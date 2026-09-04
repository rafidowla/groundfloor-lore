#!/usr/bin/env tsx
/**
 * sp-f3-workspace-replay-routing-unit.ts — SP-F3 regression.
 *
 * Finding 1 — replicator-replays-into-boot-workspace-only:
 *   Before SP-F3 the outbox replicator dispatched node.upsert / verbatim.upsert
 *   into the BOOT-bound graph/verbatim regardless of entry.workspace, so any
 *   write targeting a non-boot workspace was replayed into the WRONG workspace's
 *   the legacy graph engine/LanceDB (cross-workspace data contamination + manufactured orphan
 *   vectors). SP-F3 threads entry.workspace through dispatch() into the wiring
 *   substrates, which resolve the TARGET workspace's graph/verbatim via
 *   getGraphForWorkspace / getVerbatimForWorkspace (falling back to boot only
 *   when no resolver / no workspace / resolution throws).
 *
 * These cases drive the REAL dispatch() + REAL wireOutbox substrate closures
 * with injected per-workspace resolvers (plain map lookups, so the test is
 * hermetic — no workspaces.json / LORE_HOME needed). The EXPLOIT assertion
 * ("a node.upsert for workspace B must NOT land in the boot graph") fails on
 * the pre-SP-F3 tree (which always used the boot graph) and passes after.
 *
 * Finding 2 — mcp-write-tools-bypass-outbox (static probe):
 *   The MCP write tools now call recordHotWrite before the substrate write,
 *   mirroring the REST routes. A source probe keeps that wiring from silently
 *   regressing (a full daemon-driven parity test lives in the integration
 *   suites; the runtime contract is exercised by Finding-1's dispatch path,
 *   which is the same code the MCP-produced rows flow through).
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { dispatch, verifyApplied, type DispatcherSubstrates } from '../packages/lore/src/outbox/dispatcher.js';
import { wireOutbox } from '../packages/lore/src/outbox/wiring.js';
import type { OutboxEntry } from '../packages/lore/src/outbox/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

let passed = 0, failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void> | void) {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
    })());
}

/** Minimal graph fake recording which ids it received. */
function fakeGraph(name: string) {
    return {
        name,
        nodes: [] as string[],
        edges: [] as string[],
        deletedNodes: [] as string[],
        async upsertNode(n: Record<string, unknown>) { this.nodes.push(String(n['id'])); return n; },
        async addEdge(e: Record<string, unknown>) { this.edges.push(`${e['sourceId']}->${e['targetId']}`); },
        async deleteNode(id: string) { this.deletedNodes.push(id); return true; },
        async deleteEdge() { return 0; },
        async getNode(id: string) { return this.nodes.includes(id) ? { id, type: 't', label: 'l' } : null; },
        getGraphContext() {
            return {
                queryRows: async () => [{ c: 0 }],
            };
        },
    };
}

/** Minimal verbatim fake recording which ids it received. */
function fakeVerbatim(name: string) {
    return {
        name,
        stored: [] as string[],
        async store(d: { id: string }) { this.stored.push(d.id); },
        async storeBatch(ds: Array<{ id: string }>) { for (const d of ds) this.stored.push(d.id); },
        async physicalDelete(id: string) { this.stored = this.stored.filter((x) => x !== id); },
        async getById(id: string) { return this.stored.includes(id) ? { id } : null; },
    };
}

interface WsSubstrateOpts {
    bootGraph: ReturnType<typeof fakeGraph>;
    bootVerbatim: ReturnType<typeof fakeVerbatim>;
    graphByWs: Map<string, ReturnType<typeof fakeGraph>>;
    verbatimByWs: Map<string, ReturnType<typeof fakeVerbatim>>;
    /** Omit the per-workspace resolvers to exercise the boot-fallback path. */
    withResolvers: boolean;
}

