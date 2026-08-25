/**
 * webhookReceiver.ts — Lore-side webhook receiver (V3.0 Phase A3).
 *
 * Lets external sources push change notifications into Lore without
 * the daemon having to poll. The HTTP server (mcp/server.ts) wires a
 * route to `WebhookReceiver.receive(...)`; this module is transport-
 * agnostic — pass it the source name, body, and headers; it does the
 * rest.
 *
 * Per-source registration:
 *
 *   register(source, { secret, handler })
 *     - secret is shared with the source's outbound webhook
 *       configuration; never returned via the API
 *     - handler is a callback invoked with the parsed payload after
 *       signature + idempotency checks pass
 *
 * Inbound request handling:
 *
 *   1. Look up the registered source. Unknown source → 404.
 *   2. Verify HMAC signature header (constant-time compare).
 *      Missing or wrong signature → 401.
 *   3. Idempotency: skip duplicate delivery ids (24h TTL).
 *   4. Invoke the registered handler.
 *   5. Emit a WebhookAuditEvent (received, accepted, duplicate, rejected).
 *
 * Idempotency store is in-memory; works for a single-process daemon.
 * For multi-replica deployments callers wire in a shared store via
 * the optional `idempotencyStore` constructor argument.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
// F-S08 — durable idempotency. better-sqlite3 mirrors how other durable
// stores in this repo persist (see outbox/auxStore.ts). Imported as a type
// + lazily required so the in-memory fallback has zero hard dependency.
import type { Database as DatabaseType } from 'better-sqlite3';

export interface WebhookSourceRegistration {
    /** Shared HMAC secret. */
    secret: string;
    /** Algorithm — only SHA-256 supported in v1. */
    algorithm?: 'sha256';
    /** Custom signature header name (default: 'x-lore-signature'). */
    signatureHeader?: string;
    /** Custom delivery-id header name (default: 'x-lore-delivery'). */
    deliveryIdHeader?: string;
    /**
     * Handler invoked with the parsed payload. Throws → audit emits
     * 'rejected' with the error message; the receiver returns 500.
     */
    handler: (payload: unknown, ctx: { source: string; deliveryId: string }) => Promise<void>;
}

export type WebhookAuditEvent =
    | { kind: 'received'; source: string; deliveryId: string; at: string }
    | { kind: 'accepted'; source: string; deliveryId: string; at: string; durationMs: number }
    | { kind: 'duplicate'; source: string; deliveryId: string; at: string }
    | { kind: 'rejected'; source: string; reason: 'unknown-source' | 'bad-signature' | 'handler-error' | 'malformed'; detail?: string; at: string };

export type WebhookAuditListener = (event: WebhookAuditEvent) => void;

export interface IdempotencyStore {
    has(key: string): boolean;
    add(key: string): void;
    /** Periodic prune of older-than-TTL keys. */
    prune(now: number): void;
}

export interface ReceiveResult {
    status: 200 | 202 | 400 | 401 | 404 | 500;
    body: { ok: boolean; reason?: string; deliveryId?: string };
}

/** In-memory store with TTL pruning. Adequate for single-process daemons. */
class InMemoryIdempotencyStore implements IdempotencyStore {
    private byKey = new Map<string, number>();
    constructor(private readonly ttlMs: number = 24 * 60 * 60 * 1000) { }
    has(key: string): boolean {
        const at = this.byKey.get(key);
        if (at === undefined) return false;
        if (Date.now() - at > this.ttlMs) {
            this.byKey.delete(key);
            return false;
        }
        return true;
    }
    add(key: string): void { this.byKey.set(key, Date.now()); }
    prune(now: number): void {
        for (const [k, at] of this.byKey) {
            if (now - at > this.ttlMs) this.byKey.delete(k);
        }
    }
}

