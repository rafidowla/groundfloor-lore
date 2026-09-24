#!/usr/bin/env tsx
/**
 * test/rc321d-embed-failure-keeps-node-mcp-rest-unit.ts — Lore 3.21 step
 * 3(d), MCP + REST.
 *
 * Pins that `embedPending` (node kept, embed failure not rolled back)
 * surfaces through the two write surfaces on top of nodeService.nodeUpsert():
 * the MCP `store_node` tool and REST POST /api/node. Drives the REAL
 * handlers (registerStoreNodeTool / handlePostNode) against a real
 * `SurrealGraph` + a real `FileOutboxStore`, with a flaky `inlineVerbatim`
 * hook that fails on the write under test — same real-stack style as
 * rc321d-embed-failure-keeps-node-unit.ts, one layer up (through the tool/
 * route, not nodeService directly).
 *
 * Run: npx tsx test/rc321d-embed-failure-keeps-node-mcp-rest-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import { FileOutboxStore } from '../packages/lore/src/outbox/store.js';
import { registerStoreNodeTool } from '../packages/lore/src/mcp/tools/memory/storeNode.js';
import { handlePostNode } from '../packages/lore/src/mcp/http/routes/nodes/postNode.js';
import type { MemoryToolsDeps } from '../packages/lore/src/mcp/tools/memory/types.js';
import type { NodesDeps } from '../packages/lore/src/mcp/http/routes/nodes/types.js';

let passed = 0, failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void>): void {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? (err as Error).message}`); failed++; }
    })());
}

function mkTmp(prefix: string): { dir: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    return { dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } } };
}

/** A flaky verbatim writer: always throws (simulating a persistent-enough
 *  embed failure to exercise the branch, once is enough for this test). */
function makeFlakyInline(): { verbatimStore: () => Promise<never> } {
    return { verbatimStore: async () => { throw new Error('injected inline embed failure'); } };
}

console.log('\n3.21 step 3(d) — embedPending across MCP store_node + REST POST /api/node\n');

test('MCP store_node: inline embed failure with outbox wired → success:true, embedPending:true, node present', async () => {
    const g = mkTmp('lore-rc321d-mcp-g-');
    const o = mkTmp('lore-rc321d-mcp-o-');
    const graph = new SurrealGraph(g.dir);
    const outboxStore = new FileOutboxStore(o.dir);
    await graph.initialize();
    try {
        interface ToolBag { [name: string]: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>; }
        const tools: ToolBag = {};
        const server = { tool: (name: string, ..._rest: unknown[]) => { const h = _rest[_rest.length - 1]; if (typeof h === 'function') tools[name] = h as ToolBag[string]; } };

        const deps: MemoryToolsDeps = {
            store: {
                loreGraph: graph as never,
                loreVerbatim: {} as never,
                sessionCache: { pushNode: () => undefined } as never,
                storageClient: { async verbatimStore() { /* unused: outbox branch wins */ } } as never,
            } as never,
            configManager: { read: () => ({ pluginConfig: {} }) } as never,
            auditLog: { log: () => undefined } as never,
            detectedScope: { workspace: 'rc321d-mcp-ws', ecosystem: 'default' },
            getWal: () => ({ append: () => undefined }) as never,
            domain: 'lore',
            edgeRelations: ['related_to'],
            nodeTypesEnum: z.enum(['decision', 'note', 'convention', 'bug_pattern', 'architecture']) as never,
            nodeTypesDescription: 'decision|note|convention|bug_pattern|architecture',
            edgeRelationsEnum: z.enum(['related_to']) as never,
            coreNodeTypes: ['decision', 'note', 'convention', 'bug_pattern', 'architecture', 'troubleshooting'],
            outboxStore: outboxStore as never,
            inlineVerbatim: makeFlakyInline() as never,
        };
        registerStoreNodeTool(server as never, deps);

        const res = await tools['store_node']!({
            id: 'rc321d-mcp-node', type: 'decision', label: 'embed fail mcp test',
            content: 'zzyzxmcpd marker', workspace: 'rc321d-mcp-ws',
        });
        assert.ok(!res.isError, `expected success (node kept), got error: ${res.content[0]?.text}`);
        const body = JSON.parse(res.content[0]!.text) as { success: boolean; embedPending?: boolean };
        assert.equal(body.success, true);
        assert.equal(body.embedPending, true, `expected embedPending:true in the response, got: ${JSON.stringify(body)}`);

        const graphNode = await graph.getNode('rc321d-mcp-node');
        assert.ok(graphNode, 'graph node must be present — NOT rolled back');

        const rows = await outboxStore.listPendingForWorkspace('rc321d-mcp-ws', 1000);
        assert.ok(rows.some((r) => r.operationKind === 'verbatim.upsert'), 'the durable verbatim.upsert retry row must still be pending');
    } finally {
        await graph.close().catch(() => undefined);
        g.cleanup(); o.cleanup();
    }
});

