/**
 * failureDisposition.ts - 3.35.0 (a)/(p): what the replicator does with a row whose replay threw.
 * One decision shared by every dead-letter site (replicateOne, the consolidated embed batch and
 * the consolidated verbatim batch).
 *
 *   unwired / invalid payload      -> dead, immediately (never succeeds on retry)
 *   TRANSIENT (classifier says so) -> 'failed' with a full-jitter backoff, `attempts` NOT bumped;
 *                                     dead only after the row has been retrying transient errors
 *                                     for longer than `transientCeilingMs` (default 24 h), measured
 *                                     from the persisted `firstTransientAt`
 *   anything else                  -> 'failed' + attempts bump, dead at `maxAttempts` (as before)
 *
 * The classifier is injected: only the ArcadeDB wiring supplies one (ConcurrentModification /
 * unreachable). With none (SQLite, Dataplane, ...) every failure takes the last branch, so those
 * engines behave exactly as before. Search-worker timeouts are deliberately NOT transient yet:
 * the request may have been applied, so they stay counted attempts (deliberate follow-up).
 */
import { MissingPayloadError, UnwiredOperationKindError } from './dispatcher.js';
import { isSqliteLockedError } from '../engines/graphShared/deleteOutcome.js';
import { isVerbatimStoreRetiredError } from '../engines/verbatimWriteBarrier.js';
import type { OutboxEntry, OutboxStore } from './types.js';

export const DEFAULT_TRANSIENT_CEILING_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_TRANSIENT_BASE_MS = 500;
export const DEFAULT_TRANSIENT_CAP_MS = 60_000;

export const DEFAULT_TRANSIENT_CONFIG = {
    transientCeilingMs: DEFAULT_TRANSIENT_CEILING_MS,
    transientBaseMs: DEFAULT_TRANSIENT_BASE_MS,
    transientCapMs: DEFAULT_TRANSIENT_CAP_MS,
};

/**
 * The SQLite wiring's transient classifier (also its batch-halt classifier): lock contention, or a
 * write rejected with VerbatimStoreRetiredError (the promotion committed while it was parked and the
 * promoted store was not resolvable within SqliteVerbatimStore's own bounded retry). Both mean
 * "nothing was applied, replay later" - never a counted attempt, never a dead-letter.
 */
export const isSqliteOrRetiredTransient = (err: unknown): boolean => isSqliteLockedError(err) || isVerbatimStoreRetiredError(err);

/** Why a row was dead-lettered; stored in `deadReason`, shown by /api/stats and the dead-rows route. */
export type DeadReason = 'unwired' | 'invalid' | 'permanent' | 'transient_ceiling';

export interface DispositionEnv {
    maxAttempts: number;
    transientCeilingMs: number;
    transientBaseMs: number;
    transientCapMs: number;
    /** True when `err` means "nothing was applied, replay later". Absent: nothing is transient. */
    classify?: (err: unknown) => boolean;
    /** True when a transient `err` means the whole store is unavailable (a SQLite lock), so the rest of
     *  the batch would fail the same way: set {@link batchHalted} and let the caller stop. */
    haltBatch?: (err: unknown) => boolean;
    /** Set by {@link recordReplayFailure} on a halting transient failure; the replicator resets it per batch. */
    batchHalted: boolean;
    now: () => number;
    random: () => number;
}

export type FailureOutcome =
    | { kind: 'transient'; retries: number; nextAttemptAt: string }
    | { kind: 'failed' }
    | { kind: 'dead'; reason: DeadReason; message: string };

/** The replicator's {@link DispositionEnv} from its config, optional classifier and test clock. */
export function makeDispositionEnv(
    cfg: Pick<DispositionEnv, 'maxAttempts' | 'transientCeilingMs' | 'transientBaseMs' | 'transientCapMs'>,
    classify?: (err: unknown) => boolean,
    clock?: { now?: () => number; random?: () => number },
    haltBatch?: (err: unknown) => boolean,
): DispositionEnv {
    return { ...cfg, classify, haltBatch, batchHalted: false, now: clock?.now ?? Date.now, random: clock?.random ?? Math.random };
}

