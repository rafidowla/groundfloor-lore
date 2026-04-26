import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

import {
    type LoadedManifest,
    type LoadManifestError,
    type InspectorPanel,
    type TableInspector as TableInspectorConfig,
    loadManifest,
    pickManifestFile,
    describeError,
    parseLoadError,
} from './manifest';
import { TableInspector } from './TableInspector';
import {
    discoverDaemon,
    discoverDef,
    parseDaemonError,
    describeDaemonError,
    describeLaunchdState,
    describeDefLaunchdState,
    describeDataplaneState,
    type DiscoverReport,
    type DiscoverDefReport,
    type HealthReport,
    type DataplaneState,
    type LaunchdState,
} from './loreClient';

interface ShellInfo {
    version: string;
    loreDaemonStatus: 'unknown' | 'absent' | 'running';
}

type DiscoverState =
    | { kind: 'idle' }
    | { kind: 'discovering' }
    | { kind: 'ok'; report: DiscoverReport }
    | { kind: 'error'; message: string };

/**
 * Phase 6 — DEF discovery state. Mirrors `DiscoverState` but for the
 * DEF launchd job. Separate state so a slow DEF probe never blocks the
 * Lore-daemon panel — Lore is the primary primitive and the panel
 * should always render even if DEF is missing.
 */
type DiscoverDefState =
    | { kind: 'idle' }
    | { kind: 'discovering' }
    | { kind: 'ok'; report: DiscoverDefReport }
    | { kind: 'error'; message: string };

/**
 * Phase 3d — adds launchd-aware daemon discovery. On boot the shell asks
 * Rust to:
 *   1. Locate the daemon's launchd plist (macOS).
 *   2. Read launchctl state (loaded / not loaded / running with PID).
 *   3. Probe the HTTP health endpoint.
 *
 * The combined report lets the UI explain *why* the daemon is or isn't
 * reachable — and tell the user the exact `launchctl load` command if
 * the plist is present but not loaded. The shell is still strictly
 * read-only against launchd; we never start, stop, or signal the
 * daemon. See `docs/SHELL_LIFECYCLE.md` for the contract.
 */
