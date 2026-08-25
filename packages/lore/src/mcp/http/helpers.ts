/**
 * helpers.ts — Tiny HTTP utilities shared by every route family.
 *
 * `readJsonBody` was the only helper inlined in server.ts; `writeJson` /
 * `writeError` are new but follow the exact pattern every existing
 * `if (pathname === ...)` block uses, so route family extractions can
 * adopt them without changing wire behavior.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

/** Hard cap on inbound request body size. 10 MB. */
export const MAX_BODY_BYTES = 10 * 1024 * 1024;

/**
 * Marker on errors thrown by readBoundedBody / readJsonBody when the
 * incoming body exceeded MAX_BODY_BYTES. Handlers should match on this
 * and map to HTTP 413 rather than 400 or 500.
 *
 * RC2 audit (2026-05-17): added so the body-size guard can be threaded
 * through route handlers that previously used inline `req.on('data')`
 * with no cap. The bearer-gated DoS surface (a glitching client looping
 * an upload, a Loom dispatch wrong, etc.) is closed at the helper, so
 * every route inherits the cap by switching to readBoundedBody.
 */
export const PAYLOAD_TOO_LARGE = 'payload_too_large';

function isPayloadTooLarge(err: unknown): boolean {
    return !!err
        && typeof err === 'object'
        && (err as { code?: string }).code === PAYLOAD_TOO_LARGE;
}

/**
 * readBoundedBody — Read the request body as a string, capped at
 * MAX_BODY_BYTES. Rejects with `{ code: PAYLOAD_TOO_LARGE }` on
 * overflow so the route handler can return 413 cleanly.
 *
 * Use this when the route needs to parse a non-JSON payload (e.g.
 * base64-encoded import previews, raw text). For JSON, prefer
 * readJsonBody which adds JSON.parse on top of this bound.
 */
export async function readBoundedBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let bytes = 0;
        let overflowed = false;
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => {
            if (overflowed) return; // discard further chunks
            bytes += chunk.length;
            if (bytes > MAX_BODY_BYTES) {
                overflowed = true;
                // Drop the buffered chunks so we don't sit on the
                // memory we were trying to bound.
                chunks.length = 0;
                // SP-12 — stop reading immediately and reject NOW rather
                // than waiting for 'end'. Previously the handler kept
                // consuming + discarding every remaining attacker byte off
                // the socket until 'end' fired (CPU/event-loop waste).
                // pause() halts the flow; the actual socket teardown happens
                // in writeOversizeError() after the 413 is written.
                try { req.pause(); } catch { /* already closing */ }
                const err = new Error(`request body exceeded ${MAX_BODY_BYTES} bytes`) as Error & { code?: string };
                err.code = PAYLOAD_TOO_LARGE;
                reject(err);
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (overflowed) return; // already rejected
            resolve(Buffer.concat(chunks).toString('utf8'));
        });
        req.on('error', (err) => { if (!overflowed) reject(err); });
    });
}

/**
 * readJsonBody — Read the request body and JSON.parse it.
 *
 * Bounded at MAX_BODY_BYTES via readBoundedBody. Throws with
 * `{ code: PAYLOAD_TOO_LARGE }` on oversize and a plain Error on
 * malformed JSON so handlers can map each to 413 / 400 cleanly.
 */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
    const text = await readBoundedBody(req);
    if (!text) return {};
    try {
        return JSON.parse(text);
    } catch (err) {
        throw new Error(`invalid JSON body: ${(err as Error).message}`);
    }
}

/**
 * writeOversizeError — convenience: write the 413 response for a body
 * that exceeded MAX_BODY_BYTES. Use inside a catch block after
 * isPayloadTooLarge(err) returns true.
 */
export function writeOversizeError(res: ServerResponse, req?: IncomingMessage): void {
    // Connection: close signals to the client that the server will not
    // read any more of the in-flight request body. Pairs with req.pause()
    // inside readBoundedBody: after the 413 flushes, we destroy the socket
    // (SP-12) so the daemon stops reading the attacker's remaining bytes
    // instead of leaving a half-open connection draining.
    res.writeHead(413, {
        'Content-Type': 'application/json',
        'Connection': 'close',
    });
    res.end(JSON.stringify({
        code: PAYLOAD_TOO_LARGE,
        message: `request body exceeded ${MAX_BODY_BYTES} bytes`,
        maxBytes: MAX_BODY_BYTES,
    }));
    // SP-12 — tear down the underlying socket after the response flushes so
    // buffered TCP bytes aren't read + discarded. Deferred a tick so the
    // 413 body reaches the client first. req is optional for back-compat
    // with callers that don't thread it through.
    if (req) {
        const t = setImmediate(() => { try { req.destroy(); } catch { /* already destroyed */ } });
        if (typeof (t as { unref?: () => void }).unref === 'function') (t as { unref: () => void }).unref();
    }
}

/**
 * payloadTooLarge — exported test predicate so route handlers can keep
 * their own catch blocks readable.
 */
export { isPayloadTooLarge };

/**
 * writeJson — JSON success response.
 */
export function writeJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}

/**
 * writeError — JSON error response. `code` mirrors the convention used
 * across server.ts: a snake_case stable identifier the UI can switch on.
 */
export function writeError(
    res: ServerResponse,
    status: number,
    code: string,
    message: string,
    extras?: Record<string, unknown>,
): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code, message, ...(extras ?? {}) }));
}

