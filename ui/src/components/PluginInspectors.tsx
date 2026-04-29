/**
 * PluginInspectors.tsx — Render `lore.inspectors[]` panels declared in a
 * plugin's manifest.
 *
 * The plugin manifest spec defines four renderer kinds: table, graph,
 * timeline, document. This module ships the **table renderer** (the
 * highest-value one — every Tier 1 example plugin uses it).
 * graph/timeline/document remain TBD; the kind switch is a stub that
 * shows a "renderer not yet implemented" message for those.
 *
 * The shell discovers manifests via `/api/plugins/manifests` (added
 * alongside this component). For each manifest with `lore.inspectors[]`,
 * a tab appears in the InspectorTabs strip; clicking activates that
 * inspector's renderer.
 *
 * Data flows in via core's existing list_nodes / type-filter route.
 * Tables paginate client-side (cap 1000 rows in the API call; that's
 * already the engine's default).
 */

import { useCallback, useEffect, useState } from 'react';
import { authFetch } from '../lib/authFetch';

// ── Types echoing the manifest spec inline (same convention as PluginWizard) ──

interface InspectorColumn {
    field: string;
    label: string;
    width?: number;
    flex?: number;
    type?: 'string' | 'number' | 'date' | 'boolean' | 'tags';
}

interface InspectorSort {
    field: string;
    order: 'asc' | 'desc';
}

interface TableInspector {
    id: string;
    label: string;
    icon?: string;
    kind: 'table';
    entity: string;
    columns: InspectorColumn[];
    sort?: InspectorSort;
}

interface OtherInspector {
    id: string;
    label: string;
    icon?: string;
    kind: 'graph' | 'timeline' | 'document';
}

type Inspector = TableInspector | OtherInspector;

interface PluginManifestSummary {
    name: string;
    description: string;
    inspectors: Inspector[];
}

interface PluginInspectorsProps {
    onClose: () => void;
}

interface NodeRow {
    id: string;
    type: string;
    label: string;
    tags: string;
    project: string;
    updatedAt: string;
    [k: string]: unknown;
}

