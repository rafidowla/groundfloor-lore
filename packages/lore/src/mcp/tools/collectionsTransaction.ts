/**
 * Shared handler and MCP registration for typed table transactions.
 * REST imports the same handler so both surfaces keep identical semantics.
 *
 * FILTER SHAPE — SOURCE OF TRUTH: `filterZ` below is intentionally
 * LEAF-ONLY (eq/contains/startsWith/gt/gte/lt/lte/in — no and/or/not).
 * `contracts/tables.ts`'s `TableOp` types `update`/`delete` filters as the
 * broader recursive `FilterNode` (which also permits `and`/`or`/`not`),
 * but THIS file's zod schema is what `collection_transaction` and
 * `POST /v1/transaction` actually accept at the wire — a nested boolean
 * filter is rejected by zod before it ever reaches a `TableOp`. That gap
 * is deliberate, not an oversight: no caller of this tool has needed
 * nested filters inside a transaction op, and widening `filterZ` to
 * `filterNodeZ` (collectionsFilterSchema.ts) would need auditing every
 * downstream consumer of `assertValidFilter`/`classifyFilterScope` below
 * for depth/AND/OR edge cases that don't currently apply here. If a real
 * need for nested filters in a transaction op shows up, widen `filterZ`
 * to `filterNodeZ` and re-run this file's regression tests. Note that
 * `filterNodeZ` is ALSO not `.strict()` today (same silent-strip class of
 * bug this round fixed here) — widening to it would need that fixed too.
 *
 * QA round-2 (2026-09-03) — the "rejected by zod" claim above used to be
 * FALSE: `filterZ` was a plain (non-strict) `z.object`, and zod's default
 * behavior for an unrecognized key is to silently STRIP it, not throw. A
 * filter like `{and:[{eq:{id:'r1'}}], eq:{status:'closed'}}` parsed
 * successfully with `and` silently dropped, leaving only
 * `{eq:{status:'closed'}}` — a MUCH BROADER match than the caller wrote
 * (every closed row, not just id `r1`), applied with no error at all.
 * `filterZ` is now `.strict()` so any unrecognized key (`and`/`or`/`not`,
 * or a typo) throws a `ZodError` before `runTransaction` ever sees the op —
 * `describeTransactionFailure` below turns that into a 400 `filter_invalid`
 * naming the op index and the offending key(s).
 *
 * QA finding B2 (2026-09-03) — because a transaction op's filter is
 * ALWAYS a leaf `Filter` at runtime (zod guarantees it), the
 * `assertValidFilter`/`refuseAllFilter` pairing below (see `refuseAllFilter`)
 * only ever exercises `classifyLeafScope`'s branch of `classifyFilterScope`,
 * never the and/or/not branches. It is still real defense-in-depth: it
 * refuses an empty/ALL filter — same `all: true` opt-in as
 * `collection_update_by_query`/`collection_delete_by_query` (X-allrows,
 * 2026-09-03, widened all three from an unconditional refusal) — with a
 * clean, typed error BEFORE `runTransaction` starts mutating anything,
 * instead of relying on `updateSqliteTableRows`/`deleteSqliteTableRows`'s
 * own empty-where guard deep inside the SQL layer (whose messages differ
 * from each other, which is exactly why a
 * dedicated pre-check produces one consistent error shape here).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Filter, FilterNode } from '../../engines/collectionStorage.js';
import type { Row, TableOp, TableOpResult } from '../../contracts/tables.js';
import { MAX_TABLE_TX_OPS } from '../../contracts/tables.js';
import type { McpScopeMode } from './mcpScope.js';
import { getIntrospectableSchema, type CollectionsDeps } from './collections.js';
import { CollectionValidationError, validateRowAgainstSchema } from '../../engines/collectionRowValidation.js';
import { assertValidFilter } from './collectionsFilterScope.js';
import { isPayloadTooLarge, MAX_BODY_BYTES, PAYLOAD_TOO_LARGE } from '../http/helpers.js';

// QA round-2 (2026-09-03) — `.strict()` so an unrecognized key (and/or/not,
// or a typo) REJECTS with a ZodError instead of zod's default silent strip.
// See the file header for the full story.
const filterZ = z.object({
    eq: z.record(z.string(), z.unknown()).optional(),
    contains: z.record(z.string(), z.string()).optional(),
    startsWith: z.record(z.string(), z.string()).optional(),
    gt: z.record(z.string(), z.unknown()).optional(),
    gte: z.record(z.string(), z.unknown()).optional(),
    lt: z.record(z.string(), z.unknown()).optional(),
    lte: z.record(z.string(), z.unknown()).optional(),
    in: z.record(z.string(), z.array(z.unknown())).optional(),
}).strict();

const rowZ = z.record(z.string(), z.unknown());
// X-allrows (2026-09-03) — `all` mirrors collection_update/collection_delete's
// opt-in: confirms an unscoped update/delete, INCLUDING a filter that is only
// SCOPED "by construction" but data-dependently matches every row of a >1-row
// table (see the storage-layer check in engines/sqliteTableTransaction.ts).
const allOptZ = z.boolean().optional();
const operationZ = z.discriminatedUnion('op', [
    z.object({ op: z.literal('insert'), collection: z.string().min(1), row: rowZ }),
    z.object({ op: z.literal('update'), collection: z.string().min(1), filter: filterZ, patch: rowZ, all: allOptZ }),
    z.object({ op: z.literal('delete'), collection: z.string().min(1), filter: filterZ, all: allOptZ }),
    z.object({ op: z.literal('upsert'), collection: z.string().min(1), row: rowZ }),
]);

export const tableTransactionBodyZ = z.object({
    operations: z.array(operationZ).min(1).max(MAX_TABLE_TX_OPS),
});

/**
 * `assertValidFilter` alone only refuses a STRUCTURALLY invalid filter
 * (an and/or with no branches, or over-deep nesting) — it deliberately
 * does not refuse a merely-empty/ALL filter, since some callers
 * (`collection_update`/`collection_delete`) allow that via an explicit
 * `all: true` opt-in.
 *
 * X-allrows (2026-09-03) — a `TableOp` now carries that same `all` opt-in
 * (see `operationZ` above), so a transaction `update`/`delete` allows an
 * ALL filter under the identical `all: true` confirmation as
 * `collection_update`/`collection_delete` — it is no longer an
 * unconditional refusal. The storage layer's OWN data-aware tautology
 * check (engines/sqliteTableTransaction.ts) independently requires the
 * same `all: true` for a filter that is merely SCOPED by construction but
 * matches every row of a >1-row table by data; that check runs regardless
 * of what happens here. The thrown message deliberately contains
 * "empty/all filter" so `describeTransactionFailure`'s regex classifies
 * it as 400 `all_filter_refused`, matching every other all-filter refusal
 * on this surface.
 */
