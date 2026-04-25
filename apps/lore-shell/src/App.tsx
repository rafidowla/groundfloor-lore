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
    daemonHealth,
    parseDaemonError,
    describeDaemonError,
    type HealthReport,
} from './loreClient';

interface ShellInfo {
    version: string;
    loreDaemonStatus: 'unknown' | 'absent' | 'running';
}

type DaemonProbe =
    | { kind: 'idle' }
    | { kind: 'probing' }
    | { kind: 'ok'; report: HealthReport }
    | { kind: 'error'; message: string };

/**
 * Phase 3c — adds the daemon HTTP bridge. The shell can now:
 *   1. Probe the running Lore daemon's `/api/health` (button under the
 *      status section).
 *   2. Render `TableInspector` panels by fetching `/api/topology` and
 *      filtering to the entity type the manifest declares.
 *
 * Daemon discovery + connection (sibling launchd service) lands in 3d;
 * for now the daemon must already be running on `LORE_PORT` (3847 by
 * default) when the shell starts.
 */
export function App() {
    const [info, setInfo] = useState<ShellInfo | null>(null);
    const [infoError, setInfoError] = useState<string | null>(null);

    const [loaded, setLoaded] = useState<LoadedManifest | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    const [probe, setProbe] = useState<DaemonProbe>({ kind: 'idle' });

    useEffect(() => {
        invoke<ShellInfo>('shell_info')
            .then(setInfo)
            .catch((e) => setInfoError(String(e)));
    }, []);

    async function onProbeClicked() {
        setProbe({ kind: 'probing' });
        try {
            const report = await daemonHealth();
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
                <span className="tag">Phase 3c — daemon bridge + table inspector</span>
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
                                onClick={onProbeClicked}
                                disabled={probe.kind === 'probing'}
                            >
                                {probe.kind === 'probing' ? 'Probing…' : 'Probe'}
                            </button>
                        </dd>
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
                {loaded && <ManifestView loaded={loaded} daemonReachable={probe.kind === 'ok'} />}
            </section>

            <footer>
                <p>
                    Daemon discovery + connect (sibling launchd service) lands
                    in 3d. See <code>docs/plugin-manifest-spec.md</code>.
                </p>
            </footer>
        </main>
    );
}

function DaemonStatusPill({
    probe,
    fallback,
}: {
    probe: DaemonProbe;
    fallback: 'unknown' | 'absent' | 'running';
}) {
    if (probe.kind === 'ok') {
        return (
            <span
                className="daemon daemon-running"
                title={`port ${probe.report.port}${
                    probe.report.version ? ` · v${probe.report.version}` : ''
                }`}
            >
                running · port {probe.report.port}
            </span>
        );
    }
    if (probe.kind === 'error') {
        return (
            <span className="daemon daemon-absent" title={probe.message}>
                unreachable
            </span>
        );
    }
    if (probe.kind === 'probing') {
        return <span className="daemon daemon-unknown">probing…</span>;
    }
    return <span className={`daemon daemon-${fallback}`}>{fallback}</span>;
}

function ManifestView({
    loaded,
    daemonReachable,
}: {
    loaded: LoadedManifest;
    daemonReachable: boolean;
}) {
    const m = loaded.manifest;
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
