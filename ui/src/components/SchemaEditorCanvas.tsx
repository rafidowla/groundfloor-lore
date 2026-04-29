/**
 * SchemaEditorCanvas.tsx — Boxes-and-arrows visual editor for a Tier 1
 * plugin's node-type and edge-relation schema.
 *
 * Pairs with `PluginWizard.tsx`'s Step 2: the user can switch between
 * the form-based field mapping editor (existing) and this canvas
 * (new) via a toggle.
 *
 * What the canvas does:
 *   - Renders each declared node type as a draggable rounded box.
 *   - Renders each declared edge relation as a labelled arrow.
 *   - "+ Node type" button adds a new node-type box (empty / unmapped).
 *     CSV-mapped node types stay editable too.
 *   - Drag from a box's right handle to another box's left handle to
 *     declare an edge relation. A small modal asks for the relation
 *     name + description.
 *   - Click a node-type box → side panel to rename, edit description,
 *     or delete (delete prevented if it's the CSV-mapped node type).
 *   - Click an edge → side panel to rename, edit description, or delete.
 *
 * Substrate: reactflow 11.x. Node positions persist in the wizard's
 * state so a back-and-forward through steps doesn't reset the layout.
 */

import { useCallback, useMemo, useState } from 'react';
import ReactFlow, {
    Background,
    Controls,
    MiniMap,
    addEdge,
    type Connection,
    type Edge,
    type Node,
    type NodeChange,
    type EdgeChange,
    applyNodeChanges,
    applyEdgeChanges,
    Handle,
    Position,
    MarkerType,
} from 'reactflow';
import 'reactflow/dist/style.css';

export interface SchemaNodeType {
    name: string;
    description: string;
    /** True if this node type is bound to the wizard's CSV import. The
     *  user can edit its description but not delete it. */
    isCsvAnchor?: boolean;
}

export interface SchemaEdgeRelation {
    name: string;
    description: string;
    fromType: string;
    toType: string;
}

export interface CanvasState {
    nodeTypes: SchemaNodeType[];
    edges: SchemaEdgeRelation[];
    /** Per-node positions, keyed by node-type name. Persists through
     *  step navigation so the layout doesn't reset. */
    positions: Record<string, { x: number; y: number }>;
}

interface SchemaEditorCanvasProps {
    state: CanvasState;
    onChange: (next: CanvasState) => void;
}

