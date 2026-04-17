import { useEffect, useRef, useState, useCallback } from 'react';
import { SigmaContainer, useLoadGraph, useRegisterEvents, useSigma } from '@react-sigma/core';
import '@react-sigma/core/lib/style.css';
import Graph from 'graphology';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import { ZoomIn, ZoomOut, RotateCcw } from 'lucide-react';

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
function drawLabel(
    context: CanvasRenderingContext2D,
    data: { x: number; y: number; size: number; label: string; color: string },
    settings: { labelSize: number; labelFont: string; labelWeight: string },
): void {
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
function drawHover(
    context: CanvasRenderingContext2D,
    data: Record<string, any>,
    settings: Record<string, any>,
): void {
    const size = settings.labelSize as number;
    const font = settings.labelFont as string;
    const weight = settings.labelWeight as string;
    const subLabelSize = size - 2;

    const label: string = data.label || data.id || '';
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
                const response = await fetch('/api/topology');
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
                sigma.setSetting('defaultDrawNodeLabel', drawLabel as any);
                sigma.setSetting('defaultDrawNodeHover', drawHover as any);
                sigma.setSetting('defaultEdgeType', 'arrow');
                sigma.setSetting('edgeLabelSize', 10);
                sigma.setSetting('renderEdgeLabels', false);
                // Node border on hover
                sigma.setSetting('nodeReducer', (_node: string, data: Record<string, any>) => {
                    return { ...data };
                });

            } catch (err) {
                console.error('Failed to load Sigma topology', err);
            }
        };

        fetchGraph();

        return () => { active = false; };
    }, [loadGraph, sigma, onStatsReady]);

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

/* ─── Hover neighbour highlighting ─────────────────────────────── */

const HoverHighlight = () => {
    const registerEvents = useRegisterEvents();
    const sigma = useSigma();
    const hoveredNodeRef = useRef<string | null>(null);

    useEffect(() => {
        registerEvents({
            enterNode: ({ node }) => {
                hoveredNodeRef.current = node;
                const graph = sigma.getGraph();

                // Dim all nodes and edges, highlight the hovered node + its neighbours
                const neighbours = new Set(graph.neighbors(node));
                neighbours.add(node);

                sigma.setSetting('nodeReducer', (_nodeId: string, data: Record<string, any>) => {
                    if (neighbours.has(_nodeId)) {
                        return { ...data, zIndex: 1 };
                    }
                    return { ...data, color: '#e0e0e0', label: '', zIndex: 0 };
                });

                sigma.setSetting('edgeReducer', (_edgeId: string, data: Record<string, any>) => {
                    const source = graph.source(_edgeId);
                    const target = graph.target(_edgeId);
                    if (neighbours.has(source) && neighbours.has(target)) {
                        return { ...data, color: '#333', size: 2 };
                    }
                    return { ...data, hidden: true };
                });
            },
            leaveNode: () => {
                hoveredNodeRef.current = null;
                // Reset reducers
                sigma.setSetting('nodeReducer', null);
                sigma.setSetting('edgeReducer', null);
            }
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

/* ─── Phase 3: Filter + Camera effect components ──────────────── */

interface FilterEffectProps {
    activeTypes: Set<string> | null;
    activeProjects: Set<string> | null;
}

/**
 * FilterEffect — Applies the right-panel filter state via Sigma's
 * nodeReducer. An empty set for any filter dimension means "nothing
 * selected", which visually dims all non-matching nodes to ~15% alpha.
 * `null` means "filter not configured; show everything".
 */
const FilterEffect = ({ activeTypes, activeProjects }: FilterEffectProps) => {
    const sigma = useSigma();

    useEffect(() => {
        sigma.setSetting('nodeReducer', (_nodeId: string, data: Record<string, any>) => {
            const t = data.tag as string;
            const c = data.clusterLabel as string;
            const dimType = activeTypes !== null && !activeTypes.has(t);
            const dimProj = activeProjects !== null && !activeProjects.has(c);
            if (dimType || dimProj) {
                return { ...data, color: '#cbd5e188', label: '', zIndex: 0 };
            }
            return data;
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
}

export default function SigmaCanvas({
    activeTypes = null,
    activeProjects = null,
    focusNodeId = null,
    onTopologyReady,
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
                    defaultDrawNodeLabel: drawLabel as any,
                    defaultDrawNodeHover: drawHover as any,
                }}
            >
                <GraphLoader onStatsReady={handleStatsReady} onTopologyReady={onTopologyReady} />
                <DragEvents />
                <HoverHighlight />
                <FilterEffect activeTypes={activeTypes} activeProjects={activeProjects} />
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
