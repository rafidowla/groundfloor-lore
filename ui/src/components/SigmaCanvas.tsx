import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { SigmaContainer, useLoadGraph, useRegisterEvents, useSigma } from '@react-sigma/core';
import '@react-sigma/core/lib/style.css';
import Graph from 'graphology';
import type { Attributes } from 'graphology-types';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import { ZoomIn, ZoomOut, RotateCcw, ChevronLeft } from 'lucide-react';
import type { NodeDisplayData } from 'sigma/types';
import type { NodeLabelDrawingFunction, NodeHoverDrawingFunction } from 'sigma/rendering';
import { authFetch } from '../lib/authFetch';

/**
 * Extends Sigma's NodeDisplayData with the two custom attributes we stash
 * on every node in GraphLoader (`tag` = node type, `clusterLabel` =
 * project). Typed once here so drawHover and the reducers can read them
 * without `any`.
 */
type LoreNodeAttrs = NodeDisplayData & {
    tag?: string;
    clusterLabel?: string;
};

/* ─── Data contract from /api/topology ─────────────────────────── */

interface LoreNode {
    id: string;
    type: string;
    label: string;
    project?: string;
    content?: string;
}

interface LoreEdge {
    from: string;
    to: string;
    label: string;
    // C1 — confidence tier + score flow through from the daemon's
    // /api/topology. Plugin-contributed edges (FileContains, CodeRelation,
    // etc.) may not carry these; treat absence as 'extracted' at render.
    confidence?: 'extracted' | 'inferred' | 'ambiguous';
    confidenceScore?: number;
}

/* ─── Color palette per knowledge-node type ────────────────────── */

const NODE_COLORS: Record<string, string> = {
    'architecture': '#3182CE',
    'convention': '#38A169',
    'decision': '#805AD5',
    'bug_pattern': '#E53E3E',
    'troubleshooting': '#DD6B20',
    'schema': '#319795',
    'note': '#718096',
    'file_ref': '#B7791F',
    'default': '#4A5568'
};

/**
 * Minimum node size for orphan / single-edge nodes.
 * Maximum size for the most-connected hub.
 */
const MIN_NODE_SIZE = 4;
const MAX_NODE_SIZE = 28;

/* ─── Q1.9 — Semantic zoom: overview blob sizing ───────────────── */

/**
 * Below this node count the UI renders the full single-globe (today's
 * behavior). At or above, we auto-switch to the project-blob overview
 * unless the caller pins a mode. Lives at 1000 per the Q1.9 plan.
 */
const SEMANTIC_ZOOM_THRESHOLD = 1000;

const OVERVIEW_MIN_BLOB_SIZE = 12;
const OVERVIEW_MAX_BLOB_SIZE = 48;

/* ─── Q1.9 — Overview data contract from /api/topology/overview ── */

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
    totalNodes: number;
    groupBy: 'project';
}

/**
 * View mode exposed to the parent. Kept narrow on purpose — the parent
 * never needs to know per-project blob shape.
 *
 *   'full'      — current single-globe render (below threshold, or
 *                 after a user drilled down from overview)
 *   'overview'  — one blob per project, aggregate edges between blobs
 *   'project:<name>' — drilled into a single project's subgraph
 */
export type TopologyViewMode =
    | { kind: 'full' }
    | { kind: 'overview' }
    | { kind: 'project'; project: string };

/**
 * Only labels for nodes whose screen-space pixel-size exceeds this
 * threshold are rendered.  Sigma.js calls `labelRenderedSizeThreshold`
 * on the *rendered* size each frame — so zooming in naturally reveals
 * more labels, exactly like the Wikipedia cartography demo.
 */
const LABEL_RENDERED_SIZE_THRESHOLD = 12;

/* ─── Custom canvas-level label renderer ───────────────────────── */

/**
 * Draws a label with a semi-transparent background pill, matching the
 * Sigma.js demo style (canvas-utils.ts from the official repo).
 */
const drawLabel: NodeLabelDrawingFunction<LoreNodeAttrs> = (context, data, settings) => {
    if (!data.label) return;

    const size = settings.labelSize;
    const font = settings.labelFont;
    const weight = settings.labelWeight;

    context.font = `${weight} ${size}px ${font}`;
    const textWidth = context.measureText(data.label).width + 8;

    // Semi-transparent pill behind the text
    context.fillStyle = '#ffffffcc';
    context.fillRect(
        data.x + data.size + 1,
        data.y + size / 3 - 15,
        textWidth,
        20,
    );

    context.fillStyle = '#000';
    context.fillText(data.label, data.x + data.size + 3, data.y + size / 3);
}

/**
 * Draws a rich hover card: rounded rectangle with label,
 * type sub-label, and project cluster label.
 */