export default function SchemaEditorCanvas({ state, onChange }: SchemaEditorCanvasProps) {
    const [selectedNode, setSelectedNode] = useState<string | null>(null);
    const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
    const [pendingEdge, setPendingEdge] = useState<{ from: string; to: string } | null>(null);

    // ── Map wizard schema state into reactflow's node/edge types ──
    const rfNodes: Node[] = useMemo(() => {
        return state.nodeTypes.map((nt, i) => ({
            id: nt.name,
            type: 'nodeType',
            position: state.positions[nt.name] ?? { x: 80 + (i % 3) * 240, y: 80 + Math.floor(i / 3) * 160 },
            data: { name: nt.name, description: nt.description, isCsvAnchor: nt.isCsvAnchor },
        }));
    }, [state.nodeTypes, state.positions]);

    const rfEdges: Edge[] = useMemo(() => {
        return state.edges.map((er, i) => ({
            id: `e${i}-${er.name}`,
            source: er.fromType,
            target: er.toType,
            label: er.name,
            type: 'smoothstep',
            markerEnd: { type: MarkerType.ArrowClosed, color: '#888' },
            labelStyle: { fontSize: 11, fontWeight: 600 },
            labelBgStyle: { fill: 'var(--color-surface, #1a1a1a)', fillOpacity: 0.9 },
            labelBgPadding: [4, 6],
            style: { stroke: '#888', strokeWidth: 1.5 },
        }));
    }, [state.edges]);

    // ── Position changes (drag) ─────────────────────────────────
    const handleNodesChange = useCallback((changes: NodeChange[]) => {
        const next = applyNodeChanges(changes, rfNodes);
        const nextPositions = { ...state.positions };
        for (const n of next) nextPositions[n.id] = n.position;
        onChange({ ...state, positions: nextPositions });
    }, [rfNodes, state, onChange]);

    // Dummy edges-change handler (selection only); real edits via panels.
    const handleEdgesChange = useCallback((changes: EdgeChange[]) => {
        applyEdgeChanges(changes, rfEdges);
    }, [rfEdges]);

    // ── New edge drawn ──────────────────────────────────────────
    const handleConnect = useCallback((conn: Connection) => {
        if (!conn.source || !conn.target) return;
        if (conn.source === conn.target) return; // self-edges TBD
        setPendingEdge({ from: conn.source, to: conn.target });
        // Don't add to state until the modal's confirmed (for the name/description).
        addEdge(conn, rfEdges); // suppress unused-import in strict bundlers
    }, [rfEdges]);

    // ── Add node type ───────────────────────────────────────────
    const addNodeType = useCallback(() => {
        let i = 1;
        while (state.nodeTypes.some((n) => n.name === `new_type_${i}`)) i += 1;
        const name = `new_type_${i}`;
        onChange({
            ...state,
            nodeTypes: [...state.nodeTypes, { name, description: 'A new node type.' }],
            positions: { ...state.positions, [name]: { x: 80 + state.nodeTypes.length * 60, y: 280 } },
        });
        setSelectedNode(name);
    }, [state, onChange]);

    return (
        <div style={{ height: 520, position: 'relative', display: 'flex', gap: 0 }}>
            <div style={{ flex: 1, position: 'relative', border: '1px solid var(--color-border, #444)', borderRadius: 4 }}>
                <ReactFlow
                    nodes={rfNodes}
                    edges={rfEdges}
                    nodeTypes={NODE_RENDERERS}
                    onNodesChange={handleNodesChange}
                    onEdgesChange={handleEdgesChange}
                    onConnect={handleConnect}
                    onNodeClick={(_, n) => { setSelectedNode(n.id); setSelectedEdge(null); }}
                    onEdgeClick={(_, e) => { setSelectedEdge(e.id); setSelectedNode(null); }}
                    onPaneClick={() => { setSelectedNode(null); setSelectedEdge(null); }}
                    fitView
                >
                    <Background gap={16} color="#333" />
                    <Controls />
                    <MiniMap pannable zoomable nodeColor="#4a90e2" maskColor="rgba(0,0,0,0.5)" />
                </ReactFlow>
                <div style={{ position: 'absolute', top: 8, left: 8, display: 'flex', gap: 6 }}>
                    <button onClick={addNodeType} style={miniBtn}>+ Node type</button>
                </div>
                <div style={{ position: 'absolute', bottom: 8, left: 8, fontSize: 11, color: 'var(--color-text-muted, #888)', maxWidth: 260, lineHeight: 1.4 }}>
                    Drag from one box's right edge to another box's left edge to create an edge relation. Click a box or arrow to edit it.
                </div>
            </div>

            <SidePanel
                state={state}
                onChange={onChange}
                selectedNode={selectedNode}
                selectedEdge={selectedEdge}
                onCloseSelection={() => { setSelectedNode(null); setSelectedEdge(null); }}
            />

            {pendingEdge && (
                <NewEdgeModal
                    pending={pendingEdge}
                    onCancel={() => setPendingEdge(null)}
                    onConfirm={(name, description) => {
                        // Reject duplicate edge names within this manifest.
                        if (state.edges.some((e) => e.name === name)) {
                            alert(`Edge relation "${name}" already exists. Pick a different name.`);
                            return;
                        }
                        onChange({
                            ...state,
                            edges: [...state.edges, { name, description, fromType: pendingEdge.from, toType: pendingEdge.to }],
                        });
                        setPendingEdge(null);
                    }}
                />
            )}
        </div>
    );
}

// ────────────────────────────────────────────────────────────────────────
// Node renderer — a rounded box with the type name + description preview.
// ────────────────────────────────────────────────────────────────────────

interface NodeRendererProps {
    data: { name: string; description: string; isCsvAnchor?: boolean };
}