function entry(operationKind: OutboxEntry['operationKind'], workspace: string | undefined, payload: Record<string, unknown>): OutboxEntry {
    const now = new Date().toISOString();
    return {
        id: `e-${Math.random().toString(36).slice(2)}`,
        operation: String(operationKind), initiator: 'test', createdAt: now, updatedAt: now,
        steps: [], completed: false, workspace, operationKind, payload, status: 'pending', attempts: 0,
    };
}

console.log('SP-F3 — outbox replay workspace routing');

// wireOutbox builds the substrates internally and hands them to the
// replicator. To exercise the substrate closures with the real
// resolveGraph/resolveVerbatim logic we reach them through the replicator the
// same object the production code uses. The replicator stores them privately;
// the test accesses them via the documented (test-only) field.
function substratesFromWiring(opts: WsSubstrateOpts): DispatcherSubstrates {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-spf3-'));
    const wiring = wireOutbox({
        loreDir: tmp,
        getSyncEngine: () => ({ recoverVectorMirror: async () => ({ recovered: 0, skipped: 0 }) }) as never,
        getGraph: () => opts.bootGraph as never,
        getVerbatim: () => opts.bootVerbatim as never,
        ...(opts.withResolvers ? {
            getGraphForWorkspace: () => (ws: string) => {
                const g = opts.graphByWs.get(ws);
                return g ? Promise.resolve(g as never) : Promise.reject(new Error(`no graph for ${ws}`));
            },
            getVerbatimForWorkspace: () => (ws: string) => {
                const v = opts.verbatimByWs.get(ws);
                return v ? Promise.resolve(v as never) : Promise.reject(new Error(`no verbatim for ${ws}`));
            },
        } : {}),
    });
    // The replicator exposes its substrates for test/observability.
    return (wiring.replicator as unknown as { substrates: DispatcherSubstrates }).substrates;
}

test('node.upsert for workspace B lands in B graph, NOT boot graph (EXPLOIT)', async () => {
    const boot = fakeGraph('boot');
    const bV = fakeVerbatim('bootV');
    const gB = fakeGraph('B');
    const vB = fakeVerbatim('B');
    const subs = substratesFromWiring({
        bootGraph: boot, bootVerbatim: bV,
        graphByWs: new Map([['B', gB]]), verbatimByWs: new Map([['B', vB]]),
        withResolvers: true,
    });
    await dispatch(entry('node.upsert', 'B', { id: 'n1', type: 't', label: 'l' }), subs);
    assert.deepEqual(gB.nodes, ['n1'], 'node must land in workspace B graph');
    assert.deepEqual(boot.nodes, [], 'node must NOT contaminate the boot graph');
});

test('verbatim.upsert for workspace B lands in B verbatim, NOT boot verbatim (EXPLOIT)', async () => {
    const boot = fakeGraph('boot');
    const bV = fakeVerbatim('bootV');
    const vB = fakeVerbatim('B');
    const subs = substratesFromWiring({
        bootGraph: boot, bootVerbatim: bV,
        graphByWs: new Map(), verbatimByWs: new Map([['B', vB]]),
        withResolvers: true,
    });
    await dispatch(entry('verbatim.upsert', 'B', { id: 'lore:n1', text: 'x', metadata: {} }), subs);
    assert.deepEqual(vB.stored, ['lore:n1'], 'verbatim must land in workspace B store');
    assert.deepEqual(bV.stored, [], 'verbatim must NOT contaminate the boot store');
});

test('node.delete for workspace B deletes from B graph only', async () => {
    const boot = fakeGraph('boot');
    const bV = fakeVerbatim('bootV');
    const gB = fakeGraph('B');
    const subs = substratesFromWiring({
        bootGraph: boot, bootVerbatim: bV,
        graphByWs: new Map([['B', gB]]), verbatimByWs: new Map(),
        withResolvers: true,
    });
    await dispatch(entry('node.delete', 'B', { id: 'n9' }), subs);
    assert.deepEqual(gB.deletedNodes, ['n9']);
    assert.deepEqual(boot.deletedNodes, []);
});