export default function PluginInspectors({ onClose }: PluginInspectorsProps) {
    const [manifests, setManifests] = useState<PluginManifestSummary[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [activeKey, setActiveKey] = useState<string | null>(null); // "<plugin>:<inspectorId>"

    useEffect(() => {
        void (async () => {
            try {
                const r = await authFetch('/api/plugins/manifests');
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                const data = await r.json() as { manifests: PluginManifestSummary[] };
                const withInspectors = data.manifests.filter((m) => (m.inspectors ?? []).length > 0);
                setManifests(withInspectors);
                if (withInspectors[0]?.inspectors[0]) {
                    setActiveKey(`${withInspectors[0].name}:${withInspectors[0].inspectors[0].id}`);
                }
            } catch (err) {
                setError((err as Error).message);
            }
        })();
    }, []);

    if (error) {
        return <Wrapper onClose={onClose}><div style={errorBox}>Failed to load plugin manifests: {error}</div></Wrapper>;
    }
    if (!manifests) {
        return <Wrapper onClose={onClose}><div style={muted}>Loading…</div></Wrapper>;
    }
    if (manifests.length === 0) {
        return (
            <Wrapper onClose={onClose}>
                <div style={muted}>
                    No plugins declare inspector panels yet. A plugin can declare them via
                    <code> lore.inspectors[]</code> in its manifest.
                </div>
            </Wrapper>
        );
    }

    return (
        <Wrapper onClose={onClose}>
            {/* Tab strip — one tab per (plugin × inspector) */}
            <div style={tabStrip}>
                {manifests.flatMap((m) => m.inspectors.map((insp) => {
                    const key = `${m.name}:${insp.id}`;
                    const active = key === activeKey;
                    return (
                        <button
                            key={key}
                            onClick={() => setActiveKey(key)}
                            style={active ? tabActive : tab}
                            title={`${m.name} — ${insp.kind}`}
                        >
                            {insp.label}
                        </button>
                    );
                }))}
            </div>

            {/* Active inspector body */}
            {(() => {
                const [pluginName, inspId] = (activeKey ?? '').split(':');
                const m = manifests.find((mm) => mm.name === pluginName);
                const insp = m?.inspectors.find((i) => i.id === inspId);
                if (!insp) return null;
                return <InspectorBody pluginName={pluginName!} inspector={insp} />;
            })()}
        </Wrapper>
    );
}

// ────────────────────────────────────────────────────────────────────────
// Renderer dispatch
// ────────────────────────────────────────────────────────────────────────

function InspectorBody({ pluginName, inspector }: { pluginName: string; inspector: Inspector }) {
    if (inspector.kind === 'table') {
        return <TableRenderer pluginName={pluginName} inspector={inspector} />;
    }
    return (
        <div style={{ padding: 24, color: 'var(--color-text-muted, #888)' }}>
            <div style={{ marginBottom: 8 }}>
                The <code>{inspector.kind}</code> renderer is declared in the manifest spec but not yet implemented in the shell.
            </div>
            <div style={{ fontSize: 12 }}>
                Plugin <code>{pluginName}</code> · inspector <code>{inspector.id}</code> ({inspector.label}).
            </div>
        </div>
    );
}

// ────────────────────────────────────────────────────────────────────────
// Table renderer
// ────────────────────────────────────────────────────────────────────────

function TableRenderer({ pluginName, inspector }: { pluginName: string; inspector: TableInspector }) {
    const [rows, setRows] = useState<NodeRow[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    const fetchRows = useCallback(async () => {
        try {
            const r = await authFetch(`/api/nodes?type=${encodeURIComponent(inspector.entity)}&limit=1000`);
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const data = await r.json() as { nodes: NodeRow[] };
            setRows(data.nodes ?? []);
        } catch (err) {
            setError((err as Error).message);
        }
    }, [inspector.entity]);

    useEffect(() => { void fetchRows(); }, [fetchRows]);

    if (error) {
        return <div style={errorBox}>Failed to load {inspector.entity}: {error}</div>;
    }
    if (!rows) {
        return <div style={muted}>Loading {inspector.entity}…</div>;
    }

    // Apply manifest-declared sort (client-side; cheap on ≤1000 rows).
    const sortedRows = [...rows];
    if (inspector.sort) {
        const f = inspector.sort.field;
        const dir = inspector.sort.order === 'asc' ? 1 : -1;
        sortedRows.sort((a, b) => {
            const av = String((a as Record<string, unknown>)[f] ?? '');
            const bv = String((b as Record<string, unknown>)[f] ?? '');
            return av.localeCompare(bv) * dir;
        });
    }

    return (
        <div style={{ padding: 12 }}>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted, #888)', marginBottom: 8 }}>
                {sortedRows.length} {inspector.entity} record{sortedRows.length === 1 ? '' : 's'}
                {' · '}plugin <code>{pluginName}</code>
                <button onClick={fetchRows} style={{ ...miniBtn, marginLeft: 12 }} title="Refresh">↻</button>
            </div>
            <div style={{ overflow: 'auto', maxHeight: '70vh', border: '1px solid var(--color-border, #444)', borderRadius: 4 }}>
                <table style={tableStyle}>
                    <thead>
                        <tr>
                            {inspector.columns.map((c) => (
                                <th
                                    key={c.field}
                                    style={{
                                        ...th,
                                        width: c.width ? `${c.width}px` : undefined,
                                    }}
                                >{c.label}</th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {sortedRows.map((row) => (
                            <tr key={row.id}>
                                {inspector.columns.map((c) => (
                                    <td key={c.field} style={td}>
                                        {formatCell((row as Record<string, unknown>)[c.field], c.type)}
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

function formatCell(value: unknown, type?: InspectorColumn['type']): string {
    if (value === null || value === undefined) return '';
    if (type === 'date' && typeof value === 'string') {
        try { return new Date(value).toLocaleString(); } catch { return value; }
    }
    if (type === 'tags' && typeof value === 'string') {
        return value.split(',').map((s) => s.trim()).filter(Boolean).join('  ·  ');
    }
    return String(value);
}

// ────────────────────────────────────────────────────────────────────────
// Modal wrapper + styles
// ────────────────────────────────────────────────────────────────────────

function Wrapper({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
    return (
        <div style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 1000,
        }}>
            <div style={{
                background: 'var(--color-surface, #1a1a1a)',
                color: 'var(--color-text, #e5e5e5)',
                borderRadius: 8,
                width: 'min(1100px, 95vw)',
                maxHeight: '92vh',
                overflow: 'auto',
                padding: 20,
                boxShadow: '0 12px 48px rgba(0,0,0,0.4)',
            }}>
                <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                    <h2 style={{ margin: 0, fontSize: '1.2rem' }}>Plugin inspectors</h2>
                    <button onClick={onClose} style={miniBtn}>Close</button>
                </header>
                {children}
            </div>
        </div>
    );
}

const tabStrip: React.CSSProperties = { display: 'flex', gap: 4, borderBottom: '1px solid var(--color-border, #444)', marginBottom: 12 };
const tab: React.CSSProperties = { padding: '6px 14px', border: 'none', background: 'transparent', color: 'var(--color-text-muted, #888)', cursor: 'pointer', fontSize: 13, borderBottom: '2px solid transparent' };
const tabActive: React.CSSProperties = { ...tab, color: 'var(--color-text, #e5e5e5)', borderBottomColor: 'var(--color-accent, #4a90e2)', fontWeight: 600 };
const tableStyle: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: 12 };
const th: React.CSSProperties = { textAlign: 'left', padding: '8px', position: 'sticky', top: 0, background: 'var(--color-surface-alt, #2a2a2a)', borderBottom: '1px solid var(--color-border, #444)', fontWeight: 600 };
const td: React.CSSProperties = { padding: '6px 8px', borderBottom: '1px solid var(--color-border-subtle, #333)' };
const miniBtn: React.CSSProperties = { padding: '4px 10px', background: 'transparent', color: 'var(--color-text, #e5e5e5)', border: '1px solid var(--color-border, #444)', borderRadius: 3, cursor: 'pointer', fontSize: 12 };
const muted: React.CSSProperties = { color: 'var(--color-text-muted, #888)', fontSize: 13, padding: 24 };
const errorBox: React.CSSProperties = { padding: 12, background: 'rgba(248,113,113,0.15)', border: '1px solid #f87171', borderRadius: 4, color: '#fca5a5', fontSize: 13 };