export function App() {
    const [info, setInfo] = useState<ShellInfo | null>(null);
    const [infoError, setInfoError] = useState<string | null>(null);

    const [loaded, setLoaded] = useState<LoadedManifest | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    const [probe, setProbe] = useState<DiscoverState>({ kind: 'idle' });
    const [defProbe, setDefProbe] = useState<DiscoverDefState>({ kind: 'idle' });

    useEffect(() => {
        invoke<ShellInfo>('shell_info')
            .then(setInfo)
            .catch((e) => setInfoError(String(e)));
        // Run discovery on boot — no manual button needed in 3d.
        runDiscovery();
        // Phase 6 — also probe the DEF runtime. Independent IPC call so
        // a slow / hanging DEF launchctl never blocks the Lore-daemon
        // panel. Both probes fire on boot and can be re-triggered
        // independently.
        runDefDiscovery();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    async function runDiscovery() {
        setProbe({ kind: 'discovering' });
        try {
            const report = await discoverDaemon();
            setProbe({ kind: 'ok', report });
        } catch (e) {
            const parsed = parseDaemonError(e);
            setProbe({
                kind: 'error',
                message:
                    parsed.kind === 'Unknown'
                        ? `Unexpected error: ${parsed.detail.message}`
                        : describeDaemonError(parsed),
            });
        }
    }

    async function runDefDiscovery() {
        setDefProbe({ kind: 'discovering' });
        try {
            const report = await discoverDef();
            setDefProbe({ kind: 'ok', report });
        } catch (e) {
            // DEF discovery uses the same DaemonError surface today
            // (Tauri's invoke serialises any thrown error). Reuse the
            // Lore-side parser so the message is at least informative.
            const parsed = parseDaemonError(e);
            setDefProbe({
                kind: 'error',
                message:
                    parsed.kind === 'Unknown'
                        ? `Unexpected error: ${parsed.detail.message}`
                        : describeDaemonError(parsed),
            });
        }
    }

    async function onLoadClicked() {
        setLoadError(null);
        const path = await pickManifestFile();
        if (path == null) return;
        setLoading(true);
        try {
            const result = await loadManifest(path);
            setLoaded(result);
        } catch (e) {
            const parsed = parseLoadError(e);
            setLoadError(
                parsed.kind === 'Unknown'
                    ? `Unexpected error: ${parsed.detail.message}`
                    : describeError(parsed as LoadManifestError),
            );
            setLoaded(null);
        } finally {
            setLoading(false);
        }
    }

    return (
        <main className="shell-root">
            <header>
                <h1>Lore</h1>
                <span className="tag">Phase 6 — Lore + DEF, two primitives</span>
            </header>

            <section className="status">
                {infoError ? (
                    <p className="error">IPC error: {infoError}</p>
                ) : info ? (
                    <dl>
                        <dt>Shell version</dt>
                        <dd>{info.version}</dd>
                        <dt>Lore daemon</dt>
                        <dd className="daemon-cell">
                            <DaemonStatusPill probe={probe} fallback={info.loreDaemonStatus} />
                            <button
                                type="button"
                                className="probe"
                                onClick={runDiscovery}
                                disabled={probe.kind === 'discovering'}
                            >
                                {probe.kind === 'discovering' ? 'Discovering…' : 'Re-probe'}
                            </button>
                        </dd>
                        {probe.kind === 'ok' && probe.report.http_health && (
                            <>
                                <dt>Dataplane</dt>
                                <dd className="daemon-cell">
                                    <DataplanePill health={probe.report.http_health} />
                                </dd>
                            </>
                        )}
                        <dt>DEF runtime</dt>
                        <dd className="daemon-cell">
                            <DefRuntimePill probe={defProbe} />
                            <button
                                type="button"
                                className="probe"
                                onClick={runDefDiscovery}
                                disabled={defProbe.kind === 'discovering'}
                            >
                                {defProbe.kind === 'discovering' ? 'Discovering…' : 'Re-probe'}
                            </button>
                        </dd>
                        {probe.kind === 'ok' && (
                            <DiscoveryDetail report={probe.report} />
                        )}
                        {defProbe.kind === 'ok' && (
                            <DefDiscoveryDetail report={defProbe.report} />
                        )}
                    </dl>
                ) : (
                    <p>Booting…</p>
                )}
            </section>

            <section className="loader">
                <div className="loader-actions">
                    <button onClick={onLoadClicked} disabled={loading}>
                        {loading ? 'Loading…' : 'Load plugin manifest…'}
                    </button>
                    {loaded && (
                        <span className="loaded-path" title={loaded.sourcePath}>
                            {loaded.sourcePath}
                        </span>
                    )}
                </div>
                {loadError && <p className="error">{loadError}</p>}
                {loaded && (
                    <ManifestView
                        loaded={loaded}
                        daemonReachable={
                            probe.kind === 'ok' && probe.report.http_health != null
                        }
                        defReachable={
                            defProbe.kind === 'ok' &&
                            defProbe.report.launchd.kind === 'Running'
                        }
                    />
                )}
            </section>

            <footer>
                <p>
                    Shell ↔ daemon is sibling, not parent — closing this window
                    never kills the daemon. External MCP clients (Claude Code,
                    Cursor, Antigravity, ChatGPT local) keep working.
                    See <code>docs/SHELL_LIFECYCLE.md</code>.
                </p>
            </footer>
        </main>
    );
}

function DaemonStatusPill({
    probe,
    fallback,
}: {
    probe: DiscoverState;
    fallback: 'unknown' | 'absent' | 'running';
}) {
    if (probe.kind === 'ok') {
        const healthy = probe.report.http_health != null;
        const launchdRunning = probe.report.launchd.kind === 'Running';
        if (healthy && launchdRunning) {
            const pid =
                probe.report.launchd.kind === 'Running'
                    ? probe.report.launchd.pid
                    : null;
            const port = probe.report.http_health!.port;
            return (
                <span
                    className="daemon daemon-running"
                    title={`launchd-managed · PID ${pid} · port ${port}`}
                >
                    running · PID {pid} · port {port}
                </span>
            );
        }
        if (healthy && !launchdRunning) {
            return (
                <span
                    className="daemon daemon-warning"
                    title="HTTP responds but no launchd job — daemon was started manually."
                >
                    running (manual)
                </span>
            );
        }
        return (
            <span
                className="daemon daemon-absent"
                title={describeLaunchdState(probe.report.launchd)}
            >
                unreachable
            </span>
        );
    }
    if (probe.kind === 'error') {
        return (
            <span className="daemon daemon-absent" title={probe.message}>
                error
            </span>
        );
    }
    if (probe.kind === 'discovering') {
        return <span className="daemon daemon-unknown">discovering…</span>;
    }
    return <span className={`daemon daemon-${fallback}`}>{fallback}</span>;
}

/**
 * Phase 8 — Dataplane bind-state pill.
 *
 * Renders alongside the daemon-status pill so the user can see at a
 * glance whether their workspace is currently syncing to the team
 * Dataplane. State sourcing:
 *
 *   `health.dataplane`         — daemon's bind state (offline / opted-out / bound / error / unknown)
 *   `health.deploymentMode`    — local vs. cloud, used to phrase the
 *                                "offline" tooltip differently
 *   `health.telemetryOptOut`   — informational, surfaced in tooltip
 *
 * Pill colour:
 *   bound      → green
 *   opted-out  → grey + italic
 *   offline    → grey (when local-mode) / orange warning (when cloud-mode)
 *   error      → red
 *   unknown    → unstyled (boot in progress)
 *
 * Backwards compat: a daemon that doesn't expose `dataplane` (older
 * than 2.1) renders as "unsupported" and links to the launchd plist
 * remediation hint.
 */
function DataplanePill({ health }: { health: HealthReport }) {
    const state = health.dataplane ?? null;
    const deploymentMode = health.deploymentMode ?? null;
    const tooltip = describeDataplaneState(state, deploymentMode);

    if (state == null) {
        return (
            <span
                className="daemon daemon-unknown"
                title={tooltip}
            >
                unsupported
                <span className="dim"> · daemon &lt;2.1</span>
            </span>
        );
    }

    const cls = pillClassForDataplane(state, deploymentMode);
    const label = labelForDataplane(state, deploymentMode);
    const optOutMark = health.telemetryOptOut ? ' · telemetry off' : '';
    return (
        <span className={`daemon ${cls}`} title={tooltip}>
            {label}
            <span className="dim">
                {deploymentMode ? ` · ${deploymentMode} mode` : ''}
                {optOutMark}
            </span>
        </span>
    );
}

function pillClassForDataplane(
    state: DataplaneState,
    deploymentMode: 'local' | 'cloud' | null,
): string {
    switch (state) {
        case 'bound':
            return 'daemon-running';
        case 'error':
            return 'daemon-absent';
        case 'opted-out':
            return 'daemon-unknown';
        case 'offline':
            // Cloud-mode-and-offline is a misconfiguration the user
            // should fix (orange warning). Local-mode-and-offline is
            // expected (grey).
            return deploymentMode === 'cloud' ? 'daemon-warning' : 'daemon-unknown';
        case 'unknown':
            return 'daemon-unknown';
    }
}

function labelForDataplane(
    state: DataplaneState,
    deploymentMode: 'local' | 'cloud' | null,
): string {
    switch (state) {
        case 'bound':
            return 'bound';
        case 'error':
            return 'error';
        case 'opted-out':
            return 'opted out';
        case 'offline':
            return deploymentMode === 'cloud' ? 'offline (no key)' : 'offline';
        case 'unknown':
            return 'starting…';
    }
}

function DiscoveryDetail({ report }: { report: DiscoverReport }) {
    return (
        <>
            <dt>launchd</dt>
            <dd>
                <code>{report.launchd.kind}</code>
                <span className="dim"> · {describeLaunchdState(report.launchd)}</span>
            </dd>
            {report.launchd.kind === 'NotLoaded' && (
                <dd className="hint">
                    Run in a Terminal:{' '}
                    <code>launchctl load {report.launchd.plist_path}</code>
                </dd>
            )}
            {report.http_error && (
                <>
                    <dt>HTTP</dt>
                    <dd className="dim">
                        {describeDaemonError(report.http_error)}
                    </dd>
                </>
            )}
        </>
    );
}

function ManifestView({
    loaded,
    daemonReachable,
    defReachable,
}: {
    loaded: LoadedManifest;
    daemonReachable: boolean;
    /**
     * Phase 6 — true when the DEF launchd job reports
     * `LaunchdState::Running`. Used to warn when a manifest declares
     * `def.required: true` but the DEF runtime is missing or down —
     * the agents/scheduledTasks rendered below won't actually execute
     * until the operator brings DEF online.
     */
    defReachable: boolean;
}) {
    const m = loaded.manifest;
    const defNeeded = Boolean(m.def);
    const defRequired = Boolean(m.def?.required);
    const defMissing = defNeeded && !defReachable;
    const inspectors = m.lore?.inspectors ?? [];
    const tableInspectors = inspectors.filter(
        (i): i is TableInspectorConfig => i.kind === 'table',
    );

    const [activeTab, setActiveTab] = useState<string | null>(
        tableInspectors[0]?.id ?? null,
    );

    return (
        <div className="manifest">
            <header className="manifest-header">
                <h2>{m.name}</h2>
                <span className="version">v{m.version}</span>
            </header>
            <p className="description">{m.description}</p>

            {m.lore && (
                <section className="primitive primitive-lore">
                    <h3>Lore contributions</h3>
                    <dl>
                        <dt>Module</dt>
                        <dd>
                            <code>{m.lore.module}</code>
                        </dd>
                        {m.lore.permissions && m.lore.permissions.length > 0 && (
                            <>
                                <dt>Permissions</dt>
                                <dd>
                                    <ul className="permissions">
                                        {m.lore.permissions.map((p) => (
                                            <li key={p}>
                                                <code>{p}</code>
                                            </li>
                                        ))}
                                    </ul>
                                </dd>
                            </>
                        )}
                    </dl>
                    {inspectors.length > 0 && (
                        <>
                            <h4>Inspectors</h4>
                            <ul className="inspectors">
                                {inspectors.map((i) => (
                                    <InspectorSummary key={i.id} inspector={i} />
                                ))}
                            </ul>
                        </>
                    )}
                </section>
            )}

            {m.def && (
                <section className="primitive primitive-def">
                    <h3>
                        DEF contributions
                        {m.def.required && (
                            <span className="badge badge-required">required</span>
                        )}
                    </h3>
                    {defMissing && (
                        <p className={`hint ${defRequired ? 'error' : ''}`}>
                            {defRequired
                                ? 'DEF is required by this manifest but not running. Agents and scheduled tasks will not execute until the DEF runtime is started.'
                                : 'DEF runtime not running. Agents and scheduled tasks below will be inert until DEF is started — load the launchd plist (status panel above) to enable.'}
                        </p>
                    )}
                    {m.def.agents && m.def.agents.length > 0 && (
                        <>
                            <h4>Agents</h4>
                            <ul>
                                {m.def.agents.map((a) => (
                                    <li key={a.name}>
                                        <strong>{a.displayName ?? a.name}</strong>
                                        {a.model && (
                                            <span className="dim"> · {a.model}</span>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        </>
                    )}
                    {m.def.scheduledTasks && m.def.scheduledTasks.length > 0 && (
                        <>
                            <h4>Scheduled tasks</h4>
                            <ul>
                                {m.def.scheduledTasks.map((t) => (
                                    <li key={t.id}>
                                        <code>{t.id}</code>
                                        <span className="dim">
                                            {' '}
                                            → agent <code>{t.agent}</code>
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        </>
                    )}
                </section>
            )}

            {tableInspectors.length > 0 && (
                <section className="inspector-tabs">
                    <h3>Live data</h3>
                    {!daemonReachable && (
                        <p className="hint">
                            Probe the daemon first (above) to enable live
                            queries. The shell only fetches when you've
                            confirmed the daemon is reachable.
                        </p>
                    )}
                    <div className="tabs">
                        {tableInspectors.map((i) => (
                            <button
                                key={i.id}
                                type="button"
                                className={`tab${activeTab === i.id ? ' active' : ''}`}
                                onClick={() => setActiveTab(i.id)}
                            >
                                {i.label}
                            </button>
                        ))}
                    </div>
                    {daemonReachable && activeTab && (
                        <TableInspector
                            key={activeTab}
                            config={
                                tableInspectors.find((i) => i.id === activeTab)!
                            }
                        />
                    )}
                </section>
            )}

            <details className="raw">
                <summary>Raw JSON</summary>
                <pre>{JSON.stringify(m, null, 2)}</pre>
            </details>
        </div>
    );
}

function InspectorSummary({ inspector }: { inspector: InspectorPanel }) {
    return (
        <li>
            <strong>{inspector.label}</strong>
            <span className="dim"> · {inspector.kind}</span>
            {inspector.kind === 'table' && (
                <span className="dim">
                    {' '}
                    · entity <code>{inspector.entity}</code> ·{' '}
                    {inspector.columns.length} columns
                </span>
            )}
            {(inspector.kind === 'graph' ||
                inspector.kind === 'timeline') && (
                <span className="dim">
                    {' '}
                    · entity <code>{inspector.entity}</code>
                </span>
            )}
        </li>
    );
}

/**
 * Phase 6 — DEF runtime status pill.
 *
 * Mirrors `DaemonStatusPill` for the Lore daemon but reads launchd
 * state only — DEF has no HTTP probe (it's an MCP client, not a
 * server, per `docs/DEF_LOCAL_FIRST.md`). Variants:
 *
 *   Running           → green; "running · PID …"
 *   LoadedNotRunning  → orange warning; "between respawns"
 *   NotLoaded         → grey; tooltip shows the `launchctl load`
 *                       command needed to bring it up
 *   PlistMissing      → grey-italic "not installed" — most operators
 *                       use Lore without DEF, so this is the
 *                       "neutral" state, not an error
 *   NotApplicable     → grey-italic "n/a" (non-macOS for now)
 *   UnknownError      → red
 *
 * The label/styling diverges from the Lore-daemon pill on the
 * "missing" case: a missing Lore daemon means Lore is dead; a missing
 * DEF means the user simply hasn't installed DEF yet, and that's
 * fine.
 */
function DefRuntimePill({ probe }: { probe: DiscoverDefState }) {
    if (probe.kind === 'discovering') {
        return <span className="daemon daemon-unknown">discovering…</span>;
    }
    if (probe.kind === 'error') {
        return (
            <span className="daemon daemon-absent" title={probe.message}>
                error
            </span>
        );
    }
    if (probe.kind === 'idle') {
        return <span className="daemon daemon-unknown">idle</span>;
    }
    const s: LaunchdState = probe.report.launchd;
    const tooltip = describeDefLaunchdState(s);
    switch (s.kind) {
        case 'Running':
            return (
                <span className="daemon daemon-running" title={tooltip}>
                    running · PID {s.pid}
                </span>
            );
        case 'LoadedNotRunning':
            return (
                <span className="daemon daemon-warning" title={tooltip}>
                    loaded · no PID
                </span>
            );
        case 'NotLoaded':
            return (
                <span className="daemon daemon-unknown" title={tooltip}>
                    not loaded
                </span>
            );
        case 'PlistMissing':
            return (
                <span className="daemon daemon-unknown" title={tooltip}>
                    not installed
                    <span className="dim"> · optional</span>
                </span>
            );
        case 'NotApplicable':
            return (
                <span className="daemon daemon-unknown" title={tooltip}>
                    n/a
                    <span className="dim"> · {probe.report.platform}</span>
                </span>
            );
        case 'UnknownError':
            return (
                <span className="daemon daemon-absent" title={tooltip}>
                    error
                </span>
            );
    }
}

/**
 * Phase 6 — DEF discovery detail rows. Mirrors `DiscoveryDetail` for
 * the Lore daemon. Renders inside the same `<dl>` as the rest of the
 * status panel.
 */
function DefDiscoveryDetail({ report }: { report: DiscoverDefReport }) {
    return (
        <>
            <dt>DEF launchd</dt>
            <dd>
                <code>{report.launchd.kind}</code>
                <span className="dim">
                    {' '}
                    · {describeDefLaunchdState(report.launchd)}
                </span>
            </dd>
            {report.launchd.kind === 'NotLoaded' && (
                <dd className="hint">
                    Run in a Terminal:{' '}
                    <code>launchctl load {report.launchd.plist_path}</code>
                </dd>
            )}
            {report.launchd.kind === 'PlistMissing' && (
                <dd className="hint dim">
                    DEF is the second primitive (alongside Lore). Most
                    workspaces don't need it; install only when you
                    want the agent runtime to host{' '}
                    <code>def.agents</code> and{' '}
                    <code>def.scheduledTasks</code> from plugin
                    manifests.
                </dd>
            )}
        </>
    );
}
