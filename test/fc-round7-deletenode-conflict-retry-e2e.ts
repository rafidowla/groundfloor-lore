#!/usr/bin/env tsx
/**
 * fc-round7-deletenode-conflict-retry-e2e.ts — 2026-08-18 round-7 residual.
 *
 * Same bug class as round 6, new verb: SurrealGraph.deleteNode is a
 * composite write (select node -> select incident edges -> delete edges ->
 * delete node) with no retry anywhere in its call chain. The delete_node
 * MCP tool and DELETE /api/node call it directly; under concurrent
 * DISTINCT-key deletes running alongside other graph writes, SurrealDB's
 * optimistic-concurrency "Transaction conflict: Transaction write conflict.
 * This transaction can be retried" surfaced to callers (verifier: 10-17
 * rejections per attempt, 3/3 attempts).
 *
 * This drives the REAL production entry points — the actual delete_node
 * MCP tool handler (registered via registerDeleteNodeTool over the real
 * embedded bundle + graph registry) and the actual tryNodeDeleteRoute
 * HTTP handler — against a real embedded createLore boot (SurrealGraph
 * default engine), with the repro shape that actually triggers it:
 * distinct keys, deletes concurrent WITH background graph writes.
 *
 *   T1  24 concurrent delete_node tool calls (distinct ids) under
 *       background write load — zero Transaction-conflict failures.
 *   T2  24 concurrent DELETE /api/node route calls (distinct ids) under
 *       the same load — zero Transaction-conflict failures.
 *   T3  deletes actually deleted (correctness under the retry).
 *
 * Run: LORE_HOME=$(mktemp -d) npx tsx test/fc-round7-deletenode-conflict-retry-e2e.ts
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createLore } from '../packages/lore/src/index.js';
import { registerDeleteNodeTool } from '../packages/lore/src/mcp/tools/memory/deleteNode.js';
import { tryNodeDeleteRoute } from '../packages/lore/src/mcp/http/routes/nodes-delete.js';

let passed = 0, failed = 0;
const test = (name: string, fn: () => Promise<void>) =>
    (async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
    })();
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Capture the real tool handler from a fake registration surface. */
function captureToolHandler(deps: Parameters<typeof registerDeleteNodeTool>[1]) {
    type Handler = (args: { id: string; workspace: string }) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
    const captured: Handler[] = [];
    const server = {
        tool: (_name: string, ...rest: unknown[]) => {
            const h = rest[rest.length - 1];
            if (typeof h === 'function') captured.push(h as Handler);
        },
    };
    registerDeleteNodeTool(server as never, deps);
    const handler = captured.pop();
    if (!handler) throw new Error('delete_node tool was not registered');
    return handler;
}

/** Minimal req/res pair for the real HTTP route handler. */
function fakeHttp(id: string, workspace: string) {
    const req = new EventEmitter() as never as { method: string };
    req.method = 'DELETE';
    const chunks: string[] = [];
    const res = {
        statusCode: 0,
        headers: {} as Record<string, string>,
        body: '',
        writeHead(code: number, headers: Record<string, string>) { res.statusCode = code; res.headers = headers; },
        end(body?: string) { res.body = body ?? ''; },
    };
    return {
        req,
        res,
        run: (deps: Parameters<typeof tryNodeDeleteRoute>[4]) =>
            tryNodeDeleteRoute(
                req as never,
                res as never,
                `http://localhost/api/node/${encodeURIComponent(id)}?workspace=${workspace}`,
                `/api/node/${encodeURIComponent(id)}`,
                deps,
            ),
    };
}

