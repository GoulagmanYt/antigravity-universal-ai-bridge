import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { toSafeAttachmentName, getHash, ALLOWED_ORIGINS, PORT } from "../extension/bridge.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

let passed = 0;
let failed = 0;

function assert(condition, message) {
    if (condition) {
        console.log(`✅ [PASS] ${message}`);
        passed++;
    } else {
        console.error(`❌ [FAIL] ${message}`);
        failed++;
    }
}

console.log("=== WebAI Bridge - Diagnostic Doctor ===\n");

// 1. Verify required files exist
const requiredFiles = [
    "extension/bridge.mjs",
    "extension/content.js",
    "extension/manifest.json",
    "extension/popup.html",
    "extension/popup.js",
    "package.json"
];

for (const rel of requiredFiles) {
    const full = path.join(rootDir, rel);
    assert(fs.existsSync(full), `Required file exists: ${rel}`);
}

// 2. Verify Manifest V3 integrity
try {
    const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, "extension/manifest.json"), "utf8"));
    assert(manifest.manifest_version === 3, "manifest.json is Manifest V3");
} catch (e) {
    assert(false, `manifest.json is valid JSON: ${e.message}`);
}

// 3. Verify attachment filename sanitizer
const sampleMjs = toSafeAttachmentName("c:\\repo", "c:\\repo\\extension\\bridge.mjs", 0);
assert(sampleMjs.endsWith(".txt"), `Non-standard extension (.mjs) safely suffixed with .txt -> ${sampleMjs}`);

const sampleJs = toSafeAttachmentName("c:\\repo", "c:\\repo\\extension\\content.js", 1);
assert(sampleJs.endsWith(".js"), `Standard extension (.js) preserved -> ${sampleJs}`);

// 4. Verify zero truncation in bridge.mjs
const bridgeSource = fs.readFileSync(path.join(rootDir, "extension/bridge.mjs"), "utf8");
assert(!bridgeSource.includes("File truncated by bridge"), "bridge.mjs has NO destructive file truncation");
assert(bridgeSource.includes("attachments.push"), "bridge.mjs builds structured native file attachments");

// 5. Verify native upload vectors in content.js
const contentSource = fs.readFileSync(path.join(rootDir, "extension/content.js"), "utf8");
assert(contentSource.includes("uploadAttachmentsToDOM"), "content.js implements uploadAttachmentsToDOM");
assert(contentSource.includes("new DataTransfer()"), "content.js uses native DataTransfer & File API");
assert(contentSource.includes("ClipboardEvent('paste'"), "content.js supports ClipboardEvent('paste') vector");

console.log(`\n=== Summary: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
    process.exit(1);
}
