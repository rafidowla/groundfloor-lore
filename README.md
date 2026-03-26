# @groundfloor/lore

Unified Developer Intelligence Engine — code awareness + institutional knowledge in a single graph.

## What it does

- **Local graph** ([Kùzu](https://kuzudb.com/)) — indexes your codebase + stores team knowledge locally (<1ms queries)
- **Team sync** — pluggable sync adapter for sharing knowledge across the team
- **MCP server** — integrates with Cursor, Antigravity, and any [MCP](https://modelcontextprotocol.io/)-compatible AI agent
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
                                                 │ sync
                                           ┌─────▼───────┐
                                           │  Remote DB   │
                                           │  (optional)  │
                                           └──────────────┘
```

## Development

```bash
npm install
npm run build
npm run dev   # start MCP server locally
```

## Credits

This project builds on the work of several open-source projects:

| Project | Author / Maintainer | License | Role |
|---|---|---|---|
| [GitNexus](https://github.com/abhigyanpatwari/GitNexus) | Abhigyan Patwari | MIT | Code graph analyzer — tree-sitter-based symbol extraction and call chain analysis |
| [Kùzu](https://kuzudb.com/) | Kùzu Inc. (Semih Salihoğlu et al.) | MIT | Embedded graph database (local Cypher-based graph engine) |
| [@kineviz/kuzu-lite](https://www.npmjs.com/package/@kineviz/kuzu-lite) | Kineviz | — | Node.js bindings for Kùzu |
| [Model Context Protocol](https://modelcontextprotocol.io/) | Anthropic | MIT | Protocol standard for AI tool integration |
| [tree-sitter](https://tree-sitter.github.io/tree-sitter/) | Max Brunsfeld (GitHub) | MIT | Multi-language parser generator powering code analysis |
| [TypeScript](https://www.typescriptlang.org/) | Microsoft | Apache 2.0 | Language runtime |
| [tsx](https://github.com/privatenumber/tsx) | Hiroki Osame | MIT | TypeScript execution engine |

## License

MIT — see [LICENSE](LICENSE)
