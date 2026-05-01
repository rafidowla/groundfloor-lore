/**
 * types.ts — Core interfaces for the Lore V2 plugin system.
 *
 * A plugin is the smallest unit that can be activated/deactivated in a
 * workspace. Active plugins are read from .lore/config.json → `plugins[]`.
 * Each plugin contributes:
 *
 *   - Tools     : MCP tool registrations gated by plugin activation
 *   - Schemas   : additional node types and edge relations beyond the base
 *   - Tables    : Kùzu table names it owns (used for collision checks +
 *                 orphan detection on plugin removal)
 *   - UI hints  : default filter preset, default system prompt, camera focus
 *                 tag (consumed by the Mode pill-group in Phase 3)
 *   - Telemetry : optional `getTelemetryPayload()` used by the Dataplane
 *                 sync in Phase 4+
 *
 * The plugin registry (registry.ts) loads and validates plugins; the core
 * server never imports plugin tool registrations directly.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PluginStorage } from './storage.js';

export type { PluginStorage, Filter, FindOptions, TraverseOptions, EdgeRow, EdgeShapeHint } from './storage.js';

/**
 * PluginGraphContext — Narrow surface exposed to plugins for reading from
 * or writing to the substrate-bound graph without importing engine
 * classes directly (which would invert the dependency).
 *
 * Handed to registerSchema / contributeReconnectNodes / routeReconnectEdge.
 *
 * SUBSTRATE PORTABILITY (Q2.2 slice 5a):
 *   Plugins should write business logic against `storage` (PluginStorage)
 *   — substrate-portable, runs on Kùzu and Dataplane identically. The
 *   raw `executeQuery` / `queryRows` Cypher path is kept for backward
 *   compatibility; new plugin code should NOT use it. Cypher-on-cloud
 *   throws (Cypher is Kùzu-specific; Dataplane speaks AQL).
 *
 *   Migration path: existing developer-plugin Cypher calls move to
 *   `storage.*` in slice 5b. After that, executeQuery/queryRows
 *   become deprecated and removed in a future slice.
 */
export interface PluginGraphContext {
    /**
     * Substrate-portable plugin storage — preferred surface for ALL new
     * plugin code. Same calls work in local and cloud modes.
     *
     * See `src/plugins/storage.ts` for the interface and Filter shape.
     */
    storage: PluginStorage;

    /**
     * @deprecated Q2.2 slice 5a — Use `storage.*` for substrate-portable
     * plugin code. Raw Cypher only works in local mode (Kùzu); cloud-mode
     * daemons reject these calls. Slice 5b cuts the developer plugin
     * over and removes Cypher from any new plugin path.
     *
     * Execute a parameterized Cypher query. Plugins use this both for
     * schema creation (CREATE NODE TABLE …) and for operational reads.
     * Throws on syntax / execution error; caller decides to recover.
     */
    executeQuery(cypher: string, params?: Record<string, unknown>): Promise<unknown>;

