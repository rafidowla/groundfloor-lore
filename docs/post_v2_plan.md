# Lore Post-V2 Plan — Q1 + Q2

Locked 2026-04-23. Assumes V2 ship complete per `docs/V2_tasks.md` Definition of Done.

Q3 (local personal use cases) and Q4 (AI Drive port) are parked in Lore as deferred nodes and not elaborated here.

## Changelog
- **2026-04-23** — Initial draft. All D-A through D-G gating decisions locked.

## Locked decisions (D-A through D-G)

| # | Decision | Summary |
|---|---|---|
| D-A | Doc-type validators | Cut v1; defer with trigger. Revisit when second document-type plugin lands. |
| D-B | Mode selector (intra-workspace) | Dropped. Workspaces + Projects filter cover the use case. |
| D-C | Storage split | Local: Kùzu (graph+typed columns) + LanceDB (vectors). Cloud: ArangoDB + Qdrant-or-Zilliz + Postgres, all access through Dataplane per D-017. |
| D-D | Portable IR | Option A — each plugin invents a narrow IR it serializes into. No generalized CommonMark/OOXML chasing. |
| D-E | Analytical capability | Default-on, settings toggle, plugin-level opt-out. Ships with A2UI view-stack in canvas. |
| D-F | Cache tier | Local: in-process LRU + TTL + write-through invalidation (no Redis dep). Cloud-only: Redis + Dataplane change-feed + voice fast-path. Shared cache-key contract. |
| D-G | Voice fast-path | Cloud-only. Groundfloor provides fast-path API; external pipelines (Twilio, ElevenLabs) own STT/TTS. "Let me look that up" escape hatch for deeper queries. |

Each decision will be stored as a Lore node with cross-refs once this plan is signed off.

---

## Q1 — Core, ships local-first, all workspaces benefit

Ordered by dependency. Each item is demo-able standalone. Airplane-mode acceptance pattern (per V2 Phase 4) applies throughout: each Q1 item lists what must work with the network cable pulled.

### Q1.1 — Dataplane runtime binding
Flip groundfloor-lore from "code wired, runtime offline" (per `project_dataplane_connection_deferred`) to "bound." API key into launchd plist; wire Admin SDK + Consumer SDK call sites.

**Acceptance:**
- `sync_status` reports `dataplane: bound`
- One end-to-end round-trip call succeeds against a real Dataplane instance
- Airplane-mode: local functionality unchanged, Dataplane reports `offline`, no silent cloud fallback

**Unblocks:** all of Q2.
**Dependency:** V2 Phase 0 (Settings wiring, keychain for API key), V2 Phase 4 (health-ping spec).

### Q1.2 — Plugin boundary cleanup
- Move `who_is_working` from core `packages/lore/src/mcp/server.ts` (line 891) to `packages/lore-plugin-developer/` — uses `symbol` vocabulary, boundary leak.
- Add tool-provenance metadata to MCP `tools/list` response; each tool tagged `core` / `plugin:<name>`.

**Acceptance:**
- `npm run test:arch` stays green
- MCP clients (Claude Code, IDE integrations) can filter tools by provenance
- Deactivating the developer plugin removes `who_is_working` from the tool surface

**Dependency:** none.

### Q1.3 — Local cache tier (in-proc LRU)
In-process LRU with TTL + write-through invalidation on `store_node` / `store_edge` / reconnect. Shared cache-key contract with Q2.3 Redis tier (swap substrate, not shape). No Redis dependency in local install.

**Acceptance:**
- Hot-path recall measurably faster (benchmark: 3x improvement on repeat queries)
- Invalidation verified by write-then-read test: write a node, immediately recall, get the new version
- SLO: 50–200ms p95 recall
- Airplane-mode: unchanged (cache is in-proc)

**Dependency:** none.

### Q1.4 — Portable IR per plugin (D-D Option A)
Each document-type plugin defines a narrow IR it serializes into.
- Developer plugin: formalize `CodeFile` / `CodeSymbol` as the plugin's IR.
- Personal plugin: define `PersonNote` / `CalendarEvent` IR.
- Plugin template includes IR stub.

**Acceptance:**
- Plugins register their IR via `registerSchema`
- Core never touches plugin vocabulary (enforced by `test:arch`)
- New plugin template can be scaffolded with `npx lore scaffold-plugin <name>` and has a working IR on first boot

**Dependency:** Q1.2.

### Q1.5 — Analytical projection capability (default-on, toggleable)
New hook on `ILorePlugin`: `contributeAnalyticalProjections`. Core query engine can answer shape-of-data questions (counts, group-by, time-series) without an external BI tool. Settings toggle: global on/off; per-plugin opt-out.

**Acceptance:**
- `recall({query: "how many X by month"})` returns a tabular answer with source nodes
- Settings toggle disables the capability end-to-end
- A plugin can opt out and its data is excluded from analytical queries
- Airplane-mode: works (analytical projection is local)

**Dependency:** Q1.4.