/**
 * F-S08 — durable idempotency store backed by SQLite (better-sqlite3,
 * synchronous API, same dep + pattern as outbox/auxStore.ts).
 *
 * The in-memory store loses every processed delivery id on restart, so a
 * daemon restart (or a second replica) replays already-handled webhook
 * deliveries — a side-effecting handler runs twice. Persisting the keys to
 * a SQLite table keyed by the idempotency key survives restarts and is
 * shareable across replicas pointed at the same file.
 *
 * Schema is created on first open (idempotent). TTL pruning deletes rows
 * older than the window, mirroring the in-memory store's lazy + periodic
 * prune semantics. Construct via `WebhookReceiver` by passing
 * `idempotencyDbPath`; if no path is given the in-memory fallback is used
 * (preserves single-process / local-mode behavior unchanged).
 */
class SqliteIdempotencyStore implements IdempotencyStore {
    private readonly db: DatabaseType;
    private readonly hasStmt: ReturnType<DatabaseType['prepare']>;
    private readonly addStmt: ReturnType<DatabaseType['prepare']>;
    private readonly pruneStmt: ReturnType<DatabaseType['prepare']>;

    constructor(dbPath: string, private readonly ttlMs: number = 24 * 60 * 60 * 1000) {
        // Lazy require — keeps the in-memory fallback dependency-free and
        // avoids loading the native addon when it isn't needed.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const Database = require('better-sqlite3') as typeof import('better-sqlite3');
        this.db = new Database(dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.exec(`
CREATE TABLE IF NOT EXISTS webhook_idempotency (
  key       TEXT PRIMARY KEY,
  seen_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_webhook_idempotency_seen ON webhook_idempotency(seen_at);
`);
        this.hasStmt = this.db.prepare('SELECT seen_at FROM webhook_idempotency WHERE key = ?');
        this.addStmt = this.db.prepare(
            'INSERT OR REPLACE INTO webhook_idempotency (key, seen_at) VALUES (?, ?)',
        );
        this.pruneStmt = this.db.prepare('DELETE FROM webhook_idempotency WHERE seen_at < ?');
    }

    has(key: string): boolean {
        const row = this.hasStmt.get(key) as { seen_at: number } | undefined;
        if (row === undefined) return false;
        if (Date.now() - row.seen_at > this.ttlMs) {
            // Lazy expiry — matches InMemoryIdempotencyStore.has().
            this.db.prepare('DELETE FROM webhook_idempotency WHERE key = ?').run(key);
            return false;
        }
        return true;
    }

    add(key: string): void {
        // Array form = positional binds for (?, ?); satisfies the narrow
        // DatabaseType.run(1-arg) typing while better-sqlite3 binds both.
        this.addStmt.run([key, Date.now()]);
    }

    prune(now: number): void {
        this.pruneStmt.run(now - this.ttlMs);
    }
}

export class WebhookReceiver {
    private readonly sources = new Map<string, Required<WebhookSourceRegistration>>();
    private readonly listeners = new Set<WebhookAuditListener>();
    private readonly idempotency: IdempotencyStore;

    constructor(opts: {
        idempotencyStore?: IdempotencyStore;
        idempotencyTtlMs?: number;
        /**
         * F-S08 — when provided, idempotency keys are persisted to this
         * SQLite file so a restart / second replica does NOT reprocess an
         * already-handled delivery. Ignored if an explicit
         * `idempotencyStore` is supplied. Omit it (local/single-process)
         * to keep the in-memory fallback.
         */
        idempotencyDbPath?: string;
    } = {}) {
        this.idempotency =
            opts.idempotencyStore ??
            (opts.idempotencyDbPath
                ? new SqliteIdempotencyStore(opts.idempotencyDbPath, opts.idempotencyTtlMs)
                : new InMemoryIdempotencyStore(opts.idempotencyTtlMs));
    }

    register(source: string, reg: WebhookSourceRegistration): void {
        if (!source) throw new Error('webhook source required');
        if (!reg.secret) throw new Error(`webhook '${source}': secret required`);
        if (this.sources.has(source)) {
            throw new Error(`webhook '${source}' already registered`);
        }
        this.sources.set(source, {
            secret: reg.secret,
            algorithm: reg.algorithm ?? 'sha256',
            signatureHeader: (reg.signatureHeader ?? 'x-lore-signature').toLowerCase(),
            deliveryIdHeader: (reg.deliveryIdHeader ?? 'x-lore-delivery').toLowerCase(),
            handler: reg.handler,
        });
    }

