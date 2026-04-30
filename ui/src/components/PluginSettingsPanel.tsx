/**
 * PluginSettingsPanel.tsx — Auto-rendered settings UI from a plugin's
 * manifest `lore.settings[]` declarations.
 *
 * The panel lists every active manifest plugin that declares settings,
 * and for each one renders an input per declared field. Values round-trip
 * through `GET /api/plugins/<name>/settings` and `PUT` to the same path.
 * Secret values are keychain-resident; the API only ever returns
 * `{ set: true|false }` for them.
 */

import { useCallback, useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { authFetch } from '../lib/authFetch';

interface SettingsField {
    name: string;
    label: string;
    type: 'string' | 'number' | 'boolean' | 'secret';
    description: string;
    default?: string | number | boolean;
    required?: boolean;
}

interface SettingsResponse {
    plugin: string;
    fields: SettingsField[];
    values: Record<string, unknown>;
}

interface ManifestSummary { name: string; description: string; }

interface PluginSettingsPanelProps {
    onClose: () => void;
}

export default function PluginSettingsPanel({ onClose }: PluginSettingsPanelProps) {
    const [pluginsWithSettings, setPluginsWithSettings] = useState<string[] | null>(null);
    const [activePlugin, setActivePlugin] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        void (async () => {
            try {
                const r = await authFetch('/api/plugins/manifests');
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                const data = await r.json() as { manifests: ManifestSummary[] };
                // Probe each plugin's settings endpoint to find which declare fields.
                const withSettings: string[] = [];
                for (const m of data.manifests) {
                    try {
                        const sr = await authFetch(`/api/plugins/${m.name}/settings`);
                        if (!sr.ok) continue;
                        const s = await sr.json() as SettingsResponse;
                        if (s.fields.length > 0) withSettings.push(m.name);
                    } catch { continue; }
                }
                setPluginsWithSettings(withSettings);
                if (withSettings.length > 0) setActivePlugin(withSettings[0]!);
            } catch (err) {
                setError((err as Error).message);
            }
        })();
    }, []);

    return (
        <Wrapper onClose={onClose}>
            {error && <div style={errorBox}>{error}</div>}
            {!error && !pluginsWithSettings && <div style={muted}>Loading…</div>}
            {!error && pluginsWithSettings && pluginsWithSettings.length === 0 && (
                <div style={muted}>
                    No plugins declare settings. A plugin can declare them via
                    <code> lore.settings[]</code> in its manifest.
                </div>
            )}
            {pluginsWithSettings && pluginsWithSettings.length > 0 && (
                <>
                    <div style={tabStrip}>
                        {pluginsWithSettings.map((p) => (
                            <button key={p} onClick={() => setActivePlugin(p)} style={p === activePlugin ? tabActive : tab}>
                                {p}
                            </button>
                        ))}
                    </div>
                    {activePlugin && <PluginSettingsForm pluginName={activePlugin} />}
                </>
            )}
        </Wrapper>
    );
}

function PluginSettingsForm({ pluginName }: { pluginName: string }) {
    const [data, setData] = useState<SettingsResponse | null>(null);
    const [edits, setEdits] = useState<Record<string, unknown>>({});
    const [error, setError] = useState<string | null>(null);
    const [saved, setSaved] = useState(false);
    const [busy, setBusy] = useState(false);

    const refresh = useCallback(async () => {
        setError(null);
        try {
            const r = await authFetch(`/api/plugins/${pluginName}/settings`);
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const d = await r.json() as SettingsResponse;
            setData(d);
            setEdits({});
            setSaved(false);
        } catch (err) {
            setError((err as Error).message);
        }
    }, [pluginName]);

    useEffect(() => { void refresh(); }, [refresh]);

    const handleSave = useCallback(async () => {
        if (!data) return;
        setBusy(true);
        setError(null);
        try {
            const r = await authFetch(`/api/plugins/${pluginName}/settings`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(edits),
            });
            if (!r.ok) {
                const e = await r.json().catch(() => ({}));
                throw new Error(e.error ?? `HTTP ${r.status}`);
            }
            setSaved(true);
            await refresh();
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusy(false);
        }
    }, [data, edits, pluginName, refresh]);

    if (error) return <div style={errorBox}>{error}</div>;
    if (!data) return <div style={muted}>Loading…</div>;

    return (
        <div style={{ padding: '8px 4px' }}>
            {data.fields.map((f) => (
                <Field key={f.name} field={f} value={edits[f.name] ?? data.values[f.name]} onChange={(v) => setEdits({ ...edits, [f.name]: v })} />
            ))}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end', marginTop: 16 }}>
                {saved && <span style={{ color: '#4ade80', fontSize: 12 }}>✓ Saved</span>}
                <button onClick={handleSave} disabled={busy || Object.keys(edits).length === 0} style={btnPrimary}>
                    {busy ? 'Saving…' : 'Save'}
                </button>
            </div>
        </div>
    );
}

