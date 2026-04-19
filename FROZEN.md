# Frozen Files

## Block 3 — Verbatim Embeddings Wrapper — frozen 2026-04-11
- src/engines/verbatimStore.ts — LanceDB semantic vector store implementation with Xenova embeddings

## Block 4 — Wiring VerbatimStore into server.ts — frozen 2026-04-11
- src/mcp/server.ts — Integrated semantic search, store syncing, and dual tracking

## Block 1 (V2 Phase 1) — The Local Explorer Framework — frozen 2026-04-15
- ui/src/App.tsx — Core Split-Context dashboard Layout, Settings Slideover, and Workspace selector
- ui/src/App.css — Layout specific flex box/glassmorphic panel stylings
- ui/src/index.css — CSS variables defining the Corporate Teal & Explorer Cyan themes
- ui/package.json — Frontend dependencies mapping (Vite/Lucide)

## Block 2 (V2 Phase 2) — Abstract Storage Interfaces — frozen 2026-04-16
- src/providers/types.ts — Core interface definitions for GraphProvider and VectorProvider
- src/engines/localGraph.ts — Abstracted Kùzu graph engine schema 
- src/engines/verbatimStore.ts — Abstracted LanceDB vector engine schema

## Block 3 (V2 Phase 3) — Domain Schema Injection — frozen 2026-04-16
- src/schemas/loader.ts — Dynamically loads .lore/schema.json for decoupled engine initialization
- src/mcp/server.ts — MCP logic converted to use dynamically injected Node/Edge schemas

## Block 4.5 (V2 Phase 3) — Security Scope Architecture — frozen 2026-04-16
- src/providers/types.ts — Added security_scopes array to LoreNode base interface
- src/engines/localGraph.ts — Migrated and mapped security_scopes to Kùzu
- src/engines/verbatimStore.ts — Mapped security_scopes to LanceDB metadata
- docs/examples/HR_Ingestion_SOP.md — Defined HR ReBAC ingestion workflow
- .lore/schema.json — Configured HR node schemas

## Block 5 (V3 Phase 4) — Cloud Sync via v3 TS-SDK — frozen 2026-04-17
- src/engines/tsSdkAdapter.ts — Implemented SyncAdapter using GroundfloorClient
- src/engines/surrealAdapter.ts — Deleted (replaced by tsSdkAdapter)
- src/mcp/server.ts — Updated DI mapping to use TsSdkAdapter and DATAPLANE configuration
- package.json — Removed surrealdb, added @groundfloor/ts-sdk workspace dependency

## Polish Pass — V2.1 post-merge — re-frozen 2026-04-18

Block 1 (V2 Phase 1) files touched during the 2026-04-18 polish pass.
Per §17.4, re-freezing with the new modification date. Full rationale in
`DECISIONS.md` entries dated 2026-04-18 and `docs/V2.1_status.md` →
"Session 2026-04-18 — polish pass".

- ui/src/App.tsx — Added `useCallback` for `handleTopologyReady` /
  `handleNodeClick` (sigma callback stability). Added `key` prop on
  `<NodeDetailDrawer>`. Removed `useSigmaEngine` state, Suspense
  ternary, `Renderer Engine (Beta)` settings toggle, `Network` lucide
  icon, 2 unused `eslint-disable` directives, vis-network lazy import.
- ui/package.json — Removed `vis-network` + `vis-data` deps.
- ui/src/components/SigmaCanvas.tsx — Collapsed `HoverHighlight` +
  `FilterEffect` into `ViewStateEffect` (single owner of
  `nodeReducer`/`edgeReducer`). Typed `drawLabel`/`drawHover` as
  `NodeLabelDrawingFunction`/`NodeHoverDrawingFunction` from
  `sigma/rendering`. Added `onTopologyReady` to `GraphLoader`'s
  `useEffect` deps (safe now that the callback is stable).
- ui/src/components/NodeDetailDrawer.tsx — Removed setState-in-effect
  clear branch; `displayDetail` computed at render time for
  plugin-owned placeholders; `cancelled` flag on the fetch so late
  callbacks don't write to unmounted state.
- ui/src/components/WorkspacePicker.tsx — Pruned 6 unused
  `eslint-disable` directives.
- ui/src/components/GraphCanvas.tsx — **Deleted** (vis-network fallback
  removed; Sigma WebGL is the sole renderer).
- ui/vite.config.ts — Removed `chunkSizeWarningLimit: 600` override
  (no large lazy chunks remain).
- docs/V2.1_status.md — Updated to reflect the polish pass + merge +
  MCP cleanup + deferred Dataplane.

**Block 1 pass criteria still hold:** UI lint clean (0/0), UI build
clean (1746 modules, SigmaCanvas 178 KB / 43.93 KB gzip), core
`npm test` + `npm run build` green. Full test battery passed before PR
#1 was merged.

## Tooling + permissions — added 2026-04-18

- .claude/settings.json — Project-level read-only tool allowlist (4
  Bash patterns + 8 MCP tools) that reduces permission prompts for
  common operations without granting arbitrary code execution. Pairs
  with the more permissive `.claude/settings.local.json` (user-specific
  overlay, not committed).
- .gitignore — Added `*.tsbuildinfo` so TypeScript incremental build
  cache files never leak into commits.
