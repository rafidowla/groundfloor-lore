#!/usr/bin/env tsx
/**
 * test/rc321e-question-aliases-mcp-rest-unit.ts — Lore 3.21 step 3(e), MCP + REST.
 *
 * Pins that summary/entities/topics merge into the node's metadata through
 * the real `store_node` MCP tool handler and the real `POST /api/node` REST
 * handler, and that an over-cap `questions[]` is rejected with a clear
 * validation error (Zod on the MCP side; invalid_questions_meta/400 on
 * REST) — never partially written.
 *
 * Run: npx tsx test/rc321e-question-aliases-mcp-rest-unit.ts
 */

import assert from 'node:assert/strict';
import { z } from 'zod';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { registerStoreNodeTool } from '../packages/lore/src/mcp/tools/memory/storeNode.js';
import { handlePostNode } from '../packages/lore/src/mcp/http/routes/nodes/postNode.js';
import type { NodesDeps } from '../packages/lore/src/mcp/http/routes/nodes/types.js';
import { MAX_QUESTIONS } from '../packages/lore/src/core/questionAliases.js';

let passed = 0, failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void>): void {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? (err as Error).message}`); failed++; }
    })());
}

console.log('\n3.21 step 3(e) — MCP store_node + REST POST /api/node\n');

/* ─── MCP store_node ──────────────────────────────────────────────────── */

function makeMcpDeps(): { deps: Parameters<typeof registerStoreNodeTool>[1]; graphWrites: Array<Record<string, unknown>> } {
    const graphWrites: Array<Record<string, unknown>> = [];
    const fakeGraph = {
        async upsertNode(n: Record<string, unknown>) { graphWrites.push(n); return { ...n, project: n.project ?? 'default', ecosystem: n.ecosystem ?? '*', updatedAt: '2026-06-09T00:00:00.000Z' }; },
        async deleteNode() { /* no-op */ },
        async getNode() { return null; },
    };
    const deps = {
        store: {
            loreGraph: fakeGraph, loreVerbatim: { async store() {}, async getById() { return null; }, async search() { return []; } },
            sessionCache: { pushNode: () => undefined }, storageClient: { async verbatimStore() {}, async upsertNode(n: unknown) { return n; } },
            deploymentMode: 'local' as const, sdk: {}, tableStorage: {},
        },
        configManager: { read: () => ({ pluginConfig: {} }) },
        auditLog: { log: () => undefined },
        detectedScope: { workspace: 'rc321e-mcp', ecosystem: 'default' },
        getWal: () => ({ append: () => undefined }),
        domain: 'lore',
        edgeRelations: ['related_to'],
        nodeTypesEnum: z.enum(['decision', 'note']),
        nodeTypesDescription: 'decision|note',
        edgeRelationsEnum: z.enum(['related_to']),
        coreNodeTypes: ['decision', 'note'],
    } as unknown as Parameters<typeof registerStoreNodeTool>[1];
    return { deps, graphWrites };
}

test('MCP store_node: summary/entities/topics merge verbatim into metadata', async () => {
    interface ToolBag { [k: string]: (a: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>; }
    const tools: ToolBag = {};
    const server = { tool: (name: string, ..._r: unknown[]) => { const h = _r[_r.length - 1]; if (typeof h === 'function') tools[name] = h as ToolBag[string]; } };
    const { deps, graphWrites } = makeMcpDeps();
    registerStoreNodeTool(server as never, deps);
    const res = await tools['store_node']!({
        id: 'mcp-meta-1', type: 'decision', label: 'l', content: 'c', workspace: 'rc321e-mcp',
        summary: 'a short summary', entities: ['Acme Corp'], topics: ['billing', 'refunds'],
    });
    assert.ok(!res.isError, `unexpected error: ${res.content[0]?.text}`);
    assert.equal(graphWrites.length, 1);
    const meta = JSON.parse(String(graphWrites[0]!.metadata));
    assert.equal(meta.summary, 'a short summary');
    assert.deepEqual(meta.entities, ['Acme Corp']);
    assert.deepEqual(meta.topics, ['billing', 'refunds']);
});

test('MCP store_node: over-cap questions[] is rejected by the Zod tool schema itself (before the handler runs)', async () => {
    interface ToolBag { [k: string]: (a: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>; }
    const tools: ToolBag = {};
    const rawSchemas: Record<string, z.ZodRawShape> = {};
    const server = {
        tool: (name: string, _d: string, schema: z.ZodRawShape, h: (a: Record<string, unknown>) => Promise<unknown>) => {
            rawSchemas[name] = schema;
            tools[name] = h as ToolBag[string];
        },
    };
    const { deps, graphWrites } = makeMcpDeps();
    registerStoreNodeTool(server as never, deps);
    const parsed = z.object(rawSchemas['store_node']!).safeParse({
        id: 'mcp-over-cap', type: 'decision', label: 'l', content: 'c', workspace: 'rc321e-mcp',
        questions: Array(MAX_QUESTIONS + 1).fill('too many'),
    });
    assert.equal(parsed.success, false, 'the Zod schema itself must reject an over-cap questions[] array');
    assert.equal(graphWrites.length, 0, 'no node write happened for the rejected input');
});

/* ─── REST POST /api/node ─────────────────────────────────────────────── */

function makeMockReq(rawBody: string): IncomingMessage {
    const emitter = new EventEmitter() as IncomingMessage;
    (emitter as unknown as Record<string, unknown>).method = 'POST';
    (emitter as unknown as Record<string, unknown>).headers = { 'content-type': 'application/json' };
    setImmediate(() => { emitter.emit('data', Buffer.from(rawBody)); emitter.emit('end'); });
    return emitter;
}
function makeMockRes(): { res: ServerResponse; statusCode: () => number | null; body: () => string } {
    let statusCode: number | null = null; let body = '';
    const res = { headersSent: false, writeHead(c: number) { statusCode = c; }, end(chunk?: string) { if (chunk) body += chunk; } };
    return { res: res as unknown as ServerResponse, statusCode: () => statusCode, body: () => body };
}

test('REST POST /api/node: summary/entities/topics merge verbatim into metadata', async () => {
    const graphWrites: Array<Record<string, unknown>> = [];
    const fakeGraph = {
        async upsertNode(n: Record<string, unknown>) { graphWrites.push(n); return { ...n, project: n.project ?? 'default', ecosystem: n.ecosystem ?? '*', updatedAt: '2026-06-09T00:00:00.000Z' }; },
        async deleteNode() { /* no-op */ }, async getNode() { return null; },
    };
    const deps: Partial<NodesDeps> = {
        store: { loreGraph: fakeGraph } as never,
        auditLog: { log: () => undefined } as never,
        deploymentMode: 'local', dataplane: null,
    };
    const mock = makeMockRes();
    await handlePostNode(
        makeMockReq(JSON.stringify({ id: 'rest-meta-1', type: 'decision', label: 'l', content: 'c', workspace: 'rc321e-rest', summary: 'rest summary', entities: ['E1'], topics: ['T1', 'T2'] })),
        mock.res, '/api/node', deps as NodesDeps,
    );
    assert.equal(mock.statusCode(), 201, mock.body());
    assert.equal(graphWrites.length, 1);
    const meta = JSON.parse(String(graphWrites[0]!.metadata));
    assert.equal(meta.summary, 'rest summary');
    assert.deepEqual(meta.entities, ['E1']);
    assert.deepEqual(meta.topics, ['T1', 'T2']);
});

test('REST POST /api/node: over-cap questions[] -> 400 invalid_questions_meta, no partial write', async () => {
    const graphWrites: Array<Record<string, unknown>> = [];
    const fakeGraph = {
        async upsertNode(n: Record<string, unknown>) { graphWrites.push(n); return n; },
        async deleteNode() { /* no-op */ }, async getNode() { return null; },
    };
    const deps: Partial<NodesDeps> = {
        store: { loreGraph: fakeGraph } as never,
        auditLog: { log: () => undefined } as never,
        deploymentMode: 'local', dataplane: null,
    };
    const mock = makeMockRes();
    await handlePostNode(
        makeMockReq(JSON.stringify({ id: 'rest-over-cap', type: 'decision', label: 'l', content: 'c', workspace: 'rc321e-rest', questions: Array(MAX_QUESTIONS + 1).fill('too many') })),
        mock.res, '/api/node', deps as NodesDeps,
    );
    assert.equal(mock.statusCode(), 400, mock.body());
    const body = JSON.parse(mock.body());
    assert.equal(body.code, 'invalid_questions_meta');
    assert.equal(graphWrites.length, 0, 'no partial state — the graph write must never have happened');
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
