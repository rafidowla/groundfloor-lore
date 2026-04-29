/**
 * Plugin manifest — bundle-level descriptor.
 *
 * Canonical TypeScript types for `plugin.json` (or `plugin.yaml`) at the
 * root of a plugin bundle. The manifest sits **above** the runtime
 * `ILorePlugin` contract in `./types.ts`:
 *
 *   - `ILorePlugin` is what the **Lore daemon** loads and calls hooks on.
 *   - `PluginManifest` is what the **shell** (Tauri host) reads to decide
 *     what tabs to render, whether DEF must be activated, and which
 *     permissions to request — all *before* booting either daemon.
 *
 * Two primitives, one shell. Lore and DEF stay decoupled runtimes; this
 * manifest is the integration contract. See `docs/plugin-manifest-spec.md`
 * for the human-readable spec, decision log, and migration path. Any
 * divergence between the spec and these types is a bug in the spec doc —
 * these types are authoritative.
 *
 * Plugin-boundary note: this file is *core-allowed* alongside `types.ts`
 * and `registry.ts` (see CLAUDE.md). It defines the shared shape the
 * shell + plugins both speak; it does not import plugin-owned vocabulary.
 */

// ────────────────────────────────────────────────────────────────────────
// Top-level manifest
// ────────────────────────────────────────────────────────────────────────

/**
 * The complete bundle-level manifest. At least one of `lore` or `def`
 * MUST be present — a manifest contributing to neither primitive is
 * invalid and the shell rejects it at load time.
 */
export interface PluginManifest {
    /** Bumps on breaking spec changes. v1 is the initial release. */
    manifestVersion: 1;

    /** Globally unique identifier. kebab-case. */
    name: string;

    /** semver. */
    version: string;

    /** One-line human description shown in the shell's install prompt. */
    description: string;

    /** Optional metadata. */
    author?: string;
    license?: string;
    homepage?: string;

    /** Lore primitive contributions. */
    lore?: LoreContribution;

    /** DEF primitive contributions. */
    def?: DEFContribution;

    /** Compatibility ranges (semver). */
    engines?: EngineRequirements;
}

export interface EngineRequirements {
    /** Minimum Lore daemon version. semver range. */
    lore?: string;
    /** Minimum DEF runtime version. semver range. */
    def?: string;
}

// ────────────────────────────────────────────────────────────────────────
// Lore contribution
// ────────────────────────────────────────────────────────────────────────

export interface LoreContribution {
    /**
     * Path (relative to the manifest) to the JS module whose default
     * export is an `ILorePlugin` instance. The Lore daemon dynamically
     * imports this when the plugin is activated.
     *
     * Optional as of Task-2 (Tier 1 plugins): a manifest may omit
     * `module` and declare a `schema` block instead, in which case the
     * daemon synthesises a no-code `ILorePlugin` from the manifest.
     * Existing TypeScript plugins still set `module` and ignore
     * `schema`. A manifest must declare at least one of `module` or
     * `schema`.
     *
     * All existing `ILorePlugin` hooks (registerTools, registerSchema,
     * contributeReconnectNodes, etc.) work unchanged for plugins that
     * use the `module` path.
     */
    module?: string;

    /**
     * Declarative schema contribution — Tier 1 plugins (no TypeScript)
     * declare node types and edge relations here. The daemon merges
     * these into core's `store_node` / `store_edge` enums via the
     * existing `contributeNodeTypes` / `contributeEdgeRelations` hooks.
     *
     * Tier 1 scope: type *names + descriptions* only. Typed tables with
     * field schemas are a Tier 2 extension that pairs with auto-generated
     * MCP tools (planned).
     */
    schema?: LoreSchema;

    /**
     * Declarative inspector panels the shell renders as tabs under this
     * plugin's section in the workspace UI. Pure data; no code injection.
     */
    inspectors?: InspectorPanel[];

    /** Host capabilities the Lore-side parts require. */
    permissions?: Permission[];

    /**
     * Tier 1 declarative ingestion. Each entry describes a tabular
     * source file (CSV or JSON array) and how its rows map to nodes
     * in core's `LoreNode` table via `store_node`. The daemon does NOT
     * auto-run these on boot; a Tier 1 plugin's ingest is on-demand
     * (via the `lore_plugin_ingest` MCP tool or future CLI).
     *
     * Multiple ingest entries are run in declaration order. Each entry
     * is independent; failures in one don't block others.
     */
    ingest?: IngestSpec[];

