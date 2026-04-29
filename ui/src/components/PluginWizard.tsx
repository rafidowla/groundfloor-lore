/**
 * PluginWizard.tsx — In-app wizard for authoring Tier 1 (no-code) plugins.
 *
 * Three-step flow:
 *   1. Sample      — paste/upload CSV, name your plugin, name a node type.
 *                    Server runs deterministic heuristics on column names +
 *                    sample values and proposes a schema.
 *   2. Refine      — show the proposal, let the user override field
 *                    mappings and id strategy. Generated YAML preview.
 *   3. Preview &   — server runs a dry-run ingest against the first 100
 *      Save          rows and shows what would happen. User clicks Save;
 *                    server writes the manifest to <LORE_HOME>/manifests/.
 *
 * MVP scope: forms-based, no canvas/drag-drop, no LLM (heuristics only).
 * Visual schema editor + LLM escalation are planned follow-ups.
 */

import { useCallback, useState, lazy, Suspense } from 'react';
import { authFetch } from '../lib/authFetch';
import type { CanvasState } from './SchemaEditorCanvas';

const SchemaEditorCanvas = lazy(() => import('./SchemaEditorCanvas'));

// ────────────────────────────────────────────────────────────────────────
// Types echoing the server-side shapes (kept inline to avoid a build-time
// dep on the daemon's TS sources from the UI bundle).
// ────────────────────────────────────────────────────────────────────────

interface ColumnDetection {
    name: string;
    detectedType: string;
    cardinality: 'unique' | 'low' | 'medium' | 'high';
    isIdCandidate: boolean;
    samples: string[];
    suggestedField?: string;
}

interface SchemaProposal {
    suggestedNodeTypeName: string;
    columns: ColumnDetection[];
    suggestedFields: {
        label?: string;
        content?: string;
        project?: string;
        tags?: string;
        language?: string;
    };
    suggestedIdStrategy:
        | { kind: 'column'; column: string }
        | { kind: 'hash'; columns: string[] };
    confidence: number;
    notes: string[];
}

interface DetectResponse {
    proposal: SchemaProposal;
    rowCount: number;
    sampleRows: Array<Record<string, string>>;
}

interface DryRunResponse {
    report: {
        sourcePath: string;
        totalRows: number;
        ingested: number;
        skipped: number;
        errors: Array<{ rowNumber: number; reason: string }>;
        elapsedMs: number;
    };
    sampleWrites: Array<{ id: string; type: string; label: string; tags: string[] }>;
}

interface SaveResponse {
    saved: boolean;
    bundleDir: string;
    manifestPath: string;
    next_step: string;
}

// ────────────────────────────────────────────────────────────────────────
// Editable wizard state
// ────────────────────────────────────────────────────────────────────────

interface WizardState {
    step: 1 | 2 | 3;
    pluginName: string;
    pluginDescription: string;
    nodeTypeName: string;
    nodeTypeDescription: string;
    fileName: string;
    csvText: string;
    proposal: SchemaProposal | null;
    sampleRows: Array<Record<string, string>>;
    rowCount: number;
    // Refined choices
    fieldMap: SchemaProposal['suggestedFields'];
    idStrategy: SchemaProposal['suggestedIdStrategy'];
    // Step 2 view toggle: forms (default) vs visual canvas editor
    step2View: 'form' | 'canvas';
    // Visual canvas state — additional node types and edge relations
    // declared via the canvas. The CSV-anchored node type is always
    // included via `nodeTypeName`; canvas adds extras.
    canvas: CanvasState;
    // LLM refinement
    llmBusy: boolean;
    llmRefinementInfo: string | null; // human note about whether LLM was used / why fallback
    // Stage 3
    dryRun: DryRunResponse | null;
    saveResult: SaveResponse | null;
    error: string | null;
    busy: boolean;
}

