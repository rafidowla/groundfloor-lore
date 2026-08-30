#!/usr/bin/env tsx
/**
 * test/store-node-mcp-tool-content-hash-unit.ts — PR #69 P2 contract test
 * at the MCP tool surface (store_node → storageClient.verbatimStore).
 *
 * Why this test exists:
 *   PR #70 (PR #69's implementation) ships a contentHash population at
 *   three callsites. The engine-level safety net (verbatimStore.store
 *   auto-computes when caller omits the hash) means a regression that
 *   drops the contentHash population from a callsite would still work,
 *   silently, at the cost of recomputing on every write — which is
 *   exactly the failure mode that produced the 8.5 GB lance bloat in
 *   the original PR #69 report. This test asserts the CONTRACT at the
 *   callsite where it must be honored.
 *
 *   Per the PR #70 workflow critique: all 45 prior PR-70 tests bypass
 *   the MCP tool surface. The contentHash flow on storeNode.ts:298-311
 *   has ZERO direct coverage without this test. A refactor that drops
 *   `contentHash: computeContentHash(verbatimText)` from the
 *   storageClient.verbatimStore call would still pass every other PR
 *   #70 test — only this test would catch it.
 *
 * What this test pins (MCP-tool-surface layer):
 *   M1. store_node default (inline-verbatim path) → storageClient.
 *       verbatimStore receives metadata.contentHash =
 *       computeContentHash(buildVerbatimText(label, content, tags)).
 *   M2. store_node with embed:false → storageClient.verbatimStore is
 *       NOT called (contentHash is irrelevant on this path).
 *   M3. The hash matches the bytes the route also writes to `text` —
 *       a refactor that hashes one buffer and writes another fails.
 *   M4. async_embed path routes through embedQueue.enqueue (the
 *       executor in wiring.ts is what populates contentHash on that
 *       path; the MCP tool intentionally does not pre-compute).
 *
 * Setup approach:
 *   We drive registerStoreNodeTool() with a minimal StorageBundle and
 *   MemoryToolsDeps — no LORE_HOME, no graph registry, no real graph
 *   engine. resolveTargetGraph falls back to store.loreGraph when no
 *   registry is supplied (workspaceResolve.ts:34-36). Vocab policy
 *   for an unknown workspace returns 'open' default → no rejection.
 *   This keeps the test focused on the contentHash population
 *   contract, not on workspace machinery.
 */

import assert from 'node:assert/strict';
import { z } from 'zod';
import { registerStoreNodeTool } from '../packages/lore/src/mcp/tools/memory/storeNode.js';
import { computeContentHash } from '../packages/lore/src/engines/contentHash.js';
import { buildVerbatimText } from '../packages/lore/src/engines/verbatimSchema.js';

