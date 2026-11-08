import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { WebSocketServer } from "ws";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { execSync, execFileSync } from "child_process";
import {
    MCP_INSTRUCTIONS, ORCHESTRATOR_PREAMBLE, TOOL_CONSULT, TOOL_STATUS,
    bridgeError, codedError, codeFromError, classifyTabFailure,
    buildEnvelope, buildOrchestratorFooter, buildStatus, getToolDefinitions,
    resolveToolName, validateConsultArgs, readBridgeVersion,
    detectRuleState, installRule, uninstallRule
} from "./protocol.mjs";

const BRIDGE_VERSION = readBridgeVersion(import.meta.url);

// Security: accept connections only from this machine and only from supported AI sites.
const ALLOWED_ORIGINS = new Set([
    "https://gemini.google.com",
    "https://aistudio.google.com",
    "https://claude.ai",
    "https://chatgpt.com",
    "https://chat.openai.com",
    "https://chat.deepseek.com"
]);

const PORT = parseInt(process.env.BRIDGE_PORT || "4545", 10);
let wss = null;

const isMainModule = () => {
    try {
        if (!process.argv[1]) return true;
        const scriptName = path.basename(process.argv[1]).toLowerCase();
        return scriptName.includes("bridge");
    } catch (e) {
        return true;
    }
};

let browserSocket = null;
let heartbeatInterval = null;

function setupHeartbeat(ws) {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });

    heartbeatInterval = setInterval(() => {
        if (!browserSocket || browserSocket.readyState !== 1) {
            clearInterval(heartbeatInterval);
            return;
        }
        if (browserSocket.isAlive === false) {
            browserSocket.terminate();
            browserSocket = null;
            clearInterval(heartbeatInterval);
            return;
        }
        browserSocket.isAlive = false;
        try {
            browserSocket.ping();
        } catch (e) {}
    }, 15000);
    if (heartbeatInterval.unref) heartbeatInterval.unref();
}

function setupProcessLifecycle(transport) {
    const cleanupAndExit = () => {
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        if (browserSocket) {
            try { browserSocket.close(); } catch (e) {}
        }
        if (wss) {
            try { wss.close(); } catch (e) {}
        }
        process.exit(0);
    };

    if (transport) {
        transport.onclose = cleanupAndExit;
    }
    process.on("SIGINT", cleanupAndExit);
    process.on("SIGTERM", cleanupAndExit);
    if (typeof process.disconnect === "function") {
        process.on("disconnect", cleanupAndExit);
    }
}

/**
 * Parses `netstat -ano -p tcp` output and returns the PID listening on `port`, or null.
 * Language-independent: a listening socket has a foreign address ending in ":0".
 */
function parseListeningPid(netstatOutput, port, selfPid = process.pid) {
    for (const line of String(netstatOutput).split(/\r?\n/)) {
        const cols = line.trim().split(/\s+/);
        if (cols.length < 5) continue;
        const [proto, local, foreign, , pid] = cols;
        if (!/^TCP/i.test(proto) || !foreign.endsWith(":0")) continue;
        if (!local.endsWith(`:${port}`)) continue;
        if (!/^\d+$/.test(pid) || pid === String(selfPid)) continue;
        return pid;
    }
    return null;
}

/**
 * Windows only. Terminates a stale bridge instance holding the port, but ONLY if the owning
 * process command line contains "bridge.mjs". Never kills unrelated Node.js processes.
 */
