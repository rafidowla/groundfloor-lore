/**
 * transientRetry.ts - 3.35.0: the ONE bounded budget for a transient engine blip (502/503/504, and a REFUSED
 * connection, which provably sent nothing). Shared by the store-level `retryIdempotentArcadeWrite` /
 * query retry (engines/arcade/arcadeHttp.ts) and the node-batch retry (nodeBatchRetry.ts), so the two
 * can never drift: at most {@link TRANSIENT_MAX_RETRIES} retries, full-jitter backoff `min(cap, base * 2^n)`.
 */
export const TRANSIENT_MAX_RETRIES = 2;
export const TRANSIENT_RETRY_BASE_MS = 100;
export const TRANSIENT_RETRY_CAP_MS = 400;

/** Upper bound of the jitter window before transient retry number `n` (0-based). */
export const transientBackoffCeilMs = (n: number): number => Math.min(TRANSIENT_RETRY_CAP_MS, TRANSIENT_RETRY_BASE_MS * 2 ** n);
