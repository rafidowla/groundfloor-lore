#!/usr/bin/env tsx
/**
 * pg-seed-1m.mts - BENCH ONLY (not shipped). Seeds a real Lore Postgres workspace with N synthetic nodes.
 *
 *   LORE_PG_URL=postgres://u:p@host:port/db  npx tsx scripts/bench/pg-seed-1m.mts --n 100000 --root <dir> [--dim 384]
 *
 * 1. Opens a real Lore (createLore, embedded, fake embedder) over a fresh Postgres workspace so the schema and every
 *    index is Lore's own, and writes one real node through nodeUpsert (the schema/partition birth path).
 * 2. Drops the secondary bulk-hostile indexes (3 keyword trigram/tags GIN on nodes, HNSW + tsvector GIN on verbatim).
 * 3. Bulk-loads nodes + verbatim rows (text, tsvector via Lore's trigger, vectors) with batched INSERT..unnest on parallel
 *    connections. Row shapes mirror what nodeUpsert wrote (verbatim id = `lore:<id>`, text = label/content/tags).
 * 4. Re-opens Lore and lets Lore's OWN builders recreate the indexes (graph.waitForKeywordIndexes, verbatim
 *    ensureVectorIndex / ensureFtsIndex, compact = VACUUM ANALYZE), timing each.
 *
 * Writes <root>/seed-info.json (paths, workspace name + Postgres key, params, timings) for pg-scale-bench.mts. The corpus is deterministic (pg-corpus.mts).
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { argv, hasFlag, makeHome, openLore, makeFakeEmbedder, pgWorkspaceKey, WS_DEFAULT, now } from './pg-bench-common.mts';
import { defaultParams, nodeFields, nodeVector, clusterCenters, verbatimText, contentHash, vecText, nodeId, queryVector } from './pg-corpus.mts';

const url = process.env['LORE_PG_URL'];
if (!url) { console.error('LORE_PG_URL is required'); process.exit(2); }
const n = Number(argv('n', '100000'));
const dim = Number(argv('dim', '384'));
const root = argv('root');
if (!root) { console.error('--root <dir> is required'); process.exit(2); }
const BATCH = Number(argv('batch', '4000'));
const CONC = Number(argv('conc', '4'));
const p = defaultParams(n, dim);
const ws = WS_DEFAULT;
const log = (m: string) => console.log(`[seed ${new Date().toISOString().slice(11, 19)}] ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const pool = new pg.Pool({ connectionString: url, max: CONC + 2 });
const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);
const timings: Record<string, number> = {};
const timed = async <T,>(k: string, fn: () => Promise<T>): Promise<T> => { const t = now(); try { return await fn(); } finally { timings[k] = (now() - t) / 1000; log(`${k}: ${timings[k]!.toFixed(1)} s`); } };

// ---- 1. schema through Lore itself ------------------------------------------------------------------------------
const { home, wsPath } = makeHome(root, ws);
const fake = makeFakeEmbedder(dim);
{
    const lore = await openLore(home, dim, {}, fake);
    await lore.nodeUpsert({ id: nodeId(0), workspace: ws, ecosystem: '*', nodeData: (() => { const f = nodeFields(p, 0); return { id: f.id, type: f.type, label: f.label, content: f.content, tags: f.tags, project: 'default', ecosystem: '*' }; })() });
    await lore.awaitEmbeds?.();
    await lore.dispose();
}
log(`schema created through Lore; home=${home}`);
// Rows are keyed by the permanent workspace id (3.37.0+), not the name: bulk rows must carry the same key Lore wrote.
const wsKey = await pgWorkspaceKey(home, ws);
const wrote = (await q('SELECT workspace_id FROM nodes WHERE id = $1', [nodeId(0)])).rows.map((r) => r.workspace_id as string);
if (wrote.length !== 1 || wrote[0] !== wsKey) throw new Error(`workspace key mismatch: resolver says ${wsKey}, Lore wrote node ${nodeId(0)} under ${JSON.stringify(wrote)}`);
log(`workspace key ${wsKey}`);

// ---- 2. drop the bulk-hostile indexes ------------------------------------------------------------------------
const { KEYWORD_INDEXES } = await import('../../packages/lore/src/engines/postgres/postgresKeywordIndex.js');
for (const k of KEYWORD_INDEXES) await q(`DROP INDEX IF EXISTS ${k.name}`);
await q('DROP INDEX IF EXISTS verbatim_vector_hnsw');
await q('DROP INDEX IF EXISTS verbatim_text_tsv_gin');

// ---- 3. bulk load -------------------------------------------------------------------------------------------------
const centers = clusterCenters(p);
const NODE_SQL = `INSERT INTO nodes (workspace_id, id, type, label, content, tags, project, ecosystem, "createdAt", "updatedAt", revision)
  SELECT $1, * FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::int[])
  ON CONFLICT DO NOTHING`;
const VERB_SQL = `INSERT INTO verbatim (workspace_id, id, text, vector, content_hash, type, label, tags, project, ecosystem, "updatedAt", is_canonical, is_tombstone, created_at, updated_at)
  SELECT $1, u.id, u.text, u.vec::vector, u.h, u.type, u.label, u.tags, 'default', '*', u.upd, 1, 0, u.cat, u.cat
  FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::text[]) AS u(id, text, vec, h, type, label, tags, upd, cat, _x)
  WHERE NOT EXISTS (SELECT 1 FROM verbatim v WHERE v.workspace_id = $1 AND v.id = u.id AND v.is_canonical = 1)`;

let loaded = 0;
async function loadBatch(from: number, to: number): Promise<void> {
    const c: Record<string, string[]> = { id: [], type: [], label: [], content: [], tags: [], created: [], updated: [], vid: [], text: [], vec: [], hash: [], vtags: [], blank: [] };
    const rev: number[] = [];
    for (let i = from; i < to; i++) {
        const f = nodeFields(p, i);
        c.id!.push(f.id); c.type!.push(f.type); c.label!.push(f.label); c.content!.push(f.content);
        c.tags!.push(JSON.stringify(f.tags)); c.created!.push(f.createdAt); c.updated!.push(f.updatedAt); rev.push(1);
        const text = verbatimText(f);
        c.vid!.push(`lore:${f.id}`); c.text!.push(text); c.vec!.push(vecText(nodeVector(p, centers, i, f.cluster)));
        c.hash!.push(contentHash(text)); c.vtags!.push(f.tags.join(',')); c.blank!.push('');
    }
    await q(NODE_SQL, [wsKey, c.id, c.type, c.label, c.content, c.tags, c.id.map(() => 'default'), c.id.map(() => '*'), c.created, c.updated, rev]);
    await q(VERB_SQL, [wsKey, c.vid, c.text, c.vec, c.hash, c.type, c.label, c.vtags, c.updated, c.created, c.blank]);
    loaded += to - from;
}
await timed('bulk_load', async () => {
    let next = 1; // node 0 was written through nodeUpsert
    let lastLog = now();
    const worker = async () => {
        for (;;) {
            const from = next; if (from >= n) return;
            next = Math.min(n, from + BATCH);
            await loadBatch(from, next);
            if (now() - lastLog > 30_000) { lastLog = now(); log(`loaded ${loaded + 1}/${n}`); }
        }
    };
    await Promise.all(Array.from({ length: CONC }, worker));
});
const counts = await q(`SELECT (SELECT count(*) FROM nodes WHERE workspace_id=$1) AS nodes, (SELECT count(*) FROM verbatim WHERE workspace_id=$1) AS verbatim`, [wsKey]);
log(`rows: nodes=${counts.rows[0].nodes} verbatim=${counts.rows[0].verbatim}`);
await pool.end();

// ---- 4. rebuild indexes ----------------------------------------------------------------------------------
// verbatim HNSW + tsvector GIN: Lore's startup schema check (ensureVerbatimSchema) treats a missing one as "schema not
// current" and re-runs the CREATE INDEX inline under the 30 s statement_timeout (finding, see the report), so they are
// built here BEFORE Lore opens, with the exact DDL of ensureVectorIndex / ensureFtsIndex, statement_timeout lifted.
// The three nodes keyword indexes are built by Lore's own background builder (graph.waitForKeywordIndexes).
{
    const c = await new pg.Pool({ connectionString: url, max: 1 }).connect();
    await c.query('SET statement_timeout = 0');
    await c.query('SET max_parallel_maintenance_workers = 4');
    await timed('index_verbatim_tsv_gin', () => c.query('CREATE INDEX IF NOT EXISTS verbatim_text_tsv_gin ON verbatim USING gin(text_tsv)'));
    await timed('index_verbatim_hnsw', () => c.query('CREATE INDEX IF NOT EXISTS verbatim_vector_hnsw ON verbatim USING hnsw(vector vector_cosine_ops)'));
    await timed('vacuum_analyze', async () => { await c.query('VACUUM (ANALYZE) nodes'); await c.query('VACUUM (ANALYZE) verbatim'); });
    c.release();
}
{
    const lore = await openLore(home, dim, {}, fake);
    const graph = lore.store.loreGraph;
    await timed('index_keyword_trgm_tags (Lore background builder)', () => graph.waitForKeywordIndexes());
    const pool2 = new pg.Pool({ connectionString: url, max: 2 });
    await pool2.query('ANALYZE nodes'); await pool2.query('ANALYZE edges');
    const sz = await pool2.query(`SELECT c.relname, c.relkind, pg_total_relation_size(c.oid) AS bytes FROM pg_class c WHERE c.relkind IN ('r','i') AND c.relnamespace = 'public'::regnamespace AND (c.relname LIKE 'idx_nodes_%' OR c.relname IN ('nodes','edges') OR c.relname LIKE 'verbatim_ws_%') ORDER BY 3 DESC LIMIT 20`);
    await pool2.end();
    await lore.dispose();
    fs.writeFileSync(path.join(root, 'seed-info.json'), JSON.stringify({ home, wsPath, ws, wsKey, n, dim, params: p, timings, sizes: sz.rows, finished: new Date().toISOString() }, null, 2));
}
log(`done; ${path.join(root, 'seed-info.json')}`);
void queryVector; void hasFlag; void sleep;
process.exit(0);
