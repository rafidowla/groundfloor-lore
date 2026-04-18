import { useEffect, useRef, useState } from 'react';
import { Settings, MessageSquare, Network, Moon, Sun } from 'lucide-react';
import GraphCanvas from './components/GraphCanvas';
import SigmaCanvas from './components/SigmaCanvas';
import FiltersPanel, { type TopologyLike } from './components/FiltersPanel';
import WorkspacePicker from './components/WorkspacePicker';
import './App.css';

// Mode → default filter preset. Matches the plugin's uiHints.defaultFilterTypes
// on the backend (src/plugins/developer/index.ts). "all" = pass-through.
const MODE_FILTER_PRESETS: Record<string, string[] | null> = {
  all: null,
  developer: ['decision', 'convention', 'bug_pattern', 'code_symbol', 'architecture', 'troubleshooting'],
};

// Backend daemon base URL. Default is empty string so requests are
// same-origin — the Vite dev proxy in ui/vite.config.ts forwards /api/*
// to http://127.0.0.1:3847. Override with VITE_LORE_API for production.
const API_BASE = (import.meta as unknown as { env?: { VITE_LORE_API?: string } }).env?.VITE_LORE_API ?? '';

type LlmProvider = 'embedded' | 'anthropic' | 'openai' | 'ollama';

interface HealthResponse {
  status: string;
  version: string;
  activePlugins: string[];
  defaultMode: string;
  llmProvider: LlmProvider;
  workspace: string;
  dataplane: 'bound' | 'offline';
  orphans?: string[];
}

type OrphanDecision = 'keep' | 'drop' | 'reenable';

interface ConfigResponse {
  plugins: string[];
  defaultMode: string;
  llmProvider: LlmProvider;
  hasApiKey: boolean;
  extractionPath?: 'local-byok' | 'def-cloud';
  telemetryOptOut?: boolean;
  capability: {
    provider: string;
    model: string;
    acceptsText: boolean;
    acceptsImages: boolean;
    acceptedMimeTypes: string[];
  };
}

interface ExtractResult {
  accepted: boolean;
  status?: number;
  filename: string;
  mimeType: string;
  reason?: string;
  plan?: { kind: string; chunks?: number; preview?: string };
  acceptedMimeTypes?: string[];
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  streaming?: boolean;
  error?: boolean;
}

/** Read a File object as base64 without the data: URL prefix. */
function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('Expected base64 string'));
        return;
      }
      resolve(result.split(',')[1] ?? '');
    };
    reader.onerror = () => reject(reader.error ?? new Error('FileReader error'));
    reader.readAsDataURL(file);
  });
}

