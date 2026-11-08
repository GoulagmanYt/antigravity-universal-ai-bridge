# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] - 2.4.0-alpha.1

### Changed
- **Renamed to WebAI Bridge** (`webai-bridge`). The project is a fork of antigravity-universal-ai-bridge by Eyad / Trignod.ai, see `NOTICE.md`. The MCP server now identifies itself as `webai-bridge`, and the release archive is `webai-bridge.zip`.
- The floating button labels no longer mention Antigravity and its watermark reads "WebAI Bridge". Its saved position and per-tab dedication use new storage keys, so they reset once after upgrading.
- `projectRoot` is now required, absolute and must exist (no more fallback to the server's working directory).
- The global rule file `~/.gemini/GEMINI.md` is no longer written automatically. Use `node extension/bridge.mjs --install-rule` (or `BRIDGE_INSTALL_RULE=1`); the legacy block is migrated, and `--uninstall-rule` removes it. `BRIDGE_NO_AUTO_RULE` is obsolete.

### Added
- **Agent <-> Orchestrator protocol** (`extension/protocol.mjs`): the MCP `instructions` field is the single source of truth, also used for the optional rule file. Canonical tools `consult_orchestrator` and `orchestrator_status`; the former names (`consult_web_architect`, `consult_gemini_web_pro`, `get_bridge_status`) remain as deprecated aliases, hidden with `BRIDGE_HIDE_LEGACY_TOOLS=1`.
- Replies start with a one-line header (`[orchestrator protocol=1 provider=... status=ok ...]`) and failures return `isError` with `{ code, message, retryable, action }`.
- `response_type` (`code_changes` or `analysis`) so questions are no longer forced to produce code.
- `--print-instructions`, `--install-rule`, `--uninstall-rule` command line flags.
- `BRIDGE_EXTRA_ROOTS` to allow extra directories for uploads.
- Unit and end-to-end tests for the protocol and the file access policy.

### Security
- Uploads are confined to the project root (symlinks resolved), credential files and VCS internals are refused, and files larger than 2 MB are rejected. Refusals are reported back to the calling agent.
- Stale-process recovery only terminates a process whose command line is a bridge instance, instead of any Node.js process on the port.
- Requests are matched strictly by correlation id and are serialized, one prompt at a time.

### Fixed
- Gemini Web: `<user-query>` custom elements are strictly excluded from assistant turn detection and clean response extraction, preventing prompt echo fallback while waiting for Gemini to generate. Enriched Gemini streaming indicators (`.sparkle-container`, `loading-dots`, `mat-progress-spinner`).
- After a failed request the next call resends the full briefing instead of a delta the Web AI never received.
- Claude: attachment detection compares against a baseline taken before the upload and is scoped to the composer; DeepSeek: selectors mapped to the actual DOM.
- `test/live-integration.mjs` no longer contains a personal absolute path.

## [2.3.0] - 2026-11-08

### Added
- **Native File Attachment Upload (`uploadAttachmentsToDOM`)**: Replaces heavy text prompt DOM injection with native browser `DataTransfer`, `File` API, and synthetic `ClipboardEvent('paste')` vectors across Gemini, Claude, ChatGPT, DeepSeek, and Google AI Studio.
- **Zero Truncation Guarantee**: Complete files and project context (`00_PROJECT_CONTEXT_AND_BRIEFING.md`) are attached natively without size restrictions or truncation.
- **Diagnostic Doctor (`scripts/doctor.mjs`)**: Automated test suite and architecture auditor integrated via `npm run doctor` and `npm test`.
- **Universal Extension Sanitization**: Automatic mapping of non-standard extensions (`.mjs`, `.mdc`, etc.) to universally accepted mime-types and extensions (`.txt`).

## [2.2.0] - 2026-11-07

### Added
- **Multi-Provider Expansion**: Added support for **Google AI Studio** (`aistudio.google.com`) across `bridge.mjs`, `content.js`, and `manifest.json`.
- **Universal Tooling**: Added `consult_web_architect` as a universal tool alias and `get_bridge_status` to probe active connection state and detected model.
- **Chrome Extension Toolbar Popup**: Added interactive popup (`popup.html` and `popup.js`) to display current tab detection, dedication status, and quick links to supported AI platforms.
- **Draggable Status Pill**: Floating status pill can now be dragged anywhere on screen with coordinates persisted in `localStorage`.
- **Session Dedication Persistence**: Dedication state saved in `sessionStorage` so refreshing or opening "New Chat" maintains connectivity.
- **Automated Test Suite**: Added comparison unit tests (`test/comparison.test.mjs`) and end-to-end live integration tests (`test/live-integration.mjs`) using Node's native test runner.
- **Git Context Awareness**: Automatically appends active branch name and `git status --short` to the context bundle.

### Changed
- **Protocol & Concurrency Hardening**: Replaced raw `once("message")` listeners with UUID-based correlation IDs (`requestId`), configurable timeouts, and active WebSocket heartbeats (15s ping/pong).
- **Token & Context Budgeting**: Enforced a 60,000-character payload cap in `autoDiscoverProjectContext` to prevent browser textarea freezes.
- **Clean Response Extraction**: Filtered chain-of-thought accordions (`.thinking-process`, `.ds-markdown--thought`, `details`) and copy buttons from scraped responses.
- **Input Injection**: Upgraded input injection to use synthetic `ClipboardEvent('paste')` with `DataTransfer` fallback for ProseMirror and Lexical editors.
- **Configurable Port**: Added `BRIDGE_PORT` environment variable support and graceful `EADDRINUSE` diagnostic handling.
- **Rule Injection Opt-out**: Added `BRIDGE_NO_AUTO_RULE=1` to allow users to opt out of global `~/.gemini/GEMINI.md` rule injection.
- **CI Workflow**: Added automated `npm test` step to GitHub Actions CI.

### Fixed
- Fixed permanent promise hang/deadlock when browser tab closes or disconnects during tool execution.
- Fixed selector and streaming detection issues on Claude (`[data-is-streaming="true"]`) and ChatGPT (`.result-streaming`).
- Fixed npm audit vulnerabilities in transitive dependencies.

## [2.1.0] - 2026-10-17

- Initial release of Antigravity Universal AI Bridge with support for Gemini, Claude, ChatGPT, and DeepSeek.