    /**
     * Tier 1 named query templates. Each entry declares a parameterised
     * Cypher query that the daemon registers as an MCP tool named
     * `<plugin>_<queryId>` (plugin-prefixed because query ids don't
     * have a global-uniqueness guarantee).
     *
     * Local-mode only today: queries hit Kùzu via the (deprecated)
     * raw-Cypher path on PluginGraphContext. Cloud-mode AQL templates
     * are a separate slice when the use case shows up.
     */
    queries?: QuerySpec[];

    /**
     * Tier 3 declarative settings — fields the plugin needs the user to
     * configure (API endpoints, cron schedules, feature toggles). The
     * shell auto-renders a settings panel from this declaration; values
     * are persisted to `<LORE_HOME>/manifests/<plugin>/settings.json`.
     *
     * Plugins read their settings via the `/api/plugins/<name>/settings`
     * endpoint (GET → current values, PUT → update). MCP tools running
     * in the daemon can also read them via the same endpoint.
     */
    settings?: SettingsField[];
}

/**
 * A single user-configurable setting. The shell renders an input
 * appropriate to the type; the value gets persisted as JSON.
 */
export interface SettingsField {
    /** Stable id within this plugin. Sent to the API as the property key. */
    name: string;
    /** Human-readable label shown in the settings panel. */
    label: string;
    /** Input type. */
    type: 'string' | 'number' | 'boolean' | 'secret';
    /** One-line description shown beneath the input. */
    description: string;
    /** Initial value when no override is present. */
    default?: string | number | boolean;
    /** When true, the field cannot be empty. */
    required?: boolean;
    /** When type='secret', the value is stored in the keychain (never in
     *  settings.json) and the API only ever returns a "set" indicator. */
}

/**
 * Tier 1 named-query spec.
 *
 * Two shapes accepted:
 *
 *   1. Raw cypher form: `{ id, description, cypher, parameters }` — plugin
 *      author writes the Cypher body. Parameters bind via Kùzu's `$param`
 *      parameterised query syntax — never string-interpolated.
 *
 *   2. Stock-pattern form: `{ id, description, pattern, bindNodeType, parameters }` —
 *      plugin author references a named pattern from the stock catalog
 *      (e.g. `find_by_field`). The daemon expands the pattern with the
 *      plugin's node type at boot. Cypher is never written by the plugin.
 *
 * Both forms produce the same registered MCP tool: `<plugin>_<id>`.
 *
 * Discriminated by the presence/absence of `cypher` vs `pattern`:
 *   - `cypher` set, no `pattern`     → raw form
 *   - `pattern` + `bindNodeType` set → stock form
 *   - both set or neither set        → invalid (validator rejects)
 */
export type QuerySpec = RawCypherQuerySpec | PatternQuerySpec;

export interface RawCypherQuerySpec {
    /** Stable id within this plugin. The MCP tool name is `<plugin>_<id>`. */
    id: string;
    /** One-line human description; surfaces in the MCP tool's help text. */
    description: string;
    /** Cypher query body. Reference parameters as `$name` (matching `parameters[].name`). */
    cypher: string;
    /** Declared parameters. The daemon validates the caller's args against this list. */
    parameters?: QueryParameter[];
}

export interface PatternQuerySpec {
    /** Stable id within this plugin. The MCP tool name is `<plugin>_<id>`. */
    id: string;
    /** One-line human description; surfaces in the MCP tool's help text. */
    description: string;
    /** Stock-pattern name from the catalog (find_by_field, count_by_field, …). */
    pattern: string;
    /** The plugin's node type to bind to the pattern. Must match a declared
     *  `lore.schema.nodeTypes[*].name`. */
    bindNodeType: string;
    /** Declared parameters. Must satisfy the pattern's required parameter shape. */
    parameters?: QueryParameter[];
}

export interface QueryParameter {
    /** Parameter name. Matches `$name` in the cypher body. */
    name: string;
    /** Scalar type the daemon coerces the caller's arg to. */
    type: 'string' | 'number' | 'boolean';
    /** One-line description shown in MCP tool help. */
    description: string;
    /** When true, MCP rejects calls that omit this arg. Defaults to true. */
    required?: boolean;
}

/**
 * Tier 1/2 ingest spec.
 *
 * Tier 1 (file source): `source: 'csv' | 'json'` + `file:` reads a local
 * tabular file relative to the manifest bundle.
 *
 * Tier 2 (HTTP source): `source: 'http'` + `url:` + optional `auth:` /
 * `pagination:` / `responsePath:` declaratively fetches from any REST
 * API and treats the response as rows. No code required.
 *
 * Both forms produce the same `store_node` calls via the same runner.
 */