test('verbatim.upsert.batch for workspace B lands in B verbatim only', async () => {
    const boot = fakeGraph('boot');
    const bV = fakeVerbatim('bootV');
    const vB = fakeVerbatim('B');
    const subs = substratesFromWiring({
        bootGraph: boot, bootVerbatim: bV,
        graphByWs: new Map(), verbatimByWs: new Map([['B', vB]]),
        withResolvers: true,
    });
    await dispatch(entry('verbatim.upsert.batch', 'B', { items: [{ id: 'lore:a' }, { id: 'lore:b' }] }), subs);
    assert.deepEqual(vB.stored.sort(), ['lore:a', 'lore:b']);
    assert.deepEqual(bV.stored, []);
});

test('verifyApplied(node.upsert) probes workspace B, not boot', async () => {
    const boot = fakeGraph('boot');     // empty
    const bV = fakeVerbatim('bootV');
    const gB = fakeGraph('B');
    await gB.upsertNode({ id: 'present' }); // only B has it
    const subs = substratesFromWiring({
        bootGraph: boot, bootVerbatim: bV,
        graphByWs: new Map([['B', gB]]), verbatimByWs: new Map(),
        withResolvers: true,
    });
    const ok = await verifyApplied(entry('node.upsert', 'B', { id: 'present' }), subs);
    assert.equal(ok.verified, true, 'self-heal must verify against workspace B graph');
    const miss = await verifyApplied(entry('node.upsert', 'boot-only', { id: 'present' }), subs);
    // 'boot-only' has no resolver entry → resolveGraph falls back to boot (empty) → not verified.
    assert.equal(miss.verified, false);
});

test('FALLBACK: undefined workspace routes to boot graph (legacy rows)', async () => {
    const boot = fakeGraph('boot');
    const bV = fakeVerbatim('bootV');
    const gB = fakeGraph('B');
    const subs = substratesFromWiring({
        bootGraph: boot, bootVerbatim: bV,
        graphByWs: new Map([['B', gB]]), verbatimByWs: new Map(),
        withResolvers: true,
    });
    await dispatch(entry('node.upsert', undefined, { id: 'legacy' }), subs);
    assert.deepEqual(boot.nodes, ['legacy'], 'legacy (no-workspace) row must use the boot graph');
    assert.deepEqual(gB.nodes, []);
});

test('FALLBACK: no resolver wired routes to boot graph (cloud / test wirings)', async () => {
    const boot = fakeGraph('boot');
    const bV = fakeVerbatim('bootV');
    const subs = substratesFromWiring({
        bootGraph: boot, bootVerbatim: bV,
        graphByWs: new Map(), verbatimByWs: new Map(),
        withResolvers: false,
    });
    await dispatch(entry('node.upsert', 'B', { id: 'x' }), subs);
    assert.deepEqual(boot.nodes, ['x'], 'with no resolver, falls back to boot graph (prior behavior)');
});

// R2 audit #2 (high) — a workspace-scoped row whose resolver THROWS must NOT
// fall back to the boot graph/store. The old behavior (assert the write lands
// in boot, "no data loss") silently applied workspace B's node/edge/vector
// write to the boot tenant's the legacy graph engine+LanceDB — a cross-workspace isolation breach
// — and, because the misrouted write succeeded, the row drained and was never
// retried against B. dispatch() now propagates the resolver error (per its
// contract: replicator catches, bumps attempts, leaves the row PENDING), so it
// replays once B resolves or eventually dead-letters — never misrouted.
// Isolation is the load-bearing local-mode contract (CLAUDE.md).
test('ISOLATION: resolver throw leaves row PENDING — does NOT misroute node write to boot', async () => {
    const boot = fakeGraph('boot');
    const bV = fakeVerbatim('bootV');
    const subs = substratesFromWiring({
        bootGraph: boot, bootVerbatim: bV,
        graphByWs: new Map(), // resolver will reject for 'B'
        verbatimByWs: new Map(),
        withResolvers: true,
    });
    await assert.rejects(
        dispatch(entry('node.upsert', 'B', { id: 'fb' }), subs),
        'resolver throw must propagate so the replicator leaves the row pending',
    );
    assert.deepEqual(boot.nodes, [], 'boot graph must NOT receive workspace B\'s write (no cross-workspace misroute)');
});

