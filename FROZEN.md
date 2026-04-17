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
