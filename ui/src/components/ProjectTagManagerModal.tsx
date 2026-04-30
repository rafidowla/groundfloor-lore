/**
 * ProjectTagManagerModal — manage tags on indexed projects/repos.
 *
 * Surfaces the developer plug-in's repo-tags data as an editable list:
 * one row per project, current tags shown as removable pills, an input
 * for adding new tags. Writes go through PATCH /api/repos/:name/tags
 * which sets the full tag list (not delta). The parent re-fetches via
 * onMutate so the FiltersPanel tag-grouping refreshes immediately.
 *
 * 2026-04-29 — first iteration. Future: archive a project (needs a
 * server endpoint), bulk-tag, drag-and-drop between groups. For now
 * this delivers the core "where do I edit tags" surface so the tag
 * grouping in the filter panel is actionable.
 */

import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { X } from 'lucide-react';
import { authFetch } from '../lib/authFetch';

interface Props {
    apiBase: string;
    /** Projects to manage. Pulled from /api/topology/overview by the
     *  parent so the list stays consistent with the filter panel. */
    allProjects: Array<{ project: string; nodeCount: number }>;
    /** Current tag → projects map. Used to seed the per-project tag
     *  display and to populate the add-tag autocomplete. */
    availableTags: Array<{ tag: string; repos: string[] }>;
    onClose: () => void;
    /** Called after any successful PATCH so the parent re-fetches tags. */
    onMutate: () => void;
}

export default function ProjectTagManagerModal({
    apiBase,
    allProjects,
    availableTags,
    onClose,
    onMutate,
}: Props): ReactElement {
    // Build project → tags from the inverse map for editing.
    const initialMap = useMemo<Map<string, string[]>>(() => {
        const m = new Map<string, string[]>();
        for (const p of allProjects) m.set(p.project, []);
        for (const t of availableTags) {
            for (const repo of t.repos) {
                const list = m.get(repo);
                if (list) list.push(t.tag);
            }
        }
        // Sort tags within each project for stable display.
        for (const [, tags] of m) tags.sort();
        return m;
    }, [allProjects, availableTags]);

    // Optimistic local state — apply changes immediately, revert on error.
    const [projectTags, setProjectTags] = useState<Map<string, string[]>>(initialMap);
    const [busy, setBusy] = useState<Set<string>>(new Set());
    const [error, setError] = useState<string | null>(null);
    const [filter, setFilter] = useState('');

    // Re-seed when the prop data changes (e.g. parent re-fetched after save).
    useEffect(() => { setProjectTags(initialMap); }, [initialMap]);

    // All known tag names for autocomplete suggestions.
    const knownTags = useMemo<string[]>(() => availableTags.map((t) => t.tag).sort(), [availableTags]);

    const filtered = useMemo(() => {
        const q = filter.trim().toLowerCase();
        if (!q) return allProjects;
        return allProjects.filter((p) => p.project.toLowerCase().includes(q));
    }, [allProjects, filter]);

    const patchTags = async (project: string, nextTags: string[]): Promise<void> => {
        setError(null);
        setBusy((s) => { const n = new Set(s); n.add(project); return n; });
        // Optimistic update.
        const prev = projectTags.get(project) ?? [];
        setProjectTags((m) => { const n = new Map(m); n.set(project, [...nextTags].sort()); return n; });
        try {
            const r = await authFetch(`${apiBase}/api/repos/${encodeURIComponent(project)}/tags`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tags: nextTags }),
            });
            if (!r.ok) {
                const e = (await r.json().catch(() => ({}))) as { error?: string };
                throw new Error(e.error ?? `HTTP ${r.status}`);
            }
            const body = (await r.json()) as { name: string; tags: string[] };
            setProjectTags((m) => { const n = new Map(m); n.set(project, [...body.tags].sort()); return n; });
            onMutate();
        } catch (err) {
            // Revert on error.
            setProjectTags((m) => { const n = new Map(m); n.set(project, prev); return n; });
            setError(`Failed to update tags for ${project}: ${(err as Error).message}`);
        } finally {
            setBusy((s) => { const n = new Set(s); n.delete(project); return n; });
        }
    };

    const removeTag = (project: string, tag: string) => {
        const cur = projectTags.get(project) ?? [];
        void patchTags(project, cur.filter((t) => t !== tag));
    };

    const addTag = (project: string, tag: string) => {
        const trimmed = tag.trim();
        if (!trimmed) return;
        const cur = projectTags.get(project) ?? [];
        if (cur.includes(trimmed)) return;
        void patchTags(project, [...cur, trimmed]);
    };

    return (
        <div
            style={{
                position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                zIndex: 1000,
            }}
            onClick={onClose}
        >
            <div
                style={{
                    background: 'var(--color-surface, #1a1a1a)',
                    color: 'var(--color-text, #e5e5e5)',
                    borderRadius: 8,
                    width: 'min(820px, 92vw)',
                    maxHeight: '88vh',
                    overflow: 'hidden',
                    display: 'flex',
                    flexDirection: 'column',
                    boxShadow: '0 12px 48px rgba(0,0,0,0.4)',
                }}
                onClick={(e) => e.stopPropagation()}
            >
                <header style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 18px', borderBottom: '1px solid var(--color-border)' }}>
                    <h2 style={{ margin: 0, fontSize: '1.15rem', flex: 1 }}>Manage projects &amp; tags</h2>
                    <button onClick={onClose} className="icon-button" title="Close">
                        <X size={18} />
                    </button>
                </header>

                <div style={{ padding: '10px 18px 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <p style={{ fontSize: '0.85rem', color: 'var(--color-text-muted)', margin: 0, lineHeight: 1.5 }}>
                        Tags group projects in the filter panel, the chord view, and recall scope. Add or remove tags inline; changes save immediately.
                    </p>
                    {error ? (
                        <div style={{ background: 'rgba(239,68,68,0.12)', color: '#f87171', padding: '6px 10px', borderRadius: 4, fontSize: '0.8rem' }}>
                            {error}
                        </div>
                    ) : null}
                    <input
                        placeholder={`Filter ${allProjects.length} project${allProjects.length === 1 ? '' : 's'}…`}
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                        style={inputStyle}
                    />
                </div>

                <div style={{ flex: 1, overflow: 'auto', padding: '10px 18px 18px' }}>
                    {filtered.length === 0 ? (
                        <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--color-text-muted)' }}>
                            No projects match "{filter}".
                        </div>
                    ) : (
                        filtered.map((p) => (
                            <ProjectRow
                                key={p.project}
                                project={p.project}
                                nodeCount={p.nodeCount}
                                tags={projectTags.get(p.project) ?? []}
                                knownTags={knownTags}
                                isBusy={busy.has(p.project)}
                                onRemove={(t) => removeTag(p.project, t)}
                                onAdd={(t) => addTag(p.project, t)}
                            />
                        ))
                    )}
                </div>
            </div>
        </div>
    );
}

