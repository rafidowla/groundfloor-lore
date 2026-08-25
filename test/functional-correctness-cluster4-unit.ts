#!/usr/bin/env tsx
/**
 * test/functional-correctness-cluster4-unit.ts — 2026-08-17 functional-
 * correctness remediation, Cluster 4 (migration/maintenance invariants,
 * SurrealGraph correctness) + the shared core/nodeService.ts autolink-gate
 * fixes (1.3, 1.4, 3.1) that landed alongside it.
 *
 * Priority item (4.2): SurrealGraph — the DEFAULT graph engine — reset every
 * lifecycle field to schema defaults on a partial update.
 *
 * Run: npx tsx test/functional-correctness-cluster4-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import { nodeUpsert } from '../packages/lore/src/core/nodeService.js';
import { defaultAutolinkTracker } from '../packages/lore/src/engines/pendingAutolink.js';
import type { LoreNode } from '../packages/lore/src/providers/types.js';
import { migrateEmbeddingModel } from '../packages/lore/src/engines/migrateEmbeddingModel.js';
import { handleSupersede, handleUnsupersede } from '../packages/lore/src/mcp/http/routes/nodes/supersede.js';
import type { NodesDeps } from '../packages/lore/src/mcp/http/routes/nodes/types.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuditLog } from '../packages/lore/src/security/audit.js';


let passed = 0;
let failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void>) {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? String(err)}`); failed++; }
    })());
}

function tmpDir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Best-effort tmp-dir cleanup. SurrealGraph's embedded storage can still be
 * flushing background writes for a moment after close() resolves, which
 * races a plain fs.rmSync into ENOTEMPTY; the test assertions have already
 * run by this point, so a stray os.tmpdir() leftover is harmless.
 */
function rmDir(dir: string): void {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function node(id: string, over: Partial<LoreNode> = {}): Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'> {
    return {
        id,
        type: 'decision',
        label: `Label ${id}`,
        content: `Content ${id}`,
        tags: ['alpha'],
        project: 'p',
        ecosystem: '*',
        metadata: '{}',
        ...over,
    } as Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>;
}

/* ────────────────────────────────────────────────────────────────────────
 * PRIORITY (4.2) — SurrealGraph lifecycle-field clobber on partial update.
 * ──────────────────────────────────────────────────────────────────────── */

test('4.2 (PRIORITY): SurrealGraph preserves status/classification/scopes/stale/language/ephemeral/ttl_ms on a partial update', async () => {
    const sdir = tmpDir('lore-42-surreal-');
    const surreal = new SurrealGraph(sdir, { workspaceId: 'w' });
    try {
        await surreal.initialize();
        const seed = node('n1', {
            status: 'archived',
            classification: 'tactical',
            security_scopes: ['team:eng'],
            stale: true,
            language: 'en',
            ephemeral: true,
            ttl_ms: 60000,
        });
        await surreal.upsertNode(seed);

        // Ordinary partial edit — store_node's real payload shape (no
        // lifecycle fields sent at all).
        const partialEdit = node('n1', { content: 'edited content' });
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete (partialEdit as Record<string, unknown>)['status'];
        await surreal.upsertNode(partialEdit);

        const after = await surreal.getNode('n1');
        assert.equal(after?.status, 'archived', 'status must survive a partial edit');
        assert.equal(after?.classification, 'tactical', 'classification must survive');
        assert.deepEqual(after?.security_scopes, ['team:eng'], 'security_scopes must survive');
        assert.equal(after?.stale, true, 'stale must survive');
        assert.equal(after?.language, 'en', 'language must survive');
        assert.equal(after?.ephemeral, true, 'ephemeral must survive');
        assert.equal(after?.ttl_ms, 60000, 'ttl_ms must survive');
        assert.equal(after?.content, 'edited content', 'the actual edit must still apply');
    } finally {
        await surreal.close().catch(() => undefined);
        rmDir(sdir);
    }
});