const drawHover: NodeHoverDrawingFunction<LoreNodeAttrs> = (context, data, settings) => {
    const size = settings.labelSize;
    const font = settings.labelFont;
    const weight = settings.labelWeight;
    const subLabelSize = size - 2;

    const label: string = data.label || '';
    const subLabel: string = data.tag || '';
    const clusterLabel: string = data.clusterLabel || '';

    // ── background card ──
    context.beginPath();
    context.fillStyle = '#fff';
    context.shadowOffsetX = 0;
    context.shadowOffsetY = 2;
    context.shadowBlur = 8;
    context.shadowColor = 'rgba(0,0,0,0.25)';

    context.font = `${weight} ${size}px ${font}`;
    const labelWidth = context.measureText(label).width;
    context.font = `${weight} ${subLabelSize}px ${font}`;
    const subLabelWidth = subLabel ? context.measureText(subLabel).width : 0;
    const clusterLabelWidth = clusterLabel ? context.measureText(clusterLabel).width : 0;

    const textWidth = Math.max(labelWidth, subLabelWidth, clusterLabelWidth);
    const x = Math.round(data.x);
    const y = Math.round(data.y);
    const w = Math.round(textWidth + size / 2 + data.size + 3);
    const hLabel = Math.round(size / 2 + 4);
    const hSubLabel = subLabel ? Math.round(subLabelSize / 2 + 9) : 0;
    const hClusterLabel = clusterLabel ? Math.round(subLabelSize / 2 + 9) : 0;

    // Rounded rectangle
    const totalH = hClusterLabel + hLabel + hSubLabel + 12;
    const topY = y - hSubLabel - 12;
    const radius = 5;
    context.beginPath();
    context.moveTo(x + radius, topY);
    context.lineTo(x + w - radius, topY);
    context.quadraticCurveTo(x + w, topY, x + w, topY + radius);
    context.lineTo(x + w, topY + totalH - radius);
    context.quadraticCurveTo(x + w, topY + totalH, x + w - radius, topY + totalH);
    context.lineTo(x + radius, topY + totalH);
    context.quadraticCurveTo(x, topY + totalH, x, topY + totalH - radius);
    context.lineTo(x, topY + radius);
    context.quadraticCurveTo(x, topY, x + radius, topY);
    context.closePath();
    context.fill();

    // Clear shadow for text
    context.shadowOffsetX = 0;
    context.shadowOffsetY = 0;
    context.shadowBlur = 0;

    // ── text labels ──
    // Type sub-label (above main label, smaller, muted)
    if (subLabel) {
        context.fillStyle = '#64748B';
        context.font = `${weight} ${subLabelSize}px ${font}`;
        context.fillText(subLabel, data.x + data.size + 3, data.y - (2 * size) / 3 - 2);
    }

    // Main label
    context.fillStyle = '#000';
    context.font = `${weight} ${size}px ${font}`;
    context.fillText(label, data.x + data.size + 3, data.y + size / 3);

    // Cluster/project label (colored, below main label)
    if (clusterLabel) {
        context.fillStyle = data.color;
        context.font = `${weight} ${subLabelSize}px ${font}`;
        context.fillText(clusterLabel, data.x + data.size + 3, data.y + size / 3 + 3 + subLabelSize);
    }
}

/* ─── Graph Loader: fetch data, build graphology, run FA2 ──────── */

interface GraphLoaderProps {
    onStatsReady: (stats: { nodes: number; edges: number }) => void;
    onTopologyReady?: (topology: {
        nodes: Array<{ id: string; type: string; project?: string; label?: string }>;
        truncated?: boolean;
        limit?: number;
        totalCoreNodes?: number;
    }) => void;
    /** Phase 3: user-configured size limit forwarded to /api/topology.
     *  Omit to let the server apply its default (10k). Server clamps to
     *  [1000, 20000] regardless — UI slider enforces the same range. */
    graphSizeLimit?: number;
    /** Q1.9 — When set, filter the rendered subgraph to nodes whose
     *  `project` matches this value. Used for drill-in from the
     *  overview mode. */
    projectFilter?: string | null;
}

