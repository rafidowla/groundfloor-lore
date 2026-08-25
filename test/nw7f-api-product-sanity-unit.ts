#!/usr/bin/env tsx
/**
 * nw7f-api-product-sanity-unit.ts — NW-7f regression for the four
 * API-surface findings from AUDIT_FINDINGS_2.md:
 *
 *   api-002 — GET /api/node/supersession-candidates skipped workspace
 *             scope. A token bound to ws-a could enumerate ws-b. Post-
 *             fix the route requires `workspace=` (400 on missing),
 *             refuses cross-workspace requests when a principal is
 *             bound (403), and routes the read to the named graph.
 *
 *   api-003 — orphan-decision gate documented + wired but never
 *             enforced. Post-fix the dead block + `orphanExempt`
 *             predicate are removed from middleware.ts. Plugin system
 *             was already removed in v3.11.0 so the gate's reason-to-
 *             exist is gone; `/api/orphan` route family stays as
 *             back-compat (returns {blocking:false, orphans:[]}).
 *
 *   api-004 — MCP store_node HITL response carried `isError:false`,
 *             making "write parked pending human review" wire-
 *             indistinguishable from success to AI callers. Post-fix:
 *             `isError:true` + stable `code:'pending_review'` in the
 *             structured body so callers can branch without parsing
 *             a JSON text blob's `status` field.
 *
 *   api-006 — POST /api/node returned 200 on first create; POST
 *             /api/workspaces returns 201. Post-fix: 201 on first-
 *             create (`isNew:true` in body), 200 on update (`isNew:false`).
 *             Minor-version-bumpable API change (called out in CHANGELOG).
 *
 * Each test pair is constructed so the assertion FAILS on the pre-fix
 * branch and PASSES on swarm/NW-7f. Harness mirrors
 * nw5b-audit-coverage-unit.ts and nw3a-supersede-workspace-unit.ts
 * (real LocalGraphRegistry + two LocalGraphs; direct handler drive,
 * no daemon spin-up).
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';

// ── LORE_HOME isolation ──────────────────────────────────────────────────────
// Set BEFORE any import that transitively loads workspaces.ts (which captures
// the env var at module evaluation time).

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'nw7f-api-'));
process.env['LORE_HOME'] = TEST_HOME;

function seedWorkspaces(home: string, names: string[]): void {
    // Explicit 'surreal': graphA/graphB below are opened via the
    // engine-aware getGraphHandle(), the SAME accessor the route/tool
    // write paths resolve through — seeding, writes, and verification
    // all land on one engine per workspace.
    const workspaces = names.map((name) => ({
        name,
        path: path.join(home, 'workspaces', name),
        createdAt: '2026-06-15T00:00:00.000Z',
        graphEngine: 'surreal' as const,
    }));
    fs.mkdirSync(home, { recursive: true });
    for (const w of workspaces) fs.mkdirSync(path.join(w.path, '.lore'), { recursive: true });
    fs.writeFileSync(
        path.join(home, 'workspaces.json'),
        JSON.stringify({ active: names[0]!, workspaces }, null, 2),
    );
}
seedWorkspaces(TEST_HOME, ['ws-a', 'ws-b']);

const { LocalGraphRegistry } = await import('../packages/lore/src/engines/localGraphRegistry.js');
const { registerMemoryTools } = await import('../packages/lore/src/mcp/tools/memory.js');
const { handlePostNode } = await import('../packages/lore/src/mcp/http/routes/nodes/postNode.js');
const { handleSupersessionCandidates } = await import('../packages/lore/src/mcp/http/routes/nodes/supersessionCandidates.js');
const { LoreStorageClient } = await import('../packages/lore/src/storage/loreStorageClient.js');
const middleware = await import('../packages/lore/src/mcp/http/middleware.js');
const { setWorkspaceVocabPolicy } = await import('../packages/lore/src/config/workspaces.js');

// ── shared fakes ─────────────────────────────────────────────────────────────

function makeFakeVerbatim() {
    return {
        async count() { return 0; },
        async search(_q: string, _l: number) { return []; },
        async bm25Search(_q: string, _l: number) { return []; },
        async store(_a: { id: string; text: string; metadata?: object }) {},
        async delete(_id: string) {},
    };
}
function makePluginRegistry() {
    return {
        activeNames: () => [],
        isActive: () => false,
        active: () => [],
        registerTools: () => undefined,
    };
}
function makeAuditLog() {
    return { log: () => undefined };
}

const registry = new LocalGraphRegistry();
const graphA = await registry.getGraphHandle('ws-a');
const graphB = await registry.getGraphHandle('ws-b');
const verbatim = makeFakeVerbatim();
const storageClient = LoreStorageClient.fromLocal({
    graph: graphA as never,
    verbatim: verbatim as never,
});
const storeBundle = {
    loreGraph: graphA,
    loreVerbatim: verbatim,
    storageClient,
    sessionCache: { pushNode: () => undefined },
};

// ── HTTP harness ─────────────────────────────────────────────────────────────

class MockResponse {
    statusCode = 0;
    headers: Record<string, string> = {};
    body = '';
    writeHead(code: number, headers?: Record<string, string>) {
        this.statusCode = code;
        if (headers) Object.assign(this.headers, headers);
    }
    end(payload?: string) { this.body = payload ?? ''; }
}
function makeReq(body: object): { req: { on: (e: string, cb: (b?: Buffer) => void) => unknown; pause: () => void }; raw: string } {
    const raw = JSON.stringify(body);
    let dataCb: ((chunk: Buffer) => void) | null = null;
    let endCb: (() => void) | null = null;
    const req = {
        on(event: string, cb: (chunk?: Buffer) => void) {
            if (event === 'data') dataCb = cb as (c: Buffer) => void;
            if (event === 'end') endCb = cb as () => void;
            if (dataCb && endCb) {
                queueMicrotask(() => { dataCb!(Buffer.from(raw)); endCb!(); });
            }
            return req;
        },
        pause() { /* no-op */ },
    };
    return { req, raw };
}
function makeRestDeps() {
    return {
        store: storeBundle,
        auditLog: makeAuditLog(),
        deploymentMode: 'local' as const,
        dataplane: null,
        graphRegistry: registry,
    };
}

