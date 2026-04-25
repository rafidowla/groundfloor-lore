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
     * All existing `ILorePlugin` hooks (registerTools, registerSchema,
     * contributeReconnectNodes, etc.) work unchanged. Existing plugins
     * become valid Phase-1 manifests by adding `plugin.json` referencing
     * their current `dist/index.js` here — no code changes needed.
     */
    module: string;

    /**
     * Declarative inspector panels the shell renders as tabs under this
     * plugin's section in the workspace UI. Pure data; no code injection.
     */
    inspectors?: InspectorPanel[];

    /** Host capabilities the Lore-side parts require. */
    permissions?: Permission[];
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