test('ISOLATION: resolver throw leaves row PENDING — does NOT misroute verbatim write to boot', async () => {
    const boot = fakeGraph('boot');
    const bV = fakeVerbatim('bootV');
    const subs = substratesFromWiring({
        bootGraph: boot, bootVerbatim: bV,
        graphByWs: new Map(),
        verbatimByWs: new Map(), // resolver will reject for 'B'
        withResolvers: true,
    });
    await assert.rejects(
        dispatch(entry('verbatim.upsert', 'B', { id: 'n1', text: 'secret-B' }), subs),
        'verbatim resolver throw must propagate (row stays pending)',
    );
    assert.deepEqual(bV.stored, [], 'boot verbatim store must NOT receive workspace B\'s vector (no misroute)');
});

/* ---------- Finding 2 — MCP write tools record outbox rows (source probe) ---------- */

test('MCP store_node / store_edge / delete_node call recordHotWrite', () => {
    const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf-8');
    // storeEdge + deleteNode still record the outbox hot-lane write directly.
    for (const f of [
        'packages/lore/src/mcp/tools/memory/storeEdge.ts',
        'packages/lore/src/mcp/tools/memory/deleteNode.ts',
    ]) {
        const src = read(f);
        assert.match(src, /recordHotWrite\(/, `${f} must call recordHotWrite`);
        assert.match(src, /deps\.outboxStore/, `${f} must gate on deps.outboxStore`);
    }
    // W3-SERVICE-LAYER: store_node's guarded write — including the outbox
    // hot-lane node.upsert + verbatim.upsert records — moved into the shared
    // core/nodeService.ts (nodeUpsert), which storeNode.ts now delegates to (and
    // so do the REST handler + the in-process createLore() API). Behavior and the
    // operationKind taxonomy are unchanged; only the file location moved.
    const sn = read('packages/lore/src/mcp/tools/memory/storeNode.ts');
    assert.match(sn, /nodeUpsert/, 'storeNode.ts must delegate to nodeService.nodeUpsert');
    const svc = read('packages/lore/src/core/nodeService.ts');
    assert.match(svc, /recordHotWrite\(/, 'nodeService.ts must record the outbox hot-lane write');
    assert.match(svc, /operationKind: 'node\.upsert'/);
    // Verbatim fan-out (including verbatim.upsert) lives in the file-size split.
    const verbatim = read('packages/lore/src/core/nodeServiceVerbatim.ts');
    assert.match(verbatim, /recordHotWrite\(/, 'nodeServiceVerbatim.ts must record verbatim.upsert');
    assert.match(verbatim, /operationKind: 'verbatim\.upsert'/);
    const se = read('packages/lore/src/mcp/tools/memory/storeEdge.ts');
    assert.match(se, /operationKind: 'edge\.upsert'/);
    const dn = read('packages/lore/src/mcp/tools/memory/deleteNode.ts');
    assert.match(dn, /operationKind: 'node\.delete'/);
});

test('MemoryToolsDeps + CreateMcpServerDeps expose outboxStore', () => {
    const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf-8');
    assert.match(read('packages/lore/src/mcp/tools/memory/types.ts'), /outboxStore\?:/);
    assert.match(read('packages/lore/src/mcp/createMcpServer.ts'), /outboxStore\?:/);
    // server.ts wires the boot outbox store into createMcpServer.
    assert.match(read('packages/lore/src/mcp/server.ts'), /outboxStore: outboxWiring\.store/);
});

(async () => {
    await Promise.all(pending);
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
})();
