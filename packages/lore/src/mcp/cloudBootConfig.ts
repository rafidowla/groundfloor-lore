/**
 * cloudBootConfig.ts — cloud-mode boot gates and the Lore-workspace registry view
 * (cloud parity C item 7; replaces cloudScopeConfig.ts).
 *
 * Model (Rafi, 2026-09-30, R2/R5):
 *   - org_id            = this Lore INSTANCE (fixed per process, `DATAPLANE_ORG_ID`).
 *   - lore_workspace    = the application tenant's PERMANENT ID (registry entry `id`, immutable),
 *     reached from the workspace NAME taken per call from AsyncLocalStorage (name or alias ->
 *     entry -> id, in `resolveDataplaneScope`). Rename keeps the id; delete + recreate gets a new
 *     one; legacy entries without an id are backfilled lazily, only here (config/workspaceIds.ts).
 *   - Dataplane workspace = fixed by the API credential (engine tenant, F2). It is NOT
 *     used for routing; it is carried for logging/health and mock key binding.
 *
 * Which Lore workspaces this instance serves is decided by the instance's OWN workspace
 * registry (`workspaces.json` under the data home), not by an environment allowlist.
 * The registry is consulted on EVERY operation (via `resolveDataplaneScope`), cached by
 * the control file's identity, and refreshed the moment the file changes — creating or
 * deleting a workspace takes effect without a restart. A workspace that is not in the
 * registry (or has no usable id) fails closed (`cloud_scope_workspace_not_allowed`); an
 * absent or unreadable registry serves nothing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadWorkspacesIfPresent, type WorkspaceEntry } from '../config/workspaces.js';
import { ensureWorkspaceIds, isValidWorkspaceId } from '../config/workspaceIds.js';
import type { LoreWorkspaceRegistry } from '../engines/dataplaneScopeFilter.js';
import { loreHome } from '../config/loreHome.js';

/**
 * requireDataplaneOrgId — Cloud-mode tenant-isolation boot gate (D4/G14). The org id scopes
 * every read and write; there is no safe default (a literal 'default' would silently collapse
 * every tenant into one org), so refuse to build any Dataplane-bound service without one.
 * Local mode never reaches this gate.
 */
export function requireDataplaneOrgId(): string {
    const orgId = process.env['DATAPLANE_ORG_ID'];
    if (!orgId) {
        throw new Error(
            '[Lore MCP] DATAPLANE_ORG_ID is required in cloud mode but is unset. ' +
                'Refusing to start: a missing org id would silently collapse every ' +
                "tenant into one 'default' org (cross-tenant data mixing). Set " +
                'DATAPLANE_ORG_ID to the tenant org id, or run in local mode ' +
                '(unset LORE_DEPLOYMENT_MODE / set it to "local").',
        );
    }
    return orgId;
}

/**
 * resolveDataplaneWorkspaceId — the Dataplane workspace the API credential is bound to.
 * `DATAPLANE_WORKSPACE_ID` is preferred; `DATAPLANE_TENANT_ID` is the legacy alias; the
 * historic default `groundfloor_lore` is kept so existing deployments keep booting. The
 * value is never a routing or authorisation input (the engine fixes the tenant from the
 * credential, F2): it is logging/health context only. The Lore-workspace boundary is the
 * instance registry, not this id.
 */
export function resolveDataplaneWorkspaceId(): string {
    return process.env['DATAPLANE_WORKSPACE_ID'] || process.env['DATAPLANE_TENANT_ID'] || 'groundfloor_lore';
}

/**
 * resolveDataplaneConnection — the ONE Dataplane connector every cloud call names (review C #1).
 * `DATAPLANE_CONNECTION` (trimmed; empty = unset). The engine resolves a connector PER ROUTE
 * when none is sent: sqlite for CRUD / query / bulk / vector, postgresql for keyword search and
 * `/v1/transaction`, surrealdb for graph traverse (handlers.rs get_or_create_connection and the
 * per-handler defaults), unless the engine's own `DEFAULT_CONNECTOR` overrides all of them. Two
 * routes of one logical store can then land on different databases. Naming the connection on every
 * route (graph, vector, version store, sync adapter) makes all of them agree.
 *
 * Unset is allowed (the engine's DEFAULT_CONNECTOR may already make every route agree) but it is
 * not safe to assume, so atomic history transactions are NOT attempted without it
 * (dataplaneTransaction.ts) and boot logs a warning.
 */