// ── MCP harness ──────────────────────────────────────────────────────────────

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
            if (typeof handler === 'function') tools[name] = handler as ToolBag[string];
        },
    };
    return { server, tools };
}

// In-memory PendingOpsStore stub matching the interface we exercise.
function makePendingOpsStub() {
    const queue: Array<{ id: string; operation: string; workspaceId: string }> = [];
    let n = 0;
    return {
        async enqueue(input: { operation: string; workspaceId: string }) {
            const id = `pend-${++n}`;
            const row = { id, operation: input.operation, workspaceId: input.workspaceId };
            queue.push(row);
            return { id, status: 'pending', createdAt: '2026-06-15T00:00:00Z', operation: input.operation, workspaceId: input.workspaceId, initiator: '', argsJson: '{}' };
        },
        async getById(_id: string) { return null; },
        async list(_opts?: unknown) { return []; },
        async decide(_input: unknown) { throw new Error('not used'); },
        async markExecuted(_id: string) { throw new Error('not used'); },
        async expireOlderThan(_cutoff: Date) { return 0; },
        _queue: queue,
    };
}

function registerStoreNodeWithPending(server: object, pendingOps: ReturnType<typeof makePendingOpsStub>) {
    const nodeTypesEnum = z.enum(['decision', 'note', 'rare_type']);
    const edgeRelationsEnum = z.enum(['related_to', 'supersedes']);
    registerMemoryTools(server as never, {
        store: storeBundle as never,
        pluginRegistry: makePluginRegistry() as never,
        configManager: { read: () => ({ pluginConfig: {} }) } as never,
        auditLog: makeAuditLog() as never,
        detectedScope: { workspace: 'ws-a', ecosystem: '*' },
        getWal: () => ({ append: () => undefined } as never),
        domain: 'lore',
        edgeRelations: ['related_to', 'supersedes'],
        nodeTypesEnum,
        nodeTypesDescription: 'decision|note|rare_type',
        edgeRelationsEnum,
        graphRegistry: registry,
        coreNodeTypes: ['decision', 'note'],
        pendingOpsStore: pendingOps as never,
    });
}

