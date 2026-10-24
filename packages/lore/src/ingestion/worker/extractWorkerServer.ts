/**
 * ingestion/worker/extractWorkerServer.ts - the extractor worker as its own loopback HTTP service, for running it
 * on a separate server (or as a separate local process) instead of as a child of the Lore instance.
 *
 *   POST /extract   body = the file bytes; headers x-lore-mime (required), x-lore-file-name, x-lore-job-id
 *                   200 {ok:true, content: ExtractedContent} | 4xx/5xx {ok:false, error:{message, retryable}}
 *   GET  /healthz   200 {ok:true}
 *
 * It listens on loopback only (a non-loopback bind needs `allowNonLoopbackBind`, for a worker on its own server
 * behind the operator's network controls), runs ONE extraction at a time (a second request is answered 503
 * retryable), caps the body at `maxFileBytes`, and bounds each extraction with a deadline. It opens nothing else.
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { OpenAiVisionEngine } from '../processors/localVision.js';
import { isLoopbackHost } from '../processors/localStructurer.js';
import type { WireError, WireVisionConfig } from './extractWorkerProtocol.js';
import { classifyError, extractCore, makeCoreDeps, type ExtractCoreDeps } from './extractWorkerCore.js';

export interface ExtractWorkerServerOptions {
    /** 0 = ephemeral. */
    port: number;
    bind?: string;
    allowNonLoopbackBind?: boolean;
    vision: WireVisionConfig | null;
    maxFileBytes: number;
    timeoutMs: number;
    /** Test hook: replace the extraction deps (e.g. a registry with a slow extractor). */
    deps?: Partial<ExtractCoreDeps>;
}

export interface ExtractWorkerServer { port: number; bind: string; close(): Promise<void> }

function reply(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers });
    res.end(text);
}
const fail = (res: http.ServerResponse, status: number, error: WireError, headers: Record<string, string> = {}) => reply(res, status, { ok: false, error }, headers);

export async function startExtractWorkerServer(o: ExtractWorkerServerOptions): Promise<ExtractWorkerServer> {
    const bind = o.bind ?? '127.0.0.1';
    if (!o.allowNonLoopbackBind && !isLoopbackHost(bind)) throw new Error(`extract worker bind '${bind}' is not loopback`);
    const vision = o.vision ? new OpenAiVisionEngine({ baseUrl: o.vision.baseUrl, model: o.vision.model, ...(o.vision.timeoutMs ? { timeoutMs: o.vision.timeoutMs } : {}) }) : null;
    const deps = makeCoreDeps({ vision, visionMaxPages: o.vision?.maxPages ?? 25, maxFileBytes: o.maxFileBytes, ...o.deps });
    let busy = false;

    const server = http.createServer((req, res) => {
        if (req.method === 'GET' && req.url === '/healthz') { reply(res, 200, { ok: true }); return; }
        if (req.method !== 'POST' || req.url !== '/extract') { fail(res, 404, { message: 'not found', retryable: false }); return; }
        const mime = String(req.headers['x-lore-mime'] ?? '').trim();
        if (!mime) { fail(res, 400, { message: 'x-lore-mime header is required', retryable: false }); return; }
        const declared = Number(req.headers['content-length'] ?? NaN);
        if (Number.isFinite(declared) && declared > o.maxFileBytes) { fail(res, 413, { message: `file exceeds the ${o.maxFileBytes} byte cap`, retryable: false }, { connection: 'close' }); req.resume(); return; }
        if (busy) { fail(res, 503, { message: 'extract worker is busy', retryable: true }, { 'retry-after': '1' }); req.resume(); return; }
        busy = true;
        const chunks: Buffer[] = []; let total = 0; let tooBig = false;
        req.on('data', (c: Buffer) => { total += c.length; if (total > o.maxFileBytes) { tooBig = true; chunks.length = 0; } else if (!tooBig) chunks.push(c); });
        req.on('error', () => { busy = false; });
        req.on('end', () => {
            if (tooBig) { busy = false; fail(res, 413, { message: `file exceeds the ${o.maxFileBytes} byte cap`, retryable: false }); return; }
            const work = extractCore(deps, Buffer.concat(chunks), mime);
            // The slot stays busy until the extraction really finishes, even if the deadline already answered the caller.
            work.then(() => undefined, () => undefined).finally(() => { busy = false; });
            let timer: NodeJS.Timeout | undefined;
            const deadline = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error('deadline'), { deadline: true })), o.timeoutMs); });
            Promise.race([work, deadline]).then(
                (content) => reply(res, 200, { ok: true, content }),
                (e) => {
                    if ((e as { deadline?: boolean }).deadline) fail(res, 504, { message: `extraction timed out after ${o.timeoutMs}ms`, retryable: true });
                    else { const err = classifyError(e); fail(res, err.retryable ? 503 : 422, err); }
                },
            ).finally(() => clearTimeout(timer));
        });
    });
    server.headersTimeout = 10_000;
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(o.port, bind, () => { server.off('error', reject); resolve(); }); });
    const addr = server.address() as AddressInfo;
    return {
        port: addr.port, bind,
        close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); }),
    };
}
