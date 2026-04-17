import { useEffect, useRef, useState } from 'react';
import { Settings, MessageSquare, Network, Moon, Sun } from 'lucide-react';
import GraphCanvas from './components/GraphCanvas';
import SigmaCanvas from './components/SigmaCanvas';
import './App.css';

// Backend daemon base URL. The MCP server listens on 127.0.0.1:3847 in --http mode.
const API_BASE = (import.meta as unknown as { env?: { VITE_LORE_API?: string } }).env?.VITE_LORE_API ?? 'http://127.0.0.1:3847';

type LlmProvider = 'anthropic' | 'openai' | 'ollama';

interface HealthResponse {
  status: string;
  version: string;
  activePlugins: string[];
  defaultMode: string;
  llmProvider: LlmProvider;
  workspaceAccount: string;
  dataplane: 'bound' | 'offline';
  orphans?: string[];
}

type OrphanDecision = 'keep' | 'drop' | 'reenable';

interface ConfigResponse {
  plugins: string[];
  defaultMode: string;
  llmProvider: LlmProvider;
  workspaceAccount: string;
  hasApiKey: boolean;
  capability: { provider: string; model: string; acceptsText: boolean; acceptsImages: boolean };
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  streaming?: boolean;
  error?: boolean;
}

function App() {
  const [theme, setTheme] = useState<'corporate' | 'midnight'>('corporate');
  const [showSettings, setShowSettings] = useState(false);
  const [useSigmaEngine, setUseSigmaEngine] = useState(true);

  // Config state (Phase 0 wiring)
  const [llmProvider, setLlmProvider] = useState<LlmProvider>('anthropic');
  const [apiKey, setApiKey] = useState('');
  const [workspaceAccount, setWorkspaceAccount] = useState('local');
  const [hasApiKey, setHasApiKey] = useState(false);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);

  // Chat state
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const patchTimer = useRef<number | null>(null);

  // Phase 1: Mode pill-group state. "all" shows every plugin's nodes;
  // otherwise the value matches one entry in health.activePlugins.
  const [activeMode, setActiveMode] = useState<string>('all');
  const [workspaceToast, setWorkspaceToast] = useState<string | null>(null);

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
        setWorkspaceAccount(c.workspaceAccount);
        setHasApiKey(c.hasApiKey);
        setActiveMode(c.defaultMode || 'all');
      } catch (err) {
        setHealthError((err as Error).message);
      }
    })();
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

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
      }
    } catch (err) {
      console.error('config patch failed:', err);
    }
  };

  const handleProviderChange = (provider: LlmProvider): void => {
    setLlmProvider(provider);
    void patchConfig({ llmProvider: provider });
  };

  const handleWorkspaceChange = (account: string): void => {
    setWorkspaceAccount(account);
    void patchConfig({ workspaceAccount: account });
    // Workspace switches are a restart-required operation (each workspace
    // maps to a separate .lore/ directory). Surface a toast so the user
    // knows the daemon still serves the prior workspace until reboot.
    setWorkspaceToast(`Workspace switched to "${account}" — restart the Lore daemon to apply.`);
    window.setTimeout(() => setWorkspaceToast(null), 6000);
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
              const evt = JSON.parse(line.slice(6)) as { type: string; content?: string; message?: string };
              if (evt.type === 'token' && evt.content) {
                setMessages((m) => m.map((msg) => (msg.id === assistantId ? { ...msg, text: msg.text + evt.content } : msg)));
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
          <div className="logo-area">
            <Network className="logo-icon" size={24} />
            <span className="logo-text">Lore Explorer</span>
          </div>
          <button className="icon-button" onClick={() => setShowSettings(!showSettings)} title="Settings">
            <Settings size={20} />
          </button>
        </header>

        <div className="chat-container">
          <div className="chat-history">
            <div className={`chat-message ai-message glass-panel${healthError ? ' chat-error' : ''}`}>
              <p>{bannerText}</p>
            </div>
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

        {/* Workspace-switched toast */}
        {workspaceToast ? (
          <div className="workspace-toast glass-panel" role="status">
            {workspaceToast}
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

        {useSigmaEngine ? <SigmaCanvas /> : <GraphCanvas />}

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
                <option value="anthropic">Anthropic API (BYOK)</option>
                <option value="openai">OpenAI API (BYOK)</option>
                <option value="ollama">Local Ollama (localhost:11434)</option>
              </select>
            </div>

            <div className="setting-group">
              <label>API Key {hasApiKey ? <span className="pill-ok">stored</span> : null}</label>
              <input
                type="password"
                placeholder={llmProvider === 'ollama' ? 'Not required for Ollama' : 'sk-…'}
                className="ui-input"
                value={apiKey}
                onChange={(e) => handleApiKeyChange(e.target.value)}
                disabled={llmProvider === 'ollama'}
                autoComplete="off"
              />
              <p className="help-text" style={{ fontSize: '0.7rem', color: 'var(--color-text-muted)', marginTop: '0.25rem' }}>
                Stored in your OS keychain. Never written to disk or localStorage.
              </p>
            </div>

            <div className="setting-group">
              <label>Workspace Account</label>
              <div className="account-switcher">
                <select
                  className="ui-select"
                  value={workspaceAccount}
                  onChange={(e) => handleWorkspaceChange(e.target.value)}
                >
                  <option value="local">Personal Local Account</option>
                  <option value="div" disabled>
                    ─── Cloud Workspaces ───
                  </option>
                  <option value="login">+ Connect Groundfloor Cloud</option>
                </select>
                <p className="help-text" style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginTop: '0.25rem' }}>
                  Keep your lore local, or log in to sync with an enterprise Dataplane.
                </p>
              </div>
            </div>

            <button className="icon-button close-settings" onClick={() => setShowSettings(false)}>
              ✕
            </button>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