    unregister(source: string): boolean {
        return this.sources.delete(source);
    }

    listSources(): string[] {
        return Array.from(this.sources.keys());
    }

    addAuditListener(listener: WebhookAuditListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /**
     * Process an inbound request. `headers` keys must be lower-cased.
     * `rawBody` is the request body as a string (we sign over the raw
     * bytes; never re-stringify the parsed JSON).
     */
    async receive(input: {
        source: string;
        rawBody: string;
        headers: Record<string, string>;
    }): Promise<ReceiveResult> {
        const reg = this.sources.get(input.source);
        const at = new Date().toISOString();
        if (!reg) {
            this.emit({ kind: 'rejected', source: input.source, reason: 'unknown-source', at });
            return { status: 404, body: { ok: false, reason: 'unknown-source' } };
        }

        const signature = input.headers[reg.signatureHeader];
        const deliveryId = input.headers[reg.deliveryIdHeader] ?? '';

        if (!signature || !verifyHmac(reg.secret, input.rawBody, signature)) {
            this.emit({ kind: 'rejected', source: input.source, reason: 'bad-signature', at });
            return { status: 401, body: { ok: false, reason: 'bad-signature' } };
        }

        if (!deliveryId) {
            this.emit({ kind: 'rejected', source: input.source, reason: 'malformed', detail: 'delivery-id missing', at });
            return { status: 400, body: { ok: false, reason: 'delivery-id required' } };
        }

        let payload: unknown;
        try {
            payload = JSON.parse(input.rawBody);
        } catch {
            this.emit({ kind: 'rejected', source: input.source, reason: 'malformed', detail: 'invalid JSON', at });
            return { status: 400, body: { ok: false, reason: 'invalid JSON' } };
        }

        const idempotencyKey = `${input.source}:${deliveryId}`;
        if (this.idempotency.has(idempotencyKey)) {
            this.emit({ kind: 'duplicate', source: input.source, deliveryId, at });
            return { status: 200, body: { ok: true, reason: 'duplicate', deliveryId } };
        }

        this.emit({ kind: 'received', source: input.source, deliveryId, at });

        const start = Date.now();
        try {
            await reg.handler(payload, { source: input.source, deliveryId });
        } catch (err) {
            this.emit({
                kind: 'rejected',
                source: input.source,
                reason: 'handler-error',
                detail: (err as Error).message,
                at: new Date().toISOString(),
            });
            return { status: 500, body: { ok: false, reason: 'handler-error', deliveryId } };
        }

        // Mark accepted only after successful handling.
        this.idempotency.add(idempotencyKey);
        this.emit({
            kind: 'accepted',
            source: input.source,
            deliveryId,
            at: new Date().toISOString(),
            durationMs: Date.now() - start,
        });
        return { status: 202, body: { ok: true, deliveryId } };
    }

    /** Periodic call site (e.g., daemon's quotaManager) to prune the in-memory store. */
    pruneIdempotency(): void {
        this.idempotency.prune(Date.now());
    }

    private emit(event: WebhookAuditEvent): void {
        if (this.listeners.size === 0) return;
        for (const l of this.listeners) {
            try { l(event); } catch { /* listener errors must not break receive */ }
        }
    }
}

/* ---------- helpers ---------- */

/**
 * Generate the canonical webhook signature for testing or for outbound
 * relay through Lore Cloud.
 */
export function signWebhook(secret: string, rawBody: string): string {
    return 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
}

function verifyHmac(secret: string, rawBody: string, candidate: string): boolean {
    const expected = signWebhook(secret, rawBody);
    if (expected.length !== candidate.length) return false;
    try {
        return timingSafeEqual(Buffer.from(expected), Buffer.from(candidate));
    } catch {
        return false;
    }
}
