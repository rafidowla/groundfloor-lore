/**
 * workspaces.ts — Multi-workspace registry for Lore V2.1.
 *
 * Model:
 *   Each workspace is a completely separate Kùzu graph + LanceDB verbatim
 *   store + .lore/config.json. Switching workspaces is a hard context
 *   switch — like Slack teams or Claude app accounts. Graphs never
 *   cross-query; plugins listed in one workspace's config are invisible
 *   to another.
 *
 * On-disk layout:
 *   ~/.groundfloor/
 *     workspaces.json                 ← this module's control file
 *     .lore/…                         ← legacy V2 path, promoted to "default"
 *     workspaces/
 *       family/.lore/…                ← new workspaces live here
 *       personal/.lore/…
 *
 * Control file shape:
 *   {
 *     active: "default",
 *     workspaces: [
 *       { name: "default", path: "/Users/foo/.groundfloor",           createdAt: "..." },
 *       { name: "family",  path: "/Users/foo/.groundfloor/workspaces/family", createdAt: "..." }
 *     ]
 *   }
 *
 * Migration:
 *   If workspaces.json doesn't exist but ~/.groundfloor/.lore/graph does
 *   (i.e. a V2.0 install), we auto-write workspaces.json with a single
 *   "default" workspace pointing at that existing path — no data moves,
 *   no data loss.
 *
 * Thread safety:
 *   Synchronous disk ops, single writer. HTTP handlers serialize via
 *   Node's event loop. Concurrent switches are idempotent — last write
 *   wins and is what the next boot picks up.
 */

import fs from 'fs';
import path from 'path';
import { loreHome } from './loreHome.js';

/**
 * Per-workspace retention policy (2026-04-28). Soft-supersession is the
 * mechanism; this is the policy on top.
 *
 * - hideSupersededInRecall: when true (default), recall + search results
 *     drop nodes whose supersededAt is non-null. Off lets stale decisions
 *     compete against current ones in semantic results.
 * - hideSupersededInGraph: when true, the network view hides superseded
 *     nodes server-side regardless of the per-session "Show superseded"
 *     toggle. Default false — UI toggle is the authoritative control.
 * - autoArchiveSupersededAfterDays: when a positive integer, a daily
 *     sweep tombstones the verbatim row (preserves the graph node + its
 *     edges) for any superseded node older than this threshold. null /
 *     0 disables the sweep. Reversible via the verbatim history endpoint
 *     since tombstone snapshots the content.
 */
export interface WorkspaceRetentionPolicy {
    hideSupersededInRecall?: boolean;
    hideSupersededInGraph?: boolean;
    autoArchiveSupersededAfterDays?: number | null;
    /**
     * W6a (Sprint W) — per-type retention rules layered on top of the
     * supersession-focused fields above. Map from node `type` string to
     * the rule that governs its expiration. Absence of an entry means
     * `keep` (back-compat: workspaces without typePolicies see no
     * behavior change). See engines/typeRetention.ts for the
     * TypeRetentionRule shape and validation.
     */
    typePolicies?: Record<string, { mode: 'keep' | 'warm-after' | 'delete-after'; days?: number }>;
}

/**
 * Phase 6 P2 — per-workspace accepted-vocabulary policy.
 *
 * Closes the cross-workspace contamination class (e.g. `workspace_a_maintenance`
 * nodes landing in a different workspace) by letting the operator
 * declare which node types are accepted, and what to do with writes
 * that don't match.
 *
 * Modes:
 *   - 'allowlist': only `types[]` is accepted; everything else triggers `onMismatch`.
 *   - 'denylist':  everything is accepted EXCEPT `types[]`; matches in
 *                  the list trigger `onMismatch`.
 *   - 'open':      no vocab restriction (back-compat default).
 *
 * onMismatch routing:
 *   - 'reject': writes are refused with HTTP 400 type_not_allowed.
 *   - 'hitl':   writes are enqueued into the pending-ops queue and
 *               return 202 pending_human_review for a second human to
 *               approve or reject.
 *   - 'warn':   write proceeds; response carries an X-Lore-Type-Warning
 *               header (HTTP) or a _meta.warning field (MCP tool).
 */
export type WorkspaceVocabMode = 'allowlist' | 'denylist' | 'open';
export type WorkspaceVocabOnMismatch = 'reject' | 'hitl' | 'warn';

export interface WorkspaceVocabPolicy {
    mode: WorkspaceVocabMode;
    /** Type names this policy applies to (interpretation depends on mode). */
    types?: string[];
    /** What to do when a write's type does NOT satisfy the policy. */
    onMismatch: WorkspaceVocabOnMismatch;
}

