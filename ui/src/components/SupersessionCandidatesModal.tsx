/**
 * SupersessionCandidatesModal — surfaces likely supersession pairs
 * detected by similarity. Each pair shows old vs new side-by-side with
 * a confidence score; the user accepts pairs individually OR uses the
 * "Accept all above N" button to bulk-mark high-confidence matches.
 *
 * Backed by GET /api/node/supersession-candidates (scan) and POST
 * /api/node/supersede (apply). Each accept hits supersede individually
 * so the user can review the audit trail entry by entry.
 */

import { useEffect, useState } from 'react';
import { X, Check, RefreshCw } from 'lucide-react';
import { authFetch } from '../lib/authFetch';

interface CandidatePair {
    oldId: string;
    oldLabel: string;
    oldContent: string;
    oldCreatedAt: string;
    newId: string;
    newLabel: string;
    newContent: string;
    newCreatedAt: string;
    score: number;
    project: string;
}

interface CandidatesResponse {
    scope: { project: string | null; minScore: number; types: string[] };
    candidatesScanned: number;
    pairs: CandidatePair[];
}

interface ProjectOption { project: string; nodeCount: number }

interface Props {
    apiBase: string;
    /** Default project to scan. When null, the user picks from a dropdown.
     *  The scan is embed-heavy (30-60s on ~150 nodes), so we never
     *  auto-fire against the entire workspace. */
    project?: string | null;
    /** Workspace project list (label + node count) for the picker. */
    projectOptions?: ProjectOption[] | null;
    onClose: () => void;
    /** Fired after the user accepts at least one pair so the parent
     *  can refresh the topology + recall. */
    onAcceptedAny?: () => void;
}

