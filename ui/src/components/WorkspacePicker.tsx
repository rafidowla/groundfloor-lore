/**
 * WorkspacePicker — Slack-style workspace chip + dropdown for Lore V2.1.
 *
 * Each workspace = an independent Kùzu graph + LanceDB store + plugin
 * config. Picking a different workspace triggers a daemon restart under
 * launchd KeepAlive; the UI polls /api/health until the new workspace is
 * live, then reloads.
 */

import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Plus, Trash2 } from 'lucide-react';

interface WorkspaceEntry {
    name: string;
    path: string;
    createdAt: string;
}

interface WorkspacesResponse {
    active: string;
    workspaces: WorkspaceEntry[];
}

interface WorkspacePickerProps {
    apiBase: string;
    onSwitchStarted: (nextName: string) => void;
}

export default function WorkspacePicker({ apiBase, onSwitchStarted }: WorkspacePickerProps): React.ReactElement {
    const [state, setState] = useState<WorkspacesResponse | null>(null);
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const ref = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        void fetch(`${apiBase}/api/workspaces`)
            .then((r) => r.json() as Promise<WorkspacesResponse>)
            .then(setState)
            .catch(() => setState(null));
    }, [apiBase]);

    // Close on outside click.
    useEffect(() => {
        const onDoc = (e: MouseEvent): void => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener('mousedown', onDoc);
        return () => document.removeEventListener('mousedown', onDoc);
    }, []);

    const refresh = async (): Promise<void> => {
        const next = (await fetch(`${apiBase}/api/workspaces`).then((r) => r.json())) as WorkspacesResponse;
        setState(next);
    };

    const handleSwitch = async (name: string): Promise<void> => {
        if (!state || name === state.active) {
            setOpen(false);
            return;
        }
        setBusy(true);
        onSwitchStarted(name);
        try {
            await fetch(`${apiBase}/api/workspaces/switch`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name }),
            });
        } finally {
            setBusy(false);
            setOpen(false);
        }
    };

    const handleCreate = async (): Promise<void> => {
        const raw = window.prompt('Name the new workspace (letters, digits, dashes; 1–40 chars):');
        if (!raw) return;
        try {
            const resp = await fetch(`${apiBase}/api/workspaces`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: raw }),
            });
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
                window.alert(`Create failed: ${err.error ?? 'unknown'}`);
                return;
            }
            await refresh();
        } catch (err) {
            window.alert(`Create failed: ${(err as Error).message}`);
        }
    };

    const handleDelete = async (name: string): Promise<void> => {
        if (!window.confirm(`Remove workspace "${name}" from the registry? On-disk data is NOT deleted.`)) return;
        try {
            const resp = await fetch(`${apiBase}/api/workspaces/${encodeURIComponent(name)}`, { method: 'DELETE' });
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
                window.alert(`Delete failed: ${err.error ?? 'unknown'}`);
                return;
            }
            await refresh();
        } catch (err) {
            window.alert(`Delete failed: ${(err as Error).message}`);
        }
    };

    if (!state) {
        return <div className="workspace-chip loading">…</div>;
    }

    return (
        <div className="workspace-chip-wrapper" ref={ref}>
            <button
                className="workspace-chip"
                onClick={() => setOpen((v) => !v)}
                disabled={busy}
                title="Switch workspace"
            >
                <span className="workspace-dot" />
                <span className="workspace-name">{state.active}</span>
                <ChevronDown size={14} />
            </button>

            {open ? (
                <div className="workspace-menu glass-panel">
                    <div className="workspace-menu-header">Workspaces</div>
                    {state.workspaces.map((w) => (
                        <div
                            key={w.name}
                            className={`workspace-menu-item${w.name === state.active ? ' active' : ''}`}
                            onClick={() => void handleSwitch(w.name)}
                        >
                            <span className={`workspace-dot ${w.name === state.active ? 'on' : ''}`} />
                            <span className="workspace-name">{w.name}</span>
                            {w.name !== 'default' && w.name !== state.active ? (
                                <button
                                    className="workspace-delete"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        void handleDelete(w.name);
                                    }}
                                    title="Remove from registry"
                                >
                                    <Trash2 size={12} />
                                </button>
                            ) : null}
                        </div>
                    ))}
                    <div className="workspace-menu-divider" />
                    <div className="workspace-menu-item action" onClick={() => void handleCreate()}>
                        <Plus size={14} />
                        <span>Create new workspace</span>
                    </div>
                </div>
            ) : null}
        </div>
    );
}