const INITIAL: WizardState = {
    step: 1,
    pluginName: '',
    pluginDescription: '',
    nodeTypeName: '',
    nodeTypeDescription: '',
    fileName: '',
    csvText: '',
    proposal: null,
    sampleRows: [],
    rowCount: 0,
    fieldMap: {},
    idStrategy: { kind: 'hash', columns: [] },
    step2View: 'form',
    canvas: { nodeTypes: [], edges: [], positions: {} },
    llmBusy: false,
    llmRefinementInfo: null,
    dryRun: null,
    saveResult: null,
    error: null,
    busy: false,
};

const FIELD_KEYS: Array<keyof SchemaProposal['suggestedFields']> = ['label', 'content', 'project', 'tags', 'language'];

interface PluginWizardProps {
    onClose?: () => void;
}

export default function PluginWizard({ onClose }: PluginWizardProps) {
    const [state, setState] = useState<WizardState>(INITIAL);

    const update = useCallback((patch: Partial<WizardState>) => {
        setState((prev) => ({ ...prev, ...patch }));
    }, []);

    // ── Step 1: detect schema ───────────────────────────────────
    const handleDetect = useCallback(async () => {
        update({ busy: true, error: null });
        try {
            const r = await authFetch('/api/plugin-wizard/detect', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ fileName: state.fileName || 'sample.csv', csvText: state.csvText }),
            });
            if (!r.ok) {
                const e = await r.json().catch(() => ({}));
                throw new Error(e.error ?? `HTTP ${r.status}`);
            }
            const data = (await r.json()) as DetectResponse;
            const seedTypeName = state.nodeTypeName || data.proposal.suggestedNodeTypeName;
            update({
                proposal: data.proposal,
                sampleRows: data.sampleRows,
                rowCount: data.rowCount,
                fieldMap: { ...data.proposal.suggestedFields },
                idStrategy: data.proposal.suggestedIdStrategy,
                nodeTypeName: seedTypeName,
                // Seed the canvas with the CSV-anchored node type so the
                // user starts with one box and can add more types / edges.
                canvas: {
                    nodeTypes: [{ name: seedTypeName, description: state.nodeTypeDescription || `A ${seedTypeName} record.`, isCsvAnchor: true }],
                    edges: [],
                    positions: { [seedTypeName]: { x: 80, y: 80 } },
                },
                step: 2,
                busy: false,
            });
        } catch (err) {
            update({ error: (err as Error).message, busy: false });
        }
    }, [state.csvText, state.fileName, state.nodeTypeName, update]);

    // ── LLM refine — escalate low-confidence heuristic to BYOK LLM ──
    const handleRefineWithLlm = useCallback(async () => {
        if (!state.proposal) return;
        update({ llmBusy: true, error: null, llmRefinementInfo: null });
        try {
            const r = await authFetch('/api/plugin-wizard/refine-with-llm', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    proposal: state.proposal,
                    sampleHeaders: state.proposal.columns.map((c) => c.name),
                    sampleRows: state.sampleRows,
                }),
            });
            if (!r.ok) {
                const e = await r.json().catch(() => ({}));
                update({
                    llmBusy: false,
                    llmRefinementInfo: `LLM refinement unavailable: ${e.error ?? r.status}. Heuristic proposal kept.`,
                });
                return;
            }
            const data = await r.json() as { refinedProposal: Record<string, unknown> | null; usable: boolean; provider: string };
            if (!data.usable || !data.refinedProposal) {
                update({
                    llmBusy: false,
                    llmRefinementInfo: `LLM (${data.provider}) returned an unparseable response. Heuristic proposal kept.`,
                });
                return;
            }
            // Merge refined fields into wizard state. We trust the LLM
            // for field mapping + id strategy + node type name; we keep
            // the heuristic's column detections (those are facts, not
            // suggestions). Note: refinedProposal columns may be absent.
            const refined = data.refinedProposal as Partial<SchemaProposal>;
            update({
                fieldMap: refined.suggestedFields ?? state.fieldMap,
                idStrategy: refined.suggestedIdStrategy ?? state.idStrategy,
                nodeTypeName: refined.suggestedNodeTypeName ?? state.nodeTypeName,
                llmBusy: false,
                llmRefinementInfo: `Refined by ${data.provider}. ${(refined.notes ?? []).map((n) => `· ${n}`).join('  ')}`,
            });
        } catch (err) {
            update({ llmBusy: false, llmRefinementInfo: `LLM refinement failed: ${(err as Error).message}` });
        }
    }, [state.proposal, state.sampleRows, state.fieldMap, state.idStrategy, state.nodeTypeName, update]);

    // ── Step 2 → 3: build manifest, run dry-run ─────────────────
    const handlePreview = useCallback(async () => {
        update({ busy: true, error: null });
        try {
            const yaml = buildManifestYaml(state);
            const r = await authFetch('/api/plugin-wizard/dryrun', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ manifestYaml: yaml, csvText: state.csvText, limit: 100 }),
            });
            if (!r.ok) {
                const e = await r.json().catch(() => ({}));
                throw new Error(e.error ?? `HTTP ${r.status}`);
            }
            const data = (await r.json()) as DryRunResponse;
            update({ dryRun: data, step: 3, busy: false });
        } catch (err) {
            update({ error: (err as Error).message, busy: false });
        }
    }, [state, update]);

    // ── Save ────────────────────────────────────────────────────
    const handleSave = useCallback(async () => {
        update({ busy: true, error: null });
        try {
            const yaml = buildManifestYaml(state);
            const r = await authFetch('/api/plugin-wizard/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    pluginName: state.pluginName,
                    manifestYaml: yaml,
                    dataFiles: [{ relPath: `data/${state.fileName || 'sample.csv'}`, content: state.csvText }],
                }),
            });
            if (!r.ok) {
                const e = await r.json().catch(() => ({}));
                throw new Error(e.error ?? `HTTP ${r.status}`);
            }
            const data = (await r.json()) as SaveResponse;
            update({ saveResult: data, busy: false });
        } catch (err) {
            update({ error: (err as Error).message, busy: false });
        }
    }, [state, update]);

    return (
        <div
            style={{
                position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                zIndex: 1000,
            }}
            onClick={onClose}
        >
            <div
                style={{
                    background: 'var(--color-surface, #1a1a1a)',
                    color: 'var(--color-text, #e5e5e5)',
                    borderRadius: 8,
                    width: 'min(900px, 90vw)',
                    maxHeight: '90vh',
                    overflow: 'auto',
                    padding: 24,
                    boxShadow: '0 12px 48px rgba(0,0,0,0.4)',
                }}
                onClick={(e) => e.stopPropagation()}
            >
                <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                    <h2 style={{ margin: 0, fontSize: '1.4rem' }}>Create plugin (Tier 1)</h2>
                    {onClose && (
                        <button onClick={onClose} style={btnSecondary}>Close</button>
                    )}
                </header>

                <Stepper step={state.step} />

                {state.error && (
                    <div style={errorBox}>{state.error}</div>
                )}

                {state.step === 1 && (
                    <Step1Sample state={state} update={update} onNext={handleDetect} />
                )}
                {state.step === 2 && (
                    <Step2Refine
                        state={state}
                        update={update}
                        onBack={() => update({ step: 1 })}
                        onNext={handlePreview}
                        onRefineWithLlm={handleRefineWithLlm}
                    />
                )}
                {state.step === 3 && (
                    <Step3PreviewSave state={state} onBack={() => update({ step: 2 })} onSave={handleSave} />
                )}
            </div>
        </div>
    );
}