export default function SupersessionCandidatesModal({ apiBase, project, projectOptions, onClose, onAcceptedAny }: Props) {
    // Active scope: defaults to the drilled project, otherwise null until
    // the user picks one from the dropdown.
    const [scope, setScope] = useState<string | null>(project ?? null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [resp, setResp] = useState<CandidatesResponse | null>(null);
    const [threshold, setThreshold] = useState<number>(0.85);
    const [accepted, setAccepted] = useState<Set<string>>(new Set()); // pair keys
    const [busy, setBusy] = useState<Set<string>>(new Set());
    const [bulkBusy, setBulkBusy] = useState(false);

    const pairKey = (p: CandidatePair) => `${p.oldId}||${p.newId}`;

    const refresh = async (fresh: boolean = false) => {
        if (!scope) {
            setError('Pick a project to scan first.');
            return;
        }
        setLoading(true);
        setError(null);
        try {
            const params = new URLSearchParams();
            params.set('project', scope);
            params.set('minScore', '0.7'); // server scans wider; UI threshold filters
            if (fresh) params.set('fresh', 'true');
            const r = await authFetch(`${apiBase}/api/node/supersession-candidates?${params.toString()}`);
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const d = await r.json() as CandidatesResponse;
            setResp(d);
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setLoading(false);
        }
    };

    // Auto-scan only when we have a project. Empty-scope just shows the picker.
    useEffect(() => {
        if (scope) void refresh();
        /* eslint-disable-next-line react-hooks/exhaustive-deps */
    }, [apiBase, scope]);

    const acceptOne = async (pair: CandidatePair, reason?: string) => {
        const key = pairKey(pair);
        setBusy((prev) => new Set(prev).add(key));
        try {
            const r = await authFetch(`${apiBase}/api/node/supersede`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    oldId: pair.oldId,
                    newId: pair.newId,
                    reason: reason ?? `auto-detected duplicate (similarity ${pair.score.toFixed(3)})`,
                }),
            });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            setAccepted((prev) => new Set(prev).add(key));
            onAcceptedAny?.();
        } catch (e) {
            setError(`Failed to supersede ${pair.oldId}: ${(e as Error).message}`);
        } finally {
            setBusy((prev) => {
                const next = new Set(prev);
                next.delete(key);
                return next;
            });
        }
    };

    const acceptAllAbove = async (minScore: number) => {
        if (!resp) return;
        const eligible = resp.pairs.filter((p) => p.score >= minScore && !accepted.has(pairKey(p)));
        if (eligible.length === 0) return;
        if (!confirm(`Accept ${eligible.length} pairs at or above ${minScore.toFixed(2)} confidence? Each will mark the older node as superseded by the newer one.`)) return;
        setBulkBusy(true);
        for (const p of eligible) {
            // Sequential to keep audit log readable + avoid hammering the daemon.
            // eslint-disable-next-line no-await-in-loop
            await acceptOne(p, `bulk-accept above ${minScore.toFixed(2)} (similarity ${p.score.toFixed(3)})`);
        }
        setBulkBusy(false);
    };

    const visiblePairs = (resp?.pairs ?? []).filter((p) => p.score >= threshold);
    const eligibleCount = visiblePairs.filter((p) => !accepted.has(pairKey(p))).length;

    return (
        <div
            style={{
                position: 'fixed',
                inset: 0,
                background: 'rgba(0,0,0,0.55)',
                zIndex: 100,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '2rem',
            }}
            onClick={onClose}
        >
            <div
                style={{
                    background: 'var(--color-bg, #fff)',
                    color: 'var(--color-text)',
                    width: '100%',
                    maxWidth: 980,
                    maxHeight: '88vh',
                    borderRadius: 10,
                    boxShadow: '0 20px 60px rgba(0,0,0,0.4)',
                    display: 'flex',
                    flexDirection: 'column',
                    overflow: 'hidden',
                }}
                onClick={(e) => e.stopPropagation()}
            >
                <header style={{ padding: '1rem 1.25rem', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <h2 style={{ margin: 0, fontSize: '1.1rem', flex: 1 }}>Find supersession candidates</h2>
                    <button onClick={() => void refresh(true)} title="Re-scan (busts the 10-min server cache)" className="icon-button">
                        <RefreshCw size={16} />
                    </button>
                    <button onClick={onClose} className="icon-button" title="Close">
                        <X size={18} />
                    </button>
                </header>

                <div style={{ padding: '0.5rem 1.25rem 0.75rem', borderBottom: '1px solid var(--color-border)', fontSize: '0.85rem', color: 'var(--color-text-muted)', lineHeight: 1.5 }}>
                    Lore looks for nodes that appear to be newer versions of older ones — same topic, similar wording, different content. Pick a project, set a confidence threshold, and accept pairs to mark the older one superseded by the newer. Higher confidence = more conservative.
                </div>

                <div style={{ padding: '0.75rem 1.25rem', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
                    {/* Project picker: required because workspace-wide
                        scans take >60s on real graphs. We surface the
                        list so the user always knows which project the
                        results came from. */}
                    <label style={{ fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                        Project:
                        <select
                            value={scope ?? ''}
                            disabled={loading}
                            onChange={(e) => {
                                const v = e.target.value || null;
                                setScope(v);
                                setResp(null);
                            }}
                            style={{
                                background: 'transparent',
                                color: 'inherit',
                                border: '1px solid var(--color-border)',
                                borderRadius: 4,
                                padding: '3px 6px',
                                fontSize: '0.85rem',
                            }}
                        >
                            <option value="">— pick a project —</option>
                            {(projectOptions ?? []).map((o) => (
                                <option key={o.project} value={o.project}>
                                    {o.project} ({o.nodeCount})
                                </option>
                            ))}
                        </select>
                    </label>
                    <span style={{ fontSize: '0.85rem', color: 'var(--color-text-muted)' }}>
                        {!scope ? 'Pick a project to scan' :
                            loading ? `Scanning ${scope}… (first scan takes 20–60s)` :
                            `Scanned ${resp?.candidatesScanned ?? 0} nodes · found ${resp?.pairs.length ?? 0} pairs`}
                    </span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flex: 1, minWidth: 240 }}>
                        <label style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>Min confidence</label>
                        <input
                            type="range"
                            min={0.7}
                            max={1.0}
                            step={0.01}
                            value={threshold}
                            onChange={(e) => setThreshold(parseFloat(e.target.value))}
                            style={{ flex: 1 }}
                        />
                        <code style={{ fontSize: '0.85rem', minWidth: 48, textAlign: 'right' }}>{threshold.toFixed(2)}</code>
                    </div>
                    <button
                        disabled={eligibleCount === 0 || bulkBusy}
                        onClick={() => void acceptAllAbove(threshold)}
                        style={{
                            background: eligibleCount === 0 ? 'var(--color-border)' : 'var(--color-accent, #14B8A6)',
                            color: '#fff',
                            border: 'none',
                            borderRadius: 6,
                            padding: '6px 12px',
                            fontSize: '0.85rem',
                            cursor: eligibleCount === 0 || bulkBusy ? 'not-allowed' : 'pointer',
                        }}
                    >
                        {bulkBusy ? 'Applying…' : `Accept all (${eligibleCount}) above ${threshold.toFixed(2)}`}
                    </button>
                </div>

                <div style={{ flex: 1, overflow: 'auto', padding: '1rem 1.25rem' }}>
                    {error ? (
                        <div style={{ color: 'crimson', marginBottom: '1rem' }}>Error: {error}</div>
                    ) : null}

                    {!loading && visiblePairs.length === 0 ? (
                        <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--color-text-muted)' }}>
                            No pairs at or above {threshold.toFixed(2)} confidence. Lower the slider to see more matches.
                        </div>
                    ) : null}

                    {visiblePairs.map((p) => {
                        const key = pairKey(p);
                        const isAccepted = accepted.has(key);
                        const isBusy = busy.has(key);
                        return (
                            <div
                                key={key}
                                style={{
                                    border: isAccepted ? '2px solid var(--color-accent, #14B8A6)' : '1px solid var(--color-border)',
                                    borderRadius: 8,
                                    padding: '12px',
                                    marginBottom: '10px',
                                    opacity: isAccepted ? 0.7 : 1,
                                    background: isAccepted ? 'var(--color-accent-bg, rgba(20,184,166,0.06))' : 'transparent',
                                }}
                            >
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '8px' }}>
                                    <span style={{
                                        background: 'var(--color-accent, #14B8A6)',
                                        color: '#fff',
                                        borderRadius: 4,
                                        padding: '2px 8px',
                                        fontSize: '0.75rem',
                                        fontWeight: 600,
                                    }}>
                                        {(p.score * 100).toFixed(1)}% similar
                                    </span>
                                    <span style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>
                                        project: {p.project}
                                    </span>
                                    <span style={{ flex: 1 }} />
                                    {isAccepted ? (
                                        <span style={{ fontSize: '0.8rem', color: 'var(--color-accent, #14B8A6)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '4px' }}>
                                            <Check size={14} /> Superseded
                                        </span>
                                    ) : (
                                        <button
                                            disabled={isBusy}
                                            onClick={() => void acceptOne(p)}
                                            style={{
                                                background: 'var(--color-accent, #14B8A6)',
                                                color: '#fff',
                                                border: 'none',
                                                borderRadius: 6,
                                                padding: '5px 12px',
                                                fontSize: '0.8rem',
                                                cursor: isBusy ? 'not-allowed' : 'pointer',
                                            }}
                                        >
                                            {isBusy ? 'Applying…' : `Mark old as superseded`}
                                        </button>
                                    )}
                                </div>
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                                    <div style={{ background: 'rgba(0,0,0,0.04)', padding: '8px 10px', borderRadius: 6 }}>
                                        <div style={{ fontSize: '0.7rem', color: 'var(--color-text-muted)', marginBottom: '4px' }}>
                                            OLDER → mark superseded
                                        </div>
                                        <strong style={{ fontSize: '0.85rem' }}>{p.oldLabel}</strong>
                                        <div style={{ fontSize: '0.7rem', color: 'var(--color-text-muted)', marginTop: '2px' }}>
                                            <code>{p.oldId}</code>
                                            {p.oldCreatedAt ? <span style={{ marginLeft: '0.5rem' }}>{new Date(p.oldCreatedAt).toLocaleDateString()}</span> : null}
                                        </div>
                                        <p style={{ fontSize: '0.78rem', margin: '6px 0 0', lineHeight: 1.4 }}>{p.oldContent || '(no content)'}</p>
                                    </div>
                                    <div style={{ background: 'var(--color-accent-bg, rgba(20,184,166,0.06))', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--color-accent, #14B8A6)' }}>
                                        <div style={{ fontSize: '0.7rem', color: 'var(--color-accent, #14B8A6)', marginBottom: '4px', fontWeight: 600 }}>
                                            NEWER → keep as current
                                        </div>
                                        <strong style={{ fontSize: '0.85rem' }}>{p.newLabel}</strong>
                                        <div style={{ fontSize: '0.7rem', color: 'var(--color-text-muted)', marginTop: '2px' }}>
                                            <code>{p.newId}</code>
                                            {p.newCreatedAt ? <span style={{ marginLeft: '0.5rem' }}>{new Date(p.newCreatedAt).toLocaleDateString()}</span> : null}
                                        </div>
                                        <p style={{ fontSize: '0.78rem', margin: '6px 0 0', lineHeight: 1.4 }}>{p.newContent || '(no content)'}</p>
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}
