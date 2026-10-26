/**
 * ingestion/groundfloorBlobStore.ts — IBlobStore backed by the Groundfloor workspace Files API, so several Lore nodes
 * (or a node and its replacements) share one place for ingestion source files.
 *
 * CONTRACT (derived from the reference client, `@groundfloorcloud/cli` 0.2.5 `gf files`; the SDK vendored here is
 * types-only and covers only the Dataplane S3 storage surface, not this one). All control-plane calls are
 * `Authorization: Bearer <token>` against an operator-configured base URL:
 *
 *   put     POST   {base}/v1/workspaces/{ws}/files/upload-url   {name, content_type, size_bytes}
 *                    -> {upload_url, file: {id}}
 *           PUT    {upload_url}                                  raw bytes, Content-Type (presigned: NO bearer)
 *           POST   {base}/v1/workspaces/{ws}/files/{id}/finalize {}
 *   get     GET    {base}/v1/workspaces/{ws}/files/{id}/download-url -> {download_url}
 *           GET    {download_url}                                (presigned: NO bearer)
 *   delete  DELETE {base}/v1/workspaces/{ws}/files/{id}
 *
 * Not pinned down (ask the platform team before production use): a server-side size limit (the CLI enforces none),
 * the lifetime of the token an operator supplies, and whether `finalize` can reject an upload.
 *
 * Security:
 *  - The base URL and workspace id come from operator config only; nothing from a request or a file reaches them.
 *  - The presigned URLs come from the server's response, so they are untrusted: https only (http only when the base
 *    URL itself is loopback), no credentials in the URL, no redirects followed, and IP-literal private/loopback/link-local
 *    hosts refused unless the base URL is loopback. A hostname that RESOLVES to a private address is not caught here.
 *  - The bearer token is never sent to a presigned URL and is never logged. Errors carry the operation and HTTP status
 *    only: no URL (presigned URLs hold signatures), no response body, no token.
 *  - A ref is `gf1:<fileId>:<sha256>`; the sha is re-verified on every read so a swapped or corrupted object is refused.
 */
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { BlobNotFoundError, sha256Hex, type IBlobStore } from './blobStore.js';

export class GroundfloorBlobError extends Error {
    constructor(message: string, readonly status?: number, readonly retryable = false) { super(message); this.name = 'GroundfloorBlobError'; }
}

export interface GroundfloorBlobStoreOptions {
    /** Control-plane base URL, e.g. `https://platform.groundfloor.cloud`. Operator config only. */
    baseUrl: string;
    /** The Groundfloor workspace that owns the files (path segment of /v1/workspaces/{id}/files). */
    filesWorkspaceId: string;
    /** Returns the bearer token. Called per request so a rotated token (file or provider) is picked up. Never logged. */
    token: () => string | Promise<string>;
    /**
     * Called once when the Files API answers 401, with the token that was rejected. A provider that can mint a new one
     * (m2m login) does so; the call is then retried once with `token()`. Never called for presigned transfers.
     */
    onUnauthorized?: (rejectedToken: string) => Promise<void> | void;
    /** Per control-plane request. Default 30 s. */
    timeoutMs?: number;
    /** Per presigned upload/download, body included. Default 5 min. */
    transferTimeoutMs?: number;
    /** Retries after the first attempt on network errors, 5xx and 429. Default 3. */
    maxRetries?: number;
    /** First backoff step (doubles per retry, capped at 10 s; Retry-After wins up to that cap). Default 250 ms. */
    retryBaseMs?: number;
    /** Largest blob accepted in either direction. Default 512 MiB. */
    maxBytes?: number;
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
}

const REF = /^gf1:([A-Za-z0-9_-]{1,128}):([0-9a-f]{64})$/;
const FILE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const WS_ID = /^[A-Za-z0-9_.-]{1,128}$/;
const MAX_BACKOFF_MS = 10_000;
export const DEFAULT_GF_MAX_BYTES = 512 * 1024 * 1024;

function isLoopbackHostname(h: string): boolean {
    const x = h.replace(/^\[|\]$/g, '').toLowerCase();
    return x === 'localhost' || x.endsWith('.localhost') || x === '::1' || /^127\./.test(x);
}

