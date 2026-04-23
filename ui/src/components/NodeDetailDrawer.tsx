/**
 * NodeDetailDrawer — Slides in from the right when the user clicks a
 * graph node. Shows the node's content + its immediate neighbors; the
 * "Ask about this" button fills the chat input with a [node:id] marker
 * the server expands into system-prompt context.
 */

import { useEffect, useRef, useState } from 'react';
import { X, MessageSquare, RefreshCw } from 'lucide-react';
import { authFetch } from '../lib/authFetch';

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
        language?: string | null;
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
    onReconnectNode: (nodeId: string) => void;
}

export default function NodeDetailDrawer({
    apiBase,
    selectedNodeId,
    onClose,
    onAskAbout,
    onReconnectNode,
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
        void authFetch(`${apiBase}/api/node?id=${encodeURIComponent(selectedNodeId)}`)
            .then(async (r) => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return r.json() as Promise<NodeDetail>;
            })
            .then((d) => { if (!cancelled) setDetail(d); })
            .catch((e: Error) => { if (!cancelled) setError(e.message); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [apiBase, selectedNodeId, isCore]);

    // V2.2: click-outside-to-close. Listen for mousedown on document;
    // if it lands outside the drawer's root element, close. Skip when
    // the click originated in the graph canvas (a node click will
    // immediately reopen for the new node) — but the simpler design is
    // to let the outside-click close, then the canvas handler re-opens
    // with the new ID on the same tick. React batches the two updates.
    const drawerRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        if (!selectedNodeId) return;
        const handler = (e: MouseEvent) => {
            const target = e.target as Node | null;
            if (!target) return;
            if (drawerRef.current && !drawerRef.current.contains(target)) {
                onClose();
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [selectedNodeId, onClose]);

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
        <div className="node-drawer glass-panel" ref={drawerRef}>
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
                        {displayDetail.node.language ? (
                            <span className="language-badge" title="Language detected or tagged at ingest">
                                {displayDetail.node.language.toUpperCase()}
                            </span>
                        ) : null}
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

                    <div className="node-drawer-actions">
                        <button
                            className="node-drawer-ask"
                            onClick={() => onAskAbout(displayDetail.node.id)}
                            title="Pre-fill the chat with this node attached so the LLM answers in context"
                        >
                            <MessageSquare size={14} />
                            Ask about this
                        </button>
                        {/* Recalibrate is scoped to core LoreNodes. The server path
                            (/api/chat/action reconnect_node → reconnectOneNode) only
                            understands the core LoreNode table; plugin-owned nodes
                            (file:, symbol:) would 404. Hide the button for those
                            until a per-plugin recalibrate hook exists. */}
                        {isCore ? (
                            <button
                                className="node-drawer-reconnect"
                                onClick={() => onReconnectNode(displayDetail.node.id)}
                                title="Re-compute semantic edges for this node against the latest graph state — useful when a node looks orphaned or out of date"
                            >
                                <RefreshCw size={14} />
                                Recalibrate
                            </button>
                        ) : null}
                    </div>
                </div>
            ) : null}
        </div>
    );
}