function tryKillStaleBridgeOnPort(port) {
    if (process.platform !== "win32") return false;
    try {
        const out = execFileSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8", timeout: 3000 });
        const pid = parseListeningPid(out, port);
        if (!pid) return false;
        const cmd = execFileSync(
            "powershell",
            ["-NoProfile", "-NonInteractive", "-Command",
             `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
            { encoding: "utf8", timeout: 5000 }
        );
        if (!/bridge\.mjs/i.test(cmd)) {
            console.error(`[Bridge] Port ${port} is held by PID ${pid}, which is not a bridge instance. Not terminating it.`);
            return false;
        }
        console.error(`[Bridge Auto-Recovery] Terminating stale bridge PID ${pid} on port ${port}...`);
        execFileSync("taskkill", ["/F", "/PID", pid], { timeout: 3000 });
        return true;
    } catch (e) {
        return false;
    }
}

// ---------------------------------------------------------------------------
// File access policy: only files inside projectRoot (or BRIDGE_EXTRA_ROOTS) can be uploaded
// to a third-party Web AI, and never credentials / key material.
// ---------------------------------------------------------------------------
const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;
const SENSITIVE_DIRS = new Set([".git", ".ssh", ".aws", ".gnupg", ".azure", ".kube"]);
const SENSITIVE_NAME = /^(\.env(\..*)?|\.npmrc|\.netrc|\.pypirc|id_(rsa|dsa|ecdsa|ed25519).*|.*\.(pem|key|p12|pfx|kdbx|keystore)|credentials(\.[a-z]+)?|secrets?(\.[a-z]+)?)$/i;

function isSensitiveRelPath(relPath) {
    const parts = String(relPath).split(/[\\/]+/).filter(Boolean);
    if (parts.length === 0) return false;
    if (parts.slice(0, -1).some(p => SENSITIVE_DIRS.has(p.toLowerCase()))) return true;
    return SENSITIVE_NAME.test(parts[parts.length - 1]);
}

function getAllowedRoots(projectRoot) {
    const roots = [projectRoot];
    if (process.env.BRIDGE_EXTRA_ROOTS) {
        roots.push(...process.env.BRIDGE_EXTRA_ROOTS.split(path.delimiter).filter(Boolean));
    }
    const real = [];
    for (const r of roots) {
        try { real.push(fs.realpathSync(path.resolve(r))); } catch (e) {}
    }
    return real;
}

/**
 * Resolves a file requested by the agent. Relative paths are resolved against projectRoot.
 * Returns { ok: true, path } or { ok: false, reason } (symlinks are resolved before checking).
 */
function resolveSafeFile(projectRoot, filePath) {
    let real;
    try {
        real = fs.realpathSync(path.resolve(projectRoot, filePath));
    } catch (e) {
        return { ok: false, reason: "file not found" };
    }
    const owner = getAllowedRoots(projectRoot).find(root => {
        const rel = path.relative(root, real);
        return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    });
    if (!owner) return { ok: false, reason: "outside projectRoot" };
    if (isSensitiveRelPath(path.relative(owner, real))) return { ok: false, reason: "sensitive file (credentials, keys or VCS internals)" };
    let st;
    try { st = fs.statSync(real); } catch (e) { return { ok: false, reason: "unreadable" }; }
    if (!st.isFile()) return { ok: false, reason: "not a regular file" };
    if (st.size > MAX_ATTACHMENT_BYTES) return { ok: false, reason: `larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB` };
    return { ok: true, path: real };
}

let sessionState = {
    initializedProjects: new Set(),
    sentFileHashes: new Map(),
    lastChatKey: null
};

function resetSessionMemory() {
    sessionState.initializedProjects.clear();
    sessionState.sentFileHashes.clear();
}

function getHash(content) {
    return crypto.createHash("md5").update(content).digest("hex");
}

/**
 * Formats a file path into a safe, unambiguous attachment filename accepted by all Web AI providers.
 * Non-standard extensions (.mjs, .mdc, dotfiles) are suffixed with .txt so Gemini/Claude/ChatGPT never reject them.
 */
function toSafeAttachmentName(projectRoot, fullPath, index) {
    let rel = fullPath;
    if (projectRoot) {
        try {
            const candidate = path.relative(projectRoot, fullPath);
            if (candidate && !candidate.startsWith("..")) {
                rel = candidate;
            }
        } catch (e) {}
    }
    const baseFlat = rel.replace(/[\\/:*?"<>|]+/g, "_").replace(/^_+/, "");
    const safeBase = baseFlat || `file_${index + 1}.txt`;
    const ext = path.extname(safeBase).toLowerCase();
    const universallyAcceptedExts = new Set([
        ".txt", ".md", ".js", ".ts", ".jsx", ".tsx", ".py", ".json",
        ".html", ".css", ".csv", ".xml", ".yaml", ".yml", ".sh", ".sql",
        ".java", ".c", ".cpp", ".h", ".cs", ".go", ".rs", ".rb", ".php"
    ]);
    if (!ext || !universallyAcceptedExts.has(ext)) {
        return `${safeBase}.txt`;
    }
    return safeBase;
}

function callBrowserTab(type, payload = {}, timeoutMs = 300000) {
    return new Promise((resolve, reject) => {
        if (!browserSocket || browserSocket.readyState !== 1) {
            return reject(codedError("NO_TAB", "No browser tab is currently connected. Please click the floating button on a supported AI site to dedicate a tab."));
        }

        const id = crypto.randomUUID();
        let timer = null;

        const cleanup = () => {
            if (timer) clearTimeout(timer);
            if (browserSocket) {
                browserSocket.off("message", onMessage);
                browserSocket.off("close", onClose);
                browserSocket.off("error", onError);
            }
        };

        const onMessage = (data) => {
            try {
                const msg = JSON.parse(data.toString());
                if (msg.id === id) {
                    cleanup();
                    if (msg.error) {
                        reject(new Error(msg.error));
                    } else {
                        resolve(msg.payload !== undefined ? msg.payload : msg);
                    }
                }
            } catch (e) {}
        };

        const onClose = () => {
            cleanup();
            reject(codedError("TAB_DISCONNECTED", "Browser tab disconnected before completing the request."));
        };

        const onError = (err) => {
            cleanup();
            reject(new Error(`Browser WebSocket error: ${err.message}`));
        };

        timer = setTimeout(() => {
            cleanup();
            reject(codedError("TIMEOUT", `Bridge request '${type}' timed out after ${timeoutMs / 1000}s. Check the browser tab.`));
        }, timeoutMs);

        browserSocket.on("message", onMessage);
        browserSocket.once("close", onClose);
        browserSocket.once("error", onError);

        browserSocket.send(JSON.stringify({ id, type, payload }));
    });
}

function getGitContext(projectRoot) {
    try {
        const gitDir = path.join(projectRoot, ".git");
        if (!fs.existsSync(gitDir)) return "";
        const branch = execSync("git branch --show-current", { cwd: projectRoot, encoding: "utf8", timeout: 2000 }).trim();
        const status = execSync("git status --short", { cwd: projectRoot, encoding: "utf8", timeout: 2000 }).trim();
        if (!branch && !status) return "";
        return `\n--- [GIT STATUS & BRANCH] ---\nBranch: ${branch || "HEAD"}\n${status ? "Changes:\n" + status.slice(0, 3000) : "Working tree clean"}\n`;
    } catch (e) {
        return "";
    }
}

function autoDiscoverProjectContext(projectRoot, alreadyIncludedFiles, maxChars = 60000) {
    if (!projectRoot || !fs.existsSync(projectRoot)) return "";

    const normalizedIncluded = new Set(alreadyIncludedFiles.map(f => path.resolve(f)));
    let discoveredContent = "";
    let totalChars = 0;

    const gitContext = getGitContext(projectRoot);
    if (gitContext) {
        discoveredContent += gitContext;
        totalChars += gitContext.length;
    }

    const rootContextFiles = [
        "STATE.md", "ARCHITECTURE.md", "ROADMAP.md", "REQUIREMENTS.md",
        "DECISIONS.md", "SPEC.md", "TODO.md", "JOURNAL.md",
        "GEMINI.md", "CLAUDE.md", "AGENTS.md", ".cursorrules", "package.json"
    ];

    for (const fileName of rootContextFiles) {
        if (totalChars >= maxChars) break;
        const resolved = resolveSafeFile(projectRoot, fileName);
        const fullPath = resolved.ok ? resolved.path : path.resolve(projectRoot, fileName);
        if (resolved.ok && !normalizedIncluded.has(fullPath)) {
            try {
                const content = fs.readFileSync(fullPath, "utf8").slice(0, 12000);
                const block = `\n--- [AUTO-CONTEXT] ${fileName} ---\n${content}\n`;
                discoveredContent += block;
                totalChars += block.length;
                normalizedIncluded.add(fullPath);
                sessionState.sentFileHashes.set(fullPath, getHash(content));
            } catch (e) {}
        }
    }

    const contextDirs = [".gemini", ".claude", ".agents", ".agent", ".gsd"];

    function scanDir(dirPath, depth = 0) {
        if (depth > 3 || !fs.existsSync(dirPath) || totalChars >= maxChars) return;
        try {
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });
            for (const entry of entries) {
                if (totalChars >= maxChars) break;
                const fullPath = path.resolve(dirPath, entry.name);
                if (entry.isDirectory()) {
                    if (entry.name !== "node_modules" && entry.name !== ".git") {
                        scanDir(fullPath, depth + 1);
                    }
                } else if (/\.(md|txt|mdc|json|yaml|yml)$/i.test(entry.name) && !normalizedIncluded.has(fullPath) && !isSensitiveRelPath(path.relative(projectRoot, fullPath))) {
                    const stat = fs.statSync(fullPath);
                    if (stat.size <= 25000) {
                        const relPath = path.relative(projectRoot, fullPath);
                        const content = fs.readFileSync(fullPath, "utf8");
                        const block = `\n--- [PROJECT MEMORY / SKILL] ${relPath} ---\n${content}\n`;
                        discoveredContent += block;
                        totalChars += block.length;
                        normalizedIncluded.add(fullPath);
                        sessionState.sentFileHashes.set(fullPath, getHash(content));
                    }
                }
            }
        } catch (e) {}
    }

    for (const dirName of contextDirs) {
        if (totalChars >= maxChars) break;
        scanDir(path.resolve(projectRoot, dirName));
    }

    return discoveredContent;
}

const server = new Server({ name: "webai-bridge", version: BRIDGE_VERSION }, {
    capabilities: { tools: {} },
    instructions: MCP_INSTRUCTIONS
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: getToolDefinitions({ includeLegacy: process.env.BRIDGE_HIDE_LEGACY_TOOLS !== "1" })
}));

let tabQueue = Promise.resolve();
function withTabLock(task) {
    const run = tabQueue.then(task, task);
    tabQueue = run.catch(() => {});
    return run;
}

function handleConsultRequest(args) {
    return withTabLock(() => handleConsultRequestUnlocked(args));
}

async function handleConsultRequestUnlocked(args) {
    const invalid = validateConsultArgs(args);
    if (invalid) return bridgeError("BAD_REQUEST", invalid);
    if (!browserSocket || browserSocket.readyState !== 1) {
        return bridgeError("NO_TAB", "No browser tab is currently connected.");
    }

    const {
        projectRoot,
        conversation_history_and_context = "",
        task,
        filePaths = [],
        response_type: responseType = "code_changes"
    } = args;

    let chatInfo = { isEmptyChat: true, chatKey: "unknown" };
    try {
        const info = await callBrowserTab("check_session", {}, 10000);
        if (info) chatInfo = info;
    } catch (e) {}

    if (chatInfo.isEmptyChat || chatInfo.chatKey !== sessionState.lastChatKey) {
        resetSessionMemory();
        sessionState.lastChatKey = chatInfo.chatKey;
    }

    const normalizedRoot = path.resolve(projectRoot);
    const isFirstCallForProject = !sessionState.initializedProjects.has(normalizedRoot);

    const attachments = [];
    let promptText = `[WebAI Bridge]\n\n${ORCHESTRATOR_PREAMBLE}\n\n`;

    if (isFirstCallForProject) {
        const autoContext = autoDiscoverProjectContext(normalizedRoot, filePaths);
        const fullBriefing =
            `=== 1. INITIAL SESSION BRIEFING & CONTEXT ===\n${conversation_history_and_context}\n\n` +
            (autoContext ? `=== 2. PROJECT MEMORY, PROGRESS & SKILLS ===\n${autoContext}\n` : "");

        // If the project context + briefing is large (> 3500 chars), attach it as a file to keep the DOM input fast!
        if (fullBriefing.length > 3500) {
            attachments.push({
                name: "00_PROJECT_CONTEXT_AND_BRIEFING.md",
                originalPath: path.join(normalizedRoot, "00_PROJECT_CONTEXT_AND_BRIEFING.md"),
                content: fullBriefing,
                mimeType: "text/markdown"
            });
            promptText += `=== 1. INITIAL SESSION BRIEFING & PROJECT CONTEXT ===\n` +
                          `Refer to attached file "00_PROJECT_CONTEXT_AND_BRIEFING.md" for the full project architecture, briefing, and repository memory.\n\n`;
        } else {
            promptText += `${fullBriefing}\n`;
        }
        sessionState.initializedProjects.add(normalizedRoot);
    } else {
        if (conversation_history_and_context.length > 3500) {
            attachments.push({
                name: "00_SESSION_DELTA_UPDATE.md",
                originalPath: path.join(normalizedRoot, "00_SESSION_DELTA_UPDATE.md"),
                content: conversation_history_and_context,
                mimeType: "text/markdown"
            });
            promptText += `=== 1. FOLLOW-UP SESSION UPDATE (DELTA) ===\nRefer to attached file "00_SESSION_DELTA_UPDATE.md".\n\n`;
        } else {
            promptText += `=== 1. FOLLOW-UP SESSION UPDATE (DELTA ONLY) ===\n${conversation_history_and_context}\n\n`;
        }
    }

    const manifestLines = [];
    const refused = [];
    let sentFiles = 0;
    let unchangedFiles = 0;
    let fileIndex = 0;

    for (const filePath of filePaths) {
        const resolved = resolveSafeFile(normalizedRoot, filePath);
        if (!resolved.ok) {
            manifestLines.push(`- [REFUSED: ${resolved.reason}] ${filePath}`);
            refused.push(`${filePath} (${resolved.reason})`);
            continue;
        }
        const fullPath = resolved.path;
        const content = fs.readFileSync(fullPath, "utf8");
        const currentHash = getHash(content);
        const previousHash = sessionState.sentFileHashes.get(fullPath);

        if (isFirstCallForProject || previousHash !== currentHash) {
            const attachmentName = toSafeAttachmentName(normalizedRoot, fullPath, fileIndex++);
            const headerWrappedContent =
                `// ============================================================================\n` +
                `// TARGET WORKSPACE FILE: ${fullPath}\n` +
                `// ATTACHMENT NAME: ${attachmentName}\n` +
                `// ============================================================================\n\n` +
                content;

            attachments.push({
                name: attachmentName,
                originalPath: fullPath,
                content: headerWrappedContent,
                mimeType: "text/plain"
            });

            manifestLines.push(`- [ATTACHED FILE: "${attachmentName}"] -> Absolute Path: ${fullPath} (${content.length} chars, COMPLETE & UNTRUNCATED)`);
            sessionState.sentFileHashes.set(fullPath, currentHash);
            sentFiles++;
        } else {
            manifestLines.push(`- [UNCHANGED IN THIS CHAT] -> Absolute Path: ${fullPath}`);
            unchangedFiles++;
        }
    }

    if (manifestLines.length > 0) {
        promptText += `=== TARGET WORKSPACE FILES (ATTACHED NATIVELY) ===\n` +
                      `The following target files have been uploaded as native file attachments to this message (100% complete, zero truncation):\n` +
                      `${manifestLines.join("\n")}\n\n`;
    }

    promptText += `=== CURRENT TASK TO EXECUTE ===\n${task}\n\n`;
    promptText += buildOrchestratorFooter(responseType);

    try {
        const reply = await callBrowserTab("prompt", {
            prompt: promptText,
            attachments
        }, 660000);
        const replyText = typeof reply === "string" ? reply : (reply.reply || JSON.stringify(reply));
        const failure = classifyTabFailure(replyText);
        if (failure) {
            // The Web AI never received the briefing: force a full resend on the next call.
            resetSessionMemory();
            return bridgeError(failure, replyText);
        }
        const envelope = buildEnvelope({
            provider: chatInfo.provider,
            responseType,
            filesSent: sentFiles,
            filesUnchanged: unchangedFiles,
            refused
        });
        return { content: [{ type: "text", text: envelope + replyText }] };
    } catch (err) {
        resetSessionMemory();
        return bridgeError(codeFromError(err), err.message);
    }
}

async function handleStatusRequest() {
    if (!browserSocket || browserSocket.readyState !== 1) {
        return { content: [{ type: "text", text: JSON.stringify(buildStatus({ connected: false, port: PORT, version: BRIDGE_VERSION }), null, 2) }] };
    }
    try {
        const session = await callBrowserTab("check_session", {}, 5000);
        return { content: [{ type: "text", text: JSON.stringify(buildStatus({ connected: true, port: PORT, version: BRIDGE_VERSION, session }), null, 2) }] };
    } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify(buildStatus({ connected: true, port: PORT, version: BRIDGE_VERSION, error: err.message }), null, 2) }] };
    }
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = resolveToolName(name);
    if (!tool) {
        return bridgeError("BAD_REQUEST", `Unknown tool '${name}'. Available tools: ${TOOL_CONSULT}, ${TOOL_STATUS}.`);
    }
    if (tool.legacy) {
        console.error(`[Bridge] Tool '${name}' is deprecated; use '${tool.canonical}'.`);
    }
    if (tool.kind === "status") return handleStatusRequest();
    return handleConsultRequest(args || {});
});

