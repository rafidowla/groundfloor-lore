/**
 * modelServer/protocol.ts — Lore 3.24 shared model server wire protocol (D9
 * §5.2/§5.3). One unix-domain-socket server per (LORE_HOME, protocol major,
 * transformers version, onnxruntime-node version) serves `embed`/`rerank`
 * inference to every local Lore host process, so the (large) ONNX runtime +
 * model weights are loaded once per machine instead of once per process.
 *
 * Frame format (authoritative — more precise than the design doc's summary):
 *
 *   u32 totalLen   | number of bytes that follow THIS field, i.e.
 *                    4 (headerLen field) + headerLen + body.length
 *   u32 headerLen  | byte length of the JSON header that follows
 *   headerLen bytes| UTF-8 JSON header
 *   body bytes     | binary body (Float32Array vector payloads on results;
 *                    zero-length on every request and most responses)
 *
 * `FrameDecoder` is a streaming decoder: it tolerates partial reads (a
 * frame split across many `data` events) and coalesced reads (several
 * frames delivered in one chunk). An oversized frame (`totalLen` over
 * `MAX_FRAME_BYTES`) is never buffered — bytes are counted and discarded
 * as they arrive — and is reported as a `tooLarge` event rather than an
 * exception, so the caller can reply with a `too_large` error frame and
 * keep the connection open (§5.3: "typed errors, keep connection alive on
 * too_large").
 *
 * This module is transport-agnostic plumbing only. It knows nothing about
 * `LocalEmbeddingProvider`/`LocalRerankProvider` — those are wrapped by
 * `modelServer/handlers.ts`.
 */

export const PROTOCOL_VERSION = 1;

/** Hard frame-size cap. A `totalLen` above this is never buffered. */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024; // 64 MiB

/** Request-shape limits, enforced by the connection layer before a request
 *  is ever handed to a provider. */
export const MAX_EMBED_TEXTS = 1024;
export const MAX_RERANK_PASSAGES = 64;
export const MAX_CLIENTS = 64;

// ─── Typed errors ──────────────────────────────────────────────────────

/**
 * Error kinds the server can report in an `error` frame. `too_large` is the
 * one kind that is guaranteed to never close the connection — every other
 * kind MAY be followed by the server closing (e.g. `unauthorized`,
 * `bad_version` during hello), but doesn't have to be for request-level
 * errors raised after a successful hello.
 */
export type ModelServerErrorName =
    | 'busy'
    | 'timeout'
    | 'model_absent'
    | 'integrity_failed'
    | 'invalid_model'
    | 'too_large'
    | 'bad_request'
    | 'unauthorized'
    | 'bad_version'
    | 'internal';

export class ModelServerError extends Error {
    public readonly code: ModelServerErrorName;
    constructor(code: ModelServerErrorName, message: string) {
        super(message);
        this.name = 'ModelServerError';
        this.code = code;
    }
}

// ─── Message shapes (wire headers) ────────────────────────────────────

export type EmbedOp = 'query' | 'document' | 'documentBatch' | 'splitIntoWindows';

export interface HelloMessage {
    type: 'hello';
    v: number;
    token: string;
    /** Caller-chosen label, logged only — never trusted for auth. */
    clientId?: string;
}

export interface EmbedMessage {
    type: 'embed';
    id: string;
    op: EmbedOp;
    modelId: string;
    dimension?: number;
    dtype?: string;
    device?: string;
    /** `query` / `document` / `splitIntoWindows` use `text`. */
    text?: string;
    /** `documentBatch` uses `texts`. */
    texts?: string[];
    /** `splitIntoWindows` only. */
    windowTokens?: number;
    overlapTokens?: number;
}

export interface RerankMessage {
    type: 'rerank';
    id: string;
    modelId: string;
    dtype?: string;
    cacheDir: string;
    query: string;
    passages: string[];
}

export interface CancelMessage {
    type: 'cancel';
    id: string;
}

export interface StatusMessage {
    type: 'status';
    id: string;
}

export interface ShutdownMessage {
    type: 'shutdown';
    id: string;
    token: string;
}

export type ClientMessage =
    | HelloMessage
    | EmbedMessage
    | RerankMessage
    | CancelMessage
    | StatusMessage
    | ShutdownMessage;

export interface HelloOkMessage {
    type: 'helloOk';
    v: number;
}

export interface HelloErrMessage {
    type: 'helloErr';
    reason: ModelServerErrorName;
}

/** Result of an `embed`/`rerank` call. Vector/score payloads travel in the
 *  frame BODY as a packed `Float32Array` (never in JSON) — `count`/`dim`
 *  describe how to slice it. `splitIntoWindows` has no numeric payload, so
 *  its result carries `windows` directly in the header and an empty body. */
