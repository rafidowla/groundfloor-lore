/**
 * retryConfig.ts — env overrides for the outbox retry budget.
 *
 * A row that fails replay is retried with exponential backoff (SP-21,
 * `SqliteOutboxStore.computeNextAttemptAt`: base × 2^attempts, capped at
 * 30 s) and dead-lettered once it has failed `maxAttempts` times
 * (`OutboxReplicator.replicateOne`). Neither number was tunable, so an
 * operator facing a known-permanent failure (e.g. a workspace deleted
 * with rows still queued — the replicator's resolve throws
 * `workspace_not_found` until the row dead-letters) had no way to shorten
 * or lengthen that window without a code change.
 *
 *   LORE_OUTBOX_MAX_ATTEMPTS    attempts before dead-letter   default 5
 *   LORE_OUTBOX_RETRY_BASE_MS   first backoff step (ms)        default 500
 *
 * Defaults are the pre-existing hard-coded values, so behaviour is
 * unchanged unless an operator sets them. Invalid values fall back to the
 * defaults silently — never throws on the daemon-boot path (same contract
 * as readEnvPollConfig / readEnvSelfHealConfig in replicator.ts, which is
 * over its file-size cap and so does not host this reader).
 *
 * Dead-lettered rows stay recoverable: `lore outbox requeue-dead` resets
 * them to retryable, so a workspace that reappears can still be replayed.
 */

export const DEFAULT_OUTBOX_MAX_ATTEMPTS = 5;
export const DEFAULT_OUTBOX_RETRY_BASE_MS = 500;

export interface OutboxRetryConfig {
    maxAttempts: number;
    retryBaseMs: number;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
    if (raw === undefined || raw.trim() === '') return fallback;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 1 ? n : fallback;
}

export function readEnvRetryConfig(env: NodeJS.ProcessEnv = process.env): OutboxRetryConfig {
    return {
        maxAttempts: parsePositiveInt(env.LORE_OUTBOX_MAX_ATTEMPTS, DEFAULT_OUTBOX_MAX_ATTEMPTS),
        retryBaseMs: parsePositiveInt(env.LORE_OUTBOX_RETRY_BASE_MS, DEFAULT_OUTBOX_RETRY_BASE_MS),
    };
}