let passed = 0;
let failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void>) {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}\n    ${(err as Error).stack?.split('\n').slice(1, 4).join('\n    ')}`); failed++; }
    })());
}

console.log('PR #69 P2 — MCP tool contentHash population (store_node)');

/* ---------- recording fakes ---------- */

type RecordedVerbatim = { id: string; text: string; metadata: Record<string, unknown> };

interface ToolBag {
    [name: string]: (args: Record<string, unknown>) => Promise<{
        content: Array<{ type: 'text'; text: string }>;
        isError?: boolean;
    }>;
}

function makeMcpServerStub(): { server: object; tools: ToolBag } {
    const tools: ToolBag = {};
    const server = {
        tool: (name: string, ..._rest: unknown[]) => {
            const handler = _rest[_rest.length - 1];
            if (typeof handler === 'function') {
                tools[name] = handler as ToolBag[string];
            }
        },
    };
    return { server, tools };
}

function makeDeps(): {
    deps: Parameters<typeof registerStoreNodeTool>[1];
    verbatimWrites: RecordedVerbatim[];
    embedQueueCalls: Array<{ id: string; text: string }>;
} {
    const verbatimWrites: RecordedVerbatim[] = [];
    const embedQueueCalls: Array<{ id: string; text: string }> = [];

    const fakeGraph = {
        async upsertNode(node: Record<string, unknown>) {
            return {
                ...node,
                project: node.project ?? 'default',
                ecosystem: node.ecosystem ?? '*',
                updatedAt: '2026-06-09T00:00:00.000Z',
            };
        },
        async deleteNode(_id: string) { /* no-op */ },
        async getNode(_id: string) { return null; },
    };

    const fakeVerbatim = {
        async store(_w: RecordedVerbatim) { /* unused; reconnect path */ },
        async getById() { return null; },
        async search() { return []; },
    };

    const fakeStorageClient = {
        async verbatimStore(doc: RecordedVerbatim) {
            verbatimWrites.push(doc);
        },
        // Unused but typed presence required by some helpers:
        async upsertNode(_n: unknown) { return _n as never; },
    };

    const store = {
        loreGraph: fakeGraph as never,
        loreVerbatim: fakeVerbatim as never,
        sessionCache: { pushNode: () => undefined } as never,
        storageClient: fakeStorageClient as never,
        deploymentMode: 'local' as const,
        sdk: {} as never,
        tableStorage: {} as never,
    };

    const embedQueue = {
        enqueue(id: string, text: string) { embedQueueCalls.push({ id, text }); },
    };

    const deps = {
        store,
        configManager: { read: () => ({ pluginConfig: {} }) } as never,
        auditLog: { log: () => undefined } as never,
        detectedScope: { workspace: 'pr69-mcp', ecosystem: 'default' },
        getWal: () => ({ append: () => undefined }) as never,
        domain: 'lore',
        edgeRelations: ['related_to', 'depends_on'],
        nodeTypesEnum: z.enum(['decision', 'note', 'convention', 'bug_pattern', 'architecture']) as never,
        nodeTypesDescription: 'decision|note|convention|bug_pattern|architecture',
        edgeRelationsEnum: z.enum(['related_to', 'depends_on']) as never,
        embedQueue,
        coreNodeTypes: ['decision', 'note', 'convention', 'bug_pattern', 'architecture', 'troubleshooting'],
        // graphRegistry omitted → resolveTargetGraph falls back to store.loreGraph
    };
    return { deps, verbatimWrites, embedQueueCalls };
}

async function invokeStoreNode(args: Record<string, unknown>) {
    const { server, tools } = makeMcpServerStub();
    const { deps, verbatimWrites, embedQueueCalls } = makeDeps();
    registerStoreNodeTool(server as never, deps);
    const res = await tools['store_node']!(args);
    return { res, verbatimWrites, embedQueueCalls };
}

/* ---------- M1: default path populates contentHash ---------- */

test('M1 default — storageClient.verbatimStore receives metadata.contentHash matching the verbatim text', async () => {
    const label = 'PR #69 MCP contract';
    const content = 'this is the body that gets embedded';
    const tags = 'pr69,p2,mcp';
    const { res, verbatimWrites } = await invokeStoreNode({
        id: 'mcp-m1', type: 'decision', label, content, tags,
        workspace: 'pr69-mcp',
    });

    assert.equal(res.isError, undefined, `unexpected error envelope: ${JSON.stringify(res.content[0])}`);
    assert.equal(verbatimWrites.length, 1, `expected exactly one verbatim write; got ${verbatimWrites.length}`);

    const write = verbatimWrites[0]!;
    assert.equal(write.id, 'lore:mcp-m1', 'verbatim id uses canonical `lore:` prefix');

    const md = write.metadata as { contentHash?: string };
    assert.ok(
        md.contentHash,
        `MCP store_node MUST populate metadata.contentHash (PR #69 P2). Got: ${JSON.stringify(md)}`,
    );

    const expectedText = buildVerbatimText(label, content, tags);
    const expectedHash = computeContentHash(expectedText);
    assert.equal(
        md.contentHash,
        expectedHash,
        `contentHash mismatch — MCP callsite computed ${md.contentHash}, expected ${expectedHash}. ` +
        `A refactor likely changed buildVerbatimText input or hashed the wrong buffer.`,
    );
});

/* ---------- M2: embed:false skips storageClient.verbatimStore entirely ---------- */

test('M2 embed:false — storageClient.verbatimStore NOT called (no contentHash payload to leak)', async () => {
    const { res, verbatimWrites, embedQueueCalls } = await invokeStoreNode({
        id: 'mcp-m2-noembed',
        type: 'decision',
        label: 'graph only',
        content: 'no embedding',
        embed: false,
        workspace: 'pr69-mcp',
    });
    assert.equal(res.isError, undefined);
    assert.equal(verbatimWrites.length, 0, 'embed:false MUST skip the inline verbatim write');
    assert.equal(embedQueueCalls.length, 0, 'embed:false MUST also skip the queue (graph-only)');
});

/* ---------- M3: text bytes match hash input ---------- */

test('M3 — verbatim text the route writes equals the bytes the hash was computed over', async () => {
    const label = 'unicode 日本語';
    const content = 'multi\nline\nwith\ttabs and special chars: <>&"';
    const tags = 'edge-cases';
    const { verbatimWrites } = await invokeStoreNode({
        id: 'mcp-m3', type: 'decision', label, content, tags,
        workspace: 'pr69-mcp',
    });
    assert.equal(verbatimWrites.length, 1);
    const write = verbatimWrites[0]!;
    const expectedText = buildVerbatimText(label, content, tags);
    assert.equal(write.text, expectedText, 'metadata.contentHash and write.text must agree on byte content');
    assert.equal(
        (write.metadata as { contentHash: string }).contentHash,
        computeContentHash(write.text),
    );
});

/* ---------- M4: async_embed routes through embedQueue, not inline verbatim ---------- */

test('M4 async_embed:true — embedQueue.enqueue called, storageClient.verbatimStore is NOT called inline', async () => {
    const { res, verbatimWrites, embedQueueCalls } = await invokeStoreNode({
        id: 'mcp-m4-async',
        type: 'decision',
        label: 'async embed path',
        content: 'queue handles this',
        tags: '',
        async_embed: true,
        workspace: 'pr69-mcp',
    });
    assert.equal(res.isError, undefined);
    assert.equal(verbatimWrites.length, 0, 'async_embed bypasses the inline verbatim write');
    assert.equal(embedQueueCalls.length, 1, 'embedQueue.enqueue MUST be called on the async path');
    assert.equal(embedQueueCalls[0]!.id, 'mcp-m4-async');
    // The embedQueue executor (wiring.ts) is responsible for the
    // contentHash on this path — see test/embed-queue-wiring-content-hash-unit.ts
    // (follow-up). The MCP tool intentionally only enqueues (id, text).
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
