/**
 * modelServer/connection.ts — per-socket protocol handling (D9 §5.2/§5.3).
 *
 * One `attachConnection()` call per accepted `net.Socket`: frames the byte
 * stream, gates everything behind a successful `hello` (constant-time
 * token check + protocol version check), then dispatches each subsequent
 * message. `embed` requests go onto the shared `EmbedQueue` (queue.ts);
 * everything else (`rerank`, `status`, `cancel`, `shutdown`) is handled
 * directly since only `embed` needs the round-robin/priority queue.
 *
 * Logging discipline: every `log.*` call in this file passes only ids,
 * op names, counts and byte sizes — never `text`/`texts`/`query`/`passages`
 * values. See log.ts's header comment for why that boundary lives at the
 * call site, not inside the logger.
 */

import * as crypto from 'node:crypto';
import type { Socket } from 'node:net';
import {
    FrameDecoder,
    ModelServerError,
    PROTOCOL_VERSION,
    MAX_EMBED_TEXTS,
    MAX_RERANK_PASSAGES,
    MAX_FRAME_BYTES,
    MAX_CLIENTS,
    encodeFrame,
    constantTimeEqStr,
    isHelloMessage,
    isEmbedMessage,
    isRerankMessage,
    isCancelMessage,
    isStatusMessage,
    isShutdownMessage,
    type ModelServerErrorName,
} from './protocol.js';
import { handleEmbed, handleRerank } from './handlers.js';
import type { EmbedQueue } from './queue.js';
import type { ModelServerLogger } from './log.js';

/** How long an unauthenticated socket is given to send a valid `hello`
 *  before it's closed (nit fix, review-324). `ConnectionDeps.helloDeadlineMs`
 *  can override this per-server (server.ts doesn't, so this is the live
 *  default); 0 or a negative value disables the deadline entirely (used by
 *  tests that need to probe a connection without racing a timer). */
const DEFAULT_HELLO_DEADLINE_MS = 5000;

/** Frame-size ceiling for an unauthenticated connection. Far below
 *  `MAX_FRAME_BYTES` — the only frame a not-yet-authenticated client can
 *  legitimately send is `hello`, which is tiny. */
const PRE_AUTH_MAX_FRAME_BYTES = 64 * 1024; // 64 KiB

/** Cap on simultaneously open, not-yet-authenticated connections across the
 *  whole process. server.ts's `MODEL_SERVER_MAX_CLIENTS` check (server.ts,
 *  not ours to edit) only counts AUTHENTICATED clients, so without this a
 *  connect flood that never sends a valid hello could grow unbounded ahead
 *  of that gate. Generous relative to `MAX_CLIENTS` since legitimate churn
 *  (several hosts starting up and handshaking around the same moment) is
 *  expected and each pre-auth connection costs little (a decoder + one
 *  timer). Enforced here, module-level, since server.ts is off-limits. */
const PRE_AUTH_MAX_CONNECTIONS = MAX_CLIENTS * 4;
let preAuthConnections = 0;

export interface StatusSnapshot {
    pid: number;
    uptimeMs: number;
    clients: number;
    queueDepth: number;
    protocolVersion: number;
    idleMs: number;
    rssBytes: number;
    models: import('./protocol.js').ServedModel[];
}

export interface ConnectionDeps {
    token: string;
    embedQueue: EmbedQueue;
    log: ModelServerLogger;
    queueMaxPerClient: number;
    textCharLimit: number;
    /** Called once, on a successful hello. */
    onClientConnect(clientId: string): void;
    /** Called once per connection that reached onClientConnect, on close. */
    onClientDisconnect(clientId: string): void;
    /** Called when a request starts / finishes, so the idle timer can be
     *  cancelled/rearmed by the caller (server.ts). */
    onActivityStart(): void;
    onActivityEnd(): void;
    getStatus(): StatusSnapshot;
    /** Validate a shutdown token and, on match, begin graceful shutdown.
     *  Returns false (without side effects) on a token mismatch. */
    requestShutdown(token: string): boolean;
    /** Override for `DEFAULT_HELLO_DEADLINE_MS` (mainly for tests). 0 or
     *  negative disables the deadline. */
    helloDeadlineMs?: number;
}

