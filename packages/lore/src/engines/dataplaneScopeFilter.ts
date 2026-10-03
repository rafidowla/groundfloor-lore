/**
 * dataplaneScopeFilter.ts — the ONE place cloud (Dataplane) scope, row keys and
 * engine filters are built. Pure: no SDK import, no I/O.
 *
 * Purpose:
 *   Cloud mode stores many Lore workspaces inside one Dataplane workspace (the
 *   Dataplane workspace is fixed by the API credential — the engine ignores
 *   X-Tenant-Id). Every row therefore carries `org_id`, `lore_workspace` and
 *   `lore_id`, its physical primary key `id` is a hashed row key (D2), and every
 *   read/write is filtered by the scope built here.
 *
 * Wire format:
 *   The engine's filter is a serde externally-tagged tree — `"all"`,
 *   `{field:{field,operator,value}}`, `{and:[…]}`, `{or:[…]}`, `{not:…}` — with
 *   tagged values (`{string}`, `{integer}`, `{float}`, `{boolean}`, `{array}`,
 *   null = `"null"`). There is no flat / suffix-key deserializer, so this module
 *   NEVER emits a flat map (`{org_id:'x'}`, `{tags_contains:'y'}` …).
 *
 * Server filter vs client predicate:
 *   The server filter is an optimisation; the client predicate is the guarantee.
 *   Two of the four routes accept no filter at all (keyword `/search`, graph
 *   `/traverse`) and vector `metadata_filter` push-down is connector-dependent
 *   (Arango ignores it; Qdrant keeps only string-valued top-level/`and` Fields
 *   and treats every operator as equality). So `buildDataplaneScopeFilter` returns
 *   both, and callers MUST apply `clientPredicate` to whatever comes back.
 *
 * Error Behavior:
 *   Missing Lore workspace → DataplaneScopeError('cloud_scope_missing_workspace').
 *   Fail closed, never default. A workspace not in the instance's registry →
 *   'cloud_scope_workspace_not_allowed'. A returned row that does not belong to
 *   the scope → guardScope() false (callers drop + log; mismatch on a keyed get
 *   is 'cloud_scope_mismatch').
 */

import { createHash } from 'node:crypto';

/* ─── Types ───────────────────────────────────────────────────── */

export interface DataplaneScope {
    orgId: string;
    /**
     * The Lore workspace's PERMANENT ID (registry entry `id`, never its name). Stored in the
     * `lore_workspace` column, part of the D2 row key and every scope filter, so a rename keeps the
     * rows and a delete-then-recreate (new id) cannot see the old ones.
     */
    loreWorkspace: string;
    /**
     * The name (or alias) the caller addressed (X-Lore-Workspace / ALS). Never stored; used only to
     * compare with caller-supplied names (see `scopeWorkspaceName`). Always set by resolveDataplaneScope;
     * optional only so a hand-built scope (tests, id === name) keeps working.
     */
    workspaceName?: string;
    /** Groundfloor portal workspace = engine tenant. Credential-fixed; NOT used for routing. */
    dataplaneWorkspaceId: string;
}

/** The workspace NAME the caller addressed (falls back to the id for a hand-built scope where id === name). */
export const scopeWorkspaceName = (scope: DataplaneScope): string => scope.workspaceName ?? scope.loreWorkspace;

export type EngineOp =
    | 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte'
    | 'in' | 'nin' | 'contains' | 'starts_with' | 'ends_with' | 'exists' | 'regex';

export type EngineValue =
    | { string: string }
    | { integer: number }
    | { float: number }
    | { boolean: boolean }
    | { array: EngineValue[] }
    | 'null';

export type EngineFieldClause = { field: { field: string; operator: EngineOp; value: EngineValue } };

export type EngineFilter =
    | 'all'
    | EngineFieldClause
    /** Exact physical-id lookup (`{"id_eq": "<row id>"}`): the one filter the engine's SQLite connector pushes down. */
    | { id_eq: string }
    | { and: EngineFilter[] }
    | { or: EngineFilter[] }
    | { not: EngineFilter };

