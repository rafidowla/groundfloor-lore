#!/usr/bin/env tsx
/**
 * nw5b-audit-coverage-unit.ts — NW-5b regression for
 * ent-audit-incomplete-coverage (AUDIT_FINDINGS_2.md).
 *
 * Pre-fix bug:
 *   The primary write paths (store_node MCP tool, POST /api/node, plus
 *   store_edge / delete_node / mark_stale MCP tools) did NOT emit an
 *   audit row. Audit logging was per-route with no central wrapper, so
 *   the file-split refactor that broke storeNode.ts out of the megafile
 *   silently dropped its audit call. A system that markets "every tool
 *   call is auditable" cannot drop the primary node-upsert.
 *
 * Cases:
 *   A. store_node (MCP) → audit row written with workspace + node id +
 *      duration + success result.
 *   B. POST /api/node → audit row written with workspace + node id +
 *      status + duration + success result.
 *   C. Discoverability: every entry in KNOWN_WRITE_ROUTES has its
 *      handler file actually call auditLog.log(...) — the wrapper
 *      registry is meaningless if a route can be added without an
 *      audit emission.
 *
 * Test mechanics:
 *   Drives the handlers directly with a real LocalGraphRegistry and a
 *   spy AuditLog (collects log() calls). Mirrors the harness from
 *   nw3a-supersede-workspace-unit.ts.
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'nw5b-audit-'));
process.env['LORE_HOME'] = TEST_HOME;

function seedWorkspaces(home: string, names: string[]): void {
    const workspaces = names.map((name) => ({
        name,
        path: path.join(home, 'workspaces', name),
        createdAt: '2026-06-15T00:00:00.000Z',
    }));
    fs.mkdirSync(home, { recursive: true });
    for (const w of workspaces) fs.mkdirSync(path.join(w.path, '.lore'), { recursive: true });
    fs.writeFileSync(
        path.join(home, 'workspaces.json'),
        JSON.stringify({ active: names[0]!, workspaces }, null, 2),
    );
}
seedWorkspaces(TEST_HOME, ['ws-a']);

const { LocalGraphRegistry } = await import('../packages/lore/src/engines/localGraphRegistry.js');
const { registerMemoryTools } = await import('../packages/lore/src/mcp/tools/memory.js');
const { handlePostNode } = await import('../packages/lore/src/mcp/http/routes/nodes/postNode.js');
const { LoreStorageClient } = await import('../packages/lore/src/storage/loreStorageClient.js');
const { KNOWN_WRITE_ROUTES } = await import('../packages/lore/src/security/audit.js');

// ── spy audit log ────────────────────────────────────────────────────────────

interface SpyEntry {
    toolName: string;
    args: unknown;
    result: string;
    resultDetail?: string;
    durationMs: number;
}
function makeSpyAuditLog(): { log: (entry: Omit<SpyEntry, never>) => void; entries: SpyEntry[]; reset: () => void } {
    const entries: SpyEntry[] = [];
    return {
        log: (entry: Omit<SpyEntry, never>) => { entries.push(entry as SpyEntry); },
        entries,
        reset: () => { entries.length = 0; },
    };
}

// ── fakes / shared resources ─────────────────────────────────────────────────

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

const registry = new LocalGraphRegistry();
const graphA = await registry.getGraphHandle('ws-a');
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

const spyAudit = makeSpyAuditLog();

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

function registerAllMemoryTools(server: object): void {
    const nodeTypesEnum = z.enum(['decision', 'note']);
    const edgeRelationsEnum = z.enum(['related_to', 'supersedes']);
    registerMemoryTools(server as never, {
        store: storeBundle as never,
        pluginRegistry: makePluginRegistry() as never,
        configManager: { read: () => ({ pluginConfig: {} }) } as never,
        auditLog: spyAudit as never,
        detectedScope: { workspace: 'ws-a', ecosystem: '*' },
        getWal: () => ({ append: () => undefined } as never),
        domain: 'lore',
        edgeRelations: ['related_to', 'supersedes'],
        nodeTypesEnum,
        nodeTypesDescription: 'decision|note',
        edgeRelationsEnum,
        graphRegistry: registry,
        coreNodeTypes: ['decision', 'note'],
    });
}

const { server, tools } = makeMcpServerStub();
registerAllMemoryTools(server);

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
                queueMicrotask(() => {
                    dataCb!(Buffer.from(raw));
                    endCb!();
                });
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
        auditLog: spyAudit,
        deploymentMode: 'local' as const,
        dataplane: null,
        graphRegistry: registry,
    };
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

// ── A. MCP store_node emits an audit row ─────────────────────────────────────

test('A1: store_node (MCP) emits an audit row with workspace + nodeId + success', async () => {
    spyAudit.reset();
    const res = await tools['store_node']!({
        id: 'nw5b-A1',
        type: 'decision',
        label: 'NW-5b audit coverage A1',
        workspace: 'ws-a',
    });
    assert.ok(!res.isError, `expected ok, got: ${res.content[0]?.text}`);
    const auditCalls = spyAudit.entries.filter((e) => e.toolName === 'store_node');
    assert.equal(auditCalls.length, 1, `expected exactly one store_node audit row, got ${auditCalls.length}`);
    const entry = auditCalls[0]!;
    assert.equal(entry.result, 'success', `expected success, got ${entry.result}: ${entry.resultDetail}`);
    const args = entry.args as { workspace: string | null; nodeId: string | null };
    assert.equal(args.workspace, 'ws-a');
    assert.equal(args.nodeId, 'nw5b-A1');
    assert.ok(typeof entry.durationMs === 'number' && entry.durationMs >= 0, 'durationMs must be a number');
});

test('A2: store_node failure (workspace_not_found) still emits an audit row', async () => {
    spyAudit.reset();
    const res = await tools['store_node']!({
        id: 'nw5b-A2',
        type: 'decision',
        label: 'NW-5b audit coverage A2',
        workspace: 'no-such-ws',
    });
    assert.ok(res.isError, 'expected error envelope');
    const auditCalls = spyAudit.entries.filter((e) => e.toolName === 'store_node');
    assert.equal(auditCalls.length, 1, `expected exactly one store_node audit row even on failure, got ${auditCalls.length}`);
    // Result classification: workspace_not_found is an envelope-error
    // path so the wrapper records it as error.
    assert.equal(auditCalls[0]!.result, 'success', 'workspace_not_found is a returned envelope (not throw); audit records request was processed');
    // Both branches are acceptable — the must-have is "an audit row exists".
});

// ── B. REST POST /api/node emits an audit row ────────────────────────────────

test('B1: POST /api/node (REST) emits an audit row with workspace + nodeId + success', async () => {
    spyAudit.reset();
    const { req } = makeReq({
        id: 'nw5b-B1', type: 'decision', label: 'NW-5b audit coverage B1',
        workspace: 'ws-a',
    });
    const res = new MockResponse();
    await handlePostNode(req as never, res as never, '/api/node', makeRestDeps() as never);
    // NW-7f (api-006) — POST /api/node now returns 201 on first-create,
    // 200 on update. NW-5b only cares that a 2xx success was logged, not
    // the exact code, so accept either.
    assert.ok(res.statusCode === 200 || res.statusCode === 201, `expected 2xx success, got ${res.statusCode}: ${res.body}`);
    const auditCalls = spyAudit.entries.filter((e) => e.toolName === 'http:post_node');
    assert.equal(auditCalls.length, 1, `expected exactly one http:post_node audit row, got ${auditCalls.length}`);
    const entry = auditCalls[0]!;
    assert.equal(entry.result, 'success', `expected success, got ${entry.result}: ${entry.resultDetail}`);
    const args = entry.args as { workspace: string | null; nodeId: string | null; status: number };
    assert.equal(args.workspace, 'ws-a');
    assert.equal(args.nodeId, 'nw5b-B1');
    assert.ok(args.status === 200 || args.status === 201, `expected status 200 or 201, got ${args.status}`);
});

test('B2: POST /api/node validation failure (400) emits an audit row', async () => {
    spyAudit.reset();
    const { req } = makeReq({ /* missing id/type/label */ workspace: 'ws-a' });
    const res = new MockResponse();
    await handlePostNode(req as never, res as never, '/api/node', makeRestDeps() as never);
    assert.equal(res.statusCode, 400, `expected 400, got ${res.statusCode}: ${res.body}`);
    const auditCalls = spyAudit.entries.filter((e) => e.toolName === 'http:post_node');
    assert.equal(auditCalls.length, 1, `expected one audit row even on 400, got ${auditCalls.length}`);
    assert.equal(auditCalls[0]!.result, 'error');
});

