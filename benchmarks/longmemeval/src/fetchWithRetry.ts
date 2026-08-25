/**
 * fetchWithRetry.ts — retries a fetch() call on transient failures: thrown
 * network errors (DNS, connection reset, EHOSTUNREACH, etc.) and HTTP
 * 429/5xx responses. A non-retryable HTTP status (any other 4xx) or a
 * retry-exhausted attempt is returned/thrown as-is — callers keep handling
 * `!response.ok` exactly as before.
 *
 * Found 2026-08-13: a single transient `EHOSTUNREACH` network blip 8
 * questions into a benchmark run killed the whole ~45-60min run, because
 * answerModel.ts's fetch() call had no retry at all, and judge.ts's
 * existing backoff only covered non-ok HTTP *responses* — a thrown fetch()
 * error (the network failure never even produced a Response) wasn't
 * caught by either path. Both call sites now go through this one helper.
 *
 * `sleep`/`fetchFn` are injectable so tests run near-instantly with no
 * real network calls.
 */
export interface FetchWithRetryOpts {
    maxRetries?: number;
    sleep?: (ms: number) => Promise<void>;
    fetchFn?: typeof fetch;
}

const DEFAULT_MAX_RETRIES = 5;
const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function backoffMs(attempt: number): number {
    return Math.min(30_000, 2 ** attempt * 1000);
}

export async function fetchWithRetry(
    url: string,
    init: RequestInit,
    opts: FetchWithRetryOpts = {},
): Promise<Response> {
    const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    const sleep = opts.sleep ?? defaultSleep;
    const fetchFn = opts.fetchFn ?? fetch;

    let attempt = 0;
    for (;;) {
        let response: Response;
        try {
            response = await fetchFn(url, init);
        } catch (err) {
            attempt += 1;
            if (attempt > maxRetries) throw err;
            await sleep(backoffMs(attempt));
            continue;
        }
        if (response.ok) return response;

        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable) return response;

        attempt += 1;
        if (attempt > maxRetries) return response;
        await sleep(backoffMs(attempt));
    }
}
