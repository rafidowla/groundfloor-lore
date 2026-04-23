# Lore V2: Implementation Tasks

## Changelog
- **2026-04-23** — Reviewed for post-V2 reconciliation. Added changelog, Definition of Done, capability-manifest schema, health-ping wire format, Dataplane-down rollback, hardware-detection caveat. Q1/Q2 roadmap extracted to `docs/post_v2_plan.md`.
- **2026-04-23** — Mode selector (intra-workspace) formally removed. Workspaces + Projects filter cover the use case.
- **2026-04-18** — Dataplane connection deferred; code wired, runtime offline pending API key in launchd plist.

## Definition of Done (V2 ship)
V2 is shippable when **all four** of these are true:
1. Phase 0 closed — Settings modal actually persists changes and reflects live daemon state (no hardcoded banners).
2. Airplane-mode test (Phase 4) passes all five bullets.
3. 20k hard cap enforced server-side with UI banner (Phase 3).
4. Dataplane health-ping green on a real workspace, with an explicit failure-mode path when it's not (Phase 4).

Anything else tracked here is post-V2 and does not block ship.

## Phase 0: Settings Wiring (Blocker)
Current Settings modal ([ui/src/App.tsx](ui/src/App.tsx)) is mostly dead UI. Fix before any other Phase can ship. **Owner: unassigned — needs assignment before work resumes. Flagged pre-2026-04-23.**
- [ ] Add `useState` + persistence for `llmProvider`, `apiKey`, `workspaceAccount`, and `activePlugin`.
- [ ] Store `apiKey` in OS keychain via `keytar`, NOT localStorage. Keychain service name: `groundfloor-lore`; account key: `<workspace-id>:<provider>`.
- [ ] Wire `onChange` handlers on each field; PATCH `/api/config` on change.
- [ ] Replace hardcoded "V2 Dataplane is connected" banner with a real `GET /api/health` check on mount. Banner states: `connected` (green) / `offline` (amber, with retry button) / `error: <msg>` (red).
- [ ] Wire chat input (`<input>` and send button) to `/api/chat` with SSE streaming.

## Phase 1: Generalizing Lore-Local
- [x] **Strip Developer Dependencies:** Remove hardcoded `CodeSymbol` and `GitNexus` logic from the core Lore engine. *(Mostly done — 16 legacy references tracked in `.arch-baseline.json` for follow-up cleanup.)*
- [x] **Create the Developer Plugin:** Move the extracted developer tools into `packages/lore-plugin-developer/`.
- [x] **Implement Config Boot:** Engine reads `.lore/config.json`. Missing config auto-writes V1→V2 defaults with UI toast.
- [x] **Multi-plugin support:** Boot-time collision checks enforce non-overlapping table names across plugins.
- [x] **Workspace concept:** Each workspace is a separate `.lore/` directory with its own graph. `WorkspacePicker` chip switches between them.
- [x] **Plugin-swap migration (Option C — Prompt on boot):** Detect orphaned tables when `config.json` plugin set shrinks. UI modal blocks `/api/*` with `orphan_decision_required`. Options: Keep on disk / Drop permanently (requires typing `DROP`) / Re-enable plugin. Decision persisted in `plugin_history` field of `config.json`.
- [ ] **~~Mode selector (in-workspace):~~ REMOVED (V2.1 decision — confirmed 2026-04-23).** Workspaces handle context separation; Mode pills were evaluated and rejected. Projects filter in the right panel handles intra-workspace scoping.

### Phase 1 follow-ups (not blocking V2 ship)
- [ ] **Gmail connector** for the `personal` plugin (only `filesystem` exists today).
- [ ] **Workspace creation wizard** in Settings: "Create new workspace" → pick folder → pick plugin → configure connectors. Switching works today; creation is manual file-on-disk.
- [ ] **Legacy plugin-vocab cleanup:** move the 16 tracked entries in `.arch-baseline.json` out of `localGraph.ts`, `tsSdkAdapter.ts`, `syncEngine.ts`, `cli/commands.ts`, `cli/index.ts` into the Developer plugin.

## Phase 2: Dual-Path Extraction Router & Settings
- [ ] **Settings Modal Inventory:** Add to existing modal — Active Plugin selector, Extraction Path radio (Local BYOK / DEF Cloud — greyed), Telemetry opt-out toggle (stub). Keep existing Theme, Renderer, LLM Provider, API Key, Workspace Account.
- [ ] **The "Coming Soon" Cloud:** Add the `Groundfloor DEF (Digital Employee Framework) Cloud` option for file extraction. **Open question (unresolved 2026-04-23):** grey-out with tooltip, hide until it exists, or show as a waitlist CTA. Decide before Phase 2 closes — current greyed-out design risks support tickets.
- [ ] **BYOK Local Pipeline:** Server-side `/api/extract` reads the configured LLM's capability manifest and accepts only what the LLM declares. Text-only → `.md`/`.txt`. Multimodal → add `image/png|jpeg|webp|gif`. Reject others with HTTP 415 listing accepted types.
- [ ] **Chat Routing:** Chat interactions are permanently routed to the local LLM; no cloud code path is reachable from the chat surface.

### Phase 2 spec: LLM Capability Manifest
Must be nailed before the BYOK pipeline can be built.

**Location:** `packages/lore/src/providers/<provider>/manifest.ts` — one per provider. Core ships manifests for the providers it knows; custom providers can contribute via an `ILorePlugin.registerProviders` hook (deferred to post-V2 unless needed earlier).

