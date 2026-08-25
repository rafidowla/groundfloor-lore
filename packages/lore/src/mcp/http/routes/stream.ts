/**
 * routes/stream.ts — Sprint S warm-lane streaming-ingest endpoint.
 *
 * Surface:
 *   POST /api/stream/connect?workspace=X
 *     - chunked-transfer request body, newline-delimited JSON events
 *     - chunked-transfer response, one JSON ack frame per event
 *     - 200 with first frame on accept; 400/429/503 on pre-flight
 *       rejection
 *
 * Invariants preserved from prior sprints:
 *   - Sprint L:  workspace_required fires BEFORE backpressure +
 *                concurrency checks (Z-D7 / S-D6 sentinel).
 *   - Sprint O:  every accepted event commits to the outbox via the
 *                LocalStreamConsumer → recordHotWrite path before the
 *                ack frame is written (S-D2 / S-D7 sentinel).
 *   - Sprint Z3: per-tenant concurrency cap (default 3 streams /
 *                workspace) returns 429 + Retry-After when exceeded
 *                (S-D5). Shared ConcurrencyLimiter primitive composed
 *                by StreamRegistry; same observable shape as Z3.
 *   - Sprint O4: outbox lag → 503 outbox_lag with Retry-After
 *                BEFORE acquiring a concurrency slot (S-D8).
 *
 * Scope guards (per spec):
 *   - Malformed JSON event → per-event ack with ok:false / error:
 *     'validation'; stream stays open. Hard parser exceptions never
 *     kill the connection. (S-D scope guard)
 *   - Connection drop mid-stream → registry.release() in a finally
 *     block; outbox state is consistent because every committed event
 *     landed via recordHotWrite synchronously before the ack frame.
 *     (S-D4 sentinel)
 *   - Body cap: LORE_STREAM_MAX_BYTES env; default 1 GiB. Above the
 *     hot-lane MAX_BODY_BYTES (10 MiB) because streams are intended
 *     to be long-lived; below the bulk-load cap (10 GiB) because a
 *     stream is row-shaped, not file-shaped.
 *
 * Cloud-pluggability:
 *   - The route consumes a StreamConsumerAdapter (cloud-pluggable
 *     interface). LocalStreamConsumer is the local-mode default; a
 *     future KafkaStreamConsumer / NATSStreamConsumer drops in by
 *     swapping the consumer factory in services.ts.
 *
 * Launch gate (decided 2026-08-19):
 *   - Streaming ingest is CLOUD-ONLY for the local/embedded launch.
 *     tryStreamRoutes refuses BOTH routes (/connect AND /sessions) with a
 *     structured 501 stream_ingest_cloud_only at DISPATCH — before
 *     workspace extraction, token-scope binding, or any registry/outbox
 *     access — whenever deps.deploymentMode !== 'cloud'. Embedded hosts
 *     never reach this dispatcher at all (runMode 'embedded' starts no
 *     HTTP transport — see mcp/server.ts main()), and 'embedded'
 *     collapses to deploymentMode 'local' at the substrate level, so the
 *     single !== 'cloud' check covers every non-cloud path that CAN
 *     reach this code.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { URL } from 'node:url';
import {
    writeError,
    writeWorkspaceRequired,
    extractWorkspace,
    checkOutboxBackpressure,
} from '../helpers.js';
import type { OutboxLagCache } from '../../../outbox/lagCache.js';
import type { OutboxStore } from '../../../outbox/types.js';
import type { StreamRegistry } from '../../../streaming/streamRegistry.js';
import {
    LocalStreamConsumer,
    type StreamConsumerAdapter,
    type StreamEvent,
    type StreamEventAck,
} from '../../../streaming/streamConsumer.js';
import { bindRouteTarget } from '../../../security/routeWorkspaceBinding.js';
import { STREAM_INGEST_CLOUD_ONLY } from '../errorCodes.js';

/**
 * SP-04 (retry re-sweep) — token-scoped read gate for GET
 * /api/stream/sessions, which resolves a caller-supplied workspace and lists
 * that workspace's active ingest sessions. A bound principal requesting a
 * workspace other than its own (or "*") needs cross-workspace-read; null
 * principal = legacy/local bypass. Returns true when it wrote a 4xx (caller
 * must `return true`).
 */
