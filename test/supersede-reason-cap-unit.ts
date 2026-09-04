#!/usr/bin/env tsx
/**
 * test/supersede-reason-cap-unit.ts — findings 5+13 (2026-09-03).
 *
 * DECISION (Rafi, 2026-09-03, docs/DATA_CONTRACT.md): Lore is a database
 * and does NOT sanitize free text. `supersede_node` / `POST
 * /api/node/supersede`'s `reason` is persisted verbatim on every graph
 * engine — the fix here is a length cap (parity with storeNode.ts's other
 * text fields via MAX_NODE_FIELD_BYTES), NOT a content filter.
 *
 * Pre-fix:
 *   - MCP `supersede_node`'s `reason` was `z.string().optional()` with no
 *     `.max()` — unbounded (mcp/tools/memory/supersedeNode.ts:26).
 *   - REST `POST /api/node/supersede` did no schema validation on the body
 *     at all (mcp/http/routes/nodes/supersede.ts:40) — a non-string
 *     `reason`, or one of any size, passed straight to `supersedeNode()`.
 *
 * Cases:
 *   1. MCP: `reason` over MAX_NODE_FIELD_BYTES chars → tool call rejected
 *      (McpError InvalidParams) BEFORE the handler runs, real MCP client/
 *      server pair over the SDK's in-memory transport (so this proves the
 *      Zod schema, not just a hand-invoked handler).
 *   2. MCP: `reason` at exactly MAX_NODE_FIELD_BYTES chars → succeeds, and
 *      the stored `supersededReason` on the old node equals the input
 *      EXACTLY — proving the cap is a size guard, not a filter (no
 *      truncation, no redaction, no mangling).
 *   3. REST: `reason` over the cap → 400 `bad_request` via the route's
 *      existing writeError envelope (`{code, message}`), body untouched.
 *   4. REST: `reason` at exactly the cap → 200, stored verbatim (same
 *      exact-equality proof as case 2, via the REST-driven write).
 *   5. REST: `oldId`/`newId` present but non-string → 400 `bad_request`
 *      (type validation, not just presence).
 *
 * All FAIL on baseline (18092d77): MCP accepts any length; REST accepts
 * any length AND any type for oldId/newId/reason.
 *
 * Harness mirrors test/supersede-rest-edge-unit.ts (REST) and
 * test/schema-approve-embedded-unit.ts (real embedded MCP server + real
 * MCP Client over InMemoryTransport, so schema validation is genuinely
 * exercised by the SDK, not bypassed by calling a captured handler).
 *
 * Run:
 *   npx tsx test/supersede-reason-cap-unit.ts
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'supersede-reason-cap-'));
process.env['LORE_HOME'] = TEST_HOME;

const { createLore } = await import('../packages/lore/src/index.js');
const { MAX_NODE_FIELD_BYTES, utf8ByteLength } = await import('../packages/lore/src/engines/nodeFieldLimits.js');
const { LocalGraphRegistry } = await import('../packages/lore/src/engines/localGraphRegistry.js');
const { LoreStorageClient } = await import('../packages/lore/src/storage/loreStorageClient.js');
const { handleSupersede, handleUnsupersede } = await import('../packages/lore/src/mcp/http/routes/nodes/supersede.js');
const { tryBulkWriteRoutes } = await import('../packages/lore/src/mcp/http/routes/bulkWrite.js');

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? (err as Error).message}`);
        failed++;
    }
}

async function main(): Promise<void> {
    console.log('supersede reason length cap (findings 5+13, 2026-09-03)');
    console.log(`  cap = ${MAX_NODE_FIELD_BYTES} chars (MAX_NODE_FIELD_BYTES)`);

    // ── MCP surface: real embedded boot + real MCP Client over InMemoryTransport ──
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supersede-reason-cap-embedded-'));
    process.env['LORE_HOME'] = dataDir;
    const lore = await createLore({ deploymentMode: 'embedded', dataDir });
    try {
        const mcpServer = lore.createMcpServer();
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await mcpServer.connect(serverTransport);
        const client = new Client({ name: 'supersede-reason-cap-test', version: '0.0.1' });
        await client.connect(clientTransport);

        async function seed(id: string): Promise<void> {
            const r = await lore.nodeUpsert({
                id, workspace: 'default', ecosystem: 'test',
                nodeData: { id, type: 'note', label: id, content: '' },
                asyncEmbed: true,
            } as never);
            assert.ok((r as { ok: boolean }).ok, `seed ${id} failed: ${JSON.stringify(r)}`);
        }

        await test('T1 MCP: over-cap reason is rejected by the tool schema (InvalidParams), before the handler runs', async () => {
            await seed('mcp-old-1');
            await seed('mcp-new-1');
            const overCap = 'r'.repeat(MAX_NODE_FIELD_BYTES + 1);
            // The MCP SDK catches the schema's McpError InvalidParams and
            // surfaces it as an isError:true CallToolResult (it does not
            // propagate as a client-side throw) — assert on that shape.
            const result = await client.callTool({
                name: 'supersede_node',
                arguments: { old_id: 'mcp-old-1', new_id: 'mcp-new-1', reason: overCap, workspace: 'default' },
            });
            assert.equal(result.isError, true, `over-cap reason must be rejected, got: ${JSON.stringify(result)}`);
            const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
            assert.match(text, /reason/i, `expected the validation error to name 'reason'; got: ${text}`);
            assert.match(text, /262144|too_big|too big/i, `expected the validation error to reference the cap; got: ${text}`);

            // Confirm the handler never ran: no supersedeAt/supersededReason stamped.
            const node = await lore.store.storageClient.getNode('mcp-old-1', { workspace: 'default' });
            assert.equal(node?.supersededBy ?? null, null, 'rejected call must not have superseded the node');
        });

        await test('T2 MCP: reason at EXACTLY the cap succeeds and is stored VERBATIM (no truncation, no filtering)', async () => {
            await seed('mcp-old-2');
            await seed('mcp-new-2');
            const atCap = 'a'.repeat(MAX_NODE_FIELD_BYTES);
            const result = await client.callTool({
                name: 'supersede_node',
                arguments: { old_id: 'mcp-old-2', new_id: 'mcp-new-2', reason: atCap, workspace: 'default' },
            });
            assert.notEqual(result.isError, true, `expected success, got: ${JSON.stringify(result)}`);

            const node = await lore.store.storageClient.getNode('mcp-old-2', { workspace: 'default' });
            assert.equal(node?.supersededBy, 'mcp-new-2');
            assert.equal(
                node?.supersededReason,
                atCap,
                'stored supersededReason must equal the input EXACTLY — the cap is a size guard, not a content filter',
            );
            assert.equal(node?.supersededReason?.length, MAX_NODE_FIELD_BYTES);
        });

        await test('T2b MCP: multi-byte (CJK) reason at 262144 CHARS is rejected — cap is UTF-8 BYTES, not chars (finding 3)', async () => {
            await seed('mcp-old-2b');
            await seed('mcp-new-2b');
            // '世' is 1 UTF-16 code unit (.length contribution 1) but 3 UTF-8
            // bytes. At exactly MAX_NODE_FIELD_BYTES chars this passed a
            // `.length <= cap` check pre-fix while being 3x the byte cap.
            const reason = '世'.repeat(MAX_NODE_FIELD_BYTES);
            assert.equal(reason.length, MAX_NODE_FIELD_BYTES, 'sanity: this string is exactly the cap by CHAR length');
            assert.ok(utf8ByteLength(reason) > MAX_NODE_FIELD_BYTES, 'sanity: but 3x the cap by BYTE length');
            const result = await client.callTool({
                name: 'supersede_node',
                arguments: { old_id: 'mcp-old-2b', new_id: 'mcp-new-2b', reason, workspace: 'default' },
            });
            assert.equal(result.isError, true, `expected rejection (over BYTE cap), got: ${JSON.stringify(result)}`);
            const node = await lore.store.storageClient.getNode('mcp-old-2b', { workspace: 'default' });
            assert.equal(node?.supersededBy ?? null, null, 'rejected call must not have superseded the node');
        });

        await test('T2c embedded lore.bulkIngest(): a plain upsert cannot set supersededReason directly (finding 1, embedded API gap)', async () => {
            const bigReason = 'X'.repeat(300_000);
            const res = await lore.bulkIngest([{
                id: 'bulk-ingest-gap-1', workspace: 'default', ecosystem: 'test',
                nodeData: { id: 'bulk-ingest-gap-1', type: 'note', label: 'g1', content: '', supersededReason: bigReason },
            }] as never);
            assert.equal(res.ok, false, `expected the item rejected, got: ${JSON.stringify(res)}`);
            assert.equal(res.results[0]?.ok, false);
            const err = (res.results[0] as { ok: false; error: string }).error;
            assert.match(err, /supersededReason/, `expected the rejection to name supersededReason, got: ${err}`);

            const node = await lore.store.storageClient.getNode('bulk-ingest-gap-1', { workspace: 'default' });
            assert.equal(node ?? null, null, 'the protected field must be rejected before the node is ever written');
        });
    } finally {
        await lore.dispose();
    }

    // ── REST surface: same registry/handler harness as supersede-rest-edge-unit.ts ──
    const restHome = fs.mkdtempSync(path.join(os.tmpdir(), 'supersede-reason-cap-rest-'));
    const WS = 'ws-reason-cap';
    {
        const wsPath = path.join(restHome, 'workspaces', WS);
        fs.mkdirSync(path.join(wsPath, '.lore'), { recursive: true });
        fs.writeFileSync(
            path.join(restHome, 'workspaces.json'),
            JSON.stringify({
                active: WS,
                workspaces: [{ name: WS, path: wsPath, createdAt: '2026-09-03T00:00:00.000Z', graphEngine: 'surreal' as const }],
            }, null, 2),
        );
    }
    process.env['LORE_HOME'] = restHome;

    const registry = new LocalGraphRegistry();
    const graph = await registry.getGraphHandle(WS);
    const verbatim = {
        async count() { return 0; },
        async search() { return []; },
        async bm25Search() { return []; },
        async store() {},
        async delete() {},
    };
    const storageClient = LoreStorageClient.fromLocal({ graph: graph as never, verbatim: verbatim as never });
    const storeBundle = {
        loreGraph: graph,
        loreVerbatim: verbatim,
        storageClient,
        sessionCache: { pushNode: () => undefined },
    };
    const mockOutbox = {
        async record() {},
        async markStep() {},
        async remove() {},
        async listUnfinished() { return []; },
    };

    class MockResponse {
        statusCode = 0;
        headers: Record<string, string> = {};
        body = '';
        writeHead(code: number, headers?: Record<string, string>) { this.statusCode = code; if (headers) Object.assign(this.headers, headers); }
        end(payload?: string) { this.body = payload ?? ''; }
    }
    function makeReq(bodyObj: object) {
        const raw = JSON.stringify(bodyObj);
        let dataCb: ((chunk: Buffer) => void) | null = null;
        let endCb: (() => void) | null = null;
        const req = {
            // tryBulkWriteRoutes (T6) checks req.method === 'POST' before
            // doing anything; handleSupersede/handleUnsupersede don't care.
            // Set it unconditionally so this one helper serves both.
            method: 'POST',
            on(event: string, cb: (chunk?: Buffer) => void) {
                if (event === 'data') dataCb = cb as (c: Buffer) => void;
                if (event === 'end') endCb = cb as () => void;
                if (dataCb && endCb) queueMicrotask(() => { dataCb!(Buffer.from(raw)); endCb!(); });
                return req;
            },
            pause() {},
        };
        return req;
    }
    function makeRestDeps() {
        return {
            store: storeBundle,
            auditLog: { log: () => undefined },
            deploymentMode: 'local' as const,
            dataplane: null,
            graphRegistry: registry,
            outboxStore: mockOutbox,
        };
    }
    async function seedRest(id: string): Promise<void> {
        await graph.upsertNode({ id, type: 'decision', label: id, content: '', tags: [], project: WS, ecosystem: '*', metadata: '{}' });
    }

    await test('T3 REST: over-cap reason -> 400 bad_request via the existing writeError envelope', async () => {
        await seedRest('rest-old-1');
        await seedRest('rest-new-1');
        const overCap = 'r'.repeat(MAX_NODE_FIELD_BYTES + 1);
        const req = makeReq({ oldId: 'rest-old-1', newId: 'rest-new-1', reason: overCap, workspace: WS });
        const res = new MockResponse();
        await handleSupersede(req as never, res as never, '/api/node/supersede', makeRestDeps() as never);
        assert.equal(res.statusCode, 400, `expected 400, got ${res.statusCode}: ${res.body}`);
        const parsed = JSON.parse(res.body) as { code?: string; message?: string };
        assert.equal(parsed.code, 'bad_request', `expected the route's bad_request envelope, got: ${res.body}`);
        assert.match(parsed.message ?? '', /reason/i, `expected the message to name 'reason', got: ${res.body}`);

        const node = await graph.getNode('rest-old-1');
        assert.equal(node?.supersededBy ?? null, null, 'rejected REST call must not have superseded the node');
    });

    await test('T4 REST: reason at EXACTLY the cap -> 200, stored VERBATIM', async () => {
        await seedRest('rest-old-2');
        await seedRest('rest-new-2');
        const atCap = 'b'.repeat(MAX_NODE_FIELD_BYTES);
        const req = makeReq({ oldId: 'rest-old-2', newId: 'rest-new-2', reason: atCap, workspace: WS });
        const res = new MockResponse();
        await handleSupersede(req as never, res as never, '/api/node/supersede', makeRestDeps() as never);
        assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);

        const node = await graph.getNode('rest-old-2');
        assert.equal(node?.supersededBy, 'rest-new-2');
        assert.equal(
            node?.supersededReason,
            atCap,
            'stored supersededReason must equal the input EXACTLY over the REST path too',
        );
    });

    await test('T5 REST: non-string oldId/newId -> 400 bad_request (type validation, not just presence)', async () => {
        await seedRest('rest-new-3');
        const req = makeReq({ oldId: 12345, newId: 'rest-new-3', workspace: WS });
        const res = new MockResponse();
        await handleSupersede(req as never, res as never, '/api/node/supersede', makeRestDeps() as never);
        assert.equal(res.statusCode, 400, `expected 400, got ${res.statusCode}: ${res.body}`);
        const parsed = JSON.parse(res.body) as { code?: string };
        assert.equal(parsed.code, 'bad_request', `expected bad_request envelope, got: ${res.body}`);
    });

    await test('T6 REST bulk: POST /api/nodes/bulk rejects supersededReason as unknown_field (finding 1)', async () => {
        await seedRest('bulk-old-1');
        const bigReason = 'z'.repeat(MAX_NODE_FIELD_BYTES + 1);
        const req = makeReq({
            workspace: WS,
            nodes: [{ id: 'bulk-old-1', type: 'decision', label: 'bulk-old-1', content: '', supersededReason: bigReason }],
        });
        const res = new MockResponse();
        await tryBulkWriteRoutes(req as never, res as never, '/api/nodes/bulk', '/api/nodes/bulk', makeRestDeps() as never);
        assert.equal(res.statusCode, 200, `bulk endpoint always 200 unless malformed, got ${res.statusCode}: ${res.body}`);
        const body = JSON.parse(res.body) as { results: Array<{ ok: boolean; error?: string }> };
        assert.equal(body.results[0]?.ok, false, `expected the item rejected, got: ${res.body}`);
        assert.match(body.results[0]?.error ?? '', /supersededReason/, `expected the rejection to name supersededReason, got: ${res.body}`);

        const node = await graph.getNode('bulk-old-1');
        assert.equal(node?.supersededReason ?? null, null, 'the forbidden field must never reach the graph');
    });

    await test('T7 REST unsupersede: id as array -> 400 bad_request, not a 500 crash (finding 4)', async () => {
        const req = makeReq({ id: ['x'], workspace: WS });
        const res = new MockResponse();
        await handleUnsupersede(req as never, res as never, '/api/node/unsupersede', makeRestDeps() as never);
        assert.equal(res.statusCode, 400, `expected 400 (was an uncaught 500), got ${res.statusCode}: ${res.body}`);
        const parsed = JSON.parse(res.body) as { code?: string };
        assert.equal(parsed.code, 'bad_request', `expected bad_request envelope, got: ${res.body}`);
    });

    try { await graph.close(); } catch { /* ignore */ }

    // ── CLI no-daemon fallback (finding 2) ──
    await test('T8 CLI: no-daemon fallback rejects an over-cap --reason before any HTTP/graph work', async () => {
        // Fresh LORE_HOME, no auth.token (tryHttpSupersede returns null, so
        // this exercises the no-daemon fallback), with BOTH endpoints
        // pre-seeded via the same openWorkspaceGraph path the fallback uses.
        // Seeding matters: without a cap check, `graph.supersedeNode` would
        // SUCCEED for two existing, distinct ids — proving a missing cap
        // fails this test because the reason was actually persisted, not
        // because of an unrelated "node not found".
        const cliHome = fs.mkdtempSync(path.join(os.tmpdir(), 'supersede-reason-cap-cli-'));
        process.env['LORE_HOME'] = cliHome;
        const { openWorkspaceGraph } = await import('../packages/lore/src/engines/openWorkspaceGraph.js');
        const seedGraph = openWorkspaceGraph(cliHome);
        await seedGraph.initialize();
        await seedGraph.upsertNode({ id: 'cli-old-1', type: 'note', label: 'cli-old-1', content: '', tags: [], project: 'default', ecosystem: '*', metadata: '{}' } as never);
        await seedGraph.upsertNode({ id: 'cli-new-1', type: 'note', label: 'cli-new-1', content: '', tags: [], project: 'default', ecosystem: '*', metadata: '{}' } as never);
        await seedGraph.close();

        const { supersedeCommand } = await import('../packages/lore/src/cli/commands/supersede.js');
        const realExit = process.exit;
        let exitCode: number | undefined;
        (process as unknown as { exit: (code?: number) => never }).exit = ((code?: number) => {
            exitCode = code;
            throw new Error('__test_exit__');
        }) as never;
        try {
            const overCap = 'c'.repeat(MAX_NODE_FIELD_BYTES + 1);
            await assert.rejects(
                () => supersedeCommand(['cli-old-1', 'cli-new-1', '--reason', overCap]),
                /__test_exit__/,
                'expected the fallback to call process.exit before persisting anything',
            );
            assert.equal(exitCode, 1, 'expected process.exit(1) on an over-cap --reason');
        } finally {
            process.exit = realExit;
        }

        // The oversize reason must never have reached the graph.
        const verifyGraph = openWorkspaceGraph(cliHome);
        await verifyGraph.initialize();
        const node = await verifyGraph.getNode('cli-old-1');
        assert.equal(node?.supersededBy ?? null, null, 'an over-cap --reason must not reach graph.supersedeNode at all');
        await verifyGraph.close();
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST HARNESS FAILED:', e); process.exit(2); });
