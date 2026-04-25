# @groundfloor/lore-plugin-developer

The Developer plugin for [@groundfloor/lore](../lore). Brings code
intelligence to the institutional-knowledge engine — CodeFile +
CodeSymbol + DevActivity nodes, GitNexus integration, and 10 MCP tools
for querying code context alongside decisions and bug patterns.

## Layout

```
packages/lore-plugin-developer/
├── plugin.json        Bundle-level manifest the Tauri shell reads
└── src/
    ├── index.ts           ILorePlugin definition + all hooks wired
    ├── schema.ts          Kùzu tables the plugin owns
    ├── operations.ts      Low-level graph ops (takes PluginGraphContext)
    ├── api.ts             DeveloperApi — the public surface core callers use
    ├── types.ts           CodeSymbol / CodeRelationEdge / DevActivity
    ├── tools.ts           10 MCP tool registrations
    ├── reconnect.ts       Reconnect-pass contributions + disk-read content
    ├── codeIndexer.ts     `lore index` — imports from GitNexus
    ├── gitnexusProxy.ts   HTTP wrapper around the gitnexus CLI
    └── nativeTools.ts     detect_changes / rename / list_repos helpers
```

## Manifest

`plugin.json` is the bundle-level descriptor the Tauri shell reads on
install. It declares:

- The runtime entry point (`lore.module` → `dist/lore-plugin-developer/src/index.js`)
- Inspector panels the shell renders as tabs:
  - **Symbols** (table over `CodeSymbol`)
  - **Files** (table over `CodeFile`)
  - **Team activity** (timeline over `DevActivity`)
  - **Call graph** (graph over `CodeSymbol` with depth=2)
- Permissions the plugin needs (`fs:read:.`, `net:127.0.0.1:7842` for
  the GitNexus daemon)
- Engine compatibility (`engines.lore: ">=2.0.0"`)

The manifest is validated end-to-end by
`npm run test:manifest:developer`. That script enforces the same
structural rules the shell's Rust loader does, plus the schema-level
checks the loader defers to TypeScript (inspector kinds, column shape,
permission namespaces). If the spec changes, this test fails until the
manifest is updated to match.

## Contract

The plugin implements `ILorePlugin` from `@lore-core/plugins/types.js`.
Core reaches it only via this interface; core code never imports plugin
internals (enforced by `npm run test:arch`).

Hooks implemented:

| Hook | Purpose |
|---|---|
| `registerSchema(ctx)` | Creates CodeFile, CodeSymbol, FileContains, CodeRelation, LoreAppliesToCode, LoreTouchesFile, DevActivity tables |
| `registerTools(server, ctx)` | 10 MCP tools: code_query, code_context, link_knowledge_to_code, gitnexus_*, list_repos, detect_changes, rename |
| `contributeReconnectNodes(ctx)` | Adds CodeFile + CodeSymbol embeddables to the cross-pillar reconnect pass |
| `routeReconnectEdge(prop, ctx)` | Routes lore→file / lore→symbol semantic edges into LoreTouchesFile / LoreAppliesToCode |
| `contributeTopology(ctx, limit)` | Adds CodeFile + CodeSymbol slices to `/api/topology` |
| `pruneInferredEdges(prefix, ctx)` | Wipes own inferred cross-pillar edges before a reconnect apply |
| `api` | `DeveloperApi` — typed surface for `lore index`, CLI orchestration, server callers |

## Scope boundary

Anything code-graph-related belongs here. Core must not mention
`CodeSymbol` / `CodeFile` / `gitnexus` etc. The CI arch check fails
if core regresses; see `/scripts/test-arch.mjs` + `CLAUDE.md` boundary
rule.

## Planned (senior engineer + DBA responsibilities)

1. **Schema manifest** (`schema.manifest.ts`): declared version + every
   owned column. `registerSchema` validates the live DB matches.
2. **Migrations** (`migrations/NNN_*.ts`): each schema bump ships with
   a forward migration + rollback. Boot refuses mismatched versions.
3. **Write policy** (`policies/write-policy.ts`): wrap
   `PluginGraphContext.executeQuery` so destructive ops or writes
   outside the manifest get rejected.
4. **Audit log** (`.lore/audit/developer.log` NDJSON): append-only
   record of every write; `lore audit --plugin developer` replays.
5. **Two-step destructive confirm**: `clearCodeSymbols` + any DROP
   requires a `confirm: "CONFIRM"` parameter (same pattern as the
   orphan-drop modal).

These live inside this package — core doesn't see any of it.
