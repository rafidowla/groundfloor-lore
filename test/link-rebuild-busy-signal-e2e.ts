#!/usr/bin/env tsx
/**
 * test/link-rebuild-busy-signal-e2e.ts - the link rebuild's "busy" signal through the PUBLIC entry point `createLore()`
 * (the same server.ts boot path the daemon uses: real SqliteGraph + SqliteVerbatimStore, deterministic embedder).
 *
 *   idle host           no embed work => the rebuild never waits (busyWaits 0) and finishes
 *   embedding in flight a write whose embedding has not finished is NOT on the link queue yet, but the host is busy: the rebuild
 *                       waits (busyWaits > 0, no batch ran) until the embedding completes, then finishes
 *   host fields         `discoveryHostFields` (what server.ts passes to createLinkService) reports busy for embed depth, per-workspace
 *                       pending embeds and outbox backlog
 *
 *   LORE_HOME=<scratch> LORE_MODEL_SERVER=0 npx tsx test/link-rebuild-busy-signal-e2e.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';
import { discoveryHostFields } from '../packages/lore/src/link/createLinkService.js';

for (const k of Object.keys(process.env)) if (k.startsWith('LORE_LINK_') || k.startsWith('LORE_INGEST_')) delete process.env[k];

let hold: Promise<void> | null = null;
class DetEmbedProvider implements EmbeddingProvider {
    readonly dimension = 16;
    readonly modelId = 'busy-signal-det';
    readonly dtype = 'fp32';
    async initialize(): Promise<void> { /* no-op */ }
    private vec(text: string): number[] {
        const v = new Array(this.dimension).fill(0);
        for (let i = 0; i < text.length; i++) v[i % this.dimension] += text.charCodeAt(i) / 128;
        const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
        return v.map((x) => x / norm);
    }
    async embed(t: string): Promise<number[]> { await hold; return this.vec(t); }
    async embedQuery(t: string): Promise<number[]> { return this.vec(t); }
    async embedDocument(t: string): Promise<number[]> { await hold; return this.vec(t); }
    async embedDocumentBatch(ts: string[]): Promise<number[][]> { await hold; return ts.map((t) => this.vec(t)); }
}

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ok ${name}`); passed++; }
    catch (e) { console.error(`  FAIL ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'lore-busy-sig-'));
const WS = 'default';
const node = (id: string, content: string) => ({ id, workspace: WS, ecosystem: '*', nodeData: { id, type: 'note', label: id, content, project: WS, ecosystem: '*' } });
const BASE = 'the quarterly lease renewal for the downtown office building was approved by the board';
async function until(cond: () => boolean, ms: number, what: string): Promise<void> {
    for (let t = 0; t < ms && !cond(); t += 10) await sleep(10);
    assert.ok(cond(), `timed out waiting for ${what}`);
}

async function open(dataDir: string): Promise<any> {
    const { createLore } = await import('../packages/lore/src/index.js');
    // Short yields so the test is quick; maxWait long enough that a busy host is waited for, not run over.
    return createLore({ dataDir, deploymentMode: 'embedded', embeddingProvider: new DetEmbedProvider(), modelServer: false,
        linkOnArrival: { enabled: true, minSim: 0.9, quietMs: 20, yieldMs: 5, rebuildBatchSize: 2, rebuildYieldMs: 5, rebuildIdleYieldMs: 0, rebuildMaxWaitMs: 20_000 } } as never);
}

console.log('\nlink rebuild busy signal\n');

await test('createLore: idle host => the rebuild never waits; embedding in flight (not yet on the link queue) => it waits, then finishes', async () => {
    const lore = await open(tmp());
    let release: () => void = () => undefined;
    try {
        for (let n = 1; n <= 5; n++) await lore.nodeUpsert(node(`b${n}`, `${BASE} variant ${n}`));
        await lore.awaitEmbeds?.();
        await lore.store.linkService.flush();
        const svc = lore.store.linkService;

        // idle
        await svc.startRebuild(WS);
        await until(() => svc.rebuildStatus(WS)?.status === 'done', 5000, 'idle rebuild');
        assert.equal(svc.stats().rebuild.busyWaits, 0, 'an idle host is never waited for');

        // embedding in flight: the new write is queued for embedding but nothing is on the link queue
        hold = new Promise<void>((r) => { release = r; });
        await lore.nodeUpsert(node('b6', `${BASE} variant 6`));
        assert.equal(svc.stats().queue.ready + svc.stats().queue.claimed, 0, 'precondition: the link queue is empty (the old busy check saw an idle host)');
        await svc.startRebuild(WS);
        await until(() => svc.stats().rebuild.busyWaits >= 1, 5000, 'the rebuild to notice the in-flight embedding');
        assert.equal(svc.rebuildStatus(WS)?.status, 'running');
        assert.equal(svc.rebuildStatus(WS)?.done, 0, 'no batch ran while the embedding was in flight');
        release(); hold = null;
        await lore.awaitEmbeds?.();
        await until(() => svc.rebuildStatus(WS)?.status === 'done', 10_000, 'the rebuild to finish once the host went quiet');
    } finally { release(); hold = null; await lore.dispose(); }
});

await test('discoveryHostFields (what server.ts passes to createLinkService): embed queue depth, per-workspace pending and outbox backlog each make the rebuild wait', async () => {
    const state = { depth: 0, pendingWs: false, outbox: 0 };
    const fields = discoveryHostFields(undefined, tmp(), () => ({ depth: () => state.depth, hasPendingForWorkspace: () => state.pendingWs }), () => ({ listPendingForWorkspace: async () => new Array(state.outbox).fill(0) }));
    assert.equal(await fields.discoveryBusy!(WS), false);
    state.depth = 1; assert.equal(await fields.discoveryBusy!(WS), true); state.depth = 0;
    state.pendingWs = true; assert.equal(await fields.discoveryBusy!(WS), true); state.pendingWs = false;
    state.outbox = 1; assert.equal(await fields.discoveryBusy!(WS), true); state.outbox = 0;
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