const GraphLoader = ({ onStatsReady, onTopologyReady, graphSizeLimit, projectFilter }: GraphLoaderProps) => {
    const loadGraph = useLoadGraph();
    const sigma = useSigma();

    useEffect(() => {
        let active = true;

        const fetchGraph = async () => {
            try {
                const url = typeof graphSizeLimit === 'number'
                    ? `/api/topology?limit=${graphSizeLimit}`
                    : '/api/topology';
                const response = await authFetch(url);
                const data = await response.json();
                if (!active) return;
                if (onTopologyReady) onTopologyReady({
                    nodes: data.nodes ?? [],
                    truncated: data.truncated,
                    limit: data.limit,
                    totalCoreNodes: data.totalCoreNodes,
                });

                const graph = new Graph();

                // Q1.9 — project drill-in filter. When a projectFilter
                // is active we only load nodes in that project plus
                // their direct neighbors (so intra-project edges render
                // while cross-project noise stays in the overview).
                const filterActive =
                    typeof projectFilter === 'string' && projectFilter.length > 0;
                const inProject = (p: string | undefined | null) =>
                    !filterActive || (p ?? 'Global') === projectFilter;

                // ── Add nodes ──
                (data.nodes as LoreNode[]).forEach((n) => {
                    if (filterActive && !inProject(n.project)) return;
                    if (!graph.hasNode(n.id)) {
                        graph.addNode(n.id, {
                            x: Math.random() * 100,
                            y: Math.random() * 100,
                            size: MIN_NODE_SIZE,   // placeholder — resized after edges
                            label: n.label || n.id,
                            color: NODE_COLORS[n.type] || NODE_COLORS['default'],
                            // Extra attributes for hover card rendering
                            tag: n.type,
                            clusterLabel: n.project || 'Global',
                        });
                    }
                });

                // ── Add edges ──
                // C1 — edge opacity encodes confidence. Extracted (user-
                // asserted) edges render at full weight; inferred edges
                // use reduced alpha so the graph's "known facts" pop
                // visually above its "Lore's guesses" substrate.
                //
                //   extracted → 0x80 (50%)   confidence-tagged hex suffix
                //   inferred  → 0x30 (~19%)
                //   ambiguous → 0x20 (~12%) + slightly different hue
                //
                // Plugin-contributed edges with no confidence fall back
                // to extracted rendering (historical behavior preserved).
                (data.edges as LoreEdge[]).forEach((e) => {
                    try {
                        if (graph.hasNode(e.from) && graph.hasNode(e.to) && !graph.hasEdge(e.from, e.to)) {
                            const conf = e.confidence ?? 'extracted';
                            const color =
                                conf === 'inferred'  ? '#94A3B830' :
                                conf === 'ambiguous' ? '#F59E0B20' :
                                                       '#94A3B880';
                            graph.addEdge(e.from, e.to, {
                                label: e.label,
                                type: 'arrow',
                                size: 1,
                                color,
                                confidence: conf,
                                confidenceScore: e.confidenceScore ?? 1.0,
                            });
                        }
                    } catch {
                        // Safely skip duplicate or dangling edges
                    }
                });

                // ── Degree-based node sizing ──
                // Same approach as the Wikipedia cartography: node size is
                // proportional to its degree (number of connections).
                const degrees = graph.nodes().map((nodeId) => graph.degree(nodeId));
                const minDeg = Math.min(...degrees, 0);
                const maxDeg = Math.max(...degrees, 1);
                const degRange = maxDeg - minDeg || 1;

                graph.forEachNode((nodeId) => {
                    const degree = graph.degree(nodeId);
                    const normalized = (degree - minDeg) / degRange;
                    const nodeSize = MIN_NODE_SIZE + normalized * (MAX_NODE_SIZE - MIN_NODE_SIZE);
                    graph.setNodeAttribute(nodeId, 'size', nodeSize);
                });

                // ── ForceAtlas2 layout — capped at 2000 iterations OR 3s ──
                // Phase 3 performance ceiling (docs/V2_implementation_plan.md).
                // forceAtlas2.assign() is synchronous; we approximate the
                // 3s wall-clock cap by chunking into slices of 100 iterations
                // and breaking early when the clock runs out.
                const fa2Settings = forceAtlas2.inferSettings(graph);
                const settings = {
                    ...fa2Settings,
                    gravity: 0.05,
                    scalingRatio: 8,
                    barnesHutOptimize: true,
                } as const;
                const deadline = Date.now() + 3000;
                let iterationsDone = 0;
                while (iterationsDone < 2000 && Date.now() < deadline) {
                    forceAtlas2.assign(graph, { iterations: 100, settings });
                    iterationsDone += 100;
                }

                loadGraph(graph);

                // Report counts
                onStatsReady({
                    nodes: graph.order,
                    edges: graph.size,
                });

                // Apply Sigma settings for the cartography style
                sigma.setSetting('labelRenderedSizeThreshold', LABEL_RENDERED_SIZE_THRESHOLD);
                sigma.setSetting('labelFont', 'Inter, -apple-system, system-ui, sans-serif');
                sigma.setSetting('labelSize', 13);
                sigma.setSetting('labelWeight', '500');
                sigma.setSetting('defaultDrawNodeLabel', drawLabel);
                sigma.setSetting('defaultDrawNodeHover', drawHover);
                sigma.setSetting('defaultEdgeType', 'arrow');
                sigma.setSetting('edgeLabelSize', 10);
                sigma.setSetting('renderEdgeLabels', false);
                // nodeReducer / edgeReducer are owned by <ViewStateEffect>;
                // do NOT install a passthrough here — it would race and
                // overwrite the filter/hover composition on first load.

            } catch (err) {
                console.error('Failed to load Sigma topology', err);
            }
        };

        fetchGraph();

        return () => { active = false; };
    }, [loadGraph, sigma, onStatsReady, onTopologyReady, graphSizeLimit, projectFilter]);

    return null;
};

/* ─── Drag interaction handler ─────────────────────────────────── */

const DragEvents = () => {
    const registerEvents = useRegisterEvents();
    const sigma = useSigma();
    const draggedNodeRef = useRef<string | null>(null);

    useEffect(() => {
        registerEvents({
            downNode: (event) => {
                draggedNodeRef.current = event.node;
                sigma.getGraph().setNodeAttribute(event.node, 'highlighted', true);
            },
            mousemovebody: (event) => {
                if (!draggedNodeRef.current) return;
                const pos = sigma.viewportToGraph(event);
                sigma.getGraph().setNodeAttribute(draggedNodeRef.current, 'x', pos.x);
                sigma.getGraph().setNodeAttribute(draggedNodeRef.current, 'y', pos.y);
                event.preventSigmaDefault();
                event.original.preventDefault();
                event.original.stopPropagation();
            },
            mouseup: () => {
                if (draggedNodeRef.current) {
                    sigma.getGraph().removeNodeAttribute(draggedNodeRef.current, 'highlighted');
                    draggedNodeRef.current = null;
                }
            },
            mousedown: () => {
                if (!sigma.getCustomBBox()) sigma.setCustomBBox(sigma.getBBox());
            },
        });
    }, [registerEvents, sigma]);

    return null;
};

/* ─── Stats overlay badge ──────────────────────────────────────── */

interface StatsOverlayProps {
    nodes: number;
    edges: number;
}

function StatsOverlay({ nodes, edges }: StatsOverlayProps) {
    return (
        <div style={{
            position: 'absolute',
            top: 12,
            left: 12,
            fontSize: '0.8rem',
            lineHeight: 1.4,
            color: 'var(--color-text-secondary)',
            pointerEvents: 'none',
            zIndex: 5,
        }}>
            <div style={{ fontWeight: 600, fontSize: '0.95rem', color: 'var(--color-text-primary)' }}>
                Knowledge Graph
            </div>
            <div style={{ color: 'var(--color-accent)' }}>
                {nodes} nodes, {edges} edges
            </div>
        </div>
    );
}

/* ─── Zoom controls (styled to match the demo) ────────────────── */

