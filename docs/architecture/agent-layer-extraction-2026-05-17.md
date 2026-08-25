# ADR — Agent layer extraction from Lore Core

**Date:** 2026-05-17
**Status:** Phase 1 shipped; Phases 2–4 planned
**Driver:** repeated need for Core touches to ship plugin-level features

---

## Context

Lore was designed as a **substrate** — tri-substrate storage (Kùzu graph + LanceDB vector + SQLite relational), schema management, and the Agentic DBA. Over time it accumulated an **agent layer** on top:

- A `/api/chat` endpoint
- A hardcoded `CRE_LORE_TOOLS` list in `packages/lore/src/mcp/http/routes/chat-prompts.ts`
- An agentic tool-calling loop in `packages/lore/src/providers/llmAgenticTools.ts` (`streamOllamaWithTools`, `streamOpenAIWithTools`)
- A `useTools` branch in `chat.ts` that hardcodes `if (name === 'cre_X') { ... }` for every domain tool
- Per-workspace system prompt + UI hints contributed by `ILorePlugin`

This grew because **Loom didn't yet exist (or wasn't mature)** when Lore needed conversational features. Lore filled the agent gap.

In May 2026 the situation changed:

- Loom is v1.0.0-rc1 (Phase 2 complete) — a real LangGraph-based agent platform.
- Adding any new domain tool to Lore requires editing Core code (`CRE_LORE_TOOLS` array + `executeTool` switch) — a clear plugin-boundary violation.
- The tools in Core are written against the original demo workspace's labels. New domain workspaces (workspace-a, future tenants) have different schemas, so the in-Core tools return 0 — a UX bug rooted in architecture, not code quality.

## Decision

**Lore Core is a substrate. The agent layer moves out.**

| Concern | Lore Core (substrate) | Host app (agent layer) |
|---|---|---|
| Tri-substrate storage (graph/vector/relational) | ✅ stays | — |
| Schema management + Agentic DBA | ✅ stays | — |
| CRUD APIs (REST + MCP) for nodes, edges, collections, schemas | ✅ stays + grows | — |
| Search/recall/traverse primitives | ✅ stays | — |
| Embedding pipeline, sync, snapshots, backup | ✅ stays | — |
| Plugin **schema** + **ingestion** contributions | ✅ stays | — |
| Plugin tools (`cre_X`) | ❌ leaves | ✅ moves here |
| System prompt assembly | ❌ leaves | ✅ moves here |
| Agentic tool-calling loop | ❌ leaves | ✅ moves here |
| Render-token semantics + A2UI dispatch | (already in UI) | ✅ stays in UI |
| `/api/chat` orchestration | ❌ leaves (or becomes a proxy) | ✅ moves here |

Host apps today are:
- **`lore-ui-experiments/ui/`** — the demo UI (interactive)
- **Loom** — long-term home for agents, scheduled tasks, multi-agent orchestration

Both call Lore's primitive APIs for data. Both own their own tool surface + system prompts + agent loops.

## Phased migration

### Phase 1 (2026-05-17) — Freeze + first host-app shortcut ✅ SHIPPED

- `CRE_LORE_TOOLS` in `chat-prompts.ts`: marked **FROZEN — AGENT LAYER, MOVING OUT OF CORE**.
- `useTools` branch in `chat.ts`: same notice.
- `streamOllamaWithTools` / `streamOpenAIWithTools` in `llmAgenticTools.ts`: same notice.
- No new domain tools may be added to `CRE_LORE_TOOLS`. Performance fixes (loop cap, thinking-mode toggle, parallel tool calls) are still in scope.
- Host-app UI (`lore-ui-experiments/ui/src/App.tsx`) ships three intent shortcuts:
  1. **Dashboard auto-mount** — portfolio intent → mount `cre_portfolio` immediately, bypass LLM render-token path.
  2. **Count answers** — "how many X" → answered locally from `workspace-a_portfolio.json`, no LLM round-trip.
  3. **Pre-injected portfolio prose** — when dashboard mounts, the LLM message is rewritten with the actual portfolio facts inline so the model produces grounded prose without spelunking the broken in-Core tools.