function denyStreamCrossWorkspaceRead(res: ServerResponse, workspace: string): boolean {
    return bindRouteTarget(res, { requested: workspace, intent: 'read' }) === null;
}

/** Default body cap for /api/stream/connect. 1 GiB — large enough for
 *  multi-hour streams of small events; small enough to bound disk +
 *  memory pressure if a misbehaving client never closes the socket. */
export const DEFAULT_STREAM_MAX_BYTES = 1 * 1024 * 1024 * 1024;

/** SP-12 — per-LINE cap, distinct from the whole-body maxBytes cap.
 *  Without it, a client streaming 1 GiB with NO newline pins ~1 GiB of
 *  UTF-8 string in the per-connection `buffer` before any frame is parsed.
 *  Default 1 MiB — generous for a JSONL event line, tiny vs the body cap. */
export const DEFAULT_STREAM_MAX_LINE_BYTES = 1 * 1024 * 1024;

const ALLOWED_FORMATS = new Set<string>(['jsonl']);
const DEFAULT_FORMAT = 'jsonl';
const ALLOWED_EMBED = new Set<string>(['inline', 'queued', 'skip']);
const DEFAULT_EMBED = 'queued'; // Sprint E default for warm-lane writes.

/** Default outbox kind when a producer doesn't override per-event. */
const DEFAULT_OPERATION_KIND = 'stream.event';

/** 2.7 (2026-08-17) — the stream connect surface is a telemetry/notification
 *  channel, not a substrate write path. Only the marker kind is accepted; any
 *  other operationKind would be cast to OutboxOperationKind and applied by the
 *  replicator (node.delete, verbatim.upsert, …) — bypassing the write allowlist,
 *  the finer 'delete' permission gate, and audit. */
const ALLOWED_STREAM_OPERATION_KINDS = new Set<string>(['stream.event']);

/** Retry-After (seconds) when concurrency cap hit. Tuned for typical
 *  stream lifetime — clients should reconnect after a paused window
 *  rather than retry-storming. */
const RETRY_AFTER_SECONDS = 5;

function readStreamMaxBytes(): number {
    const raw = process.env['LORE_STREAM_MAX_BYTES'];
    if (!raw) return DEFAULT_STREAM_MAX_BYTES;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_STREAM_MAX_BYTES;
    return n;
}

/** SP-12 — per-line cap (LORE_STREAM_MAX_LINE_BYTES env, default 1 MiB). */
function readStreamMaxLineBytes(): number {
    const raw = process.env['LORE_STREAM_MAX_LINE_BYTES'];
    if (!raw) return DEFAULT_STREAM_MAX_LINE_BYTES;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_STREAM_MAX_LINE_BYTES;
    return n;
}

export interface StreamRouteDeps {
    /**
     * Launch gate (2026-08-19) — streaming ingest is cloud-only. REQUIRED
     * (unlike the optional stores below) so no caller can "forget" the mode
     * and silently expose the route locally: tryStreamRoutes 501s BOTH
     * stream routes at dispatch whenever this is not 'cloud'. The
     * dispatcher-level type is 'local' | 'cloud' (mcp/http/dispatcher.ts);
     * 'embedded' is a runMode distinction that never runs this HTTP
     * dispatcher, not a third value here.
     */
    deploymentMode: 'local' | 'cloud';
    /** Sprint O outbox — every committed event flows through here. */
    outboxStore?: OutboxStore;
    /** Sprint O4 backpressure cache. */
    outboxLagCache?: OutboxLagCache;
    /** Sprint S in-memory session registry + concurrency cap. */
    streamRegistry?: StreamRegistry;
    /**
     * Optional consumer factory override. Default = new LocalStreamConsumer
     * bound to outboxStore. Cloud activation swaps this for a Kafka /
     * NATS / Kinesis driver without touching the route.
     */
    createConsumer?: (outboxStore: OutboxStore) => StreamConsumerAdapter;
}

