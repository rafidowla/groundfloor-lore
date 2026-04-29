import { useCallback, useEffect, useRef, useState, lazy, Suspense } from 'react';
import { Settings, MessageSquare, Moon, Sun, PanelLeft, PanelRight, FolderGit2, GitBranchPlus, Boxes, Table, SlidersHorizontal } from 'lucide-react';
import FiltersPanel, { type TopologyLike } from './components/FiltersPanel';
import WorkspacePicker from './components/WorkspacePicker';
import NodeDetailDrawer from './components/NodeDetailDrawer';
import ProjectsPanel from './components/ProjectsPanel';
import ChordDiagram from './components/ChordDiagram';
import SunburstDiagram from './components/SunburstDiagram';
import SupersessionCandidatesModal from './components/SupersessionCandidatesModal';
import { ChatMarkdown } from './components/ChatMarkdown';
import { A2uiRenderer } from './components/A2uiRenderer';
import { authFetch } from './lib/authFetch';
import 'highlight.js/styles/github-dark.css';
import './App.css';

// V2.1: code-split the graph renderer. Sigma.js + graphology adds ~180 KB
// gzipped; lazy-loading keeps the initial app bundle small. The Suspense
// fallback shows a brief "Loading canvas…" while the chunk arrives.
const SigmaCanvas = lazy(() => import('./components/SigmaCanvas'));
const PluginWizard = lazy(() => import('./components/PluginWizard'));
const PluginInspectors = lazy(() => import('./components/PluginInspectors'));
const PluginSettingsPanel = lazy(() => import('./components/PluginSettingsPanel'));

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

// Phase 3: Graph Size Limit.
//
// The UI slider offers 5k / 10k / 20k. The server enforces a firm 20k
// hard cap regardless of what the client asks for (packages/lore/src/
// mcp/server.ts — /api/topology handler). 20k is the ceiling because
// ForceAtlas2 is CPU-bound and scales non-linearly; above ~20k the
// browser tab hangs long enough to feel broken.
//
// Default is auto-detected from navigator.hardwareConcurrency.
// Detection is deliberately coarse — we can't distinguish M1 from M4,
// and navigator.deviceMemory is Chrome/Edge only. The goal is a sane
// first-paint default, not a perfect benchmark; users can move the
// slider if the default is wrong for their machine.
// 2026-04-27: added 2000 + 3000 as smaller options after observing
// /api/topology takes 28s for 15k+ node payloads (server-side N+1 in
// contributeDeveloperTopology). Until that's fixed, smaller defaults
// keep the app feeling responsive.
const GRAPH_SIZE_OPTIONS = [2000, 3000, 5000, 10000, 20000] as const;
type GraphSize = typeof GRAPH_SIZE_OPTIONS[number];
const GRAPH_SIZE_STORAGE_KEY = 'lore.graphSizeLimit';

function detectDefaultGraphSize(): GraphSize {
  // Lowered defaults 2026-04-27. Pre-fix, even Apple Silicon defaulted to
  // 20k → 28s topology fetches. 3k loads in ~6s and is enough for the
  // overview + drill-in flow. Users can opt up via Settings.
  return 3000;
}

function loadGraphSizeLimit(): GraphSize {
  if (typeof localStorage === 'undefined') return detectDefaultGraphSize();
  const raw = localStorage.getItem(GRAPH_SIZE_STORAGE_KEY);
  const parsed = Number(raw);
  if (GRAPH_SIZE_OPTIONS.includes(parsed as GraphSize)) return parsed as GraphSize;
  return detectDefaultGraphSize();
}

type LlmProvider = 'embedded' | 'anthropic' | 'openai' | 'ollama';