function ProjectRow({
    project,
    nodeCount,
    tags,
    knownTags,
    isBusy,
    onRemove,
    onAdd,
}: {
    project: string;
    nodeCount: number;
    tags: string[];
    knownTags: string[];
    isBusy: boolean;
    onRemove: (tag: string) => void;
    onAdd: (tag: string) => void;
}): ReactElement {
    const [draft, setDraft] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);

    const suggestions = useMemo(() => {
        const q = draft.trim().toLowerCase();
        if (!q) return [];
        return knownTags.filter((t) => t.toLowerCase().includes(q) && !tags.includes(t)).slice(0, 6);
    }, [draft, knownTags, tags]);

    const submit = (value: string) => {
        onAdd(value);
        setDraft('');
        inputRef.current?.focus();
    };

    return (
        <div
            style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '10px 12px',
                borderBottom: '1px solid var(--color-border-subtle, var(--color-border))',
                opacity: isBusy ? 0.6 : 1,
                pointerEvents: isBusy ? 'none' : 'auto',
            }}
        >
            <div style={{ flex: '0 0 200px', minWidth: 0 }}>
                <div style={{ fontSize: '0.9rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{project}</div>
                <div style={{ fontSize: '0.7rem', color: 'var(--color-text-muted)' }}>{nodeCount} node{nodeCount === 1 ? '' : 's'}</div>
            </div>

            <div style={{ flex: 1, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
                {tags.map((t) => (
                    <span
                        key={t}
                        style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 4,
                            background: 'var(--color-border)',
                            color: 'var(--color-text)',
                            fontSize: '0.75rem',
                            padding: '2px 4px 2px 8px',
                            borderRadius: 4,
                        }}
                    >
                        {t}
                        <button
                            onClick={() => onRemove(t)}
                            title={`Remove ${t}`}
                            style={{
                                background: 'transparent',
                                border: 'none',
                                color: 'var(--color-text-muted)',
                                cursor: 'pointer',
                                padding: 2,
                                display: 'inline-flex',
                                alignItems: 'center',
                            }}
                        >
                            <X size={12} />
                        </button>
                    </span>
                ))}

                <div style={{ position: 'relative', flex: '0 0 auto' }}>
                    <input
                        ref={inputRef}
                        list={`suggest-${project}`}
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                                e.preventDefault();
                                if (draft.trim()) submit(draft);
                            }
                            if (e.key === 'Escape') setDraft('');
                        }}
                        placeholder="+ tag"
                        style={{
                            ...inputStyle,
                            width: 110,
                            padding: '4px 8px',
                            fontSize: '0.78rem',
                        }}
                    />
                    <datalist id={`suggest-${project}`}>
                        {suggestions.map((s) => <option key={s} value={s} />)}
                    </datalist>
                </div>
            </div>
        </div>
    );
}

const inputStyle: React.CSSProperties = {
    background: 'var(--color-surface-alt, var(--color-surface, #1a1a1a))',
    color: 'var(--color-text, #e5e5e5)',
    border: '1px solid var(--color-border)',
    borderRadius: 4,
    padding: '6px 10px',
    fontSize: '0.85rem',
    width: '100%',
    boxSizing: 'border-box',
};