/**
 * writeWorkspaceRequired — Sprint L1/L1b canonical 400 response when a
 * route is called without an explicit workspace argument. Every
 * silent-active fallback (graphRegistry.activeName(), LORE_ACTIVE_WORKSPACE
 * env) must be replaced with this guard per the L0 audit contract.
 *
 * Wave 5: emits the single canonical error envelope via writeError —
 *   {"code":"workspace_required","message":"pass workspace=<name> as body field or query param"}
 * The machine code string is unchanged; it only moves from `error` to `code`,
 * and the former `hint` string is folded into `message`. HTTP status (400)
 * is unchanged.
 */
export function writeWorkspaceRequired(res: ServerResponse): void {
    writeError(
        res,
        400,
        'workspace_required',
        'pass workspace=<name> as body field or query param',
    );
}

/**
 * checkOutboxBackpressure — Sprint O4 convenience wrapper. Reads the
 * lag cache for the resolved workspace; on shouldBlock=true writes the
 * 503 response via writeOutboxBackpressure and returns true (caller
 * must `return` immediately). On false (cache miss OR under threshold)
 * returns false; the caller proceeds with the normal write path.
 *
 * Cache-miss path: returns false (fail-open per O4 spec hard
 * constraint). The cache itself logs the once-per-workspace warning;
 * we don't log again here.
 *
 * Wired into every hot + bulk write endpoint AFTER the Sprint L
 * workspace_required check fires and BEFORE the outbox commit. The
 * check is sub-millisecond — a Map.get + two numeric comparisons —
 * so the perf gate (<1ms steady-state overhead) holds trivially.
 */
export function checkOutboxBackpressure(
    res: ServerResponse,
    workspace: string,
    cache: { shouldBackpressure: (ws: string) => {
        shouldBlock: boolean;
        currentLagSeconds: number;
        thresholdSeconds: number;
        outboxDepth: number;
        cacheMiss: boolean;
    } } | undefined,
): boolean {
    if (!cache) return false;
    const decision = cache.shouldBackpressure(workspace);
    if (!decision.shouldBlock) return false;
    writeOutboxBackpressure(
        res,
        workspace,
        decision.currentLagSeconds,
        decision.thresholdSeconds,
        decision.outboxDepth,
    );
    return true;
}

/**
 * writeOutboxBackpressure — Sprint O4. 503 response shape when the
 * per-workspace outbox lag exceeds the configured threshold or the
 * depth exceeds the depth threshold. Carries:
 *
 *   HTTP 503
 *   Retry-After: <seconds>
 *   {"code":"outbox_lag","message":"<human reason>","workspace":"<ws>",
 *    "currentLagSeconds":N,"thresholdSeconds":N,"outboxDepth":N,
 *    "retryAfterSeconds":N}
 *
 * Wave 5: emits the single canonical error envelope via writeError — the
 * machine code string 'outbox_lag' moves from `error` to `code`, a human
 * `message` is added, and the machine-relevant fields (workspace, lag/
 * threshold/depth, retryAfterSeconds) ride along as extras. HTTP status
 * (503) and the Retry-After header are unchanged.
 *
 * Distinct from W9's 429 (rate limit) — the body code 'outbox_lag'
 * lets clients distinguish "you're sending too fast" (429, transient
 * per-bucket budget) from "the substrate is behind, the workspace
 * can't accept writes right now" (503, durable backpressure signaling
 * the replicator hasn't drained yet). Same Retry-After header so
 * generic HTTP retry libraries DTRT regardless of the status code.
 *
 * Retry-After is computed as:
 *   max(1, currentLagSeconds - thresholdSeconds + 1)
 * which is "wait at least until the lag could plausibly clear back to
 * the threshold" — a deliberately conservative hint; the server will
 * accept a retry sooner if the replicator catches up.
 *
 * Sprint O gate test O-D6 looks for the literal strings 'outbox_lag'
 * AND 'Retry-After' inside middleware.ts (see OUTBOX_BACKPRESSURE_*
 * constants there). This helper is the runtime emitter; middleware.ts
 * carries the canonical constants both files share.
 */
export function writeOutboxBackpressure(
    res: ServerResponse,
    workspace: string,
    currentLagSeconds: number,
    thresholdSeconds: number,
    outboxDepth: number,
): void {
    const retryAfter = Math.max(1, Math.ceil(currentLagSeconds - thresholdSeconds + 1));
    // Canonical {code, message, ...extras} envelope. Written head-first
    // (not via writeError) because this response also carries the
    // Retry-After header that writeError does not thread through.
    res.writeHead(503, {
        'Content-Type': 'application/json',
        'Retry-After': String(retryAfter),
    });
    res.end(JSON.stringify({
        code: 'outbox_lag',
        message: `workspace "${workspace}" is behind: outbox lag ${currentLagSeconds}s exceeds threshold ${thresholdSeconds}s (depth ${outboxDepth}); retry after ${retryAfter}s`,
        workspace,
        currentLagSeconds,
        thresholdSeconds,
        outboxDepth,
        retryAfterSeconds: retryAfter,
    }));
}

/**
 * extractWorkspace — pull an explicit workspace from a body object or
 * URL search params. Accepts the modern `workspace` key as well as the
 * legacy `project` key (L5 will sweep `project` from request shapes;
 * until then both are honored so older callers keep working). Returns
 * the string when present and non-empty; returns undefined otherwise.
 */
export function extractWorkspace(
    body: Record<string, unknown> | null | undefined,
    searchParams?: URLSearchParams,
): string | undefined {
    if (body && typeof body === 'object' && !Array.isArray(body)) {
        const w = (body as { workspace?: unknown }).workspace
            ?? (body as { project?: unknown }).project;
        if (typeof w === 'string' && w.length > 0) return w;
    }
    if (searchParams) {
        const q = searchParams.get('workspace') ?? searchParams.get('project');
        if (typeof q === 'string' && q.length > 0) return q;
    }
    return undefined;
}