export interface IngestSpec {
    /** Stable id within this plugin (used by the trigger tool to address one
     *  spec when a plugin declares many). Defaults to the index when omitted. */
    id?: string;
    /** Source type. csv/json read a file; http calls a REST API. */
    source: 'csv' | 'json' | 'http';

    /** File-source only: path to the source file. Relative paths resolve
     *  against the manifest's bundle dir; absolute paths used as-is. */
    file?: string;

    /** HTTP-source only: URL template. `{{var}}` placeholders interpolate
     *  from the caller's `vars` arg at call time (e.g. `{{since}}` for a
     *  cursor). Any `{{var}}` not referenced in the manifest's `vars[]`
     *  declarations fails validation. */
    url?: string;
    /** HTTP-source only: declared variables the caller may pass to fill
     *  URL placeholders. Same shape as query parameters. */
    vars?: QueryParameter[];
    /** HTTP-source only: HTTP method. Defaults to GET. */
    method?: 'GET' | 'POST';
    /** HTTP-source only: declarative auth shape. Stored credential is
     *  resolved from the daemon's keychain by key name. */
    auth?: IngestAuth;
    /** HTTP-source only: extra HTTP request headers. */
    headers?: Record<string, string>;
    /** HTTP-source only: dot-path into the JSON response that holds the
     *  row array. Defaults to the response root if it's already an array.
     *  Examples: `data`, `result.items`, `data.users`. */
    responsePath?: string;
    /** HTTP-source only: pagination strategy. */
    pagination?: IngestPagination;

    /** Which node-type each row becomes. MUST be one of the node types
     *  declared in this plugin's `lore.schema.nodeTypes`. */
    mapTo: string;
    /** How to derive the node id from each row (drives idempotency on re-run). */
    idStrategy: IngestIdStrategy;
    /** CSV column / JSON key / response-row key → LoreNode field mapping.
     *  Source column names are the values; LoreNode field names are the keys. */
    fields: IngestFieldMap;
    /** CSV-only: delimiter character. Defaults to ",". */
    delimiter?: string;
    /** CSV-only: when a tags column maps to LoreNode.tags, split on this. Defaults to ",". */
    tagDelimiter?: string;
}

/**
 * Declarative auth for an HTTP ingest source. The daemon resolves the
 * key from its keychain (the same store the LLM provider's API key
 * lives in). Supported shapes:
 *
 *   - `{ kind: 'bearer', credentialKey: '<key>' }` → `Authorization: Bearer <secret>`
 *   - `{ kind: 'header', headerName: 'X-API-Key', credentialKey: '<key>' }` → custom header
 *   - `{ kind: 'basic', credentialKey: '<key>' }` → secret stored as `<user>:<pass>`, sent base64
 *   - `{ kind: 'none' }` → no auth header
 */
export type IngestAuth =
    | { kind: 'none' }
    | { kind: 'bearer'; credentialKey: string }
    | { kind: 'header'; headerName: string; credentialKey: string }
    | { kind: 'basic'; credentialKey: string };

/**
 * Pagination strategy for HTTP ingest. Three patterns cover most APIs:
 *
 *   - `{ kind: 'none' }` → single request only.
 *   - `{ kind: 'page', pageParam: 'page', sizeParam?: 'per_page', pageSize?: 100, maxPages?: 10 }`
 *     → numeric page increment until empty response or maxPages.
 *   - `{ kind: 'cursor', cursorPathInResponse: 'meta.next_cursor', cursorParam: 'cursor', maxRequests?: 10 }`
 *     → follow opaque cursor token from the response.
 */
export type IngestPagination =
    | { kind: 'none' }
    | { kind: 'page'; pageParam: string; sizeParam?: string; pageSize?: number; maxPages?: number }
    | { kind: 'cursor'; cursorPathInResponse: string; cursorParam: string; maxRequests?: number };

export type IngestIdStrategy =
    | { kind: 'column'; column: string }                // use a single source column
    | { kind: 'hash'; columns: string[]; algo?: 'sha1' };// hash 1+ columns for a stable id

/**
 * Source-key → LoreNode-field map. The keys are LoreNode field names;
 * the values are source column names (CSV header / JSON object key).
 *
 * Recognised LoreNode fields:
 *   - label, content, project, ecosystem, language : string
 *   - tags                                        : string[] (CSV: split by tagDelimiter; JSON: array or string)
 *
 * Any field not listed here is ignored — the manifest doesn't capture
 * full LoreNode shape, just the human-relevant subset.
 */