export interface ResultMessage {
    type: 'result';
    id: string;
    op: EmbedOp | 'rerank';
    /** Number of vectors (embed) or scores (rerank) packed in the body. */
    count?: number;
    /** Vector width, for embed results only. */
    dim?: number;
    /** `splitIntoWindows` only — the split text segments. */
    windows?: string[];
}

export interface ErrorMessage {
    type: 'error';
    /** Absent when the error occurred before a request id could be parsed
     *  (e.g. a `tooLarge` frame-decode event). */
    id?: string;
    name: ModelServerErrorName;
    message: string;
}

export interface CancelAckMessage {
    type: 'cancelAck';
    id: string;
    cancelled: boolean;
}

export interface StatusResultMessage {
    type: 'statusResult';
    id: string;
    pid: number;
    uptimeMs: number;
    clients: number;
    queueDepth: number;
    protocolVersion: number;
    idleMs: number;
    /** Server process RSS at the time of the status call. */
    rssBytes: number;
    /** Models this server has served since start, most recent use first. */
    models: ServedModel[];
}

export interface ServedModel {
    kind: 'embed' | 'rerank';
    id: string;
    dtype: string;
    lastUsedAt: number;
}

export interface ShutdownOkMessage {
    type: 'shutdownOk';
    id: string;
}

export type ServerMessage =
    | HelloOkMessage
    | HelloErrMessage
    | ResultMessage
    | ErrorMessage
    | CancelAckMessage
    | StatusResultMessage
    | ShutdownOkMessage;

// ─── Type guards ───────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null;
}
function isStr(v: unknown): v is string {
    return typeof v === 'string';
}
function isNum(v: unknown): v is number {
    return typeof v === 'number' && Number.isFinite(v);
}
/** SF6: every `is*` guard below validates array ELEMENT types too, not just
 *  `Array.isArray()` — a `texts`/`passages` array containing e.g. `null` or
 *  a number used to reach `.length`/string methods deep inside a validator
 *  or provider and throw synchronously from inside a request handler. */
function isStrArray(v: unknown): v is string[] {
    return Array.isArray(v) && v.every(isStr);
}

export function isHelloMessage(h: unknown): h is HelloMessage {
    if (!isRecord(h) || h.type !== 'hello' || typeof h.v !== 'number' || !isStr(h.token)) return false;
    if (h.clientId !== undefined && !isStr(h.clientId)) return false;
    return true;
}
export function isEmbedMessage(h: unknown): h is EmbedMessage {
    if (!isRecord(h) || h.type !== 'embed' || !isStr(h.id) || !isStr(h.modelId)) return false;
    const op = h.op;
    if (op !== 'query' && op !== 'document' && op !== 'documentBatch' && op !== 'splitIntoWindows') return false;
    if (h.dimension !== undefined && !isNum(h.dimension)) return false;
    if (h.dtype !== undefined && !isStr(h.dtype)) return false;
    if (h.device !== undefined && !isStr(h.device)) return false;
    if (h.text !== undefined && !isStr(h.text)) return false;
    if (h.texts !== undefined && !isStrArray(h.texts)) return false;
    if (h.windowTokens !== undefined && !isNum(h.windowTokens)) return false;
    if (h.overlapTokens !== undefined && !isNum(h.overlapTokens)) return false;
    return true;
}
export function isRerankMessage(h: unknown): h is RerankMessage {
    if (
        !isRecord(h) ||
        h.type !== 'rerank' ||
        !isStr(h.id) ||
        !isStr(h.modelId) ||
        !isStr(h.cacheDir) ||
        !isStr(h.query) ||
        !isStrArray(h.passages)
    ) {
        return false;
    }
    if (h.dtype !== undefined && !isStr(h.dtype)) return false;
    return true;
}
export function isCancelMessage(h: unknown): h is CancelMessage {
    return isRecord(h) && h.type === 'cancel' && isStr(h.id);
}
export function isStatusMessage(h: unknown): h is StatusMessage {
    return isRecord(h) && h.type === 'status' && isStr(h.id);
}
export function isShutdownMessage(h: unknown): h is ShutdownMessage {
    return isRecord(h) && h.type === 'shutdown' && isStr(h.id) && isStr(h.token);
}

// ─── Frame codec ───────────────────────────────────────────────────────

/**
 * encodeFrame — pack a JSON header (+ optional binary body) into the wire
 * frame described at the top of this file.
 */