async function main() {
    const dataDir = process.env.LORE_HOME!;
    const lore = await createLore({ deploymentMode: 'embedded', dataDir });
    const client = lore.store.storageClient;
    const registry = lore._daemon.getGraphRegistry();

    console.log('round-7 residual — deleteNode retries SurrealDB conflicts (real tool handler + real route handler, real engine)');

    const N = 24;
    const seed = async (prefix: string) => {
        for (let i = 0; i < N; i++) {
            await client.upsertNode({
                id: `${prefix}-${i}`, type: 'note', label: `${prefix} ${i}`,
                content: `seed ${prefix}-${i} round7`, project: 'default', ecosystem: 'probe',
            } as never);
        }
    };
    await seed('del');    // T1 targets (MCP tool)
    await seed('hdel');   // T2 targets (HTTP route)
    await seed('bg');     // background-load targets

    // Incident edges so each delete runs its FULL composite shape
    // (select node -> select incident edges -> DELETE edges -> DELETE node).
    for (let i = 0; i < N; i++) {
        await client.addEdge({ sourceId: `del-${i}`, targetId: `bg-${i}`, relation: 'round7', confidence: 'extracted', confidenceScore: 1 } as never);
        await client.addEdge({ sourceId: `hdel-${i}`, targetId: `bg-${N - 1 - i}`, relation: 'round7', confidence: 'extracted', confidenceScore: 1 } as never);
    }

    /**
     * SUSTAINED background load — writer loops that keep issuing OTHER
     * concurrent graph writes for the entire delete window (a single
     * one-shot Promise.all settles too early; the deletes then run
     * alone and the conflict never fires).
     */
    const startLoadLoops = (loops: number) => {
        let stop = false;
        const stopped = Promise.resolve();
        const workers = Array.from({ length: loops }, async (_, w) => {
            let r = 0;
            while (!stop) {
                try {
                    await client.upsertNode({
                        id: `bg-${(w + r) % N}`, type: 'note', label: `bg ${(w + r) % N}`,
                        content: `background loop ${w} round ${r++}`,
                        project: 'default', ecosystem: 'probe',
                    } as never);
                    await client.addEdge({ sourceId: `bg-${r % N}`, targetId: `bg-${(r + 1) % N}`, relation: `bgload-${w}`, confidence: 'extracted', confidenceScore: 1 } as never);
                } catch { /* the background load itself is load, not under test */ }
            }
        });
        return {
            stop: () => { stop = true; return stopped; },
            done: Promise.all(workers),
        };
    };

    /** One-shot 24-write fanout — raced with the deletes for an extra
     *  burst of contention at the moment they start. */
    const burst = () => Promise.allSettled(Array.from({ length: N }, (_, i) =>
        client.upsertNode({
            id: `bg-burst-${i}`, type: 'note', label: `burst ${i}`,
            content: `burst ${i}`, project: 'default', ecosystem: 'probe',
        } as never)));

    const realDepsBase = {
        store: lore.store,
        graphRegistry: registry,
        detectedScope: { workspace: 'default', ecosystem: '*' },
        auditLog: { log: () => undefined },
        // Tool-path only, mirrors triage-recommended-fixes-unit.ts shape.
        getWal: () => { throw new Error('unused on the delete path'); },
        domain: 'personal', edgeRelations: [], nodeTypesEnum: null, edgeRelationsEnum: null,
        nodeTypesDescription: '',
        configManager: null, outboxStore: undefined, embedQueue: undefined,
        workspaceVerbatimResolver: undefined, versionStore: undefined,
    } as never as Parameters<typeof registerDeleteNodeTool>[1];

    await test(`T1 ${N} concurrent delete_node tool calls under load — zero conflict failures`, async () => {
        const handler = captureToolHandler(realDepsBase);
        const load = startLoadLoops(10);
        let deletes;
        try {
            deletes = await Promise.allSettled([
                ...Array.from({ length: N }, (_, i) => handler({ id: `del-${i}`, workspace: 'default' })),
                burst(),
            ].slice(0, N + 1)).then((all) => all.slice(0, N));
        } finally {
            load.stop();
            await load.done;
        }
        const rejected = deletes.filter((r) => r.status === 'rejected');
        const conflictRejections = rejected.filter((r) => /transaction conflict/i.test(msg((r as PromiseRejectedResult).reason)));
        assert.equal(conflictRejections.length, 0,
            `${conflictRejections.length}/${N} delete_node calls died on a retryable Transaction conflict — first: ${conflictRejections[0] ? msg((conflictRejections[0] as PromiseRejectedResult).reason) : ''}`);
        const errored = deletes.filter((r) => r.status === 'fulfilled'
            && (r as PromiseFulfilledResult<{ isError?: boolean; content: Array<{ text: string }> }>).value.isError === true
            && /transaction conflict/i.test(
                JSON.stringify((r as PromiseFulfilledResult<{ content: Array<{ text: string }> }>).value.content)));
        assert.equal(errored.length, 0,
            `${errored.length}/${N} delete_node calls returned isError with a Transaction conflict`);
    });

    await test(`T2 ${N} concurrent DELETE /api/node route calls under load — zero conflict failures`, async () => {
        const routeDeps = {
            store: lore.store,
            graphRegistry: registry,
            auditLog: { log: () => undefined },
            deploymentMode: 'local' as const,
            dataplane: null,
        } as never as Parameters<typeof tryNodeDeleteRoute>[4];
        const load = startLoadLoops(10);
        const outcomes: Array<{ status: number; body: string }> = [];
        let deletes;
        try {
            deletes = await Promise.allSettled([
                ...Array.from({ length: N }, (_, i) => {
                    const call = fakeHttp(`hdel-${i}`, 'default');
                    return call.run(routeDeps).then(() => outcomes.push({ status: call.res.statusCode, body: call.res.body }));
                }),
                burst(),
            ].slice(0, N + 1)).then((all) => all.slice(0, N));
        } finally {
            load.stop();
            await load.done;
        }
        const rejected = deletes.filter((r) => r.status === 'rejected');
        const conflictRejections = rejected.filter((r) => /transaction conflict/i.test(msg((r as PromiseRejectedResult).reason)));
        assert.equal(conflictRejections.length, 0,
            `${conflictRejections.length}/${N} route calls died on a retryable Transaction conflict — first: ${conflictRejections[0] ? msg((conflictRejections[0] as PromiseRejectedResult).reason) : ''}`);
        const conflictBodies = outcomes.filter((o) => /transaction conflict/i.test(o.body));
        assert.equal(conflictBodies.length, 0,
            `${conflictBodies.length}/${N} route responses carried a Transaction conflict — first: ${conflictBodies[0]?.body.slice(0, 200) ?? ''}`);
    });

    await test('T3 the deletes actually deleted (correctness, not just no-error)', async () => {
        for (let i = 0; i < N; i++) {
            assert.equal(await client.getNode(`del-${i}`), null, `del-${i} still present after delete_node`);
            assert.equal(await client.getNode(`hdel-${i}`), null, `hdel-${i} still present after DELETE /api/node`);
        }
    });

    await lore.dispose();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('TEST HARNESS FAILED:', e); process.exit(2); });