test('4.2: SurrealGraph preserves validFrom/validUntil on a partial update (previously wiped to null)', async () => {
    const dir = tmpDir('lore-42-vft-');
    const g = new SurrealGraph(dir, { workspaceId: 'w' });
    try {
        await g.initialize();
        await g.upsertNode(node('vt1', { validFrom: '2020-01-01T00:00:00.000Z', validUntil: '2030-01-01T00:00:00.000Z' }));
        const partial = node('vt1', { content: 'edited' });
        delete (partial as Record<string, unknown>)['validFrom'];
        delete (partial as Record<string, unknown>)['validUntil'];
        await g.upsertNode(partial);
        const after = await g.getNode('vt1');
        assert.equal(after?.validFrom, '2020-01-01T00:00:00.000Z', 'validFrom must survive a plain re-store');
        assert.equal(after?.validUntil, '2030-01-01T00:00:00.000Z', 'validUntil must survive a plain re-store');
    } finally {
        await g.close().catch(() => undefined);
        rmDir(dir);
    }
});

/* ────────────────────────────────────────────────────────────────────────
 * 4.1 — embedded nodeUpsert dropped `ecosystem` from the graph row.
 * ──────────────────────────────────────────────────────────────────────── */

test('4.1: nodeService.nodeUpsert (the embedded API entry point) writes the ecosystem arg to the graph row', async () => {
    const dir = tmpDir('lore-41-');
    const g = new SurrealGraph(dir, { workspaceId: 'w' });
    try {
        await g.initialize();
        // The exact broken shape from the finding: index.ts's own quick-start
        // example — ecosystem passed as a top-level arg, NOT inside nodeData.
        const result = await nodeUpsert({
            id: 'eco-1',
            workspace: 'w',
            ecosystem: 'my-project',
            nodeData: { id: 'eco-1', type: 'decision', label: 'L', content: 'C' } as Record<string, unknown>,
            targetGraph: g as never,
            initiator: 'lib:nodeUpsert',
            skipEmbed: true,
        });
        assert.ok(result.ok, 'write must succeed');
        const stored = await g.getNode('eco-1');
        assert.equal(stored?.ecosystem, 'my-project', 'ecosystem must reach the graph row, not fall to the "*" default');
    } finally {
        await g.close().catch(() => undefined);
        rmDir(dir);
    }
});

/* ────────────────────────────────────────────────────────────────────────
 * 1.3/1.4/3.1 — autolink gate + duplicate-write race.
 * ──────────────────────────────────────────────────────────────────────── */

test('1.3: autolink fires even when skipEmbed:true (the bulkIngest shape) — no longer unreachable', async () => {
    const dir = tmpDir('lore-13-');
    const g = new SurrealGraph(dir, { workspaceId: 'w' });
    const verbatim = new VerbatimStore(dir);
    try {
        await g.initialize();
        await verbatim.initialize();
        // Seed a near-duplicate node with an outbox-free inline verbatim
        // write so it's embedded and a candidate for the autolink search.
        await g.upsertNode(node('seed', { content: 'graph substrate decisions for lore memory system' }));
        await verbatim.store({ id: 'lore:seed', text: 'graph substrate decisions for lore memory system', metadata: { type: 'decision', label: 'L', tags: '', project: 'w', ecosystem: '*', updatedAt: new Date().toISOString(), security_scopes: [] } });

        const result = await nodeUpsert(
            {
                id: 'ingest-1',
                workspace: 'w',
                ecosystem: '*',
                // bulkIngest's exact shape: skipEmbed hardcoded true (vectors
                // handled later in its own batch step), autolink requested.
                nodeData: { id: 'ingest-1', type: 'decision', label: 'L2', content: 'graph substrate decisions for lore memory system too' } as Record<string, unknown>,
                targetGraph: g as never,
                initiator: 'test:bulkIngest-shape',
                skipEmbed: true,
                isActiveWorkspace: true,
            },
            { autolink: { graph: g as never, verbatim: verbatim as never, tracker: defaultAutolinkTracker } },
        );
        assert.ok(result.ok);
        // autolink is fire-and-forget (tracked, not awaited) — give it a
        // moment to complete the embed + search + addEdge round trip.
        await new Promise((r) => setTimeout(r, 500));
        const edges = await g.queryEdges({ source: 'ingest-1', limit: 100, offset: 0 });
        assert.ok(edges.length > 0, `expected at least one semantic_neighbor edge from the skipEmbed:true autolink path; got ${JSON.stringify(edges)}`);
    } finally {
        await g.close().catch(() => undefined);
        await verbatim.close?.().catch(() => undefined);
        rmDir(dir);
    }
});