export interface WorkspaceEntry {
    name: string;
    /** Human-readable display name. Defaults to name if not set. */
    label?: string;
    /** Sync mode: 'local-only' | 'local-sync' | 'cloud-only' */
    mode?: string;
    /** Workspace template: a free-form label, e.g. 'team-a', 'research'. */
    template?: string;
    path: string;
    createdAt: string;
    /**
     * Phase 3 (docs/SURREALDB_BUILD_PLAN.md) — which engine backs this
     * workspace's GRAPH substrate (nodes + edges).
     *
     * Absent or `'kuzu'` = the incumbent embedded Kùzu graph. `'surreal'` =
     * the embedded SurrealDB engine (`engines/surrealGraph.ts`).
     *
     * This selects ONE substrate, not the whole workspace. A `'surreal'`
     * workspace keeps LanceDB for vectors, and SQLite for collections/table
     * storage, the pending-ops queue and ReBAC grants. Only nodes and edges
     * are affected by this field.
     *
     * Corrected 2026-08-06 (DEC-KUZU-REMOVAL-STEP1): this used to say those
     * four subsystems stayed in Kùzu, which was true when written and is not
     * now — they are SQLite, and none of them consults this field.
     *
     * Absent is the default on purpose: an existing workspace must never
     * change substrate because a field was added.
     */
    graphEngine?: 'kuzu' | 'surreal';
    retention?: WorkspaceRetentionPolicy;
    /**
     * Phase 6 P2 — accepted-vocabulary policy. Absent or `mode: 'open'`
     * means no restriction (back-compat default).
     */
    vocabPolicy?: WorkspaceVocabPolicy;
    /**
     * Sprint O4 — per-workspace override for the outbox lag threshold
     * (seconds). When unset the global `LORE_OUTBOX_LAG_THRESHOLD_SECONDS`
     * (default 30) applies. A workspace with a known-slow substrate
     * (e.g. a large bulk-import target) can raise this so legitimate
     * sustained lag doesn't trip backpressure; conversely an
     * SLO-sensitive workspace can lower it. Read by the lag-cache's
     * thresholdResolver (packages/lore/src/outbox/lagCache.ts) on every
     * backpressure check — cheap because the resolver is a closure over
     * the in-memory workspaces.json snapshot.
     */
    outboxLagThresholdSeconds?: number;
    /**
     * Sprint C3 — per-workspace write-time quotas. When set, hot-lane
     * writes (POST /api/node and friends) check projected counters
     * against these caps and refuse with HTTP 429 workspace_quota_exceeded
     * when exceeded. Both fields are optional; absent = no cap.
     *
     * maxNodes: integer cap on total node count in the workspace.
     * maxStorageBytes: integer cap on cumulative payload bytes
     *   (label + body UTF-8 length, approximated at write time;
     *   reconciled to true on-disk bytes by a periodic job).
     *
     * Cloud per-tenant aggregation is provisioned via the
     * IWorkspaceQuotaStore interface in security/workspaceQuota.ts;
     * the concrete Redis-backed impl ships in cloud activation.
     */
    maxNodes?: number;
    maxStorageBytes?: number;
    /**
     * Feature 1 — per-classification shelf-life defaults (days).
     * When set, prune_nodes uses these as the default expiry threshold
     * for archived nodes in this workspace.
     */
    shelfLife?: {
        foundational?: number | null;
        tactical?: number | null;
        observational?: number | null;
    };
    /**
     * Feature 1 — when true, prune_nodes may hard-delete nodes
     * (permanent removal from Kùzu). Default false = soft archive only.
     */
    allowHardDelete?: boolean;
    /**
     * Feature 1 — emit a warning in corpus_health when the count of
     * non-protected nodes exceeds this threshold. null = no warn.
     */
    pruneWarnThreshold?: number | null;
    /**
     * Feature 5 — per-workspace BM25 tuning parameters.
     * k1: term frequency saturation (default 1.5). b: length normalization (default 0.75).
     */
    bm25?: { k1?: number; b?: number };
    /**
     * Feature 6 — grace period (days) before an anchor-stale node is
     * eligible for demotion to 'observational'. Phase 1: stored only,
     * not yet enforced by auto-demotion (deferred to Feature 6 Phase 2).
     */
    anchorDemotionGraceDays?: number;
}

export interface WorkspacesFile {
    active: string;
    workspaces: WorkspaceEntry[];
}

