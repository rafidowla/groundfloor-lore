/**
 * scopePageFill.ts — page-filling for lists read by a BOUND actor.
 *
 * Contract: a bound actor lacking an item's security_scopes must observe
 * exactly what it would observe if that item did not exist — including
 * pagination. Filtering a raw engine page AFTER the fact breaks that in three
 * ways: pages come back short, `hasMore` reflects the raw page, and the cursor
 * is built from the last RAW row — which can be a hidden row, so the cursor
 * hands the caller a hidden row's id/updatedAt.
 *
 * Rule (Rafi, "fill pages"): for a bound actor keep fetching underlying pages
 * until the page holds `limit` VISIBLE rows, then keep scanning (look-ahead)
 * until one more visible row is found or the list is exhausted:
 *   - look-ahead found a row  → hasMore=true, cursor = LAST VISIBLE ROW RETURNED
 *   - list exhausted          → hasMore=false, no cursor
 * so the cursor only ever names a row the caller was already shown.
 *
 * Scan cap: one request scans at most SCOPE_PAGE_FILL_MAX_SCAN raw rows, so a
 * caller who can see almost nothing cannot make a single request walk the whole
 * table. If the cap is hit before the page fills or the look-ahead resolves,
 * the response returns the visible rows found so far with hasMore=true and a
 * SEALED continuation cursor: the scan position (which may be a hidden row) is
 * encrypted with a per-process random AES-256-GCM key, so the client cannot
 * read it, yet resuming makes forward progress (never rescans the hidden
 * stretch, never loops on an empty page). The seal is invalid after a daemon
 * restart (the caller gets invalid_cursor, same as any malformed cursor).
 * Residual, unavoidable disclosure: a cap-hit response reveals that at least
 * SCOPE_PAGE_FILL_MAX_SCAN rows were passed over. hasMore=true on a cap hit
 * means "may have more" (the scan stopped before it could decide).
 *
 * Unbound actors (getCurrentActorScopes() === undefined) never reach this
 * module: callers keep their original code path byte-for-byte.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { applyActorScopeFilter } from './scopeFilter.js';
import { getCurrentActorScopes } from './actorContext.js';

/** Max raw rows one request may scan while filling a page (all batches, skip + look-ahead included). */
export const SCOPE_PAGE_FILL_MAX_SCAN = 10_000;

/** Rows requested from the engine per round trip: clamp(limit, 100, 1000). */
export function scopePageFillBatchSize(limit: number): number {
    return Math.min(1000, Math.max(Math.floor(limit), 100));
}

/** True when the current request is made by a bound (authenticated) actor. */
export function isActorBound(): boolean {
    return getCurrentActorScopes() !== undefined;
}

/* ── sealed continuation ─────────────────────────────────────────────── */

let sealKey: Buffer | undefined;
function key(): Buffer {
    if (!sealKey) sealKey = randomBytes(32);
    return sealKey;
}

/** Encrypt a small JSON-able position into an opaque base64url string. */
export function sealContinuation(payload: unknown): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key(), iv);
    const ct = Buffer.concat([c.update(JSON.stringify(payload), 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
}

/** Decrypt a token from sealContinuation; undefined when forged / foreign / from a previous process. */
export function openContinuation(token: unknown): unknown {
    if (typeof token !== 'string' || token.length === 0) return undefined;
    try {
        const raw = Buffer.from(token, 'base64url');
        if (raw.length < 29) return undefined;
        const d = createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12));
        d.setAuthTag(raw.subarray(12, 28));
        const pt = Buffer.concat([d.update(raw.subarray(28)), d.final()]);
        return JSON.parse(pt.toString('utf8'));
    } catch {
        return undefined;
    }
}

/**
 * Keyset-cursor payloads are base64url(JSON). A sealed continuation is carried
 * as `{ "sealed": "<token>" }`. Pass the parsed JSON through this: it returns
 * the inner `{updatedAt,id}` for a valid sealed cursor and the input unchanged
 * otherwise (so plain cursors, and invalid sealed ones, fail the caller's own
 * shape validation exactly as before).
 */
