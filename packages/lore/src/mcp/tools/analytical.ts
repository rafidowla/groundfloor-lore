/**
 * analytical.ts — Universal-analytical MCP tools (Lore Core).
 *
 * Per `lore-build-priority-order-2026-05-09` step #5a, these expose
 * the IAnalyticalStorage surface as MCP tools so DEF/Loom (and any
 * other consumer) can run aggregates and time-series over the active
 * workspace's graph without speaking Cypher.
 *
 * Tools:
 *   - aggregate    — count / sum / avg / min / max / groupBy / distinct
 *   - time_series  — bucketed (year/quarter/month/week/day/hour/minute)
 *
 * Cloud mode: `analytical` is null today (DataplaneAnalyticalStorage
 * lands in step #6). Tools register but reject with a clear error so
 * callers know the surface exists, just isn't backed yet.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
    AnalyticalScanCapExceeded,
    type IAnalyticalStorage,
    type AggregationType,
    type TimeBucket,
} from '../../contracts/index.js';
import type { Filter } from '../../engines/collectionStorage.js';
import { redactError } from '../../security/logRedact.js';
import { assertMcpScope } from './mcpScope.js';

export interface AnalyticalToolsDeps {
    /** Null when running cloud mode pre-step-#6. Tools surface a clear error.
     *  Also the active-workspace fallback when resolveAnalytical is absent. */
    analytical: IAnalyticalStorage | null;
    /**
     * Local-mode (Postgres model) per-workspace analytical resolver. When wired,
     * aggregate/time_series build an IAnalyticalStorage over the REQUESTED
     * workspace's graph connection instead of the boot/active one. Optional:
     * absent (cloud / tests) → fall back to `analytical`. Throws
     * WorkspaceNotFoundError for an unknown workspace (caught by the handler).
     */
    resolveAnalytical?: (workspace: string) => Promise<IAnalyticalStorage | null>;
}

const AGGREGATIONS = ['count', 'sum', 'avg', 'min', 'max'] as const;
const BUCKETS = ['minute', 'hour', 'day', 'week', 'month', 'quarter', 'year'] as const;

function notWired(tool: string) {
    return {
        content: [{
            type: 'text' as const,
            text: `${tool} not yet wired in cloud mode. DataplaneAnalyticalStorage lands in step #6. ` +
                `Run with --mode=local to use this tool today.`,
        }],
        isError: true,
    };
}

/**
 * Structured tool error for a LORE_ANALYTICAL_SCAN_CAP refusal — mirrors the
 * `collectionValidationEnvelope` pattern in tools/collections.ts (a machine-
 * readable `error` code plus the fields a caller needs to react: `cap` and
 * `matched`) rather than letting it fall into the generic catch-all's plain
 * message string.
 */
function scanCapEnvelope(e: AnalyticalScanCapExceeded, tool: string) {
    return {
        content: [{
            type: 'text' as const,
            text: JSON.stringify({
                error: 'analytical_scan_cap_exceeded',
                tool,
                cap: e.cap,
                matched: e.matched,
                message: e.message,
            }),
        }],
        isError: true,
    };
}

