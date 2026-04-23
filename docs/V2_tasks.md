# Lore V2: Implementation Tasks

## Changelog
- **2026-04-23 (audit, pass 2)** — Phase 2 closed (all four bullets implemented). Phase 3 partial — 4 of 6 items shipped, only the 20k hard cap + user-adjustable slider remain. DEF Cloud design question resolved (greyed-with-tooltip is the shipped choice). True remaining V2-ship work is Phase 3 (cap + slider) and Phase 4 (Dataplane binding + airplane-mode test).
- **2026-04-23 (audit, pass 1)** — Phase 0 closed. Line-by-line audit confirmed all five bullets were already implemented in shipped code; doc had not been updated to reflect reality. See Phase 0 section for evidence.
- **2026-04-23** — Reviewed for post-V2 reconciliation. Added changelog, Definition of Done, capability-manifest schema, health-ping wire format, Dataplane-down rollback, hardware-detection caveat. Q1/Q2 roadmap extracted to `docs/post_v2_plan.md`.
- **2026-04-23** — Mode selector (intra-workspace) formally removed. Workspaces + Projects filter cover the use case.
- **2026-04-18** — Dataplane connection deferred; code wired, runtime offline pending API key in launchd plist.

## Definition of Done (V2 ship)
V2 is shippable when **all four** of these are true:
1. ~~Phase 0 closed~~ — **CLOSED 2026-04-23** (audit). Settings modal persists changes via PATCH `/api/config`, hydrates from `/api/health` on mount, no hardcoded banners.
2. Airplane-mode test (Phase 4) passes all five bullets.
3. 20k hard cap enforced server-side with UI banner (Phase 3).
4. Dataplane health-ping green on a real workspace, with an explicit failure-mode path when it's not (Phase 4).

Anything else tracked here is post-V2 and does not block ship.

**Remaining work to ship V2 (as of 2026-04-23 pass-2 audit):**
1. **Phase 3 — Hard 20k cap + truncation flag + UI banner.** Server work in `/api/topology`, client banner in `App.tsx`.
2. **Phase 3 — Graph Size Limit slider (5k/10k/20k) with hardware auto-detect default.** Settings UI + `navigator.hardwareConcurrency` read on mount.
3. **Phase 4 — Dataplane runtime binding.** API key into launchd plist; verify `TsSdkAdapter` binds. This is equivalent to Q1.1 in `docs/post_v2_plan.md`.
4. **Phase 4 — Airplane-mode verification sweep.** Five-bullet test, pure verification work (not building).

Phases 0, 1 (core), 2 are closed. Phase 1 follow-ups (Gmail connector, workspace-creation wizard, legacy vocab cleanup) are post-V2.

## Phase 0: Settings Wiring (CLOSED — 2026-04-23 audit)
Originally flagged as "mostly dead UI" blocker. Line-by-line audit on 2026-04-23 confirmed all five bullets were implemented across earlier V2.1/V2.2 feature commits; the doc had simply not been updated to reflect the code. No remaining Phase 0 work.
- [x] **`useState` + persistence** for `llmProvider`, `apiKey`, and related config fields. Initial-load hydration from `/api/config` in `ui/src/App.tsx:285-303`. *(Note: `workspaceAccount` + `activePlugin` were re-scoped by the 2026-04-23 workspace model — now handled by the `WorkspacePicker` chip + per-workspace `config.json`, not Settings-modal fields. Obsolete framing, no work to do.)*
- [x] **OS keychain via `keytar`**, no localStorage. Keychain service name: `groundfloor-lore`; account key: `<provider>`. Implementation: `packages/lore/src/config/keychain.ts`; PATCH writes via `setApiKey` at `packages/lore/src/mcp/server.ts:2009`.
- [x] **`onChange` handlers → PATCH `/api/config`**. `handleProviderChange` (`App.tsx:378`) and debounced `handleApiKeyChange` (`App.tsx:742`); shared `patchConfig` helper (`App.tsx:361`). Server handler at `server.ts:1994-2027` — returns `{hasApiKey, capability, ...next}` for UI refresh.
- [x] **Real `GET /api/health` on mount** (no hardcoded banner). `App.tsx:285-303` `Promise.all` fetches `/api/health` + `/api/config` + `/api/stats`. Live rendering from `health.activePlugins` + `health.dataplane` at `App.tsx:979`. The string "V2 Dataplane is connected" no longer exists in the codebase.
- [x] **Chat input + send wired to `/api/chat` SSE**. `chatInputRef` bound to input (`App.tsx:1248`); `sendMessage` POSTs `/api/chat` (`App.tsx:804`); streams via `resp.body.getReader()` (`App.tsx:814`); send button at `App.tsx:1270`.

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

