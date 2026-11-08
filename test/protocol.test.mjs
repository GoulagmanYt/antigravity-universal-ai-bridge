import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    MCP_INSTRUCTIONS, LEGACY_RULE, RULE_BEGIN, RULE_END, ERROR_CODES,
    bridgeError, classifyTabFailure, codeFromError, codedError, buildEnvelope,
    buildOrchestratorFooter, getToolDefinitions, resolveToolName, validateConsultArgs,
    buildStatus, detectRuleState, installRule, uninstallRule, ruleFilePath
} from "../extension/protocol.mjs";

test("tool list exposes canonical tools first and legacy aliases last", () => {
    const names = getToolDefinitions().map(t => t.name);
    assert.deepEqual(names.slice(0, 2), ["consult_orchestrator", "orchestrator_status"]);
    assert.deepEqual(names.slice(2), ["consult_web_architect", "consult_gemini_web_pro", "get_bridge_status"]);
    assert.deepEqual(getToolDefinitions({ includeLegacy: false }).map(t => t.name), ["consult_orchestrator", "orchestrator_status"]);
});

test("every legacy tool name resolves to its canonical tool", () => {
    assert.deepEqual(resolveToolName("consult_gemini_web_pro"), { kind: "consult", legacy: true, canonical: "consult_orchestrator" });
    assert.deepEqual(resolveToolName("get_bridge_status"), { kind: "status", legacy: true, canonical: "orchestrator_status" });
    assert.equal(resolveToolName("consult_orchestrator").legacy, false);
    assert.equal(resolveToolName("nope"), null);
});

test("consult schema requires projectRoot and documents response_type", () => {
    const consult = getToolDefinitions()[0];
    assert.ok(consult.inputSchema.required.includes("projectRoot"));
    assert.deepEqual(consult.inputSchema.properties.response_type.enum, ["code_changes", "analysis"]);
    assert.ok(consult.description.length < 900);
});

test("validateConsultArgs", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-args-"));
    assert.equal(validateConsultArgs({ projectRoot: root, task: "x", filePaths: [] }), null);
    assert.match(validateConsultArgs({ projectRoot: "relative/dir", task: "x" }), /absolute/);
    assert.match(validateConsultArgs({ projectRoot: path.join(root, "missing"), task: "x" }), /does not exist/);
    assert.match(validateConsultArgs({ projectRoot: root, task: "  " }), /task is required/);
    assert.match(validateConsultArgs({ projectRoot: root, task: "x", filePaths: "a.js" }), /array/);
    assert.match(validateConsultArgs({ projectRoot: root, task: "x", response_type: "poem" }), /response_type/);
});

test("bridgeError returns isError with a machine-readable payload", () => {
    const r = bridgeError("NO_TAB", "no tab");
    assert.equal(r.isError, true);
    const body = JSON.parse(r.content[0].text).error;
    assert.equal(body.code, "NO_TAB");
    assert.equal(body.retryable, false);
    assert.match(body.action, /floating button/);
    assert.equal(JSON.parse(bridgeError("WHATEVER", "x").content[0].text).error.code, "INTERNAL");
    for (const code of ERROR_CODES) assert.ok(JSON.parse(bridgeError(code, "m").content[0].text).error.action.length > 10, code);
});

test("classifyTabFailure maps the content-script error strings", () => {
    assert.equal(classifyTabFailure("Error: Native file upload failed (no vector worked)"), "UPLOAD_FAILED");
    assert.equal(classifyTabFailure("Error: Server upload confirmation timed out"), "UPLOAD_FAILED");
    assert.equal(classifyTabFailure("Error: Generation did not start after sending"), "GENERATION_NOT_STARTED");
    assert.equal(classifyTabFailure("Error: Generation timed out after 600s"), "TIMEOUT");
    assert.equal(classifyTabFailure("Error: Input box not found"), "NO_INPUT");
    assert.equal(classifyTabFailure("Here is the fix. Error: handling changed"), null);
    assert.equal(classifyTabFailure("FILE: c:\\x.js"), null);
});

test("codeFromError prefers explicit codes and falls back on messages", () => {
    assert.equal(codeFromError(codedError("TIMEOUT", "x")), "TIMEOUT");
    assert.equal(codeFromError(new Error("Browser tab disconnected before completing")), "TAB_DISCONNECTED");
    assert.equal(codeFromError(new Error("boom")), "INTERNAL");
});

test("envelope header and footers", () => {
    const head = buildEnvelope({ provider: "Google AI Studio", responseType: "analysis", filesSent: 2, filesUnchanged: 1, refused: ["a (outside projectRoot)"] });
    assert.equal(head.split("\n")[0], "[orchestrator protocol=1 provider=Google-AI-Studio status=ok response_type=analysis files_sent=2 files_unchanged=1 files_refused=1]");
    assert.match(head, /\[refused\] a \(outside projectRoot\)/);
    assert.match(buildOrchestratorFooter("code_changes"), /FILE: <absolute path>/);
    assert.doesNotMatch(buildOrchestratorFooter("analysis"), /FILE:/);
});

test("status tells a disconnected agent what to do", () => {
    const s = buildStatus({ connected: false, port: 4545, version: "x" });
    assert.equal(s.connected, false);
    assert.match(s.next_action, /floating button/);
    assert.equal(buildStatus({ connected: true, port: 4545, version: "x", session: { provider: "Claude" } }).provider, "Claude");
});

test("instructions cover roles, errors and the no-code case", () => {
    for (const needle of ["EXECUTOR", "ORCHESTRATOR", "consult_orchestrator", "orchestrator_status", "NO_TAB", "response_type", "untrusted", "No code"]) {
        assert.ok(MCP_INSTRUCTIONS.includes(needle), needle);
    }
    for (const code of ERROR_CODES.filter(c => c !== "INTERNAL")) assert.ok(MCP_INSTRUCTIONS.includes(code), code);
});

test("rule install is opt-in, idempotent, migrates the legacy block and is reversible", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-home-"));
    const file = ruleFilePath(home);
    assert.equal(detectRuleState({ home }), "none");

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `# My own rules\nBe nice.\n\n${LEGACY_RULE}\n\n# More rules\nUse tabs.\n`);
    assert.equal(detectRuleState({ home }), "legacy");

    assert.equal(installRule({ home }).action, "updated");
    let text = fs.readFileSync(file, "utf8");
    assert.equal(detectRuleState({ home }), "managed");
    assert.ok(text.startsWith(RULE_BEGIN));
    assert.ok(text.includes(RULE_END));
    assert.ok(!text.includes("consult_gemini_web_pro"));
    assert.ok(text.includes("Be nice.") && text.includes("Use tabs."));

    assert.equal(installRule({ home }).action, "unchanged");

    assert.equal(uninstallRule({ home }).action, "removed");
    text = fs.readFileSync(file, "utf8");
    assert.ok(!text.includes(RULE_BEGIN));
    assert.ok(text.includes("Be nice.") && text.includes("Use tabs."));
    assert.equal(uninstallRule({ home }).action, "absent");
});

test("installRule creates the file when missing", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-home-"));
    assert.equal(installRule({ home }).action, "created");
    assert.equal(detectRuleState({ home }), "managed");
});
