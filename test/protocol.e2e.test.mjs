import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const bridgePath = path.resolve(here, "../extension/bridge.mjs");
const PORT = 45000 + Math.floor(Math.random() * 900);

const home = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-e2e-home-"));
const project = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-e2e-project-"));
fs.writeFileSync(path.join(project, "a.js"), "console.log('a');\n");
fs.writeFileSync(path.join(project, ".env"), "SECRET=1\n");

const tab = { ws: null, prompts: [], reply: "OK reply", isEmptyChat: false, closeOnPrompt: false };

function connectTab() {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { origin: "https://claude.ai" });
        ws.on("message", (raw) => {
            const msg = JSON.parse(raw.toString());
            if (!msg.id) return;
            if (msg.type === "check_session") {
                ws.send(JSON.stringify({ id: msg.id, type: msg.type, payload: { provider: "Claude", isEmptyChat: tab.isEmptyChat, chatKey: "https://claude.ai/chat/1" } }));
            } else if (msg.type === "prompt") {
                tab.prompts.push(msg.payload || msg);
                if (tab.closeOnPrompt) return ws.close();
                ws.send(JSON.stringify({ id: msg.id, type: "prompt", payload: { reply: tab.reply }, reply: tab.reply }));
            }
        });
        ws.on("open", () => { tab.ws = ws; setTimeout(resolve, 150); });
        ws.on("error", reject);
    });
}

const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bridgePath],
    env: { ...process.env, BRIDGE_PORT: String(PORT), HOME: home, USERPROFILE: home },
    stderr: "ignore"
});
const client = new Client({ name: "e2e", version: "1.0.0" }, { capabilities: {} });

const text = (r) => r.content[0].text;
const consult = (args, name = "consult_orchestrator") => client.callTool({ name, arguments: { projectRoot: project, conversation_history_and_context: "ctx", task: "do it", filePaths: [], ...args } });

before(async () => { await client.connect(transport); });
after(async () => { try { tab.ws?.close(); } catch {} await client.close(); });

test("server delivers the protocol as MCP instructions and lists canonical tools", async () => {
    assert.match(client.getInstructions(), /EXECUTOR/);
    const names = (await client.listTools()).tools.map(t => t.name);
    assert.deepEqual(names.slice(0, 2), ["consult_orchestrator", "orchestrator_status"]);
});

test("without a tab: status explains how to connect, consult fails with NO_TAB", async () => {
    const status = JSON.parse(text(await client.callTool({ name: "orchestrator_status", arguments: {} })));
    assert.equal(status.connected, false);
    assert.match(status.next_action, /floating button/);
    const r = await consult({});
    assert.equal(r.isError, true);
    assert.equal(JSON.parse(text(r)).error.code, "NO_TAB");
});

test("bad arguments fail with BAD_REQUEST before touching the tab", async () => {
    const r = await consult({ projectRoot: "relative" });
    assert.equal(r.isError, true);
    assert.equal(JSON.parse(text(r)).error.code, "BAD_REQUEST");
});

test("connected tab: status shows the provider", async () => {
    await connectTab();
    const status = JSON.parse(text(await client.callTool({ name: "orchestrator_status", arguments: {} })));
    assert.equal(status.connected, true);
    assert.equal(status.provider, "Claude");
});

test("consult: envelope, safe attachments, refusals reported, preamble and footer sent", async () => {
    const r = await consult({ filePaths: ["a.js", ".env", "../outside.txt"] });
    assert.notEqual(r.isError, true);
    const out = text(r);
    assert.match(out.split("\n")[0], /^\[orchestrator protocol=1 provider=Claude status=ok response_type=code_changes files_sent=1 files_unchanged=0 files_refused=2\]$/);
    assert.match(out, /\[refused\] \.env \(sensitive file/);
    assert.match(out, /\[refused\] \.\.\/outside\.txt/);
    assert.ok(out.endsWith("OK reply"));

    const sent = tab.prompts.at(-1);
    assert.match(sent.prompt, /You are the ORCHESTRATOR/);
    assert.match(sent.prompt, /FILE: <absolute path>/);
    assert.ok(sent.attachments.some(a => a.originalPath.endsWith("a.js")));
    assert.ok(!sent.attachments.some(a => /\.env$/.test(a.originalPath)));
    assert.match(sent.prompt, /\[REFUSED: sensitive file/);
});

test("follow-up in the same chat is a delta and unchanged files are not resent", async () => {
    const r = await consult({ filePaths: ["a.js"] });
    assert.match(text(r).split("\n")[0], /files_sent=0 files_unchanged=1 files_refused=0/);
    assert.match(tab.prompts.at(-1).prompt, /FOLLOW-UP SESSION UPDATE/);
});

test("response_type analysis asks for prose, not files", async () => {
    const r = await consult({ response_type: "analysis" });
    assert.match(text(r).split("\n")[0], /response_type=analysis/);
    assert.match(tab.prompts.at(-1).prompt, /Answer in prose/);
    assert.doesNotMatch(tab.prompts.at(-1).prompt, /FILE: <absolute path>/);
});

test("legacy tool names keep working", async () => {
    const r = await consult({}, "consult_gemini_web_pro");
    assert.notEqual(r.isError, true);
    assert.match(text(r), /^\[orchestrator /);
});

test("an upload failure becomes UPLOAD_FAILED and forces a full resend next time", async () => {
    tab.reply = "Error: Native file upload failed (no vector worked)";
    const failed = await consult({ filePaths: ["a.js"] });
    assert.equal(failed.isError, true);
    const body = JSON.parse(text(failed)).error;
    assert.equal(body.code, "UPLOAD_FAILED");
    assert.equal(body.retryable, true);

    tab.reply = "OK again";
    const retry = await consult({ filePaths: ["a.js"] });
    assert.notEqual(retry.isError, true);
    assert.match(tab.prompts.at(-1).prompt, /INITIAL SESSION BRIEFING/);
    assert.match(text(retry).split("\n")[0], /files_sent=1/);
});

test("a tab that disconnects mid-request yields TAB_DISCONNECTED", async () => {
    tab.closeOnPrompt = true;
    const r = await consult({});
    assert.equal(r.isError, true);
    assert.equal(JSON.parse(text(r)).error.code, "TAB_DISCONNECTED");
});
