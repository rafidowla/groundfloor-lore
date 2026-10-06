/**
 * migrateVectorsDedupe.ts — duplicate-canonical-id tracking for
 * `lore migrate-vectors <ws> --to sqlite` (3.28, `dedupeIdentical`).
 *
 * A Lance table has no unique constraint, so a canonical id can appear more
 * than once (a retried bulk write, an interrupted promotion). SQLite's
 * unique index rejects that, so the migration used to refuse outright. When
 * EVERY copy of an id carries the same content, the copies are redundant and
 * `dedupeIdentical` keeps exactly one of them.
 *
 * Identity of a copy (`rowIdentityKey`) covers EVERYTHING that is not a
 * timestamp or the vector: its `contentHash` (or a digest of its text when it
 * has none — rows written before content hashes existed), the FULL text (so a
 * live row and its tombstoned twin — which keeps the original contentHash but
 * rewrites the text to `[TOMBSTONED …]` — differ), `security_scopes` (sorted),
 * `type`, `label`, `tags`, `project` and `ecosystem`. Copies of one id are
 * "identical" only when every copy has the same identity key; anything else
 * (same hash but different scopes, a live row vs a tombstone, …) is a genuine
 * conflict: it is reported, never dropped, and the migration still refuses.
 * `updatedAt`, `createdAt` and the vector are NOT part of identity.
 *
 * Which copy is kept: the newest `updatedAt` (parsed as a date; an
 * unparseable/absent value ranks lowest), and on a tie the FIRST one seen in
 * the Lance scan. Selection is by scan ordinal ("the k-th row with this
 * id"), so pass 2 can pick the same row without a second key; pass 2
 * re-checks the picked row's identity key and `updatedAt` against what pass
 * 1 recorded and aborts on any disagreement.
 *
 * Memory: one small record per distinct non-history id (the previous
 * implementation already held a Set of every such id).
 */

import { createHash } from 'node:crypto';
import type { RowKind } from './migrateVectorsRows.js';
import { toPlainStringList } from './verbatimHistory.js';

export interface DedupedId {
    id: string;
    /** How many copies the Lance table held (>= 2). */
    copies: number;
    kept: { updatedAt: string };
}

interface Rec {
    kind: RowKind;
    n: number;
    key: string;
    allSame: boolean;
    keptOrdinal: number;
    keptUpdatedAt: string;
    keptMs: number;
    keptTombstone: boolean;
    keptUnembedded: boolean;
}

/** Columns `rowIdentityKey` reads (any absent from an old table is treated as ''). Plus `updatedAt`, read separately. */
export const IDENTITY_COLUMNS = ['id', 'text', 'contentHash', 'security_scopes', 'type', 'label', 'tags', 'project', 'ecosystem'] as const;

const sha1 = (s: string): string => createHash('sha1').update(s).digest('hex');
const plain = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

/** Hash-or-text-digest part of the identity (what `contentKey` used to be on its own). */
function contentKey(contentHash: unknown, text: string): string {
    if (typeof contentHash === 'string' && contentHash.length > 0) return `h:${contentHash}`;
    return `t:${sha1(text)}`;
}

/**
 * The ONE identity function both dedupe paths use (migrate-vectors
 * `--dedupe-identical` and `lore verbatim dedupe`). See the header. A raw
 * Lance row in, a short opaque key out; absent columns count as ''.
 */
export function rowIdentityKey(raw: Record<string, unknown>): string {
    const text = plain(raw.text);
    return sha1(JSON.stringify([
        contentKey(raw.contentHash, text),
        sha1(text),
        toPlainStringList(raw.security_scopes).sort(),
        plain(raw.type), plain(raw.label), plain(raw.tags), plain(raw.project), plain(raw.ecosystem),
    ]));
}

function toMs(updatedAt: string | null): number {
    if (!updatedAt) return Number.NEGATIVE_INFINITY;
    const t = Date.parse(updatedAt);
    return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
}

export class CanonicalTracker {
    private readonly recs = new Map<string, Rec>();

