#!/usr/bin/env tsx
/**
 * w5-sync-version-handshake.ts — W5-MIGRATION-VERSION regression tests.
 *
 * The SyncAdapter contract used to push/pull raw LoreNode[]/LoreEdge[]
 * with NO schema-version field, so a host on data-version vX syncing
 * against a peer/cloud on vY had no negotiation — a newer-shaped payload
 * was silently last-writer-wins applied. This wave adds a version
 * handshake:
 *
 *   (a) PUSH stamps CURRENT_DATA_VERSION onto the outbound envelope
 *       (via the optional pushVersioned() hook). The constant is the
 *       single source of truth, owned by migration/coordinator.ts and
 *       re-exported from the sync engine — both read the SAME value.
 *
 *   (b) PULL with a STRICTLY HIGHER incoming schemaVersion is REFUSED:
 *       the batch is logged + skipped (NOT applied), the pull cursor is
 *       NOT advanced, and PullResult.schemaVersionRefused surfaces the
 *       offending version. No nodes land locally.
 *
 *   (c) PULL with a missing/undefined OR equal schemaVersion applies
 *       normally (back-compat: a legacy peer that predates the handshake
 *       is treated as current, never a failure).
 *
 * Each assertion fails on base (pre-W5 syncEngine.ts) and passes here.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    SyncEngine,
    CURRENT_DATA_VERSION,
    type SyncAdapter,
    type SyncResult,
    type VersionedPushEnvelope,
    type VersionedPullResult,
} from '../packages/lore/src/engines/syncEngine.js';
import { CURRENT_DATA_VERSION as COORD_VERSION } from '../packages/lore/src/migration/coordinator.js';
import type { LoreNode, LoreEdge } from '../packages/lore/src/providers/types.js';

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

function tmpLoreDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'w5-sync-version-'));
}

const EPOCH = '1970-01-01T00:00:00.000Z';

function makeNode(id: string, updatedAt: string): LoreNode {
    return {
        id,
        type: 'decision',
        label: id,
        content: '',
        tags: '',
        project: '*',
        ecosystem: '*',
        metadata: '{}',
        createdAt: updatedAt,
        updatedAt,
        syncedAt: '',
    } as LoreNode;
}

/** Minimal local-graph stub: records every upsert so we can assert that
 *  a refused batch applied NOTHING. */
function makeGraph() {
    const nodes = new Map<string, LoreNode>();
    const upserts: string[] = [];
    return {
        nodes,
        upserts,
        async getNode(id: string): Promise<LoreNode | null> { return nodes.get(id) ?? null; },
        async upsertNode(n: LoreNode): Promise<void> { upserts.push(n.id); nodes.set(n.id, n); },
        async addEdge(_e: LoreEdge): Promise<void> { /* no edges in these cases */ },
        async markSynced(_id: string): Promise<void> { /* no-op */ },
    };
}

/** Version-aware adapter. Records the schemaVersion it was pushed, and
 *  serves a programmable VersionedPullResult (with optional version). */
interface VersionAdapter extends SyncAdapter {
    pushedVersions: number[];
    pullResult: VersionedPullResult;
}

function makeVersionAdapter(pullResult: VersionedPullResult): VersionAdapter {
    const a: VersionAdapter = {
        pushedVersions: [],
        pullResult,
        async push(nodes: LoreNode[], edges: LoreEdge[]): Promise<SyncResult> {
            return { nodesPushed: nodes.length, edgesPushed: edges.length, failures: 0, errors: [] };
        },
        async pushVersioned(env: VersionedPushEnvelope): Promise<SyncResult> {
            a.pushedVersions.push(env.schemaVersion);
            return { nodesPushed: env.nodes.length, edgesPushed: env.edges.length, failures: 0, errors: [] };
        },
        async pull(_since: string) {
            return { nodes: a.pullResult.nodes, edges: a.pullResult.edges };
        },
        async pullVersioned(_since: string): Promise<VersionedPullResult> {
            return a.pullResult;
        },
        async isConnected() { return true; },
        async connect() { /* no-op */ },
        async disconnect() { /* no-op */ },
    };
    return a;
}

/** Legacy adapter — NO versioned hooks. Used for the back-compat case. */
function makeLegacyAdapter(nodes: LoreNode[]): SyncAdapter {
    return {
        async push(ns: LoreNode[], es: LoreEdge[]): Promise<SyncResult> {
            return { nodesPushed: ns.length, edgesPushed: es.length, failures: 0, errors: [] };
        },
        async pull(_since: string) {
            return { nodes, edges: [] };
        },
        async isConnected() { return true; },
        async connect() { /* no-op */ },
        async disconnect() { /* no-op */ },
    };
}

