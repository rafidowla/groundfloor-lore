/**
 * A2uiRenderer.tsx — Q1.6 A2UI view-stack renderer.
 *
 * Canvas-slot component that takes a { component, props } descriptor
 * and mounts the matching renderer. The chat layer emits
 * `{{render:table|{...}}` / `{{render:bar_chart|{...}}` tokens; App.tsx
 * parses them, drops the JSON payload into canvasView, and this
 * component dispatches by `component` name.
 *
 * Why the renderers live here:
 *   - No chart dependency in the project (package.json only carries
 *     sigma + mermaid + react-markdown). Pulling in recharts/visx
 *     would be the wrong trade — the analytical projections return
 *     tiny result sets (legal: 2 rows, developer: 5 rows) and the
 *     Q1.5 column metadata already declares kind (dimension/time/
 *     measure), so a 150-LOC hand-rolled bar chart covers the full
 *     acceptance surface without the ~200KB dep hit.
 *   - Renderers are intentionally airplane-safe — no network fetches,
 *     no external CDN fonts, no dynamic imports. Matches Q1.6's
 *     "Airplane-mode: works (renderers are client-side)" criterion.
 *
 * Extensibility: add a new renderer by (1) extending the switch below
 * and (2) adding the name to `KNOWN_RENDERERS` in App.tsx's extractActions.
 * The whitelist boundary keeps hallucinated renderer names from mounting
 * arbitrary components.
 */

import type { JSX } from 'react';

/**
 * AnalyticalProjectionRow — mirrors the server-side type from
 * packages/lore/src/plugins/types.ts. Intentionally duplicated here
 * (not imported from the core package) to keep the UI independent of
 * the server package's build output; small enough that drift is easy
 * to catch visually.
 */
type RowValue = string | number | null;
type Row = Record<string, RowValue>;

interface Column {
    name: string;
    kind: 'dimension' | 'time' | 'measure';
    description?: string;
}

interface TableProps {
    title?: string;
    columns: Column[];
    rows: Row[];
    sourceNodeIds?: string[];
    elapsedMs?: number;
}

interface BarChartProps {
    title?: string;
    columns: Column[];
    rows: Row[];
    sourceNodeIds?: string[];
    elapsedMs?: number;
    /** Optional explicit axis hints. If omitted, the chart picks the
     *  first dimension/time column for x and the first measure for y. */
    xColumn?: string;
    yColumn?: string;
}

/* ─── TableRenderer ───────────────────────────────────────────────── */

/**
 * Plain HTML table. Accessible (scope="col" headers), column-kind
 * badge in the header row so users can see which columns are
 * dimensions vs measures at a glance. Measures right-align; dimensions
 * and time columns left-align — standard data-table convention.
 */
