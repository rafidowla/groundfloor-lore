/**
 * ingestion/callbackServer.ts — HTTP surface for the signed processor callback.
 *
 * Deliberately NOT mounted in the main dispatcher: that gauntlet only admits
 * localhost Host headers and demands a Lore bearer, and a hosted processor has
 * neither. Loosening those gates is a security decision for the host owner, so
 * slice 1 ships a dedicated listener (own port, own auth = the callback
 * signature) that a host can bind and expose through its ingress. The route
 * handler `routeCallback` can equally be called from an existing server.
 *
 * Only `POST /api/ingest/callback/<jobId>` exists here; everything else is 404.
 * The raw wire bytes are read (bounded) and handed to handleCallback, which
 * authenticates before trusting any byte of the body.
 */
import http from 'node:http';
import { handleCallback, MAX_CALLBACK_WIRE_BYTES } from './callbackHandler.js';
import type { IngestionCoordinator } from './coordinator.js';

const PREFIX = '/api/ingest/callback/';

export function send(res: http.ServerResponse, status: number, body: Record<string, unknown>): void {
    const data = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'Cache-Control': 'no-store' });
    res.end(data);
}

async function readRaw(req: http.IncomingMessage, cap: number): Promise<Buffer | null> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let n = 0;
        req.on('data', (c: Buffer) => {
            n += c.length;
            if (n > cap) { chunks.length = 0; try { req.pause(); } catch { /* closing */ } resolve(null); return; }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

/** Finds the coordinator that owns a job id (undefined = unknown to every workspace). */
export type CoordinatorResolver = (jobId: string) => Promise<IngestionCoordinator | undefined>;

/**
 * Returns true when the request was a callback route (response written).
 * An unknown job id answers exactly like a bad signature (401), so the route is not a job-id oracle.
 */
export async function routeCallbackWith(resolve: CoordinatorResolver, req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    const pathname = (req.url ?? '').split('?', 1)[0];
    if (!pathname.startsWith(PREFIX)) return false;
    if (req.method !== 'POST') { send(res, 405, { code: 'method_not_allowed' }); return true; }
    let jobId: string;
    try { jobId = decodeURIComponent(pathname.slice(PREFIX.length)); } catch { send(res, 400, { code: 'bad_job_id' }); return true; }
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(jobId)) { send(res, 401, { code: 'unauthorized' }); return true; }
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_CALLBACK_WIRE_BYTES) {
        send(res, 413, { code: 'payload_too_large' }); try { req.socket.destroy(); } catch { /* gone */ } return true;
    }
    const raw = await readRaw(req, MAX_CALLBACK_WIRE_BYTES);
    if (!raw) { send(res, 413, { code: 'payload_too_large' }); try { req.socket.destroy(); } catch { /* gone */ } return true; }
    try {
        const c = await resolve(jobId);
        if (!c) { send(res, 401, { code: 'unauthorized' }); return true; }
        const out = await handleCallback(c, { jobId, headers: req.headers as Record<string, string | string[] | undefined>, rawBody: raw });
        send(res, out.status, out.body);
    } catch {
        send(res, 500, { code: 'internal_error' }); // never echo error text to an unauthenticated peer
    }
    return true;
}

/** Single-coordinator form (kept for hosts that own exactly one coordinator). */
export function routeCallback(c: IngestionCoordinator, req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    return routeCallbackWith(async () => c, req, res);
}

export function createCallbackServer(c: IngestionCoordinator): http.Server {
    const server = http.createServer((req, res) => {
        routeCallback(c, req, res).then((h) => { if (!h) send(res, 404, { code: 'not_found' }); }).catch(() => { try { send(res, 500, { code: 'internal_error' }); } catch { /* closed */ } });
    });
    server.requestTimeout = 30_000;
    server.headersTimeout = 10_000;
    return server;
}