/** Full-jitter exponential backoff: uniform in [0, min(cap, base * 2^n)). */
export function transientBackoffMs(retries: number, env: Pick<DispositionEnv, 'transientBaseMs' | 'transientCapMs' | 'random'>): number {
    return Math.floor(env.random() * Math.min(env.transientCapMs, env.transientBaseMs * 2 ** Math.min(retries, 30)));
}

/**
 * Decide and record the outcome for one failed replay. The caller owns stats, logging and any
 * post-dead cleanup (half-completion reaping), driven by the returned outcome.
 */
export async function recordReplayFailure(
    store: OutboxStore,
    entry: OutboxEntry,
    err: unknown,
    env: DispositionEnv,
): Promise<FailureOutcome> {
    const msg = (err as Error).message;
    const reason: DeadReason | null = err instanceof UnwiredOperationKindError ? 'unwired'
        : err instanceof MissingPayloadError ? 'invalid' : null;
    if (reason) {
        await store.markEntryStatus!(entry.id, 'dead', { error: msg, bumpAttempt: true, deadReason: reason });
        return { kind: 'dead', reason, message: msg };
    }
    if (env.classify?.(err) && typeof store.recordTransientFailure === 'function') {
        if (env.haltBatch?.(err)) env.batchHalted = true; // 3.35.3: stop after this row, retry the rest next tick
        const retries = entry.transientRetries ?? 0;
        const firstMs = entry.firstTransientAt ? Date.parse(entry.firstTransientAt) : NaN;
        if (Number.isFinite(firstMs) && env.now() - firstMs >= env.transientCeilingMs) {
            const message = `${msg} [transient for ${Math.round((env.now() - firstMs) / 3_600_000)}h over ${retries + 1} retries, ceiling reached]`;
            await store.markEntryStatus!(entry.id, 'dead', { error: message, deadReason: 'transient_ceiling' });
            return { kind: 'dead', reason: 'transient_ceiling', message };
        }
        const nextAttemptAt = new Date(env.now() + transientBackoffMs(retries, env)).toISOString();
        await store.recordTransientFailure(entry.id, { error: msg, nextAttemptAt });
        return { kind: 'transient', retries: retries + 1, nextAttemptAt };
    }
    if ((entry.attempts ?? 0) + 1 >= env.maxAttempts) {
        await store.markEntryStatus!(entry.id, 'dead', { error: msg, bumpAttempt: true, deadReason: 'permanent' });
        return { kind: 'dead', reason: 'permanent', message: msg };
    }
    await store.markEntryStatus!(entry.id, 'failed', { error: msg, bumpAttempt: true });
    return { kind: 'failed' };
}

/** Counters/logging hooks for {@link settleReplayFailure}. */
export interface SettleHooks {
    /** e.g. 'verbatim.upsert consolidated' - names the row's path in log lines. */
    label: string;
    onDead: () => void;
    onFailure: () => void;
    log: (msg: string) => void;
}

/** {@link recordReplayFailure} plus the shared counters and log lines. Returns the outcome so a
 *  caller can add its own follow-up (replicateOne reaps half-completed node.upsert rows). */
export async function settleReplayFailure(
    store: OutboxStore, entry: OutboxEntry, err: unknown, env: DispositionEnv, hooks: SettleHooks,
): Promise<FailureOutcome> {
    const out = await recordReplayFailure(store, entry, err, env);
    if (out.kind === 'dead') {
        hooks.onDead();
        hooks.log(`[outbox replicator] entry ${entry.id} (${hooks.label}) marked dead (${out.reason}): ${out.message}`);
    } else if (out.kind === 'transient') {
        hooks.log(`[outbox replicator] entry ${entry.id} (${hooks.label}) transient failure #${out.retries}, retrying at ${out.nextAttemptAt} (attempt not counted): ${(err as Error).message}`);
    } else {
        hooks.onFailure();
    }
    return out;
}
