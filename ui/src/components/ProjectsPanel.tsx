/**
 * ProjectsPanel — Phase 1b Add-Project surface for the Lore UI.
 *
 * Wraps the daemon's /api/repos routes (added 2026-04-27 per
 * decision-add-project-ui-phase1-defaults-2026-04-27).
 *
 * Two add modes:
 *   - "Add Project" — single repo, type or paste a path
 *   - "Add Folder of Projects" — discover all git repos under a parent,
 *     show a checkbox list, batch-index the selected ones
 *
 * Browser limitation: HTML's folder picker (<input type="file" webkitdirectory>)
 * only returns relative names, not absolute paths. So we use a text input
 * with a "use cwd" hint. The Tauri shell wraps this with the native folder
 * picker for a better UX (reuses the same component, replaces input with
 * tauri's dialog.open).
 */

import { useEffect, useState, type ReactElement } from 'react';
import { FolderPlus, FolderTree, RefreshCw, Trash2, AlertCircle, CheckCircle2, Clock } from 'lucide-react';
import { authFetch } from '../lib/authFetch';

interface RepoStats {
    files?: number;
    nodes?: number;
    edges?: number;
    embeddings?: number;
}

interface RepoFreshness {
    status: 'fresh' | 'stale' | 'never';
    reason?: string;
    hoursSinceIndex?: number;
    behindHead?: boolean;
}

interface RepoEntry {
    name: string;
    path: string;
    indexedAt: string;
    lastCommit?: string;
    stats?: RepoStats;
    freshness?: RepoFreshness;
    tags?: string[];
}

interface ReposListResponse {
    count: number;
    repos: RepoEntry[];
}

interface DiscoveredRepo {
    name: string;
    path: string;
    alreadyIndexed: boolean;
}

interface DiscoverResponse {
    count: number;
    found: DiscoveredRepo[];
}

interface ProjectsPanelProps {
    apiBase: string;
    onClose?: () => void;
}

type AddMode = 'idle' | 'single' | 'discover' | 'batch-confirm' | 'busy';

