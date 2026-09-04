/**
 * helpers.ts — Tiny HTTP utilities shared by every route family.
 *
 * `readJsonBody` was the only helper inlined in server.ts; `writeJson` /
 * `writeError` are new but follow the exact pattern every existing
 * `if (pathname === ...)` block uses, so route family extractions can
 * adopt them without changing wire behavior.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';

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
 * X-json400 audit (2026-09-03): marker on errors thrown by parseJsonBody /
 * readJsonBody when the body is present but not valid JSON. Mirrors the
 * PAYLOAD_TOO_LARGE tagging pattern above — handlers match on `code` instead
 * of message-sniffing (`/^invalid JSON body:/i.test(err.message)`), which
 * several routes had already reinvented ad hoc (routes/collections.ts) and
 * several others never checked at all, so a truncated/malformed body fell
 * through their generic catch to a 500 (POST /api/node and ~20 sibling
 * routes — see the X-json400 fix-note table). The tag also lets
 * writeInvalidJson (below) recognize the error without inspecting text.
 */
export const INVALID_JSON_BODY = 'invalid_json_body';

function isInvalidJsonBody(err: unknown): boolean {
    return !!err
        && typeof err === 'object'
        && (err as { code?: string }).code === INVALID_JSON_BODY;
}
export { isInvalidJsonBody };

/**
 * parseJsonBody — JSON.parse with a tagged error on failure so a route that
 * reads its own body (readBoundedBody + a manual parse, e.g. postNode.ts)
 * gets the exact same detectable-by-callers shape readJsonBody produces
 * below, instead of a bare Error indistinguishable from a real internal
 * fault in a shared catch block. An empty body parses to `{}` (matches the
 * long-standing readJsonBody convention several routes already depend on,
 * e.g. import.ts's own readJsonBody reimplementation).
 */
export function parseJsonBody(text: string): unknown {
    if (!text) return {};
    try {
        return JSON.parse(text);
    } catch (err) {
        const tagged = new Error(`invalid JSON body: ${(err as Error).message}`) as Error & { code?: string };
        tagged.code = INVALID_JSON_BODY;
        throw tagged;
    }
}

/**
 * readJsonBody — Read the request body and JSON.parse it.
 *
 * Bounded at MAX_BODY_BYTES via readBoundedBody. Throws with
 * `{ code: PAYLOAD_TOO_LARGE }` on oversize and `{ code: INVALID_JSON_BODY }`
 * on malformed JSON so handlers can map each to 413 / 400 cleanly.
 */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
    const text = await readBoundedBody(req);
    return parseJsonBody(text);
}

/**
 * writeInvalidJson — clean 400 response for a parseJsonBody/readJsonBody
 * failure (isInvalidJsonBody(err) === true).
 *
 * Deliberately does NOT run the error through redactError: redactError's
 * quoted-token pass (security/logRedact.ts) is meant to scrub node-ID-shaped
 * content out of substrate error messages, but a JSON.parse SyntaxError
 * quotes its OWN diagnostic text (e.g. the bad token or the surrounding
 * snippet), which is JSON-syntax metadata, not caller content. Running it
 * through redactError mangled that diagnostic into an unreadable `id#<hash>`
 * fragment (X-json400 audit finding) — worse than useless for a client
 * trying to fix its own payload, and not a privacy win since the source
 * text is bounded, already client-supplied, and never echoed back in full.
 */