export function encodeFrame(header: Record<string, unknown>, body: Buffer = Buffer.alloc(0)): Buffer {
    const headerBuf = Buffer.from(JSON.stringify(header), 'utf8');
    const headerLen = headerBuf.length;
    const totalLen = 4 + headerLen + body.length;
    const out = Buffer.alloc(4 + totalLen);
    out.writeUInt32BE(totalLen, 0);
    out.writeUInt32BE(headerLen, 4);
    headerBuf.copy(out, 8);
    body.copy(out, 8 + headerLen);
    return out;
}

/** Pack an array of vectors into one contiguous Float32Array body. */
export function encodeVectors(vecs: readonly (readonly number[])[]): Buffer {
    if (vecs.length === 0) return Buffer.alloc(0);
    const dim = vecs[0].length;
    const flat = new Float32Array(vecs.length * dim);
    for (let i = 0; i < vecs.length; i++) {
        flat.set(vecs[i], i * dim);
    }
    return Buffer.from(flat.buffer, flat.byteOffset, flat.byteLength);
}

/** Unpack a contiguous Float32Array body into `count` vectors of `dim`. */
export function decodeVectors(body: Buffer, count: number, dim: number): number[][] {
    const flat = new Float32Array(body.buffer, body.byteOffset, body.byteLength / 4);
    const out: number[][] = [];
    for (let i = 0; i < count; i++) {
        out.push(Array.from(flat.subarray(i * dim, (i + 1) * dim)));
    }
    return out;
}

export type DecodeEvent =
    | { kind: 'frame'; header: unknown; body: Buffer }
    | { kind: 'tooLarge'; totalLen: number };

/**
 * FrameDecoder — streaming decoder over a `net.Socket`'s `data` events.
 * `push()` may return zero, one, or several events for a single chunk
 * (coalesced frames), and a frame that only partially arrived produces no
 * event until the rest shows up in a later `push()` call.
 *
 * An oversize/malformed frame (`totalLen` outside `[4, MAX_FRAME_BYTES]`,
 * or a `headerLen` that doesn't fit inside `totalLen`, or unparsable JSON)
 * is NEVER buffered in full: bytes belonging to it are counted and
 * discarded as they stream in, and a single `tooLarge` event is emitted
 * for it. This bounds decoder memory regardless of what a misbehaving or
 * hostile local client sends, and lets the caller keep the connection
 * open (per the protocol's `too_large` error semantics).
 *
 * Internally this accumulates incoming chunks in a `chunks: Buffer[]` list
 * (tracked alongside a running `chunksLen`) instead of re-concatenating one
 * growing `Buffer` on every `push()` call. The naive "concat the whole
 * backlog on every chunk" approach is O(n²) in the number of chunks a large
 * frame is split across — each `data` event re-copies everything received
 * so far, not just the new bytes — which matters for a frame that legitimately
 * arrives in many small pieces (a slow/chunked write, or a hostile client
 * trickling bytes one at a time). `consume()`/`peek()`/`discard()` below
 * only ever copy the bytes a single frame actually needs, so total copy
 * work across the decoder's lifetime is O(total bytes processed).
 */
export class FrameDecoder {
    private chunks: Buffer[] = [];
    private chunksLen = 0;
    private skipRemaining = 0;
    private maxFrameBytes: number;

    constructor(maxFrameBytes: number = MAX_FRAME_BYTES) {
        this.maxFrameBytes = maxFrameBytes;
    }

    /** Raise (or lower) the accepted frame-size ceiling for frames decoded
     *  from here on. Used by connection.ts to hold an unauthenticated
     *  socket to a much smaller limit than an authenticated one, then widen
     *  it once hello succeeds. Never applied retroactively to bytes already
     *  buffered — only to the next `totalLen` check. */
    setMaxFrameBytes(maxFrameBytes: number): void {
        this.maxFrameBytes = maxFrameBytes;
    }

