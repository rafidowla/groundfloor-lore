/**
 * test/helpers/fakeGroundfloorFiles.ts - an in-process HTTP stand-in for the Groundfloor workspace Files API (control
 * plane + presigned object endpoints) on an ephemeral 127.0.0.1 port. Never talks to a real Groundfloor endpoint.
 * Records every request (method, path, whether an Authorization header was present) and supports per-route fault
 * injection: `fail('upload-url', [503, 503])` answers the next two calls with those statuses.
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

export const FAKE_WS = 'gf-ws-test';
export const FAKE_TOKEN = 'tok-SECRET-do-not-log-0123456789';

export interface SeenRequest { method: string; path: string; hasAuth: boolean; auth: string | null; bytes: number }
type Route = 'upload-url' | 'put' | 'finalize' | 'download-url' | 'get' | 'delete';

export interface FakeGroundfloor {
    baseUrl: string;
    seen: SeenRequest[];
    /** id -> stored bytes. */
    objects: Map<string, Buffer>;
    /** Answer the next calls to `route` with these statuses (0 = hang until the client gives up; 'redirect' = 302). */
    fail(route: Route, statuses: Array<number | 'redirect'>, headers?: Record<string, string>): void;
    /** Replace the stored bytes (simulates corruption or a swapped object). */
    corrupt(id: string, bytes: Buffer): void;
    calls(route: Route): number;
    reset(): void;
    close(): Promise<void>;
}

/** Fake of `POST /v1/workspaces/{ws}/m2m/token`: the Groundfloor machine-login mint endpoint (JSON in, JSON out). */
export interface FakeM2mOptions { clientId: string; clientSecret: string; expiresIn?: number }
export interface FakeM2m {
    /** Successful mints so far. */
    mints: number;
    /** Every request body the endpoint received, parsed (never asserted on in logs; for contract checks). */
    bodies: Array<Record<string, unknown>>;
    /** Content-Type headers seen. */
    contentTypes: string[];
    /** Seconds put in the next responses. */
    expiresIn: number;
    /** Tokens minted so far, in order (test-only: so tests can grep logs for them). */
    issued: string[];
    /** The Files API stops accepting every token minted so far (server-side expiry or revocation). */
    expireAll(): void;
    /** Answer the next mint calls with these statuses before succeeding again. */
    failNext(statuses: number[], headers?: Record<string, string>): void;
    /** Next successful mint answers with this raw body instead (e.g. malformed). */
    nextBody(body: unknown): void;
}

