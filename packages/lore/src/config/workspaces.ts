/**
 * workspaces.ts — Multi-workspace registry for Lore V2.1.
 *
 * Model:
 *   Each workspace is a completely separate graph + LanceDB verbatim
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

/**
 * D5 (2026-09-23) — write-time supersession enforcement. Absent (default) =
 * `enforce: false`, today's behaviour: a `decision`/`convention`/`architecture`
 * write can silently duplicate or contradict an existing node with no link
 * ever recorded. Mirrors `WorkspaceVocabPolicy`'s absent-is-permissive shape
 * on purpose, for the same reason: an existing workspace must never change
 * write behaviour because a field was added at upgrade time — enforcement is
 * opt-in per workspace, turned on with `setWorkspaceSupersessionPolicy`.
 *
 * When `enforce: true`, `core/supersessionPolicy.ts`'s `checkSupersessionPolicy`
 * rejects a `decision`/`convention`/`architecture` write when: (round 2,
 * 2026-09-23 — every write path resolves its policy/near-dup hooks through
 * the one shared `resolveSupersessionContext()` helper in
 * `supersessionPolicy.ts`, so MCP store_node, REST POST /api/node, the
 * embedded `createLore()` nodeUpsert()/nodeUpsertBatch(), bulkIngest(),
 * REST POST /api/nodes/bulk and REST POST /api/import all enforce it
 * uniformly — not just the three original chokepoint callers.)
 *   - the write omits `supersedes` entirely (pass `[]` to assert "supersedes
 *     nothing" explicitly);
 *   - the write's content/label contains a `SUPERSEDES <id>` prose claim
 *     whose id is not also listed in `supersedes`;
 *   - a near-duplicate existing node (same workspace, same type, similarity
 *     >= `duplicateThreshold`) is found and its id is not listed in
 *     `supersedes`, unless the write passes `force: true`.
 * Every listed id gets a `supersedes` edge + its `supersededBy` field set,
 * same durable effect as the existing `supersede_node` MCP tool.
 */
export interface WorkspaceSupersessionPolicy {
    /** Turn write-time enforcement on for this workspace. Default false. */
    enforce: boolean;
    /**
     * Near-duplicate similarity threshold (0-1) reusing the same scoring as
     * `GET /api/node/supersession-candidates`. Absent = that route's own
     * default (0.78).
     */
    duplicateThreshold?: number;
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
     * Absent (default) = the embedded SurrealDB engine
     * (`engines/surrealGraph.ts`). A legacy `'kuzu'` value is rejected with a
     * loud refusal at open time rather than silently defaulting — that
     * graph engine was fully removed.
     *
     * This selects ONE substrate, not the whole workspace. A `'surreal'`
     * workspace keeps LanceDB for vectors, and SQLite for collections/table
     * storage, the pending-ops queue and ReBAC grants. Only nodes and edges
     * are affected by this field.
     *
     * Corrected 2026-08-06 (DEC-KUZU-REMOVAL-STEP1): this used to say those
     * four subsystems stayed on the graph engine, which was true when
     * written and is not now — they are SQLite, and none of them consults
     * this field.
     *
     * Absent is the default on purpose: an existing workspace must never
     * change substrate because a field was added.
     *
     * 3.21 step 1d adds `'sqlite'` (`engines/sqliteGraph.ts`). NEW local
     * workspaces write it explicitly at creation
     * (`createWorkspace()`/fresh-home seeding); an absent field still means
     * `'surreal'` for every workspace created before that change. See
     * `graphEngineSelector.ts`'s `DEFAULT_GRAPH_ENGINE` and
     * `resolveNewWorkspaceGraphEngine`.
     */
    graphEngine?: 'kuzu' | 'surreal' | 'sqlite';
    /**
     * 3.21 step 2 part 2 (design section 2) — which engine backs this
     * workspace's VECTOR substrate (embeddings + semantic search).
     *
     * Absent (default) = LanceDB (`engines/verbatimStore.ts`'s
     * `VerbatimStore`). NEW local workspaces write `'sqlite'` explicitly at
     * creation (`createWorkspace()`/fresh-home seeding), same rule
     * `graphEngine` follows — an existing workspace must never change
     * substrate because a field was added. See
     * `vectorEngineSelector.ts`'s `DEFAULT_VECTOR_ENGINE` and
     * `resolveNewWorkspaceVectorEngine`.
     *
     * A `'sqlite'` workspace can be promoted to `'lance'` automatically in
     * the background once its `verbatim.sqlite` crosses
     * `LORE_VECTOR_PROMOTE_ROWS` rows (`engines/verbatimPromotion.ts`) — the
     * promotion commit flips this field the same way `lore migrate-graph`
     * flips `graphEngine`. This field selects ONE substrate, not the whole
     * workspace: a `'sqlite'`-vector workspace can run either graph engine,
     * independently.
     */
    vectorEngine?: 'lance' | 'sqlite';
    retention?: WorkspaceRetentionPolicy;
    recallRerank?: import('../recall/rerankConfig.js').WorkspaceRecallRerank;
    /**
     * Phase 6 P2 — accepted-vocabulary policy. Absent or `mode: 'open'`
     * means no restriction (back-compat default).
     */
    vocabPolicy?: WorkspaceVocabPolicy;
    /**
     * D5 (2026-09-23) — opt-in write-time supersession enforcement. Absent =
     * disabled (back-compat default). See `WorkspaceSupersessionPolicy`'s doc
     * comment for the full behaviour.
     */
    supersessionPolicy?: WorkspaceSupersessionPolicy;
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
     * (permanent removal from the graph). Default false = soft archive only.
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
    pieceVectors?: import('../engines/pieces/pieceSettings.js').WorkspacePieceVectors;
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
                // 3.21 step 1d — ONLY for a genuinely FRESH home (no legacy
                // `.lore` adopted): a brand-new local workspace still gets
                // `graphEngine` written explicitly, same rule createWorkspace()
                // applies. Adopting an EXISTING `.lore` must leave the field
                // absent — that directory's real data is already on whatever
                // engine wrote it (surreal, pre-3.21), and this first-run path
                // has no way to know which; absent correctly resolves to
                // 'surreal' via graphEngineSelector.ts's default.
                ...(hasLegacy ? {} : { graphEngine: process.env['LORE_DEFAULT_GRAPH_ENGINE'] === 'surreal' ? 'surreal' : 'sqlite' as const }),
                // 3.21 step 2 part 2 — same rule, same reasoning, as the
                // graphEngine field just above: only a genuinely FRESH home
                // gets the new default; adopting an existing `.lore` must
                // leave the field absent (its real vectors are wherever
                // they already are — 'lance' via vectorEngineSelector.ts's
                // default).
                ...(hasLegacy ? {} : { vectorEngine: process.env['LORE_DEFAULT_VECTOR_ENGINE'] === 'lance' ? 'lance' : 'sqlite' as const }),
            },
        ],
    };
    writeControl(file, home);
    return file;
}