export interface IngestFieldMap {
    label?: string;
    content?: string;
    project?: string;
    ecosystem?: string;
    language?: string;
    tags?: string;
}

/**
 * Tier 1 schema declaration — pure-data, no TypeScript needed.
 *
 * Names and descriptions become entries in core's `store_node` /
 * `store_edge` enums when the plugin is active. The daemon synthesises
 * a minimal `ILorePlugin` with `contributeNodeTypes()` and
 * `contributeEdgeRelations()` returning these arrays.
 *
 * Names must be globally unique across active plugins (collision throws
 * at boot — same rule as TypeScript plugin contributions).
 */
export interface LoreSchema {
    /** Domain-specific node types this plugin introduces. */
    nodeTypes?: SchemaNodeType[];
    /** Domain-specific edge relations this plugin introduces. */
    edgeRelations?: SchemaEdgeRelation[];
}

export interface SchemaNodeType {
    /** kebab_or_snake_case identifier; merged into store_node's type enum. */
    name: string;
    /** One-line human description shown in tool help and discovery. */
    description: string;
}

export interface SchemaEdgeRelation {
    /** kebab_or_snake_case identifier; merged into store_edge's relation enum. */
    name: string;
    /** One-line human description. */
    description: string;
}

// ────────────────────────────────────────────────────────────────────────
// Inspectors — declarative UI panels
// ────────────────────────────────────────────────────────────────────────

/**
 * Renderer kinds the shell has built-in. Plugins describe data; the shell
 * owns pixels. Adding a new kind requires a `manifestVersion` bump.
 */
export type InspectorKind = 'table' | 'graph' | 'timeline' | 'document';

/**
 * Discriminated union of inspector panels. The `kind` field selects the
 * concrete panel shape.
 */
export type InspectorPanel =
    | TableInspector
    | GraphInspector
    | TimelineInspector
    | DocumentInspector;

/** Properties common to every inspector kind. */
interface InspectorBase {
    /** Stable id, unique per plugin. Used for tab routing + persistence. */
    id: string;
    /** Tab label shown in the shell. */
    label: string;
    /** Optional icon name from the shell's icon set. */
    icon?: string;
}

/** Tabular entity list with sortable columns + filters. */
export interface TableInspector extends InspectorBase {
    kind: 'table';
    /** Node label in the graph (e.g. "Email", "BankTransaction"). */
    entity: string;
    columns: InspectorColumn[];
    sort?: InspectorSort;
    filters?: InspectorFilter[];
    /** Optional: clicking a row opens this view focused on the record. */
    drilldown?: InspectorPanel;
}

/** Subgraph visualisation centred on an entity type. */
export interface GraphInspector extends InspectorBase {
    kind: 'graph';
    /** Root entity type to centre the graph on. */
    entity: string;
    /** Hops to expand from each root node. Default: 1. */
    depth?: number;
    /** Optional edge-type allowlist. Empty/undefined = all edges. */
    edgeTypes?: string[];
}

/** Time-ordered events keyed off a date field on the entity. */
export interface TimelineInspector extends InspectorBase {
    kind: 'timeline';
    entity: string;
    /** Field on the entity holding the event timestamp (ISO 8601). */
    dateField: string;
    /** Field shown as the event title in the timeline. */
    labelField: string;
    /** Optional: field whose value drives swim-lane grouping. */
    groupBy?: string;
}

/** Single-record view: full content + one-hop neighbours. */
export interface DocumentInspector extends InspectorBase {
    kind: 'document';
    /** Field used as the document title. */
    labelField: string;
    /** Field holding the body / long-form content. */
    contentField: string;
}

export interface InspectorColumn {
    /** Property on the entity. */
    field: string;
    /** Column header shown to the user. */
    label: string;
    /** Optional fixed pixel width. Mutually exclusive with `flex`. */
    width?: number;
    /** Optional flex weight. Mutually exclusive with `width`. */
    flex?: number;
    /** Renderer hint. Defaults to `string`. */
    type?: 'string' | 'number' | 'date' | 'boolean' | 'tags';
}

export interface InspectorSort {
    field: string;
    order: 'asc' | 'desc';
}

export type InspectorFilter =
    | { field: string; kind: 'text' }
    | { field: string; kind: 'number' }
    | { field: string; kind: 'date-range' }
    | { field: string; kind: 'select'; options: string[] }
    | { field: string; kind: 'multi-select'; options?: string[] }
    | { field: string; kind: 'boolean' };

// ────────────────────────────────────────────────────────────────────────
// DEF contribution
// ────────────────────────────────────────────────────────────────────────