## Phase 2: Dual-Path Extraction Router & Settings (CLOSED — 2026-04-23 audit)
All four bullets verified implemented.
- [x] **Settings Modal Inventory:** Extraction Path radio (`App.tsx:1480-1508`), Active Plugins read-out (`App.tsx:1509-1516`), Telemetry opt-out toggle (`App.tsx:1698-1703`). Existing Theme / Renderer / LLM Provider / API Key / Workspace still present.
- [x] **The "Coming Soon" Cloud:** `Groundfloor DEF (Cloud)` radio option at `App.tsx:1499-1507` — `disabled` attribute, title tooltip "Requires Groundfloor Cloud sign-in (coming soon)", greyed visually. *(The 2026-04-23 open question about hide-vs-grey-vs-waitlist is resolved by shipped code: greyed-with-tooltip is the chosen design.)*
- [x] **BYOK Local Pipeline:** `/api/extract` handler at `server.ts:2034-2060` calls `decideExtraction(payload, getCapability(cfg.llmProvider))`. Router logic in `packages/lore/src/providers/extractRouter.ts`: text-only providers accept `text/plain`+`text/markdown`; multimodal adds `image/png|jpeg|webp|gif`; others get HTTP 415 with accepted-types list.
- [x] **Chat Routing:** No cloud code path from chat. `extractRouter.ts` non-goals comment at line 17 confirms: *"No DEF Cloud routing. Radio exists in UI but is greyed out."* Chat flows through `/api/chat` → local `llmDispatch.stream()` only.

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

## Phase 3: The Hybrid WebGL Dashboard UX (PARTIAL — 2 items remain)
2026-04-23 audit: 4 of 6 shipped; hard cap + slider are the two genuine remaining items.
- [x] **3-Panel Layout:** Chat (Left), Sigma.js (Center), Filters (Right).
- [ ] **~~Mode pill-group:~~ REMOVED** (V2.1 decision). Skipped in favor of Workspaces + Projects filter.
- [x] **Dynamic WebGL Filtering:** Checkboxes grouped under Types / Projects. First 10 per category, "Show all (N)" expander. Per-category search at count > 15. Select-all / select-none links. Unchecking dims unselected nodes via Sigma's `nodeReducer`. (`FiltersPanel.tsx`)
- [x] **Conversational Camera Pan:** Server emits SSE `focus` events (`server.ts:2402,2425`); client consumes via `focusNodeId` state and `CameraEffect` component. Fallbacks wired: nodeId missing → ignored (`SigmaCanvas.tsx:621`); rapid coalesce via `focusCoalesceRef`.
- [x] **ForceAtlas2 cap:** 2000 iterations OR deadline (`SigmaCanvas.tsx:283`). Label threshold at rendered-size 12.
- [ ] **Hard 20k ceiling + sampled subgraph + banner.** *(Not implemented — `/api/topology` currently calls `graph.getTopology(500)` as a preview sample, unrelated to the 20k cap. No `truncated` flag, no banner.)* Firm cap, not user-overridable. Server-side truncation in `/api/topology`: if node count > limit, return the 20k most-recent/most-relevant and set a `truncated: true` flag. Client shows banner: *"Graph too large — showing 20k nodes. Use filters in the right panel to narrow the view."*
- [ ] **Graph Size Limit setting (user-adjustable below the cap):** *(Not implemented — no slider in Settings, no `hardwareConcurrency` wiring in UI.)* Settings slider with steps `5k / 10k / 20k`. Default auto-detected, approximate: `os.cpus().length >= 8 && os.totalmem() >= 16 GB` → 20k; `os.arch() === 'arm64'` → 20k; else → 10k; very-small (cpus < 4 or totalmem < 8 GB) → 5k. Detection is coarse — M-series tier-within-tier (M1 vs M4) is not distinguished. Help text: *"Higher values use more CPU and memory. Lore won't render more than 20k nodes at once — use filters for larger graphs."*

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