test('1.4: autolink fires for a non-active workspace when hooks.autolink is correctly wired to the TARGET workspace', async () => {
    const bootDir = tmpDir('lore-14-boot-');
    const targetDir = tmpDir('lore-14-target-');
    const bootGraph = new SurrealGraph(bootDir, { workspaceId: 'boot' });
    const targetGraph = new SurrealGraph(targetDir, { workspaceId: 'wsb' });
    const targetVerbatim = new VerbatimStore(targetDir);
    try {
        await bootGraph.initialize();
        await targetGraph.initialize();
        await targetVerbatim.initialize();
        await targetGraph.upsertNode(node('seed', { content: 'graph substrate decisions for lore memory system' }));
        await targetVerbatim.store({ id: 'lore:seed', text: 'graph substrate decisions for lore memory system', metadata: { type: 'decision', label: 'L', tags: '', project: 'wsb', ecosystem: '*', updatedAt: new Date().toISOString(), security_scopes: [] } });

        const result = await nodeUpsert(
            {
                id: 'nonactive-1',
                workspace: 'wsb',
                ecosystem: '*',
                nodeData: { id: 'nonactive-1', type: 'decision', label: 'L2', content: 'graph substrate decisions for lore memory system too' } as Record<string, unknown>,
                targetGraph: targetGraph as never,
                initiator: 'test:non-active-workspace',
                skipEmbed: true,
                // isActiveWorkspace is FALSE — the old gate would have
                // silently skipped autolink here forever.
                isActiveWorkspace: false,
            },
            { autolink: { graph: targetGraph as never, verbatim: targetVerbatim as never, tracker: defaultAutolinkTracker } },
        );
        assert.ok(result.ok);
        await new Promise((r) => setTimeout(r, 500));
        const targetEdges = await targetGraph.queryEdges({ source: 'nonactive-1', limit: 100, offset: 0 });
        assert.ok(targetEdges.length > 0, `non-active workspace must still get semantic edges; got ${JSON.stringify(targetEdges)}`);
        const bootEdges = await bootGraph.queryEdges({ limit: 1000, offset: 0 });
        assert.equal(bootEdges.length, 0, 'the boot/active graph must never see this write');
    } finally {
        await bootGraph.close().catch(() => undefined);
        await targetGraph.close().catch(() => undefined);
        await targetVerbatim.close?.().catch(() => undefined);
        rmDir(bootDir);
        rmDir(targetDir);
    }
});

test('3.1: autolink no longer double-writes the canonical verbatim row when nodeService already wrote it', async () => {
    const dir = tmpDir('lore-31-');
    const g = new SurrealGraph(dir, { workspaceId: 'w' });
    const verbatim = new VerbatimStore(dir);
    try {
        await g.initialize();
        await verbatim.initialize();
        const result = await nodeUpsert(
            {
                id: 'dup-1',
                workspace: 'w',
                ecosystem: '*',
                nodeData: { id: 'dup-1', type: 'decision', label: 'L', content: 'a fairly long piece of content for the duplicate-write race check' } as Record<string, unknown>,
                targetGraph: g as never,
                initiator: 'test:no-outbox-inline-verbatim',
                skipEmbed: false,
                isActiveWorkspace: true,
            },
            {
                // Inline verbatim path (no outbox wired) — this IS the
                // canonical-row writer for this call; autolink must not
                // ALSO write it.
                verbatim: { verbatimStore: (w: { id: string; text: string; metadata: Record<string, unknown> }) => verbatim.store(w) },
                autolink: { graph: g as never, verbatim: verbatim as never, tracker: defaultAutolinkTracker },
            },
        );
        assert.ok(result.ok);
        await new Promise((r) => setTimeout(r, 500));
        const ids = await verbatim.listIds('lore:dup-1');
        const canonicalCount = ids.filter((id) => id === 'lore:dup-1').length;
        assert.equal(canonicalCount, 1, `expected exactly one canonical row for lore:dup-1; got ${canonicalCount} (ids=${JSON.stringify(ids)})`);
    } finally {
        await g.close().catch(() => undefined);
        await verbatim.close?.().catch(() => undefined);
        rmDir(dir);
    }
});

