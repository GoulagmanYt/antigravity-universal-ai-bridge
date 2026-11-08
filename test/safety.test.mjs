import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveSafeFile, isSensitiveRelPath, parseListeningPid, withTabLock } from "../extension/bridge.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-safety-"));
const root = path.join(tmp, "project");
const outside = path.join(tmp, "outside");
fs.mkdirSync(path.join(root, "src"), { recursive: true });
fs.mkdirSync(path.join(root, ".git"), { recursive: true });
fs.mkdirSync(outside);
fs.writeFileSync(path.join(root, "src", "app.js"), "ok");
fs.writeFileSync(path.join(root, ".env"), "SECRET=1");
fs.writeFileSync(path.join(root, ".git", "config"), "x");
fs.writeFileSync(path.join(outside, "id_rsa"), "KEY");
fs.writeFileSync(path.join(outside, "notes.txt"), "n");

test("accepts a normal file inside projectRoot (absolute and relative)", () => {
    assert.equal(resolveSafeFile(root, path.join(root, "src", "app.js")).ok, true);
    assert.equal(resolveSafeFile(root, "src/app.js").ok, true);
});

test("refuses paths outside projectRoot, including traversal", () => {
    assert.equal(resolveSafeFile(root, path.join(outside, "notes.txt")).reason, "outside projectRoot");
    assert.equal(resolveSafeFile(root, "../outside/notes.txt").reason, "outside projectRoot");
});

test("refuses credentials and VCS internals inside the project", () => {
    assert.equal(resolveSafeFile(root, ".env").ok, false);
    assert.equal(resolveSafeFile(root, ".git/config").ok, false);
});

test("refuses a symlink that escapes projectRoot", (t) => {
    const link = path.join(root, "src", "link.txt");
    try { fs.symlinkSync(path.join(outside, "notes.txt"), link); } catch { return t.skip("symlinks not permitted"); }
    assert.equal(resolveSafeFile(root, "src/link.txt").reason, "outside projectRoot");
});

test("reports missing files and honours BRIDGE_EXTRA_ROOTS", () => {
    assert.equal(resolveSafeFile(root, "nope.js").reason, "file not found");
    process.env.BRIDGE_EXTRA_ROOTS = outside;
    assert.equal(resolveSafeFile(root, path.join(outside, "notes.txt")).ok, true);
    assert.equal(resolveSafeFile(root, path.join(outside, "id_rsa")).ok, false);
    delete process.env.BRIDGE_EXTRA_ROOTS;
});

test("isSensitiveRelPath", () => {
    for (const p of [".env", ".env.local", "a/b/server.pem", "id_ed25519", ".ssh/config", "x/.aws/credentials", "secrets.yml"]) {
        assert.equal(isSensitiveRelPath(p), true, p);
    }
    for (const p of ["src/app.js", "README.md", "environment.md", "keyboard.js"]) {
        assert.equal(isSensitiveRelPath(p), false, p);
    }
});

test("parseListeningPid is exact on the port and locale independent", () => {
    const out = [
        "  Proto  Adresse locale          Adresse distante        État           PID",
        "  TCP    127.0.0.1:45450        0.0.0.0:0               LISTENING       111",
        "  TCP    127.0.0.1:4545         0.0.0.0:0               ÉCOUTE          222",
        "  TCP    127.0.0.1:4545         127.0.0.1:50000         ESTABLISHED     333"
    ].join("\r\n");
    assert.equal(parseListeningPid(out, 4545, 1), "222");
    assert.equal(parseListeningPid(out, 4545, 222), null);
    assert.equal(parseListeningPid(out, 9999, 1), null);
});

test("withTabLock runs tasks strictly one at a time, even after a failure", async () => {
    const order = [];
    const job = (name, ms, fail) => withTabLock(async () => {
        order.push(`start:${name}`);
        await new Promise(r => setTimeout(r, ms));
        order.push(`end:${name}`);
        if (fail) throw new Error(name);
    });
    const results = await Promise.allSettled([job("a", 30, true), job("b", 5), job("c", 5)]);
    assert.deepEqual(order, ["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"]);
    assert.equal(results[0].status, "rejected");
    assert.equal(results[2].status, "fulfilled");
});
