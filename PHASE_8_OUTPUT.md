# Phase 8 Output — Atlas (gitnexus retired; cutover landed; dogfood)

> **Status:** Atlas cutover executed 2026-04-30. The developer plugin's
> code-intelligence layer is now in-house, in-process, license-clean,
> and live in production on the developer workspace.

## TL;DR

GitNexus is gone from the live data path. Lore's developer plugin now uses an in-house tree-sitter parser, cross-file resolver, 8 architectural analytics, 4 git-signal modules, and an MCP tool surface registered against the live daemon. The Kùzu graph holds 15566 Atlas-shape `CodeSymbol` rows across 12 repos.

## What shipped end-to-end (Phases 0 → 8)

| Phase | What landed | Where it lives |
|---|---|---|
| 0 | Audit + locked decisions + license-compliance scaffolding | `docs/PLAN_replace_gitnexus_in_developer_plugin.md`, `scripts/atlas-license-check.mjs` |
| 1 | Tree-sitter parser, 8 walkers (TS/JS, Python, Go, Rust, Java, C#, C/C++, Ruby) | `packages/lore-plugin-developer/src/parser/` |
| 2 + 2.1 | Cross-file resolver + call-graph extraction | `packages/lore-plugin-developer/src/resolver/`, `parser/walkers/*` |
| 3 | Atlas indexer (parse → resolve → upsert into Kùzu) | `packages/lore-plugin-developer/src/atlasIndexer.ts` |
| 4 | 8 architectural analytics modules | `packages/lore-plugin-developer/src/analytics/` |
| 5 | 4 git-signal modules | `packages/lore-plugin-developer/src/git/` |
| 6 | MCP tool definitions + handlers + back-compat aliases | `packages/lore-plugin-developer/src/mcp/` |
| 6.1 | Wired the 12 new tools into the live MCP server (`atlasToolsRegistrar.ts`) | `packages/lore-plugin-developer/src/atlasToolsRegistrar.ts` |
| 7 | Cutover: dry-run + execute + destructive + recovery scripts; gitnexusProxy.ts deleted; codeIndexer.ts rewritten Atlas-backed | `scripts/atlas-cutover-*.mjs`, source-retirement commits |
| 8 | This output doc + CHANGELOG entry | `CHANGELOG.md`, `PHASE_8_OUTPUT.md` |

## Cutover numbers

**Pre-cutover (gitnexus-shape):**
- 15114 CodeSymbol rows
- uid format: `<repo>::<file>::<name>::<Kind>` (Capitalized kind)
- Indexed via gitnexus subprocess + temp-file output parsing

**Post-cutover (Atlas-shape):**
- 15566 CodeSymbol rows (slight increase — Atlas's stricter parsing)
- 1488 CodeFile rows
- 28785 CodeRelation edges (CALLS, IMPORTS, EXTENDS, IMPLEMENTS, CONTAINS)
- 147 LoreAppliesToCode + 20 LoreTouchesFile (cross-pillar edges)
- uid format: `<file>:<qualifiedName>:<kind>` (lowercase kind)
- Indexed via in-process tree-sitter parser (~9 min for the 12-repo portfolio)

**Coverage:** 87.89% mappable (8005 mapped, 1103 unmapped, 6006 by-design-skipped). The 6006 by-design-skipped are gitnexus's `Property` / `Section` kinds Atlas v1 doesn't model. The 1103 unmapped are mostly inner arrow-handler closures Atlas v1 deliberately skips per the typescript.ts walker comment ("noise for analytics"). Their `LoreAppliesToCode` edges go to reconnect for re-suggestion at file level.

## What changed for users

**Same names, faster + cheaper:**
- `code_query`, `code_context`, `code_full_context`, `code_impact`, `code_cypher`, `code_flow_search` — all preserved. Underlying execution moved from gitnexus subprocess (~50–500ms) to in-process Kùzu reads (sub-ms).
- `gitnexus_*` aliases still registered for one deprecation release.

**New tools (12) registered live:**

| Analytics (8) | Git signals (4) |
|---|---|
| `code_blast_radius` (depth-tiered d1/d2/d3 reachability with edgeKinds knob) | `code_churn` (per-file commit/add/delete activity) |
| `code_pagerank` (symbol importance) | `code_lineage` (per-line authorship via git blame) |
| `code_coupling` (afferent/efferent/instability per module) | `code_pr_risk` (blast × complexity × churn → low/med/high/critical band) |
| `code_cycles` (Tarjan SCC) | `code_detect_changes` (git diff → affected symbols) |
| `code_dead_code` (zero-inbound + entry-point exemptions) | |
| `code_hotspots` (complexity × churn) | |
| `code_layer_violations` (LayerSpec rule check) | |
| `code_tectonic_map` (module topology with cyclic flags) | |

## Architecture

**Single source of truth.** Pre-Phase-7, Lore had two graphs:
- gitnexus's SQLite DB (subprocess, separate file, separate vocabulary)
- Lore's Kùzu DB (developer plugin's CodeSymbol/CodeFile/CodeRelation)

…with a bridge that imported one into the other. Post-cutover, only Lore's Kùzu graph exists for code intelligence. Atlas writes directly into it via `atlasIndexer.indexRepoWithAtlas(ctx, repoRoot)`. No more bridge, no more "which graph has the latest?" ambiguity.

**Plugin boundary preserved.** All Atlas code lives under `packages/lore-plugin-developer/`. Core (`packages/lore/`) and Lore's UI (`ui/`) have zero direct knowledge of Atlas — they reach it through `ILorePlugin` hooks and the typed `DeveloperApi` surface, exactly as they did pre-cutover.

**License compliance.** All Atlas source declared "Original work authored for groundfloor-lore". Patterns informed by reading GitNexus and jcodemunch source for understanding only — no code copied, no structural mirroring. Enforced in CI via `scripts/atlas-license-check.mjs` which scans every parser/resolver/analytics/git/mcp file for forbidden fingerprints.

## Safety net

Three backups exist for the developer workspace:

| Path | Size | Type |
|---|---|---|
| `<workspace>/.lore/graph.pre-gitnexus-migration` | 49M | Live snapshot (Kùzu file, byte-equal to pre-cutover graph) |
| `backups/developer-cold-pre-cutover-20260430T115018/.lore/` | 1.1G | Cold backup (daemon stopped) |
| `backups/developer-pre-atlas-cutover-20260430T101351/.lore/` | 815M | Earlier hot backup |

Rollback procedure documented in each backup's `MANIFEST.md` and in the cutover-result JSON at `<LORE_HOME>/atlas-cutover-result-1777564945695.json`.

## Carry-overs to v1.1

| Item | Estimate |
|---|---|
| Walker extension to capture inner arrow handlers | ~1 day per language × 2-3 of (TS/Python/Ruby) |
| PHP / Swift / Kotlin walkers | ~3 days each |
| Native Atlas repo registry (replace `~/.gitnexus/registry.json`) | ~2 days |
| Rename `codeIndexer.ts` → `repoIndexer.ts`, drop `GitNexusRepoEntry` → `IndexedRepo` | ~half day |
| Drop `gitnexus_*` MCP aliases (one release window after Phase 8 ships) | trivial |
| Schema additions (Phase 3.1): persist Atlas's complexity / pagerank / churn30d / inboundCount fields onto CodeSymbol | ~1 day |
| Reconnect run to re-suggest the 330 dropped LoreAppliesToCode edges | autonomous, just needs scheduling |
| Multi-repo `AtlasContext` for analytics tools (today: single repo via LORE_ATLAS_REPO_ROOT) | ~1 day |

## Phase 9 (post-Phase-8)

SQL/AQL data-layer bridge inside the developer plugin. Code↔data graph: link `Function` → `Table` / `Column` symbols so blast-radius queries can answer "what queries break if I drop this column?". Estimate: ~10–15 days. Per the locked plan in `docs/PLAN_replace_gitnexus_in_developer_plugin.md`.

## License compliance — final audit

`scripts/atlas-license-check.mjs` scans 37 files across `parser/`, `resolver/`, `analytics/`, `git/`, `mcp/`. All clean. No forbidden fingerprints (`gitnexus`, `jcodemunch`, `polyform`, etc. in code identifiers). Comments mentioning the names are licensed under the same "patterns informed by reading source for understanding only" claim.

## Hand-off

Atlas is in production on the developer workspace as of 2026-04-30. The daemon runs the Atlas-only build. The next person reading this — including future-Rafi — can:

- Use `code_pagerank`, `code_dead_code`, `code_blast_radius`, etc. against their portfolio
- Run `lore index` (CLI) to re-index any repo via Atlas
- Drop the `~/.gitnexus/` directory entirely (gitnexus binary is no longer invoked); the registry file move + native replacement is a v1.1 task
