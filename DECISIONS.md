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