function CustomZoomControls() {
    const sigma = useSigma();

    const handleZoomIn = () => {
        const camera = sigma.getCamera();
        camera.animatedZoom({ duration: 300 });
    };

    const handleZoomOut = () => {
        const camera = sigma.getCamera();
        camera.animatedUnzoom({ duration: 300 });
    };

    const handleReset = () => {
        const camera = sigma.getCamera();
        camera.animatedReset({ duration: 300 });
    };

    return (
        <div style={{
            position: 'absolute',
            bottom: 16,
            left: 16,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            zIndex: 10,
        }}>
            {[
                { icon: <ZoomIn size={16} />, action: handleZoomIn, title: 'Zoom in' },
                { icon: <ZoomOut size={16} />, action: handleZoomOut, title: 'Zoom out' },
                { icon: <RotateCcw size={16} />, action: handleReset, title: 'Reset view' },
            ].map((btn) => (
                <button
                    key={btn.title}
                    title={btn.title}
                    onClick={btn.action}
                    style={{
                        width: 36,
                        height: 36,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        border: '1px solid var(--color-border)',
                        borderRadius: 6,
                        background: 'var(--glass-bg)',
                        backdropFilter: 'blur(8px)',
                        color: 'var(--color-text-secondary)',
                        cursor: 'pointer',
                        transition: 'all 0.15s',
                    }}
                    onMouseEnter={(event) => { (event.target as HTMLElement).style.background = 'var(--color-surface-hover)'; }}
                    onMouseLeave={(event) => { (event.target as HTMLElement).style.background = 'var(--glass-bg)'; }}
                >
                    {btn.icon}
                </button>
            ))}
        </div>
    );
}

/* ─── Legend ────────────────────────────────────────────────────── */

function Legend() {
    const entries = Object.entries(NODE_COLORS).filter(([k]) => k !== 'default');
    return (
        <div style={{
            position: 'absolute',
            bottom: 16,
            right: 16,
            display: 'flex',
            flexWrap: 'wrap',
            gap: '6px 14px',
            padding: '10px 14px',
            background: 'var(--glass-bg)',
            backdropFilter: 'blur(8px)',
            border: '1px solid var(--color-border)',
            borderRadius: 8,
            fontSize: '0.72rem',
            color: 'var(--color-text-secondary)',
            zIndex: 10,
            maxWidth: 320,
        }}>
            {entries.map(([type, color]) => (
                <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        backgroundColor: color,
                        flexShrink: 0,
                    }} />
                    <span>{type.replace('_', ' ')}</span>
                </div>
            ))}
        </div>
    );
}

/* ─── Phase 3: Filter + Hover + Camera effect components ────── */

interface ViewStateEffectProps {
    activeTypes: Set<string> | null;
    activeProjects: Set<string> | null;
    /**
     * C1 — when false, edges whose `confidence === 'inferred'` are
     * hidden via the edgeReducer. Default true so the initial
     * render matches pre-C1 behavior.
     */
    showInferred: boolean;
}

/**
 * ViewStateEffect — owns the sole nodeReducer + edgeReducer on the
 * Sigma instance. Previously filter-dimming and hover-highlighting
 * lived in separate components that each called sigma.setSetting
 * independently, which meant hovering a node overwrote the filter's
 * reducer and leaveNode cleared it — filtered-out nodes came back
 * visible and stayed visible until a filter checkbox changed.
 *
 * Option 1 fix: single source of truth. Hover state lives in refs;
 * enterNode/leaveNode just mutate the refs and call sigma.refresh(),
 * which re-invokes the same composed reducer. The reducer layers
 * filter dim under hover dim so both states stay consistent.
 */
const ViewStateEffect = ({ activeTypes, activeProjects, showInferred }: ViewStateEffectProps) => {
    const sigma = useSigma();
    const registerEvents = useRegisterEvents();
    const hoverNeighborsRef = useRef<Set<string> | null>(null);

    // Hover events flip the ref + refresh; the reducer below re-runs
    // with the new ref value. No setSetting calls here.
    useEffect(() => {
        registerEvents({
            enterNode: ({ node }) => {
                const graph = sigma.getGraph();
                const neighbours = new Set(graph.neighbors(node));
                neighbours.add(node);
                hoverNeighborsRef.current = neighbours;
                sigma.refresh();
            },
            leaveNode: () => {
                hoverNeighborsRef.current = null;
                sigma.refresh();
            },
        });
    }, [registerEvents, sigma]);

    // Reducers — re-installed when the filter props change. The
    // closures read the current filter state (props) and the live
    // hover state (ref), so hovering doesn't need a reinstall.
    useEffect(() => {
        sigma.setSetting('nodeReducer', (nodeId: string, data: Attributes) => {
            const t = data.tag as string;
            const c = data.clusterLabel as string;
            const dimType = activeTypes !== null && !activeTypes.has(t);
            const dimProj = activeProjects !== null && !activeProjects.has(c);
            const filteredOut = dimType || dimProj;

            const neighbours = hoverNeighborsRef.current;
            if (neighbours) {
                if (!neighbours.has(nodeId)) {
                    // Not in hover neighborhood: aggressive hover dim.
                    return { ...data, color: '#e0e0e0', label: '', zIndex: 0 };
                }
                // In neighborhood — still respect the filter dim.
                if (filteredOut) {
                    return { ...data, color: '#cbd5e188', label: '', zIndex: 0 };
                }
                return { ...data, zIndex: 1 };
            }

            if (filteredOut) {
                return { ...data, color: '#cbd5e188', label: '', zIndex: 0 };
            }
            return data;
        });

        sigma.setSetting('edgeReducer', (edgeId: string, data: Attributes) => {
            // C1 — hide inferred edges when the user has toggled them off.
            // Applies regardless of hover state so the "clean up my view"
            // intent wins over hover's neighborhood highlight.
            if (!showInferred && data.confidence === 'inferred') {
                return { ...data, hidden: true };
            }

            const neighbours = hoverNeighborsRef.current;
            if (!neighbours) return data;
            const graph = sigma.getGraph();
            const source = graph.source(edgeId);
            const target = graph.target(edgeId);
            if (neighbours.has(source) && neighbours.has(target)) {
                return { ...data, color: '#333', size: 2 };
            }
            return { ...data, hidden: true };
        });

        sigma.refresh();
    }, [sigma, activeTypes, activeProjects, showInferred]);

    return null;
};

