# Changelog

All notable changes to Lore are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) loosely; dates are local.

## [Unreleased]

### Added — Atlas in-house code intelligence (2026-04-30)

The developer plugin's code-intelligence layer is now in-house, in-process, and license-clean. The previous gitnexus subprocess dependency is retired.

**Twelve new MCP tools**, registered live in the daemon:

- `code_blast_radius` — depth-tiered (d1/d2/d3) reachability with edge-kind knob
- `code_pagerank` — symbol-importance ranking (graphology-pagerank)
- `code_coupling` — afferent / efferent / instability per module
- `code_cycles` — strongly-connected components (Tarjan via graphology-components)
- `code_dead_code` — zero-inbound symbols with entry-point exemptions
- `code_hotspots` — complexity × churn ranking
- `code_layer_violations` — user-declared LayerSpec rule check
- `code_tectonic_map` — module topology with cyclic-module flags
- `code_churn` — per-file commit/add/delete activity
- `code_lineage` — per-line authorship via `git blame --line-porcelain`
- `code_pr_risk` — blast × complexity × churn → low/med/high/critical band
- `code_detect_changes` — git diff → affected symbols (Atlas-native variant)

**Tree-sitter parser** with walkers for 8 languages: TypeScript / JavaScript (shared), Python, Go, Rust, Java, C#, C/C++, Ruby. WASM grammars vendored from `tree-sitter-wasms` (Unlicense). Per-language call extraction added in Phase 2.1 (previously placeholder).

**Cross-file resolver** — symbol table, import graph (with TypeScript ESM `.js → .ts` suffix rewriting and `tsconfig.json` path aliases), inheritance edges, call graph (4-tier resolution with confidence scores), `FileContains` edges.

**8 architectural analytics modules** under `packages/lore-plugin-developer/src/analytics/`. **4 git-signal modules** under `packages/lore-plugin-developer/src/git/`.

### Changed — existing code-intelligence MCP tools now Atlas-backed

Same names, sub-millisecond execution (was ~50–500ms via gitnexus subprocess):

- `code_query`, `code_context`, `code_full_context`, `code_impact`, `code_cypher`, `code_flow_search`
- `gitnexus_query`, `gitnexus_context`, `gitnexus_impact`, `gitnexus_cypher` (back-compat aliases; will be dropped one release after this)

### Removed — gitnexus subprocess dependency from the live data path

- Deleted `packages/lore-plugin-developer/src/gitnexusProxy.ts` (314 lines of CLI subprocess + temp-file output parsing).
- Rewrote `packages/lore-plugin-developer/src/codeIndexer.ts` (513 → 165 lines). All gitnexus subprocess invocations removed; `importFromGitNexus` and `indexAllRepos` now delegate to `atlasIndexer.indexRepoWithAtlas` via a new `DeveloperApi.indexRepoWithAtlas` closure. `isGitNexusAvailable` deprecated (returns `true` since no subprocess is invoked).

### Migrated — graph data shape on the developer workspace

| | Before | After |
|---|---|---|
| `CodeSymbol` rows | 15114 | 15566 |
| uid format | `<repo>::<file>::<name>::<Kind>` | `<file>:<qualifiedName>:<kind>` |
| `kind` values | Capitalized (`Function`, `Class`, `Method`, `Property`, `Section`, …) | Lowercase (`function`, `class`, `method`, …) |
| `Property` / `Section` | Tracked as separate symbols | Not modelled in v1 (analytics noise) |
| Indexing time | ~30s per repo via subprocess | ~10–25s per repo via in-process tree-sitter |

Cutover ran via `scripts/atlas-cutover-destructive.mjs` with the daemon stopped. 87.89% mappable coverage on the 12-repo portfolio. Pre-cutover snapshot preserved at `<workspace>/.lore/graph.pre-gitnexus-migration` (one `cp -R` away from a full rollback).

### Why retire gitnexus

GitNexus is licensed under PolyForm Noncommercial 1.0.0, which blocks commercial use of Lore. jcodemunch (the alternative we considered) had the same paid-tier issue. Atlas was built from scratch as part of Lore using only MIT/Apache/Unlicense dependencies, so Lore is now license-clean for sale.

### Carry-overs to v1.1

- Walker extension to capture inner arrow handlers (would lift coverage on JS/TS-heavy repos like `coderunner`, `groundfloor-v2.5`, `mira` from ~57–86% to ~95%+)
- PHP / Swift / Kotlin walkers
- Native Atlas repo registry (replace `~/.gitnexus/registry.json`)
- Rename `codeIndexer.ts` → `repoIndexer.ts`; drop `GitNexusRepoEntry` → `IndexedRepo`
- Drop `gitnexus_*` MCP aliases
- Schema additions: persist Atlas's `complexity` / `pagerank` / `churn30d` / `inboundCount` fields onto `CodeSymbol`
- Multi-repo `AtlasContext` for analytics tools

### Phase 9 (post-Phase-8)

SQL/AQL data-layer bridge inside the developer plugin. Code↔data graph linking `Function` → `Table` / `Column` symbols so blast-radius queries can answer "what queries break if I drop this column?". Estimate ~10–15 days.

---

For the full Atlas timeline see `PHASE_0_OUTPUT.md` through `PHASE_8_OUTPUT.md`. The cumulative plan lives in `docs/PLAN_replace_gitnexus_in_developer_plugin.md`.