// ── test runner ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const cases: Array<{ name: string; fn: () => Promise<void> | void }> = [];
function test(name: string, fn: () => Promise<void> | void) { cases.push({ name, fn }); }
async function runAll(): Promise<void> {
    for (const c of cases) {
        try { await c.fn(); console.log(`  ✓ ${c.name}`); passed++; }
        catch (err) { console.error(`  ✗ ${c.name}\n    ${(err as Error).stack ?? (err as Error).message}`); failed++; }
    }
}

// ── api-002: supersession-candidates workspace scope ─────────────────────────

test('api-002 T1: GET /api/node/supersession-candidates without workspace → 400 workspace_required', async () => {
    const res = new MockResponse();
    await handleSupersessionCandidates(res as never, '/api/node/supersession-candidates', makeRestDeps() as never);
    // Pre-fix this returned 200 with an empty/global scan. Post-fix the
    // shared SP-04 read gate fires before any work happens.
    assert.equal(res.statusCode, 400, `expected 400 workspace_required, got ${res.statusCode}: ${res.body}`);
    // Wave 5: canonical {code, message} envelope (was {error, hint}).
    const body = JSON.parse(res.body) as { code: string };
    assert.equal(body.code, 'workspace_required', `expected code 'workspace_required', got '${body.code}'`);
});

test('api-002 T2: GET /api/node/supersession-candidates?workspace=no-such-ws → 404 workspace_not_found', async () => {
    const res = new MockResponse();
    await handleSupersessionCandidates(res as never, '/api/node/supersession-candidates?workspace=no-such-ws', makeRestDeps() as never);
    assert.equal(res.statusCode, 404, `expected 404 workspace_not_found, got ${res.statusCode}: ${res.body}`);
    const body = JSON.parse(res.body) as { code: string; requested: string };
    assert.equal(body.code, 'workspace_not_found');
    assert.equal(body.requested, 'no-such-ws');
});

test('api-002 T3: GET /api/node/supersession-candidates?workspace=ws-b reads ws-b, not boot-bound ws-a', async () => {
    // Seed an isolating node only in ws-b. The route's `candidatesScanned`
    // field reveals which graph it actually read from — pre-fix it would
    // read from the boot-bound storageClient (== graphA), counting 0;
    // post-fix it reads from graphB and counts 1.
    const nowTs = new Date().toISOString();
    await graphB.upsertNode({
        id: 'nw7f-002-b-only', type: 'decision', label: 'b-only',
        content: '', tags: '', project: 'ws-b', ecosystem: '*',
        metadata: '{}', createdAt: nowTs, updatedAt: nowTs, syncedAt: null,
    } as never);

    const res = new MockResponse();
    await handleSupersessionCandidates(res as never, '/api/node/supersession-candidates?workspace=ws-b&fresh=true', makeRestDeps() as never);
    assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
    const body = JSON.parse(res.body) as { candidatesScanned: number };
    assert.ok(body.candidatesScanned >= 1, `expected ws-b graph to contain at least 1 candidate, got candidatesScanned=${body.candidatesScanned}`);
});

// ── api-003: orphan-decision gate dead code removed ──────────────────────────

test('api-003: middleware.ts no longer references the never-enforced orphan gate', async () => {
    // The dead block + `orphanExempt` predicate were removed. The
    // module surface is what matters here — there's no exported gate
    // function for orphan-decision (there never was) and the source
    // file no longer carries the dead exemption predicate.
    const srcPath = path.resolve(process.cwd(), 'packages/lore/src/mcp/http/middleware.ts');
    const source = fs.readFileSync(srcPath, 'utf-8');
    assert.ok(
        !/const orphanExempt\s*=/.test(source),
        'middleware.ts still declares the never-used `orphanExempt` predicate — NW-7f did not delete it',
    );
    // Also confirm `runHttpGates` still exists (we removed a dead block,
    // not the whole function).
    assert.ok(typeof middleware.runHttpGates === 'function', 'runHttpGates must still be exported');
});

// ── api-004: store_node HITL response carries isError:true + code ────────────

