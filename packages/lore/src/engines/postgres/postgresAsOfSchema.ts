/**
 * postgresAsOfSchema.ts - Postgres engine: real date columns for valid time.
 *
 * `nodes."validFrom"` / `"validUntil"` stay TEXT ('' = unset): that is the
 * lossless round-trip of whatever string the caller wrote, and the column set
 * every shared row mapper reads. Next to them sit two additive, plain
 * TIMESTAMPTZ columns the "as of" SQL predicate runs on:
 *
 *   valid_from_at   <- "validFrom"   (NULL = no start bound)
 *   valid_until_at  <- "validUntil"  (NULL = no end bound, i.e. still valid)
 *
 * BOUNDARY RULE (identical to `isValidAsOf` in core/temporalQuery.ts and to
 * the SQLite engine, which has no SQL predicate and applies that function):
 * a node is valid at instant `at` iff
 *     (valid_from_at  IS NULL OR valid_from_at  <= at)
 * AND (valid_until_at IS NULL OR valid_until_at >= at)
 * i.e. BOTH ends are INCLUSIVE. A node with neither bound is always valid.
 *
 * The derived value is computed in JS with the same `Date.parse` that
 * `isValidAsOf` uses ({@link toPgTimestamp}), so a stored string that does not
 * parse is NULL here exactly as it is "absent" there. Every write path fills
 * the pair (postgresGraphRow's write columns + the supersede UPDATEs);
 * {@link backfillValidTimeColumns} fills rows written before this existed.
 *
 * Everything here is additive and idempotent and runs inside
 * `runSchemaBootstrap` (advisory-locked, autocommitted statements).
 */
import type { PoolClient } from 'pg';

/** Idempotent DDL. Plain columns + plain btree indexes only (Dataplane-compatible layout). */
export function asOfSchemaDdl(): string[] {
    return [
        `ALTER TABLE nodes
            ADD COLUMN IF NOT EXISTS valid_from_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS valid_until_at TIMESTAMPTZ`,
        // Serves the as-of predicate for one workspace (workspace_id leading).
        'CREATE INDEX IF NOT EXISTS idx_nodes_valid_at ON nodes(workspace_id, valid_from_at, valid_until_at)',
        // Tiny: holds only rows whose text bound has no timestamp yet, so the backfill's "anything left?" probe never scans the table.
        `CREATE INDEX IF NOT EXISTS idx_nodes_valid_at_pending ON nodes(workspace_id, id)
            WHERE ("validFrom" <> '' AND valid_from_at IS NULL) OR ("validUntil" <> '' AND valid_until_at IS NULL)`,
    ];
}

/**
 * The TIMESTAMPTZ-bound form of a stored valid-time string: a canonical ISO
 * string (ms precision, UTC) or null when the value is unset/unparseable.
 * Same parse as `isValidAsOf`. Years outside 0001-9999 are treated as
 * unparseable (Postgres' range is wider but the ISO form differs).
 */
export function toPgTimestamp(value: unknown): string | null {
    if (typeof value !== 'string' || value === '') return null;
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) return null;
    const iso = new Date(ms).toISOString();
    return /^\d{4}-/.test(iso) ? iso : null;
}

const BACKFILL_BATCH = 5_000;

/**
 * Fill `valid_from_at` / `valid_until_at` for ONE workspace's rows written before the columns existed.
 *
 * Scoped to `workspaceId` on purpose: this runs in the schema bootstrap of every handle open, and a whole-database
 * pass would make the first open of any workspace walk every other workspace's rows too (and one database will hold
 * many workspaces, possibly on many shards). Each workspace backfills its own rows when it is opened; the as-of
 * predicate only ever runs inside one workspace (`workspace_id = $1`), so nothing reads another workspace's timestamps.
 *
 * Keyset-batched on (workspace_id = $ws, id), each batch its own autocommitted statement, served by the partial
 * `idx_nodes_valid_at_pending (workspace_id, id)`; the UPDATE re-checks the text it read, so a concurrent write is
 * never overwritten with a stale derivation. Rows whose text does not parse stay NULL (matching the JS predicate) and
 * are skipped by the keyset, so the loop always ends. Idempotent: a second run finds nothing pending. Returns rows updated.
 */
export async function backfillValidTimeColumns(
    client: Pick<PoolClient, 'query'>,
    workspaceId: string,
    batch: number = BACKFILL_BATCH,
): Promise<number> {
    if (typeof workspaceId !== 'string' || workspaceId === '') throw new Error('backfillValidTimeColumns: workspaceId is required');
    let total = 0;
    let lastId = '';
    let first = true;
    for (;;) {
        const res = await client.query<{ id: string; vf: string; vu: string }>(
            `SELECT id, "validFrom" AS vf, "validUntil" AS vu FROM nodes
             WHERE workspace_id = $1
               AND (("validFrom" <> '' AND valid_from_at IS NULL) OR ("validUntil" <> '' AND valid_until_at IS NULL))
               AND ($2::boolean OR id > $3)
             ORDER BY id LIMIT $4`,
            [workspaceId, first, lastId, batch],
        );
        first = false;
        if (res.rows.length === 0) return total;
        lastId = res.rows[res.rows.length - 1]!.id;
        const rows = res.rows.map((r) => ({ r, f: toPgTimestamp(r.vf), u: toPgTimestamp(r.vu) }))
            .filter((x) => x.f !== null || x.u !== null);
        if (rows.length > 0) {
            const upd = await client.query(
                `UPDATE nodes n SET valid_from_at = v.f, valid_until_at = v.u
                 FROM unnest($2::text[], $3::text[], $4::text[], $5::timestamptz[], $6::timestamptz[])
                      AS v(id, vf, vu, f, u)
                 WHERE n.workspace_id = $1 AND n.id = v.id AND n."validFrom" = v.vf AND n."validUntil" = v.vu`,
                [
                    workspaceId, rows.map((x) => x.r.id),
                    rows.map((x) => x.r.vf), rows.map((x) => x.r.vu),
                    rows.map((x) => x.f), rows.map((x) => x.u),
                ],
            );
            total += upd.rowCount ?? 0;
        }
        if (res.rows.length < batch) return total;
    }
}
