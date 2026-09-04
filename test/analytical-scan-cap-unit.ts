#!/usr/bin/env tsx
/**
 * analytical-scan-cap-unit.ts — LORE_ANALYTICAL_SCAN_CAP regression
 * (round-X audit, item X-scancap).
 *
 * ── THE GAP THIS GUARDS ──────────────────────────────────────────────────
 *
 * docs/CONFIGURATION.md documents `LORE_ANALYTICAL_SCAN_CAP` (default
 * 200000) as a fail-loud cap: an analytical scan over more matched rows
 * than the cap must REFUSE rather than silently run, because `timeSeries`
 * buckets in JS and `groupBy` collapses via SQL `GROUP BY` — both over the
 * FULL matched set, so a truncated scan would corrupt the aggregation.
 *
 * The prior legacy-engine-backed analytical storage's `timeSeries` enforced this
 * (8a31e1c5, "fail loud over the cap"). The 2026-08-21 graph-engine removal
 * rebuilt the analytical store on SQLite (`SqliteAnalyticalStorage`) without
 * porting the check: `LORE_ANALYTICAL_SCAN_CAP` was allowlisted in
 * envScrub and documented in CONFIGURATION.md, but nothing in
 * `sqliteAnalyticalStorage.ts`, `mcp/http/routes/analytics.ts`, or
 * `mcp/tools/analytical.ts` ever read it — a query over an arbitrarily
 * large matched set ran unbounded, and the documented cap silently no
 * longer existed. This test fails against that state and passes once
 * `SqliteAnalyticalStorage.timeSeries`/`groupBy` enforce the cap via a
 * cheap pre-count, with the REST siblings mapping the refusal to
 * `400 analytical_scan_cap_exceeded` (never 500) and the MCP tools
 * surfacing a structured tool error.
 *
 * A second, adjacent gap closed here: `mcp/http/routes/analytics.ts`'s
 * `parseFilter()` throws a plain `Error` on a malformed nested `filterJson`
 * string, which the route's blanket catch mapped to `500 internal_error` —
 * a client-supplied bad request reported as a server fault. Both routes now
 * map it to `400 invalid_filter_json`.
 *
 * Run: npx tsx test/analytical-scan-cap-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { createTableStorage } from '../packages/lore/src/engines/tableStorageFactory.js';
import { createAnalyticalStorage } from '../packages/lore/src/engines/analyticalStorageFactory.js';
import {
    AnalyticalScanCapExceeded,
    ANALYTICAL_SCAN_CAP_DEFAULT,
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

// ── fixture: two collections through the LIVE write path ───────────────────
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-analytical-scancap-'));
fs.mkdirSync(path.join(base, '.lore'), { recursive: true });

const tables: ITableStorage = createTableStorage(base);
const analytical: IAnalyticalStorage | null = createAnalyticalStorage(tables);
assert.ok(analytical, 'a SqliteAnalyticalStorage exists for the live table backend');
const a = analytical!;

interface MetricRow extends Record<string, unknown> {
    id: string;
    value: number;
    status: string;
    ts: string;
}

function makeRows(n: number, prefix: string): MetricRow[] {
    const statuses = ['a', 'b', 'c'];
    const rows: MetricRow[] = [];
    for (let i = 0; i < n; i++) {
        const day = 1 + (i % 27);
        rows.push({
            id: `${prefix}-${i}`,
            value: i,
            status: statuses[i % statuses.length]!,
            ts: `2026-0${1 + (i % 6)}-${String(day).padStart(2, '0')}T00:00:00Z`,
        });
    }
    return rows;
}

const SCHEMA = (name: string) => ({
    name,
    columns: [
        { name: 'id', type: 'string', primary: true },
        { name: 'value', type: 'int' },
        { name: 'status', type: 'string' },
        { name: 'ts', type: 'string' },
    ],
}) as never;

// `metric_big`: 150 matching rows — exceeds a cap of 100.
await tables.createTable(SCHEMA('metric_big'));
await tables.insertBatch('metric_big', makeRows(150, 'big') as never);

// `metric_small`: 50 matching rows — under a cap of 100 AND the default.
await tables.createTable(SCHEMA('metric_small'));
await tables.insertBatch('metric_small', makeRows(50, 'small') as never);

console.log('LORE_ANALYTICAL_SCAN_CAP — SqliteAnalyticalStorage');

await test('exported default matches the documented 200000 (docs/CONFIGURATION.md)', () => {
    assert.equal(ANALYTICAL_SCAN_CAP_DEFAULT, 200_000);
});

await test('timeSeries refuses over cap=100 with 150 matching rows', async () => {
    process.env['LORE_ANALYTICAL_SCAN_CAP'] = '100';
    await assert.rejects(
        () => a.timeSeries('metric_big', 'ts', 'day', 'count', null),
        (err: unknown) => {
            assert.ok(err instanceof AnalyticalScanCapExceeded, `expected AnalyticalScanCapExceeded, got ${err}`);
            assert.equal(err.cap, 100);
            assert.equal(err.matched, 150);
            assert.match(err.message, /narrow the filter or time range/);
            return true;
        },
    );
});

await test('groupBy (the /api/aggregate groupBy path) refuses over cap=100 with 150 matching rows', async () => {
    process.env['LORE_ANALYTICAL_SCAN_CAP'] = '100';
    await assert.rejects(
        () => a.groupBy('metric_big', 'status', 'count', null),
        (err: unknown) => {
            assert.ok(err instanceof AnalyticalScanCapExceeded, `expected AnalyticalScanCapExceeded, got ${err}`);
            assert.equal(err.cap, 100);
            assert.equal(err.matched, 150);
            return true;
        },
    );
});

await test('cap does not exempt a small caller `limit` — the cap bounds rows scanned, not groups returned', async () => {
    process.env['LORE_ANALYTICAL_SCAN_CAP'] = '100';
    await assert.rejects(
        () => a.groupBy('metric_big', 'status', 'count', null, undefined, 1),
        AnalyticalScanCapExceeded,
    );
});

await test('timeSeries and groupBy succeed with 50 matching rows under cap=100', async () => {
    process.env['LORE_ANALYTICAL_SCAN_CAP'] = '100';
    const points = await a.timeSeries('metric_small', 'ts', 'month', 'count', null);
    assert.ok(points.length > 0);
    const groups = await a.groupBy('metric_small', 'status', 'count', null);
    assert.ok(groups.length > 0);
});

await test('with the var unset, the documented default (200000) applies — 150 rows still succeeds', async () => {
    delete process.env['LORE_ANALYTICAL_SCAN_CAP'];
    const points = await a.timeSeries('metric_big', 'ts', 'day', 'count', null);
    assert.ok(points.length > 0);
    const groups = await a.groupBy('metric_big', 'status', 'count', null);
    assert.ok(groups.length > 0);
});

// ── REST siblings: POST /api/time-series + POST /api/aggregate ─────────────

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

console.log('\nLORE_ANALYTICAL_SCAN_CAP — REST siblings (never 500)');

await test('POST /api/time-series → 400 analytical_scan_cap_exceeded (not 500) over cap', async () => {
    process.env['LORE_ANALYTICAL_SCAN_CAP'] = '100';
    const res = fakeRes();
    const handled = await tryAnalyticsRoutes(
        fakeReq(JSON.stringify({ workspace: 'ws1', collection: 'metric_big', timeField: 'ts', bucket: 'day', aggregation: 'count' })),
        res, '', '/api/time-series', deps,
    );
    assert.equal(handled, true);
    assert.equal(res._status, 400);
    const parsed = JSON.parse(res._body) as { code: string; cap: number; matched: number };
    assert.equal(parsed.code, 'analytical_scan_cap_exceeded');
    assert.equal(parsed.cap, 100);
    assert.equal(parsed.matched, 150);
});

await test('POST /api/aggregate (groupBy) → 400 analytical_scan_cap_exceeded (not 500) over cap', async () => {
    process.env['LORE_ANALYTICAL_SCAN_CAP'] = '100';
    const res = fakeRes();
    const handled = await tryAnalyticsRoutes(
        fakeReq(JSON.stringify({ workspace: 'ws1', collection: 'metric_big', aggregation: 'count', groupBy: 'status' })),
        res, '', '/api/aggregate', deps,
    );
    assert.equal(handled, true);
    assert.equal(res._status, 400);
    const parsed = JSON.parse(res._body) as { code: string; cap: number; matched: number };
    assert.equal(parsed.code, 'analytical_scan_cap_exceeded');
    assert.equal(parsed.cap, 100);
    assert.equal(parsed.matched, 150);
});

await test('POST /api/time-series → 200 under cap (50 rows, cap=100)', async () => {
    process.env['LORE_ANALYTICAL_SCAN_CAP'] = '100';
    const res = fakeRes();
    await tryAnalyticsRoutes(
        fakeReq(JSON.stringify({ workspace: 'ws1', collection: 'metric_small', timeField: 'ts', bucket: 'month', aggregation: 'count' })),
        res, '', '/api/time-series', deps,
    );
    assert.equal(res._status, 200);
    const parsed = JSON.parse(res._body) as { points: unknown[] };
    assert.ok(parsed.points.length > 0);
});

await test('POST /api/aggregate (groupBy) → 200 under cap (50 rows, cap=100)', async () => {
    process.env['LORE_ANALYTICAL_SCAN_CAP'] = '100';
    const res = fakeRes();
    await tryAnalyticsRoutes(
        fakeReq(JSON.stringify({ workspace: 'ws1', collection: 'metric_small', aggregation: 'count', groupBy: 'status' })),
        res, '', '/api/aggregate', deps,
    );
    assert.equal(res._status, 200);
    const parsed = JSON.parse(res._body) as { groups: unknown[] };
    assert.ok(parsed.groups.length > 0);
});

await test('malformed nested filterJson → 400 invalid_filter_json (not 500) on /api/time-series', async () => {
    const res = fakeRes();
    await tryAnalyticsRoutes(
        fakeReq(JSON.stringify({
            workspace: 'ws1', collection: 'metric_small', timeField: 'ts', bucket: 'day', aggregation: 'count',
            filterJson: '{not valid json',
        })),
        res, '', '/api/time-series', deps,
    );
    assert.equal(res._status, 400);
    const parsed = JSON.parse(res._body) as { code: string };
    assert.equal(parsed.code, 'invalid_filter_json');
});

await test('malformed nested filterJson → 400 invalid_filter_json (not 500) on /api/aggregate', async () => {
    const res = fakeRes();
    await tryAnalyticsRoutes(
        fakeReq(JSON.stringify({
            workspace: 'ws1', collection: 'metric_small', aggregation: 'count',
            filterJson: '{not valid json',
        })),
        res, '', '/api/aggregate', deps,
    );
    assert.equal(res._status, 400);
    const parsed = JSON.parse(res._body) as { code: string };
    assert.equal(parsed.code, 'invalid_filter_json');
});

// ── MCP tools: `aggregate` + `time_series` ──────────────────────────────────

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
const timeSeriesTool = mcp.tools.find((t) => t.name === 'time_series')!;

console.log('\nLORE_ANALYTICAL_SCAN_CAP — MCP tools (structured tool error, never a throw)');

await test('MCP time_series over cap → structured isError tool result, not a thrown exception', async () => {
    process.env['LORE_ANALYTICAL_SCAN_CAP'] = '100';
    const r = await timeSeriesTool.handler({
        collection: 'metric_big', timeField: 'ts', bucket: 'day', aggregation: 'count', workspace: 'ws1',
    });
    assert.equal(r.isError, true);
    const parsed = JSON.parse(r.content[0]!.text) as { error: string; cap: number; matched: number };
    assert.equal(parsed.error, 'analytical_scan_cap_exceeded');
    assert.equal(parsed.cap, 100);
    assert.equal(parsed.matched, 150);
});

await test('MCP aggregate(groupBy) over cap → structured isError tool result', async () => {
    process.env['LORE_ANALYTICAL_SCAN_CAP'] = '100';
    const r = await aggregateTool.handler({
        collection: 'metric_big', aggregation: 'count', groupBy: 'status', workspace: 'ws1',
    });
    assert.equal(r.isError, true);
    const parsed = JSON.parse(r.content[0]!.text) as { error: string; cap: number; matched: number };
    assert.equal(parsed.error, 'analytical_scan_cap_exceeded');
    assert.equal(parsed.cap, 100);
    assert.equal(parsed.matched, 150);
});

await test('MCP time_series and aggregate succeed under cap (50 rows, cap=100)', async () => {
    process.env['LORE_ANALYTICAL_SCAN_CAP'] = '100';
    const r1 = await timeSeriesTool.handler({
        collection: 'metric_small', timeField: 'ts', bucket: 'month', aggregation: 'count', workspace: 'ws1',
    });
    assert.equal(r1.isError, undefined);
    const r2 = await aggregateTool.handler({
        collection: 'metric_small', aggregation: 'count', groupBy: 'status', workspace: 'ws1',
    });
    assert.equal(r2.isError, undefined);
});

delete process.env['LORE_ANALYTICAL_SCAN_CAP'];
(tables as unknown as { close(): void }).close();
fs.rmSync(base, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
