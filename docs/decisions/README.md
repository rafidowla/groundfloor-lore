# Architectural Decision Records

Source of truth: each decision also lives as a `decision` node in Lore (recall by id).
These files mirror the Lore nodes for source-control review and survival
across DB rebuilds.

Format: `<YYYY-MM-DD>-<slug>.md`. The first line of each file is the Lore
node id so a future session can `lore_tool_invoke({name: "get_full", id: "..."})`
to fetch the canonical version.

## Index

### V3.0-Personal architecture (2026-05-07)

- [2026-05-07-mem-know-soft-split.md](./2026-05-07-mem-know-soft-split.md) — `kind: episodic | factual` as a type-property, not namespace; auto-promote with audit; curator queue opt-in
- [2026-05-07-rebac-two-layer.md](./2026-05-07-rebac-two-layer.md) — Five relation edges (Zanzibar-style) + workspace-declared permission expressions
- [2026-05-07-sync-architecture.md](./2026-05-07-sync-architecture.md) — Local-first vs cloud-only, asymmetric; user-with-enterprise conversations live in enterprise cloud
- [2026-05-07-artifact-policy.md](./2026-05-07-artifact-policy.md) — Watermark/DLP/audit/retention travel with generated artifacts
- [2026-05-07-v3-personal-scope.md](./2026-05-07-v3-personal-scope.md) — Personal seed types, V3.0 connectors, cloud endpoint, admin app deferred

### Refactor sprint (2026-05-08)

- [2026-05-08-refactor-server-ts-sprint-plan.md](./2026-05-08-refactor-server-ts-sprint-plan.md) — End-state plan to split `mcp/server.ts` into ~21 family files

### Parked future work (2026-05-08)

- [2026-05-08-parked-codeburn-observability.md](./2026-05-08-parked-codeburn-observability.md) — Codeburn pattern → Lore Core AI-cost observability
- [2026-05-08-parked-caveman-compression.md](./2026-05-08-parked-caveman-compression.md) — Caveman compression → core recall-pipeline candidate (NOT developer plugin)