function Field({ field, value, onChange }: { field: SettingsField; value: unknown; onChange: (v: unknown) => void }) {
    const isSecretValue = (v: unknown): v is { set: boolean } =>
        typeof v === 'object' && v !== null && 'set' in (v as Record<string, unknown>);
    return (
        <div style={{ marginBottom: 14 }}>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 500, marginBottom: 4 }}>
                {field.label}{field.required && ' *'}
            </label>
            {field.type === 'string' && (
                <input type="text" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} style={input} />
            )}
            {field.type === 'number' && (
                <input type="number" value={Number(value ?? 0)} onChange={(e) => onChange(Number(e.target.value))} style={input} />
            )}
            {field.type === 'boolean' && (
                <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
            )}
            {field.type === 'secret' && (
                <>
                    {isSecretValue(value) && value.set && (
                        <div style={{ fontSize: 11, color: '#4ade80', marginBottom: 4 }}>✓ Already set in keychain</div>
                    )}
                    <input
                        type="password"
                        placeholder={isSecretValue(value) && value.set ? '••••••••' : 'Enter secret'}
                        onChange={(e) => onChange(e.target.value)}
                        style={input}
                    />
                </>
            )}
            <div style={muted}>{field.description}</div>
        </div>
    );
}

function Wrapper({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
    return (
        <div
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
            onClick={onClose}
        >
            <div
                style={{ background: 'var(--color-surface, #1a1a1a)', color: 'var(--color-text, #e5e5e5)', borderRadius: 8, width: 'min(700px, 90vw)', maxHeight: '90vh', overflow: 'auto', padding: 20, boxShadow: '0 12px 48px rgba(0,0,0,0.4)' }}
                onClick={(e) => e.stopPropagation()}
            >
                <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                    <h2 style={{ margin: 0, fontSize: '1.2rem' }}>Plugin settings</h2>
                    <button onClick={onClose} className="icon-button" title="Close">
                        <X size={18} />
                    </button>
                </header>
                {children}
            </div>
        </div>
    );
}

const tabStrip: React.CSSProperties = { display: 'flex', gap: 4, borderBottom: '1px solid var(--color-border, #444)', marginBottom: 12 };
const tab: React.CSSProperties = { padding: '6px 14px', border: 'none', background: 'transparent', color: 'var(--color-text-muted, #888)', cursor: 'pointer', fontSize: 13, borderBottom: '2px solid transparent' };
const tabActive: React.CSSProperties = { ...tab, color: 'var(--color-text, #e5e5e5)', borderBottomColor: 'var(--color-accent, #4a90e2)', fontWeight: 600 };
const input: React.CSSProperties = { display: 'block', width: '100%', padding: '6px 8px', background: 'var(--color-surface-alt, #2a2a2a)', color: 'var(--color-text, #e5e5e5)', border: '1px solid var(--color-border, #444)', borderRadius: 4, fontSize: 13, boxSizing: 'border-box' };
const btnPrimary: React.CSSProperties = { padding: '8px 16px', background: 'var(--color-accent, #4a90e2)', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 13, fontWeight: 500 };
const miniBtn: React.CSSProperties = { padding: '4px 10px', background: 'transparent', color: 'var(--color-text, #e5e5e5)', border: '1px solid var(--color-border, #444)', borderRadius: 3, cursor: 'pointer', fontSize: 12 };
const muted: React.CSSProperties = { color: 'var(--color-text-muted, #888)', fontSize: 12, marginTop: 4 };
const errorBox: React.CSSProperties = { padding: 12, background: 'rgba(248,113,113,0.15)', border: '1px solid #f87171', borderRadius: 4, color: '#fca5a5', fontSize: 13 };
