/**
 * postgresEdgePkMigration.ts - convert a layout-1 `edges` table (text-keyed:
 * PRIMARY KEY (workspace_id, source_id, target_id, relation)) into edge layout 2
 * (PRIMARY KEY (workspace_id, src_sk, dst_sk, relation), no text endpoint columns), in place.
 *
 * Runs inside runSchemaBootstrap's advisory lock (one migrator at a time; other Lore processes opening
 * the database wait on that lock, then find the new table). Live writers on OTHER, already-open
 * connections keep using the old table until the final swap. Same shape as the verbatim partition
 * migration (postgresVerbatimPartitionMigration.ts).
 *
 * PHASES (every phase is idempotent; a crash anywhere resumes at the right one)
 *
 *   1. STAGE   create `edges_next` (layout 2, NO indexes yet so the bulk load is append-only),
 *              `edges_dangling` (the quarantine) and a one-row progress table.
 *   2. COPY    ascending batches over the old text primary key, ONE TRANSACTION PER BATCH: each row's
 *              endpoints are resolved through `nodes` by TEXT id (a stored src_sk/dst_sk is never
 *              trusted). Resolved rows go to `edges_next`; a row whose source or target node no longer
 *              exists goes to `edges_dangling` and is NEVER deleted or dropped. The batch and the
 *              progress mark commit together, so a crash loses at most the batch in flight.
 *   3. INDEX   primary key + secondary indexes built on `edges_next` (sorted builds, outside any lock).
 *   4. SWAP    ONE transaction: ACCESS EXCLUSIVE lock on the old table (writers wait; bounded by
 *              lock_timeout 60 s, after which the attempt fails loudly and the next open retries only
 *              this phase), a CATCH-UP pass for whatever live (possibly older-version) writers did during
 *              the copy (rows changed, inserted, deleted; new dangling rows quarantined), a row-count
 *              equality check (old = new + quarantined) that aborts the swap on any mismatch, then the
 *              renames:  edges -> edges_pre_pk,  edges_next -> edges  (+ index renames), and the layout
 *              stamp.
 *   5. KEEP    the old table is NOT dropped - it is the rollback. After verifying, call
 *              {@link dropPrePkEdges} (or `DROP TABLE edges_pre_pk`); it costs only disk and nothing reads
 *              or writes it. Backups skip it (postgresBackupDiscovery.ts).
 *
 * QUARANTINE: `edges_dangling` keeps the full legacy row (text ids, provenance) plus which endpoint was
 * missing and when. It has a workspace_id, so the logical backup lane includes it. Nothing reads it; an
 * operator can re-link a row by hand if the missing node comes back.
 *
 * LIMITS: the copy needs room for a second, smaller copy of the table until the old one is dropped; the
 * swap holds a table lock for the catch-up scans (seconds for a million rows); statement_timeout is
 * raised for the index builds and the swap only (the pool default is 30 s).
 */
import type { PoolClient } from 'pg';

import { log } from '../../logger.js';
import { EDGE_PRIMARY_KEY_COLUMNS, edgeLayoutStampDdl, edgeReferenceCommentDdl, edgeTableDdl, legacyEdgeColumnsDdl } from './postgresEdgeSchema.js';

const BATCH_SIZE = 20_000;

export interface EdgePkMigrationOptions {
    /** Rows per copy transaction (default 20000). */
    batchSize?: number;
    /** Test seam: stop (return 'paused') after this many copy batches, as a crash would. */
    maxBatches?: number;
    /** Test seam: runs between the copy/index phases and the swap (simulates live writers). */
    beforeSwap?: (client: PoolClient) => Promise<void>;
}

export interface EdgePkMigrationResult {
    status: 'migrated' | 'paused';
    /** Rows now in the quarantine table `edges_dangling` (those found while migrating). */
    quarantined: number;
    /** Rows in the new `edges` table after the swap. */
    edges: number;
}

const DANGLING_DDL = `CREATE TABLE IF NOT EXISTS edges_dangling (
    workspace_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    relation TEXT NOT NULL,
    confidence TEXT,
    "confidenceScore" DOUBLE PRECISION,
    origin TEXT,
    policy_version TEXT,
    model_fingerprint TEXT,
    created_at TIMESTAMPTZ,
    valid_to TIMESTAMPTZ,
    missing_endpoint TEXT NOT NULL,
    quarantined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, source_id, target_id, relation)
)`;