// ────────────────────────────────────────────────────────────────────────
// Step components
// ────────────────────────────────────────────────────────────────────────

function Stepper({ step }: { step: 1 | 2 | 3 }) {
    return (
        <div style={{ display: 'flex', gap: 8, marginBottom: 20, fontSize: 13 }}>
            {[1, 2, 3].map((n) => {
                const labels = ['1. Sample', '2. Refine schema', '3. Preview & save'];
                const active = n === step;
                const done = n < step;
                return (
                    <div key={n} style={{
                        padding: '6px 14px',
                        borderRadius: 4,
                        background: active ? 'var(--color-accent, #4a90e2)' : (done ? 'var(--color-success-bg, #2d4a2d)' : 'var(--color-surface-alt, #2a2a2a)'),
                        color: active || done ? 'white' : 'var(--color-text-muted, #888)',
                        fontWeight: active ? 600 : 400,
                    }}>
                        {labels[n - 1]}
                    </div>
                );
            })}
        </div>
    );
}

function Step1Sample({
    state, update, onNext,
}: { state: WizardState; update: (p: Partial<WizardState>) => void; onNext: () => void }) {
    const handleFile = (file: File | null) => {
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            update({ fileName: file.name, csvText: String(reader.result ?? '') });
        };
        reader.readAsText(file);
    };

    const ready = state.pluginName && state.csvText.trim().length > 0;

    return (
        <div>
            <p style={muted}>
                Tier 1 plugins are pure data — node types and edge relations declared in YAML, no TypeScript.
                Start by picking a name and uploading a sample CSV. The wizard will look at your column names
                and propose a schema using simple pattern matching.
            </p>

            <Field label="Plugin name (kebab-case, globally unique)">
                <input
                    type="text"
                    value={state.pluginName}
                    onChange={(e) => update({ pluginName: e.target.value })}
                    placeholder="cre-iam"
                    style={input}
                />
            </Field>
            <Field label="Plugin description">
                <input
                    type="text"
                    value={state.pluginDescription}
                    onChange={(e) => update({ pluginDescription: e.target.value })}
                    placeholder="CRE IT identity + access — employees, applications, roles."
                    style={input}
                />
            </Field>

            <Field label="Sample CSV file">
                <input
                    type="file"
                    accept=".csv,text/csv"
                    onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
                    style={{ marginBottom: 8 }}
                />
                <div style={muted}>…or paste CSV content below:</div>
                <textarea
                    rows={8}
                    value={state.csvText}
                    onChange={(e) => update({ csvText: e.target.value, fileName: state.fileName || 'pasted.csv' })}
                    placeholder="id,name,email,department&#10;e001,Sarah,sarah@x.com,Brokerage"
                    style={{ ...input, fontFamily: 'monospace', fontSize: 12 }}
                />
                {state.fileName && (
                    <div style={muted}>Source: {state.fileName}</div>
                )}
            </Field>

            <FooterButtons>
                <button onClick={onNext} disabled={!ready || state.busy} style={btnPrimary}>
                    {state.busy ? 'Detecting…' : 'Detect schema →'}
                </button>
            </FooterButtons>
        </div>
    );
}

