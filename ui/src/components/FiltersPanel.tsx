/**
 * FiltersPanel — Right panel for the Lore V2 dashboard.
 *
 * Renders two grouped filter sections (Types / Projects) populated from
 * the current `/api/topology` payload.
 *
 * UX rules (V2 implementation plan, Phase 3):
 *   - First 10 entries per category, "Show all (N)" expander above that.
 *   - Per-category search box appears when count > 15.
 *   - Hover reveals node count (count shown inline).
 *   - Select all / Select none per category.
 *   - Unchecking a box updates the parent state; App.tsx passes the
 *     active Set<string> to SigmaCanvas, which applies it via nodeReducer.
 */

import React, { useMemo, useState } from 'react';

export interface TopologyLike {
    nodes: Array<{ id: string; type: string; project?: string; label?: string }>;
    /** Phase 3: /api/topology truncation signal — true when the graph
     *  exceeds the requested limit. Optional to keep the shape backward
     *  compatible with consumers that only care about `nodes`. */
    truncated?: boolean;
    /** Phase 3: effective limit applied by the server (after clamping). */
    limit?: number;
    /** Phase 3: authoritative core-node count from getStats(); lets the
     *  banner show "N of TOTAL". */
    totalCoreNodes?: number;
}

interface FiltersPanelProps {
    topology: TopologyLike | null;
    activeTypes: Set<string>;
    setActiveTypes: (next: Set<string>) => void;
    activeProjects: Set<string>;
    setActiveProjects: (next: Set<string>) => void;
    /** C1 — confidence filter toggle. */
    showInferred?: boolean;
    setShowInferred?: (next: boolean) => void;
    /** Soft-supersession toggle. Default off → superseded nodes hidden
     *  from the network view. On → superseded nodes render dimmed with
     *  a virtual edge to their replacement. */
    showSuperseded?: boolean;
    setShowSuperseded?: (next: boolean) => void;
    /** 2026-04-27 multi-project drill: workspace-wide project list with
     *  per-project node counts. Sourced from /api/topology/overview so
     *  it stays stable when the network view drills into one project.
     *  When provided, it replaces the topology-derived project buckets. */
    allProjects?: Array<{ project: string; nodeCount: number }> | null;
    /** 2026-04-29 — tag-to-projects mapping from /api/repos/tags. When
     *  present and non-empty, enables a "Group by tag" toggle on the
     *  Projects section that renders the list under collapsible tag
     *  headers instead of the flat sorted list. */
    availableTags?: Array<{ tag: string; repos: string[] }>;
    /** 2026-04-29 — opens the project/tag manager modal. Optional;
     *  when omitted, the gear icon next to the Projects header
     *  isn't rendered. */
    onManageProjects?: () => void;
}

interface Bucket {
    key: string;
    count: number;
}

function buildBuckets(values: Array<string | undefined>): Bucket[] {
    const counts = new Map<string, number>();
    for (const v of values) {
        if (!v) continue;
        counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    return Array.from(counts.entries())
        .map(([key, count]) => ({ key, count }))
        .sort((a, b) => b.count - a.count);
}

function FilterGroup({
    title,
    buckets,
    active,
    onChange,
    onToggleGrouping,
    isGrouped,
    onManage,
}: {
    title: string;
    buckets: Bucket[];
    active: Set<string>;
    onChange: (next: Set<string>) => void;
    /** Optional handler that flips between flat and tag-grouped layout.
     *  Only Projects supplies this; Types stays flat. */
    onToggleGrouping?: () => void;
    /** Whether the parent is currently in grouped mode. Used to label the
     *  toggle button correctly. */
    isGrouped?: boolean;
    /** Optional click handler for a gear icon next to the section header
     *  that opens a management modal. Currently only Projects uses it. */
    onManage?: () => void;
}): React.ReactElement | null {
    const [expanded, setExpanded] = useState(false);
    const [search, setSearch] = useState('');

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (!q) return buckets;
        return buckets.filter((b) => b.key.toLowerCase().includes(q));
    }, [buckets, search]);

    const visible = expanded ? filtered : filtered.slice(0, 10);
    const hasMore = filtered.length > 10 && !expanded;

    if (buckets.length === 0) return null;

    const toggle = (key: string): void => {
        const next = new Set(active);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        onChange(next);
    };

    const selectAll = (): void => onChange(new Set(buckets.map((b) => b.key)));
    const selectNone = (): void => onChange(new Set());

    return (
        <div className="filter-group">
            <div className="filter-group-header">
                <label>{title}</label>
                <div className="filter-actions">
                    {onManage ? (
                        <a
                            onClick={onManage}
                            title="Manage projects & tags"
                            style={{ marginRight: '0.4rem' }}
                        >
                            ⚙
                        </a>
                    ) : null}
                    {onToggleGrouping ? (
                        <a
                            onClick={onToggleGrouping}
                            title={isGrouped ? 'Switch to flat list' : 'Group by tag'}
                            style={{ marginRight: '0.4rem' }}
                        >
                            {isGrouped ? 'Flat' : 'By tag'}
                        </a>
                    ) : null}
                    <a onClick={selectAll}>Select all</a>
                    <a onClick={selectNone}>None</a>
                </div>
            </div>

            {buckets.length > 15 ? (
                <input
                    className="filter-search"
                    placeholder={`Search ${title.toLowerCase()}…`}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                />
            ) : null}

            {visible.map((b) => (
                <label key={b.key} className="filter-row" title={`${b.count} node(s)`}>
                    <input
                        type="checkbox"
                        checked={active.has(b.key)}
                        onChange={() => toggle(b.key)}
                    />
                    <span>{b.key}</span>
                    <span className="count">{b.count}</span>
                </label>
            ))}

            {hasMore ? (
                <button className="filter-show-more" onClick={() => setExpanded(true)}>
                    Show all ({filtered.length})
                </button>
            ) : null}
        </div>
    );
}