interface HealthResponse {
  status: string;
  version: string;
  activePlugins: string[];
  llmProvider: LlmProvider;
  workspace: string;
  dataplane: 'bound' | 'offline';
  orphans?: string[];
  manifestHotReload?: {
    addedSinceBoot: number;
    reloadedSinceBoot: number;
    needsRestartForCoreEnums: boolean;
    namesHotLoaded: string[];
  };
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
  /** V2.2: which provider produced this bubble. Set from the SSE
   *  `start` event. Used to render a provider label + decide whether
   *  to show the "Try with BYOK" escalate button on embedded bubbles. */
  provider?: LlmProvider;
  /** V2.2: user's current thumbs rating for this bubble. Set on
   *  click, clearable by clicking the same thumb again. Persisted
   *  server-side via POST /api/feedback — UI copy here is just the
   *  current selection state. */
  rating?: 'up' | 'down' | null;
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
  const [showPluginWizard, setShowPluginWizard] = useState(false);
  const [showPluginInspectors, setShowPluginInspectors] = useState(false);
  const [showPluginSettings, setShowPluginSettings] = useState(false);
  const [showProjects, setShowProjects] = useState(false);
  const [showSupersedeCandidates, setShowSupersedeCandidates] = useState(false);
  // 2026-04-27 v2: chord = overview (default landing); network = drill-in.
  // Click an arc in chord → switches to network filtered to that project.
  // Network "back" → returns to chord. (User feedback: "is that better UX?
  // Yes.")
  type GraphViz = 'network' | 'chord' | 'sunburst';
  type OverviewViz = 'chord' | 'sunburst';
  const [graphViz, setGraphViz] = useState<GraphViz>(() => {
    try { return (localStorage.getItem('lore.graphViz') as GraphViz) ?? 'chord'; } catch { return 'chord'; }
  });
  // When set, network view is forced into project mode for this repo.
  // null means user is in either chord (overview) or network's own
  // top-level (full / Sigma's overview).
  const [drilledProject, setDrilledProject] = useState<string | null>(null);
  useEffect(() => {
    try { localStorage.setItem('lore.graphViz', graphViz); } catch { /* ignore */ }
  }, [graphViz]);
  // 2026-04-27 regression auto-recover: if user has stale graphViz='network'
  // in localStorage but isn't drilled into a project, the network top-level
  // view is no longer reachable in the new UX (chord = overview). Force
  // back to chord so they don't get stuck.
  useEffect(() => {
    if (graphViz === 'network' && !drilledProject) {
      // No drilled project but network mode → fall back to last overview
      // viz (chord by default).
      let last: OverviewViz = 'chord';
      try {
        const saved = localStorage.getItem('lore.overviewViz') as OverviewViz | null;
        if (saved && ['chord', 'sunburst'].includes(saved)) last = saved;
      } catch { /* ignore */ }
      setGraphViz(last);
    }
    // Only run on mount + when drilledProject changes; avoid infinite loop
    // by not depending on graphViz here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drilledProject]);
  const handleChordProjectClick = useCallback((project: string, type?: string) => {
    setDrilledProject(project);
    setGraphViz('network');
    // Optional type narrowing: when the user clicks an outer (type)
    // slice in the sunburst, set activeTypes to just that one. Other
    // type checkboxes appear unchecked but can be re-enabled in the
    // right panel. When type is omitted (chord arc, inner sunburst
    // ring), clear activeTypes so all types render.
    if (type) {
      setActiveTypes(new Set([type]));
    } else {
      setActiveTypes(null);
    }
    // 2026-04-27 multi-project drill: check ONLY the drilled project
    // initially. The right panel still lists every project (its source
    // is `topology`, not `activeProjects`), so the user can toggle
    // others on to expand the network into a multi-project view. The
    // server-side ?projects=a,b,c flow then fetches the union.
    setActiveProjects(new Set([project]));
  }, []);
  const handleExitProjectMode = useCallback(() => {
    setDrilledProject(null);
    // Restore the user's last overview viz (chord / sunburst / pack / tree).
    let last: OverviewViz = 'chord';
    try {
      const saved = localStorage.getItem('lore.overviewViz') as OverviewViz | null;
      if (saved && ['chord', 'sunburst'].includes(saved)) last = saved;
    } catch { /* ignore */ }
    setGraphViz(last);
    // Reset the panel selection to "all projects" so the next drill-in
    // starts from a clean slate.
    setActiveProjects(null);
  }, []);

  // Config state (Phase 0 wiring)
  const [llmProvider, setLlmProvider] = useState<LlmProvider>('embedded');
  const [apiKey, setApiKey] = useState('');
  const [hasApiKey, setHasApiKey] = useState(false);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [languageBreakdown, setLanguageBreakdown] = useState<Record<string, number> | null>(null);
  // V2.2: feedback aggregate for Settings display. Lazily fetched
  // when the Settings panel opens.
  const [feedbackStats, setFeedbackStats] = useState<{
    windowDays: number;
    totalCount: number;
    providerBreakdown: Record<string, { up: number; down: number; total: number; upRate: number }>;
    modelBreakdown: Record<string, { up: number; down: number; total: number; upRate: number }>;
  } | null>(null);
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
  // V2.2: dismiss flag for the pre-send complexity hint. Resets when
  // the user clears the input (length 0) — next complex query gets a
  // fresh chance to show the hint.
  const [complexityHintDismissed, setComplexityHintDismissed] = useState(false);
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
  // Soft-supersession: hide superseded nodes from the network view by
  // default. Toggle in the right panel surfaces them faded with a
  // virtual arrow to their replacement.
  const [showSuperseded, setShowSuperseded] = useState<boolean>(false);
  const [activeProjects, setActiveProjects] = useState<Set<string> | null>(null);
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
  const focusCoalesceRef = useRef<number | null>(null);

  // Phase 3: Graph Size Limit — user-adjustable ceiling passed to
  // /api/topology as ?limit=N. Persisted to localStorage; defaults to
  // a hardware-heuristic auto-detect on first visit. The SigmaCanvas
  // useEffect dep array watches graphSizeLimit, so changes refetch
  // automatically — no imperative reload needed.
  const [graphSizeLimit, setGraphSizeLimit] = useState<GraphSize>(() => loadGraphSizeLimit());

  // Retention policy state. Lazy-loaded when settings open.
  type RetentionPolicy = {
    hideSupersededInRecall: boolean;
    hideSupersededInGraph: boolean;
    autoArchiveSupersededAfterDays: number | null;
  };
  const [retentionPolicy, setRetentionPolicy] = useState<RetentionPolicy | null>(null);
  const [retentionSaving, setRetentionSaving] = useState(false);
  const [retentionSweepResult, setRetentionSweepResult] = useState<{ eligible: number; archived: number } | null>(null);
  const fetchRetention = useCallback(async () => {
    try {
      const r = await authFetch(`${API_BASE}/api/workspace/retention`);
      if (!r.ok) return;
      const d = await r.json() as RetentionPolicy;
      setRetentionPolicy(d);
    } catch { /* ignore */ }
  }, []);
  const updateRetention = useCallback(async (patch: Partial<RetentionPolicy>) => {
    setRetentionSaving(true);
    try {
      const r = await authFetch(`${API_BASE}/api/workspace/retention`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json() as RetentionPolicy;
      setRetentionPolicy(d);
    } finally {
      setRetentionSaving(false);
    }
  }, []);
  const runRetentionSweepNow = useCallback(async (dryRun: boolean) => {
    setRetentionSaving(true);
    try {
      const r = await authFetch(`${API_BASE}/api/workspace/retention/sweep`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json() as { eligible: number; archived: number };
      setRetentionSweepResult({ eligible: d.eligible, archived: d.archived });
    } finally {
      setRetentionSaving(false);
    }
  }, []);
  useEffect(() => {
    if (showSettings && !retentionPolicy) void fetchRetention();
  }, [showSettings, retentionPolicy, fetchRetention]);
  // Tag filter: when non-null, /api/topology fetches only repos with this tag.
  // List of available tags loaded from /api/repos/tags on mount + after edits.
  const [tagFilter, setTagFilter] = useState<string | null>(() => {
    try { return localStorage.getItem('lore.tagFilter'); } catch { return null; }
  });
  const [availableTags, setAvailableTags] = useState<Array<{ tag: string; repos: string[] }>>([]);
  useEffect(() => {
    try { if (tagFilter) localStorage.setItem('lore.tagFilter', tagFilter); else localStorage.removeItem('lore.tagFilter'); } catch { /* ignore */ }
  }, [tagFilter]);
  useEffect(() => {
    void authFetch(`${API_BASE}/api/repos/tags`)
      .then((r) => r.json() as Promise<{ tags: Array<{ tag: string; repos: string[] }> }>)
      .then((d) => setAvailableTags(d.tags ?? []))
      .catch(() => setAvailableTags([]));
  }, []);

  // 2026-04-27 multi-project drill: workspace-wide project list, fetched
  // once. The right-panel uses this so every project stays visible after
  // drill-in (otherwise the panel collapses to just the drilled project
  // since /api/topology only returns its slice).
  const [workspaceProjects, setWorkspaceProjects] = useState<
    Array<{ project: string; nodeCount: number }> | null
  >(null);
  useEffect(() => {
    void authFetch(`${API_BASE}/api/topology/overview?groupBy=project`)
      .then((r) => r.json() as Promise<{ blobs: Array<{ project: string; nodeCount: number }> }>)
      .then((d) => setWorkspaceProjects(d.blobs ?? []))
      .catch(() => setWorkspaceProjects(null));
  }, []);

  // Q1.6 — A2UI view-stack. Canvas defaults to the graph; a {{render:
  // component|json}} token from the LLM swaps it to an overlaid
  // renderer slot. SigmaCanvas stays mounted underneath (display
  // toggle) so "back to graph" is instant, and re-renders don't pay
  // a ForceAtlas2 re-layout cost on every round trip.
  const [canvasView, setCanvasView] = useState<
    | 'graph'
    | { kind: 'a2ui'; id: string; component: string; props: Record<string, unknown> }
  >('graph');

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

  // V2.2: fetch feedback stats when Settings panel opens. Fire-and-
  // forget; failures render as "no data yet."
  useEffect(() => {
    if (!showSettings) return;
    void authFetch(`${API_BASE}/api/feedback/stats?days=30`)
      .then((r) => r.ok ? r.json() as Promise<typeof feedbackStats> : null)
      .then((data) => { if (data) setFeedbackStats(data); })
      .catch(() => { /* leave null */ });
  }, [showSettings]);

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
          authFetch(`${API_BASE}/api/stats`).then((r) => r.json() as Promise<{ languageBreakdown?: Record<string, number> }>).catch(() => ({} as { languageBreakdown?: Record<string, number> })),
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
  //
  // Q1.6: additionally parse {{render:component|json}} tokens — the
  // A2UI view-stack hook. `component` is whitelisted too; the payload
  // is a raw JSON object (NOT key=value pairs) because analytical
  // projections return nested structures (columns array, rows array).
  // When present, the canvas swaps from `graph` to an `a2ui` slot
  // displaying the renderer with the parsed props. Tokens that fail
  // to parse (invalid JSON, unknown component) are dropped silently.
  const KNOWN_ACTIONS = new Set(['reconnect_node', 'open_reconnect_settings']);
  const ACTION_TOKEN_RE = /\{\{action:([^}]+)\}\}/g;
  // Render tokens use a LAZY match for the JSON body (`.*?`) so
  // multiple tokens in one message each get parsed independently.
  // The `s` flag lets the payload span newlines — LLMs sometimes
  // pretty-print the JSON.
  const KNOWN_RENDERERS = new Set(['table', 'bar_chart']);
  const RENDER_TOKEN_RE = /\{\{render:([a-z_]+)\|(.*?)\}\}/gs;
  const extractActions = (rawText: string): {
    cleaned: string;
    actions: Array<{ action: string; params: Record<string, string>; label: string }>;
    renders: Array<{ id: string; component: string; props: Record<string, unknown> }>;
  } => {
    const actions: Array<{ action: string; params: Record<string, string>; label: string }> = [];
    const renders: Array<{ id: string; component: string; props: Record<string, unknown> }> = [];
    // Strip render tokens first so an action regex can't accidentally
    // swallow a brace from inside a JSON body.
    const afterRender = rawText.replace(RENDER_TOKEN_RE, (_full, component: string, payload: string) => {
      if (!KNOWN_RENDERERS.has(component)) return '';
      let props: Record<string, unknown>;
      try {
        props = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        return ''; // drop malformed render token
      }
      const id = `r-${Date.now()}-${renders.length}`;
      renders.push({ id, component, props });
      return '';
    });
    const cleaned = afterRender.replace(ACTION_TOKEN_RE, (_full, inner: string) => {
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
    return { cleaned: cleaned.replace(/\n\n+/g, '\n\n').trim(), actions, renders };
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

  // V2.2: record a thumbs-up / thumbs-down rating on an assistant
  // bubble. Optimistic local update; server record is fire-and-
  // forget (failed POSTs just log to console, UI stays consistent).
  // Clicking the currently-selected thumb clears the rating.
  const submitFeedback = useCallback(async (messageId: string, nextRating: 'up' | 'down'): Promise<void> => {
    let serverRating: 'up' | 'down' | null = nextRating;
    setMessages((m) => m.map((msg) => {
      if (msg.id !== messageId) return msg;
      const prior = msg.rating ?? null;
      const resolved = prior === nextRating ? null : nextRating;
      serverRating = resolved;
      return { ...msg, rating: resolved };
    }));
    // Only POST when we're SETTING a rating (not when we're clearing).
    // Server aggregate() dedups per messageId keeping the latest, so
    // a cleared rating can't be expressed — we just stop counting it
    // locally. v1 acceptable; a full "delete my rating" API comes
    // later if the signal becomes important.
    if (serverRating === null) return;
    // Find the message to grab provider/model/query context.
    const msg = messages.find((m) => m.id === messageId);
    if (!msg) return;
    // Query hash is computed server-side from the preceding user
    // message's text — best-effort lookup.
    const idx = messages.findIndex((m) => m.id === messageId);
    const precedingUser = idx > 0 ? [...messages.slice(0, idx)].reverse().find((m) => m.role === 'user') : undefined;
    try {
      await authFetch(`${API_BASE}/api/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageId,
          rating: serverRating,
          provider: msg.provider ?? 'unknown',
          model: capability?.model ?? 'unknown',
          query: precedingUser?.text ?? '',
          responseLength: msg.text.length,
        }),
      });
    } catch (err) {
      console.warn('[feedback] post failed:', (err as Error).message);
    }
  }, [messages, capability]);

  // V2.2: escalate an assistant bubble — re-run the user message
  // that produced it, but through a different (typically BYOK)
  // provider. Preserves node refs so the context is identical.
  //
  // Finds the most recent user message BEFORE the assistant bubble
  // being escalated. If the bubble is from a replay/action result
  // (no preceding user turn), escalation is a no-op — the button is
  // hidden in that case, but belt-and-suspenders here too.
  const escalateAssistantMessage = useCallback((assistantMsgId: string, targetProvider: LlmProvider): void => {
    setMessages((m) => {
      const idx = m.findIndex((msg) => msg.id === assistantMsgId);
      if (idx <= 0) return m;
      // Walk backward to find the preceding user message
      for (let i = idx - 1; i >= 0; i--) {
        const userMsg = m[i];
        if (userMsg.role === 'user') {
          // Kick off the replay outside the state updater so React
          // doesn't see a sendMessage call during render. Queue with
          // a microtask.
          void Promise.resolve().then(() => {
            void sendMessage({
              forceProvider: targetProvider,
              replayText: userMsg.text,
              replayRefs: userMsg.nodeRefs ?? [],
              replayLabel: `↻ ${userMsg.text}`,
            });
          });
          break;
        }
      }
      return m;
    });
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
  const sendMessage = async (
    opts?: {
      /** V2.2 escalate: override the active llmProvider for THIS one
       *  call only. Doesn't change the persistent Settings choice. */
      forceProvider?: LlmProvider;
      /** V2.2 escalate: re-run this exact text + refs instead of
       *  pulling from the input/pills state. Used by the "Try with
       *  BYOK" button on an earlier assistant bubble. */
      replayText?: string;
      replayRefs?: Array<{ marker: string; label: string | null }>;
      /** UI-side label for the user bubble when replaying. If unset,
       *  falls back to the replayed text. */
      replayLabel?: string;
    },
  ): Promise<void> => {
    const text = opts?.replayText !== undefined ? opts.replayText : input.trim();
    const refs = opts?.replayRefs !== undefined ? opts.replayRefs : pendingNodeRefs;
    // Allow send when EITHER the user typed text OR they have pending
    // node refs — "Ask about this" with no added text is a valid query.
    if ((!text && refs.length === 0) || streaming) return;

    // Serialise pending refs back into [node:...] markers so the
    // server's existing context-expansion path works unchanged.
    const markerPrefix = refs
      .map((r) => `[node:${r.marker}]`)
      .join(' ');
    const wireMessage = markerPrefix
      ? (text ? `${markerPrefix} ${text}` : markerPrefix)
      : text;

    // For replays (escalate), don't add a new user bubble — the user
    // already asked the question once. Just insert the new assistant
    // bubble. For normal sends, add both.
    const isReplay = opts?.replayText !== undefined;
    const assistantId = `a-${Date.now()}`;
    const assistantSeed: ChatMessage = { id: assistantId, role: 'assistant', text: '', streaming: true };

    if (isReplay) {
      setMessages((m) => [...m, assistantSeed]);
    } else {
      const userMsg: ChatMessage = {
        id: `u-${Date.now()}`,
        role: 'user',
        text: opts?.replayLabel ?? (text || (refs.length > 0 ? 'Ask about this' : '')),
        nodeRefs: refs.length > 0 ? [...refs] : undefined,
      };
      setMessages((m) => [...m, userMsg, assistantSeed]);
      setInput('');
      setPendingNodeRefs([]);
    }
    setStreaming(true);

    try {
      const resp = await authFetch(`${API_BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: wireMessage,
          ...(opts?.forceProvider ? { forceProvider: opts.forceProvider } : {}),
        }),
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
                provider?: LlmProvider;
              };
              if (evt.type === 'start' && evt.provider) {
                // V2.2 escalate support: label the bubble with the
                // resolved provider (may differ from user default when
                // forceProvider was passed). Later code uses this to
                // decide whether to render the "Try with BYOK" button.
                setMessages((m) => m.map((msg) => (msg.id === assistantId ? { ...msg, provider: evt.provider } : msg)));
              } else if (evt.type === 'focus' && evt.nodeId) {
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
                // V2.2 bug-fix: on error, clear `loading` so the
                // download progress panel stops rendering. Otherwise
                // the bubble shows 100% download + red border + no
                // text, which reads as "something broke." Setting
                // loading: undefined lets the error message render
                // in the normal text position with error styling.
                setMessages((m) => m.map((msg) => (msg.id === assistantId ? { ...msg, text: evt.message ?? 'error', error: true, streaming: false, loading: undefined } : msg)));
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
                  const { cleaned, actions, renders } = extractActions(msg.text);
                  // Q1.6: route render tokens to the canvas view-stack.
                  // Only the last render wins — the canvas is a single
                  // slot, not a stack (yet). Order-insensitive from the
                  // LLM's view: earlier tokens are superseded by later
                  // ones in the same message, matching how a chat
                  // transcript reads top-to-bottom.
                  if (renders.length > 0) {
                    const latest = renders[renders.length - 1];
                    setCanvasView({
                      kind: 'a2ui',
                      id: latest.id,
                      component: latest.component,
                      props: latest.props,
                    });
                  }
                  if (actions.length > 0 && shouldAutoExec) {
                    // Fire-and-forget per extracted action. Each runs
                    // runChatAction which inserts its own result bubble.
                    actions.forEach((a) => { void runChatAction(a.action, a.params); });
                    // loading: undefined — defensive clear in case the
                    // stream produced only a download panel and then
                    // raced to done without any tokens.
                    return { ...msg, text: cleaned, streaming: false, loading: undefined };
                  }
                  return {
                    ...msg,
                    text: cleaned,
                    streaming: false,
                    loading: undefined,
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
      {/* Hot-reload banner — shown when a Tier 1 manifest plugin was
          loaded since boot. Its auto-tools work in new MCP sessions but
          the new types are not yet valid for the core store_node enum
          until daemon restart. */}
      {health?.manifestHotReload?.needsRestartForCoreEnums && (
        <div style={{
          background: 'rgba(74,144,226,0.15)',
          border: '1px solid #4a90e2',
          color: 'var(--color-text, #e5e5e5)',
          padding: '8px 16px',
          fontSize: 13,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
        }}>
          <div>
            <strong>{health.manifestHotReload.namesHotLoaded.length} new plugin{health.manifestHotReload.namesHotLoaded.length === 1 ? '' : 's'} loaded</strong>
            {' '}without restart: <code>{health.manifestHotReload.namesHotLoaded.join(', ')}</code>.
            {' '}Their typed tools work now, but the new types aren't valid for <code>store_node</code> / <code>store_edge</code> until you restart the daemon.
          </div>
          <code style={{ fontSize: 11, padding: '4px 8px', background: 'var(--color-surface-alt, #2a2a2a)', borderRadius: 3, whiteSpace: 'nowrap' }}>
            launchctl kickstart -k gui/$(id -u)/com.groundfloor.lore
          </code>
        </div>
      )}

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
              className="icon-button"
              onClick={() => {
                const next = !showProjects;
                setShowProjects(next);
                // Don't close the chat sidebar when opening the projects
                // panel — earlier behaviour collapsed the left rail and
                // made it look like the only thing that happened was
                // "the side nav disappeared." Settings + node detail
                // sit in the same right-corner real estate as projects,
                // so those still close to avoid stacking overlays.
                if (next) {
                    setShowSettings(false);
                    setSelectedNodeId(null);
                }
              }}
              title="Projects — manage indexed code repositories"
            >
              <FolderGit2 size={20} />
            </button>
            <button
              className="icon-button"
              onClick={() => setShowSupersedeCandidates(true)}
              title="Find supersession candidates — scans your knowledge for likely duplicate decisions and lets you mark older versions as superseded"
            >
              <GitBranchPlus size={20} />
            </button>
            <button
              className="icon-button"
              onClick={() => setShowPluginInspectors(true)}
              title="Plugin inspectors (manifest-declared tabs)"
            >
              <Table size={20} />
            </button>
            <button
              className="icon-button"
              onClick={() => setShowPluginSettings(true)}
              title="Plugin settings (manifest-declared config fields)"
            >
              <SlidersHorizontal size={20} />
            </button>
            <button
              className="icon-button"
              onClick={() => setShowPluginWizard(true)}
              title="Create plugin (Tier 1 wizard)"
            >
              <Boxes size={20} />
            </button>
            <button
              ref={settingsButtonRef}
              className="icon-button"
              onClick={() => {
                // Settings + Node Detail Drawer both anchor at top-right;
                // keep them mutually exclusive so neither obscures the
                // other. Opening Settings closes the drawer.
                const next = !showSettings;
                setShowSettings(next);
                if (next) { setSelectedNodeId(null); setShowProjects(false); }
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

        {showProjects && (
          <ProjectsPanel apiBase={API_BASE} onClose={() => setShowProjects(false)} />
        )}

        {showPluginWizard && (
          <Suspense fallback={null}>
            <PluginWizard onClose={() => setShowPluginWizard(false)} />
          </Suspense>
        )}

        {showPluginInspectors && (
          <Suspense fallback={null}>
            <PluginInspectors onClose={() => setShowPluginInspectors(false)} />
          </Suspense>
        )}

        {showPluginSettings && (
          <Suspense fallback={null}>
            <PluginSettingsPanel onClose={() => setShowPluginSettings(false)} />
          </Suspense>
        )}

        {showSupersedeCandidates && (
          <SupersessionCandidatesModal
            apiBase={API_BASE}
            project={drilledProject ?? null}
            projectOptions={workspaceProjects}
            onClose={() => setShowSupersedeCandidates(false)}
            onAcceptedAny={() => {
              // Bump the topology so the network view drops the
              // newly-superseded nodes (or fades them if the toggle is
              // on). Cheapest refresh: re-fetch overview.
              void authFetch(`${API_BASE}/api/topology/overview?groupBy=project`)
                .then((r) => r.json() as Promise<{ blobs: Array<{ project: string; nodeCount: number }> }>)
                .then((d) => setWorkspaceProjects(d.blobs ?? []))
                .catch(() => { /* ignore */ });
            }}
          />
        )}

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
                        {/* V2.2: message footer — provider label + thumbs
                            + escalate + save-as-md. Only renders after
                            streaming completes, on non-empty bodies, on
                            non-action bubbles. */}
                        {!m.streaming && m.text && m.text.length > 10 && !m.isActionResult ? (
                          <div className="chat-msg-footer">
                            {m.provider ? (
                              <span className="chat-provider-tag" title={`Answered by ${m.provider}`}>
                                {m.provider}
                              </span>
                            ) : null}
                            <button
                              type="button"
                              className={`chat-thumb chat-thumb-up${m.rating === 'up' ? ' active' : ''}`}
                              onClick={() => void submitFeedback(m.id, 'up')}
                              aria-label="Helpful"
                              title="Helpful"
                            >
                              👍
                            </button>
                            <button
                              type="button"
                              className={`chat-thumb chat-thumb-down${m.rating === 'down' ? ' active' : ''}`}
                              onClick={() => void submitFeedback(m.id, 'down')}
                              aria-label="Not helpful"
                              title="Not helpful"
                            >
                              👎
                            </button>
                            {m.provider === 'embedded' && hasApiKey && (llmProvider === 'anthropic' || llmProvider === 'openai') ? (
                              <button
                                type="button"
                                className="chat-escalate"
                                onClick={() => escalateAssistantMessage(m.id, llmProvider)}
                                title={`Re-run this query with ${llmProvider} for a more thorough answer`}
                              >
                                ↑ Try with {llmProvider === 'anthropic' ? 'Claude' : 'OpenAI'}
                              </button>
                            ) : null}
                            <button
                              type="button"
                              className="chat-save-md"
                              onClick={() => downloadAssistantMessageAsMarkdown(m.text)}
                              title="Download this message as a Markdown file"
                            >
                              Save as .md
                            </button>
                          </div>
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

          {/* V2.2: pre-send complexity hint. Fires when all of:
                - User is on embedded provider (so they'd hit Gemma 1B)
                - User has a BYOK key + it resolves to anthropic/openai
                - Input looks complex: > 200 chars OR matches one of
                  the high-effort-request patterns (generate, explain in
                  detail, architecture, diagram, step-by-step, example)
                - Not streaming
                - User hasn't dismissed for this input
              Click the "Send to X instead" button forces JUST THIS
              message to BYOK; does not change Settings. Dismiss hides
              until input clears or a new complex query appears. */}
          {(() => {
            if (llmProvider !== 'embedded') return null;
            if (!hasApiKey) return null;
            if (streaming) return null;
            if (complexityHintDismissed) return null;
            const trimmed = input.trim();
            if (trimmed.length === 0) return null;
            const COMPLEXITY_RE = /\b(generate|explain in detail|architecture|diagram|step[- ]by[- ]step|code example|write a|produce|walkthrough|comprehensive)\b/i;
            const isComplex = trimmed.length > 200 || COMPLEXITY_RE.test(trimmed);
            if (!isComplex) return null;
            // We only show when the effective escalate target is a
            // well-known cloud provider — skip for Ollama since the
            // embedded-vs-ollama comparison isn't strictly "commercial."
            const target = llmProvider as LlmProvider; // type; we're on 'embedded' here
            void target;
            // Resolve escalate target from capability: if user's
            // *configured* BYOK provider in Settings isn't embedded,
            // use that; else nothing to escalate to.
            const escalateTo: LlmProvider | null =
              capability?.toolCalling === 'native' && (capability.provider === 'anthropic' || capability.provider === 'openai')
                ? capability.provider as LlmProvider
                : null;
            if (!escalateTo) return null;
            const displayName = escalateTo === 'anthropic' ? 'Claude' : 'OpenAI';
            return (
              <div className="complexity-hint">
                <span className="complexity-hint-text">
                  ⚡ Looks complex — Gemma 1B may struggle.
                </span>
                <button
                  type="button"
                  className="complexity-hint-action"
                  onClick={() => {
                    const textToSend = input.trim();
                    const refsToSend = [...pendingNodeRefs];
                    void sendMessage({
                      forceProvider: escalateTo,
                      replayText: textToSend,
                      replayRefs: refsToSend,
                    });
                    // sendMessage's replay path doesn't clear input/
                    // pills on its own. Do it here for this one-shot
                    // escalate send.
                    setInput('');
                    setPendingNodeRefs([]);
                    setComplexityHintDismissed(false);
                  }}
                >
                  Send to {displayName} instead
                </button>
                <button
                  type="button"
                  className="complexity-hint-dismiss"
                  onClick={() => setComplexityHintDismissed(true)}
                  aria-label="Dismiss hint"
                >
                  ×
                </button>
              </div>
            );
          })()}

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
                  onChange={(e) => {
                    setInput(e.target.value);
                    // Reset the dismiss flag when the user clears the
                    // input — next query gets a fresh chance to show
                    // the hint.
                    if (e.target.value.trim().length === 0) setComplexityHintDismissed(false);
                  }}
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

        {/* Q1.6 — Canvas view-stack. SigmaCanvas stays mounted underneath
            so "back to graph" is instant and ForceAtlas2 doesn't re-run
            on every LLM round-trip. The A2UI overlay only mounts when
            the LLM emits a {{render:...}} token. */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            visibility: canvasView === 'graph' ? 'visible' : 'hidden',
          }}
        >
          <Suspense fallback={<CanvasLoadingFallback />}>
            {graphViz !== 'network' ? (
              (() => {
                const filter = tagFilter
                  ? (availableTags.find((t) => t.tag === tagFilter)?.repos ?? [])
                  : null;
                const common = {
                  apiBase: API_BASE,
                  onProjectClick: handleChordProjectClick,
                  projectFilter: filter,
                };
                if (graphViz === 'chord') return <ChordDiagram {...common} />;
                if (graphViz === 'sunburst') return <SunburstDiagram {...common} />;
                return null;
              })()
            ) : (
              <SigmaCanvas
                activeTypes={activeTypes}
                activeProjects={activeProjects}
                focusNodeId={focusNodeId}
                onTopologyReady={handleTopologyReady}
                onNodeClick={handleNodeClick}
                showInferred={showInferred}
                showSuperseded={showSuperseded}
                graphSizeLimit={graphSizeLimit}
                tagFilter={tagFilter}
                forcedProjectMode={drilledProject}
                onExitProjectMode={handleExitProjectMode}
              />
            )}
            {/* 2026-04-27 fix #2: removed the [network|chord] toggle.
                Chord is the only entry point; click an arc → drill into
                network for that project. The breadcrumb back-button
                returns to chord. Toggle suggested two equivalent views;
                wrong mental model. */}
            {/* 2026-04-27: tag dropdown only shown on chord view (overview).
                In drill-in mode, the user is already focused on one
                project, so the tag filter is irrelevant. To edit tags,
                they go through the ProjectsPanel (FolderGit2 icon). */}
            {availableTags.length > 0 && (graphViz === 'chord' || graphViz === 'sunburst') && !drilledProject && (
              <div
                style={{
                  position: 'absolute',
                  top: 12,
                  left: 12,
                  zIndex: 12,
                  padding: '5px 10px',
                  fontSize: '0.78rem',
                  color: 'var(--color-text)',
                  background: 'var(--glass-bg)',
                  backdropFilter: 'blur(8px)',
                  border: '1px solid var(--color-border)',
                  borderRadius: 6,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <span style={{ color: 'var(--color-text-muted)' }}>Tag:</span>
                <select
                  value={tagFilter ?? ''}
                  onChange={(e) => setTagFilter(e.target.value || null)}
                  style={{
                    background: 'transparent',
                    color: 'inherit',
                    border: 'none',
                    fontSize: 'inherit',
                    cursor: 'pointer',
                    outline: 'none',
                  }}
                >
                  <option value="">All projects</option>
                  {availableTags.map((t) => (
                    <option key={t.tag} value={t.tag}>{t.tag} ({t.repos.length})</option>
                  ))}
                </select>
                <span style={{ color: 'var(--color-border)' }}>·</span>
                <button
                  type="button"
                  onClick={() => setShowProjects(true)}
                  title="Add projects, edit tags"
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--color-accent, #14B8A6)',
                    cursor: 'pointer',
                    fontSize: 'inherit',
                    padding: 0,
                    textDecoration: 'underline',
                  }}
                >
                  Manage
                </button>
              </div>
            )}
            {/* Overview viz switcher: chord | sunburst | pack | tree.
                Only shown in overview modes (not network drill-in). */}
            {!drilledProject && (graphViz === 'chord' || graphViz === 'sunburst') && (
              <div
                style={{
                  position: 'absolute',
                  top: 12,
                  left: '50%',
                  transform: 'translateX(-50%)',
                  zIndex: 12,
                  padding: 4,
                  background: 'var(--glass-bg)',
                  backdropFilter: 'blur(8px)',
                  border: '1px solid var(--color-border)',
                  borderRadius: 8,
                  display: 'flex',
                  gap: 2,
                }}
              >
                {(['chord', 'sunburst'] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => {
                      setGraphViz(v);
                      try { localStorage.setItem('lore.overviewViz', v); } catch { /* ignore */ }
                    }}
                    style={{
                      background: graphViz === v ? 'var(--color-accent, #14B8A6)' : 'transparent',
                      color: graphViz === v ? '#fff' : 'var(--color-text)',
                      border: 'none',
                      borderRadius: 6,
                      padding: '4px 12px',
                      fontSize: '0.75rem',
                      fontWeight: 500,
                      cursor: 'pointer',
                      textTransform: 'capitalize',
                    }}
                  >
                    {v}
                  </button>
                ))}
              </div>
            )}
          </Suspense>
        </div>
        {canvasView !== 'graph' ? (
          <div
            className="a2ui-canvas-overlay"
            style={{
              position: 'absolute',
              inset: 0,
              background: 'var(--color-bg, #0b0d12)',
              zIndex: 4,
              overflow: 'auto',
            }}
          >
            <button
              type="button"
              onClick={() => setCanvasView('graph')}
              aria-label="Back to graph"
              title="Back to graph"
              style={{
                position: 'absolute',
                top: '0.75rem',
                left: '0.75rem',
                zIndex: 6,
                padding: '0.35rem 0.7rem',
                fontSize: '0.8rem',
                background: 'rgba(255,255,255,0.08)',
                color: 'inherit',
                border: '1px solid rgba(255,255,255,0.15)',
                borderRadius: 4,
                cursor: 'pointer',
              }}
            >
              ← Back to graph
            </button>
            <A2uiRenderer component={canvasView.component} props={canvasView.props} />
          </div>
        ) : null}

        {/* Phase 3: truncation banner. /api/topology sets truncated:true
            when the graph exceeds the requested limit. The banner is a
            non-dismissable amber ribbon — dismissing would hide the fact
            that the view is a sample. Raising the slider or filtering
            in the right panel is the supported response. */}
        {topology?.truncated ? (
          <div
            className="truncation-banner"
            role="status"
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              padding: '0.5rem 1rem',
              background: 'rgba(217, 119, 6, 0.92)', // amber-600
              color: '#fff',
              fontSize: '0.8rem',
              zIndex: 5,
              pointerEvents: 'none',
              textAlign: 'center',
              boxShadow: '0 1px 4px rgba(0,0,0,0.2)',
            }}
          >
            Graph too large — showing {(topology.limit ?? 0).toLocaleString()} of{' '}
            {(topology.totalCoreNodes ?? topology.nodes.length).toLocaleString()} nodes.
            Use filters in the right panel to narrow the view, or raise the Graph Size Limit in Settings.
          </div>
        ) : null}

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
          onReconnectNode={(id) => {
            // V2.2: "Recalibrate" — route the drawer's reconnect
            // button through the same /api/chat/action dispatch used
            // for LLM-suggested action buttons, so the result bubble
            // appears in chat with edge-count confirmation.
            const marker = id.includes(':') ? id : `lore:${id}`;
            void runChatAction('reconnect_node', { id: marker });
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

            {/* Phase 3: Graph Size Limit. Hard cap at 20k — enforced by
                server. Default is hardware-auto-detected on first visit;
                once the user moves it, the choice is persisted. Refetch
                is automatic via the SigmaCanvas useEffect dep array. */}
            <div className="setting-group">
              <label>Graph Size Limit</label>
              <div
                role="radiogroup"
                aria-label="Graph Size Limit"
                style={{ display: 'flex', gap: '0.5rem', marginTop: '0.25rem' }}
              >
                {GRAPH_SIZE_OPTIONS.map((size) => (
                  <label
                    key={size}
                    className={`size-option ${graphSizeLimit === size ? 'active' : ''}`}
                    style={{
                      flex: 1,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      padding: '0.4rem 0.5rem',
                      border: graphSizeLimit === size
                        ? '1px solid var(--color-accent, #0969da)'
                        : '1px solid var(--color-border, rgba(128,128,128,0.3))',
                      borderRadius: '4px',
                      fontSize: '0.8rem',
                      cursor: 'pointer',
                      background: graphSizeLimit === size
                        ? 'rgba(9, 105, 218, 0.12)'
                        : 'transparent',
                    }}
                  >
                    <input
                      type="radio"
                      name="graph-size"
                      value={size}
                      checked={graphSizeLimit === size}
                      onChange={() => {
                        setGraphSizeLimit(size);
                        try {
                          localStorage.setItem(GRAPH_SIZE_STORAGE_KEY, String(size));
                        } catch {
                          // localStorage may throw in private mode; ignore.
                        }
                      }}
                      style={{ display: 'none' }}
                    />
                    {(size / 1000).toFixed(0)}k
                  </label>
                ))}
              </div>
              <p className="help-text" style={{ fontSize: '0.7rem', color: 'var(--color-text-muted)', marginTop: '0.4rem' }}>
                Maximum nodes rendered in the canvas. ForceAtlas2 layout is
                CPU-bound, so higher values cost more on slow machines.
                20k is the firm ceiling — the server won't return more
                even if asked. Default auto-detected from your CPU.
              </p>
            </div>

            {/* 2026-04-28 — soft-supersession retention policy. Per
                workspace; the daemon also auto-runs the sweep daily. */}
            <div className="setting-group">
              <label>Retention (superseded nodes)</label>
              {retentionPolicy === null ? (
                <p className="help-text" style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>Loading…</p>
              ) : (
                <>
                  <label className="filter-checkbox" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.4rem' }}>
                    <input
                      type="checkbox"
                      checked={retentionPolicy.hideSupersededInRecall}
                      disabled={retentionSaving}
                      onChange={(e) => void updateRetention({ hideSupersededInRecall: e.target.checked })}
                    />
                    <span style={{ fontSize: '0.85rem' }}>Hide superseded nodes from recall + search</span>
                  </label>
                  <p className="help-text" style={{ fontSize: '0.7rem', color: 'var(--color-text-muted)', margin: '0.2rem 0 0.6rem' }}>
                    Default on. Off lets stale decisions compete against current ones in semantic results.
                  </p>

                  <label style={{ fontSize: '0.85rem', display: 'block', marginTop: '0.6rem' }}>
                    Auto-archive after (days)
                    <input
                      type="number"
                      min={0}
                      step={1}
                      value={retentionPolicy.autoArchiveSupersededAfterDays ?? ''}
                      placeholder="never"
                      disabled={retentionSaving}
                      onChange={(e) => {
                        const raw = e.target.value;
                        const v = raw === '' ? null : Math.max(0, parseInt(raw, 10) || 0);
                        void updateRetention({ autoArchiveSupersededAfterDays: v });
                      }}
                      style={{
                        marginLeft: '0.5rem',
                        width: '5rem',
                        padding: '2px 6px',
                        background: 'transparent',
                        color: 'inherit',
                        border: '1px solid var(--color-border)',
                        borderRadius: 4,
                      }}
                    />
                  </label>
                  <p className="help-text" style={{ fontSize: '0.7rem', color: 'var(--color-text-muted)', margin: '0.2rem 0 0.4rem' }}>
                    A daily background sweep tombstones the verbatim memory of any node that has been superseded for longer than this. Graph node + edges + lineage are preserved. Empty / 0 disables the sweep.
                  </p>

                  <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.6rem', alignItems: 'center' }}>
                    <button
                      type="button"
                      disabled={retentionSaving}
                      onClick={() => void runRetentionSweepNow(true)}
                      style={{
                        background: 'transparent',
                        color: 'var(--color-text)',
                        border: '1px solid var(--color-border)',
                        borderRadius: 4,
                        padding: '4px 10px',
                        fontSize: '0.78rem',
                        cursor: retentionSaving ? 'not-allowed' : 'pointer',
                      }}
                    >
                      Dry-run sweep
                    </button>
                    <button
                      type="button"
                      disabled={retentionSaving}
                      onClick={() => void runRetentionSweepNow(false)}
                      style={{
                        background: 'var(--color-accent, #14B8A6)',
                        color: '#fff',
                        border: 'none',
                        borderRadius: 4,
                        padding: '4px 10px',
                        fontSize: '0.78rem',
                        cursor: retentionSaving ? 'not-allowed' : 'pointer',
                      }}
                    >
                      Run sweep now
                    </button>
                    {retentionSweepResult ? (
                      <span style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>
                        {retentionSweepResult.eligible} eligible · {retentionSweepResult.archived} archived
                      </span>
                    ) : null}
                  </div>
                </>
              )}
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

            {/* V2.2: feedback aggregate. Helps the user (and us) see
                whether the active model is actually landing good
                answers. Stored locally; never egresses. */}
            {feedbackStats && feedbackStats.totalCount > 0 ? (
              <div className="setting-group">
                <label>Answer Quality (last {feedbackStats.windowDays} days)</label>
                <div className="plugins-list">
                  {Object.entries(feedbackStats.providerBreakdown)
                    .sort(([, a], [, b]) => b.total - a.total)
                    .map(([prov, counts]) => (
                      <span
                        key={prov}
                        className="plugin-badge"
                        title={`${counts.up} 👍 / ${counts.down} 👎 over ${counts.total} rated messages`}
                      >
                        {prov}: {Math.round(counts.upRate * 100)}% 👍 ({counts.total})
                      </span>
                    ))}
                </div>
                <p className="help-text">
                  Based on {feedbackStats.totalCount} rated messages.
                  Click 👍 / 👎 on any chat answer to contribute.
                  Data stays local — never egressed.
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
            showSuperseded={showSuperseded}
            setShowSuperseded={setShowSuperseded}
            allProjects={workspaceProjects}
          />
        </aside>
      ) : null}
    </div>
  );
}

export default App;