    /**
     * @deprecated Q2.2 slice 5a — Use `storage.find` / `storage.get` for
     * substrate-portable reads. Cypher-only; cloud mode rejects these.
     *
     * Materialized row list helper — common enough to hoist out of every
     * plugin. Returns an array of plain objects keyed by the RETURN names.
     */
    queryRows(cypher: string, params?: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;

    /**
     * Q1.3 — Invalidate the core read cache.
     *
     * Plugin authors MUST call this after any `executeQuery` that runs
     * a CREATE / MERGE / DELETE / SET / DETACH DELETE — anything that
     * mutates graph state. The `storage.*` mutating methods (upsert /
     * deleteWhere / addEdge / upsertEdge / deleteEdgesWhere) call bumpEpoch
     * internally — plugins on PluginStorage do NOT need to call it manually.
     * The hook remains exposed for the legacy raw-Cypher path.
     *
     * The operation is constant-time (monotonic counter increment) and
     * safe to call multiple times in a transaction.
     */
    bumpEpoch(): void;
}

/**
 * PluginCloudSchemaContext — Q2.2 slice 4. Narrow surface plugins use to
 * provision their owned collections against the Dataplane when the daemon
 * runs in cloud mode. Handed to `registerCloudSchema`.
 *
 * Shape and idempotency mirror DataplaneGraph's core collection push:
 *   - ensureCollection swallows "already exists"/409 errors so the hook is
 *     safe to call on every tenant's first touch, including tenants whose
 *     collections were provisioned in a prior daemon.
 *   - tenantId is resolved per-hook-call by the adapter; plugins never
 *     read AsyncLocalStorage themselves.
 *   - orgId is the ReBAC partitioning key the Lore daemon stamps onto
 *     every record; plugins should include it on collections that carry
 *     org-scoped rows (same convention as lore_node/lore_edge).
 *
 * This is intentionally a different context from `PluginGraphContext`:
 *   - PluginGraphContext is Cypher-oriented (embedded Kùzu shape).
 *   - PluginCloudSchemaContext is Dataplane-CollectionSchema-oriented.
 *
 * A plugin that wants cloud parity implements BOTH hooks with the same
 * logical schema expressed in each backend's vocabulary. The schemas do
 * NOT need to be bit-identical — e.g. Kùzu `INT32` vs Dataplane `int`.
 */
export interface PluginCloudSchemaContext {
    /** Tenant the collections are provisioned for (per-request). */
    readonly tenantId: string;
    /** Org id callers should stamp onto rows + index for ReBAC. */
    readonly orgId: string;
    /**
     * Idempotent schema push. `schema` is a Dataplane CollectionSchema
     * object (`{ name, fields: [{ name, field_type, primary_key?, … }] }`).
     * "already exists" / 409 responses are swallowed. Any other error
     * rejects the promise — the adapter then drops its cached init
     * promise so the next request retries instead of latching a
     * permanent failed state.
     */
    ensureCollection(schema: unknown): Promise<void>;
}

/**
 * EmbeddableNode — What plugins hand back from `contributeReconnectNodes`.
 * The id is already prefixed (e.g. `file:src/foo.ts`, `symbol:abc123`) so
 * a single vector search returns hits across all pillars and the core
 * pass can route results by prefix.
 */
export interface EmbeddableNode {
    id: string;
    text: string;
    metadata: {
        type: string;
        label: string;
        tags: string;
        project: string;
        ecosystem: string;
        updatedAt: string;
        security_scopes: string[];
    };
}

/**
 * ReconnectEdgeProposal — One semantic edge candidate for the plugin to
 * route into the correct REL table. The plugin returns `true` if it
 * accepted the edge; `false` lets the next plugin (or core) try.
 *
 * Both ids carry their pillar prefix so plugins can pattern-match on
 * kind without another lookup.
 */
export interface ReconnectEdgeProposal {
    from: string;
    to: string;
    confidence: number;
    relation: string; // already formatted e.g. "semantic_neighbor:0.842"
}

/**
 * PluginContext — Shared runtime handed to each plugin's tool registrar.
 * Kept intentionally minimal and fully typed. Anything not on here a
 * plugin cannot reach (enforced by the registry).
 */
export interface PluginContext {
    // Service singletons. `unknown` at the interface level to avoid a
    // circular dependency between plugins and engines; plugins that need
    // these cast to the concrete classes they import directly.
    graph: unknown;
    verbatimStore: unknown;
    syncEngine: unknown;
    syncAdapter: unknown | null;
    schemaLoader: unknown;

    // Workspace scope (project + ecosystem autoresolved from cwd).
    scope: { project: string; ecosystem: string };

