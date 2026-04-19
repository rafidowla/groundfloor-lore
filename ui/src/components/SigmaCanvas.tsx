import { useEffect, useRef, useState, useCallback } from 'react';
import { SigmaContainer, useLoadGraph, useRegisterEvents, useSigma } from '@react-sigma/core';
import '@react-sigma/core/lib/style.css';
import Graph from 'graphology';
import type { Attributes } from 'graphology-types';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import { ZoomIn, ZoomOut, RotateCcw } from 'lucide-react';
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
    onTopologyReady?: (topology: { nodes: Array<{ id: string; type: string; project?: string; label?: string }> }) => void;
}

const GraphLoader = ({ onStatsReady, onTopologyReady }: GraphLoaderProps) => {
    const loadGraph = useLoadGraph();
    const sigma = useSigma();

    useEffect(() => {
        let active = true;

        const fetchGraph = async () => {
            try {
                const response = await authFetch('/api/topology');
                const data = await response.json();
                if (!active) return;
                if (onTopologyReady) onTopologyReady({ nodes: data.nodes ?? [] });

                const graph = new Graph();

                // ── Add nodes ──
                (data.nodes as LoreNode[]).forEach((n) => {
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
                (data.edges as LoreEdge[]).forEach((e) => {
                    try {
                        if (graph.hasNode(e.from) && graph.hasNode(e.to) && !graph.hasEdge(e.from, e.to)) {
                            graph.addEdge(e.from, e.to, {
                                label: e.label,
                                type: 'arrow',
                                size: 1,
                                color: '#94A3B880',
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
    }, [loadGraph, sigma, onStatsReady, onTopologyReady]);

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
const ViewStateEffect = ({ activeTypes, activeProjects }: ViewStateEffectProps) => {
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
    }, [sigma, activeTypes, activeProjects]);

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

/* ─── Main export ──────────────────────────────────────────────── */

interface SigmaCanvasProps {
    activeTypes?: Set<string> | null;
    activeProjects?: Set<string> | null;
    focusNodeId?: string | null;
    onTopologyReady?: (topology: { nodes: Array<{ id: string; type: string; project?: string; label?: string }> }) => void;
    /** V2.1: emit when the user clicks a graph node. */
    onNodeClick?: (nodeId: string) => void;
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
}: SigmaCanvasProps) {
    const [stats, setStats] = useState<{ nodes: number; edges: number } | null>(null);

    const handleStatsReady = useCallback((newStats: { nodes: number; edges: number }) => {
        setStats(newStats);
    }, []);

    return (
        <div style={{ position: 'relative', width: '100%', height: '100%', outline: 'none' }}>
            <SigmaContainer
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
                <GraphLoader onStatsReady={handleStatsReady} onTopologyReady={onTopologyReady} />
                <DragEvents />
                <ClickEvents onNodeClick={onNodeClick} />
                <ViewStateEffect activeTypes={activeTypes} activeProjects={activeProjects} />
                <CameraEffect focusNodeId={focusNodeId} />
                <CustomZoomControls />
            </SigmaContainer>

            {/* Stats overlay — top-left corner */}
            {stats && <StatsOverlay nodes={stats.nodes} edges={stats.edges} />}

            {/* Type legend — bottom-right corner */}
            <Legend />
        </div>
    );
}
