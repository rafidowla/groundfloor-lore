import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

interface ShellInfo {
    version: string;
    loreDaemonStatus: 'unknown' | 'absent' | 'running';
}

/**
 * Phase 3a — bare scaffold. Confirms the Tauri host process boots, the
 * frontend mounts, and the IPC bridge to the Rust backend is wired.
 *
 * No manifest loading, no inspectors, no daemon management yet — those
 * land in 3b/3c/3d. This screen is intentionally a status placeholder so
 * the build pipeline can be verified before piling on features.
 */
export function App() {
    const [info, setInfo] = useState<ShellInfo | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        invoke<ShellInfo>('shell_info')
            .then(setInfo)
            .catch((e) => setError(String(e)));
    }, []);

    return (
        <main className="shell-root">
            <header>
                <h1>Lore</h1>
                <span className="tag">Phase 3a — scaffold</span>
            </header>

            <section className="status">
                {error ? (
                    <p className="error">IPC error: {error}</p>
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

            <footer>
                <p>
                    Manifest loader, inspectors, and daemon lifecycle land in
                    subsequent slices. See{' '}
                    <code>docs/plugin-manifest-spec.md</code>.
                </p>
            </footer>
        </main>
    );
}
