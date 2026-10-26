/**
 * test/helpers/reviewHttp.ts - a REAL http.Server on an ephemeral 127.0.0.1 port that runs the production
 * `dispatchHttpRequest` (auth gates -> principal -> route binding -> routes), the same call the daemon makes, with
 * tokens minted through the real registry (`issueToken`). Only the dispatcher deps are a hand-built subset.
 *
 * Call `setupReviewHome()` BEFORE importing any lore module that reads LORE_HOME (the registry path).
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TokenScope } from '../../packages/lore/src/auth/tokens.js';

export function setupReviewHome(prefix: string): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    process.env['LORE_HOME'] = home;
    process.env['LORE_MODEL_SERVER'] = '0';
    return home;
}

export interface ReviewHttp {
    base: string;
    port: number;
    mint(workspace: string, scopes: TokenScope[], admin?: boolean): string;
    call(token: string, method: string, pathAndQuery: string, body?: unknown, rawBody?: string): Promise<{ status: number; json: any; text: string }>;
    close(): Promise<void>;
}

export async function startReviewHttp(opts: { home: string; store: unknown; graphRegistry: unknown; activeWorkspace: string }): Promise<ReviewHttp> {
    const { dispatchHttpRequest } = await import('../../packages/lore/src/mcp/http/dispatcher.js');
    const { RateLimiter } = await import('../../packages/lore/src/security/rateLimit.js');
    const { issueToken } = await import('../../packages/lore/src/auth/tokens.js');
    const limiter = new RateLimiter('local');
    let port = 0;
    const server = http.createServer((req, res) => {
        const deps: any = {
            port, deploymentMode: 'local', runMode: 'daemon', dataplane: null,
            detectedScope: { workspace: opts.activeWorkspace },
            dataHome: opts.home, getAuthToken: () => 'bootstrap-token-not-used-in-this-test', getSharedSecret: () => undefined,
            rateLimiter: limiter, store: opts.store, graphRegistry: opts.graphRegistry,
            auditLog: { log: () => undefined }, activeSessions: new Map(), configManager: {},
        };
        dispatchHttpRequest(req, res, deps).catch((err: unknown) => {
            if (!res.headersSent) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ code: 'test_harness_error', message: String((err as Error)?.message ?? err) })); }
        });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    return {
        base, port,
        mint: (workspace, scopes, admin = false) => issueToken({ workspace, label: `review-http-${scopes.join('+')}`, scopes, admin }).token,
        async call(token, method, pathAndQuery, body, rawBody) {
            const r = await fetch(`${base}${pathAndQuery}`, {
                method,
                headers: { Authorization: `Bearer ${token}`, ...(body !== undefined || rawBody !== undefined ? { 'Content-Type': 'application/json' } : {}) },
                ...(rawBody !== undefined ? { body: rawBody } : body !== undefined ? { body: JSON.stringify(body) } : {}),
            });
            const text = await r.text();
            let json: any = null;
            try { json = JSON.parse(text); } catch { /* non-JSON */ }
            return { status: r.status, json, text };
        },
        close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
    };
}
