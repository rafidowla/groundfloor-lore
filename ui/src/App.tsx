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
}

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
      } catch (err) {
        setHealthError((err as Error).message);
      }
    })();
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

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
