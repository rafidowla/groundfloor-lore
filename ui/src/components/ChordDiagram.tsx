/**
 * ChordDiagram — project-to-project relationship intensity view.
 *
 * Reads /api/topology/overview, builds a symmetric N×N matrix of
 * cross-project edge counts, and renders a d3 chord diagram. Each
 * project is an outer arc; ribbons between arcs encode edge count.
 *
 * Inspired by the Observable example linked by Rafi 2026-04-27:
 *   https://observablehq.com/@d3/directed-chord-diagram/2
 *
 * Why this view exists: at 12k+ symbol scale the network view is
 * a muddy blob. The chord view answers a different question —
 * "which projects are most coupled to each other" — directly and
 * legibly with 11 arcs instead of 11k dots.
 */

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { chord, ribbon } from 'd3-chord';
import { arc } from 'd3-shape';
import { scaleOrdinal } from 'd3-scale';
import { authFetch } from '../lib/authFetch';

interface OverviewBlob {
    project: string;
    nodeCount: number;
}
interface OverviewAggregateEdge {
    fromProject: string;
    toProject: string;
    count: number;
}
interface OverviewPayload {
    blobs: OverviewBlob[];
    aggregateEdges: OverviewAggregateEdge[];
    totalNodes?: number;
}

interface ChordDiagramProps {
    apiBase: string;
    onProjectClick?: (project: string) => void;
    /** Optional whitelist of project names to render. Other projects
     *  are filtered out before the matrix is built. Used by the tag
     *  dropdown so the chord narrows to a tagged subset. */
    projectFilter?: string[] | null;
}

// Quiet, distinguishable palette — 14 colors (covers any realistic
// project count). Each project gets a stable color via ordinal scale.
const PROJECT_PALETTE = [
    '#3182CE', '#38A169', '#805AD5', '#DD6B20',
    '#319795', '#B7791F', '#E53E3E', '#4A5568',
    '#9F7AEA', '#48BB78', '#ED8936', '#0BC5EA',
    '#F56565', '#A0AEC0',
];