function startServer() {
    if (process.env.BRIDGE_INSTALL_RULE === "1") {
        try {
            const r = installRule();
            console.error(`[Bridge] Global rule ${r.action}: ${r.path}`);
        } catch (e) {
            console.error(`[Bridge] Could not install the global rule: ${e.message}`);
        }
    } else if (detectRuleState() === "legacy") {
        console.error("[Bridge] Legacy global rule found in ~/.gemini/GEMINI.md. Run `node bridge.mjs --install-rule` to migrate it, or `--uninstall-rule` to remove it.");
    }

    function initWebSocket(attempt = 1) {
        wss = new WebSocketServer({
            host: "127.0.0.1",
            port: PORT,
            maxPayload: 100 * 1024 * 1024, // 100MB max payload for large multi-file attachments
            verifyClient: (info) => ALLOWED_ORIGINS.has(info.origin)
        });

        wss.on("error", (err) => {
            if (err.code === "EADDRINUSE") {
                if (attempt === 1 && tryKillStaleBridgeOnPort(PORT)) {
                    console.error(`[Bridge Auto-Recovery] Port ${PORT} was held by a stale process. Retrying bind in 500ms...`);
                    setTimeout(() => initWebSocket(attempt + 1), 500);
                    return;
                }
                console.error(`[Bridge Error] Port ${PORT} is already in use. Another bridge instance or Node process is running.`);
                console.error(`[Bridge Tip] Close lingering Node.js processes or set BRIDGE_PORT to another port (e.g. 4546).`);
            } else {
                console.error(`[Bridge Error] WebSocketServer error:`, err);
            }
        });

        wss.on("connection", (ws) => {
            if (browserSocket && browserSocket.readyState === 1) {
                try {
                    browserSocket.send(JSON.stringify({ type: "replaced" }));
                } catch (e) {}
                browserSocket.close();
            }
            browserSocket = ws;
            setupHeartbeat(ws);
            ws.on("close", () => {
                if (browserSocket === ws) {
                    browserSocket = null;
                }
            });
            resetSessionMemory();
        });
    }

    initWebSocket(1);

    const transport = new StdioServerTransport();
    setupProcessLifecycle(transport);
    return server.connect(transport);
}

