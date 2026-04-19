import { useCallback, useEffect, useRef, useState, lazy, Suspense } from 'react';
import { Settings, MessageSquare, Moon, Sun, PanelLeft, PanelRight } from 'lucide-react';
import FiltersPanel, { type TopologyLike } from './components/FiltersPanel';
import WorkspacePicker from './components/WorkspacePicker';
import NodeDetailDrawer from './components/NodeDetailDrawer';
import { authFetch } from './lib/authFetch';
import './App.css';

// V2.1: code-split the graph renderer. Sigma.js + graphology adds ~180 KB
// gzipped; lazy-loading keeps the initial app bundle small. The Suspense
// fallback shows a brief "Loading canvas…" while the chunk arrives.
const SigmaCanvas = lazy(() => import('./components/SigmaCanvas'));

function CanvasLoadingFallback() {
  return (
    <div style={{
      position: 'absolute',
      inset: 0,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: 'var(--color-text-muted)',
      fontSize: '0.9rem',
    }}>
      Loading canvas…
    </div>
  );
}

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
  /** V2.1: first-run Qwen download progress overlay. */
  loading?: {
    file?: string;
    progress: number; // 0..1
  };
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

  // V2.1 note: Mode pills removed. Workspace chip (WorkspacePicker) is
  // the only context switcher. Intra-workspace scoping happens through
  // the Projects filter in the right panel.

  // Phase 2: Dual-path extraction settings + last upload result (rendered
  // beneath the file input so the user sees what the server decided).
  const [extractionPath, setExtractionPath] = useState<'local-byok' | 'def-cloud'>('local-byok');
  const [telemetryOptOut, setTelemetryOptOut] = useState(false);
  const [capability, setCapability] = useState<ConfigResponse['capability'] | null>(null);
  const [lastExtract, setLastExtract] = useState<ExtractResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // V2.1: collapsible panels (persisted in localStorage)
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => {
    try { return localStorage.getItem('lore.sidebarOpen') !== 'false'; } catch { return true; }
  });
  const [filtersOpen, setFiltersOpen] = useState<boolean>(() => {
    try { return localStorage.getItem('lore.filtersOpen') !== 'false'; } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem('lore.sidebarOpen', sidebarOpen ? 'true' : 'false'); } catch { /* ignore */ }
  }, [sidebarOpen]);
  useEffect(() => {
    try { localStorage.setItem('lore.filtersOpen', filtersOpen ? 'true' : 'false'); } catch { /* ignore */ }
  }, [filtersOpen]);

  // V2.1: drag-drop visual cue
  const [dragOver, setDragOver] = useState(false);

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

  // V2.1: node-click detail drawer state.
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const chatInputRef = useRef<HTMLInputElement | null>(null);

  // Debug hatch: dev-tools / headless test can call
  // window.__lore_selectNode(id) to open the drawer without a Sigma click.
  // Shipped intentionally because the cost is one typed global and it's
  // genuinely useful for QA scripts.
  useEffect(() => {
    (window as unknown as { __lore_selectNode?: (id: string) => void }).__lore_selectNode = setSelectedNodeId;
    return () => {
      delete (window as unknown as { __lore_selectNode?: (id: string) => void }).__lore_selectNode;
    };
  }, []);

  // ── Initial load: fetch /api/health + /api/config ────────────────
  useEffect(() => {
    void (async () => {
      try {
        const [h, c] = await Promise.all([
          authFetch(`${API_BASE}/api/health`).then((r) => r.json() as Promise<HealthResponse>),
          authFetch(`${API_BASE}/api/config`).then((r) => r.json() as Promise<ConfigResponse>),
        ]);
        setHealth(h);
        setLlmProvider(c.llmProvider);
        setHasApiKey(c.hasApiKey);
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

  // V2.1: initialize type filter to all-checked once topology loads.
  // User can uncheck individual types in the right panel to scope the
  // view; no mode preset logic anymore.
  useEffect(() => {
    if (topology && activeTypes === null) {
      const all = new Set(topology.nodes.map((n) => n.type).filter(Boolean));
      setActiveTypes(all);
    }
  }, [topology, activeTypes]);

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

  // Stable handler identities for SigmaCanvas. Inline arrows change
  // every render, which would (a) refetch /api/topology on every App
  // render once onTopologyReady is in GraphLoader's deps, and
  // (b) cause ClickEvents to re-register listeners every render.
  const handleTopologyReady = useCallback((t: TopologyLike) => {
    setTopology(t);
  }, []);
  const handleNodeClick = useCallback((nodeId: string) => {
    setSelectedNodeId(nodeId);
  }, []);

  // V2.1: Cmd/Ctrl+1..9 mode cycling removed with the mode pill-group.
  // Future keyboard shortcuts (focus chat, toggle filters) can live here.

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
      const resp = await authFetch(`${API_BASE}/api/config`, {
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
        const h = (await authFetch(`${API_BASE}/api/health`).then((r) => r.json())) as HealthResponse;
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

  // V2.1: "Ask about this" — pre-fill the chat with a [node:id] marker
  // and focus the input. Server /api/chat expands the marker into
  // system-prompt context (node content + immediate neighbors).
  const askAboutNode = (nodeId: string): void => {
    // Plugin-owned nodes use their prefix as the marker kind.
    // Core nodes get the `lore:` prefix to disambiguate.
    const marker = nodeId.includes(':') ? nodeId : `lore:${nodeId}`;
    const prefill = `[node:${marker}] `;
    setInput((curr) => (curr.startsWith(prefill) ? curr : prefill + curr));
    window.setTimeout(() => chatInputRef.current?.focus(), 50);
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
      const resp = await authFetch(`${API_BASE}/api/extract`, {
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

  // V2.1: Graph reconnect / reconsume.
  // - `reconnect`: dry-run by default; Apply prunes+inserts semantic edges.
  // - `reconsume`: always applies, with enriched file+symbol embeddings
  //   (re-reads node content into the vector store before edge routing).
  const runReconnect = async (mode: 'dry' | 'apply' | 'reconsume'): Promise<void> => {
    setReconnectBusy(true);
    setReconnectMsg(mode === 'reconsume' ? 'Re-embedding every node + reconnecting…' : 'Embedding + scoring…');
    try {
      const endpoint = mode === 'reconsume' ? '/api/graph/reconsume' : '/api/graph/reconnect';
      const resp = await authFetch(`${API_BASE}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          k: reconnectK,
          threshold: reconnectThreshold,
          ...(mode === 'apply' ? { apply: true } : {}),
        }),
      });
      const body = (await resp.json()) as {
        proposedEdges: Array<unknown>;
        applied?: boolean;
        prunedByTable?: { loreEdge: number; touchesFile: number; appliesToCode: number };
        edgesInsertedByTable?: { loreEdge: number; touchesFile: number; appliesToCode: number };
      };
      if (mode === 'dry') {
        setReconnectMsg(
          `${body.proposedEdges.length} edges proposed at threshold ${reconnectThreshold.toFixed(2)}. Click "Apply" to commit.`,
        );
      } else {
        const ins = body.edgesInsertedByTable ?? { loreEdge: 0, touchesFile: 0, appliesToCode: 0 };
        const total = ins.loreEdge + ins.touchesFile + ins.appliesToCode;
        setReconnectMsg(
          `✓ Inserted ${total}: ${ins.loreEdge} lore↔lore · ${ins.touchesFile} lore→file · ${ins.appliesToCode} lore→symbol. Refreshing…`,
        );
        window.setTimeout(() => window.location.reload(), 1400);
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
      const typed = window.prompt(`Type DROP to permanently remove tables for "${plugin}":`);
      if (typed !== 'DROP') return;
      confirmValue = 'DROP';
    }
    try {
      const resp = await authFetch(`${API_BASE}/api/orphan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plugin, decision, confirm: confirmValue }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      // Refresh health to clear the blocking modal.
      const h = (await authFetch(`${API_BASE}/api/health`).then((r) => r.json())) as HealthResponse;
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
      const resp = await authFetch(`${API_BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      });
      if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let gotError = false;
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
              const evt = JSON.parse(line.slice(6)) as {
                type: string;
                content?: string;
                message?: string;
                nodeId?: string;
                file?: string;
                progress?: number;
                status?: string;
              };
              if (evt.type === 'focus' && evt.nodeId) {
                requestFocus(evt.nodeId);
              } else if (evt.type === 'model_loading') {
                // V2.1: Qwen first-run download progress.
                setMessages((m) =>
                  m.map((msg) =>
                    msg.id === assistantId
                      ? {
                          ...msg,
                          loading: {
                            file: evt.file,
                            progress: typeof evt.progress === 'number' ? evt.progress : 0,
                          },
                        }
                      : msg,
                  ),
                );
              } else if (evt.type === 'token' && evt.content) {
                setMessages((m) =>
                  m.map((msg) =>
                    msg.id === assistantId
                      ? { ...msg, text: msg.text + evt.content, loading: undefined }
                      : msg,
                  ),
                );
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

  // V2.1: drag-drop handlers — one file at a time through /api/extract.
  // Handles both chat and canvas drop zones; rejects surface as an
  // error-styled chat bubble so the user sees the capability mismatch.
  const onDrop = async (e: React.DragEvent<HTMLElement>): Promise<void> => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    const sysId = `s-${Date.now()}`;
    setMessages((m) => [...m, { id: sysId, role: 'system', text: `Uploading ${file.name}…` }]);
    await onFileSelected(file);
    // `lastExtract` just got set inside onFileSelected; mirror it into chat.
    window.setTimeout(() => {
      setLastExtract((le) => {
        if (!le) return le;
        const bubble: ChatMessage = {
          id: `s-${Date.now()}`,
          role: 'assistant',
          text: le.accepted
            ? `✓ Ingested ${le.filename}${le.plan?.chunks ? ` — ${le.plan.chunks} chunk(s)` : ''}`
            : `✗ ${le.filename} rejected: ${le.reason ?? 'unknown reason'}`,
          error: !le.accepted,
        };
        setMessages((m) => m.filter((x) => x.id !== sysId).concat(bubble));
        return le;
      });
    }, 50);
  };

  const onDragOver = (e: React.DragEvent<HTMLElement>): void => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    setDragOver(true);
  };

  const onDragLeave = (): void => setDragOver(false);

  // Banner text = real health result, not hardcoded.
  const bannerText = healthError
    ? `Lore daemon unreachable: ${healthError}`
    : health
      ? `Lore V2 ${health.version} · plugins: ${health.activePlugins.join(', ')} · dataplane: ${health.dataplane}`
      : 'Contacting Lore daemon…';

  return (
    <div className="app-container">
      {/* Left Panel: Navigation & Chat */}
      {sidebarOpen ? (
      <aside
        className="sidebar"
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={(e) => void onDrop(e)}
      >
        <header className="sidebar-header">
          <WorkspacePicker apiBase={API_BASE} onSwitchStarted={onWorkspaceSwitchStarted} />
          <div style={{ display: 'flex', gap: '0.25rem' }}>
            <button className="icon-button" onClick={() => setShowSettings(!showSettings)} title="Settings">
              <Settings size={20} />
            </button>
            <button className="icon-button" onClick={() => setSidebarOpen(false)} title="Hide chat panel">
              <PanelLeft size={18} />
            </button>
          </div>
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
                {m.loading ? (
                  <div className="model-loading">
                    <p style={{ margin: 0, fontSize: '0.85rem' }}>
                      Downloading model… {m.loading.file ? <code>{m.loading.file}</code> : null}
                    </p>
                    <div className="progress-bar">
                      <div
                        className="progress-bar-fill"
                        style={{ width: `${Math.round(m.loading.progress * 100)}%` }}
                      />
                    </div>
                    <small>{Math.round(m.loading.progress * 100)}% — runs fully offline after download</small>
                  </div>
                ) : (
                  <p>
                    {m.text}
                    {m.streaming ? <span className="cursor-blink">▌</span> : null}
                  </p>
                )}
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>

          <div className="chat-input-area">
            <div className="input-wrapper glass-panel">
              <input
                ref={chatInputRef}
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
      ) : null}

      {/* Graph Visualization Canvas Area */}
      <main
        className={`canvas-area${dragOver ? ' drag-over' : ''}`}
        style={{ position: 'relative' }}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={(e) => void onDrop(e)}
      >
        {/* V2.1: mode pill-group removed. Workspace chip (WorkspacePicker
            in the sidebar) is the only context switcher; per-project
            scoping is the Projects filter in the right panel. */}

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

        <Suspense fallback={<CanvasLoadingFallback />}>
          <SigmaCanvas
            activeTypes={activeTypes}
            activeProjects={activeProjects}
            focusNodeId={focusNodeId}
            onTopologyReady={handleTopologyReady}
            onNodeClick={handleNodeClick}
          />
        </Suspense>

        {/* V2.1: node-click detail drawer. `key` forces a fresh instance
            per selected node so stale fetch results never render under a
            newer id — cleaner than tracking "detail-for-id" in state. */}
        <NodeDetailDrawer
          key={selectedNodeId ?? 'closed'}
          apiBase={API_BASE}
          selectedNodeId={selectedNodeId}
          onClose={() => setSelectedNodeId(null)}
          onAskAbout={(id) => {
            askAboutNode(id);
            setSelectedNodeId(null);
          }}
        />

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
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                <button
                  className="theme-toggle"
                  onClick={() => void runReconnect('dry')}
                  disabled={reconnectBusy}
                >
                  <span>{reconnectBusy ? 'Working…' : 'Dry run'}</span>
                </button>
                <button
                  className="theme-toggle"
                  onClick={() => void runReconnect('apply')}
                  disabled={reconnectBusy}
                  style={{ background: 'rgba(20, 184, 166, 0.12)' }}
                >
                  <span>Apply</span>
                </button>
                <button
                  className="theme-toggle"
                  onClick={() => void runReconnect('reconsume')}
                  disabled={reconnectBusy}
                  style={{ background: 'rgba(245, 158, 11, 0.12)' }}
                  title="Re-read every node's content, re-embed, and rebuild the semantic layer"
                >
                  <span>Reconsume</span>
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
        {/* V2.1: Floating panel-toggle chevrons. Visible when a side
            panel is collapsed so the user can reopen it. */}
        {!sidebarOpen ? (
          <button
            className="panel-reopen left"
            onClick={() => setSidebarOpen(true)}
            title="Show chat panel"
          >
            <PanelLeft size={16} />
          </button>
        ) : null}
        {!filtersOpen ? (
          <button
            className="panel-reopen right"
            onClick={() => setFiltersOpen(true)}
            title="Show filters panel"
          >
            <PanelRight size={16} />
          </button>
        ) : null}

        {/* Drag overlay */}
        {dragOver ? (
          <div className="drop-overlay">
            <div className="drop-overlay-card glass-panel">
              <p>Drop to ingest</p>
              {capability ? (
                <small>
                  {capability.model} accepts: {capability.acceptedMimeTypes.join(', ')}
                </small>
              ) : null}
            </div>
          </div>
        ) : null}
      </main>

      {/* Phase 3: Right panel — filters driven by /api/topology */}
      {filtersOpen ? (
        <aside className="filters-panel-wrapper">
          <div className="filters-panel-toolbar">
            <button
              className="icon-button"
              onClick={() => setFiltersOpen(false)}
              title="Hide filters panel"
            >
              <PanelRight size={16} />
            </button>
          </div>
          <FiltersPanel
            topology={topology}
            activeTypes={activeTypes ?? new Set()}
            setActiveTypes={(next) => setActiveTypes(next)}
            activeProjects={activeProjects ?? new Set()}
            setActiveProjects={(next) => setActiveProjects(next)}
          />
        </aside>
      ) : null}
    </div>
  );
}

export default App;
