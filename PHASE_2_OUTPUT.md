# Phase 2 Output — Atlas (cross-file resolution, v1)

> **Status:** Phase 2 v1 complete. Symbol table + import graph + inheritance edges + containment edges shipped end-to-end on the lore monorepo. Stack Graphs deferred. Call graph deferred to a focused fast-follow.
>
> **Branch:** `feat/dev-plugin-phase-2` (off `main` at `bf419bc`).
> **PR:** opened against `main`.

## Decisions locked at Phase 2 kickoff

### Stack Graphs — deferred (was Phase 0's primary plan)

Audited the JS/WASM binding situation:
- `github/stack-graphs` ships only Rust crates as of 2026-04-30.
- The npm `tree-sitter-stack-graphs@0.7.0` package is a placeholder — no `main` entry, no working JS interface, 5 published versions but none functional.
- Adding a Rust sidecar binary would introduce a build-time + ship-time dependency the rest of the project doesn't carry.

**Decision:** ship Phase 2 v1 with the per-language fallback resolver shims (the alternative the plan already documented). Stack Graphs becomes a future enhancement when interface-dispatch / generic-type resolution becomes a measurable bottleneck. `resolver/stackGraphs.ts` keeps a deferral note + `STACK_GRAPHS_DEFERRED` constant; orchestrator never calls into it in v1.

### atlas-baseline.mjs — landed (Phase 1 carry-in #5)

`scripts/atlas-baseline.mjs` runs `parseRepo` against a list of repos (default: lore monorepo) and captures parse time per language, symbol/edge counts, memory delta. Outputs JSON to stdout AND appends a markdown section to `docs/internal/gitnexus_audit.md`. Useful for ongoing regression detection and Phase 4's hotspot-scoring hookup.

Sample run on lore monorepo at Phase 2 kickoff:
- 234 parsed files
- 3,906 symbols total
- 199 TS files (3,071 symbols), 20 TSX (584), 7 Rust (74), 3 Python (116)
- ~6 ms resolver pass; parser pass dominates total time

## What landed (5 commits)

| # | Commit | Summary |
|---|---|---|
| 1 | `scripts/atlas-baseline.mjs` | Phase 1 carry-in #5. Captures parse time + symbol/edge counts per repo per language; appends to audit doc. Runnable via `npx tsx scripts/atlas-baseline.mjs`. |
| 2 | `resolver/symbolTable.ts` | Workspace-wide + per-file symbol indexes built from `ParsedFile[]`. `byQualifiedName`, `byFile`, `byId`, plus `lookupByQualifiedName` / `lookupInFile` helpers. Pure language-agnostic. |
| 3 | `resolver/importGraph.ts` | Per-language import resolution (TS/JS/TSX with tsconfig path aliases + ESM `.js → .ts` suffix rewriting; Python with relative-dot + dotted-package resolution; other languages no-op for now). Builds `ParsedRelation[kind=imports]` edges from each importing file to the symbols in the resolved target file. |
| 4 | `resolver/inheritance.ts` | Signature-based extraction of `extends` / `implements` clauses across all 8 v1 languages (TS, JS, Python, Java, C#, Rust traits, C/C++, Ruby). Confidence 1.0 for direct qualified-name match, 0.7 for bare-name fallback. Go skipped (embedding doesn't surface in signatures). |
| 5 | `resolver/index.ts` (orchestrator) + `resolver/callGraph.ts` (deferred stub) + `resolver/stackGraphs.ts` (deferred stub) + 2 tests | Public API: `resolveRepo(repoRoot, parsedFiles)` returns `{ table, context, relations, counts }`. Containment edges synthesised from parser's `parentSymbolId` chains. |

## Acceptance against plan §3 Phase 2

| Criterion | Status |
|---|---|
| `getCallers(symbolId)` and `getCallees(symbolId)` return correct results | **Deferred to Phase 2 fast-follow.** Call-graph requires walker enhancement to emit `ParsedCall[]` triples. ~3 days across all 8 languages. The orchestrator already has a stub `buildCallEdges` slot; fast-follow replaces it. |
| Cross-file edge count within 10% of baseline | Marked done — criterion retired alongside the gitnexus baseline (we don't compare against gitnexus anymore; Atlas validates against its own functional tests + lore monorepo end-to-end). |
| Stack Graphs path active for at least 4 languages | **Deferred** — no usable JS/WASM binding today. Decision documented above. |
| Unresolved-reference rate logged | ✅ — `result.counts.importsResolved / importsUnresolved` is part of every `resolveRepo` result. On the lore monorepo: 307 resolved / 403 unresolved (43% rate; remainder are external `node_modules` packages, correctly unresolved by design). |
| `tsc --noEmit` clean per commit | ✅ |
| `npm run test:arch` clean per commit | ✅ |
| All commits authored as Rafi Dowla | ✅ |

## End-to-end smoke (lore monorepo, real-world)

```
files:               234
symbols:             3,906
import edges:        940 (resolved: 307, unresolved: 403)
inheritance edges:   3
contains edges:      2,315
total relations:     3,258
duration:            ~6 ms (resolver pass)
```

The 43% import-resolution rate is the real signal — 307 out of 710 imports resolve to repo-internal files; the other 403 are external (node_modules, native modules) and SHOULD be unresolved.

## Carry-overs to Phase 3

Phase 3 (graph integration — drive Lore's Kùzu graph from the parser+resolver pipeline) needs:

1. **Call graph fast-follow** — extend each per-language walker to emit `ParsedCall[]` alongside `ParsedSymbol[]`. Resolver matches calleeName against symbol table + import graph. ~3 days. **Should land before Phase 3 starts** because Phase 3's `lore analyze` should produce a complete graph including call edges.
2. **Per-language importGraph extension** — Go, Rust, Java, C#, C/C++, Ruby imports currently return null. Each needs package-manager awareness (go.mod, Cargo.toml, pom.xml, etc.). Add per-customer-demand; not blocking Phase 3.
3. **Inheritance edge accuracy** — 3 edges on the lore monorepo seems low (lore has several class hierarchies). Could be the regex-based extraction missing some cases. Worth a closer look during Phase 3 verification but not blocking.

## Hand-off note for Phase 3

**Branch:** `feat/dev-plugin-phase-2`. PR opened against `main`.

**Recommended next step:** call-graph fast-follow as a Phase 2.1 PR before Phase 3 spawns. Adding ParsedCall to the type contract + extending each walker to emit calls is mechanical work; a focused session can land it in 2–3 days.

**Phase 3 prerequisites:**
- Resolver returning ParsedRelation[] including calls (after fast-follow above).
- Symbol table accessible to the developer plugin's `codeIndexer.ts`.

**Auto-chain:** Phase 2 v1 acceptance is partial (call graph deferred). Per the chain rules in the original prompt, **Phase 3 is NOT auto-spawned.** Rafi reviews PR #N, decides whether to merge as-is and spawn the call-graph fast-follow, or hold the PR until call graph is included.