test('api-004 T1: store_node HITL response has isError:true + code:"pending_review"', async () => {
    // Trigger a HITL verdict: install a denylist-mode vocab policy on
    // ws-a with onMismatch:hitl, naming a type that the caller submits.
    // The write must be parked, not committed.
    setWorkspaceVocabPolicy('ws-a', {
        mode: 'denylist',
        types: ['rare_type'],
        onMismatch: 'hitl',
    });
    const pendingOps = makePendingOpsStub();
    const { server, tools } = makeMcpServerStub();
    registerStoreNodeWithPending(server, pendingOps);

    const res = await tools['store_node']!({
        id: 'nw7f-004-T1',
        type: 'rare_type',
        label: 'should be HITL-parked',
        workspace: 'ws-a',
    });

    // Pre-fix: isError omitted/false → AI callers cannot distinguish
    // this from a successful write.
    assert.equal(res.isError, true, `expected isError:true on HITL response, got ${res.isError}`);

    const body = JSON.parse(res.content[0]!.text) as {
        code?: string; error?: string; status?: string; pending_op_id?: string;
    };
    assert.equal(body.code, 'pending_review', `expected code:'pending_review', got '${body.code}'`);
    // Back-compat fields preserved so legacy string-match consumers
    // keep working.
    assert.equal(body.status, 'pending_human_review', 'legacy status field must still be present');
    assert.ok(body.pending_op_id, 'pending_op_id must be returned so caller can poll the decision');

    // Side-effect proof: the pending-ops queue actually has a row, i.e.
    // the write was parked, not silently dropped.
    assert.equal(pendingOps._queue.length, 1, `expected 1 pending op enqueued, got ${pendingOps._queue.length}`);

    // Clear the policy so other tests stay unaffected.
    setWorkspaceVocabPolicy('ws-a', null);
});

// ── api-006: POST /api/node returns 201 on create, 200 on update ─────────────

test('api-006 T1: POST /api/node first-create returns 201 with isNew:true', async () => {
    const { req } = makeReq({
        id: 'nw7f-006-T1-fresh',
        type: 'decision',
        label: 'first create',
        workspace: 'ws-a',
    });
    const res = new MockResponse();
    await handlePostNode(req as never, res as never, '/api/node', makeRestDeps() as never);
    // Pre-fix: 200. Post-fix: 201 (matches POST /api/workspaces and the
    // HTTP convention for create).
    assert.equal(res.statusCode, 201, `expected 201 on first-create, got ${res.statusCode}: ${res.body}`);
    const body = JSON.parse(res.body) as { ok: boolean; isNew: boolean };
    assert.equal(body.ok, true);
    assert.equal(body.isNew, true, `expected isNew:true on first-create, got ${body.isNew}`);
});

test('api-006 T2: POST /api/node second-write to same id returns 200 with isNew:false', async () => {
    // Seed first (201).
    const seed = makeReq({
        id: 'nw7f-006-T2-update',
        type: 'decision',
        label: 'seed',
        workspace: 'ws-a',
    });
    const seedRes = new MockResponse();
    await handlePostNode(seed.req as never, seedRes as never, '/api/node', makeRestDeps() as never);
    assert.equal(seedRes.statusCode, 201, `seed must 201, got ${seedRes.statusCode}: ${seedRes.body}`);

    // Now update — same id, different label.
    const update = makeReq({
        id: 'nw7f-006-T2-update',
        type: 'decision',
        label: 'updated label',
        workspace: 'ws-a',
    });
    const updRes = new MockResponse();
    await handlePostNode(update.req as never, updRes as never, '/api/node', makeRestDeps() as never);
    assert.equal(updRes.statusCode, 200, `update must 200, got ${updRes.statusCode}: ${updRes.body}`);
    const body = JSON.parse(updRes.body) as { ok: boolean; isNew: boolean };
    assert.equal(body.ok, true);
    assert.equal(body.isNew, false, `expected isNew:false on update, got ${body.isNew}`);
});

// ── runner ───────────────────────────────────────────────────────────────────

console.log('\n=== NW-7f: API-product sanity (api-002/003/004/006) ===\n');
await runAll();
console.log(`\n${passed} passed, ${failed} failed`);

try { await graphA.close(); } catch { /* ignore */ }
try { await graphB.close(); } catch { /* ignore */ }

process.exit(failed > 0 ? 1 : 0);