export interface DEFContribution {
    /**
     * Whether DEF is required for the plugin to function.
     *
     * - `true` — install is blocked if DEF is absent; the shell prompts
     *   the user to activate DEF first.
     * - `false` (default) — DEF parts are optional. Lore parts install
     *   immediately; DEF parts are stored as **pending** and auto-activate
     *   when DEF is later enabled — no reinstall.
     *
     * Use `true` only when the plugin's value is fundamentally agentic.
     * For plugins that augment-with-agents but work without them, prefer
     * `false`.
     */
    required?: boolean;

    /**
     * Agent definitions the DEF runtime instantiates.
     *
     * The Lore daemon treats each entry as **opaque pass-through**. The
     * shell forwards the array to the DEF runtime's plugin loader; DEF
     * owns the schema. We model it as `unknown[]` (rather than `any[]`)
     * to force callers to validate before reaching into the shape — the
     * authoritative type lives in the DEF project.
     */
    agents?: AgentDescriptor[];

    /**
     * Cron-style or event-driven tasks. Same opaque-pass-through rule
     * as `agents` — DEF owns the schema.
     */
    scheduledTasks?: ScheduledTaskDescriptor[];

    /** Host capabilities the DEF-side parts require. */
    permissions?: Permission[];
}

/**
 * DEF agent descriptor. Opaque to Lore; DEF owns the canonical schema.
 *
 * The fields below are documented as a *guidance* shape for plugin
 * authors today, but Lore does not validate them — additional or
 * different fields are allowed and forwarded as-is. When DEF's spec
 * stabilises this type narrows to its real shape.
 */
export interface AgentDescriptor {
    /** Stable id, unique within the plugin. */
    name: string;
    /** Human-readable name shown in DEF's UI. */
    displayName?: string;
    /** System prompt. */
    system?: string;
    /** Model id (DEF resolves to a provider). */
    model?: string;
    /**
     * MCP tool references the agent may call. Format:
     * `lore:<plugin>:<tool>` for plugin-contributed tools, or
     * `lore:builtin:<tool>` for core Lore tools.
     */
    tools?: string[];
    /** Memory binding. `kind: 'lore'` ties the agent to a Lore workspace. */
    memory?: { kind: 'lore'; workspace: string } | { kind: string; [k: string]: unknown };
    /** DEF is allowed to define additional fields. */
    [k: string]: unknown;
}

/**
 * DEF scheduled-task descriptor. Same opaque-pass-through rule as
 * `AgentDescriptor`.
 */
export interface ScheduledTaskDescriptor {
    /** Stable id, unique within the plugin. */
    id: string;
    /** Agent name (within this plugin) the task invokes. */
    agent: string;
    /** Trigger spec — cron, event, or manual. */
    trigger: ScheduledTaskTrigger;
    /** Initial prompt the agent receives when the trigger fires. */
    prompt?: string;
    /** DEF is allowed to define additional fields. */
    [k: string]: unknown;
}

export type ScheduledTaskTrigger =
    | { kind: 'cron'; expression: string }
    | { kind: 'event'; topic: string }
    | { kind: 'manual' };

// ────────────────────────────────────────────────────────────────────────
// Permissions
// ────────────────────────────────────────────────────────────────────────

/**
 * Namespaced permission string. The shell asks the user to grant these
 * at install time. Format: `<namespace>:<verb>:<target>` (verb optional
 * for namespaces that don't need it).
 *
 * Known namespaces (v1):
 *   - `fs:read:<path>`           filesystem read
 *   - `fs:write:<path>`          filesystem write
 *   - `net:<host>:<port>`        outbound network (host:port allowlist)
 *   - `credentials:store:<key>`  keytar entry
 *   - `os:notifications`         OS notification surface
 *   - `os:clipboard`             clipboard read/write
 *
 * Unknown namespaces fail at install. The full registry lives in the
 * shell spec (out of scope for this file).
 */
export type Permission = string;

// ────────────────────────────────────────────────────────────────────────
// Validation helpers (pure type-only — runtime validation lives in the shell)
// ────────────────────────────────────────────────────────────────────────

/**
 * Compile-time guard: a manifest must declare at least one primitive
 * contribution. Use as `const m: ValidatedManifest = …` to catch the
 * empty-manifest case at the type level when manifests are constructed
 * in-tree (test fixtures, scaffolding tooling).
 *
 * Runtime manifests loaded from disk are validated by the shell; this
 * type only helps in-tree authoring.
 */
export type ValidatedManifest =
    | (PluginManifest & { lore: LoreContribution })
    | (PluginManifest & { def: DEFContribution });
