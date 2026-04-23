import { useCallback, useEffect, useRef, useState, lazy, Suspense } from 'react';
import { Settings, MessageSquare, Moon, Sun, PanelLeft, PanelRight } from 'lucide-react';
import FiltersPanel, { type TopologyLike } from './components/FiltersPanel';
import WorkspacePicker from './components/WorkspacePicker';
import NodeDetailDrawer from './components/NodeDetailDrawer';
import { ChatMarkdown } from './components/ChatMarkdown';
import { authFetch } from './lib/authFetch';
import 'highlight.js/styles/github-dark.css';
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
  llmProvider: LlmProvider;
  workspace: string;
  dataplane: 'bound' | 'offline';
  orphans?: string[];
}

type OrphanDecision = 'keep' | 'drop' | 'reenable';

interface ConfigResponse {
  plugins: string[];
  llmProvider: LlmProvider;
  hasApiKey: boolean;
  extractionPath?: 'local-byok' | 'def-cloud';
  telemetryOptOut?: boolean;
  keepEmbeddedModelHot?: boolean;
  autoExecuteChatActions?: boolean;
  capability: {
    provider: string;
    model: string;
    acceptsText: boolean;
    acceptsImages: boolean;
    acceptedMimeTypes: string[];
    /** V2.2 plumbing: UI branches on this when rendering chat actions.
     *  'native' → future native tool-calling path.
     *  'suggestion_only' → parse {{action:...}} tokens into buttons.
     *  'none' → pure text, no structured output expected. */
    toolCalling: 'native' | 'suggestion_only' | 'none';
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
  /** V2.2: node references attached via "Ask about this". Render as
   *  pills above the bubble; not part of the text body itself. */
  nodeRefs?: Array<{ marker: string; label: string | null }>;
  /** V2.2: action-suggestion buttons parsed from the assistant's
   *  {{action:...}} tokens. Null when the message contains no actions
   *  (text-only answer). Preserves insertion order so buttons appear
   *  below the text in the order the LLM emitted them. */
  actions?: Array<{
    action: string;
    params: Record<string, string>;
    label: string;
  }>;
  /** V2.2: if this assistant message is itself the result of a
   *  user-confirmed action click, carry the metadata so the UI can
   *  style it as a "system confirmation" instead of normal LLM chat. */
  isActionResult?: boolean;
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
  const [languageBreakdown, setLanguageBreakdown] = useState<Record<string, number> | null>(null);
  const [workspaceSwitching, setWorkspaceSwitching] = useState<string | null>(null);

  // Chat state
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const patchTimer = useRef<number | null>(null);

  // V2.2: pending node references added via "Ask about this". These
  // render as removable pills above the chat input; on send they get
  // serialised back into [node:...] markers so the server's existing
  // context-expansion path is unchanged.
  const [pendingNodeRefs, setPendingNodeRefs] = useState<
    Array<{ marker: string; label: string | null }>
  >([]);
  // Small in-memory label cache so re-referencing a node doesn't refetch.
  const nodeLabelCache = useRef<Map<string, string>>(new Map());

  // V2.1 note: Mode pills removed. Workspace chip (WorkspacePicker) is
  // the only context switcher. Intra-workspace scoping happens through
  // the Projects filter in the right panel.

  // Phase 2: Dual-path extraction settings + last upload result (rendered
  // beneath the file input so the user sees what the server decided).
  const [extractionPath, setExtractionPath] = useState<'local-byok' | 'def-cloud'>('local-byok');
  const [telemetryOptOut, setTelemetryOptOut] = useState(false);
  const [keepEmbeddedModelHot, setKeepEmbeddedModelHot] = useState(false);
  const [autoExecuteChatActions, setAutoExecuteChatActions] = useState(false);
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
  // C1 — confidence filter. Inferred edges are the majority in a
  // reconnect-heavy workspace; toggle them off for a "known facts only"
  // view. Default on so first paint matches what the user had before.
  const [showInferred, setShowInferred] = useState<boolean>(true);
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
  // Opening the Node Detail Drawer must also close Settings — they
  // both anchor at top-right and would otherwise visually collide.
  // Closing the drawer (id = null) leaves Settings alone.
  const openNodeDrawer = useCallback((nodeId: string | null) => {
    setSelectedNodeId(nodeId);
    if (nodeId !== null) setShowSettings(false);
  }, []);

  // V2.2: click-outside-to-close for the Settings panel. Same pattern
  // NodeDetailDrawer uses. The gear button itself must be excluded
  // from the outside check (otherwise opening flashes shut immediately).
  const settingsPanelRef = useRef<HTMLDivElement | null>(null);
  const settingsButtonRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!showSettings) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (settingsPanelRef.current?.contains(target)) return;
      if (settingsButtonRef.current?.contains(target)) return;
      setShowSettings(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showSettings]);

  useEffect(() => {
    (window as unknown as { __lore_selectNode?: (id: string) => void }).__lore_selectNode = openNodeDrawer as (id: string) => void;
    return () => {
      delete (window as unknown as { __lore_selectNode?: (id: string) => void }).__lore_selectNode;
    };
  }, [openNodeDrawer]);

  // ── Initial load: fetch /api/health + /api/config ────────────────
  useEffect(() => {
    void (async () => {
      try {
        const [h, c, s] = await Promise.all([
          authFetch(`${API_BASE}/api/health`).then((r) => r.json() as Promise<HealthResponse>),
          authFetch(`${API_BASE}/api/config`).then((r) => r.json() as Promise<ConfigResponse>),
          authFetch(`${API_BASE}/api/stats`).then((r) => r.json() as Promise<{ languageBreakdown?: Record<string, number> }>).catch(() => ({})),
        ]);
        setHealth(h);
        setLlmProvider(c.llmProvider);
        setHasApiKey(c.hasApiKey);
        setExtractionPath(c.extractionPath ?? 'local-byok');
        setTelemetryOptOut(Boolean(c.telemetryOptOut));
        setKeepEmbeddedModelHot(Boolean(c.keepEmbeddedModelHot));
        setAutoExecuteChatActions(Boolean(c.autoExecuteChatActions));
        setCapability(c.capability);
        setLanguageBreakdown(s?.languageBreakdown ?? null);
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
    openNodeDrawer(nodeId);
  }, [openNodeDrawer]);

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

  // V2.2: parse {{action:name|key=value|...}} tokens out of an LLM
  // response. Returns the cleaned text (tokens removed) plus the
  // extracted actions array in emit order.
  //
  // Defensive: unknown action names are dropped silently (never
  // rendered as a button) — prevents a hallucinated action from
  // producing a clickable dead-end. Server-side whitelist is the
  // authoritative check; this is a client-side pre-filter.
  const KNOWN_ACTIONS = new Set(['reconnect_node', 'open_reconnect_settings']);
  const ACTION_TOKEN_RE = /\{\{action:([^}]+)\}\}/g;
  const extractActions = (rawText: string): {
    cleaned: string;
    actions: Array<{ action: string; params: Record<string, string>; label: string }>;
  } => {
    const actions: Array<{ action: string; params: Record<string, string>; label: string }> = [];
    const cleaned = rawText.replace(ACTION_TOKEN_RE, (_full, inner: string) => {
      // inner shape: "name|key=value|key=value"
      const parts = inner.split('|').map((s) => s.trim()).filter(Boolean);
      if (parts.length === 0) return '';
      const action = parts[0];
      if (!KNOWN_ACTIONS.has(action)) return ''; // drop unknown action
      const params: Record<string, string> = {};
      for (let i = 1; i < parts.length; i++) {
        const eq = parts[i].indexOf('=');
        if (eq < 0) continue;
        const key = parts[i].slice(0, eq).trim();
        const value = parts[i].slice(eq + 1).trim();
        if (key) params[key] = value;
      }
      const label = params['label'] || 'Run action';
      actions.push({ action, params, label });
      return '';
    });
    return { cleaned: cleaned.replace(/\n\n+/g, '\n\n').trim(), actions };
  };

  // V2.2: execute an action button. POSTs to /api/chat/action, shows
  // the result as a new assistant message styled as an action-result
  // confirmation. Errors surface the same way (error styling).
  const runChatAction = useCallback(async (action: string, params: Record<string, string>): Promise<void> => {
    const resultId = `a-action-${Date.now()}`;
    setMessages((m) => [...m, { id: resultId, role: 'assistant', text: 'Running…', streaming: true, isActionResult: true }]);
    try {
      // For reconnect_node, the param key from the LLM is `id`; map to
      // the server's expected `nodeId`. For open_reconnect_settings,
      // no params needed — handle UI-side below.
      let serverParams: Record<string, unknown> = {};
      if (action === 'reconnect_node') {
        serverParams = { nodeId: params['id'] ?? '' };
      }

      const resp = await authFetch(`${API_BASE}/api/chat/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, params: serverParams }),
      });
      const body = await resp.json() as {
        ok?: boolean;
        error?: string;
        edgesAdded?: number;
        label?: string;
        uiHint?: { openPanel?: string; scrollTo?: string };
      };

      if (!resp.ok || !body.ok) {
        setMessages((m) => m.map((msg) => msg.id === resultId ? { ...msg, text: `Action failed: ${body.error ?? `HTTP ${resp.status}`}`, streaming: false, error: true } : msg));
        return;
      }

      // Success — compose a concise confirmation message.
      let confirmText = '';
      if (action === 'reconnect_node') {
        const n = body.edgesAdded ?? 0;
        confirmText = `✓ Reconnected **${body.label ?? params['id']}**. ${n === 0 ? 'No new edges — the node was already well-connected.' : `Added ${n} semantic_neighbor edge${n === 1 ? '' : 's'}.`}`;
      } else if (action === 'open_reconnect_settings') {
        setShowSettings(true);
        setSelectedNodeId(null);
        confirmText = '✓ Opened Settings. Scroll to **Graph Connections** for the Dry run / Apply / Reconsume controls.';
      } else {
        confirmText = `✓ Action "${action}" completed.`;
      }

      setMessages((m) => m.map((msg) => msg.id === resultId ? { ...msg, text: confirmText, streaming: false } : msg));
    } catch (err) {
      setMessages((m) => m.map((msg) => msg.id === resultId ? { ...msg, text: `Action failed: ${(err as Error).message}`, streaming: false, error: true } : msg));
    }
  }, []);

  // V2.2: specialized prompt for "Generate docs for this node." Sends
  // the node reference as a pill + a doc-request instruction that
  // asks the LLM for a structured Markdown document. The chat bubble
  // renders via the existing ChatMarkdown pipeline, so code blocks,
  // tables, and Mermaid diagrams all render correctly.
  //
  // Quality depends entirely on the active LLM. Embedded Gemma 1B
  // will produce a short stub; BYOK Claude / GPT-4o produces full
  // Markdown with diagrams when the node content supports it. The
  // UI doesn't gate on capability — the user sees what their model
  // produces, which is the honest signal.
  const DOCS_PROMPT = (
    'Produce comprehensive developer-facing documentation for the node(s) attached to this conversation. Structure as Markdown with these sections:\n\n' +
    '1. **Overview** — 1-2 paragraphs describing what this node represents.\n' +
    '2. **Key Concepts** — bullet list of important terms and ideas.\n' +
    '3. **Relationships** — how this connects to other systems or knowledge.\n' +
    '4. **Code References** — if the node mentions files or line numbers, list them as a Markdown table (file | lines | purpose).\n' +
    '5. **Diagram** — include a ```mermaid code block with a diagram if the node describes architecture, flows, or relationships. Skip this section if a diagram would not add value.\n' +
    '6. **Usage / Context** — when and how this knowledge applies.\n\n' +
    'Cite any claims with [node-id] markers. Do not invent details that are not in the provided context.'
  );
  const generateDocsFor = useCallback((nodeId: string): void => {
    const marker = nodeId.includes(':') ? nodeId : `lore:${nodeId}`;
    setPendingNodeRefs((refs) => {
      if (refs.some((r) => r.marker === marker)) return refs;
      const cached = nodeLabelCache.current.get(marker) ?? null;
      return [...refs, { marker, label: cached }];
    });
    // Prefill input with the docs request. User can edit before send
    // OR hit send as-is. Deliberately not auto-sending — one extra
    // click is the safety belt against accidental invocations.
    setInput((curr) => (curr ? curr : DOCS_PROMPT));
    window.setTimeout(() => chatInputRef.current?.focus(), 50);
  }, []);

  // V2.2: Save an assistant message body as a .md file. Browser-side
  // only — no server round-trip. Filename derives from the first
  // non-empty heading or falls back to a timestamp. No external deps.
  const downloadAssistantMessageAsMarkdown = useCallback((text: string): void => {
    if (!text) return;
    // Try to pull a filename from the first ATX heading.
    const headingMatch = /^#{1,6}\s+(.+?)\s*$/m.exec(text);
    const slug = (headingMatch ? headingMatch[1] : '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `${slug || 'lore-chat'}-${stamp}.md`;
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, []);

  // V2.2: "Ask about this" — add the node as a removable pill above
  // the chat input instead of stuffing a [node:id] marker into the
  // textbox. On send (see sendMessage) the pending refs get serialised
  // back into markers so the server's context-expansion path is
  // unchanged. Label is fetched async; pill shows raw marker until then.
  const askAboutNode = (nodeId: string): void => {
    // Plugin-owned nodes use their prefix as the marker kind.
    // Core nodes get the `lore:` prefix to disambiguate.
    const marker = nodeId.includes(':') ? nodeId : `lore:${nodeId}`;
    setPendingNodeRefs((refs) => {
      if (refs.some((r) => r.marker === marker)) return refs;
      const cached = nodeLabelCache.current.get(marker) ?? null;
      return [...refs, { marker, label: cached }];
    });

    // Fetch the label if not cached. Non-plugin (lore:) refs only —
    // plugin-owned nodes (file:, symbol:) don't have /api/node yet.
    if (marker.startsWith('lore:')) {
      const rawId = marker.slice('lore:'.length);
      if (!nodeLabelCache.current.has(marker)) {
        void authFetch(`${API_BASE}/api/node?id=${encodeURIComponent(rawId)}`)
          .then((r) => r.json())
          .then((detail: { node?: { label?: string } }) => {
            const label = detail?.node?.label ?? null;
            if (label) {
              nodeLabelCache.current.set(marker, label);
              setPendingNodeRefs((refs) =>
                refs.map((r) => (r.marker === marker ? { ...r, label } : r)),
              );
            }
          })
          .catch(() => { /* leave label null; pill still works */ });
      }
    }

    window.setTimeout(() => chatInputRef.current?.focus(), 50);
  };

  const removePendingNodeRef = useCallback((marker: string): void => {
    setPendingNodeRefs((refs) => refs.filter((r) => r.marker !== marker));
  }, []);

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
    // Allow send when EITHER the user typed text OR they have pending
    // node refs — "Ask about this" with no added text is a valid query.
    if ((!text && pendingNodeRefs.length === 0) || streaming) return;

    // Serialise pending refs back into [node:...] markers so the
    // server's existing context-expansion path works unchanged.
    const markerPrefix = pendingNodeRefs
      .map((r) => `[node:${r.marker}]`)
      .join(' ');
    const wireMessage = markerPrefix
      ? (text ? `${markerPrefix} ${text}` : markerPrefix)
      : text;

    // Display in the user bubble: clean text (or fallback if no text)
    // plus the pills as structured refs. Don't put markers in the
    // visible text body — that's what caused the ugly [node:…] in the
    // chat log before.
    const userMsg: ChatMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      text: text || (pendingNodeRefs.length > 0 ? 'Ask about this' : ''),
      nodeRefs: pendingNodeRefs.length > 0 ? [...pendingNodeRefs] : undefined,
    };
    const assistantId = `a-${Date.now()}`;
    setMessages((m) => [...m, userMsg, { id: assistantId, role: 'assistant', text: '', streaming: true }]);
    setInput('');
    setPendingNodeRefs([]);
    setStreaming(true);

    try {
      const resp = await authFetch(`${API_BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: wireMessage }),
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
                // V2.2: on stream completion, parse action tokens out
                // of the accumulated text and surface them as buttons.
                // When autoExecuteChatActions is ON AND the active
                // capability is native-tier, skip the button render
                // and execute each action immediately. Embedded
                // (suggestion_only) ALWAYS uses buttons regardless of
                // the toggle — safety property documented in
                // ToolCapability type.
                const isNativeTier = capability?.toolCalling === 'native';
                const shouldAutoExec = isNativeTier && autoExecuteChatActions;

                setMessages((m) => m.map((msg) => {
                  if (msg.id !== assistantId) return msg;
                  const { cleaned, actions } = extractActions(msg.text);
                  if (actions.length > 0 && shouldAutoExec) {
                    // Fire-and-forget per extracted action. Each runs
                    // runChatAction which inserts its own result bubble.
                    actions.forEach((a) => { void runChatAction(a.action, a.params); });
                    return { ...msg, text: cleaned, streaming: false };
                  }
                  return {
                    ...msg,
                    text: cleaned,
                    streaming: false,
                    ...(actions.length > 0 ? { actions } : {}),
                  };
                }));
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
          <div className="logo-area" title="Groundfloor Lore — local-first knowledge graph">
            <img src="/favicon.svg" alt="" width="22" height="22" className="brand-mark" />
            <span className="brand-wordmark">Lore</span>
          </div>
          <WorkspacePicker apiBase={API_BASE} onSwitchStarted={onWorkspaceSwitchStarted} />
          <div style={{ display: 'flex', gap: '0.25rem' }}>
            <button
              ref={settingsButtonRef}
              className="icon-button"
              onClick={() => {
                // Settings + Node Detail Drawer both anchor at top-right;
                // keep them mutually exclusive so neither obscures the
                // other. Opening Settings closes the drawer.
                const next = !showSettings;
                setShowSettings(next);
                if (next) setSelectedNodeId(null);
              }}
              title="Settings"
            >
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
                  ⚠ Using the built-in <strong>Gemma 3 1B</strong> — usable, but small. For richer
                  answers, docs, or diagrams, add an API key (Anthropic / OpenAI) or switch to Ollama
                  with a stronger local model in <em>Settings</em>. The embedded model idle-unloads
                  after 3 minutes to save memory — toggle in Settings if you prefer it always hot.
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
                  <>
                    {m.nodeRefs && m.nodeRefs.length > 0 ? (
                      <div className="node-ref-pills message-refs">
                        {m.nodeRefs.map((r) => (
                          <span key={r.marker} className="node-ref-pill" title={r.marker}>
                            <span className="node-ref-pill-label">{r.label ?? r.marker}</span>
                          </span>
                        ))}
                      </div>
                    ) : null}
                    {m.role === 'assistant' ? (
                      // Assistant bubbles render as Markdown — so
                      // BYOK models' code blocks, tables, and
                      // ```mermaid diagrams actually show up.
                      // During streaming we still show the cursor
                      // inline with the rendered output.
                      <div className={`chat-markdown-wrap${m.isActionResult ? ' action-result' : ''}`}>
                        <ChatMarkdown source={m.text || ''} />
                        {m.streaming ? <span className="cursor-blink">▌</span> : null}
                        {m.actions && m.actions.length > 0 ? (
                          <div className="chat-actions">
                            {m.actions.map((a, i) => (
                              <button
                                key={`${a.action}-${i}`}
                                type="button"
                                className="chat-action-btn"
                                onClick={() => void runChatAction(a.action, a.params)}
                                title={`Action: ${a.action}`}
                              >
                                {a.label}
                              </button>
                            ))}
                          </div>
                        ) : null}
                        {/* V2.2: Save as .md on every completed
                            assistant message. Hidden during streaming;
                            hidden on banner-role system messages;
                            hidden on empty bodies. */}
                        {!m.streaming && m.text && m.text.length > 10 ? (
                          <button
                            type="button"
                            className="chat-save-md"
                            onClick={() => downloadAssistantMessageAsMarkdown(m.text)}
                            title="Download this message as a Markdown file"
                          >
                            Save as .md
                          </button>
                        ) : null}
                      </div>
                    ) : (
                      // User bubbles stay plain text — the user
                      // typed it, don't re-interpret Markdown syntax
                      // they didn't mean.
                      <p>
                        {m.text}
                        {m.streaming ? <span className="cursor-blink">▌</span> : null}
                      </p>
                    )}
                  </>
                )}
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>

          <div className="chat-input-area">
            <div className="input-wrapper glass-panel">
              {pendingNodeRefs.length > 0 ? (
                <div className="node-ref-pills">
                  {pendingNodeRefs.map((r) => (
                    <span key={r.marker} className="node-ref-pill removable" title={r.marker}>
                      <button
                        type="button"
                        className="node-ref-pill-remove"
                        aria-label={`Remove ${r.label ?? r.marker}`}
                        onClick={() => removePendingNodeRef(r.marker)}
                      >
                        ×
                      </button>
                      <span className="node-ref-pill-label">{r.label ?? r.marker}</span>
                    </span>
                  ))}
                </div>
              ) : null}
              <div className="input-wrapper-row">
                <input
                  ref={chatInputRef}
                  type="text"
                  placeholder={
                    streaming
                      ? 'Streaming…'
                      : pendingNodeRefs.length > 0
                        ? 'Ask a follow-up… (or send as-is)'
                        : 'Query the knowledge graph…'
                  }
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={onInputKeyDown}
                  disabled={streaming}
                />
                <button
                  className="send-button"
                  onClick={() => void sendMessage()}
                  disabled={streaming || (!input.trim() && pendingNodeRefs.length === 0)}
                >
                  <MessageSquare size={18} />
                </button>
              </div>
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
            showInferred={showInferred}
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
          onGenerateDocs={(id) => {
            generateDocsFor(id);
            setSelectedNodeId(null);
          }}
        />

        {/* Dynamic Settings Sidebar (Slide-over) */}
        {showSettings && (
          <div className="settings-panel glass-panel" ref={settingsPanelRef}>
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
                <option value="embedded">Built-in Gemma 3 1B (no setup)</option>
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
                      ? 'Not required for built-in Gemma'
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

            {/* V2.2: Embedded model memory behavior. Only shown when the
                embedded provider is selected — BYOK / Ollama don't load
                a local pipeline so the toggle is irrelevant there. */}
            {llmProvider === 'embedded' ? (
              <div className="setting-group">
                <label>Embedded model memory</label>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={keepEmbeddedModelHot}
                    onChange={(e) => {
                      setKeepEmbeddedModelHot(e.target.checked);
                      void patchConfig({ keepEmbeddedModelHot: e.target.checked });
                    }}
                  />
                  <span>Keep Gemma 3 1B in memory when idle</span>
                </label>
                <p className="help-text" style={{ fontSize: '0.7rem', color: 'var(--color-text-muted)', marginTop: '0.25rem' }}>
                  OFF (default): model idle-unloads after 3 min of no
                  queries — saves ~1.5 GB RAM. Next query reloads in
                  ~5-10s. ON: model stays resident for instant
                  responses; holds ~1.5 GB permanently. Pick ON if you
                  have plenty of RAM and chat frequently.
                </p>
              </div>
            ) : null}

            {/* V2.2: auto-execute action tokens for native-tier BYOK
                models only. Embedded (suggestion_only) ALWAYS uses
                click-to-confirm buttons regardless of this toggle —
                safety property so small-model action hallucinations
                can't fire automatically. */}
            {capability?.toolCalling === 'native' ? (
              <div className="setting-group">
                <label>Chat action execution</label>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={autoExecuteChatActions}
                    onChange={(e) => {
                      setAutoExecuteChatActions(e.target.checked);
                      void patchConfig({ autoExecuteChatActions: e.target.checked });
                    }}
                  />
                  <span>Auto-execute chat action suggestions</span>
                </label>
                <p className="help-text" style={{ fontSize: '0.7rem', color: 'var(--color-text-muted)', marginTop: '0.25rem' }}>
                  OFF (default): every action suggestion renders as a
                  button; you click to run. ON: action tokens from your
                  BYOK LLM auto-execute — faster, but you trust the
                  model not to propose bad actions. Embedded Gemma 1B
                  always uses the button path regardless of this
                  setting. Every action, button or auto, goes through
                  the same server whitelist and is audit-logged.
                </p>
              </div>
            ) : null}

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

            {/* Phase A (V2.2) — corpus language breakdown. Read-only
                display of how many LoreNodes are tagged with each
                language, plus how many are untagged (key "null"). See
                docs/LANGUAGE_DETECTION.md: tagging is an explicit
                caller opt-in; untagged counts are expected when
                plugins or AI agents don't bother to pass `language`. */}
            {languageBreakdown && Object.keys(languageBreakdown).length > 0 ? (
              <div className="setting-group">
                <label>Corpus Languages</label>
                <div className="plugins-list">
                  {Object.entries(languageBreakdown)
                    .sort(([, a], [, b]) => b - a)
                    .map(([lang, count]) => (
                      <span
                        key={lang}
                        className="plugin-badge"
                        title={lang === 'null' ? 'Untagged — treated as English / default' : `Explicitly tagged as ${lang}`}
                      >
                        {lang === 'null' ? 'untagged' : lang.toUpperCase()}: {count}
                      </span>
                    ))}
                </div>
                <p className="help-text">
                  Tagging is explicit — see docs/LANGUAGE_DETECTION.md.
                  Use the <code>detect_language</code> MCP tool or
                  <code> POST /api/language/detect</code> before ingest
                  if you want non-default tagging.
                </p>
              </div>
            ) : null}

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
            showInferred={showInferred}
            setShowInferred={setShowInferred}
          />
        </aside>
      ) : null}
    </div>
  );
}

export default App;
