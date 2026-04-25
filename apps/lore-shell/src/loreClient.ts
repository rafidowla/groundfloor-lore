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