    // Loreroot. Plugins that manage their own persistence should write
    // beneath `${loreDir}/plugins/${pluginName}/...`.
    loreDir: string;
}

/**
 * PluginUiHints — Phase 3 Mode pill behavior.
 * Clicking a mode pill swaps system prompt, filter preset, and camera focus.
 */
export interface PluginUiHints {
    /** Short label shown on the pill (e.g., "Developer", "Family"). */
    modeLabel: string;
    /** System prompt swap for chat when this mode is active. */
    systemPrompt: string;
    /** Default node types to show (Sigma `nodeReducer` preset). */
    defaultFilterTypes: string[];
    /** Camera focuses on the densest cluster whose nodes carry this tag. */
    cameraFocusTag: string;
}

export interface PluginTelemetryPayload {
    pluginName: string;
    version: string;
    nodeCount: number;
    edgeCount: number;
    tableNames: string[];
}

/**
 * RetentionRule — Phase 5 / C12. A plugin-declared policy for how
 * long its nodes live.
 *
 *   nodeType: which domain node type this rule applies to
 *             (the plugin's own node types — plugins can't regulate others').
 *   condition: how expiry is computed
 *     - 'age'        — nodes older than `ageThresholdDays` expire
 *     - 'tag'        — nodes carrying `tag` expire
 *     - 'predicate'  — plugin implements its own expiry check (future)
 *   action: what to do when a node expires
 *     - 'archive'       — move to cold storage via C11 archive hook
 *     - 'evict-content' — keep the graph node, drop raw content
 *     - 'delete'        — remove the node entirely
 *     - 'keep-forever'  — explicit opt-out (noop)
 */
export interface RetentionRule {
    nodeType: string;
    condition: 'age' | 'tag' | 'predicate';
    ageThresholdDays?: number;
    tag?: string;
    action: 'archive' | 'evict-content' | 'delete' | 'keep-forever';
}

/**
 * PluginIR — A plugin's declared Intermediate Representation.
 *
 * Q1.4 / decision D-D per docs/post_v2_plan.md: "Each plugin invents a
 * narrow IR it serializes into. No generalized CommonMark/OOXML
 * chasing." Making the IR a first-class, declarative field — rather
 * than inferring it from `registerSchema` side effects — lets tooling
 * enumerate a plugin's shape without booting it:
 *
 *   - Scaffolder (`lore scaffold-plugin`) generates a stub with a
 *     working IR on the first boot.
 *   - `/api/plugins/ir` returns the aggregated IR for UI + docs.
 *   - Analytical projection (Q1.5) reads node/edge kinds from here
 *     to know which projections a plugin opts into.
 *   - `test:arch` gains a stricter rule: core must not reference any
 *     node or edge kind declared in a plugin's IR.
 *
 * Split of fields:
 *   ownedNodeTables : Kùzu node tables this plugin CREATEs. Collision-
 *                     checked at boot.
 *   ownedEdgeTables : Kùzu REL tables this plugin CREATEs.
 *   nodeKinds       : domain node-type labels used in tags / metadata
 *                     (e.g. 'Person', 'code_symbol', 'Contract').
 *                     Not always 1:1 with ownedNodeTables — a plugin
 *                     can contribute `nodeType: 'decision'` to the
 *                     shared LoreNode table without owning a table.
 *   edgeKinds       : relation labels (e.g. 'lives_at', 'applies_to').
 *   version         : IR schema version — plugin bumps on breaking
 *                     change. Clients can migrate or refuse to load.
 *
 * The older flat fields (`ownedTables`, `nodeTypes`, `edgeRelations`)
 * stay as a parallel compat surface until every plugin has migrated;
 * the registry prefers `ir.*` when present and falls back otherwise.
 */
export interface PluginIR {
    version: string;
    ownedNodeTables: string[];
    ownedEdgeTables: string[];
    nodeKinds: string[];
    edgeKinds: string[];
}

/**
 * AnalyticalProjectionColumn — One column in a projection's result set.
 *
 * `kind` matters for downstream renderers (Q1.6 canvas view-stack):
 *   - 'dimension' : grouping/categorical axis (bar chart x-axis, table
 *                   group-by column). Values are strings.
 *   - 'time'      : temporal axis — ISO-8601 date or month bucket. Line
 *                   charts / time-series renderers key on this.
 *   - 'measure'   : numeric aggregate (count, sum, avg). Bar-chart
 *                   y-axis / table summable column.
 */
export interface AnalyticalProjectionColumn {
    name: string;
    kind: 'dimension' | 'time' | 'measure';
    description?: string;
}

/**
 * AnalyticalProjectionRow — A single result row. Keys match the
 * projection's declared column names. Values are the raw projected
 * data (string | number | null). No nested structures — if a plugin
 * wants structured output it should flatten into multiple columns.
 */
export type AnalyticalProjectionRow = Record<string, string | number | null>;

/**
 * AnalyticalProjectionResult — What a projection's `run()` returns.
 * The `sourceNodeIds` field carries the ids of every node that
 * contributed to the aggregate, so `recall`-style callers can echo
 * "click to see sources" without the projection having to emit them
 * inline per row. If a projection can't cheaply enumerate sources
 * (e.g. a 100k-node aggregation), it returns an empty array — the
 * tradeoff is explicit, not a silent truncation.
 */
export interface AnalyticalProjectionResult {
    columns: AnalyticalProjectionColumn[];
    rows: AnalyticalProjectionRow[];
    sourceNodeIds: string[];
    /** Wall-clock time the projection took, in milliseconds. Populated by
     *  the registry's `runProjection` wrapper; projections don't self-time. */
    elapsedMs?: number;
}

/**
 * AnalyticalProjection — Q1.5. A declarative, runnable shape-of-data
 * question a plugin exposes to core's query engine.
 *
 * Why "projection" not "query": core doesn't let the LLM author raw
 * Cypher against plugin tables (too much surface for abuse, too brittle
 * across plugin upgrades). Projections are a curated catalog — each
 * plugin publishes a small set of well-named analytical questions
 * ("contracts by jurisdiction", "memories per month", "symbols per
 * file"), the LLM picks one by `id`, and the plugin runs it.
 *
 * Intent routing:
 *   `intentKeywords` is a rough-match hint for `analyze_graph`'s
 *   intent detector. Matching is substring + case-insensitive; the
 *   detector picks the projection with the most keyword hits. Plugins
 *   that want deterministic routing should include uniquely-scoped
 *   keywords (e.g. 'contract', 'clause' rather than 'document').
 *
 * `run()` must be airplane-safe — projections are local queries against
 * the plugin's own Kùzu tables. No network calls.
 */
export interface AnalyticalProjection {
    /** Stable, kebab-case id unique within a plugin (e.g. 'contracts-by-jurisdiction'). */
    id: string;
    /** One-line human description for UI / tool output. */
    label: string;
    /** Longer description for tool discovery. */
    description: string;
    /** Substring-match hints for natural-language intent routing. */
    intentKeywords: string[];
    /** Columns the result set will contain (declared for renderer hints). */
    columns: AnalyticalProjectionColumn[];
    /** Execute the projection. Must be local / airplane-safe. */
    run(ctx: PluginGraphContext): Promise<AnalyticalProjectionResult>;
}

/**
 * ILorePlugin — The contract every plugin must satisfy.
 * Must be a pure object (no module-level side effects on import) so the
 * registry can introspect without booting the plugin.
 */
export interface ILorePlugin {
    /** Kebab-case plugin id; matches the string in config.plugins[]. */
    name: string;
    version: string;
    description: string;

