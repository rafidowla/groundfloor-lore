/**
 * NodeDetailDrawer — Slides in from the right when the user clicks a
 * graph node. Shows the node's content + its immediate neighbors; the
 * "Ask about this" button fills the chat input with a [node:id] marker
 * the server expands into system-prompt context.
 */

import { useEffect, useState } from 'react';
import { X, MessageSquare } from 'lucide-react';

interface NodeDetail {
    node: {
        id: string;
        label: string;
        type: string;
        content?: string;
        tags?: string;
        project?: string;
        ecosystem?: string;
        updatedAt?: string;
    };
    neighbors: Array<{
        id: string;
        label: string;
        type: string;
        relation: string;
        depth: number;
    }>;
}

interface NodeDetailDrawerProps {
    apiBase: string;
    selectedNodeId: string | null;
    onClose: () => void;
    onAskAbout: (nodeId: string) => void;
}

export default function NodeDetailDrawer({
    apiBase,
    selectedNodeId,
    onClose,
    onAskAbout,
}: NodeDetailDrawerProps) {
    // Core nodes are the lore: prefix or unprefixed. Plugin-owned nodes
    // (file:, symbol:) don't have a GET /api/node endpoint yet.
    const isCore =
        selectedNodeId !== null &&
        (selectedNodeId.startsWith('lore:') || !selectedNodeId.includes(':'));

    // Parent keys this drawer on selectedNodeId, so every new selection
    // mounts a fresh instance — useState initializers run once and fire
    // with the correct starting values. `loading` starts true for core
    // nodes (we're about to fetch); stays false for plugin placeholders.
    const [detail, setDetail] = useState<NodeDetail | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState<boolean>(() => isCore);

    useEffect(() => {
        if (!selectedNodeId || !isCore) return;
        let cancelled = false;
        void fetch(`${apiBase}/api/node?id=${encodeURIComponent(selectedNodeId)}`)
            .then(async (r) => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return r.json() as Promise<NodeDetail>;
            })
            .then((d) => { if (!cancelled) setDetail(d); })
            .catch((e: Error) => { if (!cancelled) setError(e.message); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [apiBase, selectedNodeId, isCore]);

    if (!selectedNodeId) return null;

    // Plugin-owned placeholder is pure derivation from selectedNodeId;
    // compute at render time, not via setState-in-effect.
    const displayDetail: NodeDetail | null = isCore
        ? detail
        : {
            node: {
                id: selectedNodeId,
                label: selectedNodeId.split(':').slice(1).join(':'),
                type: selectedNodeId.split(':')[0],
                content: '(Plugin-owned node — detail endpoint not yet implemented for this kind.)',
            },
            neighbors: [],
        };

    return (
        <div className="node-drawer glass-panel">
            <header className="node-drawer-header">
                <div className="node-drawer-title">
                    {displayDetail ? (
                        <>
                            <span className={`node-type-badge type-${displayDetail.node.type}`}>
                                {displayDetail.node.type}
                            </span>
                            <h3>{displayDetail.node.label}</h3>
                        </>
                    ) : (
                        <h3>{loading ? 'Loading…' : selectedNodeId}</h3>
                    )}
                </div>
                <button className="icon-button" onClick={onClose} title="Close">
                    <X size={18} />
                </button>
            </header>

            {error ? (
                <div className="node-drawer-error">Failed to load: {error}</div>
            ) : displayDetail ? (
                <div className="node-drawer-body">
                    <div className="node-drawer-meta">
                        <code>{displayDetail.node.id}</code>
                        {displayDetail.node.project ? <span>project: {displayDetail.node.project}</span> : null}
                        {displayDetail.node.tags ? <span>tags: {displayDetail.node.tags}</span> : null}
                    </div>

                    {displayDetail.node.content ? (
                        <section>
                            <h4>Content</h4>
                            <p className="node-drawer-content">{displayDetail.node.content}</p>
                        </section>
                    ) : null}

                    {displayDetail.neighbors.length > 0 ? (
                        <section>
                            <h4>Connected to ({displayDetail.neighbors.length})</h4>
                            <ul className="node-drawer-neighbors">
                                {displayDetail.neighbors.map((n) => (
                                    <li key={n.id + n.relation}>
                                        <span className="rel-label">{n.relation}</span>
                                        <span className="neighbor-type">{n.type}</span>
                                        <span className="neighbor-label">{n.label}</span>
                                    </li>
                                ))}
                            </ul>
                        </section>
                    ) : (
                        <section>
                            <h4>Connected to</h4>
                            <p className="help-text">
                                No edges yet. Run <code>lore reconsume</code> to lay
                                semantic links to similar nodes.
                            </p>
                        </section>
                    )}

                    <button
                        className="node-drawer-ask"
                        onClick={() => onAskAbout(displayDetail.node.id)}
                        title="Pre-fill the chat with [node:id] so the LLM answers in context"
                    >
                        <MessageSquare size={14} />
                        Ask about this in chat
                    </button>
                </div>
            ) : null}
        </div>
    );
}
