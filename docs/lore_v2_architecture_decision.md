# Lore V2: Architecture & AI Drive Convergence

## 1. The Strategic Conflict
During the V2 planning phase, an analysis of the Groundfloor ecosystem revealed a significant architectural overlap between **Digital Employee Framework (DEF)**, **AI Drive**, and **Lore**:
- **AI Drive (Python/FastAPI):** Implements a robust "Dual-Store Indexing" strategy using ChromaDB (Vectors) and SurrealDB (Relational Graph). It handles extraction, chunking, and strict Pydantic validation via a Schema Registry (`registry.py`).
- **Lore (TypeScript/Node):** Initially built to be a generalized graph database (Kùzu) and vector store (LanceDB) primarily optimized for Developer team tools (GitNexus) via the Model Context Protocol (MCP).

If Lore continued down the path of building full ingestion pipelines (e.g., Slack, Drive connectors), it would unnecessarily duplicate AI Drive's battle-tested Python ingestion queues and Pydantic validation.

## 2. The Verdict: Hybrid Producer/Consumer Architecture
To maximize the strengths of both systems and avoid tech debt, they are formally separated into a Producer/Consumer Model:

### A. Lore-Cloud (AI Drive)
**Role:** The Heavy Enterprise Backend (The "Hippocampus")
AI Drive is recognized as the ultimate knowledge brain for unstructured data processing.
- Owns all heavy Tier-2 integrations (IMAP, Google Drive, PDFs).
- Handles text extraction, recursive chunking, and dense vector embeddings using LiteLLM.
- Owns the formal Relational Schema Registry.

### B. Lore-Local (groundfloor-lore)
**Role:** The Topological Cache & MCP Gateway (The "Prefrontal Cortex")
Lore-Local drops any ambitions of being a monolithic Database server and focuses entirely on being a blazing-fast, deployable desktop daemon.
- It operates as the ultimate **Domain-Agnostic MCP Schema Engine**.
- It leverages the embedded **Kùzu** native graph engine to evaluate massive multi-hop relationships instantly (like GitNexus blast radius querying).
- It provides LLM Agents (Cursor, DEF) instantaneous local context without network latency.

## 3. Lore-Local Plugin Architecture
A JSON configuration file (`.lore/schema.json`) is sufficient to define *nouns* (data shape) but cannot define *verbs* (AST parsing, EXIF extracting). Generalizing Lore-Local strictly via configuration is insufficient for diverse scenarios (Developer code-sync vs. Family photo indexing).

Lore-Local must implement a **Plugin Architecture**:
- **Plugins Provide:** 
  1. Imperative local background code (e.g., GitNexus running AST analysis).
  2. Custom MCP Tools injected dynamically at bootstrap.
- **Templates:** When a user initializes Lore (`lore init --template family`), the engine actively loads the `FamilyPlugin` (which provides local document indexing tools) rather than the default `DeveloperPlugin` (which provides GitNexus).

## 4. Local ↔ Cloud Bridging
Lore-Local and Lore-Cloud communicate cleanly and mathematically over the Groundfloor Dataplane, using the **TS-SDK (`TsSdkAdapter`)** built during Phase 4.
- **Upward Sync:** When a local plugin extracts a local truth (e.g., `Developer -> Fixed -> Bug`), it saves it to the local Kùzu graph and syncs the Edge up to Lore-Cloud via the TS-SDK natively.
- **Downward Sync:** When AI Drive finishes chunking an Enterprise PDF and creates new metadata nodes, Lore-Local dynamically fetches those conceptual edges via the SDK webhook integration, making them available to local local LLM agents natively via MCP.

*Recorded on 2026-04-17 during Ultrathink V2 Platform Analysis.*