/**
 * WorkspacePaths — the three derived locations under a Lore home.
 *
 * Previously these were module-eval constants (`const HOME_GROUNDFLOOR =
 * loreHome()`), which baked the home at import time. That broke hosts
 * that set `LORE_HOME` after import and made two Lore instances in one
 * process collide. They are now computed per-call from an injectable
 * `home`, so each caller can resolve against its own data root.
 */
interface WorkspacePaths {
    /** The Lore data root (formerly HOME_GROUNDFLOOR). */
    home: string;
    /** workspaces.json control file (formerly CONTROL_FILE). */
    controlFile: string;
    /** workspaces/ directory for non-legacy workspaces (formerly WORKSPACES_DIR). */
    workspacesDir: string;
}

/** Resolve the workspace paths for a given home (defaults to loreHome()). */
function workspacePaths(home: string = loreHome()): WorkspacePaths {
    return {
        home,
        controlFile: path.join(home, 'workspaces.json'),
        workspacesDir: path.join(home, 'workspaces'),
    };
}

/**
 * kebabCase — Normalize a user-entered workspace name to a safe on-disk id.
 * Rules: lowercase, alnum + dash, 1–40 chars. Empty / invalid → throws.
 */
export function kebabCase(name: string): string {
    const kebab = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!kebab || kebab.length > 40) {
        throw new Error(`Invalid workspace name "${name}". Use 1–40 letters/digits/dashes.`);
    }
    return kebab;
}

/** Load workspaces.json, running the V2.0 → V2.1 migration if needed. */
export function loadWorkspaces(home: string = loreHome()): WorkspacesFile {
    const paths = workspacePaths(home);
    if (fs.existsSync(paths.controlFile)) {
        const parsed = JSON.parse(fs.readFileSync(paths.controlFile, 'utf8')) as WorkspacesFile;
        if (!parsed.active || !Array.isArray(parsed.workspaces) || parsed.workspaces.length === 0) {
            throw new Error(`Corrupt ${paths.controlFile}: missing active or workspaces[]`);
        }
        return parsed;
    }

    // First-run migration: adopt the existing ~/.groundfloor/.lore if it
    // exists, otherwise create an empty "default" workspace.
    const legacyLore = path.join(paths.home, '.lore');
    const hasLegacy = fs.existsSync(legacyLore);
    if (!hasLegacy && !fs.existsSync(paths.home)) {
        fs.mkdirSync(paths.home, { recursive: true });
    }
    const file: WorkspacesFile = {
        active: 'default',
        workspaces: [
            {
                name: 'default',
                path: paths.home,
                createdAt: new Date().toISOString(),
            },
        ],
    };
    writeControl(file, home);
    return file;
}

/** Returns the disk path for the currently-active workspace. */
export function getActiveWorkspacePath(home: string = loreHome()): string {
    const f = loadWorkspaces(home);
    const entry = f.workspaces.find((w) => w.name === f.active);
    if (!entry) {
        throw new Error(`workspaces.json.active="${f.active}" has no matching entry`);
    }
    return entry.path;
}

export function getActiveWorkspaceName(home: string = loreHome()): string {
    return loadWorkspaces(home).active;
}

/**
 * createWorkspace — Register a new workspace and create its .lore/ dir.
 * Does NOT switch to it; call switchWorkspace() afterwards to activate.
 */
export function createWorkspace(
    rawName: string,
    opts?: { label?: string; mode?: string; template?: string },
    home: string = loreHome(),
): WorkspaceEntry {
    const name = kebabCase(rawName);
    const file = loadWorkspaces(home);
    if (file.workspaces.some((w) => w.name === name)) {
        throw new Error(`Workspace "${name}" already exists`);
    }
    const workspacePath = path.join(workspacePaths(home).workspacesDir, name);
    const loreDir = path.join(workspacePath, '.lore');
    fs.mkdirSync(loreDir, { recursive: true });
    const entry: WorkspaceEntry = {
        name,
        ...(opts?.label ? { label: opts.label } : {}),
        ...(opts?.mode ? { mode: opts.mode } : {}),
        ...(opts?.template ? { template: opts.template } : {}),
        path: workspacePath,
        createdAt: new Date().toISOString(),
    };
    file.workspaces.push(entry);
    writeControl(file, home);
    return entry;
}

/**
 * registerWorkspaceAlias — Register a workspace entry that points at an
 * EXISTING on-disk path (typically another workspace's `.lore` parent).
 * Used to expose a subset of rows (e.g. tagged with a particular
 * `project` value, physically inside an existing workspace's kuzu graph)
 * under a separate addressable workspace name.
 *
 * Differs from createWorkspace:
 *   - Does NOT mkdir — caller asserts the path already exists.
 *   - Does NOT block on name uniqueness (idempotent: re-registering the
 *     same alias with the same path is a no-op; same name + different
 *     path throws to prevent silent re-pointing).
 *
 * The LocalGraphRegistry's path-dedup logic (also Sprint L5b-final) is
 * what makes querying the alias workspace return the in-place tagged
 * rows without opening a second Kùzu handle on the same graph dir.
 */
