/**
 * ingestion/callbackAuth.ts — authentication of processor callbacks.
 *
 * Three schemes, chosen per processor (never negotiated from the request):
 *
 *   lore-hmac          Lore-native. Per-job key = HMAC(master, jobId). Signature
 *                      covers `${jobId}.${timestamp}.${rawBody}`; headers
 *                      `x-lore-timestamp`, `x-lore-signature: v1=<hex>`.
 *   standard-webhooks  What ai-api sends today: `webhook-id`, `webhook-timestamp`,
 *                      `webhook-signature: v1,<base64>` over `${id}.${ts}.${body}`
 *                      with a shared secret (optionally `whsec_` + base64).
 *                      Job binding comes from the URL path jobId and the body's
 *                      requestID (checked by the handler), since the key is shared.
 *   bearer             `Authorization: Bearer <token>` where token is a per-job
 *                      derived value handed to the processor in the request.
 *
 * All comparisons are constant-time. Timestamps must be within the replay
 * window (past AND future). Duplicate deliveries are rejected/deduplicated by
 * the caller via IIngestionStore.recordDelivery.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export type CallbackScheme = 'lore-hmac' | 'standard-webhooks' | 'bearer';

export interface CallbackAuthConfig {
    /** >= 32 bytes. Per-job keys and bearer tokens derive from it. */
    masterSecret: Buffer;
    /** Shared secret for the standard-webhooks scheme. Raw string or `whsec_<base64>`. */
    webhookSecret?: string;
    /** Allowed clock skew either side, seconds. */
    replayWindowSec: number;
}

export const DEFAULT_REPLAY_WINDOW_SEC = 300;

export type VerifyResult =
    | { ok: true; deliveryId: string }
    | { ok: false; reason: 'missing_headers' | 'bad_timestamp' | 'outside_replay_window' | 'bad_signature' | 'scheme_unconfigured' };

export function assertConfig(c: CallbackAuthConfig): void {
    if (!Buffer.isBuffer(c.masterSecret) || c.masterSecret.length < 32) throw new Error('callback masterSecret must be at least 32 bytes');
}

export function deriveJobKey(master: Buffer, jobId: string): Buffer {
    return createHmac('sha256', master).update('lore-ingest-callback-v1\0' + jobId).digest();
}

/** Bearer token handed to the processor for this job. */
export function jobBearerToken(master: Buffer, jobId: string): string {
    return createHmac('sha256', master).update('lore-ingest-bearer-v1\0' + jobId).digest('base64url');
}

export function signLoreHmac(master: Buffer, jobId: string, timestampSec: number, rawBody: Buffer): string {
    const mac = createHmac('sha256', deriveJobKey(master, jobId)).update(`${jobId}.${timestampSec}.`).update(rawBody).digest('hex');
    return 'v1=' + mac;
}

function webhookKey(secret: string): Buffer {
    return secret.startsWith('whsec_') ? Buffer.from(secret.slice(6), 'base64') : Buffer.from(secret, 'utf8');
}

export function signStandardWebhook(secret: string, id: string, timestampSec: number, rawBody: Buffer): string {
    return 'v1,' + createHmac('sha256', webhookKey(secret)).update(`${id}.${timestampSec}.`).update(rawBody).digest('base64');
}

/** Constant-time string equality (length leak only, which is not secret here). */
export function safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a, 'utf8'); const bb = Buffer.from(b, 'utf8');
    if (ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
}

function hdr(h: Record<string, string | string[] | undefined>, name: string): string | undefined {
    const v = h[name];
    return Array.isArray(v) ? v[0] : v;
}

function checkTimestamp(raw: string | undefined, now: Date, windowSec: number): { ok: true; ts: number } | { ok: false; reason: 'bad_timestamp' | 'outside_replay_window' } {
    if (!raw || !/^\d{9,12}$/.test(raw)) return { ok: false, reason: 'bad_timestamp' };
    const ts = Number(raw);
    if (Math.abs(Math.floor(now.getTime() / 1000) - ts) > windowSec) return { ok: false, reason: 'outside_replay_window' };
    return { ok: true, ts };
}

export function verifyCallback(
    scheme: CallbackScheme,
    cfg: CallbackAuthConfig,
    jobId: string,
    headers: Record<string, string | string[] | undefined>,
    rawBody: Buffer,
    now: Date,
): VerifyResult {
    assertConfig(cfg);
    if (scheme === 'bearer') {
        const auth = hdr(headers, 'authorization');
        const m = auth && /^Bearer\s+(\S+)$/i.exec(auth);
        if (!m) return { ok: false, reason: 'missing_headers' };
        if (!safeEqual(m[1]!, jobBearerToken(cfg.masterSecret, jobId))) return { ok: false, reason: 'bad_signature' };
        // Bearer carries no timestamp/id: the delivery id is the body hash so identical redeliveries dedupe.
        return { ok: true, deliveryId: 'bearer:' + createHmac('sha256', cfg.masterSecret).update(rawBody).digest('hex').slice(0, 32) };
    }
    if (scheme === 'lore-hmac') {
        const tsRaw = hdr(headers, 'x-lore-timestamp'); const sig = hdr(headers, 'x-lore-signature');
        if (!tsRaw || !sig) return { ok: false, reason: 'missing_headers' };
        const t = checkTimestamp(tsRaw, now, cfg.replayWindowSec);
        if (!t.ok) return t;
        if (!safeEqual(sig, signLoreHmac(cfg.masterSecret, jobId, t.ts, rawBody))) return { ok: false, reason: 'bad_signature' };
        return { ok: true, deliveryId: hdr(headers, 'x-lore-delivery-id') ?? sig };
    }
    // standard-webhooks
    if (!cfg.webhookSecret) return { ok: false, reason: 'scheme_unconfigured' };
    const id = hdr(headers, 'webhook-id'); const tsRaw = hdr(headers, 'webhook-timestamp'); const sigs = hdr(headers, 'webhook-signature');
    if (!id || !tsRaw || !sigs) return { ok: false, reason: 'missing_headers' };
    const t = checkTimestamp(tsRaw, now, cfg.replayWindowSec);
    if (!t.ok) return t;
    const expected = signStandardWebhook(cfg.webhookSecret, id, t.ts, rawBody);
    // The header may list several space separated signatures; evaluate ALL (no early exit) to keep timing flat.
    let match = false;
    for (const s of sigs.split(' ')) if (safeEqual(s, expected)) match = true;
    return match ? { ok: true, deliveryId: id } : { ok: false, reason: 'bad_signature' };
}
