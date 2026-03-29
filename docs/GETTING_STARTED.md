# Getting Started with Groundfloor Lore

> Unified developer intelligence — institutional knowledge + code awareness in one graph.

## Quick Start (Solo Developer)

```bash
npm install -g @groundfloor/lore
lore setup
```

That's it. `lore setup` will:
- Initialize the Kùzu graph at `~/.groundfloor/.lore/graph/`
- Install and start the Lore daemon (background service on port 3847)
- Detect your IDE (Cursor, Antigravity) and configure MCP automatically

### Index Your Code

```bash
cd ~/my-project
gitnexus analyze .          # Build code graph (one-time per project)
lore index                  # Import into unified Lore graph
```

### Verify

```bash
lore status                 # Graph stats
lore doctor                 # Health check
curl http://127.0.0.1:3847/health   # Daemon health
```

---

## Team Setup

### Team Lead — Create a Shared Database

```bash
lore setup --team
```

This starts a SurrealDB instance and generates a **join link**:

```
✅ Team sync ready!

Share this with your team:
  lore join gf://your-server:8001/groundfloor?token=cm9vdDEyMw==
```

Share that link. Team members never touch Docker or databases.

### Team Member — Join

```bash
npm install -g @groundfloor/lore
lore setup
lore join gf://your-server:8001/groundfloor?token=abc123
```

The `lore join` command:
- Connects to the team's SurrealDB
- Pulls existing team knowledge (decisions, conventions, architecture notes)
- Enables automatic sync going forward

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Lore Daemon (port 3847)                                │
│  ┌──────────┐  ┌──────────┐  ┌────────────────────────┐ │
│  │ Knowledge│  │   Code   │  │   Sync Engine          │ │
│  │  Graph   │  │  Graph   │  │  (optional SurrealDB)  │ │
│  │ (Kùzu)   │  │ (Kùzu)   │  │                        │ │
│  └──────────┘  └──────────┘  └────────────────────────┘ │
└───────┬───────────────┬─────────────────────────────────┘
        │               │
   ┌────┴────┐    ┌─────┴─────┐
   │ Cursor  │    │Antigravity│
   │  (MCP)  │    │   (MCP)   │
   └─────────┘    └───────────┘
```

- **Local-first:** Works fully offline. No database or network needed for solo use.
- **Optional sync:** SurrealDB is only needed when sharing knowledge across a team.
- **One daemon:** All IDEs share a single process — no file lock conflicts.

---

## CLI Reference

| Command | Description |
|---------|-------------|
| `lore setup` | One-time setup (graph, daemon, IDE config) |
| `lore join <url>` | Connect to a team's SurrealDB |
| `lore serve --http` | Start MCP daemon (managed by LaunchAgent) |
| `lore init` | Initialize graph only (low-level) |
| `lore index [repo]` | Import GitNexus code symbols |
| `lore status` | Show graph stats and sync status |
| `lore sync` | Manual push/pull |
| `lore doctor` | Diagnose issues |

---

## Troubleshooting

### Daemon not running
```bash
curl http://127.0.0.1:3847/health
# If it fails:
launchctl list | grep groundfloor.lore
launchctl load ~/Library/LaunchAgents/com.groundfloor.lore.plist
```

### IDE not connecting
Check your MCP config points to the daemon. Each IDE uses a different schema:

**Cursor** (`~/.cursor/mcp.json`):
```json
{
  "groundfloor-lore": {
    "type": "http",
    "url": "http://127.0.0.1:3847/mcp"
  }
}
```

**Antigravity** (`~/.gemini/antigravity/mcp_config.json`):
```json
{
  "groundfloor-lore": {
    "serverUrl": "http://127.0.0.1:3847/mcp"
  }
}
```

> **Note:** Cursor uses `url` + `type`; Antigravity uses `serverUrl` (no `type` field).
> Run `lore setup` to auto-configure both.

### Graph locked / schema error
Stop all Lore processes, then restart the daemon:
```bash
launchctl unload ~/Library/LaunchAgents/com.groundfloor.lore.plist
launchctl load ~/Library/LaunchAgents/com.groundfloor.lore.plist
```