function NodeTypeBox({ data }: NodeRendererProps) {
    return (
        <div style={{
            background: 'var(--color-surface-alt, #2a2a2a)',
            border: data.isCsvAnchor ? '2px solid #4a90e2' : '1px solid var(--color-border, #444)',
            borderRadius: 8,
            padding: '10px 14px',
            minWidth: 180,
            color: 'var(--color-text, #e5e5e5)',
            fontSize: 13,
            cursor: 'pointer',
        }}>
            <Handle type="target" position={Position.Left} style={{ background: '#888' }} />
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
                {data.name}
                {data.isCsvAnchor && <span style={{ marginLeft: 6, fontSize: 10, padding: '1px 6px', borderRadius: 3, background: '#4a90e2', color: 'white' }}>CSV</span>}
            </div>
            <div style={{ fontSize: 11, color: 'var(--color-text-muted, #888)', maxWidth: 200, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {data.description}
            </div>
            <Handle type="source" position={Position.Right} style={{ background: '#888' }} />
        </div>
    );
}

const NODE_RENDERERS = { nodeType: NodeTypeBox } as const;

// ────────────────────────────────────────────────────────────────────────
// Right-hand side panel (edits the selected node or edge)
// ────────────────────────────────────────────────────────────────────────

function SidePanel({
    state, onChange, selectedNode, selectedEdge, onCloseSelection,
}: {
    state: CanvasState;
    onChange: (next: CanvasState) => void;
    selectedNode: string | null;
    selectedEdge: string | null;
    onCloseSelection: () => void;
}) {
    if (!selectedNode && !selectedEdge) {
        return (
            <div style={panelEmpty}>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>Schema</div>
                <div style={{ fontSize: 12, color: 'var(--color-text-muted, #888)' }}>
                    {state.nodeTypes.length} node types, {state.edges.length} edge relations.
                </div>
                <div style={{ fontSize: 11, color: 'var(--color-text-muted, #888)', marginTop: 12 }}>
                    Click a box or arrow to edit it. Use the + Node type button to add another type.
                </div>
            </div>
        );
    }

    if (selectedNode) {
        const nt = state.nodeTypes.find((n) => n.name === selectedNode);
        if (!nt) return null;
        return (
            <div style={panel}>
                <PanelHeader title="Edit node type" onClose={onCloseSelection} />
                <Field label="Name (lowercase_with_underscores)">
                    <input
                        type="text"
                        value={nt.name}
                        disabled={nt.isCsvAnchor}
                        onChange={(e) => {
                            const newName = e.target.value;
                            // Rename across nodes + edges + positions.
                            onChange({
                                ...state,
                                nodeTypes: state.nodeTypes.map((n) =>
                                    n.name === nt.name ? { ...n, name: newName } : n,
                                ),
                                edges: state.edges.map((e2) => ({
                                    ...e2,
                                    fromType: e2.fromType === nt.name ? newName : e2.fromType,
                                    toType: e2.toType === nt.name ? newName : e2.toType,
                                })),
                                positions: renameKey(state.positions, nt.name, newName),
                            });
                        }}
                        style={inputCanvas}
                    />
                    {nt.isCsvAnchor && (
                        <div style={{ fontSize: 10, color: 'var(--color-text-muted, #888)', marginTop: 4 }}>
                            Locked — this is the CSV-anchored node type. Rename it in the form view's "Node type name" field.
                        </div>
                    )}
                </Field>
                <Field label="Description">
                    <textarea
                        value={nt.description}
                        onChange={(e) => onChange({
                            ...state,
                            nodeTypes: state.nodeTypes.map((n) =>
                                n.name === nt.name ? { ...n, description: e.target.value } : n,
                            ),
                        })}
                        rows={3}
                        style={inputCanvas}
                    />
                </Field>
                {!nt.isCsvAnchor && (
                    <button
                        style={btnDanger}
                        onClick={() => {
                            if (state.edges.some((e2) => e2.fromType === nt.name || e2.toType === nt.name)) {
                                alert(`Cannot delete "${nt.name}" — there are edge relations referencing it. Delete the edges first.`);
                                return;
                            }
                            onChange({
                                ...state,
                                nodeTypes: state.nodeTypes.filter((n) => n.name !== nt.name),
                                positions: omitKey(state.positions, nt.name),
                            });
                            onCloseSelection();
                        }}
                    >Delete</button>
                )}
            </div>
        );
    }

    // selectedEdge — find the edge by its synthesised id ("e<index>-<name>")
    const edgeIndex = Number(selectedEdge!.split('-')[0]?.slice(1) ?? -1);
    const er = state.edges[edgeIndex];
    if (!er) return null;
    return (
        <div style={panel}>
            <PanelHeader title="Edit edge relation" onClose={onCloseSelection} />
            <div style={{ fontSize: 12, marginBottom: 10 }}>
                <span style={{ color: 'var(--color-text-muted, #888)' }}>From → To: </span>
                <code>{er.fromType}</code> → <code>{er.toType}</code>
            </div>
            <Field label="Relation name">
                <input
                    type="text"
                    value={er.name}
                    onChange={(e) => onChange({
                        ...state,
                        edges: state.edges.map((x, i) => i === edgeIndex ? { ...x, name: e.target.value } : x),
                    })}
                    style={inputCanvas}
                />
            </Field>
            <Field label="Description">
                <textarea
                    value={er.description}
                    onChange={(e) => onChange({
                        ...state,
                        edges: state.edges.map((x, i) => i === edgeIndex ? { ...x, description: e.target.value } : x),
                    })}
                    rows={3}
                    style={inputCanvas}
                />
            </Field>
            <button
                style={btnDanger}
                onClick={() => {
                    onChange({ ...state, edges: state.edges.filter((_, i) => i !== edgeIndex) });
                    onCloseSelection();
                }}
            >Delete</button>
        </div>
    );
}

function PanelHeader({ title, onClose }: { title: string; onClose: () => void }) {
    return (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ fontWeight: 600 }}>{title}</div>
            <button onClick={onClose} style={miniBtn}>×</button>
        </div>
    );
}

