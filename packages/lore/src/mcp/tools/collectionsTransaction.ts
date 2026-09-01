/**
 * Shared handler and MCP registration for typed table transactions.
 * REST imports the same handler so both surfaces keep identical semantics.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Filter } from '../../engines/collectionStorage.js';
import type { Row, TableOp, TableOpResult } from '../../contracts/tables.js';
import { MAX_TABLE_TX_OPS } from '../../contracts/tables.js';
import type { McpScopeMode } from './mcpScope.js';
import type { CollectionsDeps } from './collections.js';

const filterZ = z.object({
    eq: z.record(z.string(), z.unknown()).optional(),
    contains: z.record(z.string(), z.string()).optional(),
    startsWith: z.record(z.string(), z.string()).optional(),
    gt: z.record(z.string(), z.unknown()).optional(),
    gte: z.record(z.string(), z.unknown()).optional(),
    lt: z.record(z.string(), z.unknown()).optional(),
    lte: z.record(z.string(), z.unknown()).optional(),
    in: z.record(z.string(), z.array(z.unknown())).optional(),
});

const rowZ = z.record(z.string(), z.unknown());
const operationZ = z.discriminatedUnion('op', [
    z.object({ op: z.literal('insert'), collection: z.string().min(1), row: rowZ }),
    z.object({ op: z.literal('update'), collection: z.string().min(1), filter: filterZ, patch: rowZ }),
    z.object({ op: z.literal('delete'), collection: z.string().min(1), filter: filterZ }),
    z.object({ op: z.literal('upsert'), collection: z.string().min(1), row: rowZ }),
]);

export const tableTransactionBodyZ = z.object({
    operations: z.array(operationZ).min(1).max(MAX_TABLE_TX_OPS),
});

export async function handleTransaction(
    deps: CollectionsDeps,
    body: unknown,
): Promise<{ results: TableOpResult[] }> {
    const parsed = tableTransactionBodyZ.parse(body);
    const results = await deps.tableStorage.runTransaction(parsed.operations as TableOp[]);
    return { results };
}

export interface TransactionFailure {
    status: number;
    code: string;
    message: string;
    failed_op_index?: number;
    reason: string;
}

/** Sanitize backend errors while retaining the failed operation and reason. */
export function describeTransactionFailure(error: unknown): TransactionFailure {
    if (error instanceof z.ZodError) {
        return {
            status: 400,
            code: 'invalid_transaction',
            message: 'transaction body must contain 1–100 valid typed operations',
            reason: 'invalid_request',
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