export default function ChordDiagram({ apiBase, onProjectClick, projectFilter }: ChordDiagramProps): ReactElement {
    const containerRef = useRef<HTMLDivElement>(null);
    const [payload, setPayload] = useState<OverviewPayload | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [size, setSize] = useState<{ w: number; h: number }>({ w: 800, h: 800 });
    const [hover, setHover] = useState<{ project: string; partner?: string; count?: number } | null>(null);

    // Fetch the overview payload once.
    useEffect(() => {
        authFetch(`${apiBase}/api/topology/overview?groupBy=project`)
            .then((r) => r.json() as Promise<OverviewPayload>)
            .then(setPayload)
            .catch((e) => setError((e as Error).message));
    }, [apiBase]);

    // Resize observer for responsive sizing.
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
                Failed to load chord data: {error}
            </div>
        );
    }
    if (!payload) {
        return (
            <div style={{ padding: 20, color: 'var(--color-text-muted)' }}>
                Loading chord diagram…
            </div>
        );
    }

    // Tag filter: narrow blobs to a project whitelist if provided.
    // Aggregate edges where either endpoint is filtered out are dropped.
    const allowSet = projectFilter && projectFilter.length > 0 ? new Set(projectFilter) : null;
    const filteredBlobs = allowSet
        ? payload.blobs.filter((b) => allowSet.has(b.project))
        : payload.blobs;
    const filteredEdges = allowSet
        ? payload.aggregateEdges.filter((e) => allowSet.has(e.fromProject) && allowSet.has(e.toProject))
        : payload.aggregateEdges;
    if (allowSet && filteredBlobs.length === 0) {
        return (
            <div style={{ padding: 20, color: 'var(--color-text-muted)' }}>
                No projects match the selected tag.
            </div>
        );
    }

    // Build the symmetric matrix.
    const projects = filteredBlobs.map((b) => b.project);
    const projectIdx = new Map<string, number>(projects.map((p, i) => [p, i]));
    const N = projects.length;
    const matrix: number[][] = Array.from({ length: N }, () => new Array<number>(N).fill(0));
    for (const e of filteredEdges) {
        const i = projectIdx.get(e.fromProject);
        const j = projectIdx.get(e.toProject);
        if (i === undefined || j === undefined) continue;
        matrix[i][j] += e.count;
        if (i !== j) matrix[j][i] += e.count; // symmetric
    }

    // Color scale per project.
    const color = scaleOrdinal<string, string>()
        .domain(projects)
        .range(PROJECT_PALETTE);

    // d3 chord layout.
    const chordLayout = chord()
        .padAngle(0.04)
        .sortSubgroups((a, b) => b - a);
    const chords = chordLayout(matrix);

    // Geometry.
    const innerRadius = Math.min(size.w, size.h) * 0.5 - 130;
    const outerRadius = innerRadius + 18;
    const arcGen = arc().innerRadius(innerRadius).outerRadius(outerRadius);
    const ribbonGen = ribbon().radius(innerRadius);

    return (
        <div
            ref={containerRef}
            style={{
                width: '100%',
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                position: 'relative',
                background: 'var(--color-bg, #0b0d12)',
            }}
        >
            <svg
                width={size.w}
                height={size.h}
                viewBox={`${-size.w / 2} ${-size.h / 2} ${size.w} ${size.h}`}
                style={{ display: 'block' }}
            >
                {/* Ribbons (drawn first so arcs sit on top) */}
                <g style={{ fillOpacity: 0.7 }}>
                    {chords.map((c, i) => {
                        const sourceProject = projects[c.source.index];
                        const targetProject = projects[c.target.index];
                        const isHovered =
                            hover &&
                            (
                                (hover.project === sourceProject && (!hover.partner || hover.partner === targetProject))
                                || (hover.project === targetProject && (!hover.partner || hover.partner === sourceProject))
                            );
                        const dimmed = hover && !isHovered;
                        // Ribbon coords contract requires source/target with
                        // startAngle/endAngle/radius. The layout already
                        // gives us this shape; cast to satisfy d3-ribbon's
                        // positional accessor types.
                        const d = ribbonGen(c as unknown as Parameters<typeof ribbonGen>[0]) as unknown as string | null;
                        return (
                            <path
                                key={i}
                                d={d ?? ''}
                                fill={color(sourceProject)}
                                stroke={color(sourceProject)}
                                strokeWidth={0.5}
                                opacity={dimmed ? 0.05 : isHovered ? 0.95 : 0.45}
                                onMouseEnter={() => setHover({ project: sourceProject, partner: targetProject, count: c.source.value })}
                                onMouseLeave={() => setHover(null)}
                                style={{ transition: 'opacity 120ms', cursor: 'pointer' }}
                            />
                        );
                    })}
                </g>

                {/* Outer arcs (one per project) + labels */}
                <g>
                    {chords.groups.map((g, i) => {
                        const project = projects[g.index];
                        const nodeCount = filteredBlobs.find((b) => b.project === project)?.nodeCount ?? 0;
                        const isHovered = hover?.project === project;
                        const dimmed = hover && !isHovered;
                        const d = arcGen({
                            innerRadius,
                            outerRadius,
                            startAngle: g.startAngle,
                            endAngle: g.endAngle,
                        }) as string;
                        // Label position at arc midpoint.
                        const angle = (g.startAngle + g.endAngle) / 2;
                        const labelRadius = outerRadius + 12;
                        const labelX = Math.sin(angle) * labelRadius;
                        const labelY = -Math.cos(angle) * labelRadius;
                        const rotate = (angle * 180 / Math.PI) - 90;
                        const flipped = angle > Math.PI;
                        return (
                            <g key={i}>
                                <path
                                    d={d}
                                    fill={color(project)}
                                    opacity={dimmed ? 0.2 : 1}
                                    stroke="#0b0d12"
                                    strokeWidth={1}
                                    onMouseEnter={() => setHover({ project })}
                                    onMouseLeave={() => setHover(null)}
                                    onClick={() => onProjectClick?.(project)}
                                    style={{ cursor: 'pointer', transition: 'opacity 120ms' }}
                                />
                                <text
                                    transform={`translate(${labelX}, ${labelY}) rotate(${flipped ? rotate + 180 : rotate})`}
                                    textAnchor={flipped ? 'end' : 'start'}
                                    fontSize={11}
                                    fontFamily="Inter, system-ui, sans-serif"
                                    fontWeight={500}
                                    fill="var(--color-text)"
                                    style={{ pointerEvents: 'none' }}
                                >
                                    {project} · {nodeCount}
                                </text>
                            </g>
                        );
                    })}
                </g>
            </svg>

            {/* Hover info panel */}
            {hover && (
                <div
                    style={{
                        position: 'absolute',
                        top: 16,
                        left: 16,
                        padding: '8px 12px',
                        background: 'var(--glass-bg)',
                        backdropFilter: 'blur(8px)',
                        border: '1px solid var(--color-border)',
                        borderRadius: 6,
                        fontSize: '0.8rem',
                        color: 'var(--color-text)',
                        maxWidth: 360,
                    }}
                >
                    <div style={{ fontWeight: 600, marginBottom: 2 }}>{hover.project}</div>
                    {hover.partner && (
                        <div style={{ color: 'var(--color-text-muted)' }}>
                            ↔ {hover.partner} · {hover.count} edge{hover.count === 1 ? '' : 's'}
                        </div>
                    )}
                </div>
            )}

            {/* Caption */}
            <div
                style={{
                    position: 'absolute',
                    bottom: 16,
                    left: 16,
                    padding: '6px 10px',
                    background: 'var(--glass-bg)',
                    backdropFilter: 'blur(8px)',
                    border: '1px solid var(--color-border)',
                    borderRadius: 6,
                    fontSize: '0.72rem',
                    color: 'var(--color-text-muted)',
                }}
            >
                Chord — {projects.length} projects · ribbon thickness = cross-project edge count · click an arc to drill in
            </div>
        </div>
    );
}