function makeMockReq(rawBody: string): IncomingMessage {
    const emitter = new EventEmitter() as IncomingMessage;
    (emitter as unknown as Record<string, unknown>).method = 'POST';
    (emitter as unknown as Record<string, unknown>).headers = { 'content-type': 'application/json' };
    setImmediate(() => { emitter.emit('data', Buffer.from(rawBody)); emitter.emit('end'); });
    return emitter;
}
function makeMockRes(): { res: ServerResponse; statusCode: () => number | null; body: () => string } {
    let statusCode: number | null = null;
    let body = '';
    const res: { headersSent: boolean; writeHead: (code: number) => void; end: (chunk?: string) => void } = {
        headersSent: false,
        writeHead(code: number) { statusCode = code; res.headersSent = true; },
        end(chunk?: string) { if (chunk) body += chunk; },
    };
    return { res: res as unknown as ServerResponse, statusCode: () => statusCode, body: () => body };
}

test('REST POST /api/node: inline embed failure with outbox wired → 201, ok:true, embedPending:true, node present', async () => {
    const g = mkTmp('lore-rc321d-rest-g-');
    const o = mkTmp('lore-rc321d-rest-o-');
    const graph = new SurrealGraph(g.dir);
    const outboxStore = new FileOutboxStore(o.dir);
    await graph.initialize();
    try {
        const deps: Partial<NodesDeps> = {
            store: { loreGraph: graph as never } as never,
            auditLog: { log: () => undefined } as never,
            deploymentMode: 'local',
            dataplane: null,
            outboxStore: outboxStore as never,
            inlineVerbatim: makeFlakyInline() as never,
        };
        const mock = makeMockRes();
        await handlePostNode(
            makeMockReq(JSON.stringify({ id: 'rc321d-rest-node', type: 'decision', label: 'embed fail rest test', content: 'zzyzxrestd marker', workspace: 'rc321d-rest-ws' })),
            mock.res, '/api/node', deps as NodesDeps,
        );
        assert.equal(mock.statusCode(), 201, `expected 201 (created, node kept), got ${mock.statusCode()}: ${mock.body()}`);
        const body = JSON.parse(mock.body()) as { ok: boolean; embedPending?: boolean };
        assert.equal(body.ok, true);
        assert.equal(body.embedPending, true, `expected embedPending:true, got: ${JSON.stringify(body)}`);

        const graphNode = await graph.getNode('rc321d-rest-node');
        assert.ok(graphNode, 'graph node must be present — NOT rolled back');

        const rows = await outboxStore.listPendingForWorkspace('rc321d-rest-ws', 1000);
        assert.ok(rows.some((r) => r.operationKind === 'verbatim.upsert'), 'the durable verbatim.upsert retry row must still be pending');
    } finally {
        await graph.close().catch(() => undefined);
        g.cleanup(); o.cleanup();
    }
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