// ────────────────────────────────────────────────────────────────────────
// New edge modal
// ────────────────────────────────────────────────────────────────────────

function NewEdgeModal({
    pending, onCancel, onConfirm,
}: { pending: { from: string; to: string }; onCancel: () => void; onConfirm: (name: string, description: string) => void }) {
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const valid = /^[a-z][a-z0-9_]*$/.test(name);
    return (
        <div style={modalBackdrop}>
            <div style={modalBox}>
                <h3 style={{ margin: '0 0 10px 0' }}>New edge relation</h3>
                <div style={{ fontSize: 12, color: 'var(--color-text-muted, #888)', marginBottom: 12 }}>
                    <code>{pending.from}</code> → <code>{pending.to}</code>
                </div>
                <Field label="Relation name (lowercase_with_underscores)">
                    <input
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="has_role"
                        style={inputCanvas}
                        autoFocus
                    />
                </Field>
                <Field label="Description">
                    <input
                        type="text"
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        placeholder="Connects an employee to a role they hold."
                        style={inputCanvas}
                    />
                </Field>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    <button onClick={onCancel} style={miniBtn}>Cancel</button>
                    <button
                        onClick={() => onConfirm(name, description)}
                        disabled={!valid || !description}
                        style={{ ...miniBtn, background: '#4a90e2', color: 'white', borderColor: '#4a90e2' }}
                    >Create</button>
                </div>
            </div>
        </div>
    );
}

// ────────────────────────────────────────────────────────────────────────
// helpers + tiny styles
// ────────────────────────────────────────────────────────────────────────

function renameKey<T>(obj: Record<string, T>, oldKey: string, newKey: string): Record<string, T> {
    if (oldKey === newKey || !(oldKey in obj)) return obj;
    const out: Record<string, T> = {};
    for (const [k, v] of Object.entries(obj)) {
        out[k === oldKey ? newKey : k] = v;
    }
    return out;
}

function omitKey<T>(obj: Record<string, T>, key: string): Record<string, T> {
    const out: Record<string, T> = {};
    for (const [k, v] of Object.entries(obj)) {
        if (k !== key) out[k] = v;
    }
    return out;
}

const panel: React.CSSProperties = {
    width: 280,
    marginLeft: 12,
    padding: 14,
    background: 'var(--color-surface-alt, #2a2a2a)',
    border: '1px solid var(--color-border, #444)',
    borderRadius: 4,
    overflow: 'auto',
};
const panelEmpty: React.CSSProperties = { ...panel, display: 'flex', flexDirection: 'column', alignItems: 'flex-start' };

const miniBtn: React.CSSProperties = {
    padding: '4px 10px',
    background: 'var(--color-surface-alt, #2a2a2a)',
    color: 'var(--color-text, #e5e5e5)',
    border: '1px solid var(--color-border, #444)',
    borderRadius: 3,
    cursor: 'pointer',
    fontSize: 12,
};

const btnDanger: React.CSSProperties = {
    padding: '6px 12px',
    background: 'rgba(248,113,113,0.15)',
    color: '#fca5a5',
    border: '1px solid #f87171',
    borderRadius: 3,
    cursor: 'pointer',
    fontSize: 12,
    marginTop: 8,
};

const inputCanvas: React.CSSProperties = {
    display: 'block', width: '100%', padding: '6px 8px',
    background: 'var(--color-surface, #1a1a1a)', color: 'var(--color-text, #e5e5e5)',
    border: '1px solid var(--color-border, #444)', borderRadius: 4, fontSize: 12,
    fontFamily: 'inherit', boxSizing: 'border-box',
};

const modalBackdrop: React.CSSProperties = {
    position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5,
};
const modalBox: React.CSSProperties = {
    background: 'var(--color-surface, #1a1a1a)',
    color: 'var(--color-text, #e5e5e5)',
    border: '1px solid var(--color-border, #444)',
    borderRadius: 6,
    padding: 20,
    width: 360,
    boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 500, marginBottom: 4 }}>{label}</label>
            {children}
        </div>
    );
}