/* ────────────────────────────────────────────────────────────────────────
 * 4.5 — migrateEmbeddingModel dropped non-node verbatim documents.
 * ──────────────────────────────────────────────────────────────────────── */

test('4.5: migrateEmbeddingModel preserves a store_verbatim (non-lore:) document across the table drop + rebuild', async () => {
    const base = tmpDir('lore-45-');
    fs.mkdirSync(path.join(base, '.lore'), { recursive: true });
    const graph = new SurrealGraph(base, { workspaceId: 'w' });
    try {
        await graph.initialize();
        await graph.upsertNode(node('gnode'));

        function stubProvider(modelId: string, dimension: number, seedMult: number) {
            return {
                modelId,
                dimension,
                async initialize() { /* no-op */ },
                async embed(t: string) { return new Array(dimension).fill(0).map((_, i) => (t.length + i * seedMult) % 7); },
                async embedQuery(t: string) { return new Array(dimension).fill(0).map((_, i) => (t.length + i * seedMult) % 7); },
                async embedDocument(t: string) { return new Array(dimension).fill(0).map((_, i) => (t.length + i * seedMult) % 7); },
            };
        }
        const oldProvider = stubProvider('old-model', 8, 1);
        const seedVerbatim = new VerbatimStore(base, oldProvider as never);
        await seedVerbatim.initialize();
        await seedVerbatim.store({ id: 'lore:gnode', text: 'graph node content', metadata: { type: 'decision', label: 'L', tags: '', project: 'w', ecosystem: '*', updatedAt: new Date().toISOString(), security_scopes: [] } });
        // The non-node document — this has NO graph copy. store_verbatim
        // forbids `lore:`-prefixed ids by construction.
        await seedVerbatim.store({ id: 'gmail:msg-abc123', text: 'an email the user asked Lore to remember, unrelated to any graph node', metadata: { type: 'note', label: 'msg', tags: '', project: 'w', ecosystem: '*', updatedAt: new Date().toISOString(), security_scopes: [] } });
        await seedVerbatim.close?.();

        const targetProvider = stubProvider('new-model', 8, 2);
        const result = await migrateEmbeddingModel(base, graph as never, {
            targetModelId: 'new-model',
            targetDimension: 8,
            targetProvider: targetProvider as never,
        });

        assert.equal(result.skipped, false);
        assert.equal(result.tableDropped, true);
        assert.equal(result.nonNodeRowsPreserved, 1, 'the one non-node document must be counted as preserved');

        const afterVerbatim = new VerbatimStore(base, targetProvider as never);
        await afterVerbatim.initialize();
        try {
            const restored = await afterVerbatim.getById('gmail:msg-abc123');
            assert.ok(restored, 'the non-node document must survive the migration — it has no graph copy to rebuild from');
            assert.equal(restored?.text, 'an email the user asked Lore to remember, unrelated to any graph node');
            const nodeRow = await afterVerbatim.getById('lore:gnode');
            assert.ok(nodeRow, 'the graph node still gets re-embedded normally');
        } finally {
            await afterVerbatim.close?.();
        }
    } finally {
        await graph.close().catch(() => undefined);
        rmDir(base);
    }
});

/* ────────────────────────────────────────────────────────────────────────
 * Cluster 4 mediums — supersede cycle guard, unsupersede validUntil/edge.
 * ──────────────────────────────────────────────────────────────────────── */

test('cluster4 medium: supersedeNode refuses a supersession that would close a cycle', async () => {
    const sdir = tmpDir('lore-cycle-surreal-');
    const surreal = new SurrealGraph(sdir, { workspaceId: 'w' });
    try {
        await surreal.initialize();
        await surreal.upsertNode(node('A'));
        await surreal.upsertNode(node('B'));
        await surreal.upsertNode(node('C'));
        // A -> B -> C (A superseded by B, B superseded by C).
        assert.equal((await surreal.supersedeNode('A', 'B')).ok, true);
        assert.equal((await surreal.supersedeNode('B', 'C')).ok, true);
        // Closing the loop: C superseded by A would make A->B->C->A.
        const closed = await surreal.supersedeNode('C', 'A');
        assert.equal(closed.ok, false, 'must refuse a cycle-closing supersession');
        assert.equal(closed.reason, 'cycle');
    } finally {
        await surreal.close().catch(() => undefined);
        rmDir(sdir);
    }
});