function App() {
  const [theme, setTheme] = useState<'corporate' | 'midnight'>('corporate');
  const [showSettings, setShowSettings] = useState(false);
  const [useSigmaEngine, setUseSigmaEngine] = useState(true);

  // Config state (Phase 0 wiring)
  const [llmProvider, setLlmProvider] = useState<LlmProvider>('embedded');
  const [apiKey, setApiKey] = useState('');
  const [hasApiKey, setHasApiKey] = useState(false);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [workspaceSwitching, setWorkspaceSwitching] = useState<string | null>(null);

  // Chat state
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const patchTimer = useRef<number | null>(null);

  // Phase 1: Mode pill-group state. "all" shows every plugin's nodes;
  // otherwise the value matches one entry in health.activePlugins.
  const [activeMode, setActiveMode] = useState<string>('all');

  // Phase 2: Dual-path extraction settings + last upload result (rendered
  // beneath the file input so the user sees what the server decided).
  const [extractionPath, setExtractionPath] = useState<'local-byok' | 'def-cloud'>('local-byok');
  const [telemetryOptOut, setTelemetryOptOut] = useState(false);
  const [capability, setCapability] = useState<ConfigResponse['capability'] | null>(null);
  const [lastExtract, setLastExtract] = useState<ExtractResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // V2.1: reconnect panel state
  const [reconnectBusy, setReconnectBusy] = useState(false);
  const [reconnectMsg, setReconnectMsg] = useState<string | null>(null);
  const [reconnectAdvanced, setReconnectAdvanced] = useState(false);
  const [reconnectK, setReconnectK] = useState(5);
  const [reconnectThreshold, setReconnectThreshold] = useState(0.65);

  // Phase 3: filter state for the right panel, topology for populating
  // the filter buckets, focusNodeId driven by SSE `focus` events.
  const [topology, setTopology] = useState<TopologyLike | null>(null);
  const [activeTypes, setActiveTypes] = useState<Set<string> | null>(null);
  const [activeProjects, setActiveProjects] = useState<Set<string> | null>(null);
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
  const focusCoalesceRef = useRef<number | null>(null);

  // ── Initial load: fetch /api/health + /api/config ────────────────
  useEffect(() => {
    void (async () => {
      try {
        const [h, c] = await Promise.all([
          fetch(`${API_BASE}/api/health`).then((r) => r.json() as Promise<HealthResponse>),
          fetch(`${API_BASE}/api/config`).then((r) => r.json() as Promise<ConfigResponse>),
        ]);
        setHealth(h);
        setLlmProvider(c.llmProvider);
        setHasApiKey(c.hasApiKey);
        setActiveMode(c.defaultMode || 'all');
        setExtractionPath(c.extractionPath ?? 'local-byok');
        setTelemetryOptOut(Boolean(c.telemetryOptOut));
        setCapability(c.capability);
      } catch (err) {
        setHealthError((err as Error).message);
      }
    })();
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Phase 3: when the mode pill changes, apply that plugin's default
  // filter preset. Users can still toggle individual types after.
  useEffect(() => {
    const preset = MODE_FILTER_PRESETS[activeMode] ?? null;
    if (preset) {
      setActiveTypes(new Set(preset));
    } else if (topology) {
      // "all" mode: everything checked.
      const all = new Set(topology.nodes.map((n) => n.type).filter(Boolean));
      setActiveTypes(all);
    } else {
      setActiveTypes(null);
    }
  }, [activeMode, topology]);

  // Keep project filter aligned with topology: default = all checked.
  useEffect(() => {
    if (topology && activeProjects === null) {
      const all = new Set(topology.nodes.map((n) => n.project ?? 'Global'));
      setActiveProjects(all);
    }
  }, [topology, activeProjects]);

  // Coalesce rapid focus requests (<200ms) to the last one only.
  const requestFocus = (nodeId: string): void => {
    if (focusCoalesceRef.current) window.clearTimeout(focusCoalesceRef.current);
    focusCoalesceRef.current = window.setTimeout(() => {
      setFocusNodeId(nodeId);
      focusCoalesceRef.current = null;
    }, 200);
  };

  // Cmd/Ctrl+1..9 cycles through Mode pills (All, then active plugins in order).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const n = parseInt(e.key, 10);
      if (Number.isNaN(n) || n < 1 || n > 9) return;
      const order = ['all', ...(health?.activePlugins ?? [])];
      const pick = order[n - 1];
      if (pick) {
        setActiveMode(pick);
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [health]);

  const toggleTheme = () => {
    const newTheme = theme === 'corporate' ? 'midnight' : 'corporate';
    setTheme(newTheme);
    if (newTheme === 'midnight') {
      document.documentElement.classList.add('theme-developer-midnight');
    } else {
      document.documentElement.classList.remove('theme-developer-midnight');
    }
  };

  // ── PATCH /api/config helpers ────────────────────────────────────
  const patchConfig = async (patch: Record<string, unknown>): Promise<void> => {
    try {
      const resp = await fetch(`${API_BASE}/api/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (resp.ok) {
        const next = (await resp.json()) as ConfigResponse;
        setHasApiKey(next.hasApiKey);
        setCapability(next.capability);
      }
    } catch (err) {
      console.error('config patch failed:', err);
    }
  };

  const handleProviderChange = (provider: LlmProvider): void => {
    setLlmProvider(provider);
    void patchConfig({ llmProvider: provider });
  };

  // Phase V2.1: Workspace switch UX. Daemon exits after writing the new
  // "active" field; launchd KeepAlive brings it back bound to the new
  // graph. We poll /api/health every 500ms until the new workspace name
  // is reported, then reload the page so Sigma + filters re-fetch fresh.
  const onWorkspaceSwitchStarted = (next: string): void => {
    setWorkspaceSwitching(next);
    const start = Date.now();
    const tick = async (): Promise<void> => {
      if (Date.now() - start > 20_000) {
        setWorkspaceSwitching(null);
        setHealthError('Workspace switch timed out after 20s');
        return;
      }
      try {
        const h = (await fetch(`${API_BASE}/api/health`).then((r) => r.json())) as HealthResponse;
        if (h.workspace === next) {
          window.location.reload();
          return;
        }
      } catch {
        // daemon mid-restart, keep polling
      }
      window.setTimeout(() => void tick(), 500);
    };
    window.setTimeout(() => void tick(), 800);
  };

  // ── Phase 2: file ingestion via /api/extract ────────────────────
  const triggerFilePicker = (): void => {
    fileInputRef.current?.click();
  };

  const onFileSelected = async (file: File): Promise<void> => {
    const isText = file.type.startsWith('text/') || /\.(md|txt)$/i.test(file.name);
    const content = isText ? await file.text() : await readFileAsBase64(file);
    const mimeType = file.type || (isText ? 'text/plain' : 'application/octet-stream');

    try {
      const resp = await fetch(`${API_BASE}/api/extract`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: file.name,
          mimeType,
          content,
          encoding: isText ? 'utf8' : 'base64',
        }),
      });
      const body = (await resp.json()) as ExtractResult;
      setLastExtract({ ...body, status: resp.status });
    } catch (err) {
      setLastExtract({
        accepted: false,
        filename: file.name,
        mimeType,
        reason: `Upload failed: ${(err as Error).message}`,
      });
    }
  };

  // V2.1: Graph reconnect — POST /api/graph/reconnect. Dry-run first
  // gives a proposed-edge count; the user re-clicks "Apply" to commit.
  const runReconnect = async (apply: boolean): Promise<void> => {
    setReconnectBusy(true);
    setReconnectMsg('Embedding + scoring…');
    try {
      const resp = await fetch(`${API_BASE}/api/graph/reconnect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ k: reconnectK, threshold: reconnectThreshold, apply }),
      });
      const body = (await resp.json()) as {
        proposedEdges: Array<unknown>;
        edgesInserted?: number;
        inferredPruned?: number;
        applied?: boolean;
      };
      if (apply) {
        setReconnectMsg(
          `✓ Pruned ${body.inferredPruned ?? 0}, inserted ${body.edgesInserted ?? 0} semantic_neighbor edges. Refreshing graph…`,
        );
        window.setTimeout(() => window.location.reload(), 1200);
      } else {
        setReconnectMsg(
          `${body.proposedEdges.length} edges proposed at threshold ${reconnectThreshold}. Click "Apply" to commit.`,
        );
      }
    } catch (err) {
      setReconnectMsg(`Failed: ${(err as Error).message}`);
    } finally {
      setReconnectBusy(false);
    }
  };

  const resolveOrphan = async (plugin: string, decision: OrphanDecision): Promise<void> => {
    let confirmValue: string | undefined;
    if (decision === 'drop') {
      // eslint-disable-next-line no-alert
      const typed = window.prompt(`Type DROP to permanently remove tables for "${plugin}":`);
      if (typed !== 'DROP') return;
      confirmValue = 'DROP';
    }
    try {
      const resp = await fetch(`${API_BASE}/api/orphan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plugin, decision, confirm: confirmValue }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      // Refresh health to clear the blocking modal.
      const h = (await fetch(`${API_BASE}/api/health`).then((r) => r.json())) as HealthResponse;
      setHealth(h);
    } catch (err) {
      setHealthError(`Orphan resolve failed: ${(err as Error).message}`);
    }
  };

  // Debounce API key PATCH to avoid keychain write on every keystroke.
  const handleApiKeyChange = (value: string): void => {
    setApiKey(value);
    if (patchTimer.current) window.clearTimeout(patchTimer.current);
    patchTimer.current = window.setTimeout(() => {
      if (value.length > 0) void patchConfig({ apiKey: value });
    }, 600);
  };

  // ── Chat / SSE streaming ─────────────────────────────────────────
  const sendMessage = async (): Promise<void> => {
    const text = input.trim();
    if (!text || streaming) return;
    const userMsg: ChatMessage = { id: `u-${Date.now()}`, role: 'user', text };
    const assistantId = `a-${Date.now()}`;
    setMessages((m) => [...m, userMsg, { id: assistantId, role: 'assistant', text: '', streaming: true }]);
    setInput('');
    setStreaming(true);

    try {
      const resp = await fetch(`${API_BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      });
      if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let gotError = false;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            try {
              const evt = JSON.parse(line.slice(6)) as { type: string; content?: string; message?: string; nodeId?: string };
              if (evt.type === 'focus' && evt.nodeId) {
                requestFocus(evt.nodeId);
              } else if (evt.type === 'token' && evt.content) {
                setMessages((m) => m.map((msg) => (msg.id === assistantId ? { ...msg, text: msg.text + evt.content } : msg)));
                // Phase 3: parse bracketed [node:ID] markers in the stream
                // so an LLM that emits them directly still triggers a pan.
                const nodeMatch = /\[node:([\w\-.:]+)\]/i.exec(evt.content ?? '');
                if (nodeMatch) requestFocus(nodeMatch[1]);
              } else if (evt.type === 'error') {
                gotError = true;
                setMessages((m) => m.map((msg) => (msg.id === assistantId ? { ...msg, text: evt.message ?? 'error', error: true, streaming: false } : msg)));
              } else if (evt.type === 'done') {
                setMessages((m) => m.map((msg) => (msg.id === assistantId ? { ...msg, streaming: false } : msg)));
              }
            } catch {
              // ignore malformed frame
            }
          }
        }
      }
      if (!gotError) {
        setMessages((m) => m.map((msg) => (msg.id === assistantId ? { ...msg, streaming: false } : msg)));
      }
    } catch (err) {
      setMessages((m) => m.map((msg) => (msg.id === assistantId ? { ...msg, text: `Chat failed: ${(err as Error).message}`, error: true, streaming: false } : msg)));
    } finally {
      setStreaming(false);
    }
  };

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void sendMessage();
    }
  };

  // Banner text = real health result, not hardcoded.
  const bannerText = healthError
    ? `Lore daemon unreachable: ${healthError}`
    : health
      ? `Lore V2 ${health.version} · plugins: ${health.activePlugins.join(', ')} · dataplane: ${health.dataplane}`
      : 'Contacting Lore daemon…';

  return (
    <div className="app-container">
      {/* Left Panel: Navigation & Chat */}
      <aside className="sidebar">
        <header className="sidebar-header">
          <WorkspacePicker apiBase={API_BASE} onSwitchStarted={onWorkspaceSwitchStarted} />
          <button className="icon-button" onClick={() => setShowSettings(!showSettings)} title="Settings">
            <Settings size={20} />
          </button>
        </header>

        <div className="chat-container">
          <div className="chat-history">
            <div className={`chat-message ai-message glass-panel${healthError ? ' chat-error' : ''}`}>
              <p>{bannerText}</p>
            </div>
            {llmProvider === 'embedded' ? (
              <div className="chat-message ai-message glass-panel nudge-banner">
                <p>
                  ⚠ Using the built-in <strong>Qwen 0.5B</strong> — usable, but small. For better
                  answers, add an API key (Anthropic / OpenAI) or switch to Ollama with a stronger
                  local model in <em>Settings</em>.
                </p>
              </div>
            ) : null}
            {messages.map((m) => (
              <div
                key={m.id}
                className={`chat-message glass-panel ${m.role === 'user' ? 'user-message' : 'ai-message'}${m.error ? ' chat-error' : ''}`}
              >
                <p>
                  {m.text}
                  {m.streaming ? <span className="cursor-blink">▌</span> : null}
                </p>
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>

          <div className="chat-input-area">
            <div className="input-wrapper glass-panel">
              <input
                type="text"
                placeholder={streaming ? 'Streaming…' : 'Query the knowledge graph…'}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onInputKeyDown}
                disabled={streaming}
              />
              <button className="send-button" onClick={() => void sendMessage()} disabled={streaming || !input.trim()}>
                <MessageSquare size={18} />
              </button>
            </div>
          </div>
        </div>
      </aside>

      {/* Graph Visualization Canvas Area */}
      <main className="canvas-area" style={{ position: 'relative' }}>
        {/* Phase 1: Mode pill-group. Renders one pill per active plugin + "All".
            Click or Cmd+1..9 to switch. Phase 3 wires filter preset, system
            prompt swap, and camera focus off this state. */}
        {health && health.activePlugins.length > 0 ? (
          <div className="mode-pills" role="tablist" aria-label="Mode">
            {(['all', ...health.activePlugins]).map((mode, idx) => (
              <button
                key={mode}
                role="tab"
                aria-selected={activeMode === mode}
                className={`mode-pill${activeMode === mode ? ' active' : ''}`}
                onClick={() => setActiveMode(mode)}
                title={`${mode === 'all' ? 'All modes' : mode} (⌘${idx + 1})`}
              >
                {mode === 'all' ? 'All' : mode.charAt(0).toUpperCase() + mode.slice(1)}
              </button>
            ))}
          </div>
        ) : null}

        {/* V2.1: Workspace-switch overlay — polls /api/health until the
            daemon comes back on the new workspace, then reloads. */}
        {workspaceSwitching ? (
          <div className="workspace-toast glass-panel" role="status">
            Switching to workspace “{workspaceSwitching}” — daemon restarting…
          </div>
        ) : null}

        {/* Orphan-decision modal. Server returns HTTP 503 on /api/* until
            resolved, and /api/health carries the orphans list. */}
        {health?.status === 'orphan_decision_required' && (health.orphans?.length ?? 0) > 0 ? (
          <div className="orphan-backdrop">
            <div className="orphan-modal glass-panel" role="dialog" aria-modal="true">
              <h3>Plugin decision required</h3>
              <p>
                The following plugin(s) were previously active but are no longer listed in
                <code> .lore/config.json</code>. Choose how to handle their on-disk data:
              </p>
              <ul className="orphan-list">
                {(health.orphans ?? []).map((p) => (
                  <li key={p}>
                    <strong>{p}</strong>
                    <div className="orphan-actions">
                      <button onClick={() => void resolveOrphan(p, 'keep')}>Keep on disk</button>
                      <button onClick={() => void resolveOrphan(p, 'reenable')}>Re-enable plugin</button>
                      <button className="danger" onClick={() => void resolveOrphan(p, 'drop')}>
                        Drop permanently
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
              <p className="help-text" style={{ fontSize: '0.75rem' }}>
                All <code>/api/*</code> calls are blocked until this is resolved.
              </p>
            </div>
          </div>
        ) : null}

        {useSigmaEngine ? (
          <SigmaCanvas
            activeTypes={activeTypes}
            activeProjects={activeProjects}
            focusNodeId={focusNodeId}
            onTopologyReady={(t) => setTopology(t)}
          />
        ) : (
          <GraphCanvas />
        )}

        {/* Dynamic Settings Sidebar (Slide-over) */}
        {showSettings && (
          <div className="settings-panel glass-panel">
            <h3>Configuration</h3>

            <div className="setting-group">
              <label>Theme</label>
              <button className="theme-toggle" onClick={toggleTheme}>
                {theme === 'corporate' ? <Moon size={16} /> : <Sun size={16} />}
                <span>{theme === 'corporate' ? 'Switch to Midnight' : 'Switch to Corporate'}</span>
              </button>
            </div>

            <div className="setting-group">
              <label>Renderer Engine (Beta)</label>
              <button className="theme-toggle" onClick={() => setUseSigmaEngine(!useSigmaEngine)}>
                <Network size={16} />
                <span>{useSigmaEngine ? 'Revert to Vis-Network' : 'Try Sigma WebGL Engine'}</span>
              </button>
            </div>

            <div className="setting-group">
              <label>LLM Provider (Local UI)</label>
              <select
                className="ui-select"
                value={llmProvider}
                onChange={(e) => handleProviderChange(e.target.value as LlmProvider)}
              >
                <option value="embedded">Built-in Qwen 0.5B (no setup)</option>
                <option value="anthropic">Anthropic API (BYOK)</option>
                <option value="openai">OpenAI API (BYOK)</option>
                <option value="ollama">Local Ollama (localhost:11434)</option>
              </select>
            </div>

            <div className="setting-group">
              <label>API Key {hasApiKey ? <span className="pill-ok">stored</span> : null}</label>
              <input
                type="password"
                placeholder={
                  llmProvider === 'ollama'
                    ? 'Not required for Ollama'
                    : llmProvider === 'embedded'
                      ? 'Not required for built-in Qwen'
                      : 'sk-…'
                }
                className="ui-input"
                value={apiKey}
                onChange={(e) => handleApiKeyChange(e.target.value)}
                disabled={llmProvider === 'ollama' || llmProvider === 'embedded'}
                autoComplete="off"
              />
              <p className="help-text" style={{ fontSize: '0.7rem', color: 'var(--color-text-muted)', marginTop: '0.25rem' }}>
                Stored in your OS keychain. Never written to disk or localStorage.
              </p>
            </div>

            {/* V2.1: Workspace switching moved to the top-left chip
                (WorkspacePicker). See the sidebar header above — the old
                "Workspace Account" dropdown was misleading for a data-
                space switch and has been removed. */}

            {/* Phase 2: Extraction Path (BYOK / greyed DEF Cloud) */}
            <div className="setting-group">
              <label>Extraction Path</label>
              <div className="radio-group">
                <label className="radio-option">
                  <input
                    type="radio"
                    name="extractionPath"
                    value="local-byok"
                    checked={extractionPath === 'local-byok'}
                    onChange={() => {
                      setExtractionPath('local-byok');
                      void patchConfig({ extractionPath: 'local-byok' });
                    }}
                  />
                  <span>
                    <strong>Local BYOK</strong>
                    <small>Your LLM handles everything. Graph stays on disk.</small>
                  </span>
                </label>
                <label className="radio-option disabled" title="Requires Groundfloor Cloud sign-in (coming soon)">
                  <input type="radio" name="extractionPath" value="def-cloud" disabled />
                  <span>
                    <strong>Groundfloor DEF (Cloud)</strong>
                    <small>Requires Groundfloor Cloud sign-in (coming soon)</small>
                  </span>
                </label>
              </div>
            </div>

            {/* Phase 2: Active Plugins read-out */}
            <div className="setting-group">
              <label>Active Plugins</label>
              <div className="plugins-list">
                {(health?.activePlugins ?? []).map((p) => (
                  <span key={p} className="plugin-badge">{p}</span>
                ))}
                {(health?.activePlugins.length ?? 0) === 0 ? (
                  <span className="help-text">No plugins active — edit .lore/config.json</span>
                ) : null}
              </div>
              <p className="help-text">
                Change by editing <code>.lore/config.json</code> and restarting the daemon.
              </p>
            </div>

            {/* Phase 2: Ingest File (BYOK) */}
            <div className="setting-group">
              <label>Ingest File (BYOK)</label>
              <input
                ref={fileInputRef}
                type="file"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void onFileSelected(f);
                  if (fileInputRef.current) fileInputRef.current.value = '';
                }}
              />
              <button className="theme-toggle" onClick={triggerFilePicker}>
                <span>Choose a file…</span>
              </button>
              {capability ? (
                <p className="help-text">
                  Accepted by <code>{capability.model}</code>: {capability.acceptedMimeTypes.join(', ')}
                </p>
              ) : null}
              {lastExtract ? (
                <div className={`extract-result${lastExtract.accepted ? ' ok' : ' err'}`}>
                  <strong>{lastExtract.accepted ? '✓ Accepted' : '✗ Rejected'}</strong> {lastExtract.filename}
                  {lastExtract.reason ? <div className="help-text">{lastExtract.reason}</div> : null}
                  {lastExtract.plan?.preview ? (
                    <div className="help-text" style={{ marginTop: '0.25rem' }}>
                      {lastExtract.plan.chunks ? `${lastExtract.plan.chunks} chunk(s) — ` : ''}
                      {lastExtract.plan.preview}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>

            {/* V2.1: Graph reconnect — compute semantic_neighbor edges */}
            <div className="setting-group">
              <label>Graph Connections</label>
              <p className="help-text">
                Connects LoreNodes by semantic similarity via the verbatim
                store. Dry-run shows a count; Apply prunes prior inferred
                edges and inserts the fresh batch.
              </p>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button
                  className="theme-toggle"
                  onClick={() => void runReconnect(false)}
                  disabled={reconnectBusy}
                >
                  <span>{reconnectBusy ? 'Working…' : 'Dry run'}</span>
                </button>
                <button
                  className="theme-toggle"
                  onClick={() => void runReconnect(true)}
                  disabled={reconnectBusy}
                  style={{ background: 'rgba(20, 184, 166, 0.12)' }}
                >
                  <span>Apply</span>
                </button>
              </div>
              {reconnectMsg ? (
                <p className="help-text" style={{ marginTop: '0.4rem' }}>{reconnectMsg}</p>
              ) : null}

              <button
                className="filter-show-more"
                onClick={() => setReconnectAdvanced((v) => !v)}
                style={{ marginTop: '0.5rem' }}
              >
                {reconnectAdvanced ? 'Hide advanced' : 'Advanced…'}
              </button>
              {reconnectAdvanced ? (
                <div style={{ marginTop: '0.4rem' }}>
                  <label className="help-text" style={{ display: 'block' }}>
                    K (nearest neighbors per node): {reconnectK}
                  </label>
                  <input
                    type="range"
                    min={2}
                    max={10}
                    step={1}
                    value={reconnectK}
                    onChange={(e) => setReconnectK(Number(e.target.value))}
                    style={{ width: '100%' }}
                  />
                  <label className="help-text" style={{ display: 'block', marginTop: '0.3rem' }}>
                    Threshold: {reconnectThreshold.toFixed(2)}
                  </label>
                  <input
                    type="range"
                    min={0.4}
                    max={0.9}
                    step={0.01}
                    value={reconnectThreshold}
                    onChange={(e) => setReconnectThreshold(Number(e.target.value))}
                    style={{ width: '100%' }}
                  />
                </div>
              ) : null}
            </div>

            {/* Phase 2: Telemetry opt-out (stub, Phase 4 consumes it) */}
            <div className="setting-group">
              <label>Telemetry</label>
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={telemetryOptOut}
                  onChange={(e) => {
                    setTelemetryOptOut(e.target.checked);
                    void patchConfig({ telemetryOptOut: e.target.checked });
                  }}
                />
                <span>Opt out of Dataplane health-ping</span>
              </label>
              <p className="help-text">
                Persisted today; Phase 4 will honor this at boot.
              </p>
            </div>

            <button className="icon-button close-settings" onClick={() => setShowSettings(false)}>
              ✕
            </button>
          </div>
        )}
      </main>

      {/* Phase 3: Right panel — filters driven by /api/topology */}
      <FiltersPanel
        topology={topology}
        activeTypes={activeTypes ?? new Set()}
        setActiveTypes={(next) => setActiveTypes(next)}
        activeProjects={activeProjects ?? new Set()}
        setActiveProjects={(next) => setActiveProjects(next)}
      />
    </div>
  );
}

export default App;