function refuseAllFilter(kind: 'update' | 'delete', index: number, filter: FilterNode | undefined, all: boolean | undefined): void {
    const scope = assertValidFilter(`transaction op ${index} (${kind})`, filter);
    if (all !== true && scope === 'ALL') {
        throw new Error(
            `transaction op ${index} (${kind}) refuses an empty/all filter — pass all:true to `
            + 'confirm an unscoped ' + kind + ', or run collection_truncate outside a transaction '
            + 'to wipe a collection.',
        );
    }
}

/**
 * B2 (QA finding, 2026-09-03) — validate EVERY operation against its
 * declared schema BEFORE `runTransaction` touches storage, so a
 * transaction behaves exactly like `collection_insert`/`collection_update`/
 * `collection_bulk_insert`/`collection_update_by_query`: an unknown
 * column, a wrong-typed value, or an empty/ALL filter is rejected as a
 * clean `CollectionValidationError`/filter error with NOTHING applied,
 * instead of reaching `SqliteTableStorage.runTransaction` where an
 * unvalidated string/boolean gets silently coerced (or an unknown column
 * surfaces as an opaque 500).
 *
 * All ops are checked up front (not "check op 0, run it, check op 1, …")
 * so an invalid op anywhere in the batch is caught before any op runs —
 * `runTransaction`'s own all-or-nothing SQL transaction would already
 * roll back a mid-batch failure, but pre-validating means we never even
 * ask the storage engine to start.
 *
 * Coordinator finding (2026-09-03, round E2 addendum) — an `upsert` op used
 * to be validated in `'upsert'` mode unconditionally, which (like `'update'`)
 * skips the required-column check because a partial patch is normally fine.
 * But `SqliteTableStorage.runTransaction`'s own upsert handling
 * (sqliteTableTransaction.ts) does an existence probe on the primary key and
 * takes one of two branches: an UPDATE (partial patch, correct to skip the
 * check) when the row already exists, or a real INSERT (needs every required
 * column, same as a plain `insert` op) when it doesn't. Validating every
 * upsert as a partial patch let a fresh-insert upsert missing a required
 * column sail past this pre-check and hit a raw SQLite `NOT NULL constraint
 * failed` deep in the storage layer, with no table/field named. This probes
 * the SAME existence question the storage layer is about to ask (via the
 * public `getByKey`, not the private SQL the storage layer runs) so the
 * validation mode always matches the branch that will actually execute.
 */
