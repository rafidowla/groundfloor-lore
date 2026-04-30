# Phase 7 Output — Atlas (gitnexus retirement + cutover prep)

> **Status:** Phase 7 prep landed; destructive cutover step deliberately deferred.
> **Branch:** `feat/dev-plugin-phase-7` (off `feat/dev-plugin-phase-3`).
> **Commits (1):** Phase 7 prep — cutover dry-run script + this output doc.

## Why this phase doesn't finish itself

Phase 7's destructive step rewrites the live graph: drops every `CodeSymbol`, `CodeFile`, `CodeRelation`, then re-indexes with Atlas and rewrites every `LoreAppliesToCode` / `LoreTouchesFile` / `FileContains` edge through an oldId → newId mapping table. The auto-chain rule says any phase whose acceptance involves destructive mutation of user data is a hard stop — Rafi's explicit go is required, and three preconditions must clear first:

1. **PR #37** (Phase 2 v1 — tree-sitter parser + cross-file resolver) merged into `main`.
2. **PR #39** (Phase 2.1 — call graph) merged into `main`.
3. **PR #38** (Phases 3–6 — graph integration, analytics, git signals, MCP surface) merged into `main`.
4. The daemon's `dist/` rebuilt against the merged code so `LORE_DEV_USE_NEW_PARSER=1` actually selects the Atlas path at runtime.
5. Daemon restarted (`launchctl kickstart -k gui/$(id -u)/com.groundfloor.lore`).

Until all five clear, ripping `gitnexusProxy.ts` / `codeIndexer.ts` out of the working source would brick the running daemon — its compiled bundle still imports those modules. So Phase 7's source-code retirement is a separate session that runs *after* PRs merge.

## What landed in this PR (autonomous prep only)

### `scripts/atlas-cutover-dryrun.mjs`

A non-destructive dry-run that reports what the cutover step *would* do without touching any node or edge in the live graph. It:

