/**
 * reconciler.ts — Diff cloud's authoritative workspace list against
 * on-disk state and produce a plan: pull / drop / leave-alone.
 *
 * Pure logic. Takes inputs (cloud list + local list); returns a
 * `ReconcilePlan`. The polling loop owns the actual I/O — call
 * `pullWorkspaceSnapshot` for each `pull` entry, delete the local
 * dir for each `drop`, do nothing for `unchanged`. Keeping it pure
 * makes it trivial to unit-test without touching disk or network.
 *
 * Per AUTH_AND_SYNC_DESIGN.md (2026-05-10):
 *   - cloud is authoritative for who-sees-what
 *   - local copy is authoritative for offline use
 *   - revocation propagates: if cloud no longer lists a workspace,
 *     the local dir is dropped
 *   - LWW for v1: if cloud's version > local's, pull
 *
 * Safety guard `cloudIsAuthoritative`:
 *   When cloud isn't configured (`LORE_CLOUD_URL` unset) the No-op
 *   client returns []. Naively reconciling that against the local
 *   list would emit `drop` for every workspace and wipe the install.
 *   Caller is required to set `cloudIsAuthoritative: false` in that
 *   case; the reconciler then returns a no-drops plan (everything
 *   stays put). Strict failure-mode design: an unset flag defaults
 *   to `false` so an integration bug can't accidentally wipe local
 *   workspaces.
 */

import type { SyncedWorkspace } from './cloudSyncClient.js';

/** What the local Lore install currently holds on disk. Lightweight; only the bits the reconciler needs. */
export interface LocalWorkspaceState {
    workspaceId: string;
    /** Cloud version stamp last sync wrote here. Empty string when never synced (manual local workspace). */
    syncedVersion: string;
    /**
     * F-S10 — true when this workspace has un-drained WAL or an un-pushed
     * outbox (local writes not yet acknowledged by cloud). A single empty /
     * short authoritative cloud response (a transient cloud blip) must NOT
     * delete a workspace that still holds local-only data, or those writes
     * are lost forever. Caller fills this from the outbox/WAL depth; when
     * omitted it defaults to false (no pending state known → eligible for
     * the normal drop path, subject to the grace-window guard below).
     */
    hasPendingLocalState?: boolean;
}

export type ReconcileAction =
    | { kind: 'pull';      workspaceId: string; reason: 'new-from-cloud' | 'version-mismatch'; cloudVersion: string }
    | { kind: 'drop';      workspaceId: string; reason: 'access-revoked' }
    // F-S10 — cloud no longer lists the workspace, but it is NOT yet safe to
    // delete. Either it holds un-synced local state (never droppable on a
    // single response) or it is within the confirmation grace window (cloud
    // must report it absent across >= dropGraceConfirmations consecutive
    // reconciles before we drop). The polling loop must persist the per-id
    // miss count so the next pass can advance toward the threshold.
    | { kind: 'drop-deferred'; workspaceId: string; reason: 'pending-local-state' | 'grace-window'; missCount: number; required: number }
    | { kind: 'unchanged'; workspaceId: string };

export interface ReconcilePlan {
    pull:      Array<Extract<ReconcileAction, { kind: 'pull' }>>;
    drop:      Array<Extract<ReconcileAction, { kind: 'drop' }>>;
    /** F-S10 — workspaces cloud dropped but that are NOT yet safe to delete. */
    dropDeferred: Array<Extract<ReconcileAction, { kind: 'drop-deferred' }>>;
    unchanged: Array<Extract<ReconcileAction, { kind: 'unchanged' }>>;
    /** All actions in input order — useful for logging / audit. */
    all: ReconcileAction[];
}

export interface ReconcileInput {
    /** What cloud says the user is authorized to see right now. */
    cloud: ReadonlyArray<SyncedWorkspace>;
    /** What's on local disk. */
    local: ReadonlyArray<LocalWorkspaceState>;
    /**
     * MUST be true when caller is using a real cloud sync client. Set
     * false (or omit, defaults to false) when no cloud is configured —
     * the reconciler then refuses to emit `drop` actions, preventing
     * accidental wipe.
     */
    cloudIsAuthoritative?: boolean;
    /**
     * Optional allowlist of workspace ids the reconciler will NEVER
     * drop, even when cloud doesn't list them. Use this to protect a
     * locally-created "draft" workspace that hasn't been pushed up yet,
     * or a legacy install where the dir name pre-dates UUID-keyed
     * naming (per Q-N2 of the auth design).
     */
    neverDrop?: ReadonlyArray<string>;
    /**
     * F-S10 — number of CONSECUTIVE reconciles in which cloud must report a
     * workspace absent before the reconciler emits a real `drop`. A single
     * empty/short authoritative cloud response (a cloud blip) then yields
     * only a `drop-deferred` action, never a destructive delete. Defaults to
     * 1 (legacy behavior: drop on the first confirmed-absent pass) so
     * existing callers are unaffected; cloud callers SHOULD set this >= 2.
     */
    dropGraceConfirmations?: number;
    /**
     * F-S10 — per-workspace count of how many consecutive prior reconciles
     * already saw this workspace absent from cloud. The polling loop owns
     * this counter (persist it between passes) and feeds it back in. A
     * workspace is only dropped once `missCount + 1 >= dropGraceConfirmations`.
     */
    priorMissCounts?: Readonly<Record<string, number>>;
}

