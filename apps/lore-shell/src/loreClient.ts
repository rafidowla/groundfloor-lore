/**
 * Lore daemon client (Phase 3c).
 *
 * Thin typed wrapper around the Rust IPC commands `daemon_health` and
 * `daemon_topology`. The actual HTTP work happens Rust-side (see
 * `src-tauri/src/daemon.rs`) so the renderer never sees the bootstrap
 * token and CORS doesn't apply.
 *
 * Errors come back as a discriminated union mirroring Rust's
 * `DaemonError` (serde tag = "kind", content = "detail"). Use
 * `parseDaemonError()` and `describeDaemonError()` for UI surface.
 */
import { invoke } from '@tauri-apps/api/core';

// ────────────────────────────────────────────────────────────────────────
// Wire types — keep in sync with `src-tauri/src/daemon.rs`.
// ────────────────────────────────────────────────────────────────────────

export interface HealthReport {
    port: number;
    /** Daemon-reported status string ("ok" today). */
    status: string;
    version?: string | null;
    sessions?: number | null;
    /**
     * Phase 8 — Dataplane bind state from the daemon. Optional because
     * older daemons (<2.1) don't include it.
     */
    dataplane?: DataplaneState | null;
    /** "local" | "cloud" — daemon's effective deployment mode. */
    deploymentMode?: 'local' | 'cloud' | null;
    /** Whether the user disabled telemetry. When true, dataplane is "opted-out". */
    telemetryOptOut?: boolean | null;
}

/**
 * Phase 8 — Dataplane bind state, mirroring the daemon's
 * `getDataplaneState()` (server.ts).
 *
 *   - `unknown`    : ping hasn't fired yet (early boot)
 *   - `offline`    : no credential present (DATAPLANE_API_KEY env or
 *                    keychain `dataplane` account both empty)
 *   - `opted-out`  : telemetry disabled in config; ping skipped
 *   - `bound`      : credential present AND tenant /health responded 2xx
 *   - `error`      : credential present but tenant unreachable / error
 */
export type DataplaneState =
    | 'unknown'
    | 'offline'
    | 'opted-out'
    | 'bound'
    | 'error';

export function describeDataplaneState(
    s: DataplaneState | null | undefined,
    deploymentMode?: 'local' | 'cloud' | null,
): string {
    if (s == null) {
        return 'Daemon does not report Dataplane state (older version). Cloud sync status unknown.';
    }
    switch (s) {
        case 'unknown':
            return 'Dataplane health ping has not fired yet — daemon is still booting.';
        case 'offline':
            return deploymentMode === 'cloud'
                ? 'Cloud-mode daemon, but no Dataplane credential found. Add DATAPLANE_API_KEY to your launchd plist (or store it in keychain account "dataplane") and restart the daemon.'
                : 'Local-mode daemon — Dataplane sync intentionally not configured. Add a credential and restart to enable cloud team sync.';
        case 'opted-out':
            return 'Telemetry is disabled (config.telemetryOptOut). Dataplane sync is intentionally skipped. Re-enable in settings if you want cloud team sync.';
        case 'bound':
            return 'Bound to Dataplane — your workspace is syncing to the team tenant.';
        case 'error':
            return 'Credential present but tenant unreachable. Check your network and that the Dataplane URL is correct (DATAPLANE_URL env on the daemon).';
    }
}

/**
 * Topology node. Shape varies by what the daemon (and any active
 * plugin's `contributeTopology` hook) emits — `id`, `label`, `type`,
 * and `project` are the LoreNode core fields, but additional fields may
 * be present. Index-signature so the inspector can pull arbitrary
 * configured columns without TS yelling.
 */
export interface TopologyNode {
    id?: string;
    label?: string;
    type?: string;
    project?: string;
    group?: string;
    [field: string]: unknown;
}

export interface TopologyEdge {
    from?: string;
    to?: string;
    label?: string;
    [field: string]: unknown;
}

export interface TopologyResponse {
    nodes: TopologyNode[];
    edges: TopologyEdge[];
    truncated: boolean;
    limit: number;
    totalCoreNodes: number;
}

export type DaemonError =
    | { kind: 'Unreachable'; detail: { port: number; message: string } }
    | { kind: 'HttpStatus'; detail: { port: number; status: number; body: string } }
    | { kind: 'BadBootstrapBody'; detail: { message: string } }
    | { kind: 'InvalidResponse'; detail: { message: string } }
    | { kind: 'Internal'; detail: { message: string } };

// ────────────────────────────────────────────────────────────────────────
// IPC wrappers
// ────────────────────────────────────────────────────────────────────────

export async function daemonHealth(): Promise<HealthReport> {
    return await invoke<HealthReport>('daemon_health');
}

export async function daemonTopology(limit = 5000): Promise<TopologyResponse> {
    return await invoke<TopologyResponse>('daemon_topology', { limit });
}

// ────────────────────────────────────────────────────────────────────────
// Phase 3d — discovery (launchd state + HTTP probe in one call).
// ────────────────────────────────────────────────────────────────────────

export type LaunchdState =
    | { kind: 'NotApplicable' }
    | { kind: 'PlistMissing' }
    | { kind: 'NotLoaded'; plist_path: string }
    | { kind: 'Running'; plist_path: string; pid: number }
    | { kind: 'LoadedNotRunning'; plist_path: string }
    | { kind: 'UnknownError'; message: string };

export interface DiscoverReport {
    platform: 'macos' | 'linux' | 'windows' | 'other';
    launchd: LaunchdState;
    http_health: HealthReport | null;
    http_error: DaemonError | null;
}

