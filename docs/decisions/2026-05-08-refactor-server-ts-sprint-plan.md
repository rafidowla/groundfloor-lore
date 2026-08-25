<!-- Lore node: refactor-server-ts-sprint-plan-2026-05-08 -->

# Refactor sprint plan: split `mcp/server.ts` into ~21 family files

Locked 2026-05-08. Plan for the dedicated refactor sprint to finish splitting `packages/lore/src/mcp/server.ts`.

> **Status update (2026-05-08, after this plan was written):** the sprint completed across 31 commits on `claude/keen-hellman-fc284c`. server.ts went from 6,835 → 721 lines. See Lore node `refactor-server-ts-sprint-progress-2026-05-08`. The file structure below describes the **target end-state** which is now realized on that branch (pending merge to main).

## State before the sprint
- `server.ts`: 6,835 lines (down from 6,872 after `lifecycle.ts` extraction)
- Already extracted: `mcp/lifecycle.ts` + `mcp/http/routes/health.ts` (proof-of-concept)
- File-size guardrail in place: `npm run test:arch` runs `scripts/test-file-sizes.mjs` (cap 800, target 500). Baseline file: `.file-size-baseline.json`.
- CLAUDE.md "File Size Budget" section tells future sessions where new code goes.
- `mcp/phaseATools.ts` already exists (V3.0 A.5 W3) but is NOT yet wired into the live MCP server.

## Target end-state structure
```
packages/lore/src/mcp/
  server.ts                  # ~200 lines — orchestrator
  services.ts                # ~400 lines — service factory (~30 singletons)
  lifecycle.ts               # ✓ done
  phaseATools.ts             # ✓ exists; wire in during Phase 5
  tools/
    index.ts                 # ~30 lines — registers all families
    memory.ts                # store_node, store_edge, mark_stale, supersede
    search.ts                # search, search_verbatim
    recall.ts                # recall (~340 lines)
    code.ts                  # code_query, code_context, code_impact, rename, detect_changes,
                             # code_cypher, code_blast_radius, code_pagerank, code_dead_code, code_cycles
    governance.ts            # delegates to phaseATools.ts
    diagnostic.ts            # stats, lore_status, list_nodes, list_repos
  http/
    index.ts                 # ~80 lines — dispatcher
    middleware.ts            # auth + rate limit + workspace header + orphan gate
    helpers.ts               # writeJson/writeError
    routes/
      diagnostic.ts          # /health, /api/health, /api/capabilities, /api/stats, /api/storage, /api/report, /api/auth/bootstrap
      mcp.ts                 # /mcp
      nodes.ts               # /api/node*, /api/nodes, /api/subgraph
      search.ts              # /api/recall, /api/search, /tags
      topology.ts            # /api/topology*
      ingestion.ts           # /api/extract, /api/graph/*
      audit.ts               # /api/audit, /api/feedback*
      sync.ts                # /api/sync/*
      retention.ts           # /api/retention*, /api/mark-stale, /api/verbatim/*
      workspaces.ts          # /api/workspaces*, /api/repos*
      plugins.ts             # /api/plugins/*, /api/plugin-wizard/*
      code.ts                # /api/code-similar, /api/code/cypher, /api/analytics/projections*
      chat.ts                # /api/chat*
      misc.ts                # /api/config, /api/connectors, /api/orphan, /api/approval*, /api/export/html, /api/language/detect, /api/mcp-clients, /explore
```

Result: ~21 module files, each ≤500 lines target, none over 800 cap.

## Extraction pattern (already established by the lifecycle + health cuts)
- Route family file exports `tryX(req, res, pathname, deps): boolean`
- `deps` is a typed object containing only mutable singletons; pure imports re-imported in the family file
- `server.ts` replaces inline routes with `if (await tryX(req, res, pathname, deps)) return;`
- Routes still run AFTER auth + rate-limit + workspace-header + orphan gates
- Each PR: extract one family, tsc clean, test:arch clean, commit, push

## Recommended order (low-coupling → high-coupling)
1. **Foundation** (1 day): `services.ts` factory, `http/middleware.ts`, `http/helpers.ts`, `http/index.ts` dispatcher
2. **Easy routes** (1–2 days, ~6 commits): diagnostic (finish), retention, sync, workspaces, plugins, misc
3. **Medium routes** (2–3 days, ~6 commits): nodes, search, topology, audit, ingestion, code
4. **Hard routes** (1–2 days, ~2 commits): chat (lots of state), mcp transport (session lifecycle)
5. **Tools** (2–3 days, ~7 commits): diagnostic → memory → search → governance (wire phaseATools) → code → recall
6. **Cleanup** (½ day): final pass on server.ts, refresh baseline, update CLAUDE.md if structure changed

Total: roughly 8–11 days of focused work, ~80–100 commits.

## Open carveouts during the sprint
- W4 (webhook receiver HTTP route): land naturally in `http/routes/misc.ts` or new `webhook.ts`
- W5 (batch scheduler lifecycle): land in `services.ts` boot path
- `mcp/phaseATools.ts`: gets wired into `tools/index.ts` during Phase 5

## Risks + mitigations
- **Cross-cutting middleware** (workspace header, orphan gate) interleaved with `/api/auth/bootstrap` early-exit — keep that route inline OR extract middleware first and have `/api/auth/bootstrap` skip it via a flag. Mitigation: do middleware extraction in Phase 1 before any post-gate route family.
- **Module-scope side effects** in service init (e.g. `dataplane-bootping-module-load-order` bug) — preserve init order exactly; don't reorder side-effecting `const x = new ...` lines when extracting `services.ts`.
- **Per-route closure variables** — each family discovers its own deps. Build the deps interface incrementally, don't try a god-context.
- **Six active worktrees** today — sprint should land in one short window to avoid merge conflicts. Coordinate before starting.

## Definition of done
- `server.ts` ≤ 200 lines
- All route + tool family files ≤ 500 lines (target), none over 800 (cap)
- `.file-size-baseline.json` shrinks: server.ts entry removed; cli/commands.ts may still be there (separate sprint)
- `npm run test:arch` clean
- Daemon boots, every MCP tool callable, every HTTP route returns same shape as before
- E2E smoke: hit `/health`, a recall tool, a code tool, a chat round-trip
