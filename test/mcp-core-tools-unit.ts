#!/usr/bin/env tsx
/**
 * mcp-core-tools-unit.ts — verify step-#5a MCP tool registrations.
 *
 * Uses a tiny fake McpServer that records every `.tool(name, desc,
 * schema, handler)` call. We then invoke the recorded handlers
 * directly with synthetic args and assert they land on the right
 * surface methods.
 */

import assert from 'node:assert/strict';
import { registerVerbatimTools } from '../packages/lore/src/mcp/tools/verbatim.js';
import { registerAnalyticalTools } from '../packages/lore/src/mcp/tools/analytical.js';

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

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

(async () => {
    console.log('mcp/tools/verbatim');

    let storedDoc: unknown = null;
    let searchedQuery: string | null = null;
    let getByIdId: string | null = null;

    // get_verbatim reads loreVerbatim.getById directly; store_verbatim /
    // search_verbatim go through the storageClient facade (Sprint 15+).
    const verbatimStub = {
        getById: async (id: string) => {
            getByIdId = id;
            return { text: 'body', contentHash: 'abc' };
        },
    };
    const storageClientStub = {
        verbatimStore: async (doc: unknown) => { storedDoc = doc; },
        verbatimSearch: async (q: string, _limit?: number) => {
            searchedQuery = q;
            return [{ id: 'v1', score: 0.9, text: 'hello world', metadata: { type: 'gmail', label: 'Subject' } }];
        },
    };
    const fakeBundle = { loreVerbatim: verbatimStub, storageClient: storageClientStub } as unknown as import('../packages/lore/src/mcp/services.js').StorageBundle;

    const v = new FakeMcpServer();
    registerVerbatimTools(v as never, { store: fakeBundle });

    await test('registers store_verbatim, search_verbatim, get_verbatim', () => {
        assert.deepEqual(v.tools.map(t => t.name).sort(),
            ['get_verbatim', 'search_verbatim', 'store_verbatim']);
    });

    await test('store_verbatim translates flat → metadata shape', async () => {
        const tool = v.tools.find(t => t.name === 'store_verbatim')!;
        const r = await tool.handler({
            id: 'doc1', text: 'x', source: 'gmail:abc', label: 'Subject', tags: 'work,urgent',
            workspace: 'test-ws',
        });
        assert.equal(r.isError, undefined);
        const d = storedDoc as { id: string; text: string; metadata: { type: string; label: string; tags: string } };
        assert.equal(d.id, 'doc1');
        assert.equal(d.metadata.type, 'gmail:abc');
        assert.equal(d.metadata.label, 'Subject');
        assert.equal(d.metadata.tags, 'work,urgent');
    });

    await test('search_verbatim returns rows from inner search', async () => {
        const tool = v.tools.find(t => t.name === 'search_verbatim')!;
        const r = await tool.handler({ query: 'hello', workspace: 'test-ws' });
        assert.equal(searchedQuery, 'hello');
        const parsed = JSON.parse(r.content[0].text) as { rows: Array<{ id: string; source: string }> };
        assert.equal(parsed.rows[0].id, 'v1');
        assert.equal(parsed.rows[0].source, 'gmail');
    });

    await test('get_verbatim returns row, contentOnly drops hash', async () => {
        const tool = v.tools.find(t => t.name === 'get_verbatim')!;
        const r = await tool.handler({ id: 'doc1', contentOnly: true, workspace: 'test-ws' });
        assert.equal(getByIdId, 'doc1');
        const parsed = JSON.parse(r.content[0].text) as { row: { id: string; text: string; contentHash?: string } };
        assert.equal(parsed.row.text, 'body');
        assert.equal(parsed.row.contentHash, undefined);
    });

    console.log('\nmcp/tools/analytical');

    let countCall: { coll: string; filter?: unknown } | null = null;
    let timeSeriesCall: { coll: string; bucket: string } | null = null;
    const analyticalStub = {
        count: async (coll: string, filter?: unknown) => { countCall = { coll, filter }; return 42; },
        sum: async () => 100,
        avg: async () => 10,
        min: async () => 1,
        max: async () => 99,
        groupBy: async () => [{ key: 'a', value: 5, count: 5 }],
        distinct: async () => ['x', 'y'],
        timeSeries: async (coll: string, _t: string, bucket: string) => {
            timeSeriesCall = { coll, bucket };
            return [{ bucket: '2026-01', value: 3, count: 3 }];
        },
    } as unknown as import('../packages/lore/src/contracts/index.js').IAnalyticalStorage;

    const a = new FakeMcpServer();
    registerAnalyticalTools(a as never, { analytical: analyticalStub });

    await test('registers aggregate, time_series', () => {
        assert.deepEqual(a.tools.map(t => t.name).sort(), ['aggregate', 'time_series']);
    });

    await test('aggregate(count) returns scalar', async () => {
        const tool = a.tools.find(t => t.name === 'aggregate')!;
        const r = await tool.handler({ collection: 'Sale', aggregation: 'count' });
        assert.equal(countCall!.coll, 'Sale');
        const parsed = JSON.parse(r.content[0].text) as { value: number };
        assert.equal(parsed.value, 42);
    });

    await test('aggregate(sum) requires field', async () => {
        const tool = a.tools.find(t => t.name === 'aggregate')!;
        const r = await tool.handler({ collection: 'Sale', aggregation: 'sum' });
        assert.equal(r.isError, true);
    });

    await test('aggregate(distinct) returns values array', async () => {
        const tool = a.tools.find(t => t.name === 'aggregate')!;
        const r = await tool.handler({ collection: 'Sale', aggregation: 'count', field: 'region', distinct: true });
        const parsed = JSON.parse(r.content[0].text) as { values: string[] };
        assert.deepEqual(parsed.values, ['x', 'y']);
    });

    await test('aggregate(groupBy) returns groups array', async () => {
        const tool = a.tools.find(t => t.name === 'aggregate')!;
        const r = await tool.handler({ collection: 'Sale', aggregation: 'count', groupBy: 'region' });
        const parsed = JSON.parse(r.content[0].text) as { groups: Array<{ key: string; value: number }> };
        assert.equal(parsed.groups[0].key, 'a');
    });

    await test('aggregate accepts filterJson', async () => {
        const tool = a.tools.find(t => t.name === 'aggregate')!;
        await tool.handler({ collection: 'Sale', aggregation: 'count', filterJson: '{"eq":{"region":"us"}}' });
        assert.deepEqual(countCall!.filter, { eq: { region: 'us' } });
    });

    await test('aggregate rejects malformed filterJson', async () => {
        const tool = a.tools.find(t => t.name === 'aggregate')!;
        const r = await tool.handler({ collection: 'Sale', aggregation: 'count', filterJson: '{not json' });
        assert.equal(r.isError, true);
    });

    await test('time_series passes bucket through', async () => {
        const tool = a.tools.find(t => t.name === 'time_series')!;
        const r = await tool.handler({ collection: 'Sale', timeField: 'day', bucket: 'month', aggregation: 'count' });
        assert.equal(timeSeriesCall!.bucket, 'month');
        const parsed = JSON.parse(r.content[0].text) as { points: Array<{ bucket: string }> };
        assert.equal(parsed.points[0].bucket, '2026-01');
    });

    await test('cloud-mode (analytical=null) tools register but error', async () => {
        const c = new FakeMcpServer();
        registerAnalyticalTools(c as never, { analytical: null });
        const r = await c.tools[0].handler({ collection: 'Sale', aggregation: 'count' });
        assert.equal(r.isError, true);
        assert.match(r.content[0].text, /not yet wired in cloud mode/);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})();
