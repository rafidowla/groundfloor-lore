#!/usr/bin/env tsx
/**
 * node-lineage-merge-unit.ts — regression for the silent-branch-loss bug in
 * node_lineage (FINDINGS-2026-08-17-functional-correctness, graph cluster).
 *
 * Bug: `findSupersededByPredecessor` was `LIMIT 1` with no ORDER BY, so when
 * a MERGE supersedes two nodes with one successor, the lineage route's
 * backward walk followed whichever branch the store happened to return
 * first and silently dropped the other.
 *
 * Fix under test:
 *   - `findSupersededByPredecessors` (plural) returns ALL predecessors of a
 *     successor, deterministically ordered by id (Surreal surrealGraphOverview.ts).
 *   - The /api/node/lineage route walks ALL predecessor branches (BFS) and
 *     orders oldest-first with an id tie-break, so the merge's full ancestry
 *     shows up in the chain.
 *
 * This exercises the REAL entry points: real SurrealGraph on disk, the real
 * supersedeNode write path, and the real route handler via tryNodesRoutes —
 * no re-implemented walk.
 *
 * Run: npx tsx test/node-lineage-merge-unit.ts
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import { tryNodesRoutes } from '../packages/lore/src/mcp/http/routes/nodes.js';

const WS = 'mergews';

let passed = 0;
let failed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
}

/* ── minimal HTTP harness (same convention as sp04-http-read-scope-unit.ts) ── */

function fakeReq(method: string, url?: string): IncomingMessage {
    return { method, url, on: () => undefined } as unknown as IncomingMessage;
}

function fakeRes(): ServerResponse & { _status: number; _body: string } {
    const r = {
        _status: 0, _body: '',
        writeHead(status: number) { (this as { _status: number })._status = status; return this; },
        end(body?: string) { (this as { _body: string })._body = body ?? ''; },
    };
    return r as unknown as ServerResponse & { _status: number; _body: string };
}

type Engine = SurrealGraph;

/** Drive the REAL /api/node/lineage route against a real engine. No
 *  principal = the legacy/local single-workspace happy path (the gate under
 *  test in sp04 is not the subject here; the WALK is). */
async function lineageViaRoute(graph: Engine, id: string): Promise<string[]> {
    const res = fakeRes();
    const registry = {
        getOrOpen: async (_ws: string) => graph,
        getGraphHandle: async (_ws: string) => graph,
        activeName: () => WS,
    };
    const store = { loreGraph: graph, storageClient: graph, loreVerbatim: {} };
    const deps = {
        deploymentMode: 'local' as const,
        dataplane: null,
        store,
        graphRegistry: registry,
        auditLog: {},
    };
    const handled = await tryNodesRoutes(
        fakeReq('GET'),
        res,
        `/api/node/lineage?id=${id}&workspace=${WS}`,
        '/api/node/lineage',
        deps as unknown as Parameters<typeof tryNodesRoutes>[4],
    );
    assert.equal(handled, true, 'route must handle /api/node/lineage');
    assert.equal(res._status, 200, `lineage route status: ${res._body}`);
    const body = JSON.parse(res._body) as { chain: Array<{ id: string }> };
    return body.chain.map((n) => n.id);
}

async function seedNode(graph: Engine, id: string): Promise<void> {
    await graph.upsertNode({
        id, type: 'decision', label: `label-${id}`, content: `content-${id}`,
        tags: [], project: WS, ecosystem: '*', metadata: '{}',
    });
}

async function runScenario(engineName: string, graph: Engine): Promise<void> {
    console.log(`\n[${engineName}]`);
    // Merge: BOTH a-merge and b-merge are superseded by s-merge.
    // Linear chain: c1 → c2 → c3, for the back-compat order assertion.
    for (const id of ['a-merge', 'b-merge', 's-merge', 'c1', 'c2', 'c3']) await seedNode(graph, id);

    const supA = await graph.supersedeNode('a-merge', 's-merge', 'merge branch a');
    const supB = await graph.supersedeNode('b-merge', 's-merge', 'merge branch b');
    assert.deepEqual(supA, { ok: true });
    assert.deepEqual(supB, { ok: true });
    assert.deepEqual(await graph.supersedeNode('c1', 'c2'), { ok: true });
    assert.deepEqual(await graph.supersedeNode('c2', 'c3'), { ok: true });

    await check(`${engineName}: engine method returns BOTH merge predecessors, ordered by id`, async () => {
        const preds = await graph.findSupersededByPredecessors('s-merge');
        assert.deepEqual(preds, ['a-merge', 'b-merge'],
            'a merge has two predecessors; LIMIT 1 used to drop one nondeterministically');
    });

    await check(`${engineName}: engine method returns [] when nothing points at the id`, async () => {
        assert.deepEqual(await graph.findSupersededByPredecessors('c1'), []);
    });

    await check(`${engineName}: GET /api/node/lineage?id=s-merge shows BOTH branches`, async () => {
        const chain = await lineageViaRoute(graph, 's-merge');
        assert.ok(chain.includes('a-merge'), `a-merge missing from chain: ${chain.join(',')}`);
        assert.ok(chain.includes('b-merge'), `b-merge missing from chain: ${chain.join(',')}`);
        assert.ok(chain.includes('s-merge'), `s-merge missing from chain: ${chain.join(',')}`);
        // Deterministic order: same-depth merge siblings order by id,
        // predecessors before the successor.
        assert.deepEqual(chain, ['a-merge', 'b-merge', 's-merge']);
    });

    await check(`${engineName}: GET /api/node/lineage?id=c3 keeps the linear oldest→newest order`, async () => {
        const chain = await lineageViaRoute(graph, 'c3');
        assert.deepEqual(chain, ['c1', 'c2', 'c3']);
    });

    await check(`${engineName}: GET /api/node/lineage?id=a-merge walks forward to the merge successor`, async () => {
        const chain = await lineageViaRoute(graph, 'a-merge');
        assert.deepEqual(chain, ['a-merge', 's-merge']);
    });
}

async function main(): Promise<void> {
    console.log('node-lineage-merge-unit.ts — merge supersession must not lose a branch');

    const surrealDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-lineage-surreal-'));
    const surreal = new SurrealGraph(surrealDir, { workspaceId: WS, cacheDisabled: true });
    await surreal.initialize();

    try {
        await runScenario('surreal', surreal);
    } finally {
        await surreal.close().catch(() => undefined);
        fs.rmSync(surrealDir, { recursive: true, force: true });
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
    console.error('FAIL:', err);
    process.exit(1);
});
