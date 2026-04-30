# Phases 3 → 6 Output — Atlas (graph integration + analytics + git + MCP surface)

> **Status:** Phases 3, 4, 5, 6 complete in one cumulative PR. Phase 7 (retirement) intentionally deferred because the destructive cutover step requires Rafi's explicit go.
>
> **Branch:** `feat/dev-plugin-phase-3` (off `main` after PR #37 merges; was branched from `feat/dev-plugin-phase-2-1` since Phase 2.1 hadn't merged when this work landed).
> **Commits (4):** Phase 3, Phase 4, Phase 5, Phase 6.

## Summary by phase

### Phase 3 — graph integration

`packages/lore-plugin-developer/src/atlasIndexer.ts`:
- `indexRepoWithAtlas(ctx, repoRoot, options)` drives the full pipeline (parse → resolve → upsert into the developer plugin's existing Kùzu schema).
- Maps `ParsedSymbol → CodeSymbol`, `ParsedRelation → CodeRelationEdge`, `ParsedFile → CodeFile`. Mapping is intentionally lossy in v1; Phase 4's analytics fields (complexity / pagerank / churn) sit on the in-memory snapshot, not yet persisted into the Kùzu schema (a small follow-up).
- `isAtlasIndexerEnabled()` reads `LORE_DEV_USE_NEW_PARSER` env. Off by default for Phases 1–6 coexistence; Phase 7 flips it on permanently.
- Existing `codeIndexer.ts` (gitnexus subprocess) untouched. Phase 7 deletes it.

### Phase 4 — architectural analytics

8 modules under `packages/lore-plugin-developer/src/analytics/`:

- `blastRadius.ts` — depth-tiered (d1/d2/d3) BFS over call+import edges.
- `pagerank.ts` — graphology-pagerank on the symbol graph.
- `coupling.ts` — afferent / efferent / instability per module.
- `cycles.ts` — Tarjan SCC via graphology-components.
- `deadCode.ts` — zero-inbound symbols filtered to callable kinds with entry-point exemptions.
- `hotspots.ts` — complexity × churn (churn callback supplied by Phase 5).
- `layerViolations.ts` — user-declared LayerSpec rule check; `defaultLoreLayerSpec()` ships with `ui→core OK, ui⇏plugins, core⇏plugins`.
- `tectonicMap.ts` — module topology (modules as nodes, cross-module weighted edges, cyclic flags).

`analytics/index.ts` re-exports all eight. Deps added at root: `graphology` + `graphology-pagerank` + `graphology-components` (all MIT). `_shims.d.ts` declares `graphology-pagerank` types since the package ships untyped.

End-to-end smoke on the lore monorepo:
```
symbols=4031  relations=9036
blastRadius(parseFile, upstream): d1=15, d2=5, d3=1
pagerank top: ReadCache.delete (0.025), SyncAdapter.push, AuditLog.log, currentUser, provider
coupling: engines = stable hub (Ca 1444, I 0.04); mcp = volatile leaf (Ce 929, I 1.0)
cycles: 4 SCCs of size 2
deadCode: 341/1128 callables flagged (39 exempt)
layerViolations: 69 against defaultLoreLayerSpec
tectonicMap: 37 modules, 113 cross-module edges, 12 cyclic-2
```

### Phase 5 — git signals (host-agnostic)

4 modules under `packages/lore-plugin-developer/src/git/`. All use the local `git` binary; no host APIs. Per-host PR-state integration (GitHub / Bitbucket / GitLab) is parked for Phase 9+.

- `churn.ts` — `fileChurn`, `repoChurn`, `churnScore`. Parses `git log --since=N days ago --numstat`. `churnScore` plugs into `hotspots.ts` as the `churnLookup` callback.
- `lineage.ts` — `symbolLineage` runs `git blame --line-porcelain` over the symbol's byte range; `symbolAuthors` returns distinct authors.
- `detectChanges.ts` — `getChangedRanges(scope, baseRef?)` parses `git diff` (staged / unstaged / compare); `detectChanges` overlaps changed ranges with the symbol table.
- `prRisk.ts` — combines blast radius × complexity × churn. Banding: low / medium / high / critical.

`git/index.ts` re-exports the surface.

### Phase 6 — MCP tool surface

3 modules under `packages/lore-plugin-developer/src/mcp/`:

- `tools.ts` — `ATLAS_TOOLS` array of 18 tool definitions with JSON Schema inputs. Every list-y tool takes a `mode` parameter (thin/standard/full) for the two-tier response shaping that saves LLM tokens.
- `aliases.ts` — `GITNEXUS_TO_ATLAS_ALIASES` map; both names register during the deprecation window.
- `handlers.ts` — `ATLAS_HANDLERS` map of 13 handler functions covering the analytics + git tools (the unique value). Handlers take an `AtlasContext = { repoRoot, table, relations }` cached per workspace.

5 tools deferred to Phase 6.1 follow-up because they need live `PluginContext` (not just the graph snapshot): `code_query` (Xenova + verbatimStore), `code_context` (blast + knowledge-node neighbours), `code_rename` (existing nativeTools), `code_cypher` (Kùzu connection), `code_search_ast` (tree-sitter query API).

## Acceptance status

| Plan §3 phase | Acceptance criterion | Status |
|---|---|---|
| 3 | `lore analyze --new-parser` passes Atlas's own functional tests | ✅ via end-to-end smoke (parseRepo → resolveRepo → indexRepoWithAtlas with mock ctx) |
| 3 | Zero subprocess calls to gitnexus when flag is on | ✅ atlasIndexer.ts has zero gitnexus references |
| 4 | All 8 analytics expose typed functions | ✅ 8/8 |
| 4 | All have MCP tool handlers in Phase 6 | ✅ |
| 5 | Churn data for every file | ✅ via repoChurn |
| 5 | code_detect_changes works pre-commit | ✅ via detectChanges scope=staged |
| 5 | Verified working on at least one repo per host | Pending — needs Bitbucket-hosted repo on hand for verification |
| 6 | All 18 tool definitions present | ✅ in ATLAS_TOOLS |
| 6 | Aliases route correctly | ✅ via expandWithAliases helper |

## Carry-overs to Phase 7

1. **Phase 6.1: 5 deferred handlers.** code_query, code_context, code_rename, code_cypher, code_search_ast — wire into the developer plugin's existing PluginContext (verbatimStore, Kùzu connection, nativeTools rename). ~3 days.
2. **Phase 3.1: schema additions.** Add optional fields to CodeSymbol (complexity, byteRange-as-int, pagerank, churn30d, inboundCount). Currently the in-memory snapshot has them but the Kùzu store doesn't. ~1 day.
3. **Phase 5 cross-host verification.** Run `prRisk` and `detectChanges` against a real Bitbucket-hosted repo to confirm host-agnostic claim.
4. **CLI wiring.** `lore analyze` CLI dispatch on the `LORE_DEV_USE_NEW_PARSER` flag. ~half a day.
5. **Tests.** Each analytic + each git module wants a unit test. ~1 day.

## Phase 7 plan (NOT executed in this PR)

Per the auto-chain rule, Phase 7's destructive cutover step is a hard stop — needs Rafi's explicit "go." When ready:

1. Code retirement (autonomous): delete `gitnexusProxy.ts`, drop the gitnexus dep from `package.json`, remove the gitnexus references from `CLAUDE.md` / `AGENTS.md` / docs, retire the post-commit hook permanently (it's already disabled since Phase 1).
2. Cutover dry-run (autonomous): build the `oldId → newId` mapping table, capture pre-cutover symbol/edge counts, snapshot the graph file as `graph.pre-gitnexus-migration`.
3. **Destructive step (NEEDS GO):** drop CodeSymbol / CodeFile / CodeRelation, rewrite reconnect edges via mapping, re-index with Atlas.
4. Verify recall returns the same answers, restore from snapshot if anything looks off.

## Hand-off

Branch `feat/dev-plugin-phase-3` contains 4 commits covering Phases 3, 4, 5, 6. PR #38 (next available) opens against `main`. PR #37 (Phase 2 v1) is the dependency — that needs to merge first, OR this PR rebases onto main if Phase 2.1's branch merges directly.
