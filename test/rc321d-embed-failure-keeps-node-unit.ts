#!/usr/bin/env tsx
/**
 * test/rc321d-embed-failure-keeps-node-unit.ts — Lore 3.21 step 3(d).
 *
 * An inline embed/verbatim write failure during nodeUpsert() no longer
 * deletes the graph node (nodeServiceVerbatim.ts's `rollback` call). Real
 * production stack, no mocks — a real `SurrealGraph`, a real `VerbatimStore`,
 * a real `FileOutboxStore`, the real `nodeUpsert()` core, and the REAL
 * `dispatch()` (outbox/dispatcher.ts) driven by REAL production substrates
 * (`wireOutbox()`, outbox/wiring.ts) for the replay step — same shape as
 * test/verbatim-tombstone-outbox-replay-unit.ts.
 *
 * Pins the full lifecycle the task asks for:
 *   inline embed failure → node present + outbox row present
 *     → later replay embeds it → recall (bm25Search) finds it after replay
 *     → a FRESH FileOutboxStore instance pointed at the SAME on-disk file
 *       (simulating a daemon restart before the replay ran) still replays.
 *
 * Run: npx tsx test/rc321d-embed-failure-keeps-node-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import { FileOutboxStore } from '../packages/lore/src/outbox/store.js';
import { nodeUpsert } from '../packages/lore/src/core/nodeService.js';
import { dispatch, type DispatcherSubstrates } from '../packages/lore/src/outbox/dispatcher.js';
import { wireOutbox } from '../packages/lore/src/outbox/wiring.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

class ConstEmbedProvider implements EmbeddingProvider {
    get modelId() { return 'rc321d-const'; }
    get dimension() { return 8; }
    async initialize() { /* no-op */ }
    private vec() { return new Array(8).fill(0.1); }
    async embed() { return this.vec(); }
    async embedQuery() { return this.vec(); }
    async embedDocument() { return this.vec(); }
    async embedDocumentBatch(texts: string[]) { return texts.map(() => this.vec()); }
}

function mkTmp(prefix: string): { dir: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    return { dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } } };
}

const WORKSPACE = 'w';

/** Mirrors verbatim-tombstone-outbox-replay-unit.ts's realDispatchSubstrates
 *  — builds the REAL dispatcher substrates via wireOutbox() so the replay
 *  step drives the SAME `upsertVerbatim` closure production boot wires, not
 *  a hand-rolled stand-in. A fresh wiring temp dir per call. */
function realDispatchSubstrates(graph: SurrealGraph, store: VerbatimStore): DispatcherSubstrates {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-rc321d-wiring-'));
    const wiring = wireOutbox({
        loreDir: tmp,
        getSyncEngine: () => ({ recoverVectorMirror: async () => ({ recovered: 0, skipped: 0 }) }) as never,
        getGraph: () => graph as never,
        getVerbatim: () => store,
    });
    return (wiring.replicator as unknown as { substrates: DispatcherSubstrates }).substrates;
}

