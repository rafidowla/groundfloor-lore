<!-- Lore node: parked-codeburn-core-observability-2026-05-08 -->

# Parked: codeburn pattern — generalize as Lore Core AI-cost observability

PARKED 2026-05-08. Reference + future direction; not active work.

## Source
https://github.com/getagentseal/codeburn — TUI dashboard tracking token usage + cost across 18 AI coding tools (Claude Code, Codex, Cursor). Reads session files from disk; prices via LiteLLM. MIT license, npm-installable.

## Why parked here
Lore should eventually surface its own AI cost + usage telemetry. Codeburn is the closest existing pattern — session-file reader plus pricing model. The capability is workspace-agnostic (a `family` or `finance` workspace running local LLMs wants the same view), so it lands in **Lore Core**, not a plugin.

## Placement (when picked up)
- New core engine module: `packages/lore/src/engines/observability/` (or similar)
- MCP tool surface: `cost_summary`, `cost_by_workspace`, `cost_by_tool`, `cost_by_period`
- CLI: `lore cost` — daily + by workspace + by model
- Reads:
  - Existing `toolDispatchLog.ts` entries (already captures tool calls + duration)
  - Future: per-call token counts (need provider integration)
  - LiteLLM-style price table per model id

## What to lift vs build fresh
- **Lift:** the pricing table approach (LiteLLM keeps a maintained model→price map). Use directly via npm dep or fetch their data.
- **Lift:** the session-file reading approach (codeburn has battle-tested parsers for ~18 tool formats; if Lore wants to surface OTHER tools' costs alongside its own, this is the shortcut).
- **Build fresh:** the Lore-side surfaces (MCP tools, CLI, optional admin-app pane). Don't try to fork their TUI.

## Trigger to unpark
Any of:
- A user explicitly asks "how much did this conversation cost?" through Lore
- Cost telemetry becomes a product requirement for the admin app
- LLM usage across the daemon hits a level where tracking starts to matter (>$X/month/user)

## Cross-references
- `lore-artifact-policy-layer-2026-05-07` (audit/retention precedent for cost ledger)
- `arch-core-vs-dev-plugin-canonical-mapping-2026-04-27` (placement test — codeburn passes the family-workspace test)