export function registerWorkspaceAlias(
    rawName: string,
    aliasPath: string,
    opts?: { label?: string },
    home: string = loreHome(),
): WorkspaceEntry {
    const name = kebabCase(rawName);
    if (!fs.existsSync(aliasPath)) {
        throw new Error(`registerWorkspaceAlias: path does not exist: ${aliasPath}`);
    }
    const file = loadWorkspaces(home);
    const existing = file.workspaces.find((w) => w.name === name);
    if (existing) {
        if (existing.path === aliasPath) return existing;
        throw new Error(
            `Workspace "${name}" already exists at ${existing.path}; refusing to re-point to ${aliasPath}`,
        );
    }
    const entry: WorkspaceEntry = {
        name,
        ...(opts?.label ? { label: opts.label } : {}),
        path: aliasPath,
        createdAt: new Date().toISOString(),
    };
    file.workspaces.push(entry);
    writeControl(file, home);
    return entry;
}

/**
 * switchWorkspace — Change the active workspace. Returns the new state.
 * Caller is responsible for restarting the daemon so the graph can be
 * re-initialized against the new path.
 */
export function switchWorkspace(name: string, home: string = loreHome()): WorkspacesFile {
    const file = loadWorkspaces(home);
    if (!file.workspaces.some((w) => w.name === name)) {
        throw new Error(`Unknown workspace "${name}"`);
    }
    file.active = name;
    writeControl(file, home);
    return file;
}

/**
 * deleteWorkspace — Remove a workspace from the registry. Does NOT touch
 * its on-disk data — user must rm -rf manually to irrevocably lose data.
 * Cannot delete the legacy/bootstrap workspace (the one anchored at
 * HOME_GROUNDFLOOR rather than under workspaces/) or the active one.
 */
export function deleteWorkspace(name: string, home: string = loreHome()): WorkspacesFile {
    const file = loadWorkspaces(home);
    const entry = file.workspaces.find((w) => w.name === name);
    if (!entry) throw new Error(`Unknown workspace "${name}"`);
    if (entry.path === workspacePaths(home).home) {
        throw new Error('Cannot delete the legacy/bootstrap workspace (path is the Lore home)');
    }
    if (file.active === name) throw new Error('Cannot delete the active workspace');
    file.workspaces = file.workspaces.filter((w) => w.name !== name);
    writeControl(file, home);
    return file;
}

/**
 * renameWorkspace — Change a workspace's name without moving its data on
 * disk. The path stays put; only the label/identity changes. Use this to
 * give workspaces meaningful names ("default" → "developer") after the
 * fact.
 *
 * Updates `active` if the renamed workspace was active. Rejects collisions
 * with existing names. The legacy "default" entry is renameable — its
 * path stays anchored at HOME_GROUNDFLOOR; only the label moves.
 */
export function renameWorkspace(oldName: string, rawNewName: string, home: string = loreHome()): WorkspacesFile {
    const newName = kebabCase(rawNewName);
    if (oldName === newName) return loadWorkspaces(home);
    const file = loadWorkspaces(home);
    if (!file.workspaces.some((w) => w.name === oldName)) {
        throw new Error(`Unknown workspace "${oldName}"`);
    }
    if (file.workspaces.some((w) => w.name === newName)) {
        throw new Error(`Workspace "${newName}" already exists`);
    }
    file.workspaces = file.workspaces.map((w) =>
        w.name === oldName ? { ...w, name: newName } : w,
    );
    if (file.active === oldName) file.active = newName;
    writeControl(file, home);
    return file;
}

/**
 * Phase 6 P1 — Resolve any workspace's disk path by name. When `name` is
 * omitted or matches the active workspace, returns the same value as
 * `getActiveWorkspacePath()`. When `name` is a different registered
 * workspace, returns that workspace's path. Throws `workspace_not_found`
 * when the name doesn't match any registered workspace.
 *
 * Always reads `workspaces.json` fresh (no caching) so callers that
 * resolve per-request see the current registry state. The legacy
 * single-active path resolution remains the default for back-compat;
 * pass `name` only when routing for a specific workspace.
 */