export interface ScopeFilterInput {
    /** lore_id eq (string) / in (array). */
    loreId?: string | readonly string[];
    type?: string | readonly string[];
    /** eq; '' or '*' = no clause (matches the local "all projects" behaviour). */
    project?: string;
    ecosystem?: string;
    /** all-of. Server `contains` narrows (tags are stored comma-joined); the client checks exact elements. */
    tags?: readonly string[];
    /** 'current' adds `revision_state eq 'current'`; 'any'/undefined adds no clause. */
    revision?: 'current' | 'any';
    extra?: ReadonlyArray<{
        field: string;
        op: EngineOp;
        value: string | number | boolean | null | readonly (string | number)[];
    }>;
}

export type ScopeRoute = 'crud' | 'vector' | 'keyword' | 'traverse';

export interface BuiltScopeFilter {
    /** Filter to send to the engine, or null when the route accepts none / nothing to send. */
    server: EngineFilter | null;
    /** Apply to every row/vertex the engine returns (raw rows: `lore_id`, not yet mapped to `id`). */
    clientPredicate: (row: Record<string, unknown>) => boolean;
    /** How many rows to ask the engine for (over-fetch compensates for client post-filtering). */
    fetchLimit: number;
}

export type DataplaneScopeErrorCode =
    | 'cloud_scope_missing_workspace'
    | 'cloud_scope_workspace_not_allowed'
    | 'cloud_scope_mismatch'
    | 'cloud_scope_invalid_identifier';

export class DataplaneScopeError extends Error {
    readonly code: DataplaneScopeErrorCode;
    constructor(code: DataplaneScopeErrorCode, message: string) {
        super(message);
        this.name = 'DataplaneScopeError';
        this.code = code;
    }
}

/* ─── Scope resolution ────────────────────────────────────────── */

/**
 * The Lore workspaces THIS instance serves: a synchronous membership test plus the name -> permanent
 * id mapping. Production passes a view over the instance's own workspace registry
 * (mcp/cloudBootConfig.ts) that reflects registry changes without a restart. There is no wildcard:
 * a workspace that is not registered, or has no id, is never served.
 */
export interface LoreWorkspaceRegistry {
    /** True when `name` (a workspace name or alias) is registered. */
    has(name: string): boolean;
    /** The permanent id of the entry `name` resolves to (aliases resolve to their target's id); undefined = unknown or no usable id (fail closed). */
    resolveId(name: string): string | undefined;
}

/**
 * Resolve the per-call scope. Runs on EVERY operation (not only first init) so the
 * registry and the ALS workspace are always current. Fails closed.
 */
export function resolveDataplaneScope(cfg: {
    orgId: string;
    dataplaneWorkspaceId: string;
    workspaceRegistry: LoreWorkspaceRegistry;
    loreWorkspaceProvider: () => string;
}): DataplaneScope {
    let ws: string | undefined;
    try {
        ws = cfg.loreWorkspaceProvider();
    } catch (err) {
        throw new DataplaneScopeError(
            'cloud_scope_missing_workspace',
            `no Lore workspace bound to this operation (${(err as Error).message})`,
        );
    }
    if (typeof ws !== 'string' || ws.trim() === '') {
        throw new DataplaneScopeError(
            'cloud_scope_missing_workspace',
            'no Lore workspace bound to this operation',
        );
    }
    assertNoSeparator('org id', cfg.orgId);
    assertNoSeparator('Lore workspace', ws);
    if (!cfg.workspaceRegistry || !cfg.workspaceRegistry.has(ws)) {
        throw new DataplaneScopeError(
            'cloud_scope_workspace_not_allowed',
            `Lore workspace '${ws}' is not registered in this Lore instance`,
        );
    }
    const id = cfg.workspaceRegistry.resolveId(ws);
    if (typeof id !== 'string' || id === '') {
        throw new DataplaneScopeError(
            'cloud_scope_workspace_not_allowed',
            `Lore workspace '${ws}' has no permanent id in this Lore instance's registry`,
        );
    }
    assertNoSeparator('Lore workspace id', id);
    return { orgId: cfg.orgId, loreWorkspace: id, workspaceName: ws, dataplaneWorkspaceId: cfg.dataplaneWorkspaceId };
}