    /**
     * Kùzu table names this plugin owns. Used for:
     *   (a) collision checks across active plugins at boot
     *   (b) orphan detection when a plugin is deactivated
     *
     * Q1.4 note: superseded by `ir.ownedNodeTables` + `ir.ownedEdgeTables`
     * when `ir` is present. Kept as a parallel field for compat with
     * plugins that haven't adopted the declarative IR yet.
     */
    ownedTables: string[];

    /** Additional node / edge kinds this plugin introduces.
     *  Q1.4: mirror of `ir.nodeKinds` / `ir.edgeKinds`. */
    nodeTypes: string[];
    edgeRelations: string[];

    /**
     * Q1.4 — Declarative IR descriptor. Optional during migration;
     * every new plugin should declare one. Scaffolder-generated
     * plugins start with an IR stub. See PluginIR jsdoc above for
     * the contract.
     */
    ir?: PluginIR;

    /** UI behavior for the Mode pill (Phase 3). */
    uiHints: PluginUiHints;

    /**
     * Plugin-specific typed API. Opaque to core — core callers that
     * know they want a specific plugin do:
     *
     *   const devPlugin = registry.get('developer');
     *   (devPlugin?.api as DeveloperApi | undefined)?.ingestFilesFromSymbols();
     *
     * Populated by the plugin during `registerSchema` so it can close
     * over the PluginGraphContext. Core never reads this field's shape.
     */
    api?: unknown;

    /**
     * Register all MCP tools this plugin contributes. Called by the
     * registry only if the plugin is active.
     */
    registerTools(server: McpServer, ctx: PluginContext): void;

    /**
     * Dataplane telemetry payload. Phase 4 ships a health-ping only; the
     * full contract consumes this. Returning null opts out.
     */
    getTelemetryPayload?(ctx: PluginContext): Promise<PluginTelemetryPayload | null>;