// Tag-grouped variant of the Projects section. Renders the project
// list under collapsible tag headers. Each project appears once under
// its first (alphabetical) tag; secondary tags surface as small chips
// after the project name so the multi-tag case stays visible.
function TagGroupedProjects({
    tagGroups,
    projectTagMap,
    active,
    onChange,
    onToggleGrouping,
    onManage,
}: {
    tagGroups: Array<{ tag: string; projects: Bucket[]; isUntagged?: boolean }>;
    projectTagMap: Map<string, string[]>;
    active: Set<string>;
    onChange: (next: Set<string>) => void;
    onToggleGrouping: () => void;
    onManage?: () => void;
}): React.ReactElement | null {
    const [collapsed, setCollapsed] = useState<Set<string>>(() => {
        try {
            const stored = localStorage.getItem('lore.collapsedTagGroups');
            if (stored) return new Set(JSON.parse(stored) as string[]);
        } catch { /* ignore */ }
        return new Set();
    });

    const persistCollapsed = (next: Set<string>): void => {
        setCollapsed(next);
        try { localStorage.setItem('lore.collapsedTagGroups', JSON.stringify(Array.from(next))); } catch { /* ignore */ }
    };

    if (tagGroups.length === 0) return null;

    const toggle = (key: string): void => {
        const next = new Set(active);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        onChange(next);
    };

    const allKeys = tagGroups.flatMap((g) => g.projects.map((p) => p.key));
    const selectAll = (): void => onChange(new Set(allKeys));
    const selectNone = (): void => onChange(new Set());

    const toggleGroup = (tag: string): void => {
        const next = new Set(collapsed);
        if (next.has(tag)) next.delete(tag);
        else next.add(tag);
        persistCollapsed(next);
    };

    const selectGroup = (projects: Bucket[]): void => {
        const next = new Set(active);
        for (const p of projects) next.add(p.key);
        onChange(next);
    };

    const deselectGroup = (projects: Bucket[]): void => {
        const next = new Set(active);
        for (const p of projects) next.delete(p.key);
        onChange(next);
    };

    return (
        <div className="filter-group">
            <div className="filter-group-header">
                <label>Projects</label>
                <div className="filter-actions">
                    {onManage ? (
                        <a onClick={onManage} title="Manage projects & tags" style={{ marginRight: '0.4rem' }}>
                            ⚙
                        </a>
                    ) : null}
                    <a onClick={onToggleGrouping} title="Switch to flat list" style={{ marginRight: '0.4rem' }}>
                        Flat
                    </a>
                    <a onClick={selectAll}>Select all</a>
                    <a onClick={selectNone}>None</a>
                </div>
            </div>

            {tagGroups.map((g) => {
                const isCollapsed = collapsed.has(g.tag);
                const groupActive = g.projects.filter((p) => active.has(p.key)).length;
                return (
                    <div key={g.tag} style={{ marginTop: 4 }}>
                        <div
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 6,
                                padding: '4px 0',
                                cursor: 'pointer',
                                fontSize: '0.75rem',
                                fontWeight: 600,
                                color: g.isUntagged ? 'var(--color-text-muted)' : 'var(--color-text-secondary)',
                                textTransform: 'uppercase',
                                letterSpacing: '0.04em',
                            }}
                            onClick={() => toggleGroup(g.tag)}
                            title={isCollapsed ? 'Expand' : 'Collapse'}
                        >
                            <span style={{ width: 10, display: 'inline-block', textAlign: 'center' }}>
                                {isCollapsed ? '▸' : '▾'}
                            </span>
                            <span style={{ flex: 1 }}>{g.tag}</span>
                            <span style={{ fontSize: '0.7rem', fontWeight: 400, opacity: 0.7 }}>
                                {groupActive}/{g.projects.length}
                            </span>
                            <a
                                style={{ fontSize: '0.7rem', fontWeight: 400 }}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    if (groupActive === g.projects.length) deselectGroup(g.projects);
                                    else selectGroup(g.projects);
                                }}
                            >
                                {groupActive === g.projects.length ? 'None' : 'All'}
                            </a>
                        </div>
                        {!isCollapsed ? g.projects.map((p) => {
                            const tags = projectTagMap.get(p.key) ?? [];
                            const secondary = tags.filter((t) => t !== g.tag);
                            return (
                                <label key={p.key} className="filter-row" title={`${p.count} node(s)`}>
                                    <input
                                        type="checkbox"
                                        checked={active.has(p.key)}
                                        onChange={() => toggle(p.key)}
                                    />
                                    <span style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
                                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.key}</span>
                                        {secondary.map((t) => (
                                            <span
                                                key={t}
                                                title={`also tagged: ${t}`}
                                                style={{
                                                    fontSize: '0.6rem',
                                                    background: 'var(--color-border)',
                                                    color: 'var(--color-text-muted)',
                                                    padding: '0 4px',
                                                    borderRadius: 3,
                                                }}
                                            >
                                                {t}
                                            </span>
                                        ))}
                                    </span>
                                    <span className="count">{p.count}</span>
                                </label>
                            );
                        }) : null}
                    </div>
                );
            })}
        </div>
    );
}

