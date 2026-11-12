#!/usr/bin/env tsx
/**
 * purge-restore-fence-unit.ts — fix round 3: snapshot RESTORES must not write back a node purged after the
 * snapshot was read (core/purgeFence.ts), and a changeset-commit version-row failure keeps 3.38.3's accounting.
 *
 *  - nodeUpsert({ purgeFence }) refuses a purged id under the lock; a fence opened after the purge does not.
 *  - bulkIngest cancel-restore: a purge landing after the bulk graph write leaves the id erased (the restore of
 *    the pre-bulk snapshot is refused, and the bulk write itself is undone like a create).
 *  - rollback_changeset (MCP + HTTP): a purge between reading the version rows and restoring previous_state
 *    leaves the node erased; the write counts as failed.
 *  - commit_changeset (MCP + HTTP) with a failing version row: the node still lands, the MCP quota delta is still
 *    counted, and the write is still reported as failed (3.38.3 recorded that row after all of these).
 *
 * Run: npx tsx test/purge-restore-fence-unit.ts
 */
import assert from 'node:assert/strict';
import { nodeUpsert } from '../packages/lore/src/core/nodeService.js';
import { openPurgeFence } from '../packages/lore/src/core/purgeFence.js';
import { runBulkIngest, type BulkIngestDeps } from '../packages/lore/src/mcp/bulkIngest.js';
import { defaultAutolinkTracker } from '../packages/lore/src/engines/pendingAutolink.js';
import { registerVersioningTools, type VersioningDeps } from '../packages/lore/src/mcp/tools/versioning.js';
import { tryVersioningRoutes, type VersioningRouteDeps } from '../packages/lore/src/mcp/http/routes/versioning.js';
import type { StorageBundle } from '../packages/lore/src/mcp/services.js';
import { WS, test, finish, withStack, startPurge, seed, assertErased, fakeReq, fakeRes, toolCapture, type Stack } from './helpers/purgeRaceHarness.js';

const upsertArgs = (s: Stack, id: string, content: string, ws = WS) => ({
    id, workspace: ws, ecosystem: '*', initiator: 'test:restore',
    nodeData: { id, type: 'note', label: id, content, tags: ['t'], security_scopes: [] as string[] }, targetGraph: s.graph as never,
});
const bundle = (s: Stack): StorageBundle => ({
    loreGraph: s.graph, loreVerbatim: s.store,
    storageClient: { verbatimStore: (w: never) => s.store.store(w), verbatimDelete: async () => undefined },
}) as unknown as StorageBundle;

/** Commits a one-write changeset that overwrites `id` (seeded with `secret-<id>`), via the real store. */
async function committedChangeset(s: Stack, id: string): Promise<string> {
    await seed(s, id);
    const cs = await s.versions.createChangeset(WS);
    await s.versions.addChangesetWrite(cs, 'upsert_node', { workspace: WS, nodeData: { id, type: 'note', label: id, content: `v2-${id}`, tags: ['t'] } });
    const t = toolCapture();
    registerVersioningTools(t.server, { versionStore: s.versions, store: bundle(s), detectedScope: { workspace: WS, ecosystem: '*' } } as unknown as VersioningDeps);
    const r = await t.call('commit_changeset', { changeset_id: cs });
    assert.match(r.content[0]!.text, /"applied":\s*1/, r.content[0]!.text);
    assert.equal((await s.graph.getNode(id))?.content, `v2-${id}`);
    return cs;
}
/** The rollback reads the changeset's version rows, then (before restoring them) a purge runs to completion. */
function purgeAfterVersionRead(s: Stack, id: string): void {
    const real = s.versions.getVersionsByChangeset.bind(s.versions);
    (s.versions as unknown as { getVersionsByChangeset: unknown }).getVersionsByChangeset = async (cs: string) => {
        const rows = await real(cs);
        assert.ok(rows.some((v) => (v.previousState as { content?: string } | null)?.content === `secret-${id}`), 'snapshot holds the content');
        await startPurge(s, id);
        return rows;
    };
}

