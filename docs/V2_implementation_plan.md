# Lore V2: Product Roadmap & Implementation Plan

This plan refocuses on the core business features we discussed: generalizing the local memory engine, creating a dual-path file extraction workflow (Local BYOK vs Cloud DEF), and ensuring everything works offline without needing AI Drive active.

## Strategy Overview

**1. Generalizing Lore-Local**
We are detaching the hardcoded "Developer/GitNexus" features. Lore V2 will be a generic Enterprise Memory Engine. Developers provide a plugin (e.g., `developer` or `family`), and Lore dynamically loads the relevant schemas and tools.

**2. Chat vs Complex Extraction (The Dual-Path System)**
- **Standard Chat:** Always runs offline using your connected Local LLM.
- **Complex File Uploads (PDFs, Videos, etc.):**
  - **Path A: DEF (Digital Employee Framework) Cloud Extraction:** Routes heavy files to the Groundfloor Cloud. *(Note: This option exists in the Settings UI but is currently GREYED OUT until we build the Auth/Sign-in workflow).*
  - **Path B: Local Plugin (BYOK):** Bypasses the cloud entirely, feeding the file through your own Bring-Your-Own-Key local pipeline. File type acceptance is governed by the configured LLM's declared capabilities — text-only models accept `.md`/`.txt`, multimodal models also accept images.

**3. Offline-First Synchronization**
Lore V2 works completely locally without needing AI Drive. We maintain a lightweight connection to the `Dataplane` via `TsSdkAdapter` for a health-ping, but the heavy AI Drive extraction pipeline is strictly optional and the graph contents never leave local disk.

---

## Non-Goals (V2)

The following are explicitly OUT of scope. Any task trending toward these should be rejected or deferred:

1. **DEF (Digital Employee Framework) Cloud Extraction.** The settings UI exposes a greyed-out "Groundfloor DEF (Cloud)" radio, but extraction endpoints, auth workflow (sign-up, JWT, billing), and cloud ingestion are not built. A disabled radio with explanatory copy is the entire deliverable.
2. **Pushing the Kùzu graph to cloud storage.** Nodes, edges, and verbatim content stay on local disk. Dataplane connectivity is limited to a lightweight health ping and does not relay graph contents.
3. **Heavy binary extraction in-engine (video frames, OCR, audio transcription).** Local BYOK extraction is limited to what the configured LLM natively accepts. Lore itself does no frame-sampling, OCR, or audio decoding — that complexity belongs to DEF (deferred) or to the LLM provider directly.
4. **Full telemetry contract over Dataplane.** Phase 4 scope is bind + health-ping only. When the full contract is built, each active plugin will declare its own telemetry payload via `getTelemetryPayload()` on the `ILorePlugin` interface; what goes over the wire will be dynamic per plugin and per user config.

---

## Phased Deployment Plan

### Phase 0: Settings Wiring (Blocker)
Audit of the existing UI ([ui/src/App.tsx](ui/src/App.tsx)) shows that the Settings modal renders but is largely cosmetic:
- `LLM Provider`, `API Key`, `Workspace Account` have no `onChange` handlers and no state binding.
- The chat input has no handler.
- The "V2 Dataplane is connected" welcome message is hardcoded.

Nothing downstream (Phase 2 Dual-Path Extractor, Phase 3 Chat) can function until this is wired. Required:
- Controlled state for `llmProvider`, `apiKey`, `workspaceAccount` with persistence. API key stored via OS keychain (`keytar`), NOT localStorage.
- `onChange` handlers that PATCH `/api/config` on change.
- Real `GET /api/health` check replacing the hardcoded banner text.
- Chat input wired to `/api/chat` with SSE streaming.

### Phase 1: Generalizing Lore-Local (Plugin Extraction)
We must first strip out all the hardcoded Developer implementation so Lore can boot as a blank slate.
- **Goal:** A `config.json` that dictates which plugins are active.
- **Action:** Move all `GitNexus` and `CodeSymbol` logic out of the core server and into a modular `Developer Plugin`.
- **Workspace separation model (V2.1 decision — confirmed 2026-04-23):** Each workspace is its own `.lore/` directory with its own `config.json` and Kùzu graph. A workspace typically activates a single plugin (`developer`, `personal`, `legal`, etc.) along with the connectors that plugin needs (`filesystem`, `gmail`, git repos, ...). Users switch contexts via the top-left **WorkspacePicker** chip. The Projects filter in the right panel handles any intra-workspace scoping. Mode pill-group was evaluated and rejected — Workspaces provide the separation users actually need.
  - Boot-time collision checks still enforce non-overlapping table namespaces; multiple plugins in one workspace remain technically supported but are not the primary UX.
  - Config shape: `{ "plugins": ["personal"], "pluginConfig": { "personal": { "connectors": ["gmail","filesystem"], ... } } }`
  - Example layouts:
    - `~/Documents/Personal/.lore/config.json` → `plugins: ["personal"]`, connectors `gmail` + `filesystem` rooted at `~/Documents`, `~/Desktop`
    - `~/Code/Work/.lore/config.json` → `plugins: ["developer"]`, connector rooted at the repo paths
