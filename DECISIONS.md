# Decisions Log

## 2026-04-11 — Block 3: Local Vector Store
Decision: Implement VerbatimStore using @lancedb/lancedb and @xenova/transformers
Reason: To keep the Lore server embedded, local-first, and zero-configuration without relying on external system daemons like ChromaDB.
Alternatives: ChromaDB, Qdrant
Impact: src/engines/verbatimStore.ts created. Semantic search is now fully local and standalone.
Note: LanceDB requires 256 rows to train an IVF-PQ index. Since we start with 0 knowledge nodes in a fresh graph, index creation was removed to rely efficiently on LanceDB's highly-optimized Flat L2 scan, manually bounded bounded downstream.
