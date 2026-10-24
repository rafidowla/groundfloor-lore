/**
 * ingestion/processors/http.ts — the one outbound HTTP path for processors.
 *
 * Every call: allowlist check on the exact URL, no redirects followed, hard
 * timeout, response size cap, status classified into retryable / permanent.
 * `fetchImpl` is injectable so tests use local in-process servers only.
 */
import { ProcessorError } from '../contracts.js';
import { assertEndpointAllowed, type EndpointAllowlist } from '../endpointAllowlist.js';

export interface HttpConfig {
    allowlist: EndpointAllowlist;
    timeoutMs?: number;
    maxResponseBytes?: number;
    fetchImpl?: typeof fetch;
}

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export function isRetryableStatus(status: number): boolean {
    return status === 408 || status === 425 || status === 429 || status >= 500;
}

export async function readCapped(res: Response, cap: number): Promise<string> {
    const reader = res.body?.getReader();
    if (!reader) return '';
    const chunks: Buffer[] = []; let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > cap) { await reader.cancel(); throw new ProcessorError(`response exceeds ${cap} bytes`, false); }
        chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
}

/** POST JSON; returns parsed JSON (or undefined for empty 2xx bodies). */
export async function postJson(cfg: HttpConfig, url: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: unknown }> {
    const target = assertEndpointAllowed(cfg.allowlist, url);
    const f = cfg.fetchImpl ?? fetch;
    let res: Response;
    try {
        res = await f(target, {
            method: 'POST',
            redirect: 'manual',
            headers: { 'content-type': 'application/json', ...headers },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
    } catch (err) {
        throw new ProcessorError(`request failed: ${(err as Error).name}`, true);
    }
    if (res.status >= 300 && res.status < 400) { await res.body?.cancel(); throw new ProcessorError(`redirect (${res.status}) refused`, false, res.status); }
    const text = await readCapped(res, cfg.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES);
    if (res.status >= 400) throw new ProcessorError(`processor returned HTTP ${res.status}`, isRetryableStatus(res.status), res.status);
    if (!text.trim()) return { status: res.status, json: undefined };
    try { return { status: res.status, json: JSON.parse(text) }; }
    catch { throw new ProcessorError('processor returned non-JSON body', false, res.status); }
}