export async function tryStreamRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
    pathname: string,
    deps: StreamRouteDeps,
): Promise<boolean> {
    const isConnect = pathname === '/api/stream/connect' && req.method === 'POST';
    const isSessions = pathname === '/api/stream/sessions' && req.method === 'GET';
    if (!isConnect && !isSessions) return false;

    // Launch gate (2026-08-19) — streaming ingest is cloud-only. Refuse at
    // DISPATCH, before workspace_required / bindRouteTarget / registry.open,
    // so a local-mode daemon never opens a session, never touches the
    // outbox, and never implies the feature half-exists by serving an empty
    // /sessions list. This composes with (does not replace) the per-handler
    // workspace-binding gates: in cloud mode those still run unchanged.
    if (deps.deploymentMode !== 'cloud') {
        writeError(res, 501, STREAM_INGEST_CLOUD_ONLY,
            `streaming ingest is cloud-only: ${req.method} ${pathname} is not available in ${deps.deploymentMode} mode`);
        return true;
    }

    if (isConnect) {
        return handleConnect(req, res, url, deps);
    }
    return handleListSessions(req, res, url, deps);
}

// ─── POST /api/stream/connect ─────────────────────────────────────────

async function handleConnect(
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
    deps: StreamRouteDeps,
): Promise<boolean> {
    const search = new URL(url, 'http://localhost').searchParams;

    // 1. Sprint L invariant — workspace_required FIRST.
    const workspace = extractWorkspace(null, search);
    if (!workspace) {
        writeWorkspaceRequired(res);
        return true;
    }

    // L-068 — /api/stream/connect is the streaming INGEST endpoint (events are
    // written to the outbox), so it requires write scope. Without this a
    // read-only app token could ingest. Null principal = local/legacy bypass.
    if (bindRouteTarget(res, { requested: workspace, intent: 'write' }) === null) return true;

    // 2. Validate format + embed mode (graceful on unknown values).
    const formatRaw = search.get('format') ?? DEFAULT_FORMAT;
    if (!ALLOWED_FORMATS.has(formatRaw.toLowerCase())) {
        writeError(res, 400, 'invalid_format',
            `format must be one of ${[...ALLOWED_FORMATS].join('|')} (got ${formatRaw})`);
        return true;
    }
    const embedRaw = search.get('embed') ?? DEFAULT_EMBED;
    if (!ALLOWED_EMBED.has(embedRaw.toLowerCase())) {
        writeError(res, 400, 'invalid_embed',
            `embed must be one of ${[...ALLOWED_EMBED].join('|')} (got ${embedRaw})`);
        return true;
    }

    // 3. Required wiring — without an outbox we cannot honor Sprint O
    //    invariants, so refuse rather than silently dropping events.
    if (!deps.outboxStore) {
        writeError(res, 503, 'outbox_unavailable',
            'streaming ingest requires an outbox store; service not ready');
        return true;
    }
    if (!deps.streamRegistry) {
        writeError(res, 503, 'stream_registry_unavailable',
            'streaming ingest registry not wired');
        return true;
    }

    // 4. Sprint O4 backpressure — 503 outbox_lag if workspace is behind.
    //    Runs BEFORE concurrency acquire so a rejected request never
    //    reserves a slot.
    if (checkOutboxBackpressure(res, workspace, deps.outboxLagCache)) {
        return true;
    }

    // 5. Sprint S concurrency cap — open a registry session.
    const label = search.get('label') ?? undefined;
    const open = deps.streamRegistry.open(workspace, label ?? undefined);
    if (!open.ok) {
        // Retry-After is set via setHeader so it survives writeError's
        // writeHead (Node merges setHeader'd fields with the writeHead map).
        res.setHeader('Retry-After', String(RETRY_AFTER_SECONDS));
        writeError(res, 429, 'concurrency_limit', 'workspace stream concurrency cap reached', {
            workspace,
            current: open.current,
            cap: open.cap,
            retryAfterSeconds: RETRY_AFTER_SECONDS,
        });
        return true;
    }
    const session = open.session;

    // 6. Build the consumer. Default is LocalStreamConsumer; cloud
    //    activation swaps via deps.createConsumer.
    const consumer = (deps.createConsumer
        ? deps.createConsumer(deps.outboxStore)
        : new LocalStreamConsumer({ outboxStore: deps.outboxStore, label: 'http-stream' }));

    // 7. Open the chunked response. First frame is a connection-open ack
    //    with sessionId so the client can correlate with daemon logs.
    res.writeHead(200, {
        'Content-Type': 'application/x-ndjson',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
    });
    res.write(JSON.stringify({
        type: 'connected',
        sessionId: session.sessionId,
        workspace,
        format: formatRaw,
        embed: embedRaw,
        openedAt: session.openedAt,
        capInfo: { cap: deps.streamRegistry.getCap(), current: deps.streamRegistry.getCount(workspace) },
    }) + '\n');

    try {
        await consumer.start();
        await pumpEvents(req, res, {
            workspace,
            sessionId: session.sessionId,
            consumer,
            registry: deps.streamRegistry,
            maxBytes: readStreamMaxBytes(),
            maxLineBytes: readStreamMaxLineBytes(),
        });
    } catch (err) {
        // Last-resort error frame; the response is already partially
        // written so we cannot set a status code.
        try {
            res.write(JSON.stringify({
                type: 'error',
                error: 'internal',
                message: (err as Error).message,
            }) + '\n');
        } catch { /* socket closed */ }
    } finally {
        // CRITICAL: release the concurrency slot whatever happens.
        // Connection drops, exceptions, normal close — all paths land
        // here so the per-workspace counter never leaks (S-D4 scope
        // guard).
        try { await consumer.stop(); } catch { /* swallow — already closing */ }
        deps.streamRegistry.release(session.sessionId);
        try { res.end(); } catch { /* socket closed */ }
    }
    return true;
}