### Q1.6 — A2UI view-stack in canvas
Canvas area becomes a view stack: `graph` (default) + `a2ui:<render-id>` slots. Extend chat action tokens: `{{render:component|props}}` — LLM emits, UI picks renderer.

Initial renderers: `table`, `bar_chart`. Pinned "back to graph" icon in canvas chrome — always visible, one click.

**Acceptance:**
- Analytical query result (from Q1.5) renders in canvas via `{{render:table|...}}`
- Graph-restore is one click regardless of active view
- Chat-initiated renders land in the slot without replacing the graph's data
- Airplane-mode: works (renderers are client-side)

**Dependency:** Q1.5.

### Q1.7 — Deferred Lore surfacing via recall()
Already stored `deferred-plugin-recalibrate-hook` as the pattern. Formalize: any `deferred-*` node gets auto-surfaced by `recall()` when trigger-signal tags match current work. PostToolUse hook (Claude Code) on edit events matches file paths in deferred nodes and surfaces them proactively.

**Acceptance:**
- Edit a file listed in a deferred node → Claude sees the deferred work on next `recall()` without user prompting
- Resolution stamp workflow: closing a deferred item updates the Lore node with a `resolved_at` timestamp and linked commit

**Dependency:** none.

### Q1.8 — Plugin recalibrate hook
Retires `deferred-plugin-recalibrate-hook` from the last V2 follow-up commit.
- New `ILorePlugin.recalibrate(nodeId, ctx)` optional hook.
- Core `reconnect_node` action routes to plugin when marker prefix is non-core.
- Remove the `isCore` gate in `NodeDetailDrawer` — Recalibrate button works for all nodes.
- Developer plugin implements for `file:` and `symbol:`.

**Acceptance:**
- Recalibrate works on any plugin-owned node without 404
- `deferred-plugin-recalibrate-hook` Lore node gets `resolved_at` stamp + commit ref
- Regression test: Recalibrate on a `file:` node triggers the developer plugin's hook, not the core path

**Dependency:** Q1.2, Q1.4.

### Q1.9 — Semantic zoom for topology canvas (project-blob LOD)
Single-globe-per-workspace renders fine at ~500 nodes, starts thrashing ForceAtlas2 at ~5k, and becomes unusable at the firm 20k hard cap. Introduce level-of-detail rendering on the existing SigmaCanvas: zoomed out shows one blob per project (size = node count, position = ForceAtlas2 run on the aggregate project-to-project graph with cross-project edge counts). Click/double-click a blob → camera animates in, siblings fade to background. Zoomed in = today's experience, unchanged.

Preserves Q1.6's single-canvas discipline — no page navigation, no layout thrash on drill-in, no new route. Cross-project edges remain visible at overview level as aggregate bundles (thickness = count, clickable to reveal the underlying node-to-node links). Implemented via sigma.js `reducer` functions + `camera.animate` — no new renderer, no schema change.

New endpoint: `GET /api/topology/overview?groupBy=project` returning `{ blobs: [{project, nodeCount, centerX, centerY}], aggregateEdges: [{fromProject, toProject, count}] }`. Server-side aggregation on local Kùzu (airplane-safe). Uses the existing `project` field on every node — no migration.

**Acceptance:**
- Landing workspace view renders as project-blobs (not full node graph) when workspace node count exceeds a configurable threshold (default 1000)
- Click/double-click a blob animates camera into that project's subgraph within 300ms; sibling blobs dim but remain on canvas
- Cross-project aggregate edges render at overview; clicking one reveals the underlying node-to-node links without leaving the canvas
- "Back to overview" control (breadcrumb or zoom-out affordance) returns to blob view without triggering re-layout
- Airplane-mode: works (aggregation is a local Kùzu query; rendering is client-side)
- Below threshold, canvas still renders the full single-globe view — no regression for small workspaces (developer plugin today at ~486 nodes)

**Dependency:** Q1.6.

---

## Q2 — Cloud / enterprise, server mode

Depends on Q1.1 (Dataplane bound).

### Q2.1 — Server mode deployment target
Same Lore codebase, different runtime config (Path A consolidation, 2026-04-20). Multi-tenant, stateless daemon, storage via Dataplane (Arango + Qdrant-or-Zilliz + Postgres).

**Acceptance:**
- One Lore binary runs local single-user and cloud multi-tenant by config only — no separate build
- Smoke test: spin up server-mode instance, create workspace, ingest one document, recall it
- Zero direct DB connections from Lore code (verified by network policy)

**Dependency:** Q1.1.

### Q2.2 — Cloud storage adapters (D-C)
- ArangoDB adapter for graph (swap-in for Kùzu in server mode).
- Qdrant or Zilliz for vectors (substrate TBD by benchmark during this item).
- Postgres for analytical projections (feeds Q1.5 capability when running server mode).
- All access through Dataplane per D-017.

**Acceptance:**
- Server-mode workspace reads/writes through Dataplane exclusively
- Benchmark report selects Qdrant-vs-Zilliz with reproducible workload
- Analytical queries (Q1.5) work against Postgres projection in server mode