function send(socket: Socket, header: Record<string, unknown>, body?: Buffer): void {
    if (socket.destroyed || socket.writableEnded) return;
    try {
        socket.write(encodeFrame(header, body));
    } catch {
        // a write racing a just-closed socket is not this server's problem
    }
}

function sendError(socket: Socket, id: string | undefined, err: unknown): void {
    const code: ModelServerErrorName = err instanceof ModelServerError ? err.code : 'internal';
    const message = err instanceof Error ? err.message : String(err);
    send(socket, { type: 'error', id, name: code, message });
}

export function attachConnection(socket: Socket, deps: ConnectionDeps): void {
    if (preAuthConnections >= PRE_AUTH_MAX_CONNECTIONS) {
        deps.log.warn('pre-auth connection cap reached — closing new connection', { cap: PRE_AUTH_MAX_CONNECTIONS });
        socket.destroy();
        return;
    }
    preAuthConnections++;
    let preAuthSlotHeld = true;
    const releasePreAuthSlot = (): void => {
        if (!preAuthSlotHeld) return;
        preAuthSlotHeld = false;
        preAuthConnections--;
    };

    const decoder = new FrameDecoder(PRE_AUTH_MAX_FRAME_BYTES);
    let authenticated = false;
    let clientId: string | undefined;
    const rerankAborts = new Map<string, AbortController>();

    const helloDeadlineMs = deps.helloDeadlineMs ?? DEFAULT_HELLO_DEADLINE_MS;
    let helloTimer: NodeJS.Timeout | undefined;
    if (helloDeadlineMs > 0) {
        helloTimer = setTimeout(() => {
            if (!authenticated) {
                deps.log.warn('no valid hello within the deadline — closing connection', { deadlineMs: helloDeadlineMs });
                socket.destroy();
            }
        }, helloDeadlineMs);
        helloTimer.unref?.();
    }

    const finishConnection = (): void => {
        if (helloTimer) clearTimeout(helloTimer);
        releasePreAuthSlot();
        if (clientId !== undefined) {
            deps.embedQueue.dropClient(clientId);
            deps.onClientDisconnect(clientId);
        }
        for (const c of rerankAborts.values()) c.abort();
        rerankAborts.clear();
    };

    socket.on('data', (chunk: Buffer) => {
        let events;
        try {
            events = decoder.push(chunk);
        } catch (err) {
            deps.log.error('decoder threw — closing connection', { error: err instanceof Error ? err.message : String(err) });
            socket.destroy();
            return;
        }
        for (const ev of events) {
            if (ev.kind === 'tooLarge') {
                if (!authenticated) {
                    // Before auth the only legitimate frame is a small
                    // `hello`; an oversize/malformed frame here has no
                    // benign explanation, so close rather than keep
                    // servicing an unauthenticated peer.
                    deps.log.warn('oversize/malformed frame before auth — closing connection', { totalLen: ev.totalLen });
                    socket.destroy();
                    return;
                }
                deps.log.warn('oversize/malformed frame — rejected, connection kept open', { totalLen: ev.totalLen });
                sendError(socket, undefined, new ModelServerError('too_large', `frame of ${ev.totalLen} bytes exceeds the server's limit`));
                continue;
            }
            handleFrame(ev.header);
        }
    });

    socket.on('error', () => {
        /* 'close' fires after 'error' — cleanup happens there */
    });
    socket.on('close', finishConnection);

    // SF6: this is the single dispatch point for every frame from an
    // authenticated client. Wrapped in try/catch so a bug anywhere in a
    // synchronous handler (a validator assuming a shape the type guards
    // didn't quite catch, etc.) always turns into a `bad_request` error
    // frame back to the client instead of an uncaught exception that would
    // otherwise crash the whole server process (taking every OTHER
    // client's in-flight work down with it).
    function handleFrame(header: unknown): void {
        try {
            if (!authenticated) {
                handleHello(header);
                return;
            }
            if (isEmbedMessage(header)) {
                handleEmbedMsg(header);
                return;
            }
            if (isRerankMessage(header)) {
                // handleRerankMsg() catches everything internally and never
                // rejects — this .catch() is a last-resort backstop in case
                // something outside its own try/catch (e.g. a throw from
                // sendError itself) still slips through, so a bug there
                // can never become an unhandled rejection either.
                handleRerankMsg(header).catch((err) => {
                    deps.log.error('unexpected: handleRerankMsg rejected outside its own catch', {
                        id: header.id,
                        error: err instanceof Error ? err.message : String(err),
                    });
                });
                return;
            }
            if (isCancelMessage(header)) {
                handleCancelMsg(header);
                return;
            }
            if (isStatusMessage(header)) {
                handleStatusMsg(header);
                return;
            }
            if (isShutdownMessage(header)) {
                handleShutdownMsg(header);
                return;
            }
            const idMaybe = isRecordWithId(header) ? header.id : undefined;
            sendError(socket, idMaybe, new ModelServerError('bad_request', 'unrecognized message type'));
        } catch (err) {
            const idMaybe = isRecordWithId(header) ? header.id : undefined;
            deps.log.warn('frame handling threw synchronously — replying with an error frame', {
                id: idMaybe,
                error: err instanceof Error ? err.message : String(err),
            });
            sendError(socket, idMaybe, err instanceof ModelServerError ? err : new ModelServerError('bad_request', err instanceof Error ? err.message : String(err)));
        }
    }

    function handleHello(header: unknown): void {
        if (!isHelloMessage(header)) {
            send(socket, { type: 'helloErr', reason: 'bad_request' });
            socket.end();
            return;
        }
        if (header.v !== PROTOCOL_VERSION) {
            deps.log.warn('hello: protocol version mismatch — closing', { got: header.v, want: PROTOCOL_VERSION });
            send(socket, { type: 'helloErr', reason: 'bad_version' });
            socket.end();
            return;
        }
        if (!constantTimeEqStr(header.token, deps.token)) {
            deps.log.warn('hello: bad token — closing');
            send(socket, { type: 'helloErr', reason: 'unauthorized' });
            socket.end();
            return;
        }
        authenticated = true;
        if (helloTimer) clearTimeout(helloTimer);
        releasePreAuthSlot();
        decoder.setMaxFrameBytes(MAX_FRAME_BYTES);
        clientId = crypto.randomBytes(8).toString('hex');
        deps.onClientConnect(clientId);
        send(socket, { type: 'helloOk', v: PROTOCOL_VERSION });
    }

    function handleEmbedMsg(req: import('./protocol.js').EmbedMessage): void {
        const tooLarge = validateEmbedLimits(req, deps.textCharLimit);
        if (tooLarge) {
            sendError(socket, req.id, new ModelServerError('too_large', tooLarge));
            return;
        }
        const cid = clientId as string;
        if (deps.embedQueue.depthFor(cid) >= deps.queueMaxPerClient) {
            sendError(socket, req.id, new ModelServerError('busy', 'per-client embed queue is full'));
            return;
        }
        deps.embedQueue.enqueue({
            id: req.id,
            clientId: cid,
            priority: req.op === 'query' ? 'query' : 'batch',
            run: async () => {
                deps.onActivityStart();
                const startedAt = Date.now();
                try {
                    const { header, body } = await handleEmbed(req, deps.log);
                    send(socket, header, body);
                    deps.log.debug('embed ok', { id: req.id, op: req.op, ms: Date.now() - startedAt });
                } catch (err) {
                    deps.log.warn('embed failed', {
                        id: req.id,
                        op: req.op,
                        error: err instanceof Error ? err.message : String(err),
                    });
                    sendError(socket, req.id, err);
                } finally {
                    deps.onActivityEnd();
                }
            },
        });
    }

    async function handleRerankMsg(req: import('./protocol.js').RerankMessage): Promise<void> {
        // SF6: the WHOLE body is inside one try/catch (not just the
        // `await handleRerank()` call) so a synchronous throw from
        // `validateRerankLimits()` — or anywhere else in here — always
        // becomes an error frame, never an unhandled rejection. `started`
        // tracks whether `onActivityStart()` actually ran, so the
        // start/end pair the caller (server.ts) relies on for its idle
        // timer stays balanced on every exit path, including the early
        // `tooLarge` return which — as before — never calls onActivityStart.
        let started = false;
        const controller = new AbortController();
        try {
            const tooLarge = validateRerankLimits(req, deps.textCharLimit);
            if (tooLarge) {
                sendError(socket, req.id, new ModelServerError('too_large', tooLarge));
                return;
            }
            // SF8: registered before the first await so a `cancel` frame
            // processed for this id — even one arriving in the very next
            // synchronous iteration of the frame-dispatch loop — is
            // guaranteed to find this controller and abort it.
            rerankAborts.set(req.id, controller);
            deps.onActivityStart();
            started = true;
            const startedAt = Date.now();
            const { header, body } = await handleRerank(req, controller.signal);
            send(socket, header, body);
            deps.log.debug('rerank ok', { id: req.id, passages: req.passages.length, ms: Date.now() - startedAt });
        } catch (err) {
            deps.log.warn('rerank failed', { id: req.id, error: err instanceof Error ? err.message : String(err) });
            sendError(socket, req.id, err);
        } finally {
            rerankAborts.delete(req.id);
            if (started) deps.onActivityEnd();
        }
    }

    function handleCancelMsg(msg: import('./protocol.js').CancelMessage): void {
        const cid = clientId as string;
        let cancelled = deps.embedQueue.remove(cid, msg.id);
        const controller = rerankAborts.get(msg.id);
        if (controller) {
            controller.abort();
            cancelled = true;
        }
        send(socket, { type: 'cancelAck', id: msg.id, cancelled });
    }

    function handleStatusMsg(msg: import('./protocol.js').StatusMessage): void {
        const s = deps.getStatus();
        send(socket, { type: 'statusResult', id: msg.id, ...s });
    }

    function handleShutdownMsg(msg: import('./protocol.js').ShutdownMessage): void {
        if (!deps.requestShutdown(msg.token)) {
            sendError(socket, msg.id, new ModelServerError('unauthorized', 'bad shutdown token'));
            return;
        }
        send(socket, { type: 'shutdownOk', id: msg.id });
    }
}