1. Runs Atlas's `parseRepo` + `resolveRepo` against the active workspace's repo to produce a candidate post-cutover graph in memory.
2. Reads the active workspace's existing graph counts via the daemon's read-only HTTP topology endpoint (full per-symbol enumeration deferred until Phase 6.1's `code_cypher` handler ships).
3. Reports candidate-graph counts (files / symbols / relations / by-kind breakdown).
4. Documents the 5-step cutover playbook (stop → backup → execute → restart → verify) and the rollback path (`cp graph.pre-gitnexus-migration graph; restart`).
5. Writes a timestamped report to `<LORE_HOME>/atlas-cutover-dryrun-<timestamp>.json`.

### This doc — `PHASE_7_OUTPUT.md`

The full retirement playbook below.

## Phase 7 retirement playbook (executed in a follow-up session, post-merge)

### Part A — autonomous source retirement (~half a day)

After PRs #37/#39/#38 merge into `main` and the daemon is rebuilt + restarted:

1. **Delete `packages/lore-plugin-developer/src/gitnexusProxy.ts`.** No callers once `LORE_DEV_USE_NEW_PARSER=1` is permanent.
2. **Delete `packages/lore-plugin-developer/src/codeIndexer.ts`.** Replaced by `atlasIndexer.ts` (already shipping in Phase 3).
3. **Drop the `gitnexus` dep from `package.json`.** No more subprocess.
4. **Scrub `gitnexus` references from:**
   - `CLAUDE.md` (the GitNexus section becomes the Atlas / `code_*` section)
   - `AGENTS.md` (mirror)
   - `.claude/skills/gitnexus/**` → archive or delete
   - `docs/internal/gitnexus_audit.md` → mark "audit closed, gitnexus retired YYYY-MM-DD"
   - The retirement comments in `parser/*`, `mcp/aliases.ts`, etc. (drop the "License-compliance per docs/PLAN..." headers if you'd rather, but they're harmless)
5. **Delete `scripts/hooks/post-commit.disabled-during-atlas`.** The hook is gone for good — Atlas is in-process, no re-index needed on commit.
6. **Drop the `gitnexus_*` aliases from `mcp/aliases.ts`.** One release window after Phase 8 — that's *this* phase's release. AI agents migrate to the `code_*` names.
7. **Run `npx tsc --noEmit` and `npm run test:arch`.** Both must stay clean. `test:arch` has no gitnexus violations to clear (the plugin-boundary rule was about plugin-owned vocabulary leaking into core, not about gitnexus specifically).
8. **Bump Atlas's developer-plugin version + write a CHANGELOG entry.** Phase 8 territory — note here for handoff.

### Part B — destructive cutover (NEEDS EXPLICIT GO)

Once Part A merges and the daemon runs cleanly on the gitnexus-free build:

1. **Stop the daemon.** `launchctl bootout gui/$(id -u)/com.groundfloor.lore`
2. **Backup the graph.** `cp <LORE_HOME>/workspaces/<active>/.lore/graph <LORE_HOME>/workspaces/<active>/.lore/graph.pre-gitnexus-migration` (and the same for `lancedb/` if you want a full snapshot — embeddings on `CodeSymbol` rows are about to become orphaned).
3. **Run `scripts/atlas-cutover-execute.mjs --i-have-the-go`** (NOT YET WRITTEN — that's the next deliverable in this playbook). Steps it performs:
   - Rebuild the candidate graph in memory (parseRepo + resolveRepo).
   - Enumerate existing `CodeSymbol` rows (requires Phase 6.1's `code_cypher` handler live, OR a one-off direct Kùzu read shim for cutover only).
   - Build the oldId → newId mapping table by joining on `(filePath, name, kind)`.
   - For every `LoreAppliesToCode`, `LoreTouchesFile`, `FileContains` edge: rewrite the code-side endpoint via the mapping, OR queue for the reconnect pass if no mapping found.
   - `MATCH (n) WHERE n:CodeSymbol OR n:CodeFile OR n:CodeRelation DETACH DELETE n` — drop the gitnexus-shape graph.
   - Run `indexRepoWithAtlas` for every registered repo to write the new graph.
   - Re-attach the rewritten reconnect edges; remaining unmapped edges go to the next reconnect pass for re-suggestion.
   - Print before/after counts + any unmapped edges.
4. **Restart the daemon.** `launchctl kickstart -k gui/$(id -u)/com.groundfloor.lore`
5. **Verify.** `recall({ topic: "..." })` returns the same answers it returned pre-cutover for a few sanity-check topics. `lore_status` returns green.
6. **If anything looks off:** `cp graph.pre-gitnexus-migration graph; launchctl kickstart -k ...` — back to gitnexus shape, no data lost.

### Acceptance (Part B)

Per plan §3 Phase 7:

| Criterion | How verified |
|---|---|
| Mapping table covers ≥99% of existing `CodeSymbol` rows | Cutover script prints coverage; <99% means stop and investigate |
| Recall returns same answers for sanity-check topics | Manual spot-check pre/post |
| No `gitnexus` substring in source tree | `grep -rln "gitnexus" packages/ src/ ui/ scripts/` returns empty (excluding archive notes) |
| Daemon starts cleanly on gitnexus-free build | `launchctl print gui/$(id -u)/com.groundfloor.lore` shows last-exit-status 0 |

## Carry-overs to Phase 8

1. **Write `scripts/atlas-cutover-execute.mjs`** — the destructive sibling of the dry-run. Estimate: 1 day, mostly the mapping-rewrite + reconnect-edge logic.
2. **Phase 6.1 deferred handlers** — `code_query`, `code_context`, `code_rename`, `code_cypher`, `code_search_ast`. The cutover script's enumeration can use `code_cypher` once it's live; until then, a one-off Kùzu-read shim ships with the cutover script.
3. **Drop `gitnexus_*` aliases** — already noted above as Part A item 6.
4. **CHANGELOG + Lore knowledge node** — Phase 8 docs/dogfood phase.

## Hand-off

Branch `feat/dev-plugin-phase-7` contains 1 commit: cutover dry-run script + this output doc. PR #40 (next available) opens against `main` as a draft, stacked on PR #38. Merge order, when ready: PR #37 → PR #39 → PR #38 → PR #40 (this) → coordinated cutover-execute session.

The destructive cutover step itself **does not run autonomously**. When ready, drop a "go cutover" message and I'll write `atlas-cutover-execute.mjs`, run it against a backed-up graph, and verify recall.
