#!/usr/bin/env tsx
/**
 * test/temporal-asof-paging-unit.ts - "as of" (VALID time) paging + boundary rule, engine-parameterised.
 *
 * Runs on whichever engine LORE_TEST_GRAPH_ENGINE selects (surreal default, sqlite, postgres - postgres uses the
 * SQL-predicate path, the others the widening JS fallback) and must give the SAME answers on all of them:
 *
 *   paging     1000 nodes, 5% valid at D, page size 20 -> pages 20,20,10 (every page full until the matches run out),
 *              no duplicates, no gaps, same order as the full listing; page size larger than the match set -> one page
 *   boundary   a window is INCLUSIVE at both ends; NULL/unset validUntil = still valid; malformed bound = absent;
 *              an offset-form timestamp compares by instant, not by string
 *
 * Run: npx tsx test/temporal-asof-paging-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createTestGraphEngine, disposeTestGraphEngine, testGraphEngineName } from './helpers/testGraphEngine.js';
import { gateDbUrl } from './helpers/testPostgres.js';
import { listNodesAsOf, type AsOfCursor } from '../packages/lore/src/core/temporalQuery.js';
import type { LoreNode } from '../packages/lore/src/providers/types.js';

if (testGraphEngineName() === 'postgres' && !gateDbUrl()) {
    console.log('SKIP postgres: LORE_TEST_GRAPH_ENGINE=postgres but LORE_PG_URL is not set - asof-paging skipped cleanly');
    process.exit(0);
}

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ok  ${name}`); passed++; }
    catch (err) { console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); failed++; }
}

let seq = 0;
async function withGraph(fn: (g: ReturnType<typeof createTestGraphEngine>) => Promise<void>): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-asof-'));
    const workspaceId = testGraphEngineName() === 'postgres' ? `pg-gate-asofpaging-${process.pid}-${seq++}` : 'test-ws';
    const g = createTestGraphEngine(dir, { workspaceId });
    try { await g.initialize(); await fn(g); }
    finally { await g.close().catch(() => undefined); fs.rmSync(dir, { recursive: true, force: true }); }
}

const node = (id: string, over: Partial<LoreNode> = {}) => ({
    id, type: 'decision', label: id, content: `content ${id}`, tags: ['t'], project: 'proj', ecosystem: '*', metadata: '{}', ...over,
}) as Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>;

console.log(`As-of paging + boundary rule (${testGraphEngineName()})`);

const D = '2026-06-15T12:00:00.000Z';

await test('sparse matches: every page is full until the matches run out; no duplicates, no gaps, listing order', async () => {
    await withGraph(async (g) => {
        const validIds: string[] = [];
        for (let i = 0; i < 1000; i++) {
            const id = `n${String(i).padStart(4, '0')}`;
            let over: Partial<LoreNode>;
            if (i % 20 === 7) { over = { validFrom: '2026-01-01T00:00:00.000Z', validUntil: i % 40 === 7 ? '2026-12-31T00:00:00.000Z' : null }; validIds.push(id); }
            else if (i % 2 === 0) over = { validFrom: '2025-01-01T00:00:00.000Z', validUntil: '2026-03-01T00:00:00.000Z' }; // ended before D
            else over = { validFrom: '2026-09-01T00:00:00.000Z' };                                                      // starts after D
            await g.upsertNode(node(id, over));
        }
        assert.equal(validIds.length, 50);

        const seen: string[] = [];
        const sizes: number[] = [];
        let after: AsOfCursor | undefined;
        for (let guard = 0; guard < 10; guard++) {
            const page = await listNodesAsOf(g, D, { project: 'proj', limit: 20, after });
            if (page.length === 0) break;
            sizes.push(page.length);
            seen.push(...page.map((n) => n.id));
            const last = page[page.length - 1]!;
            after = { updatedAt: last.updatedAt, id: last.id };
        }
        assert.deepEqual(sizes, [20, 20, 10], 'full pages until the matches run out');
        assert.equal(new Set(seen).size, seen.length, 'no duplicates');
        assert.deepEqual([...seen].sort(), [...validIds].sort(), 'no gaps, nothing extra');

        const all = await listNodesAsOf(g, D, { project: 'proj', unbounded: true });
        assert.deepEqual(all.map((n) => n.id), seen, 'same order as one unbounded call');
        const big = await listNodesAsOf(g, D, { project: 'proj', limit: 500 });
        assert.equal(big.length, 50, 'a page larger than the match set returns all of them');
        const one = await listNodesAsOf(g, D, { project: 'proj', limit: 1 });
        assert.equal(one.length, 1, 'limit 1 still returns the one match it asked for');
    });
});

await test('boundary rule: inclusive at validFrom and validUntil, NULL validUntil = still valid, same on every engine', async () => {
    await withGraph(async (g) => {
        await g.upsertNode(node('win', { validFrom: '2026-01-01T00:00:00.000Z', validUntil: '2026-06-01T00:00:00.000Z' }));
        await g.upsertNode(node('open-end', { validFrom: '2026-03-01T00:00:00.000Z' }));
        await g.upsertNode(node('open-start', { validUntil: '2026-03-01T00:00:00.000Z' }));
        await g.upsertNode(node('always'));
        await g.upsertNode(node('bad-from', { validFrom: 'not-a-date', validUntil: '2026-03-01T00:00:00.000Z' }));
        await g.upsertNode(node('offset', { validFrom: '2026-05-01T01:00:00+01:00', validUntil: '2026-05-01T03:00:00+01:00' })); // = 00:00Z .. 02:00Z
        const at = async (iso: string): Promise<string[]> =>
            (await listNodesAsOf(g, iso, { project: 'proj', unbounded: true })).map((n) => n.id).sort();

        assert.deepEqual(await at('2025-12-31T23:59:59.999Z'), ['always', 'bad-from', 'open-start'], '1ms before win.validFrom');
        assert.deepEqual(await at('2026-01-01T00:00:00.000Z'), ['always', 'bad-from', 'open-start', 'win'], 'exactly win.validFrom: IN');
        assert.deepEqual(await at('2026-03-01T00:00:00.000Z'), ['always', 'bad-from', 'open-end', 'open-start', 'win'], 'exactly open-start.validUntil + open-end.validFrom: both IN');
        assert.deepEqual(await at('2026-03-01T00:00:00.001Z'), ['always', 'open-end', 'win'], '1ms after open-start/bad-from.validUntil: OUT');
        assert.deepEqual(await at('2026-05-01T00:00:00.000Z'), ['always', 'offset', 'open-end', 'win'], 'offset form compares by instant: IN at its start');
        assert.deepEqual(await at('2026-05-01T02:00:00.000Z'), ['always', 'offset', 'open-end', 'win'], 'offset form: IN exactly at its end');
        assert.deepEqual(await at('2026-05-01T02:00:00.001Z'), ['always', 'open-end', 'win'], 'offset form: OUT 1ms after');
        assert.deepEqual(await at('2026-06-01T00:00:00.000Z'), ['always', 'open-end', 'win'], 'exactly win.validUntil: IN');
        assert.deepEqual(await at('2026-06-01T00:00:00.001Z'), ['always', 'open-end'], '1ms after win.validUntil: OUT; NULL validUntil stays in');
        assert.deepEqual(await at('2099-01-01T00:00:00.000Z'), ['always', 'open-end'], 'far future');
    });
});

await disposeTestGraphEngine();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