/**
 * Scope columns every cloud collection carries (D1). Lore stays application-agnostic:
 * applications map their own concepts (client, engagement, sensitivity …) onto Lore
 * workspaces, `project`, tags and security scopes — Lore adds no app-specific columns.
 */
export const SCOPE_COLUMNS = [
    { name: 'lore_workspace', field_type: 'string', required: true, indexed: true },
    { name: 'lore_id', field_type: 'string', required: true, indexed: true },
] as const;

/** Composite unique index: one logical id per (org, Lore workspace) — backs the D2 row key. */
export const SCOPE_KEY_INDEX = { name: 'scope_key', fields: ['org_id', 'lore_workspace', 'lore_id'], unique: true } as const;

/* ─── Row keys ────────────────────────────────────────────────── */

const SEP = '\u001f';

/**
 * The row-key preimage joins its parts with U+001F, so a part containing U+001F
 * could make two different (org, workspace, id) triples hash identically
 * ((o,"a␟b","c") vs (o,"a","b␟c")) — a 409 DoS on the colliding row. Rather than
 * change the `lw1_` hash scheme (which would orphan every stored row) we refuse
 * such inputs: no legitimate id, workspace name or org id contains a control char.
 */
function assertNoSeparator(what: string, v: string): void {
    if (typeof v === 'string' && v.includes(SEP)) {
        throw new DataplaneScopeError('cloud_scope_invalid_identifier', `${what} must not contain the U+001F control character`);
    }
}

/** D2: physical primary key = 'lw1_' + sha256hex(org ␟ workspace ␟ logicalId). `lw1_` versions the scheme. */
export function dataplaneRowKey(scope: DataplaneScope, loreId: string): string {
    assertNoSeparator('org id', scope.orgId);
    assertNoSeparator('Lore workspace id', scope.loreWorkspace);
    assertNoSeparator('logical id', loreId);
    return 'lw1_' + createHash('sha256')
        .update(`${scope.orgId}${SEP}${scope.loreWorkspace}${SEP}${loreId}`)
        .digest('hex');
}

/** Scope + identity columns every write must carry. */
export function scopeRowFields(
    scope: DataplaneScope,
    loreId: string,
): { id: string; lore_id: string; lore_workspace: string; org_id: string } {
    return {
        id: dataplaneRowKey(scope, loreId),
        lore_id: loreId,
        lore_workspace: scope.loreWorkspace,
        org_id: scope.orgId,
    };
}

/**
 * Defence in depth on any row read back: it must belong to this org + Lore
 * workspace and carry a logical id; when `loreId` is given it must be that id,
 * and (when the row exposes its physical `id`) that id must be the row key.
 */
export function guardScope(row: Record<string, unknown>, scope: DataplaneScope, loreId?: string): boolean {
    if (!row || typeof row !== 'object') return false;
    if (row['org_id'] !== scope.orgId) return false;
    if (row['lore_workspace'] !== scope.loreWorkspace) return false;
    const rowLoreId = row['lore_id'];
    if (typeof rowLoreId !== 'string' || rowLoreId === '') return false;
    if (loreId !== undefined && rowLoreId !== loreId) return false;
    const physical = row['id'];
    if (typeof physical === 'string' && physical !== dataplaneRowKey(scope, rowLoreId)) return false;
    return true;
}

/* ─── Engine filter building blocks ───────────────────────────── */

export function engineValue(v: unknown): EngineValue {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'boolean') return { boolean: v };
    if (typeof v === 'number') return Number.isInteger(v) ? { integer: v } : { float: v };
    if (typeof v === 'string') return { string: v };
    if (Array.isArray(v)) return { array: v.map(engineValue) };
    return { string: String(v) };
}

/** One leaf clause, tagged exactly as the SDK QueryBuilder `wrap()` does (plus null → "null"). */
export function engineField(field: string, op: EngineOp, v: unknown): EngineFieldClause {
    return { field: { field, operator: op, value: engineValue(v) } };
}

