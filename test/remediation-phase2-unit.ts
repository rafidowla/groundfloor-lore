#!/usr/bin/env tsx
/**
 * test/remediation-phase2-unit.ts — 2026-08-17 launch-blocker remediation,
 * Phase 2 (write-path integrity & security) regression tests.
 *
 * Each test exercises the production entry point named in the finding (or the
 * shared chokepoint that entry point routes through), not an internal helper:
 *   2.1  nodeUpsert mirrors security_scopes onto the verbatim row
 *   2.2  wireEmbedQueue executor mirrors security_scopes
 *   2.5  assertSafeVerbatimId rejects 'lore:' + '#rev'
 *   2.6  redactSecrets screens secrets before the embed layer
 *   2.7  normaliseEvent rejects non-marker operationKinds on the stream route
 */

import assert from 'node:assert/strict';

import { nodeUpsert, type NodeWriteGraph } from '../packages/lore/src/core/nodeService.js';
import { wireEmbedQueue } from '../packages/lore/src/embed/wiring.js';
import { assertSafeVerbatimId } from '../packages/lore/src/engines/verbatimHistory.js';
import { redactSecrets } from '../packages/lore/src/security/secretScan.js';
import { normaliseEvent } from '../packages/lore/src/mcp/http/routes/stream.js';
import type { LoreNode } from '../packages/lore/src/providers/types.js';

let passed = 0;
let failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => void | Promise<void>): void {
    pending.push((async () => {
        try { await fn(); passed++; console.log(`  ✓ ${name}`); }
        catch (err) { failed++; console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? (err as Error).message}`); }
    })());
}

console.log('Remediation Phase 2 (write-path integrity & security)');

/* ─── 2.1: nodeUpsert mirrors security_scopes onto the verbatim row ─── */

test('2.1 nodeUpsert mirrors the existing node security_scopes onto the inline verbatim row', async () => {
    let captured: Record<string, unknown> | undefined;
    const graph: NodeWriteGraph = {
        async upsertNode(node) {
            return { ...node, tags: [], type: 'note', label: '', project: 'ws', ecosystem: '*', updatedAt: new Date().toISOString() } as unknown as LoreNode;
        },
        async deleteNode() { return undefined; },
        async getNode() {
            return { id: 'n1', security_scopes: ['finance'] } as unknown as LoreNode;
        },
    };
    const res = await nodeUpsert(
        {
            id: 'n1', workspace: 'ws', ecosystem: '*',
            nodeData: { id: 'n1', type: 'note', label: 'L', content: 'c', tags: '', project: 'ws', ecosystem: '*' },
            targetGraph: graph, initiator: 'test:2.1',
        },
        {
            verbatim: {
                async verbatimStore(write) { captured = write.metadata; },
            },
        },
    );
    assert.equal(res.ok, true);
    assert.deepEqual(captured?.security_scopes, ['finance'], 'verbatim metadata must carry the graph row scopes');
});

/* ─── 2.2: wireEmbedQueue executor mirrors security_scopes ─── */

test('2.2 wireEmbedQueue executor mirrors the node security_scopes into the vector row', async () => {
    let captured: Record<string, unknown> | undefined;
    const graph = {
        async getNode(id: string) {
            return { id, type: 'note', label: 'L', tags: [], project: 'ws', ecosystem: '*', updatedAt: 't', security_scopes: ['finance'] } as unknown as LoreNode;
        },
    };
    const vectorStore = {
        async store(doc: { id: string; text: string; metadata: Record<string, unknown> }) {
            captured = doc.metadata;
        },
    };
    const q = wireEmbedQueue({ graph: graph as never, vectorStore: vectorStore as never });
    q.enqueue('n1', 'text', 'ws');
    await q.drained();
    assert.deepEqual(captured?.security_scopes, ['finance'], 'embed-queue vector row must carry scopes');
});

/* ─── 2.5: assertSafeVerbatimId rejects lore: + #rev ─── */

test('2.5 assertSafeVerbatimId rejects the lore: namespace', () => {
    assert.throws(() => assertSafeVerbatimId('lore:node-123', 'test'), /lore:' prefix is reserved/);
});

test('2.5 assertSafeVerbatimId rejects a caller-supplied #rev suffix', () => {
    assert.throws(() => assertSafeVerbatimId('doc-123#rev2020-01-01T00:00:00.000Z', 'test'), /#rev.*reserved/);
});

test('2.5 assertSafeVerbatimId accepts a plain caller id', () => {
    assert.doesNotThrow(() => assertSafeVerbatimId('sha256-abc123', 'test'));
});

/* ─── 2.6: redactSecrets screens secrets before the embed layer ─── */

test('2.6 redactSecrets redacts common secret shapes', () => {
    const input = 'key=sk-abcdefghijklmnopqrstuvwxyz123456 and AKIAABCDEFGHIJKLMNOP token ghp_abcdefghijklmnopqrstuvwxyz123456789012';
    const out = redactSecrets(input);
    assert.ok(!out.includes('sk-abcdefghijklmnopqrstuvwxyz123456'), 'OpenAI key redacted');
    assert.ok(!out.includes('AKIAABCDEFGHIJKLMNOP'), 'AWS key id redacted');
    assert.ok(!out.includes('ghp_abcdefghijklmnopqrstuvwxyz123456789012'), 'GitHub token redacted');
});

test('2.6 redactSecrets leaves ordinary prose untouched', () => {
    const prose = 'The meeting covered quarterly finance planning and roadmap updates.';
    assert.equal(redactSecrets(prose), prose);
});

/* ─── 2.7: normaliseEvent rejects non-marker operationKinds ─── */

test('2.7 normaliseEvent accepts the stream.event marker kind', () => {
    const e = normaliseEvent({ operationKind: 'stream.event', payload: { a: 1 } }, 'ws');
    assert.ok(e);
    assert.equal(e.operationKind, 'stream.event');
});

test('2.7 normaliseEvent rejects a caller-chosen node.delete kind', () => {
    const e = normaliseEvent({ operationKind: 'node.delete', payload: { id: 'lore:x' } }, 'ws');
    assert.equal(e, null, 'node.delete must not reach the replicator via the stream route');
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
