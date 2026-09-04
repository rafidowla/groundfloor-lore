#!/usr/bin/env tsx
/**
 * triage-recommended-fixes-unit.ts — regression coverage for the small
 * "recommended" triage fixes:
 *
 *   L-037 — corrupt token registry is renamed aside (recoverable) instead of
 *           being silently overwritten with an empty one (token wipe).
 *   L-048 — POST /api/nodes/prune enforces the per-token write scope (a
 *           read-only Bearer → 403), mirroring DELETE /api/node.
 *   L-049/L-050 — GET /api/load/jobs/<id> is workspace-scoped: a principal
 *           bound to workspace A cannot read a job that lives in workspace B.
 *   L-067 — mutating /v1/{collection} ops (insert/bulk/truncate/PUT/DELETE)
 *           enforce the per-token write scope (a read-only Bearer → 403);
 *           reads (GET, POST query) are unaffected.
 *
 * Style mirrors sp04-http-read-scope-unit.ts (fakeReq/fakeRes +
 * runWithPrincipal) and Z1-load-endpoint-unit.ts (real LoadJobsStore).
 *
 * Run:
 *   LORE_HOME=$(mktemp -d) npx tsx test/triage-recommended-fixes-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { tryLifecycleRoutes } from '../packages/lore/src/mcp/http/routes/lifecycle.js';
import { tryLoadRoutes } from '../packages/lore/src/mcp/http/routes/load.js';
import { tryCollectionsRoutes } from '../packages/lore/src/mcp/http/routes/collections.js';
import { registerDeleteNodeTool } from '../packages/lore/src/mcp/tools/memory/deleteNode.js';
import { LoadJobsStore } from '../packages/lore/src/storage/loadJobsStore.js';
import { runWithPrincipal, type Principal } from '../packages/lore/src/auth/principal.js';
import type { TokenScope } from '../packages/lore/src/auth/tokens.js';

/* ─── shared fakes (sp04 style) ─────────────────────────────────────────── */

function appPrincipal(workspace: string, scopes: TokenScope[]): Principal {
    return { kind: 'app', workspace, scopes, label: `app-${workspace}` };
}

function fakeReq(method: string, url?: string, body?: string): IncomingMessage {
    if (body !== undefined) {
        let consumed = false;
        return {
            method, url,
            on(event: string, cb: (chunk?: Buffer) => void) {
                if (event === 'data' && !consumed) { consumed = true; cb(Buffer.from(body, 'utf8')); }
                if (event === 'end') setImmediate(() => cb());
                return this;
            },
        } as unknown as IncomingMessage;
    }
    return { method, url, on: () => undefined } as unknown as IncomingMessage;
}

function fakeRes(): ServerResponse & { _status: number; _body: string } {
    const r = {
        _status: 0, _body: '',
        writeHead(status: number) { (this as { _status: number })._status = status; return this; },
        end(body?: string) { (this as { _body: string })._body = body ?? ''; },
    };
    return r as unknown as ServerResponse & { _status: number; _body: string };
}

let passed = 0, failed = 0;
const pending: Array<Promise<void>> = [];
const test = (name: string, fn: () => Promise<void>) => {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
    })());
};

console.log('triage-recommended-fixes-unit.ts');

/* ─── L-037 — corrupt registry renamed aside, not wiped ─────────────────── */

