/**
 * ingestion/callbackListener.ts - the hardened, SEPARATE listener for signed processor callbacks.
 *
 * A hosted processor cannot pass the main dispatcher's gates (localhost Host + Lore bearer), and those
 * gates must not be loosened for it. So callbacks arrive here instead: its own port, and the ONLY thing it
 * serves is `POST /api/ingest/callback/<jobId>`, authenticated by the callback signature (see
 * callbackHandler.ts). Nothing else - no MCP, no REST, no health - is reachable on this port.
 *
 * Hardening, in the order a request meets it:
 *   - bind 127.0.0.1 unless the operator configures otherwise (non-loopback logs a warning)
 *   - refuses to start on the main daemon's port
 *   - socket cap (`maxConnections`), global in-flight cap, per-source-IP in-flight cap and per-source-IP
 *     request rate (fixed window). The source IP is the TCP peer: X-Forwarded-For is never trusted.
 *   - header and whole-request timeouts (slowloris), keep-alive trimmed, body capped (MAX_CALLBACK_WIRE_BYTES)
 *   - unknown route 404, wrong method 405, every error body is a fixed code - never exception text
 *   - rejections are logged (status + peer only) - never the body, headers, signature, URL or any secret
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { log } from '../logger.js';
import { routeCallbackWith, send, type CoordinatorResolver } from './callbackServer.js';
import { isLoopbackHost } from './processors/localStructurer.js';

export class CallbackListenerConfigError extends Error {
    readonly code = 'callback_listener_config';
    constructor(msg: string) { super(msg); this.name = 'CallbackListenerConfigError'; }
}

export interface CallbackListenerOptions {
    resolve: CoordinatorResolver;
    port: number;
    bind?: string;
    /** The main daemon port; the listener refuses to share it. */
    mainPort?: number;
    maxConcurrent?: number;
    perIpPerMin?: number;
    headersTimeoutMs?: number;
    requestTimeoutMs?: number;
    now?: () => number;
}

export interface CallbackListener {
    readonly port: number;
    readonly bind: string;
    close(graceMs?: number): Promise<void>;
}

/** Fixed-window counter per key with a hard cap on tracked keys (oldest evicted), so it cannot be grown without bound. */
export class RateWindow {
    private readonly hits = new Map<string, { start: number; n: number }>();
    constructor(private readonly limit: number, private readonly windowMs: number, private readonly maxKeys = 4096) {}
    /** True when the request is allowed (and counted). */
    allow(key: string, now: number): boolean {
        const e = this.hits.get(key);
        if (!e || now - e.start >= this.windowMs) {
            if (!e && this.hits.size >= this.maxKeys) this.evict(now);
            this.hits.delete(key); // re-insert so Map order = recency of window start
            this.hits.set(key, { start: now, n: 1 });
            return true;
        }
        e.n++;
        return e.n <= this.limit;
    }
    private evict(now: number): void {
        for (const [k, v] of this.hits) if (now - v.start >= this.windowMs) this.hits.delete(k);
        while (this.hits.size >= this.maxKeys) { const first = this.hits.keys().next(); if (first.done) break; this.hits.delete(first.value); }
    }
}

const WARN_EVERY_MS = 60_000;

export async function startCallbackListener(o: CallbackListenerOptions): Promise<CallbackListener> {
    const bind = o.bind ?? '127.0.0.1';
    if (!Number.isInteger(o.port) || o.port < 0 || o.port > 65_535) throw new CallbackListenerConfigError('callback listener port is invalid');
    if (o.port !== 0 && o.mainPort !== undefined && o.port === o.mainPort) {
        throw new CallbackListenerConfigError('callback listener port must differ from the main daemon port');
    }
    if (!isLoopbackHost(bind)) {
        log.warn(`[Ingest] callback listener binds ${bind}, which is not loopback: expose it only through a TLS-terminating ingress and keep the signature secret private`);
    }
    const now = o.now ?? (() => Date.now());
    const maxConcurrent = o.maxConcurrent ?? 32;
    const perIpConcurrent = Math.max(1, Math.floor(maxConcurrent / 4));
    const rate = new RateWindow(o.perIpPerMin ?? 120, 60_000);
    const inflightByIp = new Map<string, number>();
    let inflight = 0;
    const lastWarn = new Map<number, number>();

    const noteRejected = (status: number, peer: string): void => {
        log.debug(`[Ingest] callback rejected status=${status} peer=${peer}`);
        const t = now();
        if (t - (lastWarn.get(status) ?? 0) >= WARN_EVERY_MS) {
            lastWarn.set(status, t);
            log.warn(`[Ingest] callback rejected status=${status} peer=${peer} (further rejections with this status logged at debug for ${WARN_EVERY_MS / 1000}s)`);
        }
    };

    const headersTimeoutMs = o.headersTimeoutMs ?? 10_000;
    const server = http.createServer({
        // Node enforces header/request timeouts on a polling interval; keep it tight enough to matter.
        connectionsCheckingInterval: Math.max(50, Math.min(5_000, Math.floor(headersTimeoutMs / 2))),
    }, (req, res) => {
        const peer = req.socket.remoteAddress ?? 'unknown';
        res.on('finish', () => { if (res.statusCode >= 400) noteRejected(res.statusCode, peer); });
        const ipN = inflightByIp.get(peer) ?? 0;
        if (!rate.allow(peer, now())) {
            res.setHeader('Retry-After', '60'); send(res, 429, { code: 'rate_limited' }); try { req.socket.destroy(); } catch { /* gone */ } return;
        }
        if (inflight >= maxConcurrent || ipN >= perIpConcurrent) {
            res.setHeader('Retry-After', '5'); send(res, 503, { code: 'busy' }); try { req.socket.destroy(); } catch { /* gone */ } return;
        }
        inflight++; inflightByIp.set(peer, ipN + 1);
        const done = (): void => {
            inflight--;
            const left = (inflightByIp.get(peer) ?? 1) - 1;
            if (left <= 0) inflightByIp.delete(peer); else inflightByIp.set(peer, left);
        };
        let released = false;
        const release = (): void => { if (!released) { released = true; done(); } };
        res.on('close', release);
        routeCallbackWith(o.resolve, req, res)
            .then((handled) => { if (!handled) send(res, 404, { code: 'not_found' }); })
            .catch(() => { try { send(res, 500, { code: 'internal_error' }); } catch { /* closed */ } });
    });
    server.headersTimeout = headersTimeoutMs;
    server.requestTimeout = o.requestTimeoutMs ?? 30_000;
    server.keepAliveTimeout = 5_000;
    server.maxConnections = maxConcurrent * 4;
    server.on('clientError', (_e, socket) => {
        // Malformed / oversized-header requests: fixed reply, no detail, and the socket is dropped.
        try { socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); } catch { /* gone */ }
    });

    await new Promise<void>((resolve, reject) => {
        const onErr = (e: Error): void => reject(e);
        server.once('error', onErr);
        server.listen(o.port, bind, () => { server.off('error', onErr); resolve(); });
    });
    server.on('error', (e: Error) => log.error(`[Ingest] callback listener error (${e.name})`));
    const actual = (server.address() as AddressInfo).port;

    return {
        port: actual,
        bind,
        close(graceMs = 2_000): Promise<void> {
            return new Promise<void>((resolve) => {
                const t = setTimeout(() => { try { server.closeAllConnections(); } catch { /* gone */ } }, Math.max(0, graceMs));
                t.unref();
                server.close(() => { clearTimeout(t); resolve(); });
                try { server.closeIdleConnections(); } catch { /* older node */ }
            });
        },
    };
}