/**
 * Read `workspaces.json` for `home` WITHOUT running `loadWorkspaces`'s
 * first-run migration — returns `null` when no control file exists there
 * instead of creating one.
 *
 * Defect 3 (3.20.2) — a maintenance pass (or any other read-only probe)
 * against an embedded instance's own `dataHome` must never bootstrap a
 * `workspaces.json` as a side effect of merely checking "what's the active
 * workspace?". `loadWorkspaces()` is correct for callers that actually want
 * a registry (CLI, daemon boot); this is for callers that want to know
 * whether one exists first.
 */
export function loadWorkspacesIfPresent(home: string = loreHome()): WorkspacesFile | null {
    const { controlFile } = workspacePaths(home);
    if (!fs.existsSync(controlFile)) {
        return null;
    }
    return loadWorkspaces(home);
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
        // 3.21 step 1d — NEW local workspaces write this EXPLICITLY (never
        // absent), so `graphEngineSelector.ts`'s absent-field default stays
        // 'surreal' forever for every pre-3.21 workspace. `resolveNewWorkspaceGraphEngine`
        // is not imported here on purpose: `engines/graphEngineSelector.ts`
        // itself imports `loadWorkspaces` from THIS module, so importing
        // back from it would be circular. The rule is one line — kept
        // inline, with `graphEngineSelector.ts`'s
        // `resolveNewWorkspaceGraphEngine` doc comment as the canonical
        // explanation of the `LORE_DEFAULT_GRAPH_ENGINE` escape hatch.
        graphEngine: process.env['LORE_DEFAULT_GRAPH_ENGINE'] === 'surreal' ? 'surreal' : 'sqlite',
        // 3.21 step 2 part 2 — NEW local workspaces write this EXPLICITLY
        // too (never absent), same reasoning as graphEngine above: an
        // absent field must keep meaning 'lance' forever for every
        // pre-3.21 workspace. `resolveNewWorkspaceVectorEngine` is the
        // canonical explanation of the `LORE_DEFAULT_VECTOR_ENGINE` escape
        // hatch; not imported here for the same circular-import reason
        // graphEngine's inline duplicate exists.
        vectorEngine: process.env['LORE_DEFAULT_VECTOR_ENGINE'] === 'lance' ? 'lance' : 'sqlite',
    };
    file.workspaces.push(entry);
    writeControl(file, home);
    return entry;
}

/**
 * registerWorkspaceAlias — Register a workspace entry that points at an
 * EXISTING on-disk path (typically another workspace's `.lore` parent).
 * Used to expose a subset of rows (e.g. tagged with a particular
 * `project` value, physically inside an existing workspace's graph)
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
 * rows without opening a second graph handle on the same graph dir.
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
 * setWorkspaceGraphEngine — 3.21 step 1e: flip which engine a workspace's
 * `graphEngine` field names, atomically (`writeControl`'s tmp-file +
 * `renameSync`, same primitive every other mutator in this file uses).
 *
 * This is `lore migrate-graph`'s FINAL step, on purpose — everything before
 * it (backup, stream, importRaw, digest/read-probe verification) must
 * complete first, so a crash or refusal anywhere upstream of this call
 * leaves the registry, and therefore which store every reader opens,
 * completely unchanged. `--rollback` calls this the same way, in reverse.
 */
