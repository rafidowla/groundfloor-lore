import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

import {
    type LoadedManifest,
    type LoadManifestError,
    type InspectorPanel,
    loadManifest,
    pickManifestFile,
    describeError,
    parseLoadError,
} from './manifest';

interface ShellInfo {
    version: string;
    loreDaemonStatus: 'unknown' | 'absent' | 'running';
}

/**
 * Phase 3b — adds the manifest loader. The shell can now open a
 * `plugin.json` from disk, validate it via the Rust IPC command, and
 * display its contributions in a structured viewer.
 *
 * Inspector renderers (TableInspector, GraphInspector, etc.) are
 * displayed here as *summaries* only — actually executing a query
 * against the running Lore daemon and rendering rows lands in 3c.
 */
export function App() {
    const [info, setInfo] = useState<ShellInfo | null>(null);
    const [infoError, setInfoError] = useState<string | null>(null);

    const [loaded, setLoaded] = useState<LoadedManifest | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        invoke<ShellInfo>('shell_info')
            .then(setInfo)
            .catch((e) => setInfoError(String(e)));
    }, []);

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
                <span className="tag">Phase 3b — manifest loader</span>
            </header>

            <section className="status">
                {infoError ? (
                    <p className="error">IPC error: {infoError}</p>
                ) : info ? (
                    <dl>
                        <dt>Shell version</dt>
                        <dd>{info.version}</dd>
                        <dt>Lore daemon</dt>
                        <dd className={`daemon daemon-${info.loreDaemonStatus}`}>
                            {info.loreDaemonStatus}
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
                {loaded && <ManifestView loaded={loaded} />}
            </section>

            <footer>
                <p>
                    Inspector queries against the Lore daemon land in 3c.
                    Daemon discovery + connect (sibling launchd service)
                    lands in 3d. See <code>docs/plugin-manifest-spec.md</code>.
                </p>
            </footer>
        </main>
    );
}

function ManifestView({ loaded }: { loaded: LoadedManifest }) {
    const m = loaded.manifest;
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
                    {m.lore.inspectors && m.lore.inspectors.length > 0 && (
                        <>
                            <h4>Inspectors</h4>
                            <ul className="inspectors">
                                {m.lore.inspectors.map((i) => (
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
