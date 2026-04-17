import { useEffect, useRef, useState } from 'react';
import { Network } from 'vis-network';
import { DataSet } from 'vis-data';

interface LoreNode {
    id: string;
    type: string;
    label: string;
    project?: string;
    content?: string;
    updatedAt?: string;
}

interface LoreEdge {
    from: string;
    to: string;
    label: string;
}

interface GraphData {
    nodes: LoreNode[];
    edges: LoreEdge[];
}

const COLORS: Record<string, string> = {
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

export default function GraphCanvas() {
    const containerRef = useRef<HTMLDivElement>(null);
    const networkRef = useRef<Network | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let active = true;

        const loadTopology = async () => {
            try {
                // The Vite proxy handles /api -> http://127.0.0.1:3847
                const response = await fetch('/api/topology');
                if (!response.ok) {
                    throw new Error(`Failed to fetch topology: ${response.statusText}`);
                }
                const data: GraphData = await response.json();
                
                if (active) {
                    renderGraph(data.nodes || [], data.edges || []);
                    setLoading(false);
                }
            } catch (err) {
                if (active) {
                    setError((err as Error).message);
                    setLoading(false);
                }
            }
        };

        const renderGraph = (rawNodes: LoreNode[], rawEdges: LoreEdge[]) => {
            if (!containerRef.current) return;

            // Map backend nodes to vis-network visual nodes
            const visNodes = rawNodes.map((n) => ({
                id: n.id,
                label: n.type === 'schema' ? (n.label || n.id).toUpperCase() : n.label || n.id,
                color: {
                    background: COLORS[n.type] || COLORS['default'],
                    border: '#2D3748',
                    highlight: { background: COLORS[n.type] || COLORS['default'], border: '#ffffff' }
                },
                font: { 
                    color: '#ffffff', 
                    face: 'Inter, -apple-system, system-ui', 
                    size: 14, 
                    strokeWidth: n.type === 'schema' ? 0 : 5, 
                    strokeColor: '#0f1115', 
                    multi: true 
                },
                shape: n.type === 'schema' ? 'box' : 'dot',
                size: n.type === 'schema' ? undefined : 18,
                title: `Type: ${n.type}\nID: ${n.id}\nProject: ${n.project || 'Global'}`
            }));

            // Map backend edges
            const visEdges = rawEdges.map((e) => ({
                from: e.from, 
                to: e.to, 
                label: e.label,
                font: { color: '#cbd5e1', size: 11, face: 'Inter', align: 'middle', background: '#16181d', strokeWidth: 0 },
                color: { color: '#4A5568', opacity: 0.6, highlight: '#718096' },
                arrows: 'to', 
                length: 250
            }));

            // --- USER ADOPTED IMPROVEMENT: Project Hub Anchoring ---
            // Reconstructs the highly structured global layout physics from explore.html
            const uniqueProjects = new Set(rawNodes.map(n => n.project || 'Global'));
            const projectAnchors: any[] = [];
            const anchorEdges: any[] = [];

            if (uniqueProjects.size > 1 || (uniqueProjects.size === 1 && !uniqueProjects.has('Global'))) {
                projectAnchors.push({ 
                    id: 'GLOBAL_HUB', 
                    shape: 'dot', 
                    size: 0, 
                    color: { background: 'transparent', border: 'transparent' }, 
                    x: 0, 
                    y: 0, 
                    fixed: true, 
                    mass: 1 
                });

                Array.from(uniqueProjects).forEach((proj) => {
                    projectAnchors.push({ 
                        id: `PROJECT_ANCHOR_${proj}`, 
                        label: proj.toUpperCase(), 
                        font: { color: '#334155', size: 36, face: 'Inter', strokeWidth: 0, bold: true }, 
                        shape: 'text', 
                        fixed: false, 
                        mass: 2 
                    });
                    anchorEdges.push({ 
                        from: `PROJECT_ANCHOR_${proj}`, 
                        to: 'GLOBAL_HUB', 
                        color: { opacity: 0 }, 
                        length: 550, 
                        physics: true 
                    });
                });

                rawNodes.forEach((n) => {
                    anchorEdges.push({ 
                        from: n.id, 
                        to: `PROJECT_ANCHOR_${n.project || 'Global'}`, 
                        color: { opacity: 0 }, 
                        length: 50, 
                        physics: true 
                    });
                });
            }

            const nodesDataSet = new DataSet([...visNodes, ...projectAnchors]);
            const edgesDataSet = new DataSet([...visEdges, ...anchorEdges]);

            // --- USER ADOPTED IMPROVEMENT: Optimized BarnesHut Physics ---
            const options = {
                physics: { 
                    solver: 'barnesHut', 
                    barnesHut: { 
                        gravitationalConstant: -1500, 
                        centralGravity: 0.0, 
                        springLength: 100, 
                        springConstant: 0.05, 
                        damping: 0.09, 
                        avoidOverlap: 0.2 
                    }, 
                    stabilization: { iterations: 150 } 
                },
                nodes: { shadow: { enabled: true, color: 'rgba(0,0,0,0.5)', size: 10 } },
                edges: { smooth: { enabled: true, type: 'continuous', roundness: 0.5 } },
                interaction: { hover: true, tooltipDelay: 200 }
            };

            if (networkRef.current) {
                networkRef.current.destroy();
            }

            networkRef.current = new Network(containerRef.current, { nodes: nodesDataSet, edges: edgesDataSet }, options);

            // Turn off physics after stabilization to save CPU
            networkRef.current.on('stabilizationIterationsDone', () => {
                networkRef.current?.setOptions({ physics: { enabled: false } });
            });
        };

        loadTopology();

        return () => {
            active = false;
            if (networkRef.current) {
                networkRef.current.destroy();
                networkRef.current = null;
            }
        };
    }, []);

    // Full container styles
    return (
        <div style={{ position: 'relative', width: '100%', height: '100%', outline: 'none' }}>
            {loading && (
                <div style={{
                    position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
                    background: 'rgba(0,0,0,0.8)', padding: '10px 20px', borderRadius: '20px',
                    color: 'var(--color-text-muted)', fontSize: '0.95rem', zIndex: 100
                }}>
                    Connecting to Local Engine...
                </div>
            )}
            
            {error && (
                <div style={{
                    position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
                    background: 'rgba(255, 0, 0, 0.2)', border: '1px solid #E53E3E', padding: '10px 20px', borderRadius: '20px',
                    color: '#FFF', fontSize: '0.95rem', zIndex: 100
                }}>
                    Failed to Load: {error}
                </div>
            )}

            <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'absolute', top: 0, left: 0 }} />
        </div>
    );
}