function Step2Refine({
    state, update, onBack, onNext, onRefineWithLlm,
}: { state: WizardState; update: (p: Partial<WizardState>) => void; onBack: () => void; onNext: () => void; onRefineWithLlm: () => void }) {
    if (!state.proposal) return <div>Loading…</div>;

    const setField = (k: keyof SchemaProposal['suggestedFields'], v: string) => {
        update({ fieldMap: { ...state.fieldMap, [k]: v || undefined } });
    };

    const confidencePct = Math.round(state.proposal.confidence * 100);
    const confidenceColor = confidencePct >= 70 ? '#4ade80' : confidencePct >= 40 ? '#fbbf24' : '#f87171';

    return (
        <div>
            <div style={{
                display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14,
                padding: '10px 14px', background: 'var(--color-surface-alt, #2a2a2a)', borderRadius: 6,
            }}>
                <div>
                    <div style={{ fontSize: 12, opacity: 0.7 }}>Heuristic confidence</div>
                    <div style={{ fontSize: 22, fontWeight: 600, color: confidenceColor }}>{confidencePct}%</div>
                </div>
                <div style={{ flex: 1, fontSize: 13 }}>
                    <strong>Detected {state.proposal.columns.length} columns</strong> across {state.rowCount} sample rows.
                    {state.proposal.notes.map((n, i) => <div key={i} style={muted}>· {n}</div>)}
                </div>
                <button
                    onClick={onRefineWithLlm}
                    disabled={state.llmBusy}
                    title="Use the configured BYOK LLM to refine the heuristic proposal"
                    style={{ ...btnSecondary, whiteSpace: 'nowrap' }}
                >
                    {state.llmBusy ? '✨ Refining…' : '✨ Refine with AI'}
                </button>
            </div>

            {state.llmRefinementInfo && (
                <div style={{ ...muted, padding: '8px 12px', background: 'rgba(74,144,226,0.1)', border: '1px solid #4a90e2', borderRadius: 4, marginBottom: 12 }}>
                    {state.llmRefinementInfo}
                </div>
            )}

            <div style={{ display: 'flex', gap: 4, marginBottom: 14 }}>
                <button
                    onClick={() => update({ step2View: 'form' })}
                    style={state.step2View === 'form' ? btnTabActive : btnTab}
                >📋 Form view</button>
                <button
                    onClick={() => update({ step2View: 'canvas' })}
                    style={state.step2View === 'canvas' ? btnTabActive : btnTab}
                >🌐 Canvas (visual schema editor)</button>
            </div>

            {state.step2View === 'canvas' ? (
                <Suspense fallback={<div style={{ height: 520, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>Loading canvas…</div>}>
                    <SchemaEditorCanvas
                        state={state.canvas}
                        onChange={(canvas) => {
                            // Keep the wizard's `nodeTypeName` field aligned with
                            // the canvas's CSV-anchored node-type box if its
                            // description was edited (the canvas handles renames
                            // by disabling the input on the anchor — we only need
                            // to track description here).
                            const anchor = canvas.nodeTypes.find((n) => n.isCsvAnchor);
                            update({
                                canvas,
                                nodeTypeDescription: anchor?.description ?? state.nodeTypeDescription,
                            });
                        }}
                    />
                </Suspense>
            ) : (
            <>
            <Field label="Node type name (lowercase_with_underscores)">
                <input
                    type="text"
                    value={state.nodeTypeName}
                    onChange={(e) => update({ nodeTypeName: e.target.value })}
                    style={input}
                />
            </Field>
            <Field label="Node type description">
                <input
                    type="text"
                    value={state.nodeTypeDescription}
                    onChange={(e) => update({ nodeTypeDescription: e.target.value })}
                    placeholder={`A ${state.nodeTypeName} record.`}
                    style={input}
                />
            </Field>

            <h3 style={h3}>Detected columns</h3>
            <table style={table}>
                <thead><tr><th style={th}>Column</th><th style={th}>Type</th><th style={th}>Cardinality</th><th style={th}>Sample values</th></tr></thead>
                <tbody>
                    {state.proposal.columns.map((c) => (
                        <tr key={c.name}>
                            <td style={td}><code>{c.name}</code>{c.isIdCandidate && <span style={{ marginLeft: 6, fontSize: 10, padding: '1px 6px', borderRadius: 3, background: '#4a90e2', color: 'white' }}>id</span>}</td>
                            <td style={td}>{c.detectedType}</td>
                            <td style={td}>{c.cardinality}</td>
                            <td style={{ ...td, fontSize: 11, color: 'var(--color-text-muted, #888)' }}>{c.samples.join(', ')}</td>
                        </tr>
                    ))}
                </tbody>
            </table>

            <h3 style={h3}>Field mapping</h3>
            <p style={muted}>Each LoreNode field can map to one of your CSV columns. Leave blank to skip.</p>
            {FIELD_KEYS.map((k) => (
                <Field key={k} label={`${k}${k === 'label' ? ' (required)' : ''}`}>
                    <select value={state.fieldMap[k] ?? ''} onChange={(e) => setField(k, e.target.value)} style={input}>
                        <option value="">— skip —</option>
                        {state.proposal!.columns.map((c) => (<option key={c.name} value={c.name}>{c.name}</option>))}
                    </select>
                </Field>
            ))}

            <h3 style={h3}>Id strategy</h3>
            <p style={muted}>How each row's stable id is derived. Stable ids are required for re-runs to upsert rather than duplicate.</p>
            <Field label="Strategy">
                <select
                    value={state.idStrategy.kind}
                    onChange={(e) => {
                        const kind = e.target.value as 'column' | 'hash';
                        if (kind === 'column') {
                            update({ idStrategy: { kind: 'column', column: state.proposal!.columns[0]?.name ?? '' } });
                        } else {
                            update({ idStrategy: { kind: 'hash', columns: state.proposal!.columns.slice(0, 2).map((c) => c.name) } });
                        }
                    }}
                    style={input}
                >
                    <option value="column">column (use one CSV column as id)</option>
                    <option value="hash">hash (SHA-1 of multiple columns)</option>
                </select>
            </Field>
            {state.idStrategy.kind === 'column' && (
                <Field label="Id column">
                    <select
                        value={state.idStrategy.column}
                        onChange={(e) => update({ idStrategy: { kind: 'column', column: e.target.value } })}
                        style={input}
                    >
                        {state.proposal.columns.map((c) => (<option key={c.name} value={c.name}>{c.name}</option>))}
                    </select>
                </Field>
            )}
            {state.idStrategy.kind === 'hash' && (
                <Field label="Hash columns (multi-select; same combo always produces the same id)">
                    <select
                        multiple
                        value={state.idStrategy.columns}
                        onChange={(e) => {
                            const selected = Array.from(e.target.selectedOptions).map((o) => o.value);
                            update({ idStrategy: { kind: 'hash', columns: selected } });
                        }}
                        style={{ ...input, minHeight: 90 }}
                    >
                        {state.proposal.columns.map((c) => (<option key={c.name} value={c.name}>{c.name}</option>))}
                    </select>
                </Field>
            )}

            </>
            )}

            <details style={{ marginTop: 14 }}>
                <summary style={{ cursor: 'pointer', userSelect: 'none' }}>Generated YAML preview</summary>
                <pre style={preCode}>{buildManifestYaml(state)}</pre>
            </details>

            <FooterButtons>
                <button onClick={onBack} style={btnSecondary}>← Back</button>
                <button onClick={onNext} disabled={state.busy || !state.fieldMap.label} style={btnPrimary}>
                    {state.busy ? 'Running dry-run…' : 'Preview ingest →'}
                </button>
            </FooterButtons>
        </div>
    );
}

function Step3PreviewSave({
    state, onBack, onSave,
}: { state: WizardState; onBack: () => void; onSave: () => void }) {
    if (state.saveResult) {
        return (
            <div>
                <h3 style={{ ...h3, color: '#4ade80' }}>✓ Plugin saved</h3>
                <div style={{ padding: 14, background: 'var(--color-surface-alt, #2a2a2a)', borderRadius: 6, marginBottom: 14 }}>
                    <div><strong>Bundle:</strong> <code>{state.saveResult.bundleDir}</code></div>
                    <div><strong>Manifest:</strong> <code>{state.saveResult.manifestPath}</code></div>
                </div>
                <p style={muted}><strong>Next step:</strong></p>
                <pre style={preCode}>{state.saveResult.next_step}</pre>
                <p style={muted}>After restart, your plugin's MCP tools will be available:
                    <code> store_{state.nodeTypeName}</code>, <code>list_{state.nodeTypeName}</code>,
                    and <code>lore_plugin_ingest({'{plugin: "' + state.pluginName + '"}'})</code>.
                </p>
            </div>
        );
    }
    if (!state.dryRun) return <div>Loading…</div>;
    const { report, sampleWrites } = state.dryRun;
    return (
        <div>
            <h3 style={h3}>Dry-run report</h3>
            <div style={{ display: 'flex', gap: 16, marginBottom: 14 }}>
                <Stat label="Source rows" value={report.totalRows} />
                <Stat label="Would ingest" value={report.ingested} good />
                <Stat label="Would skip" value={report.skipped} bad={report.skipped > 0} />
                <Stat label="Elapsed" value={`${report.elapsedMs}ms`} />
            </div>

            {report.errors.length > 0 && (
                <details>
                    <summary style={{ color: '#f87171', cursor: 'pointer' }}>{report.errors.length} skipped row{report.errors.length === 1 ? '' : 's'}</summary>
                    <table style={table}>
                        <thead><tr><th style={th}>Row</th><th style={th}>Reason</th></tr></thead>
                        <tbody>
                            {report.errors.map((e, i) => (
                                <tr key={i}><td style={td}>{e.rowNumber}</td><td style={td}>{e.reason}</td></tr>
                            ))}
                        </tbody>
                    </table>
                </details>
            )}

            <h3 style={h3}>Sample writes</h3>
            <p style={muted}>The first 10 rows would create these graph nodes:</p>
            <table style={table}>
                <thead><tr><th style={th}>id</th><th style={th}>type</th><th style={th}>label</th><th style={th}>tags</th></tr></thead>
                <tbody>
                    {sampleWrites.map((w) => (
                        <tr key={w.id}>
                            <td style={{ ...td, fontFamily: 'monospace', fontSize: 11 }}>{w.id}</td>
                            <td style={td}>{w.type}</td>
                            <td style={td}>{w.label}</td>
                            <td style={{ ...td, fontSize: 11 }}>{w.tags.join(', ')}</td>
                        </tr>
                    ))}
                </tbody>
            </table>

            <FooterButtons>
                <button onClick={onBack} style={btnSecondary}>← Back</button>
                <button onClick={onSave} disabled={state.busy} style={btnPrimary}>
                    {state.busy ? 'Saving…' : 'Save plugin'}
                </button>
            </FooterButtons>
        </div>
    );
}

// ────────────────────────────────────────────────────────────────────────
// YAML builder + UI primitives
// ────────────────────────────────────────────────────────────────────────

function buildManifestYaml(state: WizardState): string {
    const fileName = state.fileName || 'sample.csv';
    const fields = state.fieldMap;
    const fieldLines: string[] = [];
    if (fields.label) fieldLines.push(`        label: ${q(fields.label)}`);
    if (fields.content) fieldLines.push(`        content: ${q(fields.content)}`);
    if (fields.project) fieldLines.push(`        project: ${q(fields.project)}`);
    if (fields.tags) fieldLines.push(`        tags: ${q(fields.tags)}`);
    if (fields.language) fieldLines.push(`        language: ${q(fields.language)}`);

    const idStrategyLine = state.idStrategy.kind === 'column'
        ? `      idStrategy: { kind: column, column: ${q(state.idStrategy.column)} }`
        : `      idStrategy: { kind: hash, columns: [${state.idStrategy.columns.map(q).join(', ')}] }`;

    // Combine the CSV-anchored node type (from `nodeTypeName`) with any
    // additional node types declared via the canvas. The canvas's anchor
    // is the same node-type name; if the canvas state is present, prefer
    // it (the canvas may have edited the description). Otherwise fall
    // back to the form's `nodeTypeName` / `nodeTypeDescription`.
    const csvAnchorName = state.nodeTypeName;
    const csvAnchorDesc = state.nodeTypeDescription || `A ${csvAnchorName} record.`;
    const canvasNodeTypes = state.canvas.nodeTypes;
    const additionalNodeTypes = canvasNodeTypes.filter((nt) => !nt.isCsvAnchor);
    const allNodeTypes = canvasNodeTypes.length > 0
        ? canvasNodeTypes.map((nt) => nt.isCsvAnchor
            ? { name: csvAnchorName, description: nt.description || csvAnchorDesc }
            : nt)
        : [{ name: csvAnchorName, description: csvAnchorDesc }];

    void additionalNodeTypes; // documented as a separate concept above

    const nodeTypeLines = allNodeTypes.map((nt) =>
        `      - name: ${q(nt.name)}\n        description: ${q(nt.description)}`,
    ).join('\n');

    const edges = state.canvas.edges;
    const edgeBlock = edges.length === 0
        ? ''
        : `\n    edgeRelations:\n${edges.map((er) => `      - name: ${q(er.name)}\n        description: ${q(er.description)}`).join('\n')}`;

    return `manifestVersion: 1
name: ${q(state.pluginName)}
version: 0.1.0
description: ${q(state.pluginDescription || `Tier 1 plugin built with the wizard.`)}

lore:
  schema:
    nodeTypes:
${nodeTypeLines}${edgeBlock}
  ingest:
    - id: import
      source: csv
      file: data/${fileName}
      mapTo: ${q(csvAnchorName)}
${idStrategyLine}
      fields:
${fieldLines.join('\n')}
`;
}

function q(s: string): string {
    // Quote when needed; YAML inline-flow is brittle around special chars.
    if (/^[a-z][a-z0-9_-]*$/i.test(s)) return s;
    return JSON.stringify(s);
}

// ── tiny styling primitives (kept inline so the wizard ships in one file) ──

const input: React.CSSProperties = {
    display: 'block', width: '100%', padding: '6px 8px',
    background: 'var(--color-surface-alt, #2a2a2a)', color: 'var(--color-text, #e5e5e5)',
    border: '1px solid var(--color-border, #444)', borderRadius: 4, fontSize: 13,
};
const btnPrimary: React.CSSProperties = {
    padding: '8px 16px', background: 'var(--color-accent, #4a90e2)', color: 'white',
    border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 13, fontWeight: 500,
};
const btnSecondary: React.CSSProperties = {
    padding: '8px 16px', background: 'transparent', color: 'var(--color-text, #e5e5e5)',
    border: '1px solid var(--color-border, #444)', borderRadius: 4, cursor: 'pointer', fontSize: 13,
};
const btnTab: React.CSSProperties = {
    padding: '6px 14px', background: 'transparent', color: 'var(--color-text-muted, #888)',
    border: '1px solid var(--color-border, #444)', borderRadius: 4, cursor: 'pointer', fontSize: 12,
    fontWeight: 500,
};
const btnTabActive: React.CSSProperties = {
    ...btnTab, background: 'var(--color-accent, #4a90e2)', color: 'white', borderColor: 'var(--color-accent, #4a90e2)',
};
const muted: React.CSSProperties = { color: 'var(--color-text-muted, #888)', fontSize: 12, marginTop: 4 };
const h3: React.CSSProperties = { margin: '20px 0 8px', fontSize: '0.95rem', fontWeight: 600 };
const table: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: 12, marginBottom: 8 };
const th: React.CSSProperties = { textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid var(--color-border, #444)', fontWeight: 600 };
const td: React.CSSProperties = { padding: '4px 8px', borderBottom: '1px solid var(--color-border-subtle, #2a2a2a)' };
const errorBox: React.CSSProperties = {
    padding: 10, background: 'rgba(248,113,113,0.15)', border: '1px solid #f87171',
    borderRadius: 4, color: '#fca5a5', marginBottom: 12, fontSize: 13,
};
const preCode: React.CSSProperties = {
    background: 'var(--color-surface-alt, #2a2a2a)', padding: 12, borderRadius: 4,
    fontSize: 11, overflow: 'auto', maxHeight: 240,
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 500, marginBottom: 4 }}>{label}</label>
            {children}
        </div>
    );
}

function FooterButtons({ children }: { children: React.ReactNode }) {
    return (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--color-border, #444)' }}>
            {children}
        </div>
    );
}

function Stat({ label, value, good, bad }: { label: string; value: string | number; good?: boolean; bad?: boolean }) {
    return (
        <div style={{ flex: 1, padding: 10, background: 'var(--color-surface-alt, #2a2a2a)', borderRadius: 4 }}>
            <div style={{ fontSize: 11, opacity: 0.7 }}>{label}</div>
            <div style={{
                fontSize: 18, fontWeight: 600,
                color: good ? '#4ade80' : bad ? '#f87171' : 'inherit',
            }}>{value}</div>
        </div>
    );
}