    /**
     * V2.1 — register additional Kùzu node / rel tables the plugin needs.
     * Called exactly once at boot after the core graph is initialized.
     * Plugins issue CREATE … IF NOT EXISTS statements through ctx.executeQuery.
     * Returning an error throws the boot — collisions here are fatal.
     */
    registerSchema?(ctx: PluginGraphContext): Promise<void>;

    /**
     * Q2.2 slice 5c — declarative collection registration.
     *
     * Called once at boot for every active plugin, after `registerSchema`
     * (local mode) and after each tenant's first cloud touch (cloud
     * mode), with the active substrate's storage adapter. The plugin
     * returns CollectionDecls describing every node + edge collection it
     * owns; core wires each into the storage adapter via
     * `storage.declareCollection`.
     *
     * After registration, plugin code passes the canonical `name` to
     * storage ops — the adapter resolves substrate-specific names
     * (kuzuTable / cloudCollection) and edge metadata (source/target
     * labels + primary keys) automatically. EdgeShapeHint becomes
     * unnecessary.
     *
     * Plugins that skip this hook still work via the legacy hint-based
     * path; new plugins should always implement it.
     */
    contributeCollectionDecls?(): import('./storage.js').CollectionDecl[];

    /**
     * Q2.2 slice 4 — cloud-mode schema provisioning.
     *
     * Invoked once per tenant on the tenant's first touch to Dataplane
     * (DataplaneGraph's per-tenant lazy init), AFTER the core
     * `lore_node` + `lore_edge` collections are in place. Plugins declare
     * their own collections using the Dataplane `CollectionSchema` shape
     * (`{ name, fields: [...] }`). The schemas are pushed via
     * `ctx.ensureCollection`, which is idempotent on "already exists" —
     * safe for repeat boots against provisioned tenants.
     *
     * Naming convention: `${pluginName}_${kind}` (kebab/snake your
     * choice, but lowercase) to prevent cross-plugin collisions in a
     * shared Dataplane tenant. e.g. `developer_code_symbol`,
     * `developer_code_file`.
     *
     * Plugins that don't implement this hook skip the push — their
     * graph ops are still not available in cloud mode (Cypher→AQL
     * translation is a later slice), but core's own collections and
     * any other plugins' collections still get provisioned.
     *
     * Local mode (LocalGraph) never calls this hook — `registerSchema`
     * covers that backend. A plugin supporting cloud parity must
     * implement BOTH.
     */
    registerCloudSchema?(ctx: PluginCloudSchemaContext): Promise<void>;

    /**
     * V2.1 — contribute additional nodes to the reconnect pass's vector
     * space. Core embeds LoreNode by default; plugins can add their own
     * node kinds (e.g. code_file, code_symbol) so cross-pillar semantic
     * edges are possible.
     *
     * Returned ids MUST be prefixed so the core pass can route without
     * a reverse lookup. Recommended prefixes: '<kind>:<id>'.
     */
    contributeReconnectNodes?(ctx: PluginGraphContext): Promise<EmbeddableNode[]>;

    /**
     * V2.1 — given a semantic edge proposal involving one or both of the
     * plugin's node kinds, route it into the correct rel table. Return
     * `true` if this plugin handled the edge; `false` to let the next
     * participant try. Core handles pure lore↔lore so plugins only see
     * cross-pillar candidates.
     */
    routeReconnectEdge?(proposal: ReconnectEdgeProposal, ctx: PluginGraphContext): Promise<boolean>;

    /**
     * V2.1 — prune any inferred edges this plugin owns. Called before a
     * reconnect pass's insert phase so re-runs don't duplicate. Plugins
     * prune only their own rel tables, identified by relation-prefix.
     * Returns the number of edges deleted (for stats/logging).
     */
    pruneInferredEdges?(relationPrefix: string, ctx: PluginGraphContext): Promise<number>;

    /**
     * V2.1 — contribute additional nodes + edges to the /api/topology
     * response so the dashboard's graph view shows plugin-owned data
     * alongside core LoreNodes. Core emits LoreNode + LoreEdge by
     * default; plugins add their own with prefixed ids (e.g. file:,
     * symbol:) and any cross-pillar edges they track.
     */
    contributeTopology?(ctx: PluginGraphContext, limit: number, projects?: string[] | string): Promise<{
        nodes: Array<{ id: string; label: string; type: string; project?: string; group?: string }>;
        edges: Array<{ from: string; to: string; label: string }>;
    }>;

