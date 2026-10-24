/**
 * postgres/postgresGraphRow.ts — row ⇄ LoreNode-document mapping + the small
 * SQL helpers every postgres graph slice shares.
 *
 * MIRRORS `engines/sqlite/sqliteGraphRow.ts` without forking it: the node
 * document shape, the write-column list, the outcome-counter seed and the
 * two-direction mapping are byte-identical there because the postgres DDL
 * (postgresGraphSchema.ts) mirrors the SQLite schema column-for-column. The
 * JSON-text columns (`tags`, `security_scopes`) parse in postgres exactly as
 * in sqlite — `fromSqliteNodeRow` is pure JS over a `Record<string, unknown>`
 * row, so it IS the postgres row mapper too; it is re-exported here under a
 * pg-side name so call sites read naturally and nothing drifts.
 *
 * What IS postgres-specific here:
 *   - `pgQuoteIdent` — the DDL quotes every mixed-case column
 *     (`"updatedAt"`, `"createdAt"`, …); unquoted identifiers would fold to
 *     lower-case and the ported row mappers read the exact SQLite names.
 *   - `PgParams` — numbered `$n` placeholders with one `values` array, the
 *     postgres counterpart of the sqlite `?, ?` positional discipline.
 *   - `chunkIds` — the 256-id IN-chunk cap, same constant as the sqlite
 *     reads' CHUNK_SIZE, applied to `= ANY($n)` batches.
 */

import { assertIdent } from '../whereClause.js';
import { LoreGraphError } from '../loreGraphError.js';

// The engine-neutral node document mapping is shared verbatim — see the file
// header. The write-column list, outcome-counter seed and toNodeRow are
// re-exported (not re-implemented) so parity holds by construction;
// `fromPgNodeRow` (below) wraps the shared row parser.
export {
    SQLITE_OUTCOME_COUNTER_SEED as OUTCOME_COUNTER_SEED,
    fromSqliteNodeRow,
} from '../sqlite/sqliteGraphRow.js';
import {
    fromSqliteNodeRow,
    NODE_WRITE_COLUMNS as SHARED_NODE_WRITE_COLUMNS,
    toNodeRow as sharedToNodeRow,
} from '../sqlite/sqliteGraphRow.js';
import { toPgTimestamp } from './postgresAsOfSchema.js';
import type { Pool, PoolClient } from 'pg';

export type { Pool, PoolClient };

/**
 * The postgres write-column list: the shared SQLite-mirrored list plus the two
 * derived TIMESTAMPTZ valid-time columns (postgresAsOfSchema.ts), so every
 * write path that iterates this list (single, update, conditional, replay,
 * insert-if-absent, importRaw, node batch) fills them with no extra code.
 */
export const NODE_WRITE_COLUMNS = [...SHARED_NODE_WRITE_COLUMNS, 'valid_from_at', 'valid_until_at'] as const;

/** `toNodeRow` + the derived `valid_from_at` / `valid_until_at` (null when the text bound is unset or unparseable). */
export function toNodeRow(
    ...args: Parameters<typeof sharedToNodeRow>
): ReturnType<typeof sharedToNodeRow> & { valid_from_at: string | null; valid_until_at: string | null } {
    const doc = sharedToNodeRow(...args);
    return { ...doc, valid_from_at: toPgTimestamp(doc.validFrom), valid_until_at: toPgTimestamp(doc.validUntil) };
}

/** Anything that can run one parameterised statement: the pool or a client inside a transaction. */
export type PgQueryable = Pool | PoolClient;

/** Minimal shape of a pg result row as this engine consumes it (the pg driver types rows as `any[]`; the shared mapper wants a record). */
export type PgRow = Record<string, unknown>;

/**
 * pgQuoteIdent — validate with the SHARED `assertIdent` (the SP-05/SW-01
 * regression suites match its error message), then double-quote. Mixed-case
 * SQLite-named columns (`createdAt`, `updatedAt`, `validFrom`, …) must stay
 * quoted everywhere they appear in SQL text.
 */