interface CameraEffectProps {
    focusNodeId: string | null;
}

/**
 * CameraEffect — Smoothly animates the camera to a target node whenever
 * the incoming focusNodeId changes. Gracefully no-ops on unknown IDs
 * (per Phase 3 fallback "NodeId not in current graph → silently ignored").
 * Pauses user-initiated pans for 3s before restoring auto-focus behavior.
 */
const CameraEffect = ({ focusNodeId }: CameraEffectProps) => {
    const sigma = useSigma();
    const pauseUntilRef = useRef<number>(0);
    const registerEvents = useRegisterEvents();

    // Detect user pans; pause auto-follow for 3s.
    useEffect(() => {
        registerEvents({
            mousedown: () => { pauseUntilRef.current = Date.now() + 3000; },
            wheel: () => { pauseUntilRef.current = Date.now() + 3000; },
        });
    }, [registerEvents]);

    useEffect(() => {
        if (!focusNodeId) return;
        if (Date.now() < pauseUntilRef.current) return;
        const graph = sigma.getGraph();
        if (!graph.hasNode(focusNodeId)) return;
        const { x, y } = graph.getNodeAttributes(focusNodeId) as { x: number; y: number };
        sigma.getCamera().animate({ x, y, ratio: 0.35 }, { duration: 600 });
    }, [sigma, focusNodeId]);

    return null;
};

/* ─── Q1.9 — Overview loader (project-blob LOD) ───────────────── */

// Synthetic node id for each blob. Prefixed so we can cheaply detect
// overview-mode clicks in the click handler.
const OVERVIEW_BLOB_PREFIX = '__blob__:';

// Deterministic color palette for project blobs. The palette cycles
// over a small steel-blue / slate ramp — hue is intentionally quiet
// so the graph-mode color legend retains semantic weight. Project
// differentiation comes from size + label, not hue.
const OVERVIEW_BLOB_COLORS = [
    '#3182CE', '#38A169', '#805AD5', '#DD6B20',
    '#319795', '#B7791F', '#E53E3E', '#4A5568',
];
const blobColor = (project: string): string => {
    let hash = 0;
    for (let i = 0; i < project.length; i++) {
        hash = (hash * 31 + project.charCodeAt(i)) | 0;
    }
    return OVERVIEW_BLOB_COLORS[Math.abs(hash) % OVERVIEW_BLOB_COLORS.length];
};

interface OverviewLoaderProps {
    payload: OverviewPayload;
    onStatsReady: (stats: { nodes: number; edges: number }) => void;
}

const OverviewGraphLoader = ({ payload, onStatsReady }: OverviewLoaderProps) => {
    const loadGraph = useLoadGraph();
    const sigma = useSigma();

    useEffect(() => {
        const graph = new Graph();

        // Blob sizing: log-scale on nodeCount, clamped. Log keeps a
        // 10-node project readable next to a 10k-node monster without
        // either dominating — blobs communicate "relative mass" not
        // absolute count. Absolute count shows in the hover card.
        const counts = payload.blobs.map((b) => b.nodeCount);
        const maxLog = Math.log(Math.max(...counts, 2) + 1);
        const minLog = Math.log(Math.min(...counts, 1) + 1);
        const logRange = maxLog - minLog || 1;

        payload.blobs.forEach((blob) => {
            const normalized = (Math.log(blob.nodeCount + 1) - minLog) / logRange;
            const size =
                OVERVIEW_MIN_BLOB_SIZE +
                normalized * (OVERVIEW_MAX_BLOB_SIZE - OVERVIEW_MIN_BLOB_SIZE);
            graph.addNode(`${OVERVIEW_BLOB_PREFIX}${blob.project}`, {
                x: Math.random() * 100,
                y: Math.random() * 100,
                size,
                label: `${blob.project} (${blob.nodeCount})`,
                color: blobColor(blob.project),
                tag: 'project',
                clusterLabel: blob.project,
                // Retained in attrs for the click handler + hover card.
                blobProject: blob.project,
                blobNodeCount: blob.nodeCount,
            });
        });

        // Aggregate edges. Thickness ∝ log(count). Color is neutral
        // gray so bundles read as "connection tissue" rather than
        // compete with blob color.
        const edgeCounts = payload.aggregateEdges.map((e) => e.count);
        const maxEdgeLog = Math.log(Math.max(...edgeCounts, 2) + 1);
        const minEdgeLog = Math.log(Math.min(...edgeCounts, 1) + 1);
        const edgeLogRange = maxEdgeLog - minEdgeLog || 1;

        payload.aggregateEdges.forEach((edge) => {
            const fromId = `${OVERVIEW_BLOB_PREFIX}${edge.fromProject}`;
            const toId = `${OVERVIEW_BLOB_PREFIX}${edge.toProject}`;
            if (!graph.hasNode(fromId) || !graph.hasNode(toId)) return;
            // Sigma rejects duplicate parallel edges; collapse directional
            // pairs into the larger of the two by replacing the existing
            // one when this direction carries more weight.
            if (graph.hasEdge(fromId, toId) || graph.hasEdge(toId, fromId)) {
                return;
            }
            const normalized = (Math.log(edge.count + 1) - minEdgeLog) / edgeLogRange;
            const thickness = 1 + normalized * 5; // 1–6 px
            graph.addEdge(fromId, toId, {
                label: String(edge.count),
                type: 'arrow',
                size: thickness,
                color: '#94A3B880',
                aggregateCount: edge.count,
            });
        });

        // ForceAtlas2 on the aggregate graph. Blob count is O(projects),
        // typically <30 even in very heavy workspaces — a short pass
        // produces a readable layout in <100 ms.
        if (graph.order > 1) {
            const fa2Settings = forceAtlas2.inferSettings(graph);
            forceAtlas2.assign(graph, {
                iterations: 300,
                settings: {
                    ...fa2Settings,
                    gravity: 0.2,
                    scalingRatio: 20,
                    barnesHutOptimize: graph.order > 50,
                },
            });
        }

        loadGraph(graph);
        onStatsReady({ nodes: graph.order, edges: graph.size });

        // Reset to neutral sigma settings (the ViewStateEffect's
        // nodeReducer still runs — but activeTypes/activeProjects are
        // null in overview mode so it's a passthrough).
        sigma.setSetting('labelRenderedSizeThreshold', 0); // always show blob labels
        sigma.setSetting('labelFont', 'Inter, -apple-system, system-ui, sans-serif');
        sigma.setSetting('labelSize', 13);
        sigma.setSetting('labelWeight', '600');
        sigma.setSetting('defaultDrawNodeLabel', drawLabel);
        sigma.setSetting('defaultDrawNodeHover', drawHover);
        sigma.setSetting('defaultEdgeType', 'arrow');
        sigma.setSetting('renderEdgeLabels', true); // show count on bundles
        sigma.setSetting('edgeLabelSize', 11);
    }, [payload, loadGraph, sigma, onStatsReady]);

    return null;
};