async function validateTransactionOps(deps: CollectionsDeps, ops: TableOp[]): Promise<void> {
    for (const [index, op] of ops.entries()) {
        if (op.op === 'insert') {
            const schema = getIntrospectableSchema(deps, op.collection);
            if (schema) validateRowAgainstSchema(schema, op.row, 'insert', index);
        } else if (op.op === 'upsert') {
            const schema = getIntrospectableSchema(deps, op.collection);
            if (schema) {
                const pkColumn = schema.columns.find(c => c.primary)?.name;
                const pkValue = pkColumn === undefined ? undefined : op.row[pkColumn];
                const existing = pkColumn !== undefined && pkValue !== undefined
                    ? await deps.tableStorage.getByKey(op.collection, pkValue)
                    : null;
                validateRowAgainstSchema(schema, op.row, existing ? 'update' : 'insert', index);
            }
        } else if (op.op === 'update') {
            // Partial-patch validation only — same semantics as
            // handleUpdate/handleUpdateByQuery (an update patch need not
            // be non-empty or carry every required column).
            const schema = getIntrospectableSchema(deps, op.collection);
            if (schema) validateRowAgainstSchema(schema, op.patch, 'update', index);
            refuseAllFilter('update', index, op.filter, op.all);
        } else if (op.op === 'delete') {
            refuseAllFilter('delete', index, op.filter, op.all);
        }
    }
}

export async function handleTransaction(
    deps: CollectionsDeps,
    body: unknown,
): Promise<{ results: TableOpResult[] }> {
    const parsed = tableTransactionBodyZ.parse(body);
    const ops = parsed.operations as TableOp[];
    await validateTransactionOps(deps, ops);
    const results = await deps.tableStorage.runTransaction(ops);
    return { results };
}

export interface TransactionFailure {
    status: number;
    code: string;
    message: string;
    failed_op_index?: number;
    reason: string;
    /** Present only for a `CollectionValidationError` (reason: 'invalid_row'). */
    table?: string;
    field?: string;
}

