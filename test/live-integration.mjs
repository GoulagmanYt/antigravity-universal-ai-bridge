import { spawn } from "child_process";
import { WebSocket } from "ws";
import assert from "assert/strict";

const BRIDGE_PATH = "C:\\gemini-bridge\\gemini-bridge\\extension\\bridge.mjs";
const TEST_PORT = 4546;

console.log("=== STARTING LIVE END-TO-END BRIDGE TEST ===");
console.log(`Target: ${BRIDGE_PATH} on Port ${TEST_PORT}\n`);

// 1. Spawn live bridge process
const bridgeProc = spawn("node", [BRIDGE_PATH], {
    env: { ...process.env, BRIDGE_PORT: String(TEST_PORT), BRIDGE_NO_AUTO_RULE: "1" },
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
        console.log("[Test 1] Attente du démarrage du serveur WebSocket sur port " + TEST_PORT + "...");
        await wait(1200);

        // Security check: Evil origin must be rejected (HTTP 403)
        console.log("[Test 2] Test de sécurité: tentative de connexion depuis une origine non autorisée (https://evil-site.com)...");
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
        assert.equal(evilRejected, true, "L'origine non autorisée doit être rejetée avec erreur HTTP 403");
        console.log("  -> SUCCÈS: Origine non autorisée rejetée immédiatement.\n");

        // Legitimate connection: Gemini origin
        console.log("[Test 3] Connexion légitime depuis l'extension (Origin: https://gemini.google.com)...");
        const browserWs = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`, {
            headers: { Origin: "https://gemini.google.com" }
        });

        await new Promise((resolve, reject) => {
            browserWs.on("open", resolve);
            browserWs.on("error", reject);
        });
        console.log("  -> SUCCÈS: WebSocket connecté et validé.\n");

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
                // Simulate web architect response
                browserWs.send(JSON.stringify({
                    id: msg.id,
                    type: "prompt",
                    payload: {
                        reply: "```javascript\n// Production code from Web Architect\nexport const liveStatus = 'PERFECT';\n```"
                    }
                }));
            }
        });

        // Initialize MCP connection over stdio
        console.log("[Test 4] Initialisation du protocole MCP (JSON-RPC sur stdio)...");
        const initResp = await sendJsonRpc("initialize", {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "antigravity-live-test", version: "1.0.0" }
        });
        assert.ok(initResp.result, "MCP initialize must succeed");
        console.log(`  -> SUCCÈS: Connecté au serveur MCP ${initResp.result.serverInfo.name} v${initResp.result.serverInfo.version}\n`);

        // List tools
        console.log("[Test 5] Vérification de la liste des outils MCP exposés...");
        const listResp = await sendJsonRpc("tools/list");
        const tools = listResp.result.tools;
        const toolNames = tools.map(t => t.name);
        console.log("  -> Outils enregistrés:", toolNames);
        assert.ok(toolNames.includes("consult_gemini_web_pro"), "consult_gemini_web_pro must be present");
        assert.ok(toolNames.includes("consult_web_architect"), "consult_web_architect must be present");
        assert.ok(toolNames.includes("get_bridge_status"), "get_bridge_status must be present");
        console.log("  -> SUCCÈS: Tous les outils universels sont bien déclarés.\n");

        // Call get_bridge_status
        console.log("[Test 6] Appel de l'outil 'get_bridge_status'...");
        const statusCall = await sendJsonRpc("tools/call", {
            name: "get_bridge_status",
            arguments: {}
        });
        const statusJson = JSON.parse(statusCall.result.content[0].text);
        assert.equal(statusJson.connected, true);
        assert.equal(statusJson.session.provider, "Google Gemini");
        console.log("  -> SUCCÈS: Statut en direct reçu:", JSON.stringify(statusJson));
        console.log();

        // Call consult_web_architect end-to-end
        console.log("[Test 7] Exécution complète d'une tâche de code via 'consult_web_architect'...");
        const consultCall = await sendJsonRpc("tools/call", {
            name: "consult_web_architect",
            arguments: {
                projectRoot: process.cwd(),
                conversation_history_and_context: "Live test turn 1",
                task: "Vérifier la réponse du Web Architect",
                filePaths: []
            }
        });
        const replyText = consultCall.result.content[0].text;
        assert.ok(replyText.includes("export const liveStatus = 'PERFECT'"), "Doit contenir le code généré");
        console.log("  -> SUCCÈS: Réponse reçue et transmise par le pont avec succès :");
        console.log("--------------------------------------------------");
        console.log(replyText);
        console.log("--------------------------------------------------\n");

        // Test disconnect resilience: close browser socket and call tool again
        console.log("[Test 8] Test de résilience : déconnexion brutale de l'onglet et nouvel appel...");
        browserWs.close();
        await wait(200);

        const disconnectCall = await sendJsonRpc("tools/call", {
            name: "consult_web_architect",
            arguments: {
                projectRoot: process.cwd(),
                conversation_history_and_context: "Live test after disconnect",
                task: "Tester la non-suspension",
                filePaths: []
            }
        });
        const disconnectText = disconnectCall.result.content[0].text;
        assert.ok(disconnectText.includes("Error: No browser tab is currently connected"), "Doit renvoyer une erreur propre sans geler");
        console.log("  -> SUCCÈS: Erreur propre renvoyée immédiatement sans aucun blocage :\n     \"" + disconnectText + "\"\n");

        console.log("=== TOUS LES TESTS EN DIRECT ONT RÉUSSI (8/8) ===");
    } finally {
        bridgeProc.kill();
    }
}

runLiveTest().catch((err) => {
    console.error("ÉCHEC DU TEST EN DIRECT:", err);
    bridgeProc.kill();
    process.exit(1);
});