test('cluster4 medium: unsupersedeNode preserves an app-set validUntil but clears an auto-stamped one (SurrealGraph)', async () => {
    const dir = tmpDir('lore-unsup-vu-');
    const g = new SurrealGraph(dir, { workspaceId: 'w' });
    try {
        await g.initialize();
        // Case A: app already set its own validUntil BEFORE supersession —
        // supersedeNode's own guard preserves it; unsupersede must too.
        await g.upsertNode(node('appset', { validUntil: '2030-06-01T00:00:00.000Z' }));
        await g.upsertNode(node('newer1'));
        await g.supersedeNode('appset', 'newer1', 'r');
        await g.unsupersedeNode('appset');
        const afterAppSet = await g.getNode('appset');
        assert.equal(afterAppSet?.validUntil, '2030-06-01T00:00:00.000Z', 'an app-set validUntil must survive unsupersede');

        // Case B: no prior validUntil — supersedeNode auto-stamps it;
        // unsupersede must clear the auto-stamp.
        await g.upsertNode(node('autostamp'));
        await g.upsertNode(node('newer2'));
        await g.supersedeNode('autostamp', 'newer2', 'r');
        const midway = await g.getNode('autostamp');
        assert.ok(midway?.validUntil, 'sanity: supersede auto-stamped validUntil');
        await g.unsupersedeNode('autostamp');
        const afterAutoStamp = await g.getNode('autostamp');
        assert.equal(afterAutoStamp?.validUntil, null, 'an auto-stamped validUntil must be cleared by unsupersede');
    } finally {
        await g.close().catch(() => undefined);
        rmDir(dir);
    }
});

test('cluster4 medium: POST /api/node/unsupersede removes the supersedes edge handleSupersede wrote', async () => {
    const dir = tmpDir('lore-unsup-edge-');
    const g = new SurrealGraph(dir, { workspaceId: 'w' });
    try {
        await g.initialize();
        await g.upsertNode(node('old'));
        await g.upsertNode(node('newv'));

        const auditLog: AuditLog = { log: () => undefined } as unknown as AuditLog;
        const deps: NodesDeps = {
            store: { loreGraph: g } as never,
            auditLog,
            deploymentMode: 'local',
            dataplane: null,
        };

        function fakeReq(bodyObj: unknown): IncomingMessage {
            const chunks = [Buffer.from(JSON.stringify(bodyObj))];
            let i = 0;
            return {
                method: 'POST',
                on(event: string, cb: (...args: unknown[]) => void) {
                    if (event === 'data') { for (const c of chunks) cb(c); }
                    if (event === 'end') cb();
                    return this;
                },
            } as unknown as IncomingMessage;
        }
        function fakeRes(): ServerResponse & { _status: number; _body: string } {
            const r = {
                _status: 0, _body: '',
                writeHead(status: number) { (this as { _status: number })._status = status; return this; },
                end(body?: string) { (this as { _body: string })._body = body ?? ''; },
            };
            return r as unknown as ServerResponse & { _status: number; _body: string };
        }

        const resSup = fakeRes();
        await handleSupersede(fakeReq({ oldId: 'old', newId: 'newv', workspace: 'w' }), resSup, '/api/node/supersede?workspace=w', deps);
        assert.equal(resSup._status, 200, resSup._body);
        const edgesAfterSupersede = await g.queryEdges({ relation: 'supersedes', limit: 100, offset: 0 });
        assert.equal(edgesAfterSupersede.length, 1, 'supersede must write the supersedes edge');

        const resUnsup = fakeRes();
        await handleUnsupersede(fakeReq({ id: 'old', workspace: 'w' }), resUnsup, '/api/node/unsupersede?workspace=w', deps);
        assert.equal(resUnsup._status, 200, resUnsup._body);
        const edgesAfterUnsupersede = await g.queryEdges({ relation: 'supersedes', limit: 100, offset: 0 });
        assert.equal(edgesAfterUnsupersede.length, 0, 'unsupersede must remove the supersedes edge, not just the denormalized field');
    } finally {
        await g.close().catch(() => undefined);
        rmDir(dir);
    }
});

(async () => {
    console.log('functional-correctness — cluster 4 (migration/maintenance invariants, SurrealGraph correctness)');
    await Promise.all(pending);
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})();