const NEW_COLS = 'workspace_id, src_sk, dst_sk, relation, confidence, "confidenceScore", origin, policy_version, model_fingerprint, created_at, valid_to';
const DANGLING_COLS = 'workspace_id, source_id, target_id, relation, confidence, "confidenceScore", origin, policy_version, model_fingerprint, created_at, valid_to, missing_endpoint';
const VALUE_COLS = ['confidence', '"confidenceScore"', 'origin', 'policy_version', 'model_fingerprint', 'created_at', 'valid_to'];

/** `old` rows with both endpoints resolved through nodes (text ids -> sk). */
const RESOLVED_OLD = `SELECT o.workspace_id, s.sk AS ssk, t.sk AS dsk, o.relation, o.confidence, o."confidenceScore", o.origin,
        o.policy_version, o.model_fingerprint, o.created_at, o.valid_to
    FROM edges o
    JOIN nodes s ON s.workspace_id = o.workspace_id AND s.id = o.source_id
    JOIN nodes t ON t.workspace_id = o.workspace_id AND t.id = o.target_id`;

const MISSING_EXPR = `CASE WHEN s.sk IS NULL AND t.sk IS NULL THEN 'both' WHEN s.sk IS NULL THEN 'source' ELSE 'target' END`;
const UNRESOLVED_FROM = `FROM edges o
    LEFT JOIN nodes s ON s.workspace_id = o.workspace_id AND s.id = o.source_id
    LEFT JOIN nodes t ON t.workspace_id = o.workspace_id AND t.id = o.target_id
    WHERE s.sk IS NULL OR t.sk IS NULL`;

async function inTx<T>(client: PoolClient, fn: () => Promise<T>, timeouts?: { statement: string; lock?: string }): Promise<T> {
    await client.query('BEGIN');
    try {
        if (timeouts) {
            await client.query(`SET LOCAL statement_timeout = '${timeouts.statement}'`);
            if (timeouts.lock) await client.query(`SET LOCAL lock_timeout = '${timeouts.lock}'`);
        }
        const out = await fn();
        await client.query('COMMIT');
        return out;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
    }
}

/** One copy batch. Returns rows scanned (0 = done) and how many were quarantined. */
async function copyBatch(client: PoolClient, batchSize: number): Promise<{ n: number; q: number }> {
    return inTx(client, async () => {
        const p = (await client.query<{ ws: string | null; src: string | null; dst: string | null; rel: string | null }>(
            'SELECT ws, src, dst, rel FROM edges_pk_progress WHERE id = 1 FOR UPDATE',
        )).rows[0]!;
        const after = p.ws === null ? '' : 'WHERE (e.workspace_id, e.source_id, e.target_id, e.relation) > ($2, $3, $4, $5)';
        const params: unknown[] = [batchSize, ...(p.ws === null ? [] : [p.ws, p.src, p.dst, p.rel])];
        const res = await client.query<{ n: number; q: number; lw: string | null; ls: string | null; lt: string | null; lr: string | null }>(
            `WITH b AS (
                 SELECT e.* FROM edges e ${after}
                 ORDER BY e.workspace_id, e.source_id, e.target_id, e.relation LIMIT $1),
             r AS (
                 SELECT b.*, s.sk AS ssk, t.sk AS dsk FROM b
                 LEFT JOIN nodes s ON s.workspace_id = b.workspace_id AND s.id = b.source_id
                 LEFT JOIN nodes t ON t.workspace_id = b.workspace_id AND t.id = b.target_id),
             good AS (
                 INSERT INTO edges_next (${NEW_COLS})
                 SELECT workspace_id, ssk, dsk, relation, confidence, "confidenceScore", origin, policy_version, model_fingerprint, created_at, valid_to
                 FROM r WHERE ssk IS NOT NULL AND dsk IS NOT NULL RETURNING 1),
             bad AS (
                 INSERT INTO edges_dangling (${DANGLING_COLS})
                 SELECT workspace_id, source_id, target_id, relation, confidence, "confidenceScore", origin, policy_version, model_fingerprint, created_at, valid_to,
                        CASE WHEN ssk IS NULL AND dsk IS NULL THEN 'both' WHEN ssk IS NULL THEN 'source' ELSE 'target' END
                 FROM r WHERE ssk IS NULL OR dsk IS NULL ON CONFLICT DO NOTHING RETURNING 1),
             last_row AS (
                 SELECT workspace_id, source_id, target_id, relation FROM b
                 ORDER BY workspace_id DESC, source_id DESC, target_id DESC, relation DESC LIMIT 1)
             SELECT (SELECT count(*) FROM b)::int AS n,
                    (SELECT count(*) FROM bad)::int AS q,
                    (SELECT workspace_id FROM last_row) AS lw, (SELECT source_id FROM last_row) AS ls,
                    (SELECT target_id FROM last_row) AS lt, (SELECT relation FROM last_row) AS lr`,
            params,
        );
        const row = res.rows[0]!;
        if (row.n > 0) {
            await client.query('UPDATE edges_pk_progress SET ws = $1, src = $2, dst = $3, rel = $4 WHERE id = 1', [row.lw, row.ls, row.lt, row.lr]);
        }
        return { n: row.n, q: row.q };
    });
}