export default function ProjectsPanel({ apiBase, onClose }: ProjectsPanelProps): ReactElement {
    const [repos, setRepos] = useState<RepoEntry[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [mode, setMode] = useState<AddMode>('idle');

    // Single-add state
    const [singlePath, setSinglePath] = useState('');
    const [installHook, setInstallHook] = useState(true);

    // Folder-discover state
    const [parentPath, setParentPath] = useState('');
    const [discovered, setDiscovered] = useState<DiscoveredRepo[]>([]);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [busyMessage, setBusyMessage] = useState<string>('');

    const refresh = async (): Promise<void> => {
        try {
            const r = await authFetch(`${apiBase}/api/repos`).then((r) => r.json() as Promise<ReposListResponse>);
            setRepos(r.repos);
            setError(null);
        } catch (e) {
            setError((e as Error).message);
        }
    };

    useEffect(() => { void refresh(); }, [apiBase]);

    const handleAddSingle = async (): Promise<void> => {
        if (!singlePath.trim()) return;
        setMode('busy');
        setBusyMessage(`Indexing ${singlePath}…`);
        try {
            const resp = await authFetch(`${apiBase}/api/repos`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: singlePath.trim(), installHook }),
            });
            if (!resp.ok) {
                const errText = await resp.text();
                throw new Error(errText || `HTTP ${resp.status}`);
            }
            setSinglePath('');
            setMode('idle');
            await refresh();
        } catch (e) {
            setError((e as Error).message);
            setMode('single');
        } finally {
            setBusyMessage('');
        }
    };

    const handleDiscover = async (): Promise<void> => {
        if (!parentPath.trim()) return;
        setMode('busy');
        setBusyMessage(`Scanning ${parentPath}…`);
        try {
            const resp = await authFetch(`${apiBase}/api/repos/discover`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ parentPath: parentPath.trim(), depth: 'shallow' }),
            });
            const data = (await resp.json()) as DiscoverResponse;
            setDiscovered(data.found);
            // Pre-check the not-yet-indexed ones; user can uncheck.
            setSelected(new Set(data.found.filter((r) => !r.alreadyIndexed).map((r) => r.path)));
            setMode('batch-confirm');
        } catch (e) {
            setError((e as Error).message);
            setMode('discover');
        } finally {
            setBusyMessage('');
        }
    };

    const handleBatchAdd = async (): Promise<void> => {
        const toAdd = discovered.filter((r) => selected.has(r.path)).map((r) => r.path);
        if (toAdd.length === 0) {
            setMode('idle');
            return;
        }
        setMode('busy');
        setBusyMessage(`Indexing ${toAdd.length} repo(s)…`);
        try {
            const resp = await authFetch(`${apiBase}/api/repos/batch`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ paths: toAdd, installHook }),
            });
            if (!resp.ok) throw new Error(await resp.text() || `HTTP ${resp.status}`);
            const summary = (await resp.json()) as { ok: number; failed: number; total: number };
            setBusyMessage(`Done. ${summary.ok}/${summary.total} added; ${summary.failed} failed.`);
            setTimeout(() => { setBusyMessage(''); setMode('idle'); }, 2500);
            await refresh();
        } catch (e) {
            setError((e as Error).message);
            setMode('batch-confirm');
            setBusyMessage('');
        }
    };

    const handleEditTags = async (name: string, currentTags: string[]): Promise<void> => {
        const input = prompt(
            `Tags for "${name}" (comma-separated; e.g. "groundfloor,backend"):`,
            currentTags.join(', '),
        );
        if (input === null) return; // user cancelled
        const tags = input.split(',').map((t) => t.trim()).filter((t) => t.length > 0);
        try {
            const resp = await authFetch(`${apiBase}/api/repos/${encodeURIComponent(name)}/tags`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tags }),
            });
            if (!resp.ok) throw new Error(await resp.text() || `HTTP ${resp.status}`);
            await refresh();
        } catch (e) {
            setError((e as Error).message);
        }
    };

    const handleRemove = async (name: string): Promise<void> => {
        if (!confirm(`Remove "${name}" from Lore? Code symbols will be cleared. This is reversible — you can re-add later.`)) return;
        try {
            const resp = await authFetch(`${apiBase}/api/repos/${encodeURIComponent(name)}`, { method: 'DELETE' });
            if (!resp.ok) throw new Error(await resp.text() || `HTTP ${resp.status}`);
            await refresh();
        } catch (e) {
            setError((e as Error).message);
        }
    };

    const toggleSelected = (path: string): void => {
        const next = new Set(selected);
        if (next.has(path)) next.delete(path); else next.add(path);
        setSelected(next);
    };

    const renderFreshnessBadge = (f?: RepoFreshness): ReactElement => {
        if (!f) return <span className="repo-freshness unknown">?</span>;
        if (f.status === 'fresh') return <span className="repo-freshness fresh"><CheckCircle2 size={12} /> fresh</span>;
        if (f.status === 'stale') return <span className="repo-freshness stale"><AlertCircle size={12} /> stale{f.reason ? ` — ${f.reason}` : ''}</span>;
        return <span className="repo-freshness never"><Clock size={12} /> never indexed</span>;
    };

    // Convert to centered opaque modal (was a translucent right-side
    // overlay that didn't fit the layout grid and competed visually
    // with the canvas). Same shape as SupersessionCandidatesModal:
    // backdrop click closes, the inner card is opaque + has its own
    // border + scroll.
    return (
        <div
            style={{
                position: 'fixed',
                inset: 0,
                background: 'rgba(0, 0, 0, 0.55)',
                zIndex: 100,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '2rem',
            }}
            onClick={onClose}
        >
            <div
                className="projects-panel"
                style={{
                    background: 'var(--color-bg, #fff)',
                    color: 'var(--color-text, #0F172A)',
                    width: '100%',
                    maxWidth: 760,
                    maxHeight: '88vh',
                    borderRadius: 10,
                    boxShadow: '0 20px 60px rgba(0,0,0,0.4)',
                    border: '1px solid var(--color-border)',
                    display: 'flex',
                    flexDirection: 'column',
                    overflow: 'hidden',
                    padding: 0,
                    position: 'relative',
                    inset: 'auto',
                }}
                onClick={(e) => e.stopPropagation()}
            >
                <div
                    className="projects-panel-header"
                    style={{
                        padding: '1rem 1.25rem',
                        borderBottom: '1px solid var(--color-border)',
                        margin: 0,
                    }}
                >
                    <h2>Indexed Projects</h2>
                    {onClose && <button className="icon-button" onClick={onClose} aria-label="Close">×</button>}
                </div>

                <div style={{ padding: '1rem 1.25rem', overflow: 'auto', flex: 1 }}>

            {error && (
                <div className="projects-error">
                    <AlertCircle size={14} /> {error}
                    <button className="icon-button" onClick={() => setError(null)}>×</button>
                </div>
            )}

            {mode === 'busy' && (
                <div className="projects-busy">
                    <RefreshCw size={14} className="spin" /> {busyMessage}
                </div>
            )}

            {/* Add buttons */}
            {mode === 'idle' && (
                <div className="projects-add-buttons">
                    <button className="add-button" onClick={() => setMode('single')}>
                        <FolderPlus size={16} /> Add Project
                    </button>
                    <button className="add-button" onClick={() => setMode('discover')}>
                        <FolderTree size={16} /> Add Folder of Projects
                    </button>
                </div>
            )}

            {/* Single-add form */}
            {mode === 'single' && (
                <div className="projects-form">
                    <label>Path to git repository:</label>
                    <input
                        type="text"
                        autoFocus
                        value={singlePath}
                        onChange={(e) => setSinglePath(e.target.value)}
                        placeholder="/Users/me/code/my-project"
                        onKeyDown={(e) => { if (e.key === 'Enter') void handleAddSingle(); }}
                    />
                    <label className="checkbox-row">
                        <input type="checkbox" checked={installHook} onChange={(e) => setInstallHook(e.target.checked)} />
                        Install post-commit auto-refresh hook (recommended)
                    </label>
                    <div className="projects-form-buttons">
                        <button onClick={() => setMode('idle')}>Cancel</button>
                        <button className="primary" onClick={handleAddSingle} disabled={!singlePath.trim()}>Index it</button>
                    </div>
                </div>
            )}

            {/* Folder-discover form */}
            {mode === 'discover' && (
                <div className="projects-form">
                    <label>Parent folder containing git repositories:</label>
                    <input
                        type="text"
                        autoFocus
                        value={parentPath}
                        onChange={(e) => setParentPath(e.target.value)}
                        placeholder="/Users/me/code/v3"
                        onKeyDown={(e) => { if (e.key === 'Enter') void handleDiscover(); }}
                    />
                    <div className="projects-form-buttons">
                        <button onClick={() => setMode('idle')}>Cancel</button>
                        <button className="primary" onClick={handleDiscover} disabled={!parentPath.trim()}>Scan</button>
                    </div>
                </div>
            )}

            {/* Batch confirm */}
            {mode === 'batch-confirm' && (
                <div className="projects-form">
                    <label>Discovered {discovered.length} repos. Pick which to index ({selected.size} selected):</label>
                    <div className="discovered-list">
                        {discovered.map((r) => (
                            <label key={r.path} className="discovered-row">
                                <input
                                    type="checkbox"
                                    checked={selected.has(r.path)}
                                    onChange={() => toggleSelected(r.path)}
                                    disabled={r.alreadyIndexed}
                                />
                                <span className="discovered-name">{r.name}</span>
                                {r.alreadyIndexed && <span className="discovered-tag">already indexed</span>}
                                <span className="discovered-path">{r.path}</span>
                            </label>
                        ))}
                    </div>
                    <label className="checkbox-row">
                        <input type="checkbox" checked={installHook} onChange={(e) => setInstallHook(e.target.checked)} />
                        Install post-commit hooks in each
                    </label>
                    <div className="projects-form-buttons">
                        <button onClick={() => { setMode('idle'); setDiscovered([]); setSelected(new Set()); }}>Cancel</button>
                        <button className="primary" onClick={handleBatchAdd} disabled={selected.size === 0}>
                            Index {selected.size} repo(s)
                        </button>
                    </div>
                </div>
            )}

            {/* Repos list */}
            <div className="projects-list">
                <div className="projects-list-header">
                    <h3>Indexed ({repos?.length ?? 0})</h3>
                    <button className="icon-button" onClick={refresh} aria-label="Refresh"><RefreshCw size={14} /></button>
                </div>
                {repos === null && <div className="projects-empty">Loading…</div>}
                {repos && repos.length === 0 && (
                    <div className="projects-empty">
                        No projects indexed yet. Click "Add Project" or "Add Folder of Projects" above.
                    </div>
                )}
                {repos && repos.map((r) => (
                    <div key={r.name} className="repo-row">
                        <div className="repo-row-main">
                            <div className="repo-name">{r.name}</div>
                            <div className="repo-path">{r.path}</div>
                            <div className="repo-meta">
                                {renderFreshnessBadge(r.freshness)}
                                {r.stats && (
                                    <span className="repo-stats">
                                        {r.stats.nodes ?? 0} symbols · {r.stats.edges ?? 0} relations
                                    </span>
                                )}
                            </div>
                            <div className="repo-tags">
                                {(r.tags ?? []).map((t) => (
                                    <span key={t} className="repo-tag-chip">{t}</span>
                                ))}
                                <button
                                    className="repo-tag-edit"
                                    onClick={() => handleEditTags(r.name, r.tags ?? [])}
                                    title="Edit tags"
                                >
                                    {(r.tags?.length ?? 0) > 0 ? 'edit tags' : '+ add tags'}
                                </button>
                            </div>
                        </div>
                        <button className="icon-button danger" onClick={() => handleRemove(r.name)} title="Remove from Lore">
                            <Trash2 size={14} />
                        </button>
                    </div>
                ))}
                </div>
            </div>
            </div>
        </div>
    );
}