    /** Record one non-history Lance row, in scan order. */
    add(id: string, kind: RowKind, key: string, updatedAt: string | null, tombstone: boolean, unembedded: boolean): void {
        const ms = toMs(updatedAt);
        const cur = this.recs.get(id);
        if (!cur) {
            this.recs.set(id, {
                kind, n: 1, key, allSame: true, keptOrdinal: 0, keptUpdatedAt: updatedAt ?? '', keptMs: ms,
                keptTombstone: tombstone, keptUnembedded: unembedded,
            });
            return;
        }
        const ordinal = cur.n;
        cur.n++;
        if (key !== cur.key) cur.allSame = false;
        if (ms > cur.keptMs) {
            cur.keptOrdinal = ordinal;
            cur.keptUpdatedAt = updatedAt ?? '';
            cur.keptMs = ms;
            cur.keptTombstone = tombstone;
            cur.keptUnembedded = unembedded;
        }
    }

    /** Distinct non-history ids seen so far. */
    size(): number {
        return this.recs.size;
    }

    /** Ids that appear more than once, in first-seen order. */
    duplicates(): Array<{ id: string; copies: number; identical: boolean }> {
        const out: Array<{ id: string; copies: number; identical: boolean }> = [];
        for (const [id, r] of this.recs) if (r.n > 1) out.push({ id, copies: r.n, identical: r.allSame });
        return out;
    }

    /** Non-history tombstone / unembedded totals counting ONE copy per id (the kept one). */
    keptTotals(): { tombstones: number; unembedded: number } {
        let tombstones = 0;
        let unembedded = 0;
        for (const r of this.recs.values()) {
            if (r.keptTombstone) tombstones++;
            if (r.keptUnembedded) unembedded++;
        }
        return { tombstones, unembedded };
    }

    /** Rows dropped per kind if every duplicate group is deduped. */
    droppedByKind(): Record<RowKind, number> {
        const out: Record<RowKind, number> = { canonical: 0, history: 0, alias: 0 };
        for (const r of this.recs.values()) if (r.n > 1) out[r.kind] += r.n - 1;
        return out;
    }

    /** Plan for pass 2: which ordinal to keep per duplicated id. */
    plan(): Map<string, { copies: number; keptOrdinal: number; key: string; keptUpdatedAt: string }> {
        const out = new Map<string, { copies: number; keptOrdinal: number; key: string; keptUpdatedAt: string }>();
        for (const [id, r] of this.recs) {
            if (r.n > 1) out.set(id, { copies: r.n, keptOrdinal: r.keptOrdinal, key: r.key, keptUpdatedAt: r.keptUpdatedAt });
        }
        return out;
    }

    report(): DedupedId[] {
        return [...this.plan()].map(([id, p]) => ({ id, copies: p.copies, kept: { updatedAt: p.keptUpdatedAt } }))
            .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    }
}

const LIST_MAX = 10;

function idList(ids: string[]): string {
    const shown = ids.slice(0, LIST_MAX).map((i) => `'${i}'`).join(', ');
    return ids.length > LIST_MAX ? `${shown} (+${ids.length - LIST_MAX} more)` : shown;
}

/**
 * The refusal for duplicate canonical ids. Always begins with today's
 * message; the tail tells the operator whether `--dedupe-identical` would
 * resolve it (never claims it will when any group differs).
 */
export function duplicateRefusal(dups: Array<{ id: string; copies: number; identical: boolean }>, dedupeRequested: boolean): string {
    const extra = dups.reduce((s, d) => s + d.copies - 1, 0);
    const differing = dups.filter((d) => !d.identical).map((d) => d.id);
    let msg = `migrate-vectors: duplicate canonical id '${dups[0]!.id}' in the Lance table — SQLite's unique index would reject it. Nothing written. `
        + `${dups.length} id(s) are repeated (${extra} extra row(s)): ${idList(dups.map((d) => d.id))}.`;
    if (differing.length === 0) {
        msg += ' All copies of each id are identical (same content hash); re-run with --dedupe-identical to keep the newest copy of each '
            + 'and leave the rest out of the SQLite import (the Lance data is never modified).';
    } else if (dedupeRequested) {
        msg += ` --dedupe-identical only drops copies with identical content, and ${differing.length} id(s) have copies that DIFFER: ${idList(differing)}. `
            + 'Resolve those in Lance first (keep one version of each), then retry.';
    } else {
        msg += ` ${differing.length} of them have copies with DIFFERENT content (${idList(differing)}), so --dedupe-identical would NOT resolve this. `
            + 'Resolve those ids in Lance first (keep one version of each), then retry.';
    }
    return msg;
}
