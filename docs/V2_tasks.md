# Lore V2: Implementation Tasks

## Phase 0: Settings Wiring (Blocker)
Current Settings modal ([ui/src/App.tsx](ui/src/App.tsx)) is mostly dead UI. Fix before any other Phase can ship.
- [ ] Add `useState` + persistence for `llmProvider`, `apiKey`, `workspaceAccount`, and `activePlugin`.
- [ ] Store `apiKey` in OS keychain via `keytar`, NOT localStorage.
- [ ] Wire `onChange` handlers on each field; PATCH `/api/config` on change.
- [ ] Replace hardcoded "V2 Dataplane is connected" banner with a real `GET /api/health` check on mount.
- [ ] Wire chat input (`<input>` and send button) to `/api/chat` with SSE streaming.

## Phase 1: Generalizing Lore-Local
- [ ] **Strip Developer Dependencies:** Remove hardcoded `CodeSymbol` and `GitNexus` logic from the core Lore engine (`src/mcp/server.ts`).
- [ ] **Create the Developer Plugin:** Move the extracted developer tools (e.g., `code_query`, `gitnexus_impact`) into a new modular folder (`src/plugins/developer/`).
- [ ] **Implement Config Boot:** Engine reads `.lore/config.json` shape `{ "plugins": [...], "pluginConfig": {...}, "defaultMode": "..." }`. Missing config auto-writes `{"plugins":["developer"],"pluginConfig":{}}` with a V1→V2 migration toast in the UI.
- [ ] **Multi-plugin support:** Boot-time collision checks enforce non-overlapping table names across plugins. Colliding plugins halt boot with an error naming the conflicting table + plugins.
- [ ] **Workspace concept:** Each workspace is a separate `.lore/` directory with its own graph. Settings "Workspace Account" dropdown switches between them.
- [ ] **Mode selector (in-workspace):** Top-of-center-panel pill-group — one pill per active plugin, plus an "All" pill. Clicking a pill: (a) swaps chat system prompt, (b) applies plugin's default filter preset, (c) shows/hides plugin-specific UI panels, (d) centers camera on densest cluster for that plugin. `Cmd+1/2/3` cycles modes.
- [ ] **Plugin-swap migration (Option C — Prompt on boot):** Detect orphaned tables when `config.json` plugin set shrinks. CLI blocks at stdin; UI modal blocks `/api/*` with `orphan_decision_required`. Options: Keep on disk / Drop permanently (requires typing `DROP`) / Re-enable plugin. Decision persisted in `plugin_history` field of `config.json`.

## Phase 2: Dual-Path Extraction Router & Settings
- [ ] **Settings Modal Inventory:** Add to existing modal — Active Plugin selector, Extraction Path radio (Local BYOK / DEF Cloud — greyed), Telemetry opt-out toggle (stub). Keep existing Theme, Renderer, LLM Provider, API Key, Workspace Account.
- [ ] **The "Coming Soon" Cloud:** Add the `Groundfloor DEF (Digital Employee Framework) Cloud` option for file extraction; grey out, disable the radio, tooltip explains why.
- [ ] **BYOK Local Pipeline:** Server-side `/api/extract` reads the configured LLM's capability manifest and accepts only what the LLM declares. Text-only → `.md`/`.txt`. Multimodal → add `image/png|jpeg|webp|gif`. Reject others with HTTP 415 listing accepted types.
- [ ] **Chat Routing:** Chat interactions are permanently routed to the local LLM; no cloud code path is reachable from the chat surface.

## Phase 3: The Hybrid WebGL Dashboard UX
- [ ] **3-Panel Layout:** Establish the core structural grid: Chat (Left), Sigma.js (Center), Filters (Right).
- [ ] **Mode pill-group:** Above the center canvas, renders one pill per active plugin plus an "All" pill. Wires to the Phase 1 Mode selector behavior.
- [ ] **Dynamic WebGL Filtering:** Extract all `type` and `project` tags from the Local Graph. Render grouped checkboxes in the right panel (grouped under Types / Projects). Show first 10 per category, "Show all (N)" expander. Per-category search box when count > 15. Hover reveals node count. Select-all / select-none links per category. Unchecking dims unselected nodes via Sigma's `nodeReducer`.
- [ ] **Conversational Camera Pan:** Chat stream emits SSE `focus` events with `nodeId`; client animates `sigma.getCamera().animate(...)`.
  - [ ] **Fallbacks:** (a) LLM emits no structured ref → server regex-matches tokens against labels. (b) NodeId missing from graph → silently ignored. (c) Rapid successive events (<200ms) → coalesce to last. (d) User manually pans → pause auto-follow for 3s.
- [ ] **Performance ceilings:** 60 FPS ≤ 2k nodes; 30 FPS floor ≤ 10k; hard ceiling 20k (above → server returns sampled subgraph + banner). ForceAtlas2 capped at 2000 iterations OR 3 seconds. Labels render only for top 10% by edge-degree.

## Phase 4: Dataplane Sync (Stand-Alone)
- [ ] **Validate TsSdkAdapter:** Verify the Lore V2 platform binds successfully to the `.env` Dataplane credentials.
- [ ] **Health-ping only:** Single boot-time health-ping. No graph content, no telemetry payload. Full telemetry contract deferred per Non-Goals #4.
- [ ] **AI-Drive Independence:** Run a full boot/sync cycle to assure that local projects and telemetry sync *without* requiring an active connection to AI Drive or Lore-Cloud extraction engines.
- [ ] **Airplane-Mode Test:** With network disabled, verify (a) server boots; (b) Settings renders; (c) dropping `.md` attempts BYOK call and fails gracefully; (d) WebGL graph renders from local Kùzu; (e) chat returns clear "LLM unreachable" error with no silent cloud fallback.