export function pgQuoteIdent(name: string): string {
    return `"${assertIdent(name)}"`;
}

/**
 * PgParams — numbered-placeholder builder. `add()` returns the next `$n`, so
 * SQL text and the values array are built in the same pass and can never
 * misalign (the failure mode the sqlite reads' two-arrays comment documents
 * for positional `?` placeholders).
 */
export class PgParams {
    readonly values: unknown[] = [];

    add(value: unknown): string {
        this.values.push(value);
        return `$${this.values.length}`;
    }

    /** Add several values at once; returns their placeholders joined with ', '. */
    addAll(values: readonly unknown[]): string {
        return values.map((v) => this.add(v)).join(', ');
    }
}

/**
 * Columns the frozen DDL (postgresGraphSchema.ts) declared WITHOUT quotes, so
 * Postgres folded them to lowercase at CREATE TABLE time — while its header
 * claims "the ported row mappers read the exact SQLite names". This is a bug
 * in that frozen infra file (left as-is: renaming physical columns is a schema migration). Queries here target the
 * PHYSICAL columns: lowercase for the folded set, double-quoted otherwise.
 */
const FOLDED_COLUMNS: ReadonlySet<string> = new Set([
    'syncedAt', 'supersededBy', 'supersededAt', 'supersededReason', 'lastAccessedAt',
]);

/** Folded columns' physical (lowercase) name, for `information_schema` checks and row keys. */
const FOLDED_TO_PHYSICAL: Readonly<Record<string, string>> = {
    syncedat: 'syncedAt',
    supersededby: 'supersededBy',
    supersededat: 'supersededAt',
    supersededreason: 'supersededReason',
    lastaccessedat: 'lastAccessedAt',
};

/**
 * pgColumn — the SQL text for one `nodes` column whose SQLite-side name is
 * `name`: double-quoted (via the validating {@link pgQuoteIdent}) for the
 * mixed-case columns the DDL quoted, bare lowercase for the folded set.
 */
export function pgColumn(name: string): string {
    return FOLDED_COLUMNS.has(name) ? name.toLowerCase() : pgQuoteIdent(name);
}

/**
 * fromPgNodeRow — a raw `nodes` row to the engine-neutral document shape:
 * first renames the folded lowercase columns back to the SQLite names every
 * shared mapper reads, then applies the SHARED JSON-text parsing
 * (`fromSqliteNodeRow`) for `tags`/`security_scopes`.
 */
export function fromPgNodeRow(row: Record<string, unknown>): Record<string, unknown> {
    let renamed: Record<string, unknown> | null = null;
    for (const key of Object.keys(row)) {
        const camel = FOLDED_TO_PHYSICAL[key];
        if (camel === undefined) continue;
        if (renamed === null) renamed = { ...row };
        renamed[camel] = row[key];
    }
    return fromSqliteNodeRow(renamed ?? row);
}

/** Same 256-id chunk as the sqlite reads — one round-trip per chunk on id-list reads. */
export const PG_CHUNK_SIZE = 256;

export function chunkIds(ids: readonly string[]): string[][] {
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += PG_CHUNK_SIZE) chunks.push(ids.slice(i, i + PG_CHUNK_SIZE));
    return chunks;
}

export function pgError(message: string, operation: string, error: unknown): LoreGraphError {
    return new LoreGraphError(message, operation, error);
}

/**
 * isUniqueViolation — pg surfaces a rejected PRIMARY KEY / UNIQUE constraint
 * as SQLSTATE `23505` (unique_violation). This is the postgres counterpart
 * of the sqlite insert's `SQLITE_CONSTRAINT + /UNIQUE|PRIMARY KEY/` test that
 * `insertNodeIfAbsent` translates into NodeAlreadyExistsError.
 */
export function isUniqueViolation(err: unknown): boolean {
    const e = err as { code?: unknown; message?: unknown } | null | undefined;
    return typeof e?.code === 'string' && e.code === '23505';
}
