# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue. Use GitHub's private reporting instead:
**Security tab → "Report a vulnerability"**.

If you can't use GitHub's private reporting, open a public issue that says only that you need a private channel (no technical details), and the maintainer will reach out.

Include what you found, steps to reproduce, and the potential impact. You'll get a reply as soon as possible.

## Scope

This project runs locally:

- a Chrome extension (`extension/content.js`) that runs on the supported AI sites;
- a local MCP server (`extension/bridge.mjs`, `extension/protocol.mjs`) that listens on `127.0.0.1:4545`, only accepts WebSocket connections from the supported AI sites, and only uploads files located inside the project root (credential files and VCS internals are refused).

The server writes a rule block to `~/.gemini/GEMINI.md` **only when you ask for it** (`node extension/bridge.mjs --install-rule` or `BRIDGE_INSTALL_RULE=1`), and can remove it again with `--uninstall-rule`.

Reports about these components, or about their dependencies, are welcome. Files and prompts you send are processed by the Web AI provider of the tab you dedicated, under that provider's terms; that is outside the scope of this project.

## Supported versions

Only the latest release receives fixes.