function isRecordWithId(v: unknown): v is { id?: string } {
    return typeof v === 'object' && v !== null;
}

function validateEmbedLimits(req: import('./protocol.js').EmbedMessage, charLimit: number): string | undefined {
    if (req.op === 'documentBatch') {
        const texts = req.texts ?? [];
        if (texts.length > MAX_EMBED_TEXTS) return `documentBatch of ${texts.length} texts exceeds the ${MAX_EMBED_TEXTS}-text limit`;
        for (const t of texts) {
            if (t.length > charLimit) return `a text in documentBatch exceeds the ${charLimit}-char limit`;
        }
        return undefined;
    }
    const text = req.text ?? '';
    if (text.length > charLimit) return `text exceeds the ${charLimit}-char limit`;
    return undefined;
}

function validateRerankLimits(req: import('./protocol.js').RerankMessage, charLimit: number): string | undefined {
    if (req.passages.length > MAX_RERANK_PASSAGES) {
        return `rerank of ${req.passages.length} passages exceeds the ${MAX_RERANK_PASSAGES}-passage limit`;
    }
    if (req.query.length > charLimit) return `rerank query exceeds the ${charLimit}-char limit`;
    for (const p of req.passages) {
        if (p.length > charLimit) return `a rerank passage exceeds the ${charLimit}-char limit`;
    }
    return undefined;
}