    /**
     * V2.2 — resolve a plugin-owned node marker (e.g. "file:src/foo.ts"
     * or "symbol:MyClass#someMethod") into a context block for the chat
     * context expander. Called by /api/chat when a [node:...] marker
     * with a prefix the plugin owns appears.
     *
     * Return `null` when this plugin doesn't recognize the prefix —
     * core iterates remaining plugins until one claims the node or
     * all return null. Core LoreNode ids (no prefix, or `lore:` prefix)
     * never reach this hook; they're handled by the core path.
     *
     * Return a block with:
     *   - label: human-readable title for the node
     *   - type: node kind (e.g. "file", "symbol")
     *   - content: best-effort body text to inject into LLM context
     *     (file preview, symbol signature, doc comment — plugin's call)
     *   - neighbors (optional): up to ~10 connected entities with
     *     relation labels, to give the LLM one-hop context
     *
     * This is how chat becomes useful for plugin-owned graph data —
     * without it, "Ask about this" on a CodeFile / CodeSymbol returns
     * "I don't have enough information" because the default context
     * expander only checks the core LoreNode table.
     */
    resolveChatContext?(
        markerId: string,
        ctx: PluginGraphContext,
    ): Promise<{
        label: string;
        type: string;
        content: string;
        neighbors?: Array<{ id: string; label: string; type: string; relation: string }>;
    } | null>;

    /**
     * Phase 5 / C12 — retention policy rules owned by this plugin.
     *
     * A plugin declares how long its OWN node types should live and
     * what to do when that lifetime expires. Core iterates contributions
     * daily and applies actions (archive / delete / evict-content).
     *
     * Rule examples:
     *   Personal plugin:
     *     { nodeType: 'Memory',     action: 'keep-forever' }
     *     { nodeType: 'Communication', condition: 'age', ageThresholdDays: 1095, action: 'archive' }
     *   Bank plugin (future, enterprise):
     *     { nodeType: 'Interaction', condition: 'age', ageThresholdDays: 2555, action: 'delete' }
     *     (2555 days = 7 years, the typical regulatory retention period)
     *
     * Returning null or [] = no retention opinions; core never touches
     * this plugin's nodes.
     */
    contributeRetentionPolicy?(): RetentionRule[] | null;

    /**
     * Phase boundary cleanup (2026-04-27) — node-type vocabulary owned by
     * this plugin. Merged into the `store_node` MCP tool's type enum at
     * boot. Lets each plugin contribute its own domain types
     * (bug_pattern, architecture, schema for Developer; Memory, Person
     * for Personal; …) without leaking them into Core's hard-coded
     * default schema.
     *
     * Returning null or [] = the plugin uses only the core types
     * (decision, convention, note).
     *
     * Example (Developer plugin):
     *   [
     *     { name: 'bug_pattern',     description: 'Recurring code bug + fix' },
     *     { name: 'architecture',    description: 'High-level code structure' },
     *     { name: 'troubleshooting', description: 'Step-by-step recovery' },
     *     { name: 'file_ref',        description: 'Pointer to a code file' },
     *     { name: 'schema',          description: 'Data schema or table' },
     *   ]
     *
     * Names must be unique across all active plugins. Collisions throw
     * at boot so the operator gets a clean diagnostic.
     */
    contributeNodeTypes?(): Array<{ name: string; description: string }> | null;

    /**
     * Phase boundary fix (2026-04-27) — bind runtime services for use
     * outside MCP sessions. Called once at daemon boot, AFTER boot() and
     * BEFORE the HTTP server starts handling requests.
     *
     * Why this exists: registerTools is called inside createMcpServer(),
     * which in HTTP daemon mode only fires when an MCP session connects.
     * Plugins that expose surfaces beyond MCP (e.g. HTTP routes that
     * core wires up to plugin APIs like /api/code-similar → evaluatePreWrite)
     * need access to PluginContext (verbatimStore, syncEngine, etc.)
     * BEFORE any MCP session might exist. bindRuntime gives them that.
     *
     * Implementation: stash ctx in a module-private variable; the api
     * object's methods reference it. See lore-plugin-developer/src/api.ts
     * bindPluginContext for the canonical pattern.
     */
    bindRuntime?(ctx: PluginContext): void;