export function setWorkspaceGraphEngine(
    name: string,
    engine: 'surreal' | 'sqlite',
    home: string = loreHome(),
): WorkspaceEntry {
    const file = loadWorkspaces(home);
    const entry = file.workspaces.find((w) => w.name === name);
    if (!entry) {
        throw new Error(`Unknown workspace "${name}"`);
    }
    entry.graphEngine = engine;
    writeControl(file, home);
    return entry;
}

/**
 * setWorkspaceVectorEngine — 3.21 step 2 part 2: flip which engine a
 * workspace's `vectorEngine` field names, atomically (same `writeControl`
 * tmp-file + `renameSync` primitive as `setWorkspaceGraphEngine`).
 *
 * This is `verbatimPromotion.ts`'s auto-promotion hook's FINAL step, same
 * ordering discipline as the graph migration: staging, the tail copy, index
 * build, and verification all happen BEFORE this call, so a crash or a
 * failed verify anywhere upstream leaves the registry — and therefore which
 * store the resolver opens next — completely unchanged. The manual
 * `lore vectors promote` CLI deliberately does NOT call this (see its own
 * header) — only the automatic background hook does.
 */
export function setWorkspaceVectorEngine(
    name: string,
    engine: 'lance' | 'sqlite',
    home: string = loreHome(),
): WorkspaceEntry {
    const file = loadWorkspaces(home);
    const entry = file.workspaces.find((w) => w.name === name);
    if (!entry) {
        throw new Error(`Unknown workspace "${name}"`);
    }
    entry.vectorEngine = engine;
    writeControl(file, home);
    return entry;
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

export function writeControl(file: WorkspacesFile, home: string = loreHome()): void {
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

/**
 * D5 (2026-09-23) — read a workspace's supersession-enforcement policy.
 * Returns `{ enforce: false }` when the entry has no explicit policy
 * (back-compat default — see `WorkspaceSupersessionPolicy`'s doc comment).
 * Throws when the workspace name is unknown, same as `getWorkspaceVocabPolicy`.
 *
 * Round 2 (#2, host switch): `hostDefaultEnforce` is the fallback used ONLY
 * when this workspace has no explicit `supersessionPolicy` entry — an
 * explicit per-workspace entry (true OR false) always wins outright. The
 * caller (core/supersessionPolicy.ts's `resolveSupersessionContext`) is
 * responsible for computing it from `createLore({supersessionEnforce})` and
 * `LORE_SUPERSESSION_ENFORCE`; this function just applies the final
 * precedence rule (per-workspace > everything else).
 */
export function getWorkspaceSupersessionPolicy(
    name: string,
    home: string = loreHome(),
    hostDefaultEnforce?: boolean,
): WorkspaceSupersessionPolicy {
    const file = loadWorkspaces(home);
    const entry = file.workspaces.find((w) => w.name === name);
    if (!entry) throw new Error(`Unknown workspace "${name}"`);
    const policy = entry.supersessionPolicy;
    if (!policy) return { enforce: hostDefaultEnforce === true };
    return {
        enforce: policy.enforce === true,
        ...(typeof policy.duplicateThreshold === 'number' ? { duplicateThreshold: policy.duplicateThreshold } : {}),
    };
}

/**
 * D5 (2026-09-23) — persist a workspace's supersession-enforcement policy.
 * Replaces any prior policy in full. Pass `null` to clear (back to disabled).
 */
export function setWorkspaceSupersessionPolicy(
    name: string,
    policy: WorkspaceSupersessionPolicy | null,
    home: string = loreHome(),
): WorkspaceSupersessionPolicy | null {
    const file = loadWorkspaces(home);
    const entry = file.workspaces.find((w) => w.name === name);
    if (!entry) throw new Error(`Unknown workspace "${name}"`);
    if (policy === null) {
        delete entry.supersessionPolicy;
        writeControl(file, home);
        return null;
    }
    if (typeof policy.enforce !== 'boolean') {
        throw new Error('Invalid supersessionPolicy.enforce (expected boolean)');
    }
    if (
        policy.duplicateThreshold !== undefined
        && (typeof policy.duplicateThreshold !== 'number' || policy.duplicateThreshold < 0 || policy.duplicateThreshold > 1)
    ) {
        throw new Error('Invalid supersessionPolicy.duplicateThreshold (expected a number between 0 and 1)');
    }
    entry.supersessionPolicy = {
        enforce: policy.enforce,
        ...(typeof policy.duplicateThreshold === 'number' ? { duplicateThreshold: policy.duplicateThreshold } : {}),
    };
    writeControl(file, home);
    return entry.supersessionPolicy;
}
