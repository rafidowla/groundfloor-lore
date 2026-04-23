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
}: {
    title: string;
    buckets: Bucket[];
    active: Set<string>;
    onChange: (next: Set<string>) => void;
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

export default function FiltersPanel({
    topology,
    activeTypes,
    setActiveTypes,
    activeProjects,
    setActiveProjects,
    showInferred,
    setShowInferred,
}: FiltersPanelProps): React.ReactElement {
    const typeBuckets = useMemo(() => buildBuckets((topology?.nodes ?? []).map((n) => n.type)), [topology]);
    const projectBuckets = useMemo(() => buildBuckets((topology?.nodes ?? []).map((n) => n.project)), [topology]);

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
                </div>
            ) : null}
            <FilterGroup title="Types" buckets={typeBuckets} active={activeTypes} onChange={setActiveTypes} />
            <FilterGroup title="Projects" buckets={projectBuckets} active={activeProjects} onChange={setActiveProjects} />
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
