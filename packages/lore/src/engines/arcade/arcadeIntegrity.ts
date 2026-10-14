/**
 * arcadeIntegrity.ts — 3.34.0 slice 2: ghost-record scan and removal for ArcadeDB (the ArcadeDB
 * implementation of the optional `GraphProvider.integrityScan` / `integrityRemove` capability).
 *
 * A "ghost" is a `LoreNode` bucket record the unique `LoreNode[id]` index has no entry for. Every
 * id-keyed statement (`WHERE id = :id`, upsert, `DELETE VERTEX ... WHERE id = :id`) goes through that
 * index, so a ghost can be neither read nor deleted by id, and it can keep a retired node's text
 * visible to scans. The root cause of how the index diverges is unconfirmed; this finds the records
 * and removes them by `@rid`, the one handle the index does not gate.
 *
 * Verified live against ArcadeDB 26.7.1 (see the slice 2 PR):
 *  - `SELECT @rid AS rid, id, ... FROM LoreNode ORDER BY @rid` projects the record id and scans the
 *    bucket; a record with a NULL id is skipped by the index (`nullStrategy: SKIP`) so it is a
 *    naturally reproducible ghost.
 *  - `@rid > :param` does NOT compare as a rid (a string param matched nothing); the cursor is
 *    inlined as a rid literal after a strict shape check.
 *  - `DELETE VERTEX FROM LoreNode WHERE @rid = :rid` removes by record id and reports `count`.
 */
import type { GraphIntegrityRemoval, GraphIntegrityScan, GraphIntegritySuspect } from '../../providers/types.js';
import type { ArcadeHttp } from './arcadeHttp.js';
import { NODE_TYPE, graphSchemaDdl } from './arcadeSchema.js';

const PAGE = 500;
/** Stops a runaway loop (a non-advancing cursor) rather than scanning forever. */
const MAX_PAGES = 100_000;
const RID_RE = /^#\d+:\d+$/;

type Row = Record<string, unknown>;
const rows = (r: { result?: unknown }): Row[] => (Array.isArray(r.result) ? (r.result as Row[]) : []);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

/** Record ids are interpolated into SQL (the param form does not compare as a rid), so validate first. */
export function assertRid(rid: string): string {
  if (!RID_RE.test(rid)) throw new Error(`invalid record id: ${JSON.stringify(rid).slice(0, 40)}`);
  return rid;
}

/**
 * Schema DDL only - deliberately NOT `ArcadeGraphStore.initialize()`. initialize() also runs the
 * security_scopes backfill, which pages `WHERE security_scopes IS NULL`; a null-id ghost matches that
 * forever and the backfill throws "made no progress", so the repair could never run on exactly the cell
 * that needs it (found live, 26.7.1). The DDL is IF NOT EXISTS, so this is a no-op on a provisioned cell.
 */
export async function ensureIntegritySchema(db: string, http: ArcadeHttp): Promise<void> {
  for (const stmt of graphSchemaDdl()) await http.command(db, stmt);
}

/** Full bucket scan, compared page by page against the id lookup. Read-only. */
export async function scanNodeIntegrity(db: string, http: ArcadeHttp): Promise<GraphIntegrityScan> {
  const suspects: GraphIntegritySuspect[] = [];
  let scanned = 0;
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const where = cursor ? `WHERE @rid > ${assertRid(cursor)} ` : '';
    // eslint-disable-next-line no-await-in-loop
    const batch = rows(
      await http.query(
        db,
        `SELECT @rid AS rid, id, revision, createdAt FROM ${NODE_TYPE} ${where}ORDER BY @rid LIMIT ${PAGE}`,
      ),
    );
    if (batch.length === 0) break;
    scanned += batch.length;
    const ids = [...new Set(batch.map((r) => str(r['id'])).filter((v): v is string => v !== null))];
    const indexRid = new Map<string, string>();
    if (ids.length > 0) {
      // eslint-disable-next-line no-await-in-loop
      const found = rows(await http.query(db, `SELECT @rid AS rid, id FROM ${NODE_TYPE} WHERE id IN :ids`, { ids }));
      for (const r of found) {
        const id = str(r['id']);
        const rid = str(r['rid']);
        if (id && rid) indexRid.set(id, rid);
      }
    }
    for (const r of batch) {
      const rid = str(r['rid']);
      if (!rid) continue;
      const id = str(r['id']);
      const viaIndex = id ? indexRid.get(id) : undefined;
      if (viaIndex === rid) continue;
      suspects.push({
        rid,
        id,
        revision: num(r['revision']),
        createdAt: str(r['createdAt']),
        scanFound: true,
        indexFound: false,
        indexRid: viaIndex ?? null,
      });
    }
    const last = str(batch[batch.length - 1]?.['rid']);
    if (!last || last === cursor || batch.length < PAGE) break;
    cursor = last;
  }
  return { supported: true, status: 'ok', scanned, suspects };
}

/**
 * Remove the given records by `@rid`. Each rid is re-checked first: a record the id lookup returns is
 * live and is refused; a record that is already gone is `absent` (idempotent). A rid counts as
 * `removed` only after a re-read shows it gone.
 */
export async function removeNodeRecords(db: string, http: ArcadeHttp, rids: string[]): Promise<GraphIntegrityRemoval> {
  const removed: string[] = [];
  const absent: string[] = [];
  const refused: Array<{ rid: string; reason: 'live_readable' }> = [];
  for (const rid of [...new Set(rids)].map(assertRid)) {
    // eslint-disable-next-line no-await-in-loop
    const there = rows(await http.query(db, `SELECT @rid AS rid, id FROM ${NODE_TYPE} WHERE @rid = :rid`, { rid }));
    if (there.length === 0) {
      absent.push(rid);
      continue;
    }
    const id = str(there[0]?.['id']);
    if (id) {
      // eslint-disable-next-line no-await-in-loop
      const viaIndex = rows(await http.query(db, `SELECT @rid AS rid FROM ${NODE_TYPE} WHERE id = :id`, { id }));
      if (viaIndex.some((r) => str(r['rid']) === rid)) {
        refused.push({ rid, reason: 'live_readable' });
        continue;
      }
    }
    // eslint-disable-next-line no-await-in-loop
    const res = rows(await http.command(db, `DELETE VERTEX FROM ${NODE_TYPE} WHERE @rid = :rid`, { rid }));
    if (!(num(res[0]?.['count']) ?? 0)) {
      // Type-scoped delete matched nothing; fall back to the direct record-id form.
      // eslint-disable-next-line no-await-in-loop
      await http.command(db, `DELETE FROM ${rid}`);
    }
    // eslint-disable-next-line no-await-in-loop
    const after = rows(await http.query(db, `SELECT @rid AS rid FROM ${NODE_TYPE} WHERE @rid = :rid`, { rid }));
    if (after.length === 0) removed.push(rid);
    else throw new Error(`integrity removal of ${rid} did not take effect`);
  }
  return { supported: true, status: 'ok', removed, absent, refused };
}