/** @returns status 'migrated' once the swap committed, 'paused' only when `maxBatches` (a test seam) stopped the copy. */
export async function migrateEdgesToSurrogatePk(client: PoolClient, opts: EdgePkMigrationOptions = {}): Promise<EdgePkMigrationResult> {
    const batchSize = opts.batchSize ?? BATCH_SIZE;
    if ((await client.query(`SELECT to_regclass('edges_pre_pk') AS t`)).rows[0]?.t) {
        throw new Error('edge pk migration: edges_pre_pk already exists - drop or rename it first (refusing to overwrite a rollback copy)');
    }

    // 0. the legacy table may predate the provenance columns the copy names (a no-op when it already has them)
    for (const ddl of legacyEdgeColumnsDdl()) await client.query(ddl);

    // 1. STAGE
    await client.query(edgeTableDdl('edges_next'));
    await client.query(DANGLING_DDL);
    await client.query(`CREATE TABLE IF NOT EXISTS edges_pk_progress (
        id INTEGER PRIMARY KEY CHECK (id = 1), ws TEXT, src TEXT, dst TEXT, rel TEXT)`);
    await client.query('INSERT INTO edges_pk_progress (id) VALUES (1) ON CONFLICT DO NOTHING');

    // 2. COPY
    let batches = 0;
    let copied = 0;
    for (;;) {
        if (opts.maxBatches !== undefined && batches >= opts.maxBatches) {
            return { status: 'paused', quarantined: 0, edges: copied };
        }
        const { n } = await copyBatch(client, batchSize);
        if (n === 0) break;
        batches++;
        copied += n;
        if (batches % 25 === 0) log.info(`[edge-pk-migration] scanned ${copied} legacy edges`);
    }

    // 3. INDEX (sorted builds; idempotent so a crash here resumes)
    await inTx(client, async () => {
        await client.query(`DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'edges_next'::regclass AND contype = 'p') THEN
        ALTER TABLE edges_next ADD PRIMARY KEY (${EDGE_PRIMARY_KEY_COLUMNS});
    END IF;
END $$`);
        await client.query('CREATE INDEX IF NOT EXISTS edges_next_dst_sk ON edges_next(dst_sk)');
        await client.query('CREATE INDEX IF NOT EXISTS edges_next_relation ON edges_next(workspace_id, relation)');
        for (const stmt of edgeReferenceCommentDdl('edges_next')) await client.query(stmt);
    }, { statement: '3600s' });
    if (opts.beforeSwap) await opts.beforeSwap(client);

    // 4. SWAP
    const swapped = await swap(client);
    log.info(
        `[edge-pk-migration] done: ${swapped.edges} edges in the new layout, ${swapped.quarantined} dangling legacy edges quarantined in edges_dangling; `
        + 'old table kept as edges_pre_pk (dropPrePkEdges / DROP TABLE after verifying)',
    );
    return { status: 'migrated', ...swapped };
}