**Schema (TypeScript):**
```ts
interface LLMCapabilityManifest {
  provider: string;        // "anthropic" | "openai" | "ollama" | ...
  model: string;           // specific model identifier
  modalities: {
    text: true;            // always true
    image?: Array<"png" | "jpeg" | "webp" | "gif">;
    audio?: Array<"wav" | "mp3" | "flac">;   // future
    pdf?: boolean;          // native PDF ingest (Claude, Gemini)
  };
  limits: {
    contextTokens: number;
    outputTokens: number;
    maxImageBytes?: number;
  };
  features: {
    streaming: boolean;
    toolCalling: boolean;
    jsonMode: boolean;
  };
}
```

**Resolution order:** exact `provider+model` match → `provider` default → error. `/api/extract` translates `modalities` into an `Accept` MIME allowlist. Any rejection returns HTTP 415 with `{accepted: string[], reason: string}`.

## Phase 3: The Hybrid WebGL Dashboard UX
- [x] **3-Panel Layout:** Chat (Left), Sigma.js (Center), Filters (Right).
- [ ] **~~Mode pill-group:~~ REMOVED** (V2.1 decision). Skipped in favor of Workspaces + Projects filter.
- [x] **Dynamic WebGL Filtering:** Checkboxes grouped under Types / Projects. First 10 per category, "Show all (N)" expander. Per-category search at count > 15. Select-all / select-none links. Unchecking dims unselected nodes via Sigma's `nodeReducer`. (`FiltersPanel.tsx`)
- [x] **Conversational Camera Pan:** Server emits SSE `focus` events (`server.ts:2402,2425`); client consumes via `focusNodeId` state and `CameraEffect` component. Fallbacks wired: nodeId missing → ignored (`SigmaCanvas.tsx:621`); rapid coalesce via `focusCoalesceRef`.
- [x] **ForceAtlas2 cap:** 2000 iterations OR deadline (`SigmaCanvas.tsx:283`). Label threshold at rendered-size 12.
- [ ] **Hard 20k ceiling + sampled subgraph + banner.** Firm cap, not user-overridable. Server-side truncation in `/api/topology`: if node count > limit, return the 20k most-recent/most-relevant and set a `truncated: true` flag. Client shows banner: *"Graph too large — showing 20k nodes. Use filters in the right panel to narrow the view."*
- [ ] **Graph Size Limit setting (user-adjustable below the cap):** Settings slider with steps `5k / 10k / 20k`. Default auto-detected, approximate: `os.cpus().length >= 8 && os.totalmem() >= 16 GB` → 20k; `os.arch() === 'arm64'` → 20k; else → 10k; very-small (cpus < 4 or totalmem < 8 GB) → 5k. Detection is coarse — M-series tier-within-tier (M1 vs M4) is not distinguished. Help text: *"Higher values use more CPU and memory. Lore won't render more than 20k nodes at once — use filters for larger graphs."*

## Phase 4: Dataplane Sync (Stand-Alone)
- [ ] **Validate TsSdkAdapter:** Verify the Lore V2 platform binds successfully to the `.env` Dataplane credentials.
- [ ] **Health-ping only:** Single boot-time health-ping. No graph content, no telemetry payload. Full telemetry contract deferred per Non-Goals #4.
- [ ] **AI-Drive Independence:** Run a full boot/sync cycle to assure that local projects and telemetry sync *without* requiring an active connection to AI Drive or Lore-Cloud extraction engines.
- [ ] **Airplane-Mode Test:** With network disabled, verify (a) server boots; (b) Settings renders; (c) dropping `.md` attempts BYOK call and fails gracefully; (d) WebGL graph renders from local Kùzu; (e) chat returns clear "LLM unreachable" error with no silent cloud fallback.

### Phase 4 spec: Health-Ping wire format
**Endpoint:** `POST {dataplane_base}/api/v3/health/lore-ping`

**Request body:**
```json
{
  "workspace_id": "<uuid>",
  "lore_version": "2.x.y",
  "sent_at": "<ISO-8601 timestamp>"
}
```

No graph content. No counts. No telemetry. Workspace ID identifies the tenant for routing and rate-limiting; version + timestamp are for Dataplane-side observability.

**Expected response:** `200 {"ok": true, "server_time": "<ISO-8601>"}`. Any other status is a failure.

### Phase 4 spec: Dataplane-down failure mode
When the boot-time health-ping fails:
1. **Do not block daemon boot.** Lore starts in `degraded: dataplane-offline` mode.
2. **Retry with exponential backoff:** 30s, 1m, 2m, 5m, 15m, then hourly.
3. **Surface to UI:** Settings banner shows `offline` state with last-attempt timestamp and manual retry button (wired in Phase 0).
4. **No silent cloud fallback ever.** If any code path requires Dataplane and it's offline, return a clear error to the caller — never route to a different cloud or swallow silently.
5. **On recovery:** single info-level log line; UI banner flips to `connected`. No automatic re-sync of anything (there's nothing to sync in V2 ship scope).

## Post-V2

Q1 + Q2 roadmap lives in [docs/post_v2_plan.md](post_v2_plan.md). That plan assumes V2 ship is complete and starts with Q1.1 (Dataplane runtime binding — flipping this doc's Phase 4 from health-ping to bound CRUD).
