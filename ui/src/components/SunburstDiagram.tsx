import { useEffect, useRef, useState, type ReactElement } from 'react';
import { arc as d3arc } from 'd3-shape';
import { authFetch } from '../lib/authFetch';

interface OverviewBlob {
    project: string;
    nodeCount: number;
    types?: Array<{ type: string; count: number }>;
}
interface AggregateEdge {
    fromProject: string;
    toProject: string;
    count: number;
}
interface OverviewPayload {
    blobs: OverviewBlob[];
    aggregateEdges?: AggregateEdge[];
    totalNodes?: number;
}

interface SunburstDiagramProps {
    apiBase: string;
    /** Click handler. `type` is set when the user clicks an outer (type)
     *  slice, so the parent can drill into that project AND narrow the
     *  network view to that node type. */
    onProjectClick?: (project: string, type?: string) => void;
    /** Optional whitelist of project names to render. */
    projectFilter?: string[] | null;
}

const PROJECT_PALETTE = [
    '#3182CE', '#38A169', '#805AD5', '#DD6B20',
    '#319795', '#B7791F', '#E53E3E', '#4A5568',
    '#9F7AEA', '#48BB78', '#ED8936', '#0BC5EA',
    '#F56565', '#A0AEC0',
];

const TYPE_COLORS: Record<string, string> = {
    architecture: '#3182CE',
    convention: '#38A169',
    decision: '#805AD5',
    bug_pattern: '#E53E3E',
    troubleshooting: '#DD6B20',
    schema: '#319795',
    note: '#718096',
    file_ref: '#B7791F',
    code_symbol: '#A0AEC0',
    code_file: '#B7791F',
    default: '#4A5568',
};

const colorFor = (type: string): string => TYPE_COLORS[type] ?? TYPE_COLORS.default;