    push(chunk: Buffer): DecodeEvent[] {
        const events: DecodeEvent[] = [];
        if (chunk.length > 0) {
            this.chunks.push(chunk);
            this.chunksLen += chunk.length;
        }
        for (;;) {
            if (this.skipRemaining > 0) {
                const drop = Math.min(this.skipRemaining, this.chunksLen);
                if (drop > 0) this.discard(drop);
                this.skipRemaining -= drop;
                if (this.skipRemaining > 0) break; // rest not buffered yet — wait for more
                continue;
            }
            if (this.chunksLen < 4) break;
            const totalLen = this.peek(4).readUInt32BE(0);
            if (totalLen < 4 || totalLen > this.maxFrameBytes) {
                const alreadyBuffered = this.chunksLen - 4;
                const remainingToSkip = Math.max(0, totalLen - alreadyBuffered);
                this.discard(this.chunksLen);
                this.skipRemaining = remainingToSkip;
                events.push({ kind: 'tooLarge', totalLen });
                continue;
            }
            if (this.chunksLen < 4 + totalLen) break; // wait for the rest
            const frame = this.consume(4 + totalLen);
            const headerLen = frame.readUInt32BE(4);
            if (headerLen < 0 || headerLen > totalLen - 4) {
                events.push({ kind: 'tooLarge', totalLen });
                continue;
            }
            const headerBuf = frame.subarray(8, 8 + headerLen);
            // Copy (not subarray) the body into its own fresh, aligned
            // allocation: `frame` starts aligned (see `consume()`), but a
            // subarray offset by `8 + headerLen` is only aligned when
            // `headerLen` happens to be a multiple of 4 — `headerLen` is an
            // arbitrary JSON byte length, so in general it isn't.
            // `decodeVectors()` builds a `Float32Array` view directly over
            // a frame's body (`body.buffer`/`body.byteOffset`, no copy),
            // which throws `RangeError: start offset ... should be a
            // multiple of 4` on a misaligned subarray — matches the
            // pre-existing `Buffer.from(this.buf.subarray(...))` copy this
            // decoder always did before this rewrite.
            const bodyBuf = Buffer.from(frame.subarray(8 + headerLen, 4 + totalLen));
            let header: unknown;
            try {
                header = JSON.parse(headerBuf.toString('utf8'));
            } catch {
                events.push({ kind: 'tooLarge', totalLen });
                continue;
            }
            events.push({ kind: 'frame', header, body: bodyBuf });
        }
        return events;
    }

    /** Return the first `n` buffered bytes without consuming them. Caller
     *  must already know `chunksLen >= n` (only ever called with `n === 4`,
     *  to read the `totalLen` prefix). */
    private peek(n: number): Buffer {
        if (this.chunks.length > 0 && this.chunks[0].length >= n) return this.chunks[0].subarray(0, n);
        const out = Buffer.allocUnsafe(n);
        let offset = 0;
        for (const c of this.chunks) {
            if (offset >= n) break;
            const take = Math.min(c.length, n - offset);
            c.copy(out, offset, 0, take);
            offset += take;
        }
        return out;
    }

    /** Remove and return exactly `n` buffered bytes from the front. Caller
     *  must already know `chunksLen >= n`.
     *
     *  Deliberately does NOT fast-path "one already-received chunk IS the
     *  whole frame" by returning that chunk directly: a chunk handed to us
     *  by `net.Socket`'s `data` event is a view into Node's internal read
     *  buffer at whatever byte offset the socket happened to land on, which
     *  is not guaranteed 4-byte aligned. `decodeVectors()` later builds a
     *  `Float32Array` view directly over a consumed frame's body bytes
     *  (`body.buffer`/`body.byteOffset`, no copy) — a misaligned byteOffset
     *  throws `RangeError: start offset ... should be a multiple of 4`.
     *  Always copying into a fresh `Buffer.allocUnsafe(n)` here (as the
     *  pre-existing `Buffer.concat`-based implementation always did)
     *  guarantees every consumed frame starts at a fresh, aligned
     *  allocation. This still only copies each byte once per frame
     *  (`O(total bytes)` overall), which is the property that actually
     *  fixes the quadratic-concat issue — the fast path saved a copy, not
     *  algorithmic complexity, and cost correctness to do it. */
    private consume(n: number): Buffer {
        if (n === 0) return Buffer.alloc(0);
        const out = Buffer.allocUnsafe(n);
        let offset = 0;
        while (offset < n) {
            const head = this.chunks[0];
            const need = n - offset;
            if (head.length <= need) {
                head.copy(out, offset);
                offset += head.length;
                this.chunks.shift();
            } else {
                head.copy(out, offset, 0, need);
                this.chunks[0] = head.subarray(need);
                offset += need;
            }
        }
        this.chunksLen -= n;
        return out;
    }

    /** Drop exactly `n` buffered bytes from the front without materializing
     *  them (the oversize-frame skip path). Caller must already know
     *  `chunksLen >= n`. */
    private discard(n: number): void {
        let remaining = n;
        while (remaining > 0) {
            const head = this.chunks[0];
            if (head.length <= remaining) {
                remaining -= head.length;
                this.chunksLen -= head.length;
                this.chunks.shift();
            } else {
                this.chunks[0] = head.subarray(remaining);
                this.chunksLen -= remaining;
                remaining = 0;
            }
        }
    }
}

/** Constant-time string equality (mirrors security/authToken.ts's
 *  constantTimeEqStr) — used for hello-frame and shutdown-frame token
 *  checks so a timing side-channel can't shorten a brute-force search. */
export function constantTimeEqStr(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}
