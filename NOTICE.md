# Notice

**WebAI Bridge** is a fork of [antigravity-universal-ai-bridge](https://github.com/Eyad-Eladawy/antigravity-universal-ai-bridge), created by **Eyad (Trignod.ai)** and released under the GNU General Public License v3.0.

| | |
|---|---|
| Original project | https://github.com/Eyad-Eladawy/antigravity-universal-ai-bridge |
| Original author | Eyad / Trignod.ai |
| This fork | https://github.com/GoulagmanYt/webai-bridge |
| Fork maintainer | Robin ([@GoulagmanYt](https://github.com/GoulagmanYt)) |

## Changes made in this fork

Modified files have been changed from the original. The complete history is in the git log and in [CHANGELOG.md](CHANGELOG.md). In summary, since version 2.3.0:

- Renamed the project to WebAI Bridge.
- Added an explicit Agent <-> Orchestrator protocol (MCP instructions, canonical tools, structured replies and errors) in `extension/protocol.mjs`.
- Confined file uploads to the project root and refused credential files.
- Made the global rule file (`~/.gemini/GEMINI.md`) opt-in instead of automatic.
- Hardened request handling and stale-process recovery in `extension/bridge.mjs`.
- Improved Claude and DeepSeek attachment detection in `extension/content.js`.

## License

This fork is distributed under the same license as the original: GNU General Public License v3.0, see [LICENSE](LICENSE). If you distribute a modified version, it must stay open source under the same license and keep this notice.

## Trademarks

Antigravity, Gemini, Google AI Studio, Claude, ChatGPT and DeepSeek are trademarks of their respective owners. They are used here only to state compatibility. This project is not affiliated with, endorsed by or sponsored by any of them.