Phase 1 commits:
- `c516fa3` (Lore) — freeze notices on `chat-prompts.ts` + `chat.ts`
- `b055fd3`, `b6076ba`, `86c5ae6` (lore-ui-experiments) — UI shortcuts

### Phase 2 — Move more questions to the host app

For every question class that's still slow + wrong on the legacy Core path, add a UI-side intent handler that calls Lore's CRUD/search APIs directly. Replace the static JSON shortcut with live Lore REST calls. Example targets:

- "list buildings" → table from Lore's collection query
- "show me building <name>" → mount `cre_building_dashboard` after recall
- "what's the vacancy rate" → `metric_summary` from Lore's count endpoint
- "compare buildings X and Y" → 2× metric_summary from Lore counts

When a question genuinely needs reasoning across the data, the UI app composes a Loom agent call (or, today, a narrow LLM call with facts pre-injected).

### Phase 3 — Shrink Lore plugins to schema-only

Strip `systemPrompt`, `uiHints`, and `defaultFilterTypes` from `ILorePlugin`. Plugins keep:

- Schema definitions (Kùzu tables, nodeTypes, edgeRelations)
- Ingestion column mappings (`nodeKindFields`)
- Schema-migration hooks

Plugin code shrinks ~70%. Host apps own the system prompt + UI hints because those are presentation concerns, not substrate concerns.

### Phase 4 — Delete the dead code

Once one workspace (workspace-a) is fully served by the host-app pattern, delete from Lore Core:

- `packages/lore/src/mcp/http/routes/chat-prompts.ts` (entire file)
- The `useTools` branch in `packages/lore/src/mcp/http/routes/chat.ts`
- `packages/lore/src/providers/llmAgenticTools.ts` (entire file)
- `/api/chat` endpoint (or keep as a thin LLM proxy for a release cycle)
- Plugin contract fields removed in Phase 3

## Rules for contributors during the migration

**Do NOT:**
- Add new tools to `CRE_LORE_TOOLS`
- Add new `executeTool` switch cases in `chat.ts`
- Add `if (plugin.name === 'cre')` blocks anywhere in Core
- Extend any plugin's `systemPrompt`, `uiHints`, or `defaultFilterTypes`

**DO:**
- Add new domain tools as host-app intent shortcuts or Loom agent skills
- Use Lore's CRUD/search/MCP APIs for data access from the host
- Add performance fixes (caching, loop bounds, parallel tool calls) to the frozen agent loop — these are still legitimate

## Why this is right (load-bearing reasons)

1. **Single responsibility.** Lore = data. Host = intelligence. One job each.
2. **Commodity substrate.** Once Lore stops pretending to be an agent, any host (UI demo, Loom, Claude Code, custom Python) can use it as a knowledge layer.
3. **Solves the Core-touch debt.** The reason we kept needing Core changes is that tools live in Core. Pull them out — the debt evaporates.
4. **Matches where production is going.** End users will run on cloud Flash models routed through Loom (or equivalent). Lore as substrate matches that topology.
5. **Aligns with how MCP/A2A work in the wild.** Lore exposes MCP for data; agents are hosted separately. Canonical pattern.

## Tradeoffs accepted

- **Two services** (Lore + host) instead of one — slightly more deploy complexity.
- **Cross-boundary concerns** for auth, sessions, streaming — solvable with bearer + SSE proxy.
- **Migration cost** is real — Phases 2–4 will span multiple sessions.

These are worth the cost. The alternative is more `if (plugin.name === 'X')` in Core, every session, forever.

## References

- Lore + Loom prioritized gap list (lore-loom-gap-list-2026-05-15)
- Original plugin boundary rule: `groundfloor-lore/CLAUDE.md` § "Plugin Boundary (MANDATORY)"
- Convention: workspace, not project (`convention-workspace-not-project`)
- Lore is tri-substrate (`lore-tri-substrate-vector-graph-relational`)