function runCli(argv) {
    if (argv.includes("--print-instructions")) {
        console.log(MCP_INSTRUCTIONS);
        return 0;
    }
    if (argv.includes("--install-rule")) {
        const r = installRule();
        console.log(`Global rule ${r.action}: ${r.path}`);
        return 0;
    }
    if (argv.includes("--uninstall-rule")) {
        const r = uninstallRule();
        console.log(`Global rule ${r.action}: ${r.path}`);
        return 0;
    }
    if (argv.includes("--help") || argv.includes("-h")) {
        console.log("Usage: node bridge.mjs [--print-instructions | --install-rule | --uninstall-rule]\nWithout flags, starts the MCP server on stdio.");
        return 0;
    }
    return null;
}

if (isMainModule()) {
    const cliExit = runCli(process.argv.slice(2));
    if (cliExit !== null) {
        process.exit(cliExit);
    }
    await startServer();
}

export {
    autoDiscoverProjectContext,
    getHash,
    toSafeAttachmentName,
    getGitContext,
    callBrowserTab,
    resetSessionMemory,
    sessionState,
    MCP_INSTRUCTIONS,
    handleConsultRequest,
    ALLOWED_ORIGINS,
    PORT,
    startServer,
    resolveSafeFile,
    isSensitiveRelPath,
    parseListeningPid,
    withTabLock
};
