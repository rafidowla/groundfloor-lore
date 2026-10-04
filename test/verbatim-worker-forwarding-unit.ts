#!/usr/bin/env tsx
/**
 * verbatim-worker-forwarding-unit.ts — 3.27.1: the search-worker proxy must
 * forward every VerbatimStore method that touches the store's native state.
 *
 * THE BUG CLASS (third recurrence: 1.11 delete surface, D7c piece search, now
 * 3.27.0 purgeWithHistory + getExistingIds). VerbatimSearchWorkerProxy extends
 * VerbatimStore and shadows ONLY the names in FORWARDED_METHODS. Any other
 * inherited method runs against the deliberately-dead parent half
 * (`initialized=false`, `table=null`) and silently no-ops — while feature
 * detection (`typeof store.x === 'function'`) still passes via inheritance.
 * Under LORE_SEARCH_WORKER=1 (Atlas's daemon config) nodeDelete({purge:true})
 * reported purged:true having deleted nothing, the outbox verbatim.purge replay
 * failed verification and dead-lettered, and a deleted node's question aliases
 * (`lore:<id>#q0..4`) stayed recallable.
 *
 * Sections:
 *   A — structural guard (no child spawned): every state-touching prototype
 *       method is forwarded or explicitly allowlisted; every forwarded name
 *       exists; the proxy really shadows every forwarded name.
 *   B — physicalDeleteMany of absent ids commits NO LanceDB version.
 *   C — production path: createLore embedded, LORE_SEARCH_WORKER policy on, a
 *       Lance workspace, nodes with #q aliases and #rev history, then
 *       nodeDelete (tombstone + purge) and nodeDeleteMany purge, replicator
 *       drained, nothing dead-lettered.
 *
 * Run: npx tsx test/verbatim-worker-forwarding-unit.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createLore } from '../packages/lore/src/index.js';
import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import { VerbatimSearchWorkerProxy } from '../packages/lore/src/engines/verbatimSearchWorkerProxy.js';
import { FORWARDED_METHODS } from '../packages/lore/src/engines/verbatimWorkerProtocol.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';
import type { OutboxEntry } from '../packages/lore/src/outbox/types.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}
process.env['LORE_SEARCH_WORKER_READY_MS'] ??= '90000';

// ── Section A — structural guard ────────────────────────────────────────────
console.log('\nA. structural guard\n');

/** VerbatimStore methods that read/write `this.table|initialized|pieceIndex|db`
 *  (directly, or by handing `this`/a ctx getter to a helper) and are NOT
 *  forwarded — each with the reason it is safe on the parent half. Adding a
 *  new state-touching store method without forwarding it OR listing it here
 *  fails the test by name. */
const PARENT_SAFE: Record<string, string> = {
    // Internals reached only from inside forwarded methods, i.e. they run in the CHILD on the real store.
    ensureReadPool: 'private; called from initialize()/_runVectorSearchUncached inside the child',
    scheduleIndexHeal: 'private; called from search paths inside the child',
    cachedRead: 'private; wraps the child-side search/bm25 cache',
    checkGateAborted: 'private; child-side gate helper',
    _searchUncached: 'private; reached only via forwarded search()',
    _runVectorSearchUncached: 'private; reached only via forwarded searchByVector()/search()',
    _bm25SearchUncached: 'private; reached only via forwarded bm25Search()',
    // Observability / offline tooling: no production caller reaches them through the proxy.
    handleCount: 'diagnostic native-handle count; the dead parent half honestly reports 0 (scripts/diagnostics only)',
    pieceIndexForMigration: 'offline migrate/rebuild CLIs open a concrete store directly (pieceIndexBuild.ts), never the proxy',
};

await test('every state-touching VerbatimStore method is forwarded or allowlisted (names the offender)', () => {
    const fwd = new Set<string>(FORWARDED_METHODS);
    const offenders: string[] = [];
    for (const name of Object.getOwnPropertyNames(VerbatimStore.prototype)) {
        if (name === 'constructor') continue;
        const desc = Object.getOwnPropertyDescriptor(VerbatimStore.prototype, name)!;
        if (typeof desc.value !== 'function') continue; // accessors / fields
        const src = (desc.value as (...a: unknown[]) => unknown).toString();
        // Direct field use, or `this` handed to a helper (helper(this...), this.<x>Ctx).
        const touches = /this\.(table|initialized|pieceIndex|db)\b/.test(src)
            || /[(,]\s*this\s*[,)]/.test(src) || /this\.[a-zA-Z]*Ctx\b/.test(src);
        if (touches && !fwd.has(name) && !(name in PARENT_SAFE)) offenders.push(name);
    }
    assert.deepEqual(offenders, [],
        `VerbatimStore method(s) touch native state but are neither in FORWARDED_METHODS ` +
        `(engines/verbatimWorkerProtocol.ts) nor in PARENT_SAFE: ${offenders.join(', ')}`);
});