export function getWorkspacePath(name?: string, home: string = loreHome()): string {
    const f = loadWorkspaces(home);
    const target = name ?? f.active;
    const entry = f.workspaces.find((w) => w.name === target);
    if (!entry) {
        const known = f.workspaces.map((w) => w.name).join(', ');
        throw new Error(`workspace_not_found: "${target}" (known: ${known})`);
    }
    return entry.path;
}

/**
 * Phase 6 P1 — List all registered workspace names. Used by the
 * `workspace: '*'` cross-workspace recall path (P1.B in this chain;
 * exported now so the schema can be wired ahead of the runtime).
 */
export function listWorkspaceNames(home: string = loreHome()): string[] {
    return loadWorkspaces(home).workspaces.map((w) => w.name);
}

function writeControl(file: WorkspacesFile, home: string = loreHome()): void {
    const controlFile = workspacePaths(home).controlFile;
    const tmp = `${controlFile}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf8');
    fs.renameSync(tmp, controlFile);
}

/**
 * Read the retention policy for a workspace by name. Falls back to
 * sensible defaults when the workspace has no `retention` block (older
 * workspaces.json files predate the field).
 */
export function getWorkspaceRetention(name: string, home: string = loreHome()): WorkspaceRetentionPolicy {
    const file = loadWorkspaces(home);
    const entry = file.workspaces.find((w) => w.name === name);
    return {
        hideSupersededInRecall: entry?.retention?.hideSupersededInRecall ?? true,
        hideSupersededInGraph: entry?.retention?.hideSupersededInGraph ?? false,
        autoArchiveSupersededAfterDays: entry?.retention?.autoArchiveSupersededAfterDays ?? null,
    };
}

/**
 * Update the retention policy for a workspace by name. Merges with any
 * existing block — partial updates allowed (e.g. just toggle one field).
 */
export function setWorkspaceRetention(name: string, patch: Partial<WorkspaceRetentionPolicy>, home: string = loreHome()): WorkspaceRetentionPolicy {
    const file = loadWorkspaces(home);
    const entry = file.workspaces.find((w) => w.name === name);
    if (!entry) throw new Error(`Unknown workspace "${name}"`);
    const current = entry.retention ?? {};
    const merged: WorkspaceRetentionPolicy = { ...current, ...patch };
    entry.retention = merged;
    writeControl(file, home);
    return merged;
}

/**
 * Phase 6 P2 — read a workspace's vocab policy. Returns `mode: 'open'`
 * when the entry has no explicit policy (back-compat). Throws when the
 * workspace name is unknown so callers don't accidentally apply a
 * default policy to a non-existent workspace.
 */
export function getWorkspaceVocabPolicy(name: string, home: string = loreHome()): WorkspaceVocabPolicy {
    const file = loadWorkspaces(home);
    const entry = file.workspaces.find((w) => w.name === name);
    if (!entry) throw new Error(`Unknown workspace "${name}"`);
    const policy = entry.vocabPolicy;
    if (!policy) return { mode: 'open', onMismatch: 'warn' };
    return {
        mode: policy.mode,
        ...(policy.types ? { types: policy.types } : {}),
        onMismatch: policy.onMismatch,
    };
}

/**
 * Phase 6 P2 — persist a workspace's vocab policy. Replaces any prior
 * policy in full (not a partial merge) so operators can flip a
 * workspace cleanly between allowlist/denylist/open without leftover
 * fields from the previous mode. Pass `null` to clear.
 */
export function setWorkspaceVocabPolicy(name: string, policy: WorkspaceVocabPolicy | null, home: string = loreHome()): WorkspaceVocabPolicy | null {
    const file = loadWorkspaces(home);
    const entry = file.workspaces.find((w) => w.name === name);
    if (!entry) throw new Error(`Unknown workspace "${name}"`);
    if (policy === null) {
        delete entry.vocabPolicy;
        writeControl(file, home);
        return null;
    }
    if (policy.mode !== 'allowlist' && policy.mode !== 'denylist' && policy.mode !== 'open') {
        throw new Error(`Invalid vocabPolicy.mode "${policy.mode}" (expected allowlist|denylist|open)`);
    }
    if (policy.onMismatch !== 'reject' && policy.onMismatch !== 'hitl' && policy.onMismatch !== 'warn') {
        throw new Error(`Invalid vocabPolicy.onMismatch "${policy.onMismatch}" (expected reject|hitl|warn)`);
    }
    entry.vocabPolicy = {
        mode: policy.mode,
        ...(policy.types && policy.types.length > 0 ? { types: policy.types.slice() } : {}),
        onMismatch: policy.onMismatch,
    };
    writeControl(file, home);
    return entry.vocabPolicy;
}