export function writeInvalidJson(res: ServerResponse, err: unknown): void {
    const message = err instanceof Error ? err.message : 'invalid JSON body';
    writeError(res, 400, INVALID_JSON_BODY, message);
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
 * writeGraphEngineError — round-S fix (2026-09-04, finding 3 addendum).
 *
 * `LegacyGraphEngineRemovedError` (graphEngineSelector.ts — a workspace
 * whose workspaces.json still declares the removed legacy graph engine)
 * carries its own `.status`/`.code` (501 / `legacy_graph_engine_removed`),
 * but every route that reaches it through a generic `catch (err) {
 * writeError(res, 500, 'internal_error', redactError(err)) }` fallback
 * (readGate.ts's `resolveReadGraph` — shared by /api/node, /api/subgraph,
 * /api/node/lineage, /api/node-full, /api/node/as-of,
 * /api/node/supersession-candidates — and diagnostic/stats.ts's
 * `handleStats`) discarded that and answered a generic 500. `redactError`
 * additionally hashes the quoted engine-name token out of the message, so a
 * caller could not even grep the response for it — a legacy-engine
 * refusal was indistinguishable from a real server fault.
 *
 * Call this FIRST in any such catch block; it writes the correct 501 +
 * `legacy_graph_engine_removed` and returns true, or returns false
 * (writing nothing) so the caller's own fallback still runs for every
 * other error. Takes `err: unknown` and does its own `instanceof` check
 * (rather than importing the class into every call site's type surface)
 * so callers stay one line: `if (writeGraphEngineError(res, err)) return;`.
 */
export function writeGraphEngineError(res: ServerResponse, err: unknown): boolean {
    if (
        err instanceof Error
        && (err as { code?: unknown }).code === 'legacy_graph_engine_removed'
        && typeof (err as { status?: unknown }).status === 'number'
    ) {
        const e = err as Error & { code: string; status: number; workspace?: string | null };
        writeError(res, e.status, e.code, e.message, { workspace: e.workspace ?? null });
        return true;
    }
    return false;
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
 * Security checklist item #12 — browser security headers.
 *
 * Every HTTP response the daemon writes now carries a baseline set of
 * browser-hardening headers. This is applied ONCE, at the true chokepoint
 * every request passes through before any gate or route writes a byte:
 * mcp/http/middleware.ts's runHttpGates calls this as its first statement.
 * That single call site covers EVERY response — auth failures, rate-limit
 * 429s, the bootstrap short-circuit, OPTIONS preflights, and every route —
 * because none of those downstream writers construct their own response
 * object; they all reuse the one `res` that already carries these headers.
 *
 * Headers are set via res.setHeader() rather than folded into a writeHead()
 * call, so Node's own merge rule does the rest: a later
 * `res.writeHead(status, { 'Content-Type': ... })` elsewhere ADDS to
 * (doesn't replace) whatever was set with setHeader(), and only overrides a
 * specific header when that call's own object repeats its name. Every
 * existing route's writeHead() call sets Content-Type (and occasionally
 * Retry-After / Connection / its own Cache-Control) — none of them name
 * these five headers — so they inherit the defaults untouched. The one
 * response that legitimately needs a DIFFERENT Content-Security-Policy is
 * GET /api/export/html (routes/static.ts), which supplies its own CSP in
 * its writeHead() call; see buildHtmlExportCsp below.
 *
 *   - X-Content-Type-Options: nosniff — stops a browser MIME-sniffing a
 *     JSON (or any) response body into an executable content type.
 *   - X-Frame-Options: DENY (paired with the default CSP's
 *     frame-ancestors 'none' below) — this is a loopback API daemon with
 *     no served UI; nothing should ever be able to frame it.
 *   - Referrer-Policy: no-referrer — daemon URLs can carry workspace
 *     names/ids in the path or query string; never leak them via Referer
 *     on any outbound navigation/fetch a client makes from a rendered page.
 *   - Cache-Control: no-store — every API response sits behind Bearer auth
 *     and can carry live graph data; never let a shared or browser cache
 *     retain it. A route with a different caching need (e.g. the streaming
 *     NDJSON response's own no-cache/no-transform) overrides this per the
 *     merge rule above.
 *   - Content-Security-Policy: default-src 'none'; frame-ancestors 'none'
 *     — the strict default for every non-HTML (JSON/NDJSON/SSE) response.
 *
 * No HSTS: the daemon only ever listens on loopback plain HTTP
 * (127.0.0.1 / localhost / [::1] — see httpAuth.ts's isAllowedOrigin). HSTS
 * exists to force a browser to upgrade future requests to HTTPS for a
 * given origin; there is no HTTPS variant of this loopback origin to
 * upgrade to, so the header would be inert at best and a foot-gun if this
 * code were ever mistakenly fronted by a real hostname.
 */
export function applySecurityHeaders(res: ServerResponse): void {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
}

/**
 * generateCspNonce — cryptographically random per-response nonce for GET
 * /api/export/html's inline <script>/<style> tags. 16 bytes (128 bits) of
 * randomness, base64url-encoded so it drops cleanly into both an HTML
 * attribute and a CSP directive value with no escaping.
 */
export function generateCspNonce(): string {
    return randomBytes(16).toString('base64url');
}

/**
 * buildHtmlExportCsp — the page-specific CSP for GET /api/export/html, the
 * one daemon response that is actually rendered as a page in a browser
 * (engines/htmlExport.ts's self-contained vis-network snapshot). Derived
 * from exactly what that template loads, so it's tighter than the generic
 * default-src 'none' every other response gets:
 *
 *   - script-src: the one inline <script> (the embedded graph DATA + the
 *     vis.Network wiring) is allowed via its per-response `nonce`, never
 *     'unsafe-inline'; the vis-network CDN build is allow-listed by origin
 *     (its <script> tag already carries a pinned version + Subresource
 *     Integrity hash — the CSP origin allow-list is defense in depth on
 *     top of that, not a substitute for it).
 *   - style-src: the one inline <style> block, same nonce.
 *   - connect-src 'none': the export is a static snapshot; it must never
 *     phone home.
 *   - frame-ancestors 'none' / base-uri 'none': same framing/base-tag
 *     hardening as the generic default.
 */
export function buildHtmlExportCsp(nonce: string): string {
    return [
        "default-src 'none'",
        `script-src 'nonce-${nonce}' https://unpkg.com`,
        `style-src 'nonce-${nonce}'`,
        "connect-src 'none'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
    ].join('; ');
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
