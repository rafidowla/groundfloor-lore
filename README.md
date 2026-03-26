# @groundfloor/lore

Unified Developer Intelligence Engine — code awareness + institutional knowledge in a single graph.

## What it does

- **Local graph** (Kùzu) — indexes your codebase + stores team knowledge locally (<1ms queries)
- **Hosted sync** (SurrealDB) — shares knowledge across the team via Cloudflare Tunnel
- **MCP server** — integrates with Cursor, Antigravity, and any MCP-compatible AI agent
- **Offline-first** — works without network; syncs when available

## Quick start

```bash
# Install
npm install -g @groundfloor/lore

# Initialize in your repo
cd your-project
lore init

# Start the MCP server
lore serve
```

## Architecture

See [docs/architecture.md](docs/architecture.md) for full details.

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  AI Agent    │────▶│  MCP Server  │────▶│  Local Kùzu  │
│ (Cursor etc) │     │  (9 tools)   │     │  (.lore/)    │
└──────────────┘     └──────────────┘     └──────┬───────┘
                                                 │ WAL sync
                                           ┌─────▼───────┐
                                           │  SurrealDB   │
                                           │  (hosted)    │
                                           └──────────────┘
```

## For BaaS integration

See [docs/baas-integration.md](docs/baas-integration.md) for how Groundfloor BaaS 2.5 consumes this package as a platform service.

## Development

```bash
npm install
npm run build
npm run dev   # start MCP server locally
```

## License

Proprietary — Groundfloor / CodeMeTeam