export async function discoverDaemon(): Promise<DiscoverReport> {
    return await invoke<DiscoverReport>('discover_daemon');
}

/**
 * Human-readable description of a `LaunchdState`. Use for tooltips /
 * inline hints. The kind itself drives styling (running / warning /
 * error pill colour).
 */
export function describeLaunchdState(s: LaunchdState): string {
    switch (s.kind) {
        case 'NotApplicable':
            return 'launchd is macOS-only. On this platform the daemon must be started by another mechanism (systemd / sc.exe / manual).';
        case 'PlistMissing':
            return 'No com.groundfloor.lore.plist found in standard LaunchAgents paths. Install the daemon via its installer to register the launchd job.';
        case 'NotLoaded':
            return `Plist exists at ${s.plist_path} but is not loaded. Run \`launchctl load ${s.plist_path}\` to start the daemon.`;
        case 'Running':
            return `Daemon running under launchd · PID ${s.pid} · plist ${s.plist_path}`;
        case 'LoadedNotRunning':
            return `Job loaded (plist ${s.plist_path}) but no PID — between respawns or KeepAlive=false.`;
        case 'UnknownError':
            return `launchctl error: ${s.message}`;
    }
}

// ────────────────────────────────────────────────────────────────────────
// Phase 6 — DEF runtime discovery (launchd-only, no HTTP probe).
// ────────────────────────────────────────────────────────────────────────

/**
 * Wire shape of the `discover_def` Tauri command. Mirrors
 * `DiscoverReport` for symmetry, but DEF has no HTTP probe — DEF is an
 * MCP CLIENT (talks to Lore via Lore's MCP), not a server, so there's
 * no port to ping. Visibility is launchd state only. See
 * `apps/lore-shell/src-tauri/src/def_discovery.rs` and
 * `docs/DEF_LOCAL_FIRST.md` for the rationale.
 */
export interface DiscoverDefReport {
    platform: 'macos' | 'linux' | 'windows' | 'other';
    launchd: LaunchdState;
    /** Echoed for the UI tooltip (e.g. "com.groundfloor.def"). */
    label: string;
    /** Echoed for `launchctl load` hints (e.g. "com.groundfloor.def.plist"). */
    plist_filename: string;
}

export async function discoverDef(): Promise<DiscoverDefReport> {
    return await invoke<DiscoverDefReport>('discover_def');
}

/**
 * DEF-aware variant of `describeLaunchdState`. The Lore-daemon version
 * mentions `com.groundfloor.lore.plist` in its hints; this one mentions
 * the DEF plist instead so operators get a copy-pasteable command for
 * the right job. The two-primitives architecture keeps the strings
 * separate on purpose — confusing "your daemon is offline" between
 * Lore and DEF would be the worst kind of error message.
 */
export function describeDefLaunchdState(s: LaunchdState): string {
    switch (s.kind) {
        case 'NotApplicable':
            return 'launchd is macOS-only. On this platform DEF must be started by another mechanism (systemd / sc.exe / manual).';
        case 'PlistMissing':
            return 'No com.groundfloor.def.plist found in standard LaunchAgents paths. DEF is not installed on this machine. Lore continues to work without DEF — agents and scheduled tasks just have no runtime to execute on.';
        case 'NotLoaded':
            return `DEF plist exists at ${s.plist_path} but is not loaded. Run \`launchctl load ${s.plist_path}\` to start the DEF runtime.`;
        case 'Running':
            return `DEF runtime running under launchd · PID ${s.pid} · plist ${s.plist_path}`;
        case 'LoadedNotRunning':
            return `DEF job loaded (plist ${s.plist_path}) but no PID — between respawns or KeepAlive=false.`;
        case 'UnknownError':
            return `launchctl error: ${s.message}`;
    }
}

// ────────────────────────────────────────────────────────────────────────
// Error helpers
// ────────────────────────────────────────────────────────────────────────

export function parseDaemonError(
    raw: unknown,
): DaemonError | { kind: 'Unknown'; detail: { message: string } } {
    if (raw && typeof raw === 'object' && 'kind' in raw) {
        return raw as DaemonError;
    }
    return { kind: 'Unknown', detail: { message: String(raw) } };
}

export function describeDaemonError(err: DaemonError): string {
    switch (err.kind) {
        case 'Unreachable':
            return `Lore daemon not reachable on port ${err.detail.port}. Is the launchd service running?`;
        case 'HttpStatus':
            return `Daemon returned HTTP ${err.detail.status} on port ${err.detail.port}.`;
        case 'BadBootstrapBody':
            return `Auth bootstrap failed: ${err.detail.message}`;
        case 'InvalidResponse':
            return `Daemon response shape unexpected: ${err.detail.message}`;
        case 'Internal':
            return `Internal client error: ${err.detail.message}`;
    }
}

/**
 * UI helper — render an arbitrary node field as a string. The daemon's
 * topology shape only guarantees `id/label/type/project` on core nodes;
 * inspector configs may reference plugin-specific fields that are
 * undefined in the response. We render `—` for those rather than empty
 * cells so the user can see what's missing at a glance.
 */
export function formatNodeField(
    node: TopologyNode,
    field: string,
    type?: 'string' | 'number' | 'date' | 'boolean' | 'tags',
): string {
    const v = node[field];
    if (v == null) return '—';
    if (Array.isArray(v)) return v.join(', ');
    if (typeof v === 'object') return JSON.stringify(v);
    if (type === 'date') {
        const d = new Date(String(v));
        return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString();
    }
    if (type === 'boolean') return v ? 'true' : 'false';
    return String(v);
}