(async () => {
    console.log('W5-MIGRATION-VERSION · sync data-version handshake');

    // ───────────────────────────────────────────────────────────────────
    // Single-source-of-truth: the sync engine and the migration coordinator
    // read the SAME constant.
    // ───────────────────────────────────────────────────────────────────
    await test('CURRENT_DATA_VERSION agrees between sync engine and migration coordinator', () => {
        assert.equal(CURRENT_DATA_VERSION, COORD_VERSION,
            'sync engine and migration coordinator must share one CURRENT_DATA_VERSION');
        assert.equal(typeof CURRENT_DATA_VERSION, 'number', 'CURRENT_DATA_VERSION must be a number');
    });

    // ───────────────────────────────────────────────────────────────────
    // (a) push stamps CURRENT_DATA_VERSION on the outbound envelope.
    // ───────────────────────────────────────────────────────────────────
    await test('(a) push stamps CURRENT_DATA_VERSION on the envelope', async () => {
        const dir = tmpLoreDir();
        const graph = makeGraph();
        const adapter = makeVersionAdapter({ nodes: [], edges: [] });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const engine = new SyncEngine(graph as any, dir, adapter);

        // Append a node to the WAL so there is something to push.
        engine.getWal().append('upsert_node', makeNode('n1', '2026-01-01T00:00:00.000Z') as unknown as Record<string, unknown>);
        const result = await engine.pushPending();

        assert.equal(result.failures, 0, `push must succeed (got ${JSON.stringify(result)})`);
        assert.deepEqual(adapter.pushedVersions, [CURRENT_DATA_VERSION],
            `pushVersioned must be called once with CURRENT_DATA_VERSION (got ${JSON.stringify(adapter.pushedVersions)})`);
    });

    // ───────────────────────────────────────────────────────────────────
    // (b) pull with a HIGHER incoming schemaVersion is refused (not applied).
    // ───────────────────────────────────────────────────────────────────
    await test('(b) pull refuses a strictly-higher schemaVersion (batch NOT applied)', async () => {
        const dir = tmpLoreDir();
        const graph = makeGraph();
        const newer = CURRENT_DATA_VERSION + 1;
        const adapter = makeVersionAdapter({
            nodes: [makeNode('remote-newer', '2030-01-01T00:00:00.000Z')],
            edges: [],
            schemaVersion: newer,
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const engine = new SyncEngine(graph as any, dir, adapter);

        const r = await engine.pullRemote();

        assert.equal(r.schemaVersionRefused, newer,
            `pull must flag the refused version (got ${JSON.stringify(r)})`);
        assert.equal(r.nodesPulled, 0, 'a refused batch must apply zero nodes');
        assert.equal(graph.upserts.length, 0,
            `a refused batch must NOT upsert locally (got upserts=${JSON.stringify(graph.upserts)})`);
        assert.equal(graph.nodes.has('remote-newer'), false,
            'the unknown-newer node must NOT be present locally');

        // Cursor must NOT advance — a future, version-aware build re-pulls it.
        const pullCursorPath = path.join(dir, '.last-sync.pull');
        const onDisk = fs.existsSync(pullCursorPath) ? fs.readFileSync(pullCursorPath, 'utf-8').trim() : '';
        assert.ok(!onDisk || onDisk === EPOCH,
            `pull cursor must NOT advance on a refused batch (got '${onDisk}')`);
    });

    // ───────────────────────────────────────────────────────────────────
    // (c1) pull with an EQUAL schemaVersion applies normally.
    // ───────────────────────────────────────────────────────────────────
    await test('(c1) pull with equal schemaVersion applies normally', async () => {
        const dir = tmpLoreDir();
        const graph = makeGraph();
        const adapter = makeVersionAdapter({
            nodes: [makeNode('remote-equal', '2030-01-01T00:00:00.000Z')],
            edges: [],
            schemaVersion: CURRENT_DATA_VERSION,
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const engine = new SyncEngine(graph as any, dir, adapter);

        const r = await engine.pullRemote();

        assert.equal(r.schemaVersionRefused, undefined, 'equal version must NOT be refused');
        assert.equal(r.nodesPulled, 1, `equal-version batch must apply (got ${JSON.stringify(r)})`);
        assert.equal(graph.nodes.has('remote-equal'), true, 'the node must be present locally');
    });

    // ───────────────────────────────────────────────────────────────────
    // (c2) pull from a LEGACY adapter (no version, no pullVersioned hook)
    //      applies normally — back-compat.
    // ───────────────────────────────────────────────────────────────────
    await test('(c2) pull from a legacy adapter (missing version) applies normally', async () => {
        const dir = tmpLoreDir();
        const graph = makeGraph();
        const adapter = makeLegacyAdapter([makeNode('remote-legacy', '2030-01-01T00:00:00.000Z')]);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const engine = new SyncEngine(graph as any, dir, adapter);

        const r = await engine.pullRemote();

        assert.equal(r.schemaVersionRefused, undefined,
            'a missing version (legacy peer) must NOT be refused');
        assert.equal(r.nodesPulled, 1, `legacy batch must apply (got ${JSON.stringify(r)})`);
        assert.equal(graph.nodes.has('remote-legacy'), true, 'the legacy node must be present locally');
    });

    console.log(`\nW5-MIGRATION-VERSION: ${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
})();
