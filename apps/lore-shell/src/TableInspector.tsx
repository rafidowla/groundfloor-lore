/**
 * TableInspector — Phase 3c.
 *
 * Renders rows from the running Lore daemon's `/api/topology` endpoint
 * filtered to a single entity type. The inspector descriptor (from the
 * loaded plugin manifest) declares the entity and the columns; the
 * shell owns the rendering.
 *
 * Limitations of the current data path (intentional, narrow slice):
 *   - The topology endpoint returns nodes with `id, label, type, project`
 *     core fields. Plugin-specific fields (e.g. an Email's `sender`,
 *     `subject`) only appear if the plugin's `contributeTopology` hook
 *     emits them. Missing fields render as `—`.
 *   - Sort + filter come from the manifest but are applied client-side
 *     here. A richer query API (server-side filter/sort/pagination)
 *     lands later — when entity counts grow past the topology cap.
 *   - We always fetch the full topology slice and filter client-side.
 *     For workspaces with many entity types this is wasteful; not a
 *     concern at the scale Phase 3 targets.
 */
import { useEffect, useMemo, useState } from 'react';

import {
    daemonTopology,
    formatNodeField,
    parseDaemonError,
    describeDaemonError,
    type TopologyNode,
} from './loreClient';
import type { TableInspector as TableInspectorConfig } from './manifest';

interface Props {
    config: TableInspectorConfig;
}

export function TableInspector({ config }: Props) {
    const [nodes, setNodes] = useState<TopologyNode[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [refreshTick, setRefreshTick] = useState(0);

    useEffect(() => {
        let cancelled = false;
        async function load() {
            setLoading(true);
            setError(null);
            try {
                const resp = await daemonTopology(5000);
                if (cancelled) return;
                setNodes(resp.nodes);
            } catch (e) {
                if (cancelled) return;
                const parsed = parseDaemonError(e);
                setError(
                    parsed.kind === 'Unknown'
                        ? `Unexpected error: ${parsed.detail.message}`
                        : describeDaemonError(parsed),
                );
                setNodes(null);
            } finally {
                if (!cancelled) setLoading(false);
            }
        }
        load();
        return () => {
            cancelled = true;
        };
    }, [refreshTick]);

    const rows = useMemo(() => {
        if (!nodes) return [] as TopologyNode[];
        // Match by node.type (the LoreNode schema field). Fall back to
        // node.label for plugin-contributed nodes that key on label.
        const filtered = nodes.filter(
            (n) => n.type === config.entity || n.label === config.entity,
        );
        if (config.sort) {
            const { field, order } = config.sort;
            filtered.sort((a, b) => {
                const av = a[field];
                const bv = b[field];
                if (av == null && bv == null) return 0;
                if (av == null) return 1;
                if (bv == null) return -1;
                const cmp = String(av).localeCompare(String(bv));
                return order === 'desc' ? -cmp : cmp;
            });
        }
        return filtered;
    }, [nodes, config.entity, config.sort]);

    return (
        <div className="inspector inspector-table">
            <header className="inspector-header">
                <h3>{config.label}</h3>
                <span className="dim">
                    entity <code>{config.entity}</code>
                </span>
                <button
                    type="button"
                    className="refresh"
                    onClick={() => setRefreshTick((t) => t + 1)}
                    disabled={loading}
                    title="Re-fetch from daemon"
                >
                    {loading ? 'Loading…' : 'Refresh'}
                </button>
            </header>

            {error && <p className="error">{error}</p>}

            {!error && nodes && rows.length === 0 && (
                <p className="empty">
                    No entities of type <code>{config.entity}</code> in the
                    daemon's topology slice. (Plugin may not have
                    contributed topology, or no rows exist yet.)
                </p>
            )}

            {!error && rows.length > 0 && (
                <table>
                    <thead>
                        <tr>
                            {config.columns.map((c) => (
                                <th
                                    key={c.field}
                                    style={
                                        c.width
                                            ? { width: `${c.width}px` }
                                            : c.flex
                                              ? { flex: c.flex }
                                              : undefined
                                    }
                                >
                                    {c.label}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((node, idx) => (
                            <tr key={(node.id as string | undefined) ?? idx}>
                                {config.columns.map((c) => (
                                    <td key={c.field} title={c.field}>
                                        {formatNodeField(node, c.field, c.type)}
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}

            {!error && nodes && (
                <footer className="inspector-footer">
                    <span className="dim">
                        {rows.length} row{rows.length === 1 ? '' : 's'} ·{' '}
                        {nodes.length} total nodes in topology slice
                    </span>
                </footer>
            )}
        </div>
    );
}