function TableRenderer({ title, columns, rows, elapsedMs, sourceNodeIds }: TableProps): JSX.Element {
    return (
        <div className="a2ui-table" style={{ padding: '1rem 1.5rem', overflow: 'auto', height: '100%' }}>
            {title ? <h3 style={{ marginTop: 0 }}>{title}</h3> : null}
            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '0.9rem' }}>
                <thead>
                    <tr>
                        {columns.map((c) => (
                            <th
                                key={c.name}
                                scope="col"
                                style={{
                                    textAlign: c.kind === 'measure' ? 'right' : 'left',
                                    borderBottom: '2px solid rgba(255,255,255,0.2)',
                                    padding: '0.4rem 0.75rem',
                                    fontWeight: 600,
                                }}
                                title={c.description}
                            >
                                {c.name}
                                <span
                                    style={{
                                        marginLeft: '0.4rem',
                                        fontSize: '0.65rem',
                                        opacity: 0.6,
                                        textTransform: 'uppercase',
                                        letterSpacing: '0.05em',
                                    }}
                                >
                                    {c.kind}
                                </span>
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {rows.length === 0 ? (
                        <tr>
                            <td colSpan={columns.length} style={{ padding: '1rem', textAlign: 'center', opacity: 0.6 }}>
                                No rows.
                            </td>
                        </tr>
                    ) : (
                        rows.map((row, i) => (
                            <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
                                {columns.map((c) => (
                                    <td
                                        key={c.name}
                                        style={{
                                            textAlign: c.kind === 'measure' ? 'right' : 'left',
                                            padding: '0.35rem 0.75rem',
                                            fontVariantNumeric: c.kind === 'measure' ? 'tabular-nums' : 'normal',
                                        }}
                                    >
                                        {row[c.name] ?? '—'}
                                    </td>
                                ))}
                            </tr>
                        ))
                    )}
                </tbody>
            </table>
            <A2uiFooter elapsedMs={elapsedMs} sourceCount={sourceNodeIds?.length ?? 0} />
        </div>
    );
}

/* ─── BarChartRenderer ────────────────────────────────────────────── */

/**
 * Hand-rolled horizontal bar chart. Horizontal (not vertical) so long
 * dimension labels (file paths, jurisdiction names) don't need rotation
 * or truncation. Bar length is proportional to the measure relative to
 * the max in the dataset; measure value is rendered after the bar.
 *
 * Color: single accent (CSS var --accent or fallback blue-500). No
 * categorical color scale — users can't parse more than ~7 colors
 * reliably, and bar charts communicate with length, not hue.
 */
function BarChartRenderer({ title, columns, rows, xColumn, yColumn, elapsedMs, sourceNodeIds }: BarChartProps): JSX.Element {
    // Auto-pick axes when not provided.
    const xCol = xColumn ?? columns.find((c) => c.kind === 'dimension' || c.kind === 'time')?.name ?? columns[0]?.name;
    const yCol = yColumn ?? columns.find((c) => c.kind === 'measure')?.name ?? columns[1]?.name;

    if (!xCol || !yCol) {
        return (
            <div style={{ padding: '1.5rem', opacity: 0.7 }}>
                Bar chart needs at least one dimension/time column and one measure column.
            </div>
        );
    }

    const values = rows.map((r) => Number(r[yCol] ?? 0));
    const maxVal = values.length > 0 ? Math.max(...values, 1) : 1;

    return (
        <div className="a2ui-bar-chart" style={{ padding: '1rem 1.5rem', overflow: 'auto', height: '100%' }}>
            {title ? <h3 style={{ marginTop: 0 }}>{title}</h3> : null}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                {rows.length === 0 ? (
                    <div style={{ opacity: 0.6, padding: '1rem', textAlign: 'center' }}>No data.</div>
                ) : (
                    rows.map((row, i) => {
                        const label = String(row[xCol] ?? '—');
                        const value = Number(row[yCol] ?? 0);
                        const widthPct = (value / maxVal) * 100;
                        return (
                            <div key={i} style={{ display: 'grid', gridTemplateColumns: 'minmax(80px, 200px) 1fr auto', gap: '0.75rem', alignItems: 'center', fontSize: '0.85rem' }}>
                                <div
                                    style={{
                                        textAlign: 'right',
                                        overflow: 'hidden',
                                        textOverflow: 'ellipsis',
                                        whiteSpace: 'nowrap',
                                        opacity: 0.9,
                                    }}
                                    title={label}
                                >
                                    {label}
                                </div>
                                <div style={{ background: 'rgba(255,255,255,0.05)', borderRadius: 3, height: 18, position: 'relative' }}>
                                    <div
                                        style={{
                                            width: `${Math.max(widthPct, 1)}%`,
                                            height: '100%',
                                            background: 'var(--accent, #3b82f6)',
                                            borderRadius: 3,
                                            transition: 'width 200ms ease',
                                        }}
                                    />
                                </div>
                                <div style={{ fontVariantNumeric: 'tabular-nums', opacity: 0.85, minWidth: 50, textAlign: 'right' }}>
                                    {value}
                                </div>
                            </div>
                        );
                    })
                )}
            </div>
            <A2uiFooter elapsedMs={elapsedMs} sourceCount={sourceNodeIds?.length ?? 0} />
        </div>
    );
}

/* ─── Shared footer (source count + timing) ───────────────────────── */

function A2uiFooter({ elapsedMs, sourceCount }: { elapsedMs?: number; sourceCount: number }): JSX.Element | null {
    if (elapsedMs === undefined && sourceCount === 0) return null;
    return (
        <div style={{ marginTop: '1rem', fontSize: '0.7rem', opacity: 0.55, display: 'flex', gap: '1rem' }}>
            {sourceCount > 0 ? <span>{sourceCount} source node{sourceCount === 1 ? '' : 's'}</span> : null}
            {elapsedMs !== undefined ? <span>{elapsedMs} ms</span> : null}
        </div>
    );
}

/* ─── Dispatcher ─────────────────────────────────────────────────── */

export interface A2uiRendererProps {
    component: string;
    props: Record<string, unknown>;
}

/**
 * A2uiRenderer — dispatches to the named renderer. Unknown components
 * render a friendly error; since extractActions' KNOWN_RENDERERS
 * whitelist already filters at parse time, this is defense-in-depth.
 */
export function A2uiRenderer({ component, props }: A2uiRendererProps): JSX.Element {
    // Cast through `any` at the one dispatcher boundary — the per-
    // renderer interfaces are the type gate downstream.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = props as any;
    switch (component) {
        case 'table':
            return <TableRenderer {...(p as TableProps)} />;
        case 'bar_chart':
            return <BarChartRenderer {...(p as BarChartProps)} />;
        default:
            return (
                <div style={{ padding: '1.5rem', opacity: 0.7 }}>
                    Unknown renderer: <code>{component}</code>
                </div>
            );
    }
}