await test('nodeUpsert purgeFence: a purge after the fence opened refuses the restore; node stays erased', async () => {
    await withStack(async (s) => {
        await seed(s, 'f1');
        const fence = openPurgeFence();
        try {
            await startPurge(s, 'f1');
            const r = await nodeUpsert(upsertArgs(s, 'f1', 'secret-f1'), { inlineVerbatim: { verbatimStore: (w) => s.store.store(w) }, purgeFence: fence });
            assert.equal(r.ok, false);
            assert.equal(!r.ok && r.code, 'write_failed');
        } finally { fence.close(); }
        await assertErased(s, 'f1');
    });
});

await test('nodeUpsert purgeFence: a fence opened AFTER the purge does not block a re-create (H1)', async () => {
    await withStack(async (s) => {
        await seed(s, 'f2'); await startPurge(s, 'f2');
        const fence = openPurgeFence();
        try {
            const r = await nodeUpsert(upsertArgs(s, 'f2', 'new'), { inlineVerbatim: { verbatimStore: (w) => s.store.store(w) }, purgeFence: fence });
            assert.equal(r.ok, true);
        } finally { fence.close(); }
        assert.equal((await s.graph.getNode('f2'))?.content, 'new');
    });
});

await test('bulkIngest cancel-restore: a purge after the bulk write leaves the id erased', async () => {
    await bulkCancelCase(3);
});

await test('bulkIngest cancel-restore: a purge before the bulk write => the bulk write (a create) is undone, snapshot not restored', async () => {
    await bulkCancelCase(2);
});

/** Purge started at abort poll `at` (2 = after the pre-read, before the graph write; 3 = after the graph write), cancel at poll 3. */
async function bulkCancelCase(at: 2 | 3): Promise<void> {
    await withStack(async (s) => {
        await s.graph.upsertNode({ id: 'old', type: 'note', label: 'old', content: 'secret-old', tags: [], project: 'w', ecosystem: '*', metadata: '{}' } as never);
        const noop = () => undefined;
        const stub = new Proxy({}, { get: () => noop }) as never;
        const deps: BulkIngestDeps = {
            graph: s.graph as never, graphRegistry: null, activeWorkspaceName: () => '__not_active__', outboxStore: undefined,
            embedQueue: { enqueue: noop } as never, verbatimStore: s.store as never, storageClient: stub, loreVerbatim: s.store as never,
            embeddingProvider: { dimension: 8, embedDocumentBatch: async (t: string[]) => t.map(() => new Array(8).fill(0.2)), dispose: noop } as never,
            getWal: () => stub, versionStore: undefined, autolinkTracker: defaultAutolinkTracker,
        };
        let polls = 0;
        let purge: Promise<unknown> | null = null;
        const res = await runBulkIngest([{ id: 'old', workspace: 'w', ecosystem: '*', nodeData: { id: 'old', type: 'note', label: 'old', content: 'clobber', tags: [], project: 'w', ecosystem: '*', metadata: '{}' } }] as never, {
            autolink: false,
            // The purge takes the free node lock synchronously (a later nodeUpsert queues behind it); the cancel runs at poll 3.
            shouldAbort: () => { if (++polls >= at) purge ??= startPurge(s, 'old', 'w'); return polls > 2; },
        }, deps);
        assert.ok(purge, 'purge never started');
        await purge;
        assert.ok(res.results.every((r) => !r.ok && r.error === 'cancelled'));
        assert.equal(await s.graph.getNode('old'), null, 'neither the purged snapshot nor the cancelled bulk write may remain');
    });
}

await test('MCP rollback_changeset: purge between the version read and the restore => node stays erased, write failed', async () => {
    await withStack(async (s) => {
        const cs = await committedChangeset(s, 'rk-mcp');
        purgeAfterVersionRead(s, 'rk-mcp');
        const t = toolCapture();
        registerVersioningTools(t.server, { versionStore: s.versions, store: bundle(s), detectedScope: { workspace: WS, ecosystem: '*' } } as unknown as VersioningDeps);
        const r = await t.call('rollback_changeset', { changeset_id: cs });
        const body = JSON.parse(r.content[0]!.text) as { failed: number; reversed: number; errors: string[] };
        assert.equal(body.failed, 1, r.content[0]!.text); assert.equal(body.reversed, 0);
        assert.match(body.errors[0]!, /purged/);
        await assertErased(s, 'rk-mcp');
    });
});