await test('the allowlist has no stale entries and none is also forwarded', () => {
    const fwd = new Set<string>(FORWARDED_METHODS);
    for (const name of Object.keys(PARENT_SAFE)) {
        assert.equal(typeof (VerbatimStore.prototype as unknown as Record<string, unknown>)[name], 'function', `${name} no longer exists on VerbatimStore`);
        assert.ok(!fwd.has(name), `${name} is both forwarded and allowlisted`);
    }
});

await test('every FORWARDED_METHODS entry exists on VerbatimStore.prototype', () => {
    for (const name of FORWARDED_METHODS) {
        assert.equal(typeof (VerbatimStore.prototype as unknown as Record<string, unknown>)[name], 'function', `forwarded ${name} missing on the real store (the child could not dispatch it)`);
    }
});

await test('purgeWithHistory + getExistingIds are forwarded (3.27.1)', () => {
    for (const n of ['purgeWithHistory', 'getExistingIds']) assert.ok((FORWARDED_METHODS as readonly string[]).includes(n), n);
});

await test('the proxy shadows every forwarded name (no inherited parent-half body left)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vwf-proxy-shadow-'));
    try {
        const proxy = new VerbatimSearchWorkerProxy(home); // constructor spawns nothing
        for (const name of FORWARDED_METHODS) {
            const own = (proxy as unknown as Record<string, unknown>)[name];
            assert.equal(typeof own, 'function', name);
            assert.notEqual(own, (VerbatimStore.prototype as unknown as Record<string, unknown>)[name], `${name} still resolves to the inherited VerbatimStore body on the proxy`);
        }
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// ── Section B — physicalDeleteMany no-op commits no version ─────────────────
console.log('\nB. physicalDeleteMany of absent ids\n');

const DIM = 8;
class FakeEmbed implements EmbeddingProvider {
    readonly modelId = 'fake-forwarding-test';
    readonly dimension = DIM;
    async initialize(): Promise<void> {}
    private vec(t: string): number[] {
        const o = new Array<number>(DIM).fill(0);
        for (let i = 0; i < t.length; i++) o[i % DIM] += t.charCodeAt(i) / 255;
        const n = Math.hypot(...o) || 1;
        return o.map((x) => x / n);
    }
    async embed(t: string): Promise<number[]> { return this.vec(t); }
    async embedQuery(t: string): Promise<number[]> { return this.vec(t); }
    async embedDocument(t: string): Promise<number[]> { return this.vec(t); }
    async embedDocumentBatch(ts: string[]): Promise<number[][]> { return ts.map((t) => this.vec(t)); }
}
const META = { type: 'note', label: 'L', tags: '', project: 'default', ecosystem: '*', updatedAt: '2026-10-03T00:00:00.000Z', security_scopes: [] as string[] };

await test('absent ids: 0 new LanceDB versions, return value unchanged; present ids still deleted', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vwf-pdm-'));
    const store = new VerbatimStore(home, new FakeEmbed());
    try {
        await store.initialize();
        await store.store({ id: 'lore:keep', text: 'keep body', metadata: { ...META } });
        await store.store({ id: 'lore:gone', text: 'gone body', metadata: { ...META } });
        const table = (store as unknown as { table: { version(): Promise<number> } }).table;
        const v0 = await table.version();
        assert.equal(await store.physicalDeleteMany(['lore:nope-1', 'lore:nope-2']), 2, 'return semantics: ids processed');
        assert.equal(await table.version(), v0, 'no-op delete must not commit a version');
        assert.equal(await store.physicalDeleteMany(['lore:gone', 'lore:nope-3']), 2);
        assert.ok((await table.version()) > v0, 'a real delete commits a version');
        assert.equal(await store.getById('lore:gone'), null);
        assert.ok(await store.getById('lore:keep'), 'neighbour survives');
    } finally { await store.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

// ── Section C — production path through createLore + a real worker child ────
console.log('\nC. createLore + search worker (real child process), Lance workspace\n');

const WS = 'default';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vwf-worker-'));
fs.mkdirSync(path.join(home, '.lore'), { recursive: true });
fs.writeFileSync(path.join(home, 'workspaces.json'), JSON.stringify({
    active: 'default',
    workspaces: [{ name: 'default', path: home, createdAt: '2026-10-03T00:00:00.000Z', graphEngine: 'sqlite', vectorEngine: 'lance' }],
}, null, 2));
delete process.env['LORE_HOME'];
delete process.env['LORE_GRAPH_PATH'];
const lore = await createLore({ deploymentMode: 'embedded', dataDir: home, searchWorkerPolicy: () => true });
await (lore._daemon.outboxWiring.replicator as { stop(): Promise<void> }).stop();

type Lore = typeof lore;
interface VStore {
    getById(id: string): Promise<{ text?: string } | null>;
    getHistory(id: string): Promise<unknown[]>;
    store(doc: { id: string; text: string; metadata: Record<string, unknown> }): Promise<void>;
    count(): Promise<number>;
}
const outbox = lore._daemon.outboxWiring.store;
const pendingRows = (l: Lore): Promise<OutboxEntry[]> => l._daemon.outboxWiring.store.listPendingForWorkspace!(WS, 1000);
async function drain(l: Lore): Promise<void> {
    const r = l._daemon.outboxWiring.replicator as { tickOnce(): Promise<number> };
    for (let i = 0; i < 40; i++) {
        if ((await pendingRows(l)).length === 0) return;
        await r.tickOnce();
    }
    assert.fail(`outbox did not drain: ${JSON.stringify((await pendingRows(l)).map((e) => [e.operationKind, e.status, e.lastError]))}`);
}
const save = (id: string) => lore.nodeUpsert({
    id, workspace: WS, ecosystem: '*', skipEmbed: true,
    nodeData: { id, type: 'note', label: id, content: `${id} body`, tags: '', project: WS, ecosystem: '*', metadata: '{}' },
});
const aliasId = (id: string, i: number) => `lore:${id}#q${i}`;
const rowsOf = async (v: VStore, id: string): Promise<number> => ((await v.getById(id)) ? 1 : 0) + (await v.getHistory(id)).length;
const isTomb = async (v: VStore, id: string) => ((await v.getById(id))?.text ?? '').startsWith('[TOMBSTONED');

try {
    const v = await lore._daemon.getVerbatimResolver()!.getOrOpen(WS) as unknown as VStore;
    // 3 saves of one row => canonical + 2 #rev history rows.
    async function seedRows(id: string): Promise<void> {
        for (const t of ['one', 'two', 'three']) await v.store({ id, text: `${t} body of ${id}`, metadata: { ...META, updatedAt: `2026-10-03T00:00:0${t.length % 10}.000Z` } });
    }
    async function prep(id: string, aliases: number): Promise<void> {
        assert.ok((await save(id)).ok);
        await drain(lore);
        await seedRows(`lore:${id}`);
        for (let i = 0; i < aliases; i++) await seedRows(aliasId(id, i));
    }
    const assertNoDead = async () => {
        assert.deepEqual((await outbox.listDead!({ workspace: WS })).map((e) => [e.operationKind, e.lastError]), [], 'nothing dead-lettered');
        assert.deepEqual((await pendingRows(lore)).map((e) => e.operationKind), [], 'nothing pending/failed');
    };

    await test('the workspace verbatim store IS a worker proxy (production wiring under test)', () => {
        assert.ok(v instanceof VerbatimSearchWorkerProxy, 'resolver opened a VerbatimSearchWorkerProxy, not an in-process store');
    });

    await test('nodeDelete default (tombstone): canonical AND alias rows are tombstoned via the worker', async () => {
        await prep('tomb', 2);
        assert.equal((await lore.nodeDelete({ id: 'tomb', workspace: WS })).deleted, true);
        await drain(lore);
        for (const id of ['lore:tomb', aliasId('tomb', 0), aliasId('tomb', 1)]) assert.ok(await isTomb(v, id), `${id} tombstoned`);
        await assertNoDead();
    });

    await test('nodeDelete purge:true: canonical + #rev + #q rows physically gone; replay verifies, none dead-lettered', async () => {
        await prep('purge1', 2);
        const before = await v.count();
        const out = await lore.nodeDelete({ id: 'purge1', workspace: WS, purge: true });
        assert.equal(out.purged, true);
        for (const id of ['lore:purge1', aliasId('purge1', 0), aliasId('purge1', 1)]) {
            assert.equal(await rowsOf(v, id), 0, `${id} (row + history) gone`);
            assert.equal(await v.getById(id), null, `${id} getById null`);
        }
        assert.ok((await v.count()) < before, `row count dropped (${before} -> ${await v.count()})`);
        await drain(lore);
        for (const id of ['lore:purge1', aliasId('purge1', 0)]) assert.equal(await rowsOf(v, id), 0, `${id} still gone after replay`);
        await assertNoDead();
    });

    await test('nodeDeleteMany purge:true: every node, alias and history row gone; replay clean', async () => {
        await prep('mp-a', 2);
        await prep('mp-b', 1);
        const before = await v.count();
        const { results } = await lore.nodeDeleteMany({ ids: ['mp-a', 'mp-b', 'mp-ghost'], workspace: WS, purge: true });
        assert.equal(results.filter((r) => (r as { deleted?: boolean }).deleted).length, 2);
        for (const id of ['lore:mp-a', aliasId('mp-a', 0), aliasId('mp-a', 1), 'lore:mp-b', aliasId('mp-b', 0)]) {
            assert.equal(await rowsOf(v, id), 0, `${id} gone`);
        }
        assert.ok((await v.count()) < before, 'row count dropped');
        await drain(lore);
        await assertNoDead();
    });

    await test('nodeDeleteMany default (tombstone): aliases tombstoned too', async () => {
        await prep('mt-a', 2);
        await lore.nodeDeleteMany({ ids: ['mt-a'], workspace: WS });
        await drain(lore);
        for (const id of ['lore:mt-a', aliasId('mt-a', 0), aliasId('mt-a', 1)]) assert.ok(await isTomb(v, id), `${id} tombstoned`);
        await assertNoDead();
    });
} finally {
    await lore.dispose('test');
    fs.rmSync(home, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