// ─── Per-connection event pump ───────────────────────────────────────

interface PumpDeps {
    workspace: string;
    sessionId: string;
    consumer: StreamConsumerAdapter;
    registry: StreamRegistry;
    maxBytes: number;
    /** SP-12 — per-line cap; see DEFAULT_STREAM_MAX_LINE_BYTES. */
    maxLineBytes: number;
}

/**
 * Read the chunked request body line-by-line, parse each line as JSON,
 * forward to the consumer, write a per-event ack frame to the
 * response. Returns when the client closes the request stream or the
 * body cap is hit.
 *
 * Malformed JSON: per-event ack with ok:false / error:'validation'.
 * Stream stays open — does NOT kill the connection (Sprint S spec).
 *
 * Body cap: when exceeded, write a final 'closed' ack frame and
 * resolve. Subsequent chunks are discarded; the socket continues to
 * drain so the client sees the close cleanly.
 */
async function pumpEvents(
    req: IncomingMessage,
    res: ServerResponse,
    deps: PumpDeps,
): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        let buffer = '';
        let bytes = 0;
        let overflowed = false;
        let processing: Promise<void> = Promise.resolve();

        const handleLine = async (rawLine: string): Promise<void> => {
            const line = rawLine.trim();
            if (!line) return;
            let ack: StreamEventAck;
            let parsed: unknown;
            try {
                parsed = JSON.parse(line);
            } catch (err) {
                ack = {
                    id: synthEventId(),
                    ok: false,
                    error: 'validation',
                };
                deps.registry.recordEvent(deps.sessionId, false);
                try { res.write(JSON.stringify(ack) + '\n'); } catch { /* socket closed */ }
                return;
            }
            const event = normaliseEvent(parsed, deps.workspace);
            if (!event) {
                ack = {
                    id: synthEventId(),
                    ok: false,
                    error: 'validation',
                };
                deps.registry.recordEvent(deps.sessionId, false);
                try { res.write(JSON.stringify(ack) + '\n'); } catch { /* socket closed */ }
                return;
            }
            try {
                ack = await deps.consumer.onEvent(event);
            } catch (err) {
                ack = { id: event.id, ok: false, error: 'internal' };
            }
            deps.registry.recordEvent(deps.sessionId, ack.ok);
            try { res.write(JSON.stringify(ack) + '\n'); } catch { /* socket closed */ }
        };

        const enqueueLine = (line: string): void => {
            // Serialise per-event processing inside a connection. The
            // outbox itself tolerates concurrent writes (per-workspace
            // sequenceId allocator is atomic), but serializing here
            // keeps the ack-frame order matched to the wire order,
            // which the client correlation contract depends on.
            processing = processing.then(() => handleLine(line));
        };

        // SP-12 — on any overflow, stop accepting bytes AND terminate the
        // underlying TCP socket so the daemon doesn't keep reading +
        // discarding attacker-controlled bytes (CPU/event-loop waste).
        // Previously the handler only set `overflowed` and returned early,
        // so Node kept firing 'data' for buffered TCP. pause() halts the
        // flow; destroy() (next tick, after the close frame flushes) tears
        // down the socket. Idempotent via the `overflowed` latch.
        const tearDown = (frame: Record<string, unknown>): void => {
            overflowed = true;
            buffer = ''; // release the in-flight partial immediately
            try { req.pause(); } catch { /* already closing */ }
            try { res.write(JSON.stringify(frame) + '\n'); } catch { /* socket closed */ }
            // Defer the destroy a tick so the close frame is flushed to the
            // client before the socket is torn down.
            const t = setImmediate(() => {
                try { res.end(); } catch { /* socket closed */ }
                try { req.destroy(); } catch { /* already destroyed */ }
            });
            if (typeof (t as { unref?: () => void }).unref === 'function') (t as { unref: () => void }).unref();
        };

        req.on('data', (chunk: Buffer) => {
            if (overflowed) return;
            bytes += chunk.length;
            if (bytes > deps.maxBytes) {
                tearDown({ type: 'closed', reason: 'body_too_large', maxBytes: deps.maxBytes });
                return;
            }
            buffer += chunk.toString('utf8');
            let nl: number;
            while ((nl = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, nl);
                buffer = buffer.slice(nl + 1);
                enqueueLine(line);
            }
            // SP-12 — per-line cap: a client streaming a huge payload with
            // NO newline would otherwise grow `buffer` up to the body cap
            // (1 GiB) in process memory. Once the un-terminated tail exceeds
            // maxLineBytes, close + tear down before the heap balloons.
            if (!overflowed && buffer.length > deps.maxLineBytes) {
                tearDown({ type: 'closed', reason: 'line_too_long', maxLineBytes: deps.maxLineBytes });
            }
        });
        req.on('end', () => {
            // Flush trailing partial line (if it has content).
            if (buffer.length > 0 && !overflowed) {
                enqueueLine(buffer);
                buffer = '';
            }
            // Wait for the per-event queue to drain before resolving.
            processing.then(() => resolve(), (err) => reject(err));
        });
        req.on('error', (err) => {
            // Treat error as normal close — let the finally in
            // handleConnect release the slot.
            processing.then(() => resolve(), () => resolve());
        });
        req.on('close', () => {
            // Client disconnected before sending 'end'. Drain in-flight
            // then resolve so handleConnect's finally fires.
            processing.then(() => resolve(), () => resolve());
        });
    });
}