/** `{ id_eq: <physical row id> }`: an exact id lookup (see the SQLite push-down note on `EngineFilter`). */
export const engineIdEq = (id: string): { id_eq: string } => ({ id_eq: id });

/** and[] with the single-clause / empty collapses the engine expects (`all` = match everything). */
export function engineAnd(clauses: EngineFilter[]): EngineFilter {
    if (clauses.length === 0) return 'all';
    if (clauses.length === 1) return clauses[0]!;
    return { and: clauses };
}

/* ─── Builder ─────────────────────────────────────────────────── */

const isMany = (v: unknown): v is readonly string[] => Array.isArray(v);
const isWildcard = (v: string | undefined): boolean => v === undefined || v === '' || v === '*';

function strClause(field: string, v: string | readonly string[] | undefined, out: EngineFilter[]): void {
    if (v === undefined) return;
    if (isMany(v)) {
        if (v.length === 1) out.push(engineField(field, 'eq', v[0]));
        else out.push(engineField(field, 'in', [...v]));
    } else out.push(engineField(field, 'eq', v));
}

/** String-eq clause only when the input is single-valued (vector push-down honours nothing else). */
function strEqOnly(field: string, v: string | readonly string[] | undefined, out: EngineFilter[]): void {
    if (v === undefined) return;
    if (isMany(v)) {
        if (v.length === 1) out.push(engineField(field, 'eq', v[0]));
        return;
    }
    out.push(engineField(field, 'eq', v));
}

function asList(v: string | readonly string[] | undefined): readonly string[] | undefined {
    if (v === undefined) return undefined;
    return isMany(v) ? v : [v];
}

function tagList(raw: unknown): string[] {
    if (Array.isArray(raw)) return raw.map(String).map((t) => t.trim()).filter(Boolean);
    if (typeof raw === 'string') return raw.split(',').map((t) => t.trim()).filter(Boolean);
    return [];
}

function cmp(a: unknown, b: unknown): number {
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    const as = String(a), bs = String(b);
    return as < bs ? -1 : as > bs ? 1 : 0;
}

function matchesExtra(
    row: Record<string, unknown>,
    e: NonNullable<ScopeFilterInput['extra']>[number],
): boolean {
    const has = Object.prototype.hasOwnProperty.call(row, e.field) && row[e.field] !== undefined && row[e.field] !== null;
    const v = row[e.field];
    if (e.op === 'exists') return (e.value === false) ? !has : has;
    if (!has) return e.op === 'ne' || e.op === 'nin';
    const want = e.value;
    switch (e.op) {
        case 'eq': return v === want || String(v) === String(want);
        case 'ne': return !(v === want || String(v) === String(want));
        case 'gt': return cmp(v, want) > 0;
        case 'gte': return cmp(v, want) >= 0;
        case 'lt': return cmp(v, want) < 0;
        case 'lte': return cmp(v, want) <= 0;
        case 'in': return Array.isArray(want) && want.some((w) => String(w) === String(v));
        case 'nin': return !(Array.isArray(want) && want.some((w) => String(w) === String(v)));
        case 'contains': return String(v).toLowerCase().includes(String(want).toLowerCase());
        case 'starts_with': return String(v).toLowerCase().startsWith(String(want).toLowerCase());
        case 'ends_with': return String(v).toLowerCase().endsWith(String(want).toLowerCase());
        case 'regex': {
            try { return new RegExp(String(want)).test(String(v)); } catch { return false; }
        }
        default: return false;
    }
}