export function resolveDataplaneConnection(): string | undefined {
    const v = process.env['DATAPLANE_CONNECTION']?.trim();
    return v ? v : undefined;
}

export type { LoreWorkspaceRegistry };

/** Registry view over an instance's `workspaces.json`, with an explicit `invalidate()`. */
export interface WorkspaceRegistryView extends LoreWorkspaceRegistry {
    /** Names currently registered (fresh). */
    names(): ReadonlySet<string>;
    /** Drop the cache so the next `has()` re-reads the file. */
    invalidate(): void;
}

/**
 * createWorkspaceRegistry — registry view over `<home>/workspaces.json`.
 *
 * Freshness: every `has()` / `resolveId()` does one `statSync` and compares (mtimeMs, size, ino).
 * The control file is written write-temp-then-rename (`writeControl`), which changes the inode,
 * so even a same-size same-millisecond rewrite is detected. On any change the file is
 * re-read. The read itself never creates the file (an absent file reads as "nothing registered")
 * and any error reads as "nothing registered" — fail closed.
 *
 * Ids (review C #6): `resolveId(name)` maps a workspace name OR alias to its entry's PERMANENT id,
 * which is what cloud rows are keyed on. This view is only ever built for a Dataplane-backed store
 * (cloud mode or local-sync mode), so it is the one place a legacy entry with no id is backfilled
 * (`ensureWorkspaceIds`: atomic, deterministic, only the missing field). Backfill happens lazily on
 * the first `resolveId` of such an entry; if it cannot be written the id is undefined and the
 * scope fails closed (`cloud_scope_workspace_not_allowed`).
 */
export function createWorkspaceRegistry(home: string = loreHome()): WorkspaceRegistryView {
    const file = path.join(home, 'workspaces.json');
    let sig: string | null | undefined; // undefined = never read
    let cached: ReadonlyMap<string, WorkspaceEntry> = new Map();
    let cachedNames: ReadonlySet<string> = new Set();

    const signature = (): string | null => {
        try {
            const st = fs.statSync(file);
            return `${st.mtimeMs}:${st.size}:${st.ino}`;
        } catch {
            return null;
        }
    };
    const refresh = (): ReadonlyMap<string, WorkspaceEntry> => {
        const now = signature();
        if (now === sig) return cached;
        if (now === null) {
            cached = new Map();
        } else {
            try {
                const f = loadWorkspacesIfPresent(home);
                cached = new Map((f?.workspaces ?? []).map((w) => [w.name, w] as const));
            } catch {
                cached = new Map(); // unreadable/corrupt registry serves nothing
            }
        }
        cachedNames = new Set(cached.keys());
        sig = now;
        return cached;
    };
    const resolveId = (name: string): string | undefined => {
        let entry = refresh().get(name);
        if (!entry) return undefined;
        if (entry.id === undefined || entry.id === null || entry.id === '') {
            try {
                ensureWorkspaceIds(home); // Dataplane-backed stores only; never reached in local mode
            } catch {
                return undefined; // cannot persist an id: fail closed rather than serve an unstable one
            }
            sig = undefined;
            entry = refresh().get(name);
        }
        return isValidWorkspaceId(entry?.id) ? entry!.id : undefined;
    };
    return {
        has: (ws) => refresh().has(ws),
        resolveId,
        names: () => { refresh(); return cachedNames; },
        invalidate: () => { sig = undefined; },
    };
}

/** Everything cloud-mode store/adapter construction needs from boot config. */
export interface CloudBootConfig {
    orgId: string;
    dataplaneWorkspaceId: string;
    workspaceRegistry: LoreWorkspaceRegistry;
    /** Connector named on every Dataplane call (`DATAPLANE_CONNECTION`); undefined = engine per-route defaults. */
    connection?: string;
}

/** Resolve the boot config from env + the instance's registry. Throws (fail closed) when a required value is unset. */
export function resolveCloudBootConfig(
    opts: { home?: string; orgId?: string; dataplaneWorkspaceId?: string; workspaceRegistry?: LoreWorkspaceRegistry; connection?: string } = {},
): CloudBootConfig {
    const connection = opts.connection ?? resolveDataplaneConnection();
    return {
        orgId: opts.orgId ?? requireDataplaneOrgId(),
        dataplaneWorkspaceId: opts.dataplaneWorkspaceId ?? resolveDataplaneWorkspaceId(),
        workspaceRegistry: opts.workspaceRegistry ?? createWorkspaceRegistry(opts.home),
        ...(connection ? { connection } : {}),
    };
}