test('L-037: corrupt registry is renamed aside (recoverable) and rebuilt empty', async () => {
    // Pin LORE_HOME at a fresh tmp dir so the auth registry path is isolated.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'l037-'));
    const prev = process.env['LORE_HOME'];
    process.env['LORE_HOME'] = home;
    try {
        // Re-import the module FRESH so loreHome() reads the just-set env on a
        // clean module state (tokens caches nothing, but getRegistryPath/listTokens
        // call loreHome() on every invocation, so a plain import is fine here).
        const tokens = await import('../packages/lore/src/auth/tokens.js');
        const regPath = tokens.getRegistryPath();
        fs.mkdirSync(path.dirname(regPath), { recursive: true });
        // Write a corrupt (unparseable) registry that ALSO carries content we
        // must not lose — the bug silently overwrote this with {}.
        const corruptContent = '{ this is not valid json, here are my precious tokens';
        fs.writeFileSync(regPath, corruptContent, 'utf8');

        // listTokens() drives ensureRegistry() → the catch path.
        const list = tokens.listTokens();
        assert.equal(list.length, 0, 'rebuilt registry is empty (expected after corruption)');

        // 1) the bad file was renamed aside, preserving the original bytes.
        const aside = fs.readdirSync(path.dirname(regPath))
            .filter((f) => f.startsWith('registry.json.corrupt.'));
        assert.equal(aside.length, 1, `exactly one .corrupt.* sidecar (got ${aside.length})`);
        const preserved = fs.readFileSync(path.join(path.dirname(regPath), aside[0]), 'utf8');
        assert.equal(preserved, corruptContent, 'corrupt sidecar preserves original bytes verbatim');

        // 2) registry.json itself is now a valid, fresh registry (not the corrupt blob).
        const fresh = JSON.parse(fs.readFileSync(regPath, 'utf8'));
        assert.equal(fresh.version, 1);
        assert.deepEqual(fresh.entries, {});
    } finally {
        if (prev === undefined) delete process.env['LORE_HOME']; else process.env['LORE_HOME'] = prev;
        fs.rmSync(home, { recursive: true, force: true });
    }
});

/* ─── L-048 — prune enforces per-token write scope ──────────────────────── */

function lifecycleDeps(): Parameters<typeof tryLifecycleRoutes>[4] {
    // The write-scope gate fires right after the workspace is parsed, before
    // any store/workspaces.json access, so a 403-bound principal never reaches
    // these stubs. deploymentMode 'local' makes the upstream ReBAC gate a no-op.
    return {
        store: {} as never,
        auxStore: {} as never,
        deploymentMode: 'local',
        dataplane: null,
    } as Parameters<typeof tryLifecycleRoutes>[4];
}

test('L-048: POST /api/nodes/prune with read-only token → 403 (refused at a write-scope gate)', async () => {
    const res = fakeRes();
    const readOnly = appPrincipal('alpha', ['read']);
    await runWithPrincipal(readOnly, () =>
        tryLifecycleRoutes(
            fakeReq('POST', '/api/nodes/prune', JSON.stringify({ workspace: 'alpha' })),
            res, '/api/nodes/prune', '/api/nodes/prune', lifecycleDeps()));
    assert.equal(res._status, 403, res._body);
    // Two write-scope gates guard prune; both are valid and the test must
    // not over-specify which fires. gateRoute({permission:'write'}) at
    // lifecycle.ts:55 (local-mode scope check, added 2026-06-20 commit
    // 1a4ec7b "MVP launch hardening") catches a read-only token FIRST →
    // { code:'denied' }. requireWriteToWorkspace (per-workspace) →
    // { error:'scope_missing' }, reached only by write-scoped tokens.
    // Originally this matched `scope_missing` (gate 2); gate 1 was added
    // later and now intercepts. Assert the property (refused at a write
    // gate), not the gate. The cross-workspace case below still pins gate
    // 2's workspace_forbidden with a write-scoped token.
    assert.match(res._body, /scope_missing|denied/, `expected a write-scope denial; got ${res._body}`);
});

test('L-048: POST /api/nodes/prune cross-workspace without grant → 403 workspace_forbidden', async () => {
    const res = fakeRes();
    const writerA = appPrincipal('alpha', ['read', 'write']);
    await runWithPrincipal(writerA, () =>
        tryLifecycleRoutes(
            fakeReq('POST', '/api/nodes/prune', JSON.stringify({ workspace: 'beta' })),
            res, '/api/nodes/prune', '/api/nodes/prune', lifecycleDeps()));
    assert.equal(res._status, 403, res._body);
    assert.match(res._body, /workspace_forbidden/);
});

