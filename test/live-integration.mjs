import { spawn } from "child_process";
import { WebSocket } from "ws";
import assert from "assert/strict";
import path from "path";
import { fileURLToPath } from "url";

const BRIDGE_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../extension/bridge.mjs");
const TEST_PORT = 4546;

console.log("=== STARTING LIVE END-TO-END BRIDGE TEST ===");
console.log(`Target: ${BRIDGE_PATH} on Port ${TEST_PORT}\n`);

// 1. Spawn live bridge process
const bridgeProc = spawn("node", [BRIDGE_PATH], {
    env: { ...process.env, BRIDGE_PORT: String(TEST_PORT) },
    stdio: ["pipe", "pipe", "inherit"]
});

let procOutput = "";
let pendingJsonRpc = new Map();
let jsonRpcId = 1;

bridgeProc.stdout.on("data", (chunk) => {
    procOutput += chunk.toString();
    const lines = procOutput.split("\n");
    procOutput = lines.pop(); // keep remainder

    for (const line of lines) {
        if (!line.trim()) continue;
        try {
            const msg = JSON.parse(line.trim());
            if (msg.id && pendingJsonRpc.has(msg.id)) {
                const resolver = pendingJsonRpc.get(msg.id);
                pendingJsonRpc.delete(msg.id);
                resolver(msg);
            }
        } catch (e) {
            // non-json log
        }
    }
});

function sendJsonRpc(method, params = {}) {
    const id = jsonRpcId++;
    return new Promise((resolve) => {
        pendingJsonRpc.set(id, resolve);
        const req = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
        bridgeProc.stdin.write(req);
    });
}

function wait(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function runLiveTest() {
    try {
        console.log("[Test 1] Waiting for WebSocket server to start on port " + TEST_PORT + "...");
        await wait(1200);

        // Security check: Evil origin must be rejected (HTTP 403)
        console.log("[Test 2] Security test: connection attempt from unauthorized origin (https://evil-site.com)...");
        let evilRejected = false;
        try {
            await new Promise((resolve, reject) => {
                const badWs = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`, {
                    headers: { Origin: "https://evil-site.com" }
                });
                badWs.on("open", () => {
                    badWs.close();
                    reject(new Error("Evil origin was accepted!"));
                });
                badWs.on("error", () => {
                    evilRejected = true;
                    resolve();
                });
            });
        } catch (e) {}
        assert.equal(evilRejected, true, "Unauthorized origin must be rejected with HTTP 403 error");
        console.log("  -> SUCCESS: Unauthorized origin rejected immediately.\n");

        // Legitimate connection: Gemini origin
        console.log("[Test 3] Legitimate connection from extension (Origin: https://gemini.google.com)...");
        const browserWs = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`, {
            headers: { Origin: "https://gemini.google.com" }
        });

        await new Promise((resolve, reject) => {
            browserWs.on("open", resolve);
            browserWs.on("error", reject);
        });
        console.log("  -> SUCCESS: WebSocket connected and validated.\n");

        // Handle simulated browser tab behavior
        browserWs.on("message", (raw) => {
            const msg = JSON.parse(raw.toString());
            // Check session request
            if (msg.type === "check_session") {
                browserWs.send(JSON.stringify({
                    id: msg.id,
                    type: "check_session",
                    payload: {
                        provider: "Google Gemini",
                        isEmptyChat: true,
                        chatKey: "https://gemini.google.com/app/live-test"
                    }
                }));
            }
            // Prompt execution request
            if (msg.type === "prompt") {
                // Simulate orchestrator response
                browserWs.send(JSON.stringify({
                    id: msg.id,
                    type: "prompt",
                    payload: {
                        reply: "```javascript\n// Production code from Web Orchestrator\nexport const liveStatus = 'PERFECT';\n```"
                    }
                }));
            }
        });

        // Initialize MCP connection over stdio
        console.log("[Test 4] Initializing MCP protocol (JSON-RPC over stdio)...");
        const initResp = await sendJsonRpc("initialize", {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "webai-bridge-live-test", version: "1.0.0" }
        });
        assert.ok(initResp.result, "MCP initialize must succeed");
        console.log(`  -> SUCCESS: Connected to MCP server ${initResp.result.serverInfo.name} v${initResp.result.serverInfo.version}\n`);

        // List tools
        console.log("[Test 5] Verifying registered MCP tools list...");
        const listResp = await sendJsonRpc("tools/list");
        const tools = listResp.result.tools;
        const toolNames = tools.map(t => t.name);
        console.log("  -> Registered tools:", toolNames);
        assert.ok(toolNames.includes("consult_orchestrator"), "consult_orchestrator must be present");
        assert.ok(toolNames.includes("orchestrator_status"), "orchestrator_status must be present");
        assert.ok(toolNames.includes("consult_gemini_web_pro"), "consult_gemini_web_pro must be present");
        assert.ok(toolNames.includes("consult_web_architect"), "consult_web_architect must be present");
        assert.ok(toolNames.includes("get_bridge_status"), "get_bridge_status must be present");
        console.log("  -> SUCCESS: All canonical and legacy tools properly declared.\n");

        // Call orchestrator_status
        console.log("[Test 6] Calling 'orchestrator_status' tool...");
        const statusCall = await sendJsonRpc("tools/call", {
            name: "orchestrator_status",
            arguments: {}
        });
        const statusJson = JSON.parse(statusCall.result.content[0].text);
        assert.equal(statusJson.connected, true);
        assert.equal(statusJson.session.provider, "Google Gemini");
        console.log("  -> SUCCESS: Live status received:", JSON.stringify(statusJson));
        console.log();

        // Call consult_orchestrator end-to-end
        console.log("[Test 7] Executing full code task via 'consult_orchestrator'...");
        const consultCall = await sendJsonRpc("tools/call", {
            name: "consult_orchestrator",
            arguments: {
                projectRoot: process.cwd(),
                conversation_history_and_context: "Live test turn 1",
                task: "Verify response from Web Orchestrator",
                filePaths: []
            }
        });
        const replyText = consultCall.result.content[0].text;
        assert.ok(replyText.includes("export const liveStatus = 'PERFECT'"), "Must contain generated code");
        console.log("  -> SUCCESS: Response received and forwarded through bridge:");
        console.log("--------------------------------------------------");
        console.log(replyText);
        console.log("--------------------------------------------------\n");

        // Test disconnect resilience: close browser socket and call tool again
        console.log("[Test 8] Resilience test: sudden tab disconnect and new call...");
        browserWs.close();
        await wait(200);

        const disconnectCall = await sendJsonRpc("tools/call", {
            name: "consult_orchestrator",
            arguments: {
                projectRoot: process.cwd(),
                conversation_history_and_context: "Live test after disconnect",
                task: "Test non-hanging behavior",
                filePaths: []
            }
        });
        const disconnectText = disconnectCall.result.content[0].text;
        assert.ok(disconnectText.includes("Error: No browser tab is currently connected") || disconnectText.includes("NO_TAB"), "Must return clean error without hanging");
        console.log("  -> SUCCESS: Clean error returned immediately without hanging:\n     \"" + disconnectText + "\"\n");

        console.log("=== ALL LIVE TESTS PASSED (8/8) ===");
    } finally {
        bridgeProc.kill();
    }
}

runLiveTest().catch((err) => {
    console.error("LIVE TEST FAILURE:", err);
    bridgeProc.kill();
    process.exit(1);
});