export async function startFakeGroundfloor(opts: { requireToken?: string; presignedHost?: string; m2m?: FakeM2mOptions } = {}): Promise<FakeGroundfloor & { m2m: FakeM2m | null }> {
    const token = opts.requireToken ?? FAKE_TOKEN;
    const valid = new Set<string>();
    const mfail: number[] = []; let mfailHeaders: Record<string, string> = {}; let mbody: unknown;
    const m2m: FakeM2m | null = opts.m2m ? {
        mints: 0, bodies: [], contentTypes: [], expiresIn: opts.m2m.expiresIn ?? 300, issued: [],
        expireAll() { valid.clear(); },
        failNext(st, h) { mfail.push(...st); mfailHeaders = h ?? {}; },
        nextBody(b) { mbody = b; },
    } : null;
    const objects = new Map<string, Buffer>();
    // Real stage (probed 2026-10-24) soft-deletes: download-url then answers 409 'File is deleted, not active' and a
    // repeat DELETE answers 200; only a never-existing id answers 404.
    const deleted = new Set<string>();
    const seen: SeenRequest[] = [];
    const faults = new Map<Route, Array<number | 'redirect'>>();
    const faultHeaders = new Map<Route, Record<string, string>>();
    const counts = new Map<Route, number>();
    const hung = new Set<http.ServerResponse>();
    let nextId = 1;
    let origin = '';

    const json = (res: http.ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}) => {
        const s = JSON.stringify(body);
        res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s), ...headers }); res.end(s);
    };
    const readBody = (req: http.IncomingMessage) => new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = []; req.on('data', (c: Buffer) => chunks.push(c)); req.on('end', () => resolve(Buffer.concat(chunks))); req.on('error', reject);
    });
    function injected(route: Route, res: http.ServerResponse): boolean {
        counts.set(route, (counts.get(route) ?? 0) + 1);
        const q = faults.get(route);
        if (!q || q.length === 0) return false;
        const f = q.shift()!;
        const h = faultHeaders.get(route) ?? {};
        if (f === 'redirect') { res.writeHead(302, { location: `${origin}/elsewhere` }); res.end(); return true; }
        if (f === 0) { hung.add(res); return true; }
        json(res, f, { detail: 'injected failure', secret_echo: 'RESPONSE-BODY-MUST-NOT-LEAK' }, h);
        return true;
    }

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', origin || 'http://x');
        const auth = req.headers['authorization'] ?? null;
        const body = await readBody(req);
        seen.push({ method: req.method ?? '', path: url.pathname, hasAuth: auth !== null, auth: auth as string | null, bytes: body.length });
        const base = `/v1/workspaces/${FAKE_WS}/files`;
        const control = url.pathname.startsWith(base);
        if (m2m && req.method === 'POST' && url.pathname === `/v1/workspaces/${FAKE_WS}/m2m/token`) {
            m2m.contentTypes.push(String(req.headers['content-type'] ?? ''));
            let b: Record<string, unknown> = {}; try { b = JSON.parse(body.toString('utf8')); } catch { /* leave empty */ }
            m2m.bodies.push(b);
            if (mfail.length > 0) return json(res, mfail.shift()!, { detail: 'injected mint failure', secret_echo: 'RESPONSE-BODY-MUST-NOT-LEAK' }, mfailHeaders);
            if (b['client_id'] !== opts.m2m!.clientId || b['client_secret'] !== opts.m2m!.clientSecret) return json(res, 401, { detail: 'invalid client credentials' });
            if (mbody !== undefined) { const x = mbody; mbody = undefined; return json(res, 200, x); }
            const t = `m2m-tok-${++m2m.mints}-ACCESS-SECRET-${Math.random().toString(36).slice(2)}`;
            valid.add(t); m2m.issued.push(t);
            return json(res, 200, { access_token: t, expires_in: m2m.expiresIn, m2m_client_id: opts.m2m!.clientId });
        }
        const bearer = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : null;
        if (control && !(m2m ? bearer !== null && valid.has(bearer) : auth === `Bearer ${token}`)) return json(res, 401, { detail: 'bad token' });
        const host = opts.presignedHost ?? origin;
        if (control && req.method === 'POST' && url.pathname === `${base}/upload-url`) {
            if (injected('upload-url', res)) return;
            const meta = JSON.parse(body.toString('utf8')) as { name: string; content_type: string; size_bytes: number };
            const id = `f${nextId++}`;
            return json(res, 200, { upload_url: `${host}/s3/${id}?sig=SIGNATURE-SECRET`, file: { id, name: meta.name, size_bytes: meta.size_bytes, status: 'pending' } });
        }
        if (!control && req.method === 'PUT' && url.pathname.startsWith('/s3/')) {
            if (injected('put', res)) return;
            objects.set(url.pathname.slice(4), body); res.writeHead(200); return void res.end();
        }
        const fin = new RegExp(`^${base}/([^/]+)/finalize$`).exec(url.pathname);
        if (control && req.method === 'POST' && fin) {
            if (injected('finalize', res)) return;
            return objects.has(fin[1]!) ? json(res, 200, { id: fin[1], status: 'ready' }) : json(res, 404, { detail: 'not found' });
        }
        const dl = new RegExp(`^${base}/([^/]+)/download-url$`).exec(url.pathname);
        if (control && req.method === 'GET' && dl) {
            if (injected('download-url', res)) return;
            if (deleted.has(dl[1]!)) return json(res, 409, { detail: 'File is deleted, not active' });
            return objects.has(dl[1]!) ? json(res, 200, { download_url: `${host}/dl/${dl[1]}?sig=SIGNATURE-SECRET` }) : json(res, 404, { detail: 'not found' });
        }
        if (!control && req.method === 'GET' && url.pathname.startsWith('/dl/')) {
            if (injected('get', res)) return;
            const o = objects.get(url.pathname.slice(4));
            if (!o) return json(res, 404, { detail: 'gone' });
            res.writeHead(200, { 'content-length': o.length }); return void res.end(o);
        }
        const del = new RegExp(`^${base}/([^/]+)$`).exec(url.pathname);
        if (control && req.method === 'DELETE' && del) {
            if (injected('delete', res)) return;
            if (deleted.has(del[1]!)) return json(res, 200, { id: del[1], status: 'deleted' });
            if (!objects.delete(del[1]!)) return json(res, 404, { detail: 'not found' });
            deleted.add(del[1]!);
            return json(res, 200, { id: del[1], status: 'deleted' });
        }
        json(res, 404, { detail: 'no route' });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return {
        baseUrl: origin, seen, objects, m2m,
        fail(route, statuses, headers) { faults.set(route, [...statuses]); if (headers) faultHeaders.set(route, headers); else faultHeaders.delete(route); },
        corrupt(id, bytes) { objects.set(id, bytes); },
        calls: (route) => counts.get(route) ?? 0,
        reset() { seen.length = 0; faults.clear(); faultHeaders.clear(); counts.clear(); },
        close: () => new Promise<void>((r) => { for (const h of hung) h.destroy(); server.closeAllConnections(); server.close(() => r()); }),
    };
}