/** IP literals a presigned URL must not point at (loopback, private, link-local incl. cloud metadata, unspecified). */
function isPrivateIpLiteral(h: string): boolean {
    const x = h.replace(/^\[|\]$/g, '').toLowerCase();
    const kind = isIP(x);
    if (kind === 4) {
        const [a, b] = x.split('.').map(Number) as [number, number];
        return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
    }
    if (kind === 6) return x === '::1' || x === '::' || x.startsWith('fe80') || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('::ffff:');
    return false;
}

/** Validate operator config. Throws a plain Error (no secrets in the message). */
export function parseGroundfloorBaseUrl(raw: string): URL {
    let u: URL;
    try { u = new URL(raw); } catch { throw new Error('groundfloor blob store: base URL is not a valid URL'); }
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopbackHostname(u.hostname))) {
        throw new Error('groundfloor blob store: base URL must be https (http only for loopback)');
    }
    if (u.username || u.password) throw new Error('groundfloor blob store: base URL must not contain credentials');
    return u;
}

export class GroundfloorBlobStore implements IBlobStore {
    private readonly base: string;
    private readonly baseLoopback: boolean;
    private readonly wsPath: string;
    private readonly timeoutMs: number;
    private readonly transferTimeoutMs: number;
    private readonly maxRetries: number;
    private readonly retryBaseMs: number;
    private readonly maxBytes: number;
    private readonly fetchImpl: typeof fetch;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly token: () => string | Promise<string>;
    private readonly onUnauthorized: ((rejected: string) => Promise<void> | void) | undefined;

    constructor(o: GroundfloorBlobStoreOptions) {
        const u = parseGroundfloorBaseUrl(o.baseUrl);
        if (!WS_ID.test(o.filesWorkspaceId)) throw new Error('groundfloor blob store: files workspace id is missing or malformed');
        this.base = u.origin + u.pathname.replace(/\/+$/, '');
        this.baseLoopback = isLoopbackHostname(u.hostname);
        this.wsPath = `/v1/workspaces/${encodeURIComponent(o.filesWorkspaceId)}`;
        this.token = o.token;
        this.onUnauthorized = o.onUnauthorized;
        this.timeoutMs = o.timeoutMs ?? 30_000;
        this.transferTimeoutMs = o.transferTimeoutMs ?? 300_000;
        this.maxRetries = o.maxRetries ?? 3;
        this.retryBaseMs = o.retryBaseMs ?? 250;
        this.maxBytes = o.maxBytes ?? DEFAULT_GF_MAX_BYTES;
        this.fetchImpl = o.fetchImpl ?? fetch;
        this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    }