/**
 * Q1.9 — Click handler in overview mode. Double-click (or single-click
 * per spec; we honor both) animates the camera onto the blob in <300ms
 * then hands the blob id back to the parent via onBlobClick so the
 * parent can flip view-mode to `project:<name>`.
 *
 * Sibling fade happens via the ViewStateEffect's nodeReducer when the
 * parent updates the mode — so this component only owns the camera
 * animation + the mode-flip signal.
 */
const OverviewInteraction = ({
    onBlobClick,
    onAggregateEdgeClick,
}: {
    onBlobClick: (project: string) => void;
    onAggregateEdgeClick: (edge: { fromProject: string; toProject: string; count: number }) => void;
}) => {
    const sigma = useSigma();
    const registerEvents = useRegisterEvents();
    useEffect(() => {
        registerEvents({
            clickNode: ({ node }) => {
                if (!node.startsWith(OVERVIEW_BLOB_PREFIX)) return;
                const graph = sigma.getGraph();
                const attrs = graph.getNodeAttributes(node) as {
                    x: number; y: number; blobProject?: string;
                };
                const project = attrs.blobProject;
                if (!project) return;
                // Animate in < 300ms per Q1.9 spec.
                sigma.getCamera().animate(
                    { x: attrs.x, y: attrs.y, ratio: 0.35 },
                    { duration: 260 },
                );
                // Fire the mode flip just after the animation kicks off so
                // the parent remount happens against the zoomed viewport.
                window.setTimeout(() => onBlobClick(project), 280);
            },
            clickEdge: ({ edge }) => {
                const graph = sigma.getGraph();
                const attrs = graph.getEdgeAttributes(edge) as { aggregateCount?: number };
                if (typeof attrs.aggregateCount !== 'number') return;
                const from = graph.source(edge);
                const to = graph.target(edge);
                const fromProject = (graph.getNodeAttribute(from, 'blobProject') as string | undefined) ?? '';
                const toProject = (graph.getNodeAttribute(to, 'blobProject') as string | undefined) ?? '';
                if (!fromProject || !toProject) return;
                onAggregateEdgeClick({ fromProject, toProject, count: attrs.aggregateCount });
            },
        });
    }, [registerEvents, sigma, onBlobClick, onAggregateEdgeClick]);
    return null;
};

/* ─── Main export ──────────────────────────────────────────────── */

interface SigmaCanvasProps {
    activeTypes?: Set<string> | null;
    activeProjects?: Set<string> | null;
    focusNodeId?: string | null;
    onTopologyReady?: (topology: {
        nodes: Array<{ id: string; type: string; project?: string; label?: string }>;
        truncated?: boolean;
        limit?: number;
        totalCoreNodes?: number;
    }) => void;
    /** V2.1: emit when the user clicks a graph node. */
    onNodeClick?: (nodeId: string) => void;
    /** C1: when false, inferred-confidence edges are hidden. Default true. */
    showInferred?: boolean;
    /** Phase 3: user-configured graph size limit. Forwarded to /api/topology
     *  as ?limit=N. Server clamps to [1000, 20000]; UI slider enforces same. */
    graphSizeLimit?: number;
    /** Q1.9 — Threshold (total node count) above which the canvas
     *  auto-picks overview mode on first load. Default 1000. Set to
     *  Infinity to pin full-globe regardless of size (bypass). */
    semanticZoomThreshold?: number;
}

/**
 * ClickEvent — translates Sigma's clickNode into a prop callback.
 * Registered alongside the existing Drag + Hover event listeners.
 */
const ClickEvents = ({ onNodeClick }: { onNodeClick?: (nodeId: string) => void }) => {
    const registerEvents = useRegisterEvents();
    useEffect(() => {
        registerEvents({
            clickNode: ({ node }) => {
                if (onNodeClick) onNodeClick(node);
            },
        });
    }, [registerEvents, onNodeClick]);
    return null;
};

