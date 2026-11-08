# Project Renaming, Cleanup, Main Merge & Release v2.4.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify and rename the project to `webai-bridge` (WebAI Bridge), sanitize `README.md` by removing unnecessary emojis, translate all remaining French UI/test strings to English, remove legacy single-AI naming artifacts (`gemini-bridge` / `gemini-web-pro`), merge `feat/v2.2-stability-and-multilingual` into `main`, and create the `v2.4.0` GitHub release.

**Architecture:** 
1. Audit and clean `README.md` to remove gratuitous emojis from headings, tables, and links while preserving clean GitHub-flavored markdown.
2. Translate all residual French UI strings in `extension/popup.html`, `extension/popup.js`, and `test/live-integration.mjs` to English.
3. Rename the GitHub remote repository from `antigravity-universal-ai-bridge` to `webai-bridge` using `gh repo rename` to eliminate broken 404 links, and update local MCP server config from `gemini-web-pro` to `webai-bridge`.
4. Validate test suite (`npm test` + `npm run doctor`) and commit changes on `feat/v2.2-stability-and-multilingual`.
5. Fast-forward / merge `feat/v2.2-stability-and-multilingual` into `main`, push to `origin/main`.
6. Tag `v2.4.0` and publish the GitHub release with attached `webai-bridge.zip`.

**Tech Stack:** Node.js 18+, Model Context Protocol (MCP), Chrome Extension Manifest V3, GitHub CLI (`gh`), Git.

**Spec:** User request: "Renomme le projet pour un nom plus cohérent, enlève les emoji inutiles dans le readme, vérifie que tout est en anglais, change le nom (gemini-bridge) et les références uniques aux ia dans les nom de fichiers pour avoir un truc plus global. Puis merge la branche sur main. Ensuite créé une release . Fait toi un plan avant d'agir"

## Global Constraints
- Target project name: `webai-bridge` (Display: **WebAI Bridge**).
- Zero broken links in `README.md` and `package.json`.
- Keep multilingual DOM selectors in `extension/content-providers.js` (these match user browsers in French/German/etc.), but all UI text, console outputs, logs, and docs must be strictly in English.
- All existing unit tests (47 tests) and doctor checks (14 checks) must pass before merging.

## Review Focus
1. `README.md` headers and tables: Ensure emoji removal doesn't break table alignment or internal markdown anchor links.
2. `extension/popup.html` and `popup.js`: Ensure English strings display cleanly and fit within the popup layout.
3. Git merge: Ensure clean merge of `feat/v2.2-stability-and-multilingual` into `main` with no conflicts against `origin/main`.
4. GitHub Release: Ensure `webai-bridge.zip` is built with `node_modules` pre-packaged for zero-terminal end users.

---

### Task 1: Clean README.md (Remove Useless Emojis & Normalize Copy)

**Files:**
- Modify: `README.md`

- [ ] Remove emojis from all section headers:
  - `## 🥊 Why WebAI Bridge?` -> `## Why WebAI Bridge?`
  - `### 💸 The Double-Billing Trap` -> `### The Double-Billing Trap`
  - `### 🎭 Fixed Two-Agent Architecture` -> `### Fixed Two-Agent Architecture`
  - `## ⚡ Comparison: Why It Wins` -> `## Comparison: Why It Wins`
  - `## 🎬 Show, Don't Tell (10-Second Demo)` -> `## Quick Demo`
  - `## 🧠 Supported Frontier Models` -> `## Supported Frontier Models`
  - `## 📐 How It Works` -> `## How It Works`
  - `### 🎭 Fixed Two-Agent Protocol` -> `### Two-Agent Protocol`
  - `## ⚡ Quickstart in 30 Seconds` -> `## Quickstart`
  - `### 📦 Step 1: Install the MCP Server` -> `### Step 1: Install the MCP Server`
  - `## 🚦 Daily Workflow` -> `## Daily Workflow`
  - `## 🔒 Security, Privacy & Anti-Ban FAQ` -> `## Security, Privacy & Anti-Ban FAQ`
  - `## 🛠️ Diagnostics & Health Check` -> `## Diagnostics & Health Check`
  - `## 🔄 Upgrading from 2.3` -> `## Upgrading from 2.3`
  - `## 🤝 Contributing` -> `## Contributing`
  - `## 📄 License` -> `## License`