function makeClientPredicate(
    scope: DataplaneScope,
    input: ScopeFilterInput,
    mode: 'full' | 'traverse' | 'crud',
): (row: Record<string, unknown>) => boolean {
    const ids = asList(input.loreId);
    const types = asList(input.type);
    const wantTags = (input.tags ?? []).map((t) => t.trim()).filter(Boolean);
    return (row) => {
        if (!guardScope(row, scope)) return false;
        if (ids && !ids.includes(row['lore_id'] as string)) return false;
        if (types && !types.includes(String(row['type'] ?? ''))) return false;
        if (!isWildcard(input.project) && row['project'] !== input.project) return false;
        if (!isWildcard(input.ecosystem) && row['ecosystem'] !== input.ecosystem) return false;
        if (mode === 'traverse') return true;
        if (wantTags.length > 0) {
            if (mode === 'crud') {
                // Mirror the server clause exactly: `tags contains <tag>` is a case-insensitive
                // substring test over the stored (comma-joined) tag string.
                const hay = tagList(row['tags']).join(',').toLowerCase();
                for (const t of wantTags) if (!hay.includes(t.toLowerCase())) return false;
            } else {
                const have = new Set(tagList(row['tags']));
                for (const t of wantTags) if (!have.has(t)) return false;
            }
        }
        if (input.revision === 'current') {
            const rs = row['revision_state'];
            if (mode === 'crud') {
                if (rs !== 'current') return false; // server: `revision_state eq 'current'` (a missing field never matches)
            } else if (rs !== undefined && rs !== null && rs !== '' && rs !== 'current') return false;
        }
        for (const e of input.extra ?? []) if (!matchesExtra(row, e)) return false;
        return true;
    };
}

/** Clauses shared by the crud route: everything the caller asked for (after org + workspace). */
function callerClauses(input: ScopeFilterInput): EngineFilter[] {
    const c: EngineFilter[] = [];
    strClause('lore_id', input.loreId, c);
    strClause('type', input.type, c);
    if (!isWildcard(input.project)) c.push(engineField('project', 'eq', input.project));
    if (!isWildcard(input.ecosystem)) c.push(engineField('ecosystem', 'eq', input.ecosystem));
    for (const t of input.tags ?? []) {
        const tag = t.trim();
        if (tag) c.push(engineField('tags', 'contains', tag));
    }
    if (input.revision === 'current') c.push(engineField('revision_state', 'eq', 'current'));
    for (const e of input.extra ?? []) c.push(engineField(e.field, e.op, e.value));
    return c;
}

function clampLimit(limit: number): number {
    return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
}

/**
 * Build the per-route scope filter. See the file header for why both halves exist.
 * traverse: `fetchLimit` is the caller's `limit` unchanged (0 = engine default).
 */
export function buildDataplaneScopeFilter(
    scope: DataplaneScope,
    input: ScopeFilterInput,
    route: ScopeRoute,
    limit: number,
): BuiltScopeFilter {
    const lim = clampLimit(limit);
    const base = (): EngineFilter[] => [
        engineField('org_id', 'eq', scope.orgId),
        engineField('lore_workspace', 'eq', scope.loreWorkspace),
    ];
    switch (route) {
        case 'crud':
            return {
                server: engineAnd([...base(), ...callerClauses(input)]),
                // Full predicate, not scope-only: connectors that ignore the pushed filter
                // (SQLite pushes down id_eq only) would otherwise return rows violating
                // type/project/tags/cursor and every crud read would return them.
                clientPredicate: makeClientPredicate(scope, input, 'crud'),
                fetchLimit: lim,
            };
        case 'vector': {
            const c = base();
            strEqOnly('type', input.type, c);
            if (!isWildcard(input.project)) c.push(engineField('project', 'eq', input.project));
            if (!isWildcard(input.ecosystem)) c.push(engineField('ecosystem', 'eq', input.ecosystem));
            if (input.revision === 'current') c.push(engineField('revision_state', 'eq', 'current'));
            return {
                server: engineAnd(c),
                clientPredicate: makeClientPredicate(scope, input, 'full'),
                fetchLimit: Math.min(100, Math.max(lim * 4, lim + 20)),
            };
        }
        case 'keyword':
            return {
                server: null,
                clientPredicate: makeClientPredicate(scope, input, 'full'),
                fetchLimit: Math.min(500, Math.max(lim * 10, 50)),
            };
        case 'traverse':
            return {
                server: null,
                clientPredicate: makeClientPredicate(scope, input, 'traverse'),
                fetchLimit: lim,
            };
    }
}