export default function SunburstDiagram({
    apiBase,
    onProjectClick,
    projectFilter,
}: SunburstDiagramProps): ReactElement {
    const containerRef = useRef<HTMLDivElement>(null);
    const [payload, setPayload] = useState<OverviewPayload | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [size, setSize] = useState<{ w: number; h: number }>({ w: 800, h: 800 });
    const [hover, setHover] = useState<{ project: string; type?: string; count: number } | null>(null);

    useEffect(() => {
        authFetch(`${apiBase}/api/topology/overview?groupBy=project`)
            .then((r) => r.json() as Promise<OverviewPayload>)
            .then(setPayload)
            .catch((e) => setError((e as Error).message));
    }, [apiBase]);

    useEffect(() => {
        if (!containerRef.current) return;
        const el = containerRef.current;
        const ro = new ResizeObserver(() => {
            const rect = el.getBoundingClientRect();
            const dim = Math.min(rect.width, rect.height);
            setSize({ w: dim, h: dim });
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    if (error) {
        return (
            <div style={{ padding: 20, color: 'var(--color-text-muted)' }}>
                Failed to load sunburst data: {error}
            </div>
        );
    }
    if (!payload) {
        return (
            <div style={{ padding: 20, color: 'var(--color-text-muted)' }}>
                Loading sunburst…
            </div>
        );
    }

    const allowSet = projectFilter && projectFilter.length > 0 ? new Set(projectFilter) : null;
    const blobs = (allowSet ? payload.blobs.filter((b) => allowSet.has(b.project)) : payload.blobs)
        .filter((b) => b.nodeCount > 0);

    if (blobs.length === 0) {
        return (
            <div style={{ padding: 20, color: 'var(--color-text-muted)' }}>
                No projects match the selected tag.
            </div>
        );
    }

    const total = blobs.reduce((s, b) => s + b.nodeCount, 0);
    const dim = Math.min(size.w, size.h);
    const cx = size.w / 2;
    const cy = size.h / 2;
    const innerR = dim * 0.16;
    const midR = dim * 0.30;
    const outerR = dim * 0.46;

    // Build arc segments. Inner ring = projects. Outer ring = types per project.
    let cursor = -Math.PI / 2; // start at 12 o'clock
    const innerArcs: Array<{
        project: string;
        nodeCount: number;
        startAngle: number;
        endAngle: number;
        color: string;
    }> = [];
    const outerArcs: Array<{
        project: string;
        type: string;
        count: number;
        startAngle: number;
        endAngle: number;
        color: string;
    }> = [];

    blobs.forEach((b, i) => {
        const span = (b.nodeCount / total) * 2 * Math.PI;
        const projectColor = PROJECT_PALETTE[i % PROJECT_PALETTE.length];
        innerArcs.push({
            project: b.project,
            nodeCount: b.nodeCount,
            startAngle: cursor,
            endAngle: cursor + span,
            color: projectColor,
        });
        // Outer ring: types within this project, summing to the same span.
        const types = b.types ?? [];
        const localTotal = types.reduce((s, t) => s + t.count, 0) || 1;
        let typeCursor = cursor;
        for (const t of types) {
            const tspan = (t.count / localTotal) * span;
            outerArcs.push({
                project: b.project,
                type: t.type,
                count: t.count,
                startAngle: typeCursor,
                endAngle: typeCursor + tspan,
                color: colorFor(t.type),
            });
            typeCursor += tspan;
        }
        cursor += span;
    });

    const innerArcGen = d3arc<{ startAngle: number; endAngle: number }>()
        .innerRadius(innerR)
        .outerRadius(midR)
        .padAngle(0.012)
        .padRadius(midR);
    const outerArcGen = d3arc<{ startAngle: number; endAngle: number }>()
        .innerRadius(midR + 4)
        .outerRadius(outerR)
        .padAngle(0.005)
        .padRadius(outerR);

    return (
        <div
            ref={containerRef}
            style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
            <svg width={size.w} height={size.h} style={{ overflow: 'visible' }}>
                <g transform={`translate(${cx}, ${cy})`}>
                    {/* Cross-project ribbons in the center hole. Drawn
                        when hovering an inner project arc (and NOT a
                        type — type hover keeps the center clean for
                        outer-ring focus). Each ribbon is a quadratic
                        bezier from the hovered project's arc midpoint
                        to a connected partner's midpoint, swept through
                        origin. Stroke width scales with edge count. */}
                    {hover && !hover.type && (() => {
                        const edges = (payload.aggregateEdges ?? []).filter(
                            (e) =>
                                (e.fromProject === hover.project || e.toProject === hover.project) &&
                                e.fromProject !== e.toProject,
                        );
                        if (edges.length === 0) return null;
                        // Aggregate per-partner so a project pair only
                        // draws ONE ribbon even if both directions exist.
                        const perPartner = new Map<string, number>();
                        for (const e of edges) {
                            const partner = e.fromProject === hover.project ? e.toProject : e.fromProject;
                            perPartner.set(partner, (perPartner.get(partner) ?? 0) + e.count);
                        }
                        const maxCount = Math.max(...perPartner.values(), 1);
                        const focal = innerArcs.find((a) => a.project === hover.project);
                        if (!focal) return null;
                        const focalMid = (focal.startAngle + focal.endAngle) / 2 - Math.PI / 2;
                        const fx = Math.cos(focalMid) * innerR;
                        const fy = Math.sin(focalMid) * innerR;
                        return Array.from(perPartner.entries()).map(([partner, count]) => {
                            const partnerArc = innerArcs.find((a) => a.project === partner);
                            if (!partnerArc) return null;
                            const pmid = (partnerArc.startAngle + partnerArc.endAngle) / 2 - Math.PI / 2;
                            const px = Math.cos(pmid) * innerR;
                            const py = Math.sin(pmid) * innerR;
                            const w = 1 + (count / maxCount) * 7;
                            return (
                                <path
                                    key={`rib-${partner}`}
                                    d={`M ${fx} ${fy} Q 0 0 ${px} ${py}`}
                                    fill="none"
                                    stroke={focal.color}
                                    strokeWidth={w}
                                    strokeOpacity={0.55}
                                    strokeLinecap="round"
                                    style={{ pointerEvents: 'none' }}
                                />
                            );
                        });
                    })()}
                    {/* Outer ring: types */}
                    {outerArcs.map((a, i) => {
                        const d = outerArcGen(a) ?? '';
                        const isHovered = hover?.project === a.project && hover?.type === a.type;
                        const dimmed = !!(hover && !isHovered && hover.project !== a.project);
                        return (
                            <path
                                key={`outer-${i}`}
                                d={d}
                                fill={a.color}
                                opacity={dimmed ? 0.2 : 0.85}
                                stroke="#0b0d12"
                                strokeWidth={0.5}
                                onMouseEnter={() => setHover({ project: a.project, type: a.type, count: a.count })}
                                onMouseLeave={() => setHover(null)}
                                onClick={() => onProjectClick?.(a.project, a.type)}
                                style={{ cursor: 'pointer', transition: 'opacity 120ms' }}
                            />
                        );
                    })}
                    {/* Inner ring: projects */}
                    {innerArcs.map((a, i) => {
                        const d = innerArcGen(a) ?? '';
                        const isHovered = hover?.project === a.project;
                        const dimmed = !!(hover && !isHovered);
                        // Label position: midpoint angle
                        const mid = (a.startAngle + a.endAngle) / 2;
                        const lr = (innerR + midR) / 2;
                        const lx = Math.cos(mid - Math.PI / 2) * lr;
                        const ly = Math.sin(mid - Math.PI / 2) * lr;
                        const span = a.endAngle - a.startAngle;
                        const showLabel = span > 0.18; // ~10° threshold
                        return (
                            <g key={`inner-${i}`}>
                                <path
                                    d={d}
                                    fill={a.color}
                                    opacity={dimmed ? 0.25 : 1}
                                    stroke="#0b0d12"
                                    strokeWidth={1}
                                    onMouseEnter={() => setHover({ project: a.project, count: a.nodeCount })}
                                    onMouseLeave={() => setHover(null)}
                                    onClick={() => onProjectClick?.(a.project)}
                                    style={{ cursor: 'pointer', transition: 'opacity 120ms' }}
                                />
                                {showLabel && (
                                    <text
                                        x={lx}
                                        y={ly}
                                        textAnchor="middle"
                                        dominantBaseline="middle"
                                        fontSize={11}
                                        fontWeight={600}
                                        fill="#fff"
                                        style={{ pointerEvents: 'none' }}
                                    >
                                        {a.project.length > 14 ? a.project.slice(0, 12) + '…' : a.project}
                                    </text>
                                )}
                            </g>
                        );
                    })}
                    {/* Center label */}
                    <text
                        textAnchor="middle"
                        dominantBaseline="middle"
                        fontSize={14}
                        fontWeight={600}
                        fill="var(--color-text)"
                        y={-4}
                    >
                        {blobs.length} projects
                    </text>
                    <text
                        textAnchor="middle"
                        dominantBaseline="middle"
                        fontSize={11}
                        fill="var(--color-text-muted)"
                        y={14}
                    >
                        {total} nodes
                    </text>
                </g>
                {/* Hover tooltip — top-center, richer multi-line. Shows
                    project · count · share of workspace, and (when
                    hovering an outer/type slice) type · count · share
                    of project. Click hint reminds the user the slice
                    is interactive. */}
                {hover && (() => {
                    const projectBlob = blobs.find((b) => b.project === hover.project);
                    const projectTotal = projectBlob?.nodeCount ?? 0;
                    const workspacePct = total > 0 ? Math.round((projectTotal / total) * 100) : 0;
                    const typePctOfProject = hover.type && projectTotal > 0
                        ? Math.round((hover.count / projectTotal) * 100)
                        : null;
                    return (
                        <g>
                            <text
                                x={size.w / 2}
                                y={16}
                                textAnchor="middle"
                                fontSize={13}
                                fontWeight={600}
                                fill="var(--color-text)"
                                style={{ pointerEvents: 'none' }}
                            >
                                {hover.project} · {projectTotal} nodes · {workspacePct}% of workspace
                            </text>
                            {hover.type && (
                                <text
                                    x={size.w / 2}
                                    y={34}
                                    textAnchor="middle"
                                    fontSize={11}
                                    fill="var(--color-text-muted)"
                                    style={{ pointerEvents: 'none' }}
                                >
                                    {hover.type} · {hover.count} nodes · {typePctOfProject}% of {hover.project}
                                </text>
                            )}
                            <text
                                x={size.w / 2}
                                y={hover.type ? 50 : 32}
                                textAnchor="middle"
                                fontSize={10}
                                fill="var(--color-accent, #14B8A6)"
                                style={{ pointerEvents: 'none' }}
                            >
                                {hover.type
                                    ? 'click to drill into this type only'
                                    : 'click to drill into this project'}
                            </text>
                        </g>
                    );
                })()}
            </svg>
        </div>
    );
}
