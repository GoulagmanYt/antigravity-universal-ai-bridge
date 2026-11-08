# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