    /**
     * v1.1 file-watcher pipeline (2026-04-30): tell core which paths
     * to watch on this plugin's behalf. Called once at daemon boot
     * (via `bindRuntime`-equivalent timing). Each entry is an absolute
     * directory path; chokidar is set up to watch all files under it
     * (recursive). When a file changes, core dispatches the event to
     * this plugin's `onFileChange` hook.
     *
     * Returning [] or null = no watching.
     *
     * The `repo` label is plugin-defined (developer plugin uses the
     * registry name; family plugin might use "notes-folder", etc.) —
     * core re-emits it verbatim in the FileChangeEvent.
     */
    contributeWatchedPaths?(ctx: PluginContext): Promise<Array<{ absPath: string; repo: string }>>;

    /**
     * v1.1 file-watcher dispatch (2026-04-30): called when a file
     * inside one of this plugin's contributeWatchedPaths changes.
     * Plugin handles the change however it wants (re-parse + upsert
     * symbols, re-embed the file, refresh a cache, etc.).
     *
     * Errors are logged by core but don't propagate — file events
     * are noisy by nature; one bad file shouldn't kill the watcher.
     *
     * Throttling note: core debounces per-path events at the
     * FileWatcherEngine level (default 500ms) so a `git checkout`
     * storm doesn't fire onFileChange thousands of times. Plugins
     * see one event per affected path per debounce window.
     */
    onFileChange?(
        event: { kind: 'add' | 'change' | 'unlink'; absPath: string; relPath: string; repo: string },
        ctx: PluginGraphContext,
    ): Promise<void>;

    /**
     * Phase boundary cleanup (2026-04-27) — edge-relation vocabulary
     * owned by this plugin. Same pattern as contributeNodeTypes:
     * merged into store_edge's enum at boot so each plugin can declare
     * its own relation labels without polluting Core's hardcoded list.
     *
     * Returning null or [] = the plugin uses only the core relations
     * (decided_for, caused_by, applies_to, supersedes, related_to,
     * depends_on). The dev-leaning 'fixed_by' is contributed by the
     * developer plugin.
     *
     * Future plugins:
     *   Personal: { name: 'lives_with', description: 'household member' }
     *   Finance:  { name: 'paid_by', description: 'transaction payer' }
     *   Legal:    { name: 'governed_by', description: 'contract clause' }
     *
     * Names must be unique across active plugins. Collisions throw
     * at boot.
     */
    contributeEdgeRelations?(): Array<{ name: string; description: string }> | null;

    /**
     * Phase 1 / C2 — contribute domain-specific instructions to the
     * chat system prompt. Called at the start of every /api/chat and
     * whenever the chat system prompt is assembled. Returning null (or
     * not implementing) is the "no contribution" opt-out.
     *
     * Keep contributions short (≤1 paragraph) and focused on HOW the
     * LLM should reason about this plugin's vocabulary — not what that
     * vocabulary is (the schema speaks for itself). Good contributions
     * tell the model:
     *   - What tone/tense to use (e.g. "use first names for Person nodes")
     *   - What NOT to say (e.g. "distinguish legal info from legal advice")
     *   - When to call which tool (e.g. "before suggesting edits, call
     *     gitnexus_impact on the affected symbol")
     *
     * Core concatenates contributions in plugin registration order,
     * separated by blank lines, after the base prompt. Plugins are
     * responsible for not contradicting each other — collisions are
     * not refereed; the later contribution wins if both speak to the
     * same instruction.
     */
    contributeSystemPrompt?(ctx: PluginContext): string | null;