await test('HTTP POST /api/changesets/:id/rollback: purge between the version read and the restore => node stays erased', async () => {
    await withStack(async (s) => {
        const cs = await committedChangeset(s, 'rk-http');
        purgeAfterVersionRead(s, 'rk-http');
        const res = fakeRes();
        const p = `/api/changesets/${cs}/rollback`;
        await tryVersioningRoutes(fakeReq('{}'), res, p, p, { versionStore: s.versions, store: bundle(s), deploymentMode: 'local', dataplane: null } as unknown as VersioningRouteDeps);
        assert.equal(res._status, 200, res._body);
        const body = JSON.parse(res._body) as { failed: number; reversed: number };
        assert.equal(body.failed, 1, res._body); assert.equal(body.reversed, 0);
        await assertErased(s, 'rk-http');
    });
});

await test('rollback_changeset without a purge still restores previous_state (control)', async () => {
    await withStack(async (s) => {
        const cs = await committedChangeset(s, 'rk-ok');
        const t = toolCapture();
        registerVersioningTools(t.server, { versionStore: s.versions, store: bundle(s), detectedScope: { workspace: WS, ecosystem: '*' } } as unknown as VersioningDeps);
        const r = await t.call('rollback_changeset', { changeset_id: cs });
        assert.match(r.content[0]!.text, /"reversed":\s*1/, r.content[0]!.text);
        assert.equal((await s.graph.getNode('rk-ok'))?.content, 'secret-rk-ok');
    });
});

const failingVersions = (s: Stack): void => {
    (s.versions as unknown as { recordVersion: unknown }).recordVersion = async () => { throw new Error('version store down'); };
};

await test('MCP commit_changeset, version row fails: node lands, quota delta counted, write reported failed (3.38.3 parity)', async () => {
    await withStack(async (s) => {
        const cs = await s.versions.createChangeset(WS);
        await s.versions.addChangesetWrite(cs, 'upsert_node', { workspace: WS, nodeData: { id: 'm2', type: 'note', label: 'm2', content: 'body', tags: ['t'] } });
        failingVersions(s);
        const quota: Array<{ ws: string; delta: { nodes: number; bytes: number } }> = [];
        const t = toolCapture();
        registerVersioningTools(t.server, {
            versionStore: s.versions, store: bundle(s), detectedScope: { workspace: WS, ecosystem: '*' },
            quotaStore: { increment: (ws: string, delta: { nodes: number; bytes: number }) => { quota.push({ ws, delta }); } },
        } as unknown as VersioningDeps);
        const r = await t.call('commit_changeset', { changeset_id: cs });
        const body = JSON.parse(r.content[0]!.text) as { applied: number; failed: number; errors: string[] };
        assert.equal(body.applied, 0); assert.equal(body.failed, 1, r.content[0]!.text);
        assert.match(body.errors[0]!, /version store down/);
        assert.deepEqual(quota, [{ ws: WS, delta: { nodes: 1, bytes: Buffer.byteLength('m2body') } }], 'the landed write is still counted');
        assert.equal((await s.graph.getNode('m2'))?.content, 'body');
    });
});

await test('HTTP commit, version row fails: node lands, write reported failed (3.38.3 parity)', async () => {
    await withStack(async (s) => {
        const cs = await s.versions.createChangeset(WS);
        await s.versions.addChangesetWrite(cs, 'upsert_node', { workspace: WS, nodeData: { id: 'm2h', type: 'note', label: 'm2h', content: 'body', tags: ['t'] } });
        failingVersions(s);
        const res = fakeRes();
        const p = `/api/changesets/${cs}/commit`;
        await tryVersioningRoutes(fakeReq('{}'), res, p, p, { versionStore: s.versions, store: bundle(s), deploymentMode: 'local', dataplane: null } as unknown as VersioningRouteDeps);
        assert.equal(res._status, 200, res._body);
        const body = JSON.parse(res._body) as { applied: number; failed: number };
        assert.equal(body.applied, 0, res._body); assert.equal(body.failed, 1);
        assert.equal((await s.graph.getNode('m2h'))?.content, 'body');
    });
});

finish();
