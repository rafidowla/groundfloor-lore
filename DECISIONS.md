# Decisions Log

## 2026-04-11 — Block 3: Local Vector Store
Decision: Implement VerbatimStore using @lancedb/lancedb and @xenova/transformers
Reason: To keep the Lore server embedded, local-first, and zero-configuration without relying on external system daemons like ChromaDB.
Alternatives: ChromaDB, Qdrant
Impact: src/engines/verbatimStore.ts created. Semantic search is now fully local and standalone.
Note: LanceDB requires 256 rows to train an IVF-PQ index. Since we start with 0 knowledge nodes in a fresh graph, index creation was removed to rely efficiently on LanceDB's highly-optimized Flat L2 scan, manually bounded bounded downstream.

## 2026-04-11 — Block 4: Dual-Write Strategy
Decision: Dual-write knowledge nodes to Kùzu Graph and LanceDB VerbatimStore (fire-and-forget).
Reason: Maintains graph integrity gracefully without allowing vector embedding generation failures to break core MCP handlers. We prioritize the graph state machine as the fundamental root source.
Alternatives: Wait for execution via synchronous store insertion.
Impact: `store_node` silently drops un-awaited semantic insertions on error. `recall` relies on semantic metrics before resorting to keyword fallback.

## 2026-04-15 — Architecture Update: Cloud Sync via v3 TS-SDK
Decision: Migrate Cloud Sync to use the Groundfloor v3 TS-SDK instead of direct SurrealDB connections.
Reason: To decouple Lore from raw database logic, making it agnostic to the underlying Dataplane storage backend. The v3 TS-SDK provides generalized endpoints for graph syncing. Local semantic search remains LanceDB to preserve the embedded, zero-setup developer experience.
Alternatives: Raw SurrealDB directly (previous implementation), Qdrant for local (rejected due to daemon requirement).
Impact: Will completely remove the `surrealdb` dependency/adapter in favor of installing and using `@groundfloor/ts-sdk`. Uncouples local Kùzu graph from specific remote DBs.

## 2026-04-15 — Architecture Update: V2 Generalized Engine & UI
Decision: Refactor `groundfloor-lore` into a domain-agnostic, schema-driven memory engine. Implement a standalone Local Explorer UI (Split-Context visualization) featuring "Corporate Crisp" and "Developer Midnight" CSS themes, and BYO-Key / Ollama configurations. Delegate Human-In-The-Loop approvals to external webhooks (Jira) rather than building a custom Inbox UI.
Reason: To upgrade the tool from a developer MCP server into an Enterprise SaaS Client that integrates directly into existing corporate workflows.
Alternatives: Hardcoding specific use-cases (SOPs, Code); building a massive monolithic Inbox UI.
Impact: Shifts priority to building the Local UI (Block 1) using modern web frameworks while retaining Kùzu/LanceDB as the offline data layer prior to connecting the v3 TS-SDK.

## 2026-04-16 — Phase 3, Block 4.5: Security Scope Architecture (Pillar 2 Prep)
Decision: Introduce and serialize `security_scopes: string[]` across `LoreNode` definitions, Kùzu local graphs, and LanceDB offline schemas.
Reason: Groundfloor's deployment models include a Disconnected Cache (Pillar 2) where offline knowledge artifacts eventually sync upward to a centrally managed Dataplane. The SpiceDB ReBAC relationships inside the Dataplane require mathematical boundary identification (like Team Portfolios or HR Roles). Serializing this locally prevents the loss of access-boundary constraints upon network reconnection.
Alternatives: Waiting for Dataplane sync to interpret security contexts (rejected, causes insecure "Public" default ingestion).
- The local engines (`verbatimStore.ts`, `localGraph.ts`) are now fully decoupled from local identity enforcement but physically retain abstract security rules, allowing HR/Role-based JSON schema injection out of the box.

## 2026-04-17 — Phase 4, Block 5: Implemented TS-SDK SyncAdapter
Decision: Replace SurrealAdapter with TsSdkAdapter using @groundfloor/ts-sdk.
Reason: Decoupling physical raw-surreal interactions ensures Lore is cloud-agnostic as per the Phase 4 roadmap. The generic TS-SDK exposes document CRUD and Graph queries securely mapped to the Dataplane V3 configuration layer.
Impact: `surrealdb` driver completely removed. The local WriteAheadLog (WAL) now syncs out to `DATAPLANE_URL` natively through `TsSdkAdapter`.
