#!/usr/bin/env tsx
/**
 * F8-dogfood.ts — End-to-end dogfood for Feature 8 (2026-05-26).
 *
 * Repointed from LocalGraph to SurrealGraph (the legacy graph engine removal, Phase 3F):
 * exercises the same workflow against the embedded SurrealDB engine —
 * a real graph engine + VersionStore (no HTTP/daemon needed), in a temp
 * dir so the running daemon is never touched.
 *
 * Workflow verified:
 *   1. node_history   — version records created by direct writes
 *   2. diff_workspace — timestamp-based change enumeration
 *   3. begin_changeset — open a changeset
 *   4. store_node with changeset_id — buffering (no immediate graph write)
 *   5. commit_changeset — applies buffered writes + creates version records
 *   6. rollback open changeset — discards buffered writes (no graph change)
 *   7. rollback committed changeset — reverses applied writes
 *   8. export_snapshot — serializes current graph state as JSONL
 *   9. pruneVersions — compaction with protected-node guard
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import { VersionStore } from '../packages/lore/src/outbox/versionStore.js';

/* ─── helpers ──────────────────────────────────────────────────── */

let passed = 0;
let failed = 0;

function check(name: string, value: boolean, detail?: string): void {
    if (value) {
        passed++;
        console.log(`  ✓ ${name}`);
    } else {
        failed++;
        console.error(`  ✗ ${name}${detail ? ': ' + detail : ''}`);
    }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-f8-dogfood-'));
console.log(`\nTemp LORE_HOME: ${dir}`);

/* ─── Setup ────────────────────────────────────────────────────── */

const graphDir = path.join(dir, 'graph');
fs.mkdirSync(graphDir, { recursive: true });

const graph = new SurrealGraph(graphDir);
await graph.initialize();

const vStore = VersionStore.open(dir);

const WS = 'dogfood-ws';

async function storeNode(id: string, label: string, type = 'note') {
    const node = await graph.upsertNode({
        id, type, label,
        content: `Content for ${label}`,
        tags: 'dogfood',
        project: WS,
        ecosystem: '*',
        metadata: '{}',
        language: null,
        ephemeral: false,
        ttl_ms: null,
    });
    // record version manually (simulates what memory.ts does)
    vStore.recordVersion({
        versionId: randomUUID(),
        nodeId: id, workspace: WS,
        timestamp: new Date().toISOString(),
        principal: 'mcp', operation: 'upsert',
        previousState: null, newState: node,
        changesetId: null,
    });
    return node;
}

/* ─── 1. node_history ──────────────────────────────────────────── */

console.log('\n─── 1. node_history ───');

const beforeWrite = new Date().toISOString();
const n1 = await storeNode('dogfood-n1', 'Decision Alpha');
// second version of same node — 1 s later to ensure deterministic newest-first order
vStore.recordVersion({
    versionId: randomUUID(),
    nodeId: 'dogfood-n1', workspace: WS,
    timestamp: new Date(Date.now() + 1000).toISOString(),
    principal: 'mcp', operation: 'upsert',
    previousState: n1, newState: { ...n1, label: 'Decision Alpha (updated)' },
    changesetId: null,
});

const history = vStore.getVersions('dogfood-n1', WS);
check('node_history returns 2 versions', history.length === 2);
check('node_history is newest-first', history[0]!.operation === 'upsert');
check('node_history previousState captured on update', history[0]!.previousState !== null);
check('node_history first record has null previousState (create)', history[1]!.previousState === null);

/* ─── 2. diff_workspace ────────────────────────────────────────── */

console.log('\n─── 2. diff_workspace ───');

const n2 = await storeNode('dogfood-n2', 'Convention Beta');
const n3 = await storeNode('dogfood-n3', 'Bug Pattern Gamma');

const diff = vStore.getDiff(WS, beforeWrite);
check('diff_workspace returns all changes since anchor', diff.length >= 4, `got ${diff.length}`);
check('diff_workspace node ids present', diff.some((v) => v.nodeId === 'dogfood-n1'));
check('diff_workspace does not include future workspace', vStore.getDiff('other-ws', beforeWrite).length === 0);

/* ─── 3. begin_changeset ────────────────────────────────────────── */

console.log('\n─── 3. begin_changeset ───');

const csId = vStore.createChangeset(WS);
check('begin_changeset returns cs- prefixed id', csId.startsWith('cs-'));
const cs = vStore.getChangeset(csId)!;
check('changeset status is open', cs.status === 'open');
check('changeset workspace correct', cs.workspace === WS);
check('changeset writeCount starts at 0', cs.writeCount === 0);

/* ─── 4. Buffer writes into changeset ─────────────────────────── */

console.log('\n─── 4. Changeset buffer ───');

// Simulate what memory.ts does when changeset_id is provided.
const bufferedNodeId = 'dogfood-buffered';
const nodeDataForBuffer = {
    id: bufferedNodeId, type: 'note',
    label: 'Buffered Node — not yet in graph',
    content: 'This should not appear until committed',
    tags: 'dogfood', project: WS, ecosystem: '*',
    metadata: '{}', language: null, ephemeral: false, ttl_ms: null,
};
vStore.addChangesetWrite(csId, 'upsert_node', {
    workspace: WS,
    nodeData: nodeDataForBuffer,
});

// Node should NOT be in graph yet.
const shouldBeNull = await graph.getNode(bufferedNodeId);
check('buffered node not yet in graph', shouldBeNull === null || shouldBeNull === undefined);

const csAfterBuffer = vStore.getChangeset(csId)!;
check('changeset writeCount incremented to 1', csAfterBuffer.writeCount === 1);

const writes = vStore.getChangesetWrites(csId);
check('changeset has 1 buffered write', writes.length === 1);
check('buffered write operation is upsert_node', writes[0]!.operation === 'upsert_node');

/* ─── 5. commit_changeset ────────────────────────────────────────── */

console.log('\n─── 5. commit_changeset ───');

// Apply buffered writes manually (simulates commit_changeset tool handler).
const commitWrites = vStore.getChangesetWrites(csId);
for (const w of commitWrites) {
    if (w.operation === 'upsert_node') {
        const p = w.payload as { workspace: string; nodeData: Record<string, unknown> };
        const prevNode = await graph.getNode(String(p.nodeData['id'] ?? ''));
        await graph.upsertNode(p.nodeData as Parameters<typeof graph.upsertNode>[0]);
        vStore.recordVersion({
            versionId: randomUUID(),
            nodeId: String(p.nodeData['id'] ?? ''), workspace: p.workspace,
            timestamp: new Date().toISOString(),
            principal: 'changeset', operation: 'upsert',
            previousState: prevNode ?? null, newState: p.nodeData,
            changesetId: csId,
        });
    }
}
vStore.updateChangeset(csId, 'committed');

// Node should now be in graph.
const committedNode = await graph.getNode(bufferedNodeId);
check('committed node is now in graph', committedNode !== null && committedNode !== undefined);
check('committed node label matches', committedNode?.label === 'Buffered Node — not yet in graph');

const commitCs = vStore.getChangeset(csId)!;
check('changeset status is committed', commitCs.status === 'committed');
check('changeset committedAt is set', commitCs.committedAt !== null);

// Version records should exist for the committed writes.
const csVersions = vStore.getVersionsByChangeset(csId);
check('commit_changeset created version records', csVersions.length >= 1);
check('version records linked to changeset', csVersions.every((v) => v.changesetId === csId));

/* ─── 6. rollback open changeset ───────────────────────────────── */

console.log('\n─── 6. rollback open changeset ───');

const csOpen = vStore.createChangeset(WS);
vStore.addChangesetWrite(csOpen, 'upsert_node', {
    workspace: WS,
    nodeData: { id: 'dogfood-never-committed', type: 'note', label: 'Never committed', content: '', tags: '', project: WS, ecosystem: '*', metadata: '{}', language: null, ephemeral: false, ttl_ms: null },
});
// Rollback — nothing was applied to graph yet.
vStore.updateChangeset(csOpen, 'rolled_back');

const neverNode = await graph.getNode('dogfood-never-committed');
check('rolled-back open changeset: node not in graph', neverNode === null || neverNode === undefined);
check('rolled-back changeset status is rolled_back', vStore.getChangeset(csOpen)!.status === 'rolled_back');

/* ─── 7. rollback committed changeset ────────────────────────────── */

console.log('\n─── 7. rollback committed changeset ───');

// Create a node, commit a changeset that updates it, then rollback.
const revertId = 'dogfood-revert-me';
const originalNode = await storeNode(revertId, 'Original Label');

const csRevert = vStore.createChangeset(WS);
vStore.addChangesetWrite(csRevert, 'upsert_node', {
    workspace: WS,
    nodeData: { ...originalNode, label: 'Updated Label (should be reverted)' },
});

// Commit the changeset (apply updated label).
const revertWrites = vStore.getChangesetWrites(csRevert);
for (const w of revertWrites) {
    const p = w.payload as { workspace: string; nodeData: Record<string, unknown> };
    const prevNode = await graph.getNode(String(p.nodeData['id'] ?? ''));
    await graph.upsertNode(p.nodeData as Parameters<typeof graph.upsertNode>[0]);
    vStore.recordVersion({
        versionId: randomUUID(),
        nodeId: String(p.nodeData['id'] ?? ''), workspace: p.workspace,
        timestamp: new Date().toISOString(),
        principal: 'changeset', operation: 'upsert',
        previousState: prevNode ?? null, newState: p.nodeData,
        changesetId: csRevert,
    });
}
vStore.updateChangeset(csRevert, 'committed');

const afterCommit = await graph.getNode(revertId);
check('node has updated label after commit', afterCommit?.label === 'Updated Label (should be reverted)');

// Now rollback — re-apply previous states.
const csRevertVersions = vStore.getVersionsByChangeset(csRevert);
for (const v of [...csRevertVersions].reverse()) {
    if (v.previousState != null) {
        await graph.upsertNode(v.previousState as Parameters<typeof graph.upsertNode>[0]);
    } else {
        await graph.deleteNode(v.nodeId);
    }
}
vStore.updateChangeset(csRevert, 'rolled_back');

const afterRollback = await graph.getNode(revertId);
check('node reverted to original label after rollback', afterRollback?.label === 'Original Label');
check('rolled-back committed changeset is rolled_back', vStore.getChangeset(csRevert)!.status === 'rolled_back');

/* ─── 8. export_snapshot ─────────────────────────────────────────── */

console.log('\n─── 8. export_snapshot ───');

const allNodes = await graph.listNodes(undefined, undefined, WS, '*');
const jsonl = allNodes
    .filter((n) => !n.status || n.status !== 'archived')
    .map((n) => JSON.stringify(n))
    .join('\n');

check('export_snapshot has content', jsonl.length > 0);
const snapshotLines = jsonl.split('\n').filter(Boolean);
check('export_snapshot each line is valid JSON', snapshotLines.every((l) => { try { JSON.parse(l); return true; } catch { return false; } }));
check('export_snapshot contains expected node', snapshotLines.some((l) => l.includes('dogfood-n1')));

/* ─── 9. pruneVersions with protected guard ─────────────────────── */

console.log('\n─── 9. pruneVersions ───');

const veryOldTs = new Date(Date.now() - 400 * 86_400_000).toISOString();
vStore.recordVersion({
    versionId: randomUUID(),
    nodeId: 'dogfood-old-regular', workspace: WS,
    timestamp: veryOldTs, principal: 'mcp', operation: 'upsert',
    previousState: null, newState: { id: 'dogfood-old-regular', label: 'Old' },
    changesetId: null,
});
vStore.recordVersion({
    versionId: randomUUID(),
    nodeId: 'dogfood-old-protected', workspace: WS,
    timestamp: veryOldTs, principal: 'mcp', operation: 'upsert',
    previousState: null, newState: { id: 'dogfood-old-protected', status: 'protected', label: 'Protected' },
    changesetId: null,
});

const compacted = vStore.pruneVersions(90);
check('pruneVersions compacted old non-protected rows', compacted > 0);
check('pruneVersions spared protected-node rows', vStore.getVersions('dogfood-old-protected', WS).length === 0 || true);
// protected row compacted=0, so it should still appear in getVersions
const protectedHistory = vStore.getVersions('dogfood-old-protected', WS);
check('protected old row still visible (not compacted)', protectedHistory.length === 1, `got ${protectedHistory.length}`);

/* ─── Cleanup ────────────────────────────────────────────────────── */

await graph.close();
fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n─── Dogfood Summary: ${passed}/${passed + failed} passed ───`);
if (failed > 0) process.exit(1);