/** Sanitize backend errors while retaining the failed operation and reason. */
export function describeTransactionFailure(error: unknown): TransactionFailure {
    // Coordinator finding (2026-09-03, round E2 addendum) — readJsonBody /
    // readBoundedBody (mcp/http/helpers.ts) throw BEFORE the body ever
    // reaches `tableTransactionBodyZ.parse`: a structured
    // `{code: PAYLOAD_TOO_LARGE}` error when a POST /v1/transaction body
    // exceeds MAX_BODY_BYTES, or a plain `Error('invalid JSON body: ...')`
    // on malformed JSON. Both used to fall all the way through to the
    // generic `transaction_failed` branch below, losing the 413 status
    // every sibling /v1/{collection} route already gives via
    // classifyStorageErr's `isPayloadTooLarge` check, and losing the parse
    // detail on malformed JSON. Check them first, in the same order/shape
    // classifyStorageErr uses (mcp/http/routes/collections.ts).
    if (isPayloadTooLarge(error)) {
        return {
            status: 413,
            code: PAYLOAD_TOO_LARGE,
            message: `request body exceeded ${MAX_BODY_BYTES} bytes`,
            reason: PAYLOAD_TOO_LARGE,
        };
    }
    if (error instanceof Error && /^invalid JSON body:/i.test(error.message)) {
        return {
            status: 400,
            code: 'invalid_json_body',
            message: error.message,
            reason: 'invalid_json_body',
        };
    }
    if (error instanceof z.ZodError) {
        // QA round-2 (2026-09-03) — filterZ is now `.strict()` (see the file
        // header), so an and/or/not (or any other unknown key) inside a
        // transaction op's filter surfaces here as an `unrecognized_keys`
        // issue instead of a silent strip. Name the op index and the
        // offending key(s) instead of the generic "1–100 operations"
        // message below, and reuse the `filter_invalid` code the REST/MCP
        // surfaces already use for a structurally-invalid filter
        // (collectionsFilterScope.ts) so a caller gets one consistent code
        // for "this filter shape is not accepted" across every surface.
        const filterKeyIssue = error.issues.find(
            (issue) => issue.code === 'unrecognized_keys'
                && issue.path.length === 3
                && issue.path[0] === 'operations'
                && issue.path[2] === 'filter',
        );
        if (filterKeyIssue && filterKeyIssue.code === 'unrecognized_keys') {
            const opIndex = filterKeyIssue.path[1] as number;
            const keys = filterKeyIssue.keys.map((k) => `"${k}"`).join(', ');
            return {
                status: 400,
                code: 'filter_invalid',
                message: `transaction op ${opIndex} refuses a filter with unsupported key(s) ${keys} `
                    + '— collection_transaction filters are leaf-only (eq/contains/startsWith/gt/gte/'
                    + 'lt/lte/in); nested and/or/not filters are not supported inside a transaction op.',
                reason: 'filter_invalid',
                failed_op_index: opIndex,
            };
        }
        return {
            status: 400,
            code: 'invalid_transaction',
            message: 'transaction body must contain 1–100 valid typed operations',
            reason: 'invalid_request',
        };
    }
    // B2 — a pre-validation failure from validateTransactionOps above.
    // Read table/field/op-index off the error's own properties (same
    // convention `classifyStorageErr` uses for insert/bulk_insert), never
    // parsed out of the message, so the caller gets exact names.
    if (error instanceof CollectionValidationError) {
        return {
            status: 400,
            code: 'invalid_row',
            message: error.message,
            reason: 'invalid_row',
            table: error.table,
            ...(error.field === undefined ? {} : { field: error.field }),
            // reuse the bulk row_index convention: rowIndex carries the
            // failing operation's index within `operations`.
            ...(error.rowIndex === undefined ? {} : { failed_op_index: error.rowIndex }),
        };
    }
    const candidate = error as Error & { failedOpIndex?: number; code?: string };
    const message = candidate?.message ?? '';
    let reason = candidate?.code ?? 'transaction_failed';
    if (/UNIQUE constraint failed|duplicate primary key|duplicated primary key/i.test(message)) {
        reason = 'duplicate_primary_key';
    } else if (/NOT NULL constraint failed/i.test(message)) {
        reason = 'missing_required_field';
    } else if (/empty\/all filter|with no filter|provide a scoping filter/i.test(message)) {
        reason = 'all_filter_refused';
    } else if (/unknown table/i.test(message)) {
        reason = 'collection_not_found';
    }
    const failed = Number.isInteger(candidate?.failedOpIndex)
        ? candidate.failedOpIndex
        : undefined;
    // QA round-3 (2026-09-03, finding A3, low) — this branch used to fold
    // `all_filter_refused` into the same generic `code: 'transaction_failed'`
    // + templated "transaction failed; nothing was applied" message every
    // OTHER reason gets here, throwing away `refuseAllFilter`'s actual,
    // specific wording (which names the op and suggests collection_truncate).
    // Every sibling all-filter refusal on this codebase's REST surface
    // (classifyStorageErr, mcp/http/routes/collections.ts) returns
    // `code === reason === 'all_filter_refused'` with the real thrown
    // message — match that convention here instead of being the one place
    // that discards it.
    if (reason === 'all_filter_refused') {
        return {
            status: 400,
            code: 'all_filter_refused',
            message,
            reason: 'all_filter_refused',
            ...(failed === undefined ? {} : { failed_op_index: failed }),
        };
    }
    return {
        status: reason === 'duplicate_primary_key' ? 409 : 400,
        code: 'transaction_failed',
        message: failed === undefined
            ? 'transaction failed; nothing was applied'
            : `transaction operation ${failed} failed; nothing was applied`,
        ...(failed === undefined ? {} : { failed_op_index: failed }),
        reason,
    };
}

type McpEnvelope = {
    content: Array<{ type: 'text'; text: string }>;
    isError?: true;
};

export interface CollectionTransactionRegistrationHelpers {
    gateWorkspace(args: { workspace?: unknown }, mode: McpScopeMode): McpEnvelope | null;
    resolveDeps(
        deps: CollectionsDeps,
        requested: string,
    ): Promise<{ ok: true; deps: CollectionsDeps } | { ok: false; envelope: McpEnvelope & { isError: true } }>;
}

export function registerCollectionTransactionTool(
    mcpServer: McpServer,
    deps: CollectionsDeps,
    helpers: CollectionTransactionRegistrationHelpers,
): void {
    mcpServer.tool(
        'collection_transaction',
        'Apply 1–100 typed collection writes atomically. All operations commit, or none do.',
        {
            operations: tableTransactionBodyZ.shape.operations,
            workspace: z.string().min(1),
        },
        async (args) => {
            const denied = helpers.gateWorkspace(args, 'write');
            if (denied) return denied;
            const routed = await helpers.resolveDeps(deps, args.workspace as string);
            if (!routed.ok) return routed.envelope;
            try {
                const result = await handleTransaction(routed.deps, { operations: args.operations });
                return {
                    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
                };
            } catch (error) {
                const failure = describeTransactionFailure(error);
                return {
                    content: [{ type: 'text' as const, text: JSON.stringify(failure, null, 2) }],
                    isError: true,
                };
            }
        },
    );
}