**Dependency:** Q2.1.

### Q2.3 — Cloud cache tier (Redis + change-feed)
- Redis behind Dataplane.
- Dataplane v3 change-feed subscription for invalidation.
- Same cache-key contract as Q1.3 — swap substrate only.
- Pre-warmed embeddings for top-N FAQ-shaped queries per workspace.

**Acceptance:**
- Sub-50ms p95 on hot-path recall, sustained under load (target: 100 rps per workspace)
- Invalidation verified across replicas via change-feed
- Top-N pre-warming runs on a schedule and hits measurably improve

**Dependency:** Q2.1, Q2.2, Dataplane v3 change-feed availability.

### Q2.4 — Voice fast-path API (D-G)
Cloud-only. External pipelines (Twilio, ElevenLabs) consume via webhook.
- `POST /api/recall/fast` — sub-50ms p95.
- Output: `{answer, confidence, source_ids[], deeper_available: bool}`.
- `POST /api/recall/deep` — escape hatch for "Let me look that up" flow (1–3s latency budget, full RAG).

**Acceptance:**
- End-to-end voice demo via Twilio *or* ElevenLabs webhook for one customer use case (banking or enterprise knowledge)
- Sub-50ms p95 sustained under realistic load (50 rps per workspace, representative query mix)
- `deeper_available` signal correctly gates the escape hatch — confidence-below-threshold queries always set it true

**Dependency:** Q2.3.

### Q2.5 — SpiceDB ReBAC via Dataplane
Principal-list visibility model (Option 2): `user:` / `role:` / `team:` / `org:` / `*`. All authz checks through Dataplane v3.2.1 ReBAC admin endpoint — no direct SpiceDB connection from Lore.

**Acceptance:**
- Workspace visibility enforced on every read path
- Principal-list UI renders and edits persist through Dataplane
- Unauthorized access returns 403 with a clear `reason` field (no leaking node IDs)
- Regression test: user without access to workspace X cannot observe its existence in any API surface

**Dependency:** Q2.1.

### Q2.6 — Client Portal
Customer-facing surface for Groundfloor-hosted Lore workspaces. Workspace management, principal management, usage telemetry.

**Acceptance:**
- New customer onboards a workspace via portal without engineering involvement
- Principal management operations (add/remove/change role) complete in < 5 clicks
- Usage telemetry shows per-workspace recall rate, storage, and last-activity

**Dependency:** Q2.5.

### Q2.7 — A2UI richer renderers + plugin contribution
Q1.6 shipped `table` + `bar_chart`. Q2 extends to `timeline`, `comparison`, `form`, multi-pane. `ILorePlugin.registerRenderers` hook — plugins contribute their own.

**Acceptance:**
- Developer plugin contributes a `code-flow-diagram` renderer
- Personal plugin contributes a `calendar-week` renderer
- Renderer registration validates component name uniqueness across plugins at boot

**Dependency:** Q1.6.

### Q2.8 — Accelerator packaging
Lore ships as a single accelerator: service + MCP + skills + admin UI. One-command install, one-command deploy.

**Acceptance:**
- New customer goes from zero to working workspace in under 30 minutes (measured)
- Install artifact is a single signed binary or container image
- Deploy docs fit on one page

**Dependency:** Q2.1, Q2.6.

---

## Critical path

```
V2 ship
  └─▶ Q1.1 Dataplane runtime binding
        ├─▶ Q1.2 boundary cleanup ─▶ Q1.4 portable IR ─▶ Q1.5 analytical ─▶ Q1.6 A2UI ─▶ Q1.9 semantic zoom
        │                              └─▶ Q1.8 recalibrate hook
        └─▶ Q2.1 server mode ─▶ Q2.2 cloud storage ─▶ Q2.3 Redis cache ─▶ Q2.4 voice
                              └─▶ Q2.5 SpiceDB ─▶ Q2.6 Client Portal ─▶ Q2.8 accelerator

Parallel-able against main path: Q1.3 local cache, Q1.7 deferred surfacing.
A2UI richer renderers (Q2.7) parallel to Q2.1–Q2.6 once Q1.6 ships.
Q1.9 semantic zoom can ship independently any time after Q1.6 — no downstream blockers.
```

**Demo milestones:**
- Local demo-ready after Q1.6
- Voice demo-ready after Q2.4
- Enterprise demo-ready after Q2.8

---

## Deferred (parked in Lore)

- **Q3** — local personal use cases (post-Q2)
- **Q4** — AI Drive port (post-Q3)
- `deferred-plugin-recalibrate-hook` — resolves in Q1.8
- `decision-doc-type-validators-cut-v1-defer` (D-A) — revisit when a second document-type plugin lands

---

## Next actions

1. Batch-store D-A through D-G as decision nodes in Lore with cross-refs to this plan.
2. Store this plan itself as `plan-q1-q2-2026-04-23` with edges to each decision.
3. Confirm V2 Phase 0 owner and start Q1.1 once V2 ships.
