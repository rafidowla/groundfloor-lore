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

## 2026-04-18 — UI: Single composed `ViewStateEffect` owns Sigma reducers
Decision: Collapse `HoverHighlight` + `FilterEffect` into one component that owns both `nodeReducer` and `edgeReducer` on the Sigma instance. Hover state lives in a ref; filter state comes from props; one composed reducer reads both.
Reason: The prior design had each component calling `sigma.setSetting('nodeReducer', …)` independently — hovering a node overwrote the filter dim reducer with a hover-only one, and `leaveNode` set both reducers to `null`. Net effect: filtered-out nodes became visible on hover and stayed visible until a filter checkbox was toggled. This was a user-visible correctness bug.
Alternatives: (a) Make `HoverHighlight` read filter props directly and combine at call-time — works but splits the "what dims what" logic across two files. (b) Use a module-level shared ref — brittle. Option taken (single component, single source of truth for both reducers) is the cleanest.
Impact: `ui/src/components/SigmaCanvas.tsx` — deleted `HoverHighlight` and `FilterEffect`, added `ViewStateEffect`. No prop surface change for `<SigmaCanvas>`. Bug pattern: **never have multiple effects write the same Sigma setting independently; pick one owner.**

## 2026-04-18 — UI: Drop vis-network fallback renderer
Decision: Delete `GraphCanvas.tsx` + `vis-network` + `vis-data` npm deps. Sigma WebGL becomes the sole graph renderer.
Reason: The fallback was originally scaffolding for the pre-WebGL era. Assumption that it was for "large graphs" was inverted — vis-network (canvas 2D) tops out at ~1–2k nodes while Sigma (WebGL) scales to 10k–50k. Settings → Renderer Engine (Beta) toggle was never flipped in practice. Keeping it cost a 515 KB lazy chunk, 2 npm deps + 6 transitive packages, one misleading Settings toggle, and a second code path to maintain through every refactor.
Alternatives: Keep and tighten the two `any` types (~10 min, no behavior change). Rejected — maintenance cost unjustified when the primary renderer covers all realistic graph sizes.
Impact: `ui/src/components/GraphCanvas.tsx` deleted; `ui/package.json` lost `vis-network` + `vis-data`; `ui/src/App.tsx` lost `useSigmaEngine` state + the Suspense ternary + the `Renderer Engine (Beta)` settings group + the `Network` lucide import; `ui/vite.config.ts` dropped the `chunkSizeWarningLimit: 600` override. Bundle dropped ~515 KB. If project-anchor visual clustering from vis-network is ever wanted, port the invisible-anchor pattern into Sigma's FA2 pre-layout step (~1–2 hrs).

## 2026-04-18 — MCP: User-scope config over per-project
Decision: Wire the `groundfloor-lore` MCP server at `--scope user` (top-level `mcpServers` in `~/.claude.json`) rather than per-project. Use HTTP transport pointing at `http://127.0.0.1:3847/mcp`.
Reason: Prior config had the Lore MCP as `type: stdio` in the project-local entry of `~/.claude.json`, spawning a new Lore daemon via `npx tsx src/mcp/server.ts` on every Claude Code launch. That spawn (a) used a stale path that hasn't existed since the workspace split, (b) fought the launchd-managed daemon for Kùzu's single-writer lock — the root cause of the "MCP server fails to start" reports. User scope + HTTP transport means every Claude Code session (IDE, CLI, Antigravity's Claude Code extension) across every project connects to the single running daemon.
Alternatives: (a) per-project `.mcp.json` in each repo — works but requires touching N repos. Kept as an *optional* pattern for committing team-inheritable configs (e.g. `v3/groundfloor-dataplane-oss/.mcp.json` persists so teammates auto-inherit). (b) Keep stdio but fix the path — doesn't solve the Kùzu lock conflict.
Impact: `~/.claude.json` — stdio project entry removed; HTTP user-scope entry added. `claude` CLI symlinked to `/opt/homebrew/bin/claude`. Cursor already had global config at `~/.cursor/mcp.json`. Bug pattern: **Kùzu is single-writer; never let an MCP client spawn a second Lore daemon — always HTTP transport to the launchd-managed one.**

## 2026-04-18 — Dataplane runtime connection: deferred
Decision: Park the Dataplane runtime-connection work. Code integration is complete (`fireBootHealthPing()`, `/api/health` reports `bound/offline/opted-out/error/unknown`); what's missing is a `DATAPLANE_API_KEY` in the launchd plist's environment variables.
Reason: Obtaining / creating the API key requires investigating the `groundfloor-dataplane-oss` sibling repo (method unknown from the Lore side). V2 + V2.1 work just landed; the user chose to ship the merge rather than branch into a side-quest.
Impact: `/api/health` will continue to show `dataplane: "offline"` until revisited. See `docs/V2.1_status.md` → Deferred section for the exact resumption steps. Memory node `project_dataplane_connection_deferred` stored so future sessions recall the state.
