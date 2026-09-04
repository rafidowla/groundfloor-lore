#!/usr/bin/env tsx
/**
 * analytical-group-limit-unit.ts — LORE_ANALYTICAL_GROUP_LIMIT regression.
 *
 * ── THE GAP THIS GUARDS ──────────────────────────────────────────────────
 *
 * `SqliteAnalyticalStorage.groupBy` applied a caller-supplied `limit` as a
 * SQL LIMIT, but when the caller passed NO `limit` at all, `checkLimit`
 * returned `null` and no LIMIT clause was added — the query returned every
 * distinct group with no bound. A high-cardinality `groupField` (an id,
 * hash, or timestamp column) materialized one row per distinct value.
 *
 * The prior legacy-engine-backed analytical storage's `groupBy` had exactly
 * this default ("Defaults a 10_000 cap (mirrors distinct())"); it was lost
 * when the analytical store was rebuilt on SQLite during the graph-engine
 * removal
 * (2026-08-21) — this is the `groupBy`-returned-groups counterpart to
 * `LORE_ANALYTICAL_SCAN_CAP` (which bounds rows SCANNED before aggregating,
 * covered by test/analytical-scan-cap-unit.ts; this file covers rows
 * RETURNED after aggregating).
 *
 * Fix: `contracts/analytical.ts` exports `resolveGroupByLimit`, the single
 * source of truth both `SqliteAnalyticalStorage.groupBy` (applies the
 * resolved limit as the SQL LIMIT — no limit means the default
 * `LORE_ANALYTICAL_GROUP_LIMIT` cap, an explicit limit above the cap is
 * clamped down to it) and its MCP (`aggregate` tool) / REST (`POST
 * /api/aggregate`) callers (surface `truncated: true` when clamping
 * occurred) share.
 *
 * Run: npx tsx test/analytical-group-limit-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { createTableStorage } from '../packages/lore/src/engines/tableStorageFactory.js';
import { createAnalyticalStorage } from '../packages/lore/src/engines/analyticalStorageFactory.js';
import {
    ANALYTICAL_GROUP_LIMIT_DEFAULT,
    resolveGroupByLimit,
} from '../packages/lore/src/contracts/analytical.js';
import type { IAnalyticalStorage } from '../packages/lore/src/contracts/analytical.js';
import type { ITableStorage } from '../packages/lore/src/contracts/tables.js';
import { tryAnalyticsRoutes } from '../packages/lore/src/mcp/http/routes/analytics.js';
import { registerAnalyticalTools } from '../packages/lore/src/mcp/tools/analytical.js';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? String(err)}`);
        failed++;
    }
}

// ── fixture: a table with 20 distinct group values through the LIVE write path ──
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-analytical-grouplimit-'));
fs.mkdirSync(path.join(base, '.lore'), { recursive: true });

const tables: ITableStorage = createTableStorage(base);
const analytical: IAnalyticalStorage | null = createAnalyticalStorage(tables);
assert.ok(analytical, 'a SqliteAnalyticalStorage exists for the live table backend');
const a = analytical!;

interface WideRow extends Record<string, unknown> {
    id: string;
    group_key: string;
    value: number;
}

// 20 rows, each its OWN distinct group_key — a high-cardinality groupField,
// the exact shape the historical legacy-engine default cap protected against.
function makeWideRows(n: number): WideRow[] {
    const rows: WideRow[] = [];
    for (let i = 0; i < n; i++) {
        rows.push({ id: `w-${i}`, group_key: `grp-${String(i).padStart(3, '0')}`, value: i });
    }
    return rows;
}

await tables.createTable({
    name: 'wide_groups',
    columns: [
        { name: 'id', type: 'string', primary: true },
        { name: 'group_key', type: 'string' },
        { name: 'value', type: 'int' },
    ],
} as never);
await tables.insertBatch('wide_groups', makeWideRows(20) as never);

console.log('LORE_ANALYTICAL_GROUP_LIMIT — SqliteAnalyticalStorage.groupBy');

await test('exported default matches the documented 10000 (docs/CONFIGURATION.md)', () => {
    assert.equal(ANALYTICAL_GROUP_LIMIT_DEFAULT, 10_000);
});

await test('BUG (pre-fix): no `limit` at all used to return every group, unbounded', async () => {
    // This asserts the FIXED behavior — kept as the "before" narrative in the
    // header; the before/after proof itself is done by temporarily reverting
    // the source (see the commit's before/after patch), not by branching here.
    process.env['LORE_ANALYTICAL_GROUP_LIMIT'] = '5';
    try {
        const groups = await a.groupBy('wide_groups', 'group_key', 'count', null);
        assert.equal(groups.length, 5, `expected the 5-row cap to apply with no explicit limit, got ${groups.length}`);
    } finally {
        delete process.env['LORE_ANALYTICAL_GROUP_LIMIT'];
    }
});

await test('no explicit limit + default LORE_ANALYTICAL_GROUP_LIMIT (10000) — all 20 groups returned (under the default)', async () => {
    const groups = await a.groupBy('wide_groups', 'group_key', 'count', null);
    assert.equal(groups.length, 20, 'all 20 distinct groups fit comfortably under the 10000 default');
});

await test('an explicit limit above the override cap is clamped down to the cap, not refused', async () => {
    process.env['LORE_ANALYTICAL_GROUP_LIMIT'] = '5';
    try {
        const groups = await a.groupBy('wide_groups', 'group_key', 'count', null, undefined, 1000);
        assert.equal(groups.length, 5, `expected limit=1000 to clamp down to the override cap 5, got ${groups.length}`);
    } finally {
        delete process.env['LORE_ANALYTICAL_GROUP_LIMIT'];
    }
});

await test('an explicit limit UNDER the cap is honored exactly (not raised to the cap)', async () => {
    const groups = await a.groupBy('wide_groups', 'group_key', 'count', null, undefined, 3);
    assert.equal(groups.length, 3);
});

await test('an invalid explicit limit (non-integer / <=0) still throws before any cap resolution', async () => {
    await assert.rejects(() => a.groupBy('wide_groups', 'group_key', 'count', null, undefined, 0), /positive integer/);
    await assert.rejects(() => a.groupBy('wide_groups', 'group_key', 'count', null, undefined, 1.5), /positive integer/);
});

console.log('\nLORE_ANALYTICAL_GROUP_LIMIT — SqliteAnalyticalStorage.distinct');

await test('distinct: no `limit` at all used to return every distinct value, unbounded (BUG pre-fix)', async () => {
    // Same before/after narrative as groupBy above — the before/after proof
    // for the commit is done by temporarily reverting the source, not here.
    process.env['LORE_ANALYTICAL_GROUP_LIMIT'] = '5';
    try {
        const values = await a.distinct('wide_groups', 'group_key');
        assert.equal(values.length, 5, `expected the 5-row cap to apply with no explicit limit, got ${values.length}`);
    } finally {
        delete process.env['LORE_ANALYTICAL_GROUP_LIMIT'];
    }
});

await test('distinct: no explicit limit + default LORE_ANALYTICAL_GROUP_LIMIT (10000) — all 20 values returned (under the default)', async () => {
    const values = await a.distinct('wide_groups', 'group_key');
    assert.equal(values.length, 20, 'all 20 distinct values fit comfortably under the 10000 default');
});

await test('distinct: an explicit limit above the override cap is clamped down to the cap, not refused', async () => {
    process.env['LORE_ANALYTICAL_GROUP_LIMIT'] = '5';
    try {
        const values = await a.distinct('wide_groups', 'group_key', undefined, 1000);
        assert.equal(values.length, 5, `expected limit=1000 to clamp down to the override cap 5, got ${values.length}`);
    } finally {
        delete process.env['LORE_ANALYTICAL_GROUP_LIMIT'];
    }
});

await test('distinct: an explicit limit UNDER the cap is honored exactly (not raised to the cap)', async () => {
    const values = await a.distinct('wide_groups', 'group_key', undefined, 3);
    assert.equal(values.length, 3);
});

console.log('\nLORE_ANALYTICAL_GROUP_LIMIT — resolveGroupByLimit (shared by storage + tool/route callers)');

await test('resolveGroupByLimit: no requested limit -> cap applied, clamped=true', () => {
    process.env['LORE_ANALYTICAL_GROUP_LIMIT'] = '5';
    try {
        const r = resolveGroupByLimit(undefined);
        assert.deepEqual(r, { limit: 5, clamped: true });
    } finally {
        delete process.env['LORE_ANALYTICAL_GROUP_LIMIT'];
    }
});

await test('resolveGroupByLimit: requested limit above the cap -> clamped down, clamped=true', () => {
    process.env['LORE_ANALYTICAL_GROUP_LIMIT'] = '5';
    try {
        const r = resolveGroupByLimit(1000);
        assert.deepEqual(r, { limit: 5, clamped: true });
    } finally {
        delete process.env['LORE_ANALYTICAL_GROUP_LIMIT'];
    }
});

await test('resolveGroupByLimit: requested limit under the cap -> honored as-is, clamped=false', () => {
    process.env['LORE_ANALYTICAL_GROUP_LIMIT'] = '5';
    try {
        const r = resolveGroupByLimit(3);
        assert.deepEqual(r, { limit: 3, clamped: false });
    } finally {
        delete process.env['LORE_ANALYTICAL_GROUP_LIMIT'];
    }
});

// ── REST sibling: POST /api/aggregate (groupBy) ─────────────────────────────

function fakeReq(body: string): IncomingMessage {
    let consumed = false;
    return {
        method: 'POST',
        on(event: string, cb: (chunk?: Buffer) => void) {
            if (event === 'data' && !consumed) { consumed = true; cb(Buffer.from(body, 'utf8')); }
            if (event === 'end') setImmediate(() => cb());
            return this;
        },
    } as unknown as IncomingMessage;
}

function fakeRes(): ServerResponse & { _status: number; _body: string } {
    const r = {
        _status: 0, _body: '',
        writeHead(status: number) { (this as { _status: number })._status = status; return this; },
        end(body?: string) { (this as { _body: string })._body = body ?? ''; },
    };
    return r as unknown as ServerResponse & { _status: number; _body: string };
}

const deps = { analytical: a };

console.log('\nLORE_ANALYTICAL_GROUP_LIMIT — POST /api/aggregate (groupBy)');

await test('no `limit` in the request body -> capped groups + `truncated: true`', async () => {
    process.env['LORE_ANALYTICAL_GROUP_LIMIT'] = '5';
    try {
        const res = fakeRes();
        await tryAnalyticsRoutes(
            fakeReq(JSON.stringify({ workspace: 'ws1', collection: 'wide_groups', aggregation: 'count', groupBy: 'group_key' })),
            res, '', '/api/aggregate', deps,
        );
        assert.equal(res._status, 200);
        const parsed = JSON.parse(res._body) as { groups: unknown[]; truncated?: boolean };
        assert.equal(parsed.groups.length, 5);
        assert.equal(parsed.truncated, true, `expected truncated:true, got ${res._body}`);
    } finally {
        delete process.env['LORE_ANALYTICAL_GROUP_LIMIT'];
    }
});

await test('explicit `limit` above the cap -> clamped + `truncated: true`', async () => {
    process.env['LORE_ANALYTICAL_GROUP_LIMIT'] = '5';
    try {
        const res = fakeRes();
        await tryAnalyticsRoutes(
            fakeReq(JSON.stringify({ workspace: 'ws1', collection: 'wide_groups', aggregation: 'count', groupBy: 'group_key', limit: 1000 })),
            res, '', '/api/aggregate', deps,
        );
        assert.equal(res._status, 200);
        const parsed = JSON.parse(res._body) as { groups: unknown[]; truncated?: boolean };
        assert.equal(parsed.groups.length, 5);
        assert.equal(parsed.truncated, true);
    } finally {
        delete process.env['LORE_ANALYTICAL_GROUP_LIMIT'];
    }
});

await test('explicit `limit` under the cap -> honored, no `truncated` field', async () => {
    const res = fakeRes();
    await tryAnalyticsRoutes(
        fakeReq(JSON.stringify({ workspace: 'ws1', collection: 'wide_groups', aggregation: 'count', groupBy: 'group_key', limit: 3 })),
        res, '', '/api/aggregate', deps,
    );
    assert.equal(res._status, 200);
    const parsed = JSON.parse(res._body) as { groups: unknown[]; truncated?: boolean };
    assert.equal(parsed.groups.length, 3);
    assert.equal(parsed.truncated, undefined, `did not expect a truncated field, got ${res._body}`);
});

// ── MCP tool: `aggregate` (groupBy) ─────────────────────────────────────────

interface RecordedTool {
    name: string;
    handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
}

class FakeMcpServer {
    public tools: RecordedTool[] = [];
    tool(name: string, _desc: string, _schema: unknown, handler: RecordedTool['handler']) {
        this.tools.push({ name, handler });
    }
}

const mcp = new FakeMcpServer();
registerAnalyticalTools(mcp as never, { analytical: a });
const aggregateTool = mcp.tools.find((t) => t.name === 'aggregate')!;

console.log('\nLORE_ANALYTICAL_GROUP_LIMIT — POST /api/aggregate (distinct)');

await test('distinct: no `limit` in the request body -> capped values + `truncated: true`', async () => {
    process.env['LORE_ANALYTICAL_GROUP_LIMIT'] = '5';
    try {
        const res = fakeRes();
        await tryAnalyticsRoutes(
            fakeReq(JSON.stringify({ workspace: 'ws1', collection: 'wide_groups', distinct: true, field: 'group_key' })),
            res, '', '/api/aggregate', deps,
        );
        assert.equal(res._status, 200);
        const parsed = JSON.parse(res._body) as { values: unknown[]; truncated?: boolean };
        assert.equal(parsed.values.length, 5);
        assert.equal(parsed.truncated, true, `expected truncated:true, got ${res._body}`);
    } finally {
        delete process.env['LORE_ANALYTICAL_GROUP_LIMIT'];
    }
});

await test('distinct: explicit `limit` above the cap -> clamped + `truncated: true`', async () => {
    process.env['LORE_ANALYTICAL_GROUP_LIMIT'] = '5';
    try {
        const res = fakeRes();
        await tryAnalyticsRoutes(
            fakeReq(JSON.stringify({ workspace: 'ws1', collection: 'wide_groups', distinct: true, field: 'group_key', limit: 1000 })),
            res, '', '/api/aggregate', deps,
        );
        assert.equal(res._status, 200);
        const parsed = JSON.parse(res._body) as { values: unknown[]; truncated?: boolean };
        assert.equal(parsed.values.length, 5);
        assert.equal(parsed.truncated, true);
    } finally {
        delete process.env['LORE_ANALYTICAL_GROUP_LIMIT'];
    }
});

await test('distinct: explicit `limit` under the cap -> honored, no `truncated` field', async () => {
    const res = fakeRes();
    await tryAnalyticsRoutes(
        fakeReq(JSON.stringify({ workspace: 'ws1', collection: 'wide_groups', distinct: true, field: 'group_key', limit: 3 })),
        res, '', '/api/aggregate', deps,
    );
    assert.equal(res._status, 200);
    const parsed = JSON.parse(res._body) as { values: unknown[]; truncated?: boolean };
    assert.equal(parsed.values.length, 3);
    assert.equal(parsed.truncated, undefined, `did not expect a truncated field, got ${res._body}`);
});

console.log('\nLORE_ANALYTICAL_GROUP_LIMIT — MCP `aggregate` tool (groupBy)');

await test('no `limit` arg -> capped groups + `truncated: true`', async () => {
    process.env['LORE_ANALYTICAL_GROUP_LIMIT'] = '5';
    try {
        const r = await aggregateTool.handler({
            collection: 'wide_groups', aggregation: 'count', groupBy: 'group_key', workspace: 'ws1',
        });
        assert.equal(r.isError, undefined);
        const parsed = JSON.parse(r.content[0]!.text) as { groups: unknown[]; truncated?: boolean };
        assert.equal(parsed.groups.length, 5);
        assert.equal(parsed.truncated, true);
    } finally {
        delete process.env['LORE_ANALYTICAL_GROUP_LIMIT'];
    }
});

await test('explicit `limit` under the cap -> honored, no `truncated` field', async () => {
    const r = await aggregateTool.handler({
        collection: 'wide_groups', aggregation: 'count', groupBy: 'group_key', limit: 3, workspace: 'ws1',
    });
    assert.equal(r.isError, undefined);
    const parsed = JSON.parse(r.content[0]!.text) as { groups: unknown[]; truncated?: boolean };
    assert.equal(parsed.groups.length, 3);
    assert.equal(parsed.truncated, undefined);
});

console.log('\nLORE_ANALYTICAL_GROUP_LIMIT — MCP `aggregate` tool (distinct)');

await test('distinct: no `limit` arg -> capped values + `truncated: true`', async () => {
    process.env['LORE_ANALYTICAL_GROUP_LIMIT'] = '5';
    try {
        const r = await aggregateTool.handler({
            collection: 'wide_groups', aggregation: 'count', distinct: true, field: 'group_key', workspace: 'ws1',
        });
        assert.equal(r.isError, undefined);
        const parsed = JSON.parse(r.content[0]!.text) as { values: unknown[]; truncated?: boolean };
        assert.equal(parsed.values.length, 5);
        assert.equal(parsed.truncated, true);
    } finally {
        delete process.env['LORE_ANALYTICAL_GROUP_LIMIT'];
    }
});

await test('distinct: explicit `limit` under the cap -> honored, no `truncated` field', async () => {
    const r = await aggregateTool.handler({
        collection: 'wide_groups', aggregation: 'count', distinct: true, field: 'group_key', limit: 3, workspace: 'ws1',
    });
    assert.equal(r.isError, undefined);
    const parsed = JSON.parse(r.content[0]!.text) as { values: unknown[]; truncated?: boolean };
    assert.equal(parsed.values.length, 3);
    assert.equal(parsed.truncated, undefined);
});

(tables as unknown as { close(): void }).close();
fs.rmSync(base, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