    /**
     * Q1.8 — Plugin recalibrate hook. Given a plugin-owned node marker
     * (e.g. `file:src/foo.ts`, `symbol:<uid>`), rebuild the node's
     * semantic edges against the latest graph state. Called by the
     * /api/chat/action `reconnect_node` dispatcher when the node id
     * carries a non-core prefix.
     *
     * Return shape mirrors core `reconnectOneNode`:
     *   { added: <edges written>, confidences: <sim scores, 0..1> }
     *
     * Return `null` when this plugin doesn't own the marker's prefix —
     * the server iterates remaining plugins until one claims it or all
     * return null (in which case the dispatcher responds with 400).
     *
     * The hook is intentionally given a `PluginContext` (not just
     * PluginGraphContext) so plugins can reach the verbatim store,
     * syncEngine, etc. without another indirection. `ctx.graph` is the
     * LocalGraph; `ctx.verbatimStore` is the VerbatimStore. Plugins
     * cast to the concrete types they already import directly.
     *
     * Implementations should:
     *   1. Check the marker prefix; return null if unrecognized.
     *   2. Look up the node in the plugin's own tables.
     *   3. Build embedding text and re-store via verbatim with the
     *      plugin's canonical prefixed id.
     *   4. Run a vector search, filter by minSim, and route matches
     *      through the same `routeReconnectEdge` path used by the
     *      full reconnect pass (or whatever plugin-specific rel tables
     *      apply).
     */
    recalibrate?(
        markerId: string,
        ctx: PluginContext,
    ): Promise<{ added: number; confidences: number[] } | null>;

    /**
     * Q1.5 — contribute analytical projections.
     *
     * Returning an array of AnalyticalProjection descriptors. Each
     * projection is a named, runnable shape-of-data question. Core's
     * `analyze_graph` tool aggregates projections across active plugins,
     * routes a natural-language query to the best-matching projection
     * (by intentKeywords), and returns tabular results.
     *
     * Returning `null` or `[]` opts the plugin out — no projections
     * surface in `analyze_graph`, but the plugin's nodes are still
     * reachable via `recall` and its native tools.
     *
     * The user can further disable a plugin's projections at runtime
     * via `config.analyticalProjections.perPluginOptOut`. Core honors
     * the opt-out before calling this hook; plugins don't need to
     * self-gate.
     *
     * Projections run LOCAL queries against the plugin's own tables —
     * no network, airplane-mode compatible. Execution is wrapped by
     * the registry so exceptions don't crash chat.
     */
    contributeAnalyticalProjections?(): AnalyticalProjection[] | null;

    /**
     * Contribute plugin-specific stats to `graph.getStats()`.
     *
     * Core emits nodeCount / edgeCount / typeBreakdown (label-introspected
     * from Kùzu). Anything plugin-specific — `codeSymbolCount`,
     * `memoryCount`, `contractCount` — lives here, keyed by the plugin's
     * own metric names. Results land under `stats.pluginStats[pluginName]`.
     *
     * Returning `null` or `{}` opts out.
     */
    contributeStats?(ctx: PluginGraphContext): Promise<Record<string, number> | null>;

    /**
     * Contribute plugin-specific graph validations.
     *
     * Each entry is a human-readable warning the plugin discovered while
     * linting its own tables (e.g. "3 bug_pattern nodes aren't linked to
     * any CodeSymbol"). Core aggregates warnings from all active plugins
     * into the graph-report warning list; plugins never name each other's
     * vocabulary.
     *
     * Returning `null` or `[]` opts out.
     */
    contributeValidations?(ctx: PluginGraphContext): Promise<Array<{ warning: string }> | null>;

    /**
     * Register CLI subcommands this plugin contributes.
     *
     * Returned map key becomes `lore <command>`; the value supplies a
     * handler (given CLI args) and a short help line. The plugin owns
     * any plugin-specific vocabulary in help text — core CLI just lists
     * and dispatches. Returning `null` or `{}` opts out.
     *
     * Handlers receive CLI args directly; they're responsible for
     * booting whatever they need (graph, config, etc.). The plugin's
     * own tests exercise them; core CLI treats them as opaque.
     */
    registerCliCommands?(): Record<string, { help: string; handler: (args: string[]) => Promise<void> }> | null;

    /**
     * Contribute plugin-specific doctor checks.
     *
     * Each check runs during `lore doctor` and contributes a line to
     * the health report. Core owns graph / schema / filesystem checks;
     * plugins own their own (e.g. GitNexus CLI availability for the
     * developer plugin). An `ok: false` result increments the issue
     * count that `lore doctor` exits non-zero on.
     *
     * Returning `null` or `[]` opts out.
     */
    contributeDoctorChecks?(ctx: PluginContext): Promise<Array<{ label: string; ok: boolean; message: string }> | null>;
}
