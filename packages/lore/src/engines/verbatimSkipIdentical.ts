/**
 * verbatimSkipIdentical.ts — Lance helpers for the skip-identical rule (3.35.0).
 *
 * `updatedAt` is NOT part of "identical": the graph layer re-stamps it on every re-store, so comparing it made an
 * unchanged re-store (an Atlas `git pull`) write a new row and re-embed each time. When everything else matches and
 * only `updatedAt` differs, the canonical row's `updatedAt` is updated in place (no new row, no `#rev` snapshot, no
 * embed). Callers hold the store's write lane.
 */

import type * as lancedb from '@lancedb/lancedb';

import { VERBATIM_CHUNK_SIZE } from './verbatimBatch.js';
import { assertSafeLanceId, getById, isRevisionHistoryId, toPlainStringList } from './verbatimHistory.js';
import { computeContentHash } from './contentHash.js';
import { redactSecrets } from '../security/secretScan.js';

export interface CanonicalMeta {
    contentHash: string;
    text: string;
    type: string;
    label: string;
    tags: string;
    project: string;
    ecosystem: string;
    updatedAt: string;
    security_scopes: string[];
}

const quote = (id: string): string => `'${id.replace(/'/g, "''")}'`;

/** Canonical (non-`#rev`) rows for `ids`, keyed by id, via chunked `id IN (...)` queries. Vectors are not read. */
export async function readCanonicalMetaByIds(table: lancedb.Table | null, ids: readonly string[]): Promise<Map<string, CanonicalMeta>> {
    const out = new Map<string, CanonicalMeta>();
    const wanted = ids.filter((id) => !isRevisionHistoryId(id));
    wanted.forEach((id) => assertSafeLanceId(id, 'skipIdentical.read')); // SECURITY — outside try so validation errors propagate
    if (!table || wanted.length === 0) return out;
    for (let i = 0; i < wanted.length; i += VERBATIM_CHUNK_SIZE) {
        const chunk = wanted.slice(i, i + VERBATIM_CHUNK_SIZE);
        const rows = await table.query()
            .where(`id IN (${chunk.map(quote).join(',')})`)
            .select(['id', 'text', 'contentHash', 'type', 'label', 'tags', 'project', 'ecosystem', 'updatedAt', 'security_scopes'])
            .toArray() as Array<Record<string, unknown>>;
        const s = (v: unknown): string => (typeof v === 'string' ? v : '');
        for (const r of rows) {
            out.set(String(r.id), {
                contentHash: s(r.contentHash), text: s(r.text), type: s(r.type), label: s(r.label), tags: s(r.tags),
                project: s(r.project), ecosystem: s(r.ecosystem), updatedAt: s(r.updatedAt),
                security_scopes: toPlainStringList(r.security_scopes),
            });
        }
    }
    return out;
}

/** Carry a changed, non-empty `updatedAt` onto the canonical row in place. Returns true when a row was changed. */
export async function syncCanonicalUpdatedAt(table: lancedb.Table, id: string, current: string | undefined, next: string | undefined): Promise<boolean> {
    if (!next || (current ?? '') === next) return false;
    assertSafeLanceId(id, 'skipIdentical.update');
    await table.update({ where: `id = ${quote(id)}`, values: { updatedAt: next } });
    return true;
}

/** Redact secrets in place; returns the ids whose text changed (those are never skipped as identical). */
export function redactBatch(docs: Array<{ id: string; text: string }>): Set<string> {
    const redacted = new Set<string>();
    for (const d of docs) { const raw = d.text; d.text = redactSecrets(raw); if (d.text !== raw) redacted.add(d.id); }
    return redacted;
}

type SkipDoc = { id: string; text: string; metadata?: { updatedAt?: string; contentHash?: string } };

/** `store()` skip: true when the canonical row already matches `doc` (updatedAt excepted); its `updatedAt` is synced in place. */
export async function skipIdenticalOne(
    table: lancedb.Table | null, doc: SkipDoc, matches: (current: CanonicalMeta) => boolean, onSynced: () => void,
): Promise<boolean> {
    const current = await getById(table, true, doc.id);
    if (!current || !matches(current as CanonicalMeta)) return false;
    if (table && await syncCanonicalUpdatedAt(table, doc.id, current.updatedAt, doc.metadata?.updatedAt)) onSynced();
    return true;
}

/**
 * Batch pre-pass for Lance `storeBatch()`: drop docs identical to their canonical row (never for redacted text,
 * `#rev` history ids or tombstones) and sync those rows' `updatedAt` in place. Caller holds the write lane. A doc another
 * writer changes after this read is simply written normally: the skip was correct at the instant it was decided.
 */
export async function skipIdenticalBatch<D extends SkipDoc>(
    table: lancedb.Table | null, docs: D[], redactedIds: ReadonlySet<string>,
    matches: (current: CanonicalMeta, doc: D, hash: string) => boolean, onSynced: () => void,
): Promise<D[]> {
    const eligible = docs.filter((d) => !isRevisionHistoryId(d.id) && !redactedIds.has(d.id));
    if (!table || eligible.length === 0) return docs;
    const existing = await readCanonicalMetaByIds(table, eligible.map((d) => d.id));
    const remaining: D[] = [];
    let touched = false;
    for (const d of docs) {
        const cur = redactedIds.has(d.id) ? undefined : existing.get(d.id);
        const hash = cur ? (d.metadata?.contentHash || computeContentHash(d.text)) : '';
        if (cur && hash && matches(cur, d, hash)) {
            if (await syncCanonicalUpdatedAt(table, d.id, cur.updatedAt, d.metadata?.updatedAt)) touched = true;
            continue;
        }
        remaining.push(d);
    }
    if (touched) onSynced();
    return remaining;
}