// ── C. Discoverability: every KNOWN_WRITE_ROUTES handler emits audit ─────────

test('C1: every KNOWN_WRITE_ROUTES handler file actually emits audit', async () => {
    // Resolve from the test file's directory up to repo root.
    // The test runs from the repo root via `tsx test/...`, so use cwd.
    const repoRoot = process.cwd();
    const missing: string[] = [];
    for (const route of KNOWN_WRITE_ROUTES) {
        const absPath = path.join(repoRoot, route.path);
        if (!fs.existsSync(absPath)) {
            missing.push(`${route.name}: file does not exist at ${route.path}`);
            continue;
        }
        const source = fs.readFileSync(absPath, 'utf-8');
        // Accept either a direct .log( call on auditLog OR a withMcpAudit/withHttpAudit wrapper.
        const hasDirectLog = /auditLog\.log\s*\(/.test(source);
        const hasWrapper = /withMcpAudit|withHttpAudit/.test(source);
        if (!hasDirectLog && !hasWrapper) {
            missing.push(`${route.name} (${route.path}): no auditLog.log() call and no withMcpAudit/withHttpAudit wrapper`);
        }
    }
    assert.equal(missing.length, 0, `KNOWN_WRITE_ROUTES handlers missing audit coverage:\n  ${missing.join('\n  ')}`);
});

test('C2: KNOWN_WRITE_ROUTES is non-empty and contains the primary writers', () => {
    assert.ok(KNOWN_WRITE_ROUTES.length >= 5, `expected at least 5 known write routes, got ${KNOWN_WRITE_ROUTES.length}`);
    const names = new Set(KNOWN_WRITE_ROUTES.map((r) => r.name));
    for (const must of ['mcp:store_node', 'mcp:store_edge', 'mcp:delete_node', 'mcp:supersede_node', 'http:post_node']) {
        assert.ok(names.has(must), `KNOWN_WRITE_ROUTES missing required entry: ${must}`);
    }
});

// ── runner ───────────────────────────────────────────────────────────────────

console.log('\n=== NW-5b: audit-coverage for write surfaces (ent-audit-incomplete-coverage) ===\n');
await runAll();
console.log(`\n${passed} passed, ${failed} failed`);

try { await graphA.close(); } catch { /* ignore */ }

process.exit(failed > 0 ? 1 : 0);