export function normaliseEvent(raw: unknown, workspace: string): StreamEvent | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const obj = raw as Record<string, unknown>;
    const id = typeof obj['id'] === 'string' && obj['id'] ? obj['id'] : synthEventId();
    const operationKindRaw = obj['operationKind'];
    const operationKind = typeof operationKindRaw === 'string' && operationKindRaw
        ? operationKindRaw
        : DEFAULT_OPERATION_KIND;
    // 2.7 — only the marker kind is accepted (see ALLOWED_STREAM_OPERATION_KINDS).
    if (!ALLOWED_STREAM_OPERATION_KINDS.has(operationKind)) return null;
    const payload = (obj['payload'] && typeof obj['payload'] === 'object' && !Array.isArray(obj['payload']))
        ? obj['payload'] as Record<string, unknown>
        : {};
    return {
        id,
        workspace,
        operationKind,
        payload,
        receivedAt: new Date().toISOString(),
    };
}

let _eventIdCounter = 0;
function synthEventId(): string {
    _eventIdCounter = (_eventIdCounter + 1) >>> 0;
    return `stream-${Date.now().toString(36)}-${_eventIdCounter.toString(36)}`;
}

// ─── GET /api/stream/sessions?workspace=X ────────────────────────────

async function handleListSessions(
    _req: IncomingMessage,
    res: ServerResponse,
    url: string,
    deps: StreamRouteDeps,
): Promise<boolean> {
    const search = new URL(url, 'http://localhost').searchParams;
    const workspace = extractWorkspace(null, search);
    if (!workspace) {
        writeWorkspaceRequired(res);
        return true;
    }
    if (denyStreamCrossWorkspaceRead(res, workspace)) return true;
    if (!deps.streamRegistry) {
        writeError(res, 503, 'stream_registry_unavailable', 'streaming ingest registry not wired');
        return true;
    }
    const sessions = deps.streamRegistry.listForWorkspace(workspace);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        workspace,
        cap: deps.streamRegistry.getCap(),
        count: sessions.length,
        sessions,
    }));
    return true;
}
