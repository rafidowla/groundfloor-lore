# Wiring an MCP client to Lore

Lore exposes its tools over **MCP Streamable HTTP**. Any MCP client (Claude Code, Cursor, Antigravity, Continue, custom) can connect using the same three pieces of information below.

## Connection details

| Field | Value |
|---|---|
| **Server name** | `groundfloor-lore` |
| **Transport** | MCP Streamable HTTP |
| **URL** | `http://127.0.0.1:3847/mcp` |
| **Auth** | `Authorization: Bearer <token>` |
| **Token location** | `<LORE_HOME>/auth.token` (default: `~/.groundfloor/auth.token`) |

To read your token from the terminal:

```bash
cat "${LORE_HOME:-$HOME/.groundfloor}/auth.token"
```

## Quick verification (works for any client)

These two `curl`s prove the daemon is reachable + the token works. If they succeed, the daemon is ready and any client failure is a client-config issue.

```bash
# 1. Daemon up?
curl -s http://127.0.0.1:3847/health

# 2. Auth works? (replace TOKEN with your value)
TOKEN=$(cat "${LORE_HOME:-$HOME/.groundfloor}/auth.token")
curl -sH "Authorization: Bearer $TOKEN" http://127.0.0.1:3847/api/health | jq .workspace
```

## Per-client wiring

### Claude Code (CLI)

Add to `~/.claude/settings.json` (or per-project `.claude/settings.local.json`):

```json
{
  "mcpServers": {
    "groundfloor-lore": {
      "transport": "http",
      "url": "http://127.0.0.1:3847/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_TOKEN_HERE"
      }
    }
  }
}
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` under `"mcpServers"` — same shape as above.

### Cursor

Open Settings → Features → MCP → Add MCP Server. Use the same URL + Authorization header.

### Antigravity (Google's IDE)

Config file: `~/.gemini/antigravity/mcp_config.json` (macOS / Linux) or `C:\Users\<USER>\.gemini\antigravity\mcp_config.json` (Windows).

**Important:** Antigravity uses `serverUrl` (not `url`) for HTTP-based MCP servers, and there is no `transport` field — HTTP is inferred from the presence of `serverUrl`.

```json
{
  "mcpServers": {
    "groundfloor-lore": {
      "serverUrl": "http://127.0.0.1:3847/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_TOKEN_HERE"
      }
    }
  }
}
```

After editing, **close and reopen Antigravity** for the change to take effect. The MCP Servers panel (Agent session → "…" menu → MCP Servers) should then list `groundfloor-lore` with its tools.

If you see `groundfloor-lore` listed in Antigravity but the tools don't work, check that the `headers.Authorization` block is present and the token matches `<LORE_HOME>/auth.token`. A `serverUrl`-only entry produces a 401 on every call and the tools appear unavailable.

### Continue, Zed, others

Generic pattern — every MCP-capable IDE accepts a server registration with these four fields: name, transport=http, url, auth header. If the IDE only supports stdio transport (older MCP spec), see fallback below.

## stdio fallback (when HTTP transport isn't supported)

Some older clients only support stdio MCP transport. For those, launch the daemon as a subprocess:

```json
{
  "mcpServers": {
    "groundfloor-lore": {
      "command": "lore",
      "args": ["serve"]
    }
  }
}
```

`lore serve` defaults to stdio transport (no flag required). The `--http` flag switches to the shared HTTP daemon mode; omitting it gives you the per-process stdio path used here.

This spawns a fresh `lore` process per client connection. **Not recommended** for daily use because:
- Each client gets its own daemon process + memory
- Cloud sync, the background sweeper, and the retention timer only run in the long-lived daemon, not the spawned subprocess
- WAL conflicts if more than one daemon writes to the same workspace concurrently

Use HTTP transport whenever the client supports it.

## What you'll see when it's working

Once wired, the client's tool list should include:

- `recall`, `search`, `store_node`, `store_edge`
- `collection_create`, `collection_insert`, `collection_query`
- `schema_get`, `schema_propose`, `schema_approve`
- `stats`, `sync_status`, `register_workspace`
- `traverse`, `structured_query`, `maintain`
- `store_verbatim`, `search_verbatim`, `get_verbatim`

See [`FEATURES.md`](./FEATURES.md) for the full MCP tool catalog.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Client says "groundfloor-lore unavailable" | Wasn't registered with the client | Re-do the per-client wiring above. |
| Daemon reachable via curl but client times out | Wrong transport (client tries stdio against an HTTP server) | Make sure the client config has `"transport": "http"` and `"url": "..."`. |
| HTTP 401 in client logs | Stale or missing bearer token | Re-read `auth.token` from disk; tokens rotate on every fresh daemon install. |
| HTTP 404 on `/mcp` | Daemon running in stdio-only mode | Restart with `--http` flag (or via launchd plist which already passes it). |
| `lore` CLI not found in shell | `npm link` not run in this repo | From `groundfloor-lore/`: `npm link`. Verify with `which lore`. |
| Daemon not responding | launchd job stopped | `launchctl load ~/Library/LaunchAgents/com.groundfloor.lore.plist` |