- [ ] Clean up emojis from nav links at the top (`[Quickstart](#quickstart) · [Why WebAI Bridge?](#why-webai-bridge)...`).
- [ ] Clean up table cells in comparison matrix (replace `💸`, `🎉`, `⚡`, `🧠`, `🛡️`, `✨` with clean text or standard indicators).
- [ ] Verify that there are no mentions of `gemini-bridge` in setup instructions or archive names (all refer to `webai-bridge`).

---

### Task 2: Translate French Strings to English

**Files:**
- Modify: `extension/popup.html`
- Modify: `extension/popup.js`
- Modify: `test/live-integration.mjs`

- [ ] In `extension/popup.html`:
  - Change `Debug Mode (Logs Détaillés)` -> `Debug Mode (Detailed Logs)`
  - Change `Capture les événements DOM, boutons et requêtes en temps réel pour diagnostic immédiat.` -> `Captures real-time DOM events, buttons, and requests for live diagnostics.`
  - Change `Copier les logs` -> `Copy Logs`
  - Change `Vider` -> `Clear Logs`
- [ ] In `extension/popup.js`:
  - Translate all `setFeedback` messages to English:
    - `Mode Debug activé (logs détaillés)` -> `Debug mode enabled (detailed logs)`
    - `Mode Debug désactivé` -> `Debug mode disabled`
    - `Extension API non disponible` -> `Extension API not available`
    - `Aucun onglet actif` -> `No active tab found`
    - `Onglet non compatible` -> `Tab not compatible`
    - `Aucun log dans le buffer` -> `No logs in buffer`
    - `${logs.length} logs copiés !` -> `${logs.length} logs copied!`
    - `Erreur presse-papier` -> `Clipboard error`
    - `${logs.length} logs disponibles` -> `${logs.length} logs available`
    - `Buffer de logs vidé` -> `Log buffer cleared`
- [ ] In `test/live-integration.mjs`:
  - Translate all French `console.log` and assertion descriptions into English.

---

### Task 3: Align Project Name, Remote Repository & Local MCP Configuration

**Files:**
- Modify: `C:\Users\robin\.gemini\config\mcp_config.json`
- Command: `gh repo rename webai-bridge --yes`

- [ ] Rename GitHub repository `GoulagmanYt/antigravity-universal-ai-bridge` to `GoulagmanYt/webai-bridge` using `gh repo rename webai-bridge --yes`.
- [ ] Update git remote `origin` url in workspace to `https://github.com/GoulagmanYt/webai-bridge.git`.
- [ ] Update `C:\Users\robin\.gemini\config\mcp_config.json`:
  - Rename key `"gemini-web-pro"` to `"webai-bridge"`.
  - Point the path to `C:/Users/robin/Documents/GitHub/antigravity-universal-ai-bridge/extension/bridge.mjs`.

---

### Task 4: Run Tests & Verification Gate

**Files:**
- Verify: all project tests and linters

- [ ] Run `npm run check`
- [ ] Run `npm test`
- [ ] Run `npm run doctor`
- [ ] Commit all changes to `feat/v2.2-stability-and-multilingual` with conventional commit message `chore(branding): unify project name to webai-bridge, remove emojis, translate UI to English`.

---

### Task 5: Merge onto Main & Create Release

**Files:**
- Branch: `main`

- [ ] Switch to `main` branch (`git checkout main`).
- [ ] Merge `feat/v2.2-stability-and-multilingual` into `main`.
- [ ] Push `main` to `origin/main`.
- [ ] Create git tag `v2.4.0` (`git tag -a v2.4.0 -m "Release v2.4.0: WebAI Bridge Zero-Token MCP Orchestrator"`).
- [ ] Push tag to `origin` (`git push origin v2.4.0`).
- [ ] Build `dist/webai-bridge.zip` containing `extension`, `package.json`, `package-lock.json`, and `node_modules`.
- [ ] Create GitHub release `v2.4.0` using `gh release create v2.4.0 dist/webai-bridge.zip --title "v2.4.0 - WebAI Bridge: Zero-Token MCP Orchestrator" --notes "..."`.