async function swap(client: PoolClient): Promise<{ quarantined: number; edges: number }> {
    return inTx(client, async () => {
        await client.query('LOCK TABLE edges IN ACCESS EXCLUSIVE MODE');

        // CATCH-UP: reconcile edges_next with what the old table holds NOW (writers ran during the copy).
        const changed = VALUE_COLS.map((c) => `n.${c} IS DISTINCT FROM o.${c}`).join(' OR ');
        await client.query(
            `UPDATE edges_next n SET ${VALUE_COLS.map((c) => `${c} = o.${c}`).join(', ')}
               FROM (${RESOLVED_OLD}) o
              WHERE n.workspace_id = o.workspace_id AND n.src_sk = o.ssk AND n.dst_sk = o.dsk AND n.relation = o.relation AND (${changed})`,
        );
        await client.query(
            `INSERT INTO edges_next (${NEW_COLS})
             SELECT o.workspace_id, o.ssk, o.dsk, o.relation, o.confidence, o."confidenceScore", o.origin, o.policy_version, o.model_fingerprint, o.created_at, o.valid_to
               FROM (${RESOLVED_OLD}) o
              WHERE NOT EXISTS (SELECT 1 FROM edges_next n WHERE n.workspace_id = o.workspace_id AND n.src_sk = o.ssk AND n.dst_sk = o.dsk AND n.relation = o.relation)`,
        );
        await client.query(
            `DELETE FROM edges_next n WHERE NOT EXISTS (
                 SELECT 1 FROM edges o
                   JOIN nodes s ON s.workspace_id = o.workspace_id AND s.id = o.source_id
                   JOIN nodes t ON t.workspace_id = o.workspace_id AND t.id = o.target_id
                  WHERE o.workspace_id = n.workspace_id AND s.sk = n.src_sk AND t.sk = n.dst_sk AND o.relation = n.relation)`,
        );
        await client.query(
            `INSERT INTO edges_dangling (${DANGLING_COLS})
             SELECT o.workspace_id, o.source_id, o.target_id, o.relation, o.confidence, o."confidenceScore", o.origin, o.policy_version,
                    o.model_fingerprint, o.created_at, o.valid_to, ${MISSING_EXPR}
               ${UNRESOLVED_FROM} ON CONFLICT DO NOTHING`,
        );
        const counts = (await client.query<{ o: string; n: string; u: string }>(
            `SELECT (SELECT count(*) FROM edges) AS o, (SELECT count(*) FROM edges_next) AS n,
                    (SELECT count(*) FROM (SELECT 1 ${UNRESOLVED_FROM}) x) AS u`,
        )).rows[0]!;
        if (BigInt(counts.o) !== BigInt(counts.n) + BigInt(counts.u)) {
            throw new Error(
                `edge pk migration: row count mismatch after catch-up (old ${counts.o}, new ${counts.n}, quarantined ${counts.u}) - swap aborted, nothing changed`,
            );
        }

        // Old indexes out of the way, then the tables, then the new indexes into the canonical names.
        await client.query('ALTER INDEX IF EXISTS edges_pkey RENAME TO edges_pre_pk_pkey');
        for (const idx of ['idx_edges_src_sk', 'idx_edges_dst_sk', 'idx_edges_sk_pending', 'idx_edges_relation']) {
            await client.query(`ALTER INDEX IF EXISTS ${idx} RENAME TO ${idx}_pre_pk`);
        }
        await client.query('ALTER TABLE edges RENAME TO edges_pre_pk');
        await client.query('ALTER TABLE edges_next RENAME TO edges');
        await client.query('ALTER INDEX edges_next_pkey RENAME TO edges_pkey');
        await client.query('ALTER INDEX edges_next_dst_sk RENAME TO idx_edges_dst_sk');
        await client.query('ALTER INDEX edges_next_relation RENAME TO idx_edges_relation');
        await client.query(edgeLayoutStampDdl('edges'));
        await client.query('DROP TABLE edges_pk_progress');
        return { quarantined: Number(counts.u), edges: Number(counts.n) };
    }, { statement: '3600s', lock: '60s' });
}

/** Ops helper: drop the rollback copy left by a finished migration. Returns false when there is none. */
export async function dropPrePkEdges(client: Pick<PoolClient, 'query'>): Promise<boolean> {
    const has = await client.query(`SELECT to_regclass('edges_pre_pk') AS t`);
    if (!has.rows[0]?.t) return false;
    await client.query('DROP TABLE edges_pre_pk');
    return true;
}