export default function FiltersPanel({
    topology,
    activeTypes,
    setActiveTypes,
    activeProjects,
    setActiveProjects,
    showInferred,
    setShowInferred,
    showSuperseded,
    setShowSuperseded,
    allProjects,
    availableTags,
    onManageProjects,
}: FiltersPanelProps): React.ReactElement {
    const typeBuckets = useMemo(() => buildBuckets((topology?.nodes ?? []).map((n) => n.type)), [topology]);
    // Project buckets source: workspace-wide overview if provided
    // (so drill-in still shows every project), else the current
    // topology slice. Falls back gracefully when overview hasn't
    // loaded yet.
    const projectBuckets = useMemo(() => {
        if (allProjects && allProjects.length > 0) {
            return allProjects.map((p) => ({ key: p.project, count: p.nodeCount }));
        }
        return buildBuckets((topology?.nodes ?? []).map((n) => n.project));
    }, [allProjects, topology]);

    // Tag grouping state. Default ON when tag data is available — at 11+
    // projects the flat list becomes hard to scan. Persisted so the user's
    // choice sticks across refreshes.
    const hasTags = Boolean(availableTags && availableTags.length > 0);
    const [groupByTag, setGroupByTag] = useState<boolean>(() => {
        try {
            const stored = localStorage.getItem('lore.projectGroupByTag');
            if (stored === '0') return false;
            if (stored === '1') return true;
        } catch { /* ignore */ }
        return true;
    });
    const setGroupByTagPersisted = (next: boolean): void => {
        setGroupByTag(next);
        try { localStorage.setItem('lore.projectGroupByTag', next ? '1' : '0'); } catch { /* ignore */ }
    };

    // Build tag → buckets map. Each project appears once under its first
    // tag (alphabetical) so the UI doesn't duplicate checkboxes; secondary
    // tags surface as small labels next to the project name. Projects with
    // no tag fall into an "Untagged" group at the end.
    const tagGroups = useMemo<Array<{ tag: string; projects: Bucket[]; isUntagged?: boolean }>>(() => {
        if (!hasTags) return [];
        const projectToTags = new Map<string, string[]>();
        for (const t of availableTags ?? []) {
            for (const repo of t.repos) {
                const existing = projectToTags.get(repo) ?? [];
                existing.push(t.tag);
                projectToTags.set(repo, existing);
            }
        }
        // Sort each project's tags alphabetically so "first tag" is stable.
        for (const [, tags] of projectToTags) tags.sort();

        const tagToProjects = new Map<string, Bucket[]>();
        const untagged: Bucket[] = [];
        for (const bucket of projectBuckets) {
            const tags = projectToTags.get(bucket.key);
            if (!tags || tags.length === 0) {
                untagged.push(bucket);
                continue;
            }
            const primary = tags[0];
            const list = tagToProjects.get(primary) ?? [];
            list.push(bucket);
            tagToProjects.set(primary, list);
        }
        const groups = Array.from(tagToProjects.entries())
            .map(([tag, projects]) => ({
                tag,
                projects: projects.sort((a, b) => b.count - a.count),
            }))
            .sort((a, b) => a.tag.localeCompare(b.tag));
        if (untagged.length > 0) {
            groups.push({ tag: 'Untagged', projects: untagged.sort((a, b) => b.count - a.count), isUntagged: true });
        }
        return groups;
    }, [hasTags, availableTags, projectBuckets]);

    // Project → tags reverse map for the secondary-tag chip rendering.
    const projectTagMap = useMemo<Map<string, string[]>>(() => {
        const map = new Map<string, string[]>();
        for (const t of availableTags ?? []) {
            for (const repo of t.repos) {
                const existing = map.get(repo) ?? [];
                existing.push(t.tag);
                map.set(repo, existing);
            }
        }
        for (const [, tags] of map) tags.sort();
        return map;
    }, [availableTags]);

    return (
        <aside className="filters-panel">
            <header className="filters-panel-header">Filters</header>
            {/* C1 — confidence toggle. Sits at the top because it's a graph-
                wide filter (affects every edge), unlike the per-bucket
                type/project checklists below. */}
            {typeof showInferred === 'boolean' && setShowInferred ? (
                <div className="filter-group">
                    <div className="filter-group-header">
                        <span>Confidence</span>
                    </div>
                    <label className="filter-checkbox" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <input
                            type="checkbox"
                            checked={showInferred}
                            onChange={(e) => setShowInferred(e.target.checked)}
                        />
                        <span>Show inferred edges</span>
                    </label>
                    <p className="help-text" style={{ fontSize: '0.7rem', margin: '0.3rem 0 0' }}>
                        Off: only user-asserted relationships are shown.
                    </p>
                    {typeof showSuperseded === 'boolean' && setShowSuperseded ? (
                        <>
                            <label className="filter-checkbox" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.6rem' }}>
                                <input
                                    type="checkbox"
                                    checked={showSuperseded}
                                    onChange={(e) => setShowSuperseded(e.target.checked)}
                                />
                                <span>Show superseded nodes</span>
                            </label>
                            <p className="help-text" style={{ fontSize: '0.7rem', margin: '0.3rem 0 0' }}>
                                On: faded historical decisions appear with an arrow to their replacement.
                            </p>
                        </>
                    ) : null}
                </div>
            ) : null}
            <FilterGroup title="Types" buckets={typeBuckets} active={activeTypes} onChange={setActiveTypes} />
            {hasTags && groupByTag ? (
                <TagGroupedProjects
                    tagGroups={tagGroups}
                    projectTagMap={projectTagMap}
                    active={activeProjects}
                    onChange={setActiveProjects}
                    onToggleGrouping={() => setGroupByTagPersisted(false)}
                    onManage={onManageProjects}
                />
            ) : (
                <FilterGroup
                    title="Projects"
                    buckets={projectBuckets}
                    active={activeProjects}
                    onChange={setActiveProjects}
                    onToggleGrouping={hasTags ? () => setGroupByTagPersisted(true) : undefined}
                    isGrouped={false}
                    onManage={onManageProjects}
                />
            )}
            {!topology || (topology.nodes?.length ?? 0) === 0 ? (
                <div className="filter-group">
                    <p style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', margin: 0 }}>
                        No nodes yet. Ingest a file or add knowledge to populate filters.
                    </p>
                </div>
            ) : null}
        </aside>
    );
}
