# rimUIMCP pi extension

Bridges this project's MCP server into [pi](https://github.com/earendil-works/pi) as native tools, so pi can read RimWorld state and drive the game UI.

pi has no built-in MCP client, so this extension spawns `apps/mcp/src/main.ts` as a child process, speaks JSON-RPC over stdio, and re-registers its tools.

## Preconditions

The game and the local runtime must be running first:

```powershell
$env:RIMWORLD_ROOT = 'D:\SteamLibrary\steamapps\common\RimWorld'
./scripts/launch.ps1 start -Visible
```

Then load pi in this repository. Project extensions under `.pi/extensions/` require the project to be trusted.

## Tools

Curated wrappers (results are the raw rimUIMCP JSON):

| Tool | rimUIMCP method |
|---|---|
| `rimworld_status` | `session.status` |
| `rimworld_roots` | `state.roots` |
| `rimworld_pawns` | `state.pawns` |
| `rimworld_map` | `state.map` |
| `rimworld_ui_snapshot` | `ui.snapshot` |
| `rimworld_screenshot` | `ui.screenshot` (returns an image) |
| `rimworld_pause` | `runtime.pause` |
| `rimworld_advance` | `runtime.advance` |
| `rimworld_select_pawn` | `ui.select` |
| `rimworld_map_click` | `map.click` |

Plus `rimuimcp_call` — the generic passthrough for any method:

```json
{ "method": "state.read", "args": { "root": "currentMap" }, "timeoutMs": 30000 }
```

## Command

`/rimuimcp [status|reconnect|stop]` — inspect, restart, or stop the bridge.

## Env knobs

| Variable | Default |
|---|---|
| `PI_RIMUIMCP_MCP_ENTRY` | `apps/mcp/src/main.ts` |
| `PI_RIMUIMCP_CONFIG` | `work/runtime.json` |
| `PI_RIMUIMCP_MCP_START_TIMEOUT_MS` | `60000` |
| `PI_RIMUIMCP_MCP_CALL_TIMEOUT_MS` | `120000` |
| `PI_RIMUIMCP_MCP_DEBUG` | unset (`1` logs server stderr) |

## Testing

`tools/rimuimcp-bridge-check.ts` reuses the extension's stdio client to verify the whole path:

```bash
node tools/rimuimcp-bridge-check.ts
```