export function registerAnalyticalTools(mcpServer: McpServer, deps: AnalyticalToolsDeps): void {
    /* ─── aggregate ──────────────────────────────────────────── */
    mcpServer.tool(
        'aggregate',
        'Run an aggregation (count/sum/avg/min/max/groupBy/distinct) over a collection. Universal across local + cloud (cloud lands in step #6).',
        {
            collection: z.string().describe('Collection name (SQLite table or declared collection).'),
            aggregation: z.enum(AGGREGATIONS).describe('Operation to apply.'),
            field: z.string().optional().describe('Field to aggregate. Required for sum/avg/min/max; ignored for count.'),
            groupBy: z.string().optional().describe('Group results by this field. When set, returns per-group rows.'),
            distinct: z.boolean().optional().describe('Return distinct values of `field`. Mutually exclusive with aggregation.'),
            filterJson: z.string().optional().describe('JSON-encoded Filter (eq/contains/startsWith/gt/gte/lt/lte/in). Same shape as CollectionStorage.find.'),
            limit: z.number().int().positive().optional().describe('Cap on returned groups (groupBy only).'),
            workspace: z.string().min(1).describe('Workspace scope (required — Sprint L1e: no silent fallback).'),
        },
        async (args) => {
            if (!deps.analytical && !deps.resolveAnalytical) return notWired('aggregate');
            // SP-01 — enforce bound-principal workspace scope (read).
            const scopeDenied = assertMcpScope(args.workspace as string | undefined, 'read');
            if (scopeDenied) return scopeDenied;
            try {
                // Postgres-model isolation: route the aggregate to the REQUESTED
                // workspace's analytical storage; fall back to the boot one when
                // no per-workspace resolver is wired (cloud / tests).
                const a = deps.resolveAnalytical
                    ? await deps.resolveAnalytical(args.workspace as string)
                    : deps.analytical;
                if (!a) return notWired('aggregate');
                const filter = parseFilter(args.filterJson);
                if (args.distinct) {
                    if (!args.field) {
                        return { content: [{ type: 'text', text: 'aggregate(distinct) requires `field`' }], isError: true };
                    }
                    const values = await a.distinct(args.collection, args.field, filter);
                    return { content: [{ type: 'text', text: JSON.stringify({ values }) }] };
                }
                if (args.groupBy) {
                    const groups = await a.groupBy(
                        args.collection,
                        args.groupBy,
                        args.aggregation as AggregationType,
                        args.field ?? null,
                        filter,
                        args.limit,
                    );
                    return { content: [{ type: 'text', text: JSON.stringify({ groups }) }] };
                }
                let value: number | null;
                switch (args.aggregation as AggregationType) {
                    case 'count': value = await a.count(args.collection, filter); break;
                    case 'sum':
                    case 'avg':
                    case 'min':
                    case 'max':
                        if (!args.field) {
                            return { content: [{ type: 'text', text: `aggregate(${args.aggregation}) requires \`field\`` }], isError: true };
                        }
                        value = await callScalar(a, args.aggregation as 'sum' | 'avg' | 'min' | 'max', args.collection, args.field, filter);
                        break;
                }
                return { content: [{ type: 'text', text: JSON.stringify({ value }) }] };
            } catch (err) {
                if (err instanceof AnalyticalScanCapExceeded) return scanCapEnvelope(err, 'aggregate');
                return { content: [{ type: 'text', text: `aggregate failed: ${redactError(err)}` }], isError: true };
            }
        },
    );

    /* ─── time_series ────────────────────────────────────────── */
    mcpServer.tool(
        'time_series',
        'Bucket rows by a time field and aggregate. Bucket sizes: minute/hour/day/week/month/quarter/year. Universal across local + cloud (cloud lands in step #6).',
        {
            collection: z.string().describe('Collection name (SQLite table or declared collection).'),
            timeField: z.string().describe('Field holding the timestamp (string/Date/number).'),
            bucket: z.enum(BUCKETS).describe('Bucket size.'),
            aggregation: z.enum(AGGREGATIONS).describe('Operation to apply per bucket.'),
            field: z.string().optional().describe('Field to aggregate. Required for sum/avg/min/max; ignored for count.'),
            filterJson: z.string().optional().describe('JSON-encoded Filter (eq/contains/startsWith/gt/gte/lt/lte/in).'),
            workspace: z.string().min(1).describe('Workspace scope (required — Sprint L1e: no silent fallback).'),
        },
        async (args) => {
            if (!deps.analytical && !deps.resolveAnalytical) return notWired('time_series');
            // SP-01 — enforce bound-principal workspace scope (read).
            const scopeDenied = assertMcpScope(args.workspace as string | undefined, 'read');
            if (scopeDenied) return scopeDenied;
            try {
                const a = deps.resolveAnalytical
                    ? await deps.resolveAnalytical(args.workspace as string)
                    : deps.analytical;
                if (!a) return notWired('time_series');
                const filter = parseFilter(args.filterJson);
                const points = await a.timeSeries(
                    args.collection,
                    args.timeField,
                    args.bucket as TimeBucket,
                    args.aggregation as AggregationType,
                    args.field ?? null,
                    filter,
                );
                return { content: [{ type: 'text', text: JSON.stringify({ points }) }] };
            } catch (err) {
                if (err instanceof AnalyticalScanCapExceeded) return scanCapEnvelope(err, 'time_series');
                return { content: [{ type: 'text', text: `time_series failed: ${redactError(err)}` }], isError: true };
            }
        },
    );
}

function parseFilter(s?: string): Filter | undefined {
    if (!s) return undefined;
    try {
        return JSON.parse(s) as Filter;
    } catch {
        throw new Error(`filterJson is not valid JSON: ${s.slice(0, 80)}`);
    }
}

function callScalar(
    a: IAnalyticalStorage,
    kind: 'sum' | 'avg' | 'min' | 'max',
    coll: string,
    field: string,
    filter?: Filter,
): Promise<number | null> {
    switch (kind) {
        case 'sum': return a.sum(coll, field, filter);
        case 'avg': return a.avg(coll, field, filter);
        case 'min': return a.min<number>(coll, field, filter);
        case 'max': return a.max<number>(coll, field, filter);
    }
}