    async put(workspace: string, sha256: string, bytes: Buffer): Promise<string> {
        if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('bad sha256');
        if (sha256Hex(bytes) !== sha256) throw new Error('blob bytes do not match the given sha256');
        if (bytes.length > this.maxBytes) throw new GroundfloorBlobError(`upload refused: ${bytes.length} bytes exceeds the configured limit of ${this.maxBytes}`);
        const wsDir = createHash('sha256').update(workspace).digest('hex').slice(0, 16);
        const init = await this.control('upload-init', 'POST', '/files/upload-url', {
            name: `lore-ingest-${wsDir}-${sha256}`, content_type: 'application/octet-stream', size_bytes: bytes.length,
        });
        const id = pickFileId((init as { file?: { id?: unknown } } | null)?.file?.id);
        try {
            const uploadUrl = this.presigned((init as { upload_url?: unknown } | null)?.upload_url, 'upload-url');
            await this.transfer('upload', uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes });
            await this.control('finalize', 'POST', `/files/${encodeURIComponent(id)}/finalize`, {});
        } catch (e) {
            // Do not leave a half-made file behind. Best effort: the original error is what matters.
            await this.control('cleanup', 'DELETE', `/files/${encodeURIComponent(id)}`).catch(() => undefined);
            throw e;
        }
        return `gf1:${id}:${sha256}`;
    }

    async get(ref: string): Promise<Buffer> {
        const { id, sha } = parseRef(ref);
        const dl = await this.control('download-url', 'GET', `/files/${encodeURIComponent(id)}/download-url`);
        const url = this.presigned((dl as { download_url?: unknown } | null)?.download_url, 'download-url');
        const buf = await this.transfer('download', url, { method: 'GET' });
        if (sha256Hex(buf) !== sha) throw new GroundfloorBlobError('download rejected: content does not match the expected sha256');
        return buf;
    }

    async has(ref: string): Promise<boolean> {
        const { id } = parseRef(ref);
        try { await this.control('download-url', 'GET', `/files/${encodeURIComponent(id)}/download-url`); return true; }
        catch (e) { if (e instanceof BlobNotFoundError) return false; throw e; }
    }

    async delete(ref: string): Promise<boolean> {
        const { id } = parseRef(ref);
        try { await this.control('delete', 'DELETE', `/files/${encodeURIComponent(id)}`); return true; }
        catch (e) { if (e instanceof BlobNotFoundError) return false; throw e; }
    }

    // ---- internals ----------------------------------------------------------------------------------------------

    /** A server-supplied presigned URL is untrusted input: see the header. */
    private presigned(raw: unknown, what: string): string {
        if (typeof raw !== 'string' || raw === '') throw new GroundfloorBlobError(`${what}: response had no URL`);
        let u: URL;
        try { u = new URL(raw); } catch { throw new GroundfloorBlobError(`${what}: response URL is not valid`); }
        if (u.username || u.password) throw new GroundfloorBlobError(`${what}: response URL carries credentials`);
        if (u.protocol !== 'https:' && !(u.protocol === 'http:' && this.baseLoopback)) throw new GroundfloorBlobError(`${what}: response URL is not https`);
        if (!this.baseLoopback && (isPrivateIpLiteral(u.hostname) || isLoopbackHostname(u.hostname))) throw new GroundfloorBlobError(`${what}: response URL points at a private address`);
        return u.toString();
    }

    private async backoff(attempt: number, retryAfter: string | null): Promise<void> {
        const ra = retryAfter ? Number(retryAfter) : NaN;
        const wait = Number.isFinite(ra) && ra >= 0 ? ra * 1000 : this.retryBaseMs * 2 ** attempt;
        await this.sleep(Math.min(MAX_BACKOFF_MS, wait));
    }

    /** One control-plane call (bearer auth), JSON in/out, retrying 5xx/429/network failures. 404 (and 409 on download-url) => BlobNotFoundError. */
    private async control(op: string, method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<unknown> {
        let authRetried = false;
        for (let attempt = 0; ; attempt++) {
            let res: Response;
            let used = '';
            try {
                used = await this.token();
                res = await this.fetchImpl(`${this.base}${this.wsPath}${path}`, {
                    method, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
                    headers: { Authorization: `Bearer ${used}`, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
                    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
                });
            } catch (e) {
                // GroundfloorTokenError messages are written by us and carry a status or class name only.
                if (isTokenError(e)) throw new GroundfloorBlobError(`${op} failed (${(e as Error).message})`, undefined, tokenRetryable(e));
                if (attempt < this.maxRetries) { await this.backoff(attempt, null); continue; }
                throw new GroundfloorBlobError(`${op} failed (${errName(e)})`, undefined, true);
            }
            if (res.ok) {
                if (method === 'DELETE' || res.status === 204) { await res.body?.cancel().catch(() => undefined); return null; }
                try { return await res.json(); } catch { throw new GroundfloorBlobError(`${op}: response was not JSON`, res.status); }
            }
            const retryAfter = res.headers.get('retry-after');
            await res.body?.cancel().catch(() => undefined);
            // A rejected token (expired between mint and use, or revoked): ask the provider for a new one, once per call.
            if (res.status === 401 && this.onUnauthorized && !authRetried) {
                authRetried = true;
                try { await this.onUnauthorized(used); } catch (e) {
                    if (isTokenError(e)) throw new GroundfloorBlobError(`${op} failed (${(e as Error).message})`, 401, tokenRetryable(e));
                    throw new GroundfloorBlobError(`${op} failed with HTTP 401`, 401);
                }
                attempt--; continue;
            }
            if (res.status === 404) throw new BlobNotFoundError(`${op}: file not found`);
            // The Files API soft-deletes: asking for a download URL of a deleted (or otherwise not active) file answers 409.
            if (res.status === 409 && op === 'download-url') throw new BlobNotFoundError(`${op}: file is not active`);
            const retryable = res.status >= 500 || res.status === 429;
            if (retryable && attempt < this.maxRetries) { await this.backoff(attempt, retryAfter); continue; }
            throw new GroundfloorBlobError(`${op} failed with HTTP ${res.status}`, res.status, retryable);
        }
    }

    /** Presigned transfer: no bearer, no redirects, hashed/size-capped while streaming, retried like control calls. */
    private async transfer(op: 'upload' | 'download', url: string, init: { method: 'PUT' | 'GET'; headers?: Record<string, string>; body?: Buffer }): Promise<Buffer> {
        for (let attempt = 0; ; attempt++) {
            let res: Response;
            try {
                const req: RequestInit = { method: init.method, redirect: 'error', signal: AbortSignal.timeout(this.transferTimeoutMs) };
                if (init.headers) req.headers = init.headers;
                if (init.body) req.body = new Uint8Array(init.body);
                res = await this.fetchImpl(url, req);
            } catch (e) {
                if (attempt < this.maxRetries) { await this.backoff(attempt, null); continue; }
                throw new GroundfloorBlobError(`${op} transfer failed (${errName(e)})`, undefined, true);
            }
            if (!res.ok) {
                const retryAfter = res.headers.get('retry-after');
                await res.body?.cancel().catch(() => undefined);
                if (res.status === 404 && op === 'download') throw new BlobNotFoundError('download: object not found');
                const retryable = res.status >= 500 || res.status === 429;
                if (retryable && attempt < this.maxRetries) { await this.backoff(attempt, retryAfter); continue; }
                throw new GroundfloorBlobError(`${op} transfer failed with HTTP ${res.status}`, res.status, retryable);
            }
            if (op === 'upload') { await res.body?.cancel().catch(() => undefined); return Buffer.alloc(0); }
            try { return await this.readCapped(res); }
            catch (e) {
                if (e instanceof GroundfloorBlobError && !e.retryable) throw e;
                if (attempt < this.maxRetries) { await this.backoff(attempt, null); continue; }
                throw new GroundfloorBlobError(`download body failed (${errName(e)})`, undefined, true);
            }
        }
    }

    /** Read the body chunk by chunk, refusing to buffer past the configured cap. */
    private async readCapped(res: Response): Promise<Buffer> {
        const declared = Number(res.headers.get('content-length'));
        if (Number.isFinite(declared) && declared > this.maxBytes) { await res.body?.cancel().catch(() => undefined); throw new GroundfloorBlobError(`download refused: ${declared} bytes exceeds the configured limit`); }
        if (!res.body) return Buffer.alloc(0);
        const chunks: Buffer[] = []; let total = 0;
        const reader = res.body.getReader();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > this.maxBytes) { await reader.cancel().catch(() => undefined); throw new GroundfloorBlobError('download refused: body exceeds the configured limit'); }
            chunks.push(Buffer.from(value));
        }
        return Buffer.concat(chunks, total);
    }
}

function pickFileId(v: unknown): string {
    if (typeof v !== 'string' || !FILE_ID.test(v)) throw new GroundfloorBlobError('upload-init: response had no usable file id');
    return v;
}

function parseRef(ref: string): { id: string; sha: string } {
    const m = REF.exec(ref);
    if (!m) throw new Error('blob ref is not a groundfloor blob reference');
    return { id: m[1]!, sha: m[2]! };
}

function errName(e: unknown): string { return e instanceof Error ? e.name : typeof e; }
/** A token provider that throws is a configuration fault: retrying it is pointless and its message may be sensitive. */
function isTokenError(e: unknown): boolean { return e instanceof Error && e.name === 'GroundfloorTokenError'; }

/** Same answer on every path (token() and the 401 path): whatever the token error says, defaulting to retryable. */
function tokenRetryable(e: unknown): boolean { return (e as { retryable?: unknown }).retryable !== false; }

export class GroundfloorTokenError extends Error {
    /** `detail` must be safe to log: an HTTP status or error class, never a token, secret, URL or response body. */
    constructor(detail?: string, readonly retryable = true) { super(detail ? `could not get the groundfloor files token: ${detail}` : 'could not read the groundfloor files token'); this.name = 'GroundfloorTokenError'; }
}