test('L-048: POST /api/nodes/prune NO principal → not 403 (legacy/local bypass preserved)', async () => {
    const res = fakeRes();
    // No runWithPrincipal: getCurrentPrincipal() is null → gate bypassed.
    // The route proceeds past the gate and 404s on the unknown workspace
    // (loadWorkspaces() finds nothing) — the key assertion is "not 403".
    await tryLifecycleRoutes(
        fakeReq('POST', '/api/nodes/prune', JSON.stringify({ workspace: 'no-such-ws' })),
        res, '/api/nodes/prune', '/api/nodes/prune', lifecycleDeps());
    assert.notEqual(res._status, 403, `expected bypass, got 403: ${res._body}`);
});

/* ─── L-049/L-050 — GET /api/load/jobs/<id> is workspace-scoped ─────────── */

function mkLoadDeps(store: LoadJobsStore, dir: string): Parameters<typeof tryLoadRoutes>[4] {
    return { loreDir: dir, loadJobsStore: store, deploymentMode: 'local', dataplane: null };
}

test('L-049/L-050: GET /api/load/jobs/<id> in ws B refused for principal bound to ws A → 403', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l049-'));
    const store = new LoadJobsStore(dir);
    try {
        // Create a job that lives in workspace "beta".
        const job = await store.create({
            jobId: 'job-beta-1', workspace: 'beta', format: 'jsonl',
            embedMode: 'skip', tempFilePath: path.join(dir, 'x.jsonl'),
            createdAt: new Date().toISOString(),
        });
        const res = fakeRes();
        const alpha = appPrincipal('alpha', ['read', 'write']); // no cross-workspace-read
        await runWithPrincipal(alpha, () =>
            tryLoadRoutes(fakeReq('GET', `/api/load/jobs/${job.jobId}`),
                res, `/api/load/jobs/${job.jobId}`, `/api/load/jobs/${job.jobId}`, mkLoadDeps(store, dir)));
        assert.equal(res._status, 403, res._body);
        assert.match(res._body, /workspace_forbidden/);
    } finally {
        store.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('L-049/L-050: GET /api/load/jobs/<id> in own workspace → 200', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l049b-'));
    const store = new LoadJobsStore(dir);
    try {
        const job = await store.create({
            jobId: 'job-alpha-1', workspace: 'alpha', format: 'jsonl',
            embedMode: 'skip', tempFilePath: path.join(dir, 'x.jsonl'),
            createdAt: new Date().toISOString(),
        });
        const res = fakeRes();
        const alpha = appPrincipal('alpha', ['read', 'write']);
        await runWithPrincipal(alpha, () =>
            tryLoadRoutes(fakeReq('GET', `/api/load/jobs/${job.jobId}`),
                res, `/api/load/jobs/${job.jobId}`, `/api/load/jobs/${job.jobId}`, mkLoadDeps(store, dir)));
        assert.equal(res._status, 200, res._body);
        assert.match(res._body, /job-alpha-1/);
    } finally {
        store.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('L-049/L-050: GET /api/load/jobs/<id> unknown id stays 404 (no existence leak)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l049c-'));
    const store = new LoadJobsStore(dir);
    try {
        const res = fakeRes();
        const alpha = appPrincipal('alpha', ['read', 'write']);
        await runWithPrincipal(alpha, () =>
            tryLoadRoutes(fakeReq('GET', '/api/load/jobs/does-not-exist'),
                res, '/api/load/jobs/does-not-exist', '/api/load/jobs/does-not-exist', mkLoadDeps(store, dir)));
        assert.equal(res._status, 404, res._body);
        assert.match(res._body, /load_job_not_found/);
    } finally {
        store.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

/* ─── L-067 — mutating /v1/{collection} ops enforce write scope ─────────── */

/** A table-storage stub that THROWS if any write method is reached — proves
 *  the 403 gate fires BEFORE substrate access. Reads return empty. */
function makeTrapTableStorage() {
    const trap = (op: string) => { throw new Error(`substrate reached for ${op} — gate did not fire`); };
    return {
        insert: async () => trap('insert'),
        bulkInsert: async () => trap('bulkInsert'),
        update: async () => trap('update'),
        updateByQuery: async () => trap('updateByQuery'),
        delete: async () => trap('delete'),
        deleteByQuery: async () => trap('deleteByQuery'),
        truncate: async () => trap('truncate'),
        get: async () => null,
        find: async () => [],
        count: async () => 0,
    } as unknown as Parameters<typeof tryCollectionsRoutes>[4]['tableStorage'];
}

function collectionsDeps(): Parameters<typeof tryCollectionsRoutes>[4] {
    return { tableStorage: makeTrapTableStorage() };
}

const mutating: Array<{ name: string; method: string; pathname: string; body: string }> = [
    { name: 'POST /v1/{c} insert', method: 'POST', pathname: '/v1/things', body: JSON.stringify({ id: '1' }) },
    { name: 'POST /v1/{c}/bulk', method: 'POST', pathname: '/v1/things/bulk', body: JSON.stringify({ records: [{ id: '1' }] }) },
    { name: 'POST /v1/{c}/truncate', method: 'POST', pathname: '/v1/things/truncate', body: '{}' },
    { name: 'PUT /v1/{c}', method: 'PUT', pathname: '/v1/things', body: JSON.stringify({ filter: { id: '1' }, updates: { x: 1 } }) },
    { name: 'DELETE /v1/{c}', method: 'DELETE', pathname: '/v1/things', body: JSON.stringify({ filter: { id: '1' } }) },
    { name: 'PUT /v1/{c}/update-by-query', method: 'PUT', pathname: '/v1/things/update-by-query', body: JSON.stringify({ filter: { id: '1' }, fields: { x: 1 } }) },
    { name: 'DELETE /v1/{c}/delete-by-query', method: 'DELETE', pathname: '/v1/things/delete-by-query', body: JSON.stringify({ filter: { id: '1' } }) },
    { name: 'POST /v1/schema createCollection', method: 'POST', pathname: '/v1/schema', body: JSON.stringify({ name: 'things', fields: [] }) },
];

for (const m of mutating) {
    test(`L-067: ${m.name} with read-only token → 403 scope_missing`, async () => {
        const res = fakeRes();
        const readOnly = appPrincipal('alpha', ['read']);
        await runWithPrincipal(readOnly, () =>
            tryCollectionsRoutes(fakeReq(m.method, m.pathname, m.body), res, m.pathname, m.pathname, collectionsDeps()));
        assert.equal(res._status, 403, `${m.name}: ${res._body}`);
        assert.match(res._body, /scope_missing/, `${m.name}: ${res._body}`);
    });
}

test('L-067: POST /v1/{c}/query (read) with read-only token → NOT 403 (reads unaffected)', async () => {
    const res = fakeRes();
    const readOnly = appPrincipal('alpha', ['read']);
    await runWithPrincipal(readOnly, () =>
        tryCollectionsRoutes(fakeReq('POST', '/v1/things/query', JSON.stringify({ filter: {} })),
            res, '/v1/things/query', '/v1/things/query', collectionsDeps()));
    assert.notEqual(res._status, 403, `query must not be gated as a write: ${res._body}`);
});

test('L-067: POST /v1/{c} insert with NO principal → not 403 (legacy/local bypass preserved)', async () => {
    const res = fakeRes();
    // No principal: gate bypassed → reaches the trap stub, which throws and is
    // surfaced as a 500. The point is purely "not 403".
    await tryCollectionsRoutes(fakeReq('POST', '/v1/things', JSON.stringify({ id: '1' })),
        res, '/v1/things', '/v1/things', collectionsDeps());
    assert.notEqual(res._status, 403, `expected bypass, got 403: ${res._body}`);
});

/* ─── L-056 — delete_node MCP tool tombstones in the resolved workspace ──── */

/** Captures which verbatim store received the tombstone. */
function makeRecordingVerbatim() {
    const tombstoned: string[] = [];
    return {
        tombstoned,
        store: {
            async tombstone(id: string) { tombstoned.push(id); },
            async store() { /* unused */ },
            async delete(id: string) { tombstoned.push(id); },
        },
    };
}

/** Build a fully-isolated delete_node handler with the given boot verbatim +
 *  optional per-workspace resolver. No shared module state, so concurrent
 *  tests can't clobber each other. No graphRegistry → resolveTargetGraph
 *  returns store.loreGraph with resolvedWorkspace = the requested name. */
function captureDeleteTool(
    bootVerbatim: ReturnType<typeof makeRecordingVerbatim>['store'],
    resolver: { getOrOpen: (ws: string) => Promise<unknown> } | undefined,
) {
    let handler: ((args: { id: string; workspace: string }) => Promise<unknown>) | null = null;
    const server = {
        tool: (_name: string, ..._rest: unknown[]) => {
            const h = _rest[_rest.length - 1];
            if (typeof h === 'function') handler = h as typeof handler;
        },
    };
    const graph = { async deleteNode(_id: string) { return true; } };
    const deps = {
        store: {
            loreGraph: graph as never,
            loreVerbatim: bootVerbatim as never,
            storageClient: { async verbatimDelete() { /* legacy fallback */ } } as never,
        } as never,
        auditLog: { log: () => undefined } as never,
        detectedScope: { workspace: 'boot-ws', ecosystem: '*' },
        workspaceVerbatimResolver: resolver as never,
        // ITEM X-walnode (2026-09-03) — delete_node now appends to the WAL
        // for an active-workspace delete (mirrors store_node/store_edge);
        // MemoryToolsDeps.getWal is required. No graphRegistry here means
        // resolveTargetGraph always reports isActive:true, so this IS reached.
        getWal: () => ({ append: () => undefined }),
    } as unknown as Parameters<typeof registerDeleteNodeTool>[1];
    registerDeleteNodeTool(server as never, deps);
    if (!handler) throw new Error('delete_node tool was not registered');
    return handler;
}

test('L-056: delete_node tombstones in the RESOLVED workspace store (not boot)', async () => {
    const boot = makeRecordingVerbatim();
    const wsB = makeRecordingVerbatim();
    const resolver = {
        getOrOpen: async (ws: string) => {
            if (ws === 'B') return wsB.store;
            throw new Error(`workspace_not_found: "${ws}"`);
        },
    };
    const handler = captureDeleteTool(boot.store, resolver);
    await handler({ id: 'n1', workspace: 'B' });
    await new Promise((r) => setImmediate(r)); // settle the fire-and-forget op
    assert.equal(wsB.tombstoned.length, 1, 'tombstone must hit the resolved workspace store');
    assert.equal(wsB.tombstoned[0], 'lore:n1');
    assert.equal(boot.tombstoned.length, 0, 'tombstone must NOT hit the boot store');
});

test('L-056: delete_node falls back to boot store when no resolver (legacy unchanged)', async () => {
    const boot = makeRecordingVerbatim();
    const handler = captureDeleteTool(boot.store, undefined);
    await handler({ id: 'n2', workspace: 'wsX' });
    await new Promise((r) => setImmediate(r));
    assert.equal(boot.tombstoned.length, 1, 'no resolver → boot store used (back-compat)');
    assert.equal(boot.tombstoned[0], 'lore:n2');
});

/* ─── summary ───────────────────────────────────────────────────────────── */

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