let passed = 0, failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void>): void {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? (err as Error).message}`); failed++; }
    })());
}

console.log('\n3.21 step 3(d) — inline embed failure keeps the node (real stack, no mocks)\n');

test('inline embed failure → node present + outbox row present → replay embeds it → bm25 recall finds it after replay', async () => {
    const g = mkTmp('lore-rc321d-g-');
    const v = mkTmp('lore-rc321d-v-');
    const o = mkTmp('lore-rc321d-o-');
    const graph = new SurrealGraph(g.dir);
    const store = new VerbatimStore(v.dir, new ConstEmbedProvider());
    const outboxStore = new FileOutboxStore(o.dir);
    await graph.initialize();
    await store.initialize();
    try {
        const id = 'rc321d-embed-fail-node';

        // A flaky inline mirror: fails on the FIRST call (simulating a
        // transient embed/write failure at nodeUpsert time), succeeds on
        // any later call. Only the FIRST call happens through this wrapper
        // (nodeUpsert's inlineVerbatim hook) — the REPLAY step below calls
        // the real store directly via wireOutbox's substrates, entirely
        // independent of this wrapper.
        let firstCall = true;
        const flakyInline = {
            verbatimStore: async (doc: { id: string; text: string; metadata: Record<string, unknown> }) => {
                if (firstCall) { firstCall = false; throw new Error('injected transient embed failure'); }
                await store.store(doc);
            },
        };

        // Step 1: real create, with outbox wired AND the flaky inline
        // mirror — mirrors cloud's primary-write shape
        // (nodeServiceVerbatim.ts's `hooks.inlineVerbatim`).
        const result = await nodeUpsert(
            {
                id, workspace: WORKSPACE, ecosystem: '*', initiator: 'test:rc321d',
                nodeData: { id, type: 'note', label: 'embed fail test', content: 'zzyzxrc321d marker phrase', tags: ['t'], security_scopes: [] as string[] },
                targetGraph: graph,
            },
            { outboxStore, inlineVerbatim: flakyInline },
        );

        // 3.21 step 3(d): node KEPT, embedPending:true — not {ok:false}.
        assert.equal(result.ok, true, `expected ok:true (node kept), got ${JSON.stringify(result)}`);
        assert.equal((result as { embedPending?: boolean }).embedPending, true, 'expected embedPending:true');

        const graphAfterWrite = await graph.getNode(id);
        assert.ok(graphAfterWrite, 'graph node must be PRESENT right after the inline embed failure');

        const rowsAfterWrite = await outboxStore.listPendingForWorkspace(WORKSPACE, 1000);
        const verbatimRow = rowsAfterWrite.find((r) => r.operationKind === 'verbatim.upsert');
        assert.ok(verbatimRow, 'the verbatim.upsert outbox row (the durable retry) must be PRESENT right after the inline failure — it was recorded BEFORE the inline attempt and must not be retracted');

        // The row must not have been applied to the store yet — the inline
        // attempt is what failed; nothing else has written it.
        const beforeReplay = await store.getById(`lore:${id}`);
        assert.equal(beforeReplay, null, 'sanity: the verbatim row must not exist yet before replay');

        // Step 2: later replay — dispatch the pending row(s) through the
        // REAL production substrates (fresh wireOutbox instance, same
        // on-disk graph + verbatim stores — nothing carried over from the
        // write path's in-memory state).
        const substrates = realDispatchSubstrates(graph, store);
        const pendingRows = await outboxStore.listPendingForWorkspace(WORKSPACE, 1000);
        for (const entry of pendingRows) {
            await dispatch(entry, substrates);
        }

        const afterReplay = await store.getById(`lore:${id}`);
        assert.ok(afterReplay, 'BUG: replay did not embed the node — the verbatim row is still missing');
        assert.ok((afterReplay?.text ?? '').includes('zzyzxrc321d'), 'the replayed row must carry the original content');

        // Step 3: recall (bm25 — deterministic, no real ONNX model needed)
        // finds it after replay.
        const bm25 = await store.bm25Search('zzyzxrc321d', 10);
        assert.ok(
            bm25.hits.some((h) => h.id === `lore:${id}`),
            `expected bm25Search to find the node after replay; hits=${JSON.stringify(bm25.hits.map((h) => h.id))}`,
        );
    } finally {
        await store.close().catch(() => undefined);
        await graph.close().catch(() => undefined);
        g.cleanup(); v.cleanup(); o.cleanup();
    }
});

test('restart before replay → a FRESH FileOutboxStore instance (same on-disk file) still replays', async () => {
    const g = mkTmp('lore-rc321d-restart-g-');
    const v = mkTmp('lore-rc321d-restart-v-');
    const o = mkTmp('lore-rc321d-restart-o-');
    const graph = new SurrealGraph(g.dir);
    const store = new VerbatimStore(v.dir, new ConstEmbedProvider());
    await graph.initialize();
    await store.initialize();
    try {
        const id = 'rc321d-restart-node';
        // First "process": a live outboxStore instance records the write.
        const liveOutboxStore = new FileOutboxStore(o.dir);
        const flakyInline = {
            verbatimStore: async () => { throw new Error('injected transient embed failure'); },
        };
        const result = await nodeUpsert(
            {
                id, workspace: WORKSPACE, ecosystem: '*', initiator: 'test:rc321d-restart',
                nodeData: { id, type: 'note', label: 'restart test', content: 'zzyzxrestart marker', tags: [] as string[], security_scopes: [] as string[] },
                targetGraph: graph,
            },
            { outboxStore: liveOutboxStore, inlineVerbatim: flakyInline },
        );
        assert.equal(result.ok, true);
        assert.equal((result as { embedPending?: boolean }).embedPending, true);

        // "Restart": a BRAND NEW FileOutboxStore instance, pointed at the
        // SAME on-disk directory, with none of the live instance's JS
        // object identity or in-memory state carried over — reads
        // outbox.json fresh from disk, exactly as a daemon restart would.
        const restartedOutboxStore = new FileOutboxStore(o.dir);
        const rowsAfterRestart = await restartedOutboxStore.listPendingForWorkspace(WORKSPACE, 1000);
        const verbatimRow = rowsAfterRestart.find((r) => r.operationKind === 'verbatim.upsert' && r.payload && (r.payload as { id?: string }).id === `lore:${id}`);
        assert.ok(verbatimRow, 'the verbatim.upsert outbox row must survive being read by a freshly-constructed outbox store instance');

        const substrates = realDispatchSubstrates(graph, store);
        for (const entry of rowsAfterRestart) {
            await dispatch(entry, substrates);
        }

        const afterReplay = await store.getById(`lore:${id}`);
        assert.ok(afterReplay, 'BUG: the row did not replay after the simulated restart');
        assert.ok((afterReplay?.text ?? '').includes('zzyzxrestart'));
    } finally {
        await store.close().catch(() => undefined);
        await graph.close().catch(() => undefined);
        g.cleanup(); v.cleanup(); o.cleanup();
    }
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
