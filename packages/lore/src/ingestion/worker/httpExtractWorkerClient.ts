/**
 * ingestion/worker/httpExtractWorkerClient.ts - talks to a separately run extractor worker (extractWorkerServer.ts)
 * over a loopback URL. The worker is not owned by this process, so `dispose()` has nothing to stop.
 *
 * Same discipline as every processor call: exact-origin allowlist, no redirects, a hard deadline, a response cap, and
 * errors classified retryable (unreachable, busy, 5xx, timeout) or permanent (4xx, bad contract).
 */
import type { ExtractedContent } from '../../engines/extractors/types.js';
import { ProcessorError } from '../contracts.js';
import { assertEndpointAllowed, makeAllowlist, type EndpointAllowlist } from '../endpointAllowlist.js';
import { isRetryableStatus, readCapped } from '../processors/http.js';
import { isLoopbackHost } from '../processors/localStructurer.js';
import type { ExtractTransport, WireError } from './extractWorkerProtocol.js';

export interface HttpExtractClientOptions {
    /** e.g. http://127.0.0.1:9700 - loopback only. */
    url: string;
    timeoutMs: number;
    /** Largest answer accepted (the text cap is 10 MiB; JSON adds overhead). */
    maxResponseBytes?: number;
    fetchImpl?: typeof fetch;
}

export class HttpExtractWorkerClient implements ExtractTransport {
    readonly kind = 'url' as const;
    private readonly allow: EndpointAllowlist;
    private readonly endpoint: string;

    constructor(private readonly o: HttpExtractClientOptions) {
        const u = new URL(o.url);
        if (!isLoopbackHost(u.hostname)) throw new Error(`extract worker url ${u.origin} is not loopback`);
        this.allow = makeAllowlist([u.origin]);
        this.endpoint = new URL('/extract', u.origin).toString();
    }

    async extract(req: { jobId: string; mimeType: string; fileName: string; bytes: Buffer }): Promise<ExtractedContent> {
        const target = assertEndpointAllowed(this.allow, this.endpoint);
        let res: Response;
        try {
            res = await (this.o.fetchImpl ?? fetch)(target, {
                method: 'POST', redirect: 'manual', body: new Blob([req.bytes as BlobPart]),
                headers: { 'content-type': 'application/octet-stream', 'x-lore-mime': req.mimeType, 'x-lore-file-name': encodeURIComponent(req.fileName), 'x-lore-job-id': req.jobId },
                signal: AbortSignal.timeout(this.o.timeoutMs),
            });
        } catch (err) { throw new ProcessorError(`extract worker request failed: ${(err as Error).name}`, true); }
        if (res.status >= 300 && res.status < 400) { await res.body?.cancel(); throw new ProcessorError(`redirect (${res.status}) refused`, false, res.status); }
        const text = await readCapped(res, this.o.maxResponseBytes ?? 32 * 1024 * 1024);
        let body: { ok?: boolean; content?: ExtractedContent; error?: WireError } | undefined;
        try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }
        if (res.status === 200 && body?.ok === true && body.content) return body.content;
        if (body?.error && typeof body.error.message === 'string') throw new ProcessorError(body.error.message, body.error.retryable === true, res.status);
        throw new ProcessorError(`extract worker returned HTTP ${res.status}`, isRetryableStatus(res.status), res.status);
    }

    async dispose(): Promise<void> { /* the worker is run separately; nothing here to stop */ }
}