export default function SigmaCanvas({
    activeTypes = null,
    activeProjects = null,
    focusNodeId = null,
    onTopologyReady,
    onNodeClick,
    showInferred = true,
    graphSizeLimit,
    semanticZoomThreshold = SEMANTIC_ZOOM_THRESHOLD,
}: SigmaCanvasProps) {
    const [stats, setStats] = useState<{ nodes: number; edges: number } | null>(null);

    // Q1.9 — view-mode state. Starts as null (unknown) until the first
    // overview fetch resolves; then we pick 'overview' or 'full' based
    // on totalNodes vs the configured threshold.
    const [viewMode, setViewMode] = useState<TopologyViewMode | null>(null);
    const [overview, setOverview] = useState<OverviewPayload | null>(null);
    const [overviewError, setOverviewError] = useState<string | null>(null);
    const [aggregateEdgeInspector, setAggregateEdgeInspector] = useState<
        { fromProject: string; toProject: string; count: number } | null
    >(null);

    const handleStatsReady = useCallback((newStats: { nodes: number; edges: number }) => {
        setStats(newStats);
    }, []);

    // Fetch the overview payload once on mount. Airplane-safe — handler
    // is /api/topology/overview which aggregates via local Kùzu.
    useEffect(() => {
        let active = true;
        (async () => {
            try {
                const res = await authFetch('/api/topology/overview?groupBy=project');
                if (!res.ok) throw new Error(`overview HTTP ${res.status}`);
                const payload = await res.json() as OverviewPayload;
                if (!active) return;
                setOverview(payload);
                // Initial mode selection: auto-pick overview above threshold
                // OR when there are enough distinct projects that a blob
                // summary is actually useful (>=3 projects). Otherwise full.
                if (viewMode === null) {
                    const pickOverview =
                        payload.totalNodes >= semanticZoomThreshold &&
                        payload.blobs.length >= 2;
                    setViewMode(pickOverview ? { kind: 'overview' } : { kind: 'full' });
                }
            } catch (err) {
                if (!active) return;
                setOverviewError((err as Error).message);
                // Fall back to full globe on any overview error so the
                // user never loses the graph — this is a pure additive
                // feature. viewMode defaults to 'full'.
                if (viewMode === null) setViewMode({ kind: 'full' });
            }
        })();
        return () => { active = false; };
        // Intentionally empty dep array: we re-fetch the overview only
        // when the workspace changes (page reload). Drill-in/back does
        // not re-fetch.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // While the first overview fetch is in flight, render nothing
    // visible — the Suspense fallback upstream already covered this.
    // Default to 'full' if somehow we get here without a decision.
    const mode: TopologyViewMode = viewMode ?? { kind: 'full' };

    const isOverview = mode.kind === 'overview';
    const projectFilter = mode.kind === 'project' ? mode.project : null;

    // In overview mode we own the click semantics (blob drill-in),
    // so the parent's onNodeClick is suppressed there — a click on a
    // blob should not behave like a click on a real LoreNode.
    const effectiveNodeClick = isOverview ? undefined : onNodeClick;

    // Overview mode passes a no-op for activeTypes/activeProjects
    // filters — the ViewStateEffect dim logic would otherwise grey out
    // blobs that don't match a type (project-blobs have tag:'project',
    // which isn't in the user's type filter).
    const effectiveActiveTypes = isOverview ? null : activeTypes;
    const effectiveActiveProjects = isOverview ? null : activeProjects;

    // Breadcrumb label. Kept small; lives top-right to avoid the
    // StatsOverlay's top-left real estate.
    const breadcrumb = useMemo(() => {
        if (mode.kind === 'full') return null;
        if (mode.kind === 'overview') return overview ? `Overview — ${overview.blobs.length} projects` : 'Overview';
        return `Overview › ${mode.project}`;
    }, [mode, overview]);

    // The Sigma container is intentionally keyed on the mode kind so
    // switching between overview / project / full remounts the graph
    // instance. This avoids layout state leaks across modes (previous
    // node positions bleeding into the next mode's first frame).
    const sigmaKey =
        mode.kind === 'project' ? `project:${mode.project}` : mode.kind;

    return (
        <div style={{ position: 'relative', width: '100%', height: '100%', outline: 'none' }}>
            <SigmaContainer
                key={sigmaKey}
                style={{ height: '100%', width: '100%', background: 'transparent' }}
                settings={{
                    labelRenderedSizeThreshold: LABEL_RENDERED_SIZE_THRESHOLD,
                    labelFont: 'Inter, -apple-system, system-ui, sans-serif',
                    labelSize: 13,
                    labelWeight: '500',
                    labelColor: { color: '#1E293B' },
                    defaultEdgeColor: '#94A3B880',
                    defaultEdgeType: 'arrow',
                    renderEdgeLabels: false,
                    zIndex: true,
                    defaultDrawNodeLabel: drawLabel,
                    defaultDrawNodeHover: drawHover,
                    // Allow zero-dim containers during initial mount (common in
                    // flex layouts + Puppeteer-based previews). Sigma re-renders
                    // once the ResizeObserver fires.
                    allowInvalidContainer: true,
                }}
            >
                {isOverview && overview ? (
                    <>
                        <OverviewGraphLoader payload={overview} onStatsReady={handleStatsReady} />
                        <OverviewInteraction
                            onBlobClick={(project) => setViewMode({ kind: 'project', project })}
                            onAggregateEdgeClick={(edge) => setAggregateEdgeInspector(edge)}
                        />
                    </>
                ) : (
                    <GraphLoader
                        onStatsReady={handleStatsReady}
                        onTopologyReady={onTopologyReady}
                        graphSizeLimit={graphSizeLimit}
                        projectFilter={projectFilter}
                    />
                )}
                <DragEvents />
                <ClickEvents onNodeClick={effectiveNodeClick} />
                <ViewStateEffect
                    activeTypes={effectiveActiveTypes}
                    activeProjects={effectiveActiveProjects}
                    showInferred={showInferred}
                />
                <CameraEffect focusNodeId={isOverview ? null : focusNodeId} />
                <CustomZoomControls />
            </SigmaContainer>

            {/* Stats overlay — top-left corner */}
            {stats && <StatsOverlay nodes={stats.nodes} edges={stats.edges} />}

            {/* Q1.9 — Breadcrumb / back-to-overview chrome. Top-center.
                In overview mode it's a non-clickable label. In project
                mode it's a clickable "← Back to overview" affordance. */}
            {breadcrumb && (
                <div
                    style={{
                        position: 'absolute',
                        top: 12,
                        left: '50%',
                        transform: 'translateX(-50%)',
                        zIndex: 12,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '6px 12px',
                        fontSize: '0.78rem',
                        fontWeight: 500,
                        color: 'var(--color-text-primary)',
                        background: 'var(--glass-bg)',
                        backdropFilter: 'blur(8px)',
                        border: '1px solid var(--color-border)',
                        borderRadius: 6,
                    }}
                >
                    {mode.kind === 'project' ? (
                        <button
                            type="button"
                            onClick={() => setViewMode({ kind: 'overview' })}
                            title="Back to overview"
                            aria-label="Back to overview"
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 4,
                                border: 'none',
                                background: 'transparent',
                                padding: 0,
                                color: 'inherit',
                                cursor: 'pointer',
                                fontSize: 'inherit',
                                fontWeight: 'inherit',
                            }}
                        >
                            <ChevronLeft size={14} />
                            <span>Overview</span>
                            <span style={{ color: 'var(--color-text-secondary)' }}>›</span>
                            <span>{mode.project}</span>
                        </button>
                    ) : (
                        <span>{breadcrumb}</span>
                    )}
                </div>
            )}

            {/* Q1.9 — If the user was pinned below threshold but wants
                to opt into overview (e.g. to explore cross-project
                structure anyway), they can click this pill. It's only
                shown when we picked 'full' AND there are enough blobs
                to be interesting (>=3 projects). */}
            {mode.kind === 'full' && overview && overview.blobs.length >= 3 && (
                <button
                    type="button"
                    onClick={() => setViewMode({ kind: 'overview' })}
                    title="Switch to project-blob overview"
                    style={{
                        position: 'absolute',
                        top: 12,
                        right: 12,
                        zIndex: 12,
                        padding: '5px 10px',
                        fontSize: '0.72rem',
                        color: 'var(--color-text-secondary)',
                        background: 'var(--glass-bg)',
                        backdropFilter: 'blur(8px)',
                        border: '1px solid var(--color-border)',
                        borderRadius: 6,
                        cursor: 'pointer',
                    }}
                >
                    Overview ({overview.blobs.length} projects)
                </button>
            )}

            {/* Q1.9 — Aggregate-edge inspector popover. Click a bundle in
                overview mode to see the from→to pair and count. Shallow
                on purpose; the "reveal underlying links" feature is the
                natural drill-in: pick a project. */}
            {aggregateEdgeInspector && (
                <div
                    role="dialog"
                    style={{
                        position: 'absolute',
                        top: 56,
                        left: '50%',
                        transform: 'translateX(-50%)',
                        zIndex: 13,
                        padding: '10px 14px',
                        fontSize: '0.78rem',
                        color: 'var(--color-text-primary)',
                        background: 'var(--glass-bg)',
                        backdropFilter: 'blur(8px)',
                        border: '1px solid var(--color-border)',
                        borderRadius: 8,
                        minWidth: 240,
                        maxWidth: 360,
                    }}
                >
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>
                        {aggregateEdgeInspector.fromProject} → {aggregateEdgeInspector.toProject}
                    </div>
                    <div style={{ color: 'var(--color-text-secondary)', marginBottom: 8 }}>
                        {aggregateEdgeInspector.count} cross-project edges
                    </div>
                    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                        <button
                            type="button"
                            onClick={() => {
                                const target = aggregateEdgeInspector.fromProject;
                                setAggregateEdgeInspector(null);
                                setViewMode({ kind: 'project', project: target });
                            }}
                            style={{
                                padding: '4px 8px',
                                fontSize: '0.72rem',
                                background: 'transparent',
                                border: '1px solid var(--color-border)',
                                borderRadius: 4,
                                color: 'inherit',
                                cursor: 'pointer',
                            }}
                        >
                            Open {aggregateEdgeInspector.fromProject}
                        </button>
                        <button
                            type="button"
                            onClick={() => setAggregateEdgeInspector(null)}
                            style={{
                                padding: '4px 8px',
                                fontSize: '0.72rem',
                                background: 'transparent',
                                border: '1px solid var(--color-border)',
                                borderRadius: 4,
                                color: 'inherit',
                                cursor: 'pointer',
                            }}
                        >
                            Close
                        </button>
                    </div>
                </div>
            )}

            {/* Surface a (quiet) error banner if the overview fetch
                failed — the canvas still renders via full-globe fallback. */}
            {overviewError && (
                <div
                    style={{
                        position: 'absolute',
                        bottom: 12,
                        left: '50%',
                        transform: 'translateX(-50%)',
                        zIndex: 12,
                        padding: '4px 10px',
                        fontSize: '0.7rem',
                        color: 'var(--color-text-secondary)',
                        background: 'var(--glass-bg)',
                        backdropFilter: 'blur(8px)',
                        border: '1px solid var(--color-border)',
                        borderRadius: 4,
                    }}
                    title={overviewError}
                >
                    overview unavailable — full graph shown
                </div>
            )}

            {/* Type legend — bottom-right corner. Only in full/project
                modes; overview has its own blob-level legibility. */}
            {!isOverview && <Legend />}
        </div>
    );
}