- **Plugin-swap migration (Option C — Prompt on boot):** If `config.json` is changed so a previously-active plugin is no longer listed, boot detects orphaned tables and prompts: `Keep on disk` (reversible), `Drop permanently` (requires typing `DROP` to confirm), `Re-enable plugin` (adds back to config). Decision persisted under `plugin_history` in `config.json`. CLI blocks at stdin prompt; UI surfaces a modal and blocks `/api/*` calls with `orphan_decision_required` until resolved.
- **V1→V2 migration:** First V2 boot against a pre-existing V1 `.lore/` directory auto-writes `config.json` as `{"plugins":["developer"],"pluginConfig":{}}`. One-time UI toast: *"Welcome to Lore V2 — the Developer plugin was activated automatically. Change this in Settings."*
- **Follow-up items not blocking V2:**
  - **Gmail connector** for the `personal` plugin (only `filesystem` exists today).
  - **Workspace creation wizard** in Settings: *"Create new workspace" → pick folder → pick plugin → configure connectors.* Workspace switching already works; creation is still manual config-on-disk.
  - **Legacy plugin-vocab leakage cleanup:** 16 tracked entries in `.arch-baseline.json` across `localGraph.ts`, `tsSdkAdapter.ts`, `syncEngine.ts`, `cli/commands.ts`, `cli/index.ts` still reference `CodeSymbol` / `GitNexus` / `CodeFile`. Marked "Legacy V2.1 debt" — move into Developer plugin in a follow-up pass.
- **Outcome:** If someone wants to use Lore for Law or Personal Finance, they swap the active plugin (via WorkspacePicker) without modifying the core server.

### Phase 2: Dual-Path Extraction Router & Settings UX
We are building the UI Settings panel to let users dictate how their context is processed.
- **Goal:** Drive explicit traffic routing.
- **Action:**
  1. Build a Unified Settings UI on top of Phase 0 wiring. Settings modal inventory: Theme, Renderer Engine, LLM Provider + API Key, Workspace Account, **Active Plugin** selector, **Extraction Path** radio (Local BYOK / DEF Cloud — greyed), **Telemetry opt-out** toggle (stub).
  2. Map standard conversation interactions strictly to the Local LLM pipeline.
  3. Map File Uploads to the Dual-Path Extractor. BYOK pipeline rules:
     - Server reads the configured LLM provider's capability manifest at upload time.
     - Text-only providers accept UTF-8 text (`.md`, `.txt`). Reject binaries with HTTP 415 listing accepted types.
     - Multimodal providers additionally accept `image/png`, `image/jpeg`, `image/webp`, `image/gif`.
     - Lore itself does no binary parsing; unsupported types are rejected cleanly, never silently mangled.
  4. Keep the DEF Cloud radio visibly greyed out with copy *"Requires Groundfloor Cloud sign-in (coming soon)"* and a tooltip explaining why.
- **Outcome:** Users understand they have a choice between enterprise cloud heavy-lifting and complete local privacy.

### Phase 3: The Hybrid WebGL Dashboard UX
With the backend decoupled, transition the UI from a simple developer readout into an interactive visualizer.
- **Goal:** A cohesive 3-panel layout.
- **Action:**
  1. **Left Panel:** Conversational AI Chat that streams SSE. On each streamed `focus` event with a `nodeId`, the client animates the Sigma camera to that node.
     - **Fallbacks:** LLM emits no structured refs → server-side regex-matches tokens against node labels. NodeId not in current graph → silently ignored. Rapid successive nodeIds (<200ms apart) → coalesce to the last. User manually pans mid-stream → pause auto-follow for 3 seconds.
  2. **Center Panel:** Sigma.js WebGL rendering.
     - **Performance ceilings:** 60 FPS ≤ 2k nodes; 30 FPS floor ≤ 10k nodes; **hard ceiling 20k nodes** (firm — not user-overridable). Above 20k, the server returns a sampled subgraph of the 20k most-recent/most-relevant nodes and the client shows a banner: *"Graph too large — showing 20k nodes. Use filters in the right panel to narrow the view."*
     - **User-adjustable Graph Size Limit setting (Settings modal):** slider with steps `5k / 10k / 20k`. Default auto-detected from `navigator.hardwareConcurrency` + memory heuristics (4-core/8GB → 10k; 8-core/16GB → 20k; M-series → 20k). No "Unlimited" option. Help text above the slider: *"Higher values use more CPU and memory. Lore won't render more than 20k nodes at once — use filters for larger graphs."*
     - **Why 20k is the firm cap:** WebGL can render more, but ForceAtlas2 layout is CPU-bound and scales non-linearly (~10-15s at 20k, ~30-60s at 50k, minutes at 100k). A firm cap prevents the browser from hanging on large graphs and forces users into the filter-driven workflow instead.
     - **ForceAtlas2 layout runs** max 2000 iterations OR 3 seconds, whichever first. Labels render only for nodes in the top 10% by edge-degree.
     - **Mode pill-group was evaluated and removed** — Workspaces provide the separation users need (see Phase 1).
  3. **Right Panel:** Dynamic filters — checkboxes grouped by `Types` and `Projects`. Show first 10 per category with "Show all (N)" expander. Per-category search box appears when count > 15. Hover reveals node count. "Select all" / "Select none" links per category. Unchecking dims non-matching nodes via Sigma's `nodeReducer`.
- **Outcome:** A cohesive "Palace of Memory" interface.

### Phase 4: Dataplane Sync (No AI-Drive Required)
We already transitioned the system from the legacy SurrealDB adapter to the Groundfloor `TsSdkAdapter`.
- **Goal:** Lightweight health-ping over Dataplane.
- **Action:** Ensure the engine binds to `.env` Dataplane credentials and sends a single health-ping on boot. The full telemetry contract is deferred (see Non-Goals #4).
- **Airplane-Mode Test (offline-first proof):** With network disabled, verify (a) server boots without errors; (b) Settings modal renders; (c) dropping a `.md` file attempts the local BYOK LLM call and fails gracefully with "LLM unreachable" — server does not crash; (d) WebGL graph renders from local Kùzu data; (e) chat input returns a clear error, never silently falls back to cloud.
- **Outcome:** Lore-Local stays safely offline/isolated for memory storage, but reports a health-ping to the Dataplane. AI Drive is explicitly not required.