/**
 * Compute the reconciliation plan. Pure function. Caller executes
 * the actions.
 */
export function reconcile(input: ReconcileInput): ReconcilePlan {
    const cloudById = new Map(input.cloud.map((w) => [w.workspaceId, w]));
    const localById = new Map(input.local.map((w) => [w.workspaceId, w]));
    const protect = new Set(input.neverDrop ?? []);
    const cloudAuth = input.cloudIsAuthoritative === true;
    // F-S10 — grace window. >= 1; a value of 1 reproduces legacy "drop on the
    // first confirmed-absent pass" behavior for callers that don't opt in.
    const graceRequired = Math.max(1, input.dropGraceConfirmations ?? 1);
    const priorMisses = input.priorMissCounts ?? {};

    const pull: ReconcilePlan['pull'] = [];
    const drop: ReconcilePlan['drop'] = [];
    const dropDeferred: ReconcilePlan['dropDeferred'] = [];
    const unchanged: ReconcilePlan['unchanged'] = [];
    const all: ReconcileAction[] = [];

    // 1. Walk cloud's view: pull (new + version-mismatch) or unchanged.
    for (const cw of input.cloud) {
        const lw = localById.get(cw.workspaceId);
        if (!lw) {
            const a: ReconcileAction = { kind: 'pull', workspaceId: cw.workspaceId, reason: 'new-from-cloud', cloudVersion: cw.version };
            pull.push(a as Extract<ReconcileAction, { kind: 'pull' }>);
            all.push(a);
            continue;
        }
        if (lw.syncedVersion !== cw.version) {
            const a: ReconcileAction = { kind: 'pull', workspaceId: cw.workspaceId, reason: 'version-mismatch', cloudVersion: cw.version };
            pull.push(a as Extract<ReconcileAction, { kind: 'pull' }>);
            all.push(a);
            continue;
        }
        const a: ReconcileAction = { kind: 'unchanged', workspaceId: cw.workspaceId };
        unchanged.push(a as Extract<ReconcileAction, { kind: 'unchanged' }>);
        all.push(a);
    }

    // 2. Walk local for entries cloud no longer lists → drop, unless
    //    cloud isn't authoritative or the id is on the protect list.
    for (const lw of input.local) {
        if (cloudById.has(lw.workspaceId)) continue;
        if (!cloudAuth) continue;             // safety: don't drop when cloud is no-op
        if (protect.has(lw.workspaceId)) continue;

        // F-S10 — never-drop guard #1: a workspace with un-drained WAL /
        // un-pushed outbox holds local-only writes. A transient empty cloud
        // response must NOT delete it (that data has nowhere else to live).
        // Always defer; the next pull/push pass can drain it, after which a
        // later reconcile may legitimately drop it.
        if (lw.hasPendingLocalState === true) {
            const a: ReconcileAction = {
                kind: 'drop-deferred',
                workspaceId: lw.workspaceId,
                reason: 'pending-local-state',
                missCount: priorMisses[lw.workspaceId] ?? 0,
                required: graceRequired,
            };
            dropDeferred.push(a as Extract<ReconcileAction, { kind: 'drop-deferred' }>);
            all.push(a);
            continue;
        }

        // F-S10 — never-drop guard #2: grace window. Cloud must report this
        // workspace absent across `graceRequired` consecutive reconciles
        // before we destructively drop. This pass counts as one observation
        // on top of the persisted prior misses.
        const confirmations = (priorMisses[lw.workspaceId] ?? 0) + 1;
        if (confirmations < graceRequired) {
            const a: ReconcileAction = {
                kind: 'drop-deferred',
                workspaceId: lw.workspaceId,
                reason: 'grace-window',
                missCount: confirmations,
                required: graceRequired,
            };
            dropDeferred.push(a as Extract<ReconcileAction, { kind: 'drop-deferred' }>);
            all.push(a);
            continue;
        }

        const a: ReconcileAction = { kind: 'drop', workspaceId: lw.workspaceId, reason: 'access-revoked' };
        drop.push(a as Extract<ReconcileAction, { kind: 'drop' }>);
        all.push(a);
    }

    return { pull, drop, dropDeferred, unchanged, all };
}

/**
 * Helper for log lines / audit entries. Renders the plan as a short
 * summary (counts + first few ids). Matches the daemon log style
 * elsewhere in Lore.
 */
export function summarizePlan(plan: ReconcilePlan): string {
    const head = (xs: { workspaceId: string }[]) => xs.slice(0, 3).map((x) => x.workspaceId).join(', ');
    return `pull=${plan.pull.length} (${head(plan.pull) || '—'}) ` +
           `drop=${plan.drop.length} (${head(plan.drop) || '—'}) ` +
           // F-S10 — surface deferred drops so a cloud blip is visible in logs.
           `drop-deferred=${plan.dropDeferred.length} (${head(plan.dropDeferred) || '—'}) ` +
           `unchanged=${plan.unchanged.length}`;
}