export function unsealKeysetPayload(parsed: unknown): unknown {
    if (parsed && typeof parsed === 'object' && typeof (parsed as { sealed?: unknown }).sealed === 'string') {
        const inner = openContinuation((parsed as { sealed: string }).sealed) as { updatedAt?: unknown; id?: unknown } | undefined;
        if (inner && typeof inner.updatedAt === 'string' && typeof inner.id === 'string') {
            return { updatedAt: inner.updatedAt, id: inner.id };
        }
    }
    return parsed;
}

/* ── keyset page fill (list_nodes, /api/node-list, /api/nodes/bulk-list) ── */

export interface KeysetCursor { updatedAt: string; id: string }

type ScopedNode = { id?: unknown; updatedAt?: unknown; security_scopes?: string[] };

export interface FilledKeysetPage<T> {
    nodes: T[];
    hasMore: boolean;
    /** JSON-serialisable cursor payload (plain {updatedAt,id} or {sealed}); null = none. */
    nextCursor: KeysetCursor | { sealed: string } | null;
    /** True when the scan cap ended the request (hasMore is then "may have more"). */
    capped: boolean;
}

function keyOf(n: ScopedNode): KeysetCursor {
    return { updatedAt: String(n.updatedAt ?? ''), id: String(n.id ?? '') };
}

/**
 * Fill one page of VISIBLE rows for the current bound actor.
 *
 * @param fetch   engine page fetch, ordered (updatedAt DESC, id ASC), strict-after `cursor`
 * @param accept  extra row predicate that is NOT secret (e.g. ecosystem match); rows failing it are skipped like hidden rows
 */
export async function fillVisibleKeysetPage<T extends ScopedNode>(args: {
    limit: number;
    cursor: KeysetCursor | null;
    fetch: (cursor: KeysetCursor | null, fetchLimit: number) => Promise<{ nodes: T[]; hasMore: boolean }>;
    accept?: (n: T) => boolean;
    maxScan?: number;
    batchSize?: number;
}): Promise<FilledKeysetPage<T>> {
    const { limit, accept } = args;
    const maxScan = args.maxScan ?? SCOPE_PAGE_FILL_MAX_SCAN;
    const batch = args.batchSize ?? scopePageFillBatchSize(limit);
    const actorScopes = getCurrentActorScopes();
    const visible = (n: T): boolean =>
        (accept ? accept(n) : true)
        && applyActorScopeFilter([{ metadata: { security_scopes: n.security_scopes } }], actorScopes).length === 1;

    const out: T[] = [];
    let cur = args.cursor;
    let scanned = 0;
    let last: T | undefined;
    let foundExtra = false;
    let exhausted = false;
    let capped = false;
    while (!foundExtra && !exhausted && !capped) {
        if (scanned >= maxScan) { capped = true; break; }
        const page = await args.fetch(cur, batch);
        if (page.nodes.length === 0) { exhausted = true; break; }
        for (const n of page.nodes) {
            if (scanned >= maxScan) { capped = true; break; }
            scanned++;
            last = n;
            if (!visible(n)) continue;
            if (out.length < limit) out.push(n);
            else { foundExtra = true; break; }
        }
        if (foundExtra || capped) break;
        if (!page.hasMore) { exhausted = true; break; }
        cur = keyOf(last!);
    }

    if (foundExtra) {
        return { nodes: out, hasMore: true, nextCursor: keyOf(out[out.length - 1]!), capped: false };
    }
    if (capped && last !== undefined) {
        return { nodes: out, hasMore: true, nextCursor: { sealed: sealContinuation(keyOf(last)) }, capped: true };
    }
    return { nodes: out, hasMore: false, nextCursor: null, capped: false };
}

/** base64url(JSON) wire encoding shared by every keyset cursor. */
export function encodeKeysetCursor(c: KeysetCursor | { sealed: string }): string {
    return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}
