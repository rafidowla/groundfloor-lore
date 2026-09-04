/**
 * test/phase6-comprehensive-coverage.ts
 *
 * Phase 6 — comprehensive coverage across happy / unhappy / edge /
 * complex / UX / UAT-style axes. The shipped slices (P1.A → P4) each
 * have their own focused test files; this one fills in the edges they
 * skipped and proves that the slices compose correctly with each other.
 *
 * Layout (one test per gap, each runs in its own child process so
 * the engine's accumulated native state can't cross-contaminate):
 *
 *   P1B-E1  registry getGraphHandle returns the SAME instance on concurrent
 *           first-time opens (in-flight dedupe).
 *   P1B-E2  registry invalidates entries whose path changed in
 *           workspaces.json (mtime watcher).
 *   P1C-E1  recall workspace:"*" with the SAME id present in two
 *           workspaces emits exactly one row, tagged with the
 *           higher-scoring source.
 *   P2-E1   vocabPolicy mode='denylist' rejects types in the denylist
 *           and accepts everything else.
 *   P2-E2   multiple unknown fields surface together in one
 *           unknown_field envelope (not one-at-a-time).
 *   P3-E1   missing Bearer header on /api/node POST → 401 auth required
 *           via httpAuth (validator's Bearer regex).
 *   P3-E2   malformed Bearer ("lore_dev_TOO_SHORT") → 401.
 *   P3-E3   well-formed but UNREGISTERED app token → 401 from middleware.
 *   P4-E1   migrate --on-conflict=skip moves only non-conflicting ids;
 *           conflicts counted but not overwritten.
 *   P4-E2   migrate --filter-tag value matches when the tag is present
 *           in the comma-separated tags string.
 *   P4-E3   migrate against an unknown source workspace surfaces
 *           "workspace_not_found" cleanly (no segfault, no stale state).
 *   CROSS-C1 token bound to dev tries to write into a cre workspace
 *           with a vocabPolicy reject set. The token's workspace gate
 *           rejects FIRST (403 workspace_forbidden) — vocab policy
 *           is never consulted. Order matters: auth before policy.
 *   CROSS-C2 token with cross-workspace-read scope can run
 *           workspace:"*" recall AND the aggregator successfully
 *           returns hits from every workspace.
 *
 * Run:
 *   LORE_HOME=$(mktemp -d) npx tsx test/phase6-comprehensive-coverage.ts
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TEST_HOME = process.env['LORE_HOME'];
if (!TEST_HOME || TEST_HOME === path.join(process.env['HOME'] ?? '', '.groundfloor')) {
    console.error(
        'ERROR: LORE_HOME must be set to a fresh temp dir before running this test.\n' +
            'Use: LORE_HOME=$(mktemp -d) npx tsx test/phase6-comprehensive-coverage.ts',
    );
    process.exit(2);
}

/* ─── Workspace fixtures ───────────────────────────────────────── */
//
// Every per-test workspace lives under one workspaces.json so the
// config/workspaces.ts module cache (which freezes loreHome at import
// time) doesn't trip. Names are namespaced by test id.

const TEST_IDS = [
    'p1b-e1', 'p1b-e2',
    'p1c-e1-a', 'p1c-e1-b',
    'p2-e1',
    'p3-e1', 'p3-e2', 'p3-e3',
    'p4-e1-src', 'p4-e1-dst',
    'p4-e2-src', 'p4-e2-dst',
    'cross-c1-dev', 'cross-c1-cre',
    'cross-c2-a', 'cross-c2-b',
];

function seedWorkspacesJson(home: string): void {
    // Explicit 'surreal': every access in this suite goes through the
    // engine-aware getGraphHandle() (the same accessor the recall
    // workspace:"*" fan-out uses), so writes and verification read the
    // SAME engine the workspace declares.
    const entries = TEST_IDS.map((name) => {
        const wsPath = path.join(home, 'workspaces', name);
        fs.mkdirSync(path.join(wsPath, '.lore'), { recursive: true });
        return { name, path: wsPath, createdAt: '2026-05-21T00:00:00.000Z', graphEngine: 'surreal' as const };
    });
    fs.writeFileSync(path.join(home, 'workspaces.json'), JSON.stringify({
        active: entries[0]!.name,
        workspaces: entries,
    }, null, 2));
}
seedWorkspacesJson(TEST_HOME!);

const { LocalGraphRegistry } = await import('../packages/lore/src/engines/localGraphRegistry.js');
const { WorkspaceGraph } = await import('../packages/lore/src/engines/openWorkspaceGraph.js');

const { VerbatimStore } = await import('../packages/lore/src/engines/verbatimStore.js');
const tokensMod = await import('../packages/lore/src/auth/tokens.js');
const principalMod = await import('../packages/lore/src/auth/principal.js');
const { registerMemoryTools } = await import('../packages/lore/src/mcp/tools/memory.js');
const { registerSearchTools } = await import('../packages/lore/src/mcp/tools/search.js');
const { tryNodesRoutes } = await import('../packages/lore/src/mcp/http/routes/nodes.js');
const { trySearchRoutes } = await import('../packages/lore/src/mcp/http/routes/search.js');
const { migrateWorkspaceToWorkspace } = await import('../packages/lore/src/cli/commands/migrateWorkspaceToWorkspace.js');
const { setWorkspaceVocabPolicy } = await import('../packages/lore/src/config/workspaces.js');
const { z } = await import('zod');
const { InMemoryPendingOpsStore } = await import('../packages/lore/src/security/inMemoryPendingOpsStore.js');
const { runHttpGates } = await import('../packages/lore/src/mcp/http/middleware.js');
const { RateLimiter } = await import('../packages/lore/src/security/rateLimit.js');

/* ─── Mock req/res shared utilities ────────────────────────────── */

class MockRequest extends EventEmitter {
    public method = 'POST';
    public url = '/api/node';
    public headers: Record<string, string> = {};
    constructor(public bodyJson: object, opts?: { headers?: Record<string, string>; method?: string; url?: string }) {
        super();
        if (opts?.headers) this.headers = opts.headers;
        if (opts?.method) this.method = opts.method;
        if (opts?.url) this.url = opts.url;
        setImmediate(() => {
            this.emit('data', Buffer.from(JSON.stringify(bodyJson)));
            this.emit('end');
        });
    }
}

interface MockResponse {
    statusCode: number;
    headers: Record<string, string>;
    body: string;
    headersSent: boolean;
    writeHead(code: number, h?: Record<string, string>): void;
    setHeader(k: string, v: string): void;
    end(chunk?: string): void;
}

function mockResponse(): MockResponse {
    return {
        statusCode: 0,
        headers: {},
        body: '',
        headersSent: false,
        writeHead(code, h = {}) { this.statusCode = code; this.headers = { ...this.headers, ...h }; this.headersSent = true; },
        setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
        end(chunk) { this.body = chunk ? String(chunk) : ''; },
    };
}

function nodesDeps(registry: InstanceType<typeof LocalGraphRegistry>): unknown {
    return {
        store: {
            loreGraph: registry instanceof LocalGraphRegistry ? undefined : undefined,
            loreVerbatim: { store: async () => undefined } as never,
        },
        auditLog: { log: () => undefined },
        deploymentMode: 'local',
        dataplane: null,
        graphRegistry: registry,
        coreNodeTypes: ['decision', 'note'],
        pluginRegistry: { activeNames: () => [], isActive: () => false, active: () => [], registerTools: () => undefined },
        pendingOpsStore: new InMemoryPendingOpsStore(),
    };
}

function searchDeps(registry: InstanceType<typeof LocalGraphRegistry>, graphForLegacy: WorkspaceGraph): unknown {
    return {
        store: {
            loreGraph: graphForLegacy,
            loreVerbatim: { count: async () => 0, search: async () => [] } as never,
        },
        detectedScope: { workspace: 'dev', ecosystem: 'default' },
        deploymentMode: 'local',
        dataplane: null,
        graphRegistry: registry,
    };
}

/* ─── P1.B-E1: concurrent first-open returns the same instance ──── */

async function testP1BE1_concurrentOpenDedupes(): Promise<void> {
    const reg = new LocalGraphRegistry();
    const [a, b, c] = await Promise.all([
        reg.getGraphHandle('p1b-e1'),
        reg.getGraphHandle('p1b-e1'),
        reg.getGraphHandle('p1b-e1'),
    ]);
    assert.equal(a, b, 'first concurrent call shares instance');
    assert.equal(b, c, 'second concurrent call shares instance');
    assert.equal(reg.openedNames().length, 1, 'only one cache entry materialized');
    console.log('  ✓ P1B-E1: concurrent getGraphHandle dedupes to a single instance');
}

/* ─── P1.B-E2: workspaces.json mtime change invalidates cache ──── */

async function testP1BE2_mtimeInvalidation(): Promise<void> {
    const reg = new LocalGraphRegistry();
    const before = await reg.getGraphHandle('p1b-e2');
    assert.ok(before, 'first open succeeds');

    // Rewrite the workspaces.json to point this workspace at a NEW
    // physical dir. The registry's mtime watcher should drop the stale
    // cache entry on next getOrOpen and re-open against the new path.
    const wsFile = path.join(TEST_HOME!, 'workspaces.json');
    const json = JSON.parse(fs.readFileSync(wsFile, 'utf8')) as {
        active: string;
        workspaces: Array<{ name: string; path: string; createdAt: string }>;
    };
    const newPath = path.join(TEST_HOME!, 'workspaces', 'p1b-e2-moved');
    fs.mkdirSync(path.join(newPath, '.lore'), { recursive: true });
    for (const w of json.workspaces) if (w.name === 'p1b-e2') w.path = newPath;
    // Ensure the next stat() sees a newer mtime even on filesystems
    // with second-resolution mtime (waiting 1.1s is too slow for the
    // test budget — bump utimes by hand).
    await new Promise((r) => setTimeout(r, 50));
    fs.writeFileSync(wsFile, JSON.stringify(json, null, 2));
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(wsFile, future, future);

    const after = await reg.getGraphHandle('p1b-e2');
    assert.notEqual(after, before, 'mtime-bumped path mismatch → new graph instance');
    console.log('  ✓ P1B-E2: workspaces.json mtime change invalidates registry cache');
}

/* ─── P1.C-E1: cross-workspace same-id dedupe ──────────────────── */

async function testP1CE1_crossWorkspaceSameIdDedupe(): Promise<void> {
    const reg = new LocalGraphRegistry();
    const gA = await reg.getGraphHandle('p1c-e1-a');
    const gB = await reg.getGraphHandle('p1c-e1-b');
    // Same logical id in both workspaces — the recall aggregator
    // should emit ONE row (highest-scoring source wins).
    const dup = (g: WorkspaceGraph, ws: string) =>
        g.upsertNode({
            id: 'dup-id-shared', type: 'note', label: `${ws} copy`,
            content: 'auth', tags: 'auth', project: ws, ecosystem: 'default',
            metadata: '{}', language: null, ephemeral: false, ttl_ms: null,
        });
    await dup(gA, 'p1c-e1-a');
    await dup(gB, 'p1c-e1-b');

    // Build a tool stub the same way phase6-p1c tests do.
    const tools: Record<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>> = {};
    const mcpServerStub = {
        tool: (name: string, ..._rest: unknown[]) => {
            const handler = _rest[_rest.length - 1];
            if (typeof handler === 'function') tools[name] = handler as never;
        },
    };
    const fakeVerbatim = {
        rows: [{ id: 'lore:dup-id-shared', text: 'auth', score: 0.9 }],
        async count() { return 1; },
        async search() { return this.rows; },
        async bm25Search() { return this.rows; },
        async store() {},
        async delete() {},
    };
    registerSearchTools(mcpServerStub as never, {
        store: { loreGraph: gA, loreVerbatim: fakeVerbatim as never, sessionCache: { pushNode: () => undefined } as never } as never,
        detectedScope: { workspace: 'p1c-e1-a', ecosystem: 'default' },
        graphRegistry: reg,
    });
    const out = await tools['recall']!({ topic: 'auth', workspace: '*' });
    const body = JSON.parse(out.content[0]!.text);
    const dupHits = (body.hits as Array<{ id: string; workspace: string }>).filter((h) => h.id === 'dup-id-shared');
    assert.equal(dupHits.length, 1, `same id across workspaces must dedupe to 1, got ${dupHits.length}`);
    assert.ok(['p1c-e1-a', 'p1c-e1-b'].includes(dupHits[0]!.workspace), 'dedupe row tagged with a real workspace name');
    console.log('  ✓ P1C-E1: workspace:"*" dedupes same-id across workspaces to one row');
}

/* ─── P2-E1: denylist mode rejects in-list, accepts everything else ─ */

async function testP2E1_denylistMode(): Promise<void> {
    setWorkspaceVocabPolicy('p2-e1', { mode: 'denylist', types: ['note'], onMismatch: 'reject' });

    // Tool stub
    const reg = new LocalGraphRegistry();
    const graph = await reg.getGraphHandle('p2-e1');
    const tools: Record<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>> = {};
    const mcpServerStub = { tool: (name: string, ..._rest: unknown[]) => {
        const handler = _rest[_rest.length - 1];
        if (typeof handler === 'function') tools[name] = handler as never;
    }};
    registerMemoryTools(mcpServerStub as never, {
        store: { loreGraph: graph, loreVerbatim: { store: async () => undefined } as never, sessionCache: { pushNode: () => undefined } as never } as never,
        pluginRegistry: { active: () => [], activeNames: () => [], isActive: () => false, registerTools: () => undefined } as never,
        configManager: { read: () => ({ pluginConfig: { developer: { autoLinkOnIngest: false } } }) } as never,
        auditLog: { log: () => undefined } as never,
        detectedScope: { workspace: 'p2-e1', ecosystem: 'default' },
        getWal: () => ({ append: () => undefined } as never),
        domain: 'lore', edgeRelations: [],
        nodeTypesEnum: z.enum(['decision', 'note']),
        nodeTypesDescription: 'decision|note',
        edgeRelationsEnum: z.enum(['related_to']),
        graphRegistry: reg,
        coreNodeTypes: ['decision', 'note', 'convention'],
    });
    // 'note' is in the denylist → reject.
    const blocked = await tools['store_node']!({ id: 'p2-e1-block', type: 'note', label: 'denied', workspace: 'p2-e1' });
    assert.equal(blocked.isError, true);
    const bblock = JSON.parse(blocked.content[0]!.text);
    assert.equal(bblock.error, 'type_not_allowed', `denylist hit should reject; got ${blocked.content[0]!.text}`);

    // 'decision' is NOT in the denylist → accepted.
    const ok = await tools['store_node']!({ id: 'p2-e1-ok', type: 'decision', label: 'allowed', workspace: 'p2-e1' });
    assert.equal(ok.isError, undefined, `non-denied type should pass; got ${ok.content[0]?.text}`);
    console.log('  ✓ P2-E1: denylist mode rejects in-list types, accepts everything else');
}

/* ─── P2-E2: multiple unknown fields surface together ──────────── */

async function testP2E2_multipleUnknownFields(): Promise<void> {
    const reg = new LocalGraphRegistry();
    const graph = await reg.getGraphHandle('p2-e1'); // reuse — no writes
    const tools: Record<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>> = {};
    const mcpServerStub = { tool: (name: string, ..._rest: unknown[]) => {
        const handler = _rest[_rest.length - 1];
        if (typeof handler === 'function') tools[name] = handler as never;
    }};
    registerMemoryTools(mcpServerStub as never, {
        store: { loreGraph: graph, loreVerbatim: { store: async () => undefined } as never, sessionCache: { pushNode: () => undefined } as never } as never,
        pluginRegistry: { active: () => [], activeNames: () => [], isActive: () => false, registerTools: () => undefined } as never,
        configManager: { read: () => ({ pluginConfig: { developer: { autoLinkOnIngest: false } } }) } as never,
        auditLog: { log: () => undefined } as never,
        detectedScope: { workspace: 'p2-e1', ecosystem: 'default' },
        getWal: () => ({ append: () => undefined } as never),
        domain: 'lore', edgeRelations: [],
        nodeTypesEnum: z.enum(['decision', 'note']),
        nodeTypesDescription: 'decision|note',
        edgeRelationsEnum: z.enum(['related_to']),
        graphRegistry: reg,
        coreNodeTypes: ['decision', 'note'],
    });
    const out = await tools['store_node']!({
        id: 'multi-x', type: 'decision', label: 'multi',
        project: 'x', xyz: 1, frobnicate: 'q',
    });
    assert.equal(out.isError, true);
    const body = JSON.parse(out.content[0]!.text);
    assert.equal(body.error, 'unknown_field');
    assert.deepEqual([...body.rejected].sort(), ['frobnicate', 'project', 'xyz'].sort(), `expected all three fields surfaced together; got ${JSON.stringify(body.rejected)}`);
    // The hint targets the FIRST rejected field (project → workspace alias).
    assert.equal(body.hint, 'workspace', `first-field hint: project → workspace`);
    console.log('  ✓ P2-E2: multiple unknown fields surface together with first-field hint');
}

/* ─── P3-E1: missing Bearer → 401 ───────────────────────────────── */
//
// runHttpGates wraps the validator; we call it directly with a mock
// request that omits the Authorization header. /api/node requires Bearer
// per httpAuth.PUBLIC_API_PATHS allowlist.

async function testP3E1_missingBearer401(): Promise<void> {
    const req = new MockRequest({}, {
        method: 'POST', url: '/api/node',
        headers: { host: '127.0.0.1:3897' },
    });
    const res = mockResponse();
    const gate = await runHttpGates(req as never, res as never, {
        port: 3897,
        dataHome: '/tmp/phase6-coverage-unused',
        getAuthToken: () => 'a'.repeat(64),
        getSharedSecret: () => undefined,
        rateLimiter: new RateLimiter(),
        deploymentMode: 'local',
        pluginRegistry: { getOrphanState: () => ({ blocking: false, orphans: [] }) } as never,
        getBootstrapWorkspace: () => 'p3-e1',
    });
    assert.equal(gate.handled, true, 'gate must short-circuit');
    assert.equal(res.statusCode, 401, `missing Bearer → 401, got ${res.statusCode}`);
    console.log('  ✓ P3-E1: missing Bearer → 401 auth required');
}

/* ─── P3-E2: malformed Bearer → 401 ─────────────────────────────── */

async function testP3E2_malformedBearer401(): Promise<void> {
    const req = new MockRequest({}, {
        method: 'POST', url: '/api/node',
        headers: { host: '127.0.0.1:3897', authorization: 'Bearer lore_dev_TOO_SHORT' },
    });
    const res = mockResponse();
    const gate = await runHttpGates(req as never, res as never, {
        port: 3897,
        dataHome: '/tmp/phase6-coverage-unused',
        getAuthToken: () => 'a'.repeat(64),
        getSharedSecret: () => undefined,
        rateLimiter: new RateLimiter(),
        deploymentMode: 'local',
        pluginRegistry: { getOrphanState: () => ({ blocking: false, orphans: [] }) } as never,
        getBootstrapWorkspace: () => 'p3-e2',
    });
    assert.equal(gate.handled, true);
    assert.equal(res.statusCode, 401, `malformed Bearer → 401, got ${res.statusCode}`);
    console.log('  ✓ P3-E2: malformed Bearer (lore_dev_TOO_SHORT) → 401');
}

/* ─── P3-E3: well-formed but unregistered app token → 401 ───────── */

async function testP3E3_unregisteredAppToken401(): Promise<void> {
    // A syntactically valid lore_<ws>_<43-base64url> token that's
    // NOT in the registry. validateRequest accepts the shape;
    // middleware should reject the unregistered token at the
    // principal-resolution step.
    const fakeToken = 'lore_dev_' + 'A'.repeat(43);
    const req = new MockRequest({}, {
        method: 'POST', url: '/api/node',
        headers: { host: '127.0.0.1:3897', authorization: `Bearer ${fakeToken}` },
    });
    const res = mockResponse();
    const gate = await runHttpGates(req as never, res as never, {
        port: 3897,
        dataHome: '/tmp/phase6-coverage-unused',
        getAuthToken: () => 'a'.repeat(64),
        getSharedSecret: () => undefined,
        rateLimiter: new RateLimiter(),
        deploymentMode: 'local',
        pluginRegistry: { getOrphanState: () => ({ blocking: false, orphans: [] }) } as never,
        getBootstrapWorkspace: () => 'p3-e3',
    });
    assert.equal(gate.handled, true, 'gate must short-circuit on unregistered token');
    assert.equal(res.statusCode, 401, `unregistered app token → 401, got ${res.statusCode}`);
    console.log('  ✓ P3-E3: well-formed but unregistered app token → 401');
}

/* ─── P4-E1: --on-conflict=skip ─────────────────────────────────── */

async function testP4E1_onConflictSkip(): Promise<void> {
    const reg = new LocalGraphRegistry();
    const src = await reg.getGraphHandle('p4-e1-src');
    const dst = await reg.getGraphHandle('p4-e1-dst');
    // Seed 5 decisions in source.
    for (let i = 0; i < 5; i++) {
        await src.upsertNode({
            id: `p4e1-${i}`, type: 'decision', label: `D${i}`,
            content: '', tags: '', project: 'p4-e1-src', ecosystem: 'default',
            metadata: '{}', language: null, ephemeral: false, ttl_ms: null,
        });
    }
    // Pre-seed 2 of the same ids in dst (different label) — those should be SKIPPED.
    for (let i = 0; i < 2; i++) {
        await dst.upsertNode({
            id: `p4e1-${i}`, type: 'decision', label: `pre-existing D${i}`,
            content: '', tags: '', project: 'p4-e1-dst', ecosystem: 'default',
            metadata: '{}', language: null, ephemeral: false, ttl_ms: null,
        });
    }
    const report = await migrateWorkspaceToWorkspace({
        from: 'p4-e1-src', to: 'p4-e1-dst',
        filterTypes: ['decision'],
        apply: true, force: true, onConflict: 'skip',
        injected: { srcGraph: src, dstGraph: dst },
    });
    assert.equal(report.candidates, 5);
    assert.equal(report.skipped, 2, `skipped 2 conflicting ids, got ${report.skipped}`);
    assert.equal(report.upserted, 3, `upserted 3 non-conflicting ids, got ${report.upserted}`);

    // The pre-existing labels must be intact in dst (skip = leave alone).
    const preExist = await dst.getNode('p4e1-0');
    assert.equal(preExist?.label, 'pre-existing D0', `skip MUST NOT overwrite the existing row`);
    console.log('  ✓ P4-E1: --on-conflict=skip skips collisions + preserves dest rows');
}

/* ─── P4-E2: --filter-tag matches values inside comma-list ──────── */

async function testP4E2_filterTagMatchesValue(): Promise<void> {
    const reg = new LocalGraphRegistry();
    const src = await reg.getGraphHandle('p4-e2-src');
    const dst = await reg.getGraphHandle('p4-e2-dst');
    await src.upsertNode({
        id: 'p4e2-yes', type: 'decision', label: 'tagged',
        content: '', tags: 'auth,security,urgent',
        project: 'p4-e2-src', ecosystem: 'default',
        metadata: '{}', language: null, ephemeral: false, ttl_ms: null,
    });
    await src.upsertNode({
        id: 'p4e2-no', type: 'decision', label: 'untagged',
        content: '', tags: 'misc,info',
        project: 'p4-e2-src', ecosystem: 'default',
        metadata: '{}', language: null, ephemeral: false, ttl_ms: null,
    });
    const report = await migrateWorkspaceToWorkspace({
        from: 'p4-e2-src', to: 'p4-e2-dst',
        filterTypes: ['decision'],
        filterTag: { key: '', value: 'urgent' },
        apply: true, force: true, onConflict: 'fail',
        injected: { srcGraph: src, dstGraph: dst },
    });
    assert.equal(report.candidates, 1, `only the urgent-tagged node moves`);
    assert.equal(report.upserted, 1);
    assert.ok(await dst.getNode('p4e2-yes'));
    assert.equal(await dst.getNode('p4e2-no'), null, 'non-matching tag stays in source');
    console.log('  ✓ P4-E2: --filter-tag value matches comma-list membership');
}

/* ─── P4-E3: unknown source workspace → clear error ─────────────── */

async function testP4E3_unknownSourceWorkspace(): Promise<void> {
    let thrown: unknown = null;
    try {
        await migrateWorkspaceToWorkspace({
            from: 'no-such-workspace', to: 'p4-e1-dst',
            apply: false, force: true, onConflict: 'fail',
        });
    } catch (err) {
        thrown = err;
    }
    assert.ok(thrown, 'unknown source must throw');
    assert.ok(/workspace_not_found|no-such-workspace/.test((thrown as Error).message), `error message names the missing workspace: ${(thrown as Error).message}`);
    console.log('  ✓ P4-E3: unknown source workspace → clear workspace_not_found');
}

/* ─── CROSS-C1: auth gate fires BEFORE vocab gate ───────────────── */
//
// Token bound to dev tries to write into cre (where vocabPolicy is
// 'reject'). Both gates would fire, but token-scope is the first one
// checked at the route layer; we should see workspace_forbidden and
// the vocab policy is never consulted.

async function testCrossC1_authBeforeVocab(): Promise<void> {
    setWorkspaceVocabPolicy('cross-c1-cre', { mode: 'allowlist', types: ['decision'], onMismatch: 'reject' });
    tokensMod._resetForTests();
    const tok = tokensMod.issueToken({ workspace: 'cross-c1-dev', label: 'dev-only', scopes: ['read', 'write'] });
    const reg = new LocalGraphRegistry();
    await reg.getGraphHandle('cross-c1-dev');
    await reg.getGraphHandle('cross-c1-cre');

    const principal = {
        kind: 'app' as const,
        workspace: 'cross-c1-dev',
        scopes: ['read', 'write'] as const,
        label: tok.record.prefix,
    };
    const res = await principalMod.runWithPrincipal(principal as never, async () => {
        const req = new MockRequest({
            id: 'crossc1-attack', type: 'note', label: 'forbidden cross-write', workspace: 'cross-c1-cre',
        });
        const r = mockResponse();
        await tryNodesRoutes(req as never, r as never, '/api/node', '/api/node', nodesDeps(reg) as never);
        return r;
    });
    assert.equal(res.statusCode, 403, `auth gate should reject before vocab; got ${res.statusCode} ${res.body}`);
    const body = JSON.parse(res.body);
    // Wave 5 canonical {code, message} envelope (was {error, reason}).
    assert.equal(body.code, 'workspace_forbidden', `auth-level error wins, vocab is never consulted: ${res.body}`);
    console.log('  ✓ CROSS-C1: token workspace gate fires BEFORE vocab policy (correct order)');
}

/* ─── CROSS-C2: cross-workspace-read token + workspace="*" works ── */

async function testCrossC2_crossReadAggregatesAllWorkspaces(): Promise<void> {
    tokensMod._resetForTests();
    const tok = tokensMod.issueToken({
        workspace: 'cross-c2-a',
        label: 'aggregator',
        scopes: ['read', 'cross-workspace-read'],
    });
    const reg = new LocalGraphRegistry();
    const gA = await reg.getGraphHandle('cross-c2-a');
    const gB = await reg.getGraphHandle('cross-c2-b');
    await gA.upsertNode({ id: 'cc2-a-hit', type: 'note', label: 'A', content: 'topic A',
        tags: ['t'], project: 'cross-c2-a', ecosystem: 'default', metadata: '{}',
        language: null, ephemeral: false, ttl_ms: null });
    await gB.upsertNode({ id: 'cc2-b-hit', type: 'note', label: 'B', content: 'topic B',
        tags: ['t'], project: 'cross-c2-b', ecosystem: 'default', metadata: '{}',
        language: null, ephemeral: false, ttl_ms: null });

    const principal = {
        kind: 'app' as const,
        workspace: 'cross-c2-a',
        scopes: ['read', 'cross-workspace-read'] as const,
        label: tok.record.prefix,
    };
    const res = await principalMod.runWithPrincipal(principal as never, async () => {
        const req = new MockRequest({}, { method: 'GET', url: '/api/recall?topic=topic&workspace=*' });
        const r = mockResponse();
        await trySearchRoutes(req as never, r as never, '/api/recall?topic=topic&workspace=*', '/api/recall', searchDeps(reg, gA) as never);
        return r;
    });
    assert.equal(res.statusCode, 200, `cross-read principal allowed; got ${res.statusCode} ${res.body}`);
    const body = JSON.parse(res.body);
    assert.equal(body.crossWorkspace, true);
    // Pre-existing drift, unrelated to the engine-default flip: the response
    // field is `hits` (see recallCrossWorkspace.ts), not `results` — this
    // test was never updated when that shape landed.
    const ids = (body.hits as Array<{ id: string; workspace: string }>).map((h) => h.id);
    assert.ok(ids.includes('cc2-a-hit'), 'A workspace contributes');
    assert.ok(ids.includes('cc2-b-hit'), 'B workspace contributes');
    console.log('  ✓ CROSS-C2: cross-workspace-read scope + workspace="*" aggregates from all');
}

/* ─── Runner (subprocess-per-test for engine-state isolation) ─────── */

type TestFn = () => Promise<void>;
const TESTS: Record<string, TestFn> = {
    'p1b-e1': testP1BE1_concurrentOpenDedupes,
    'p1b-e2': testP1BE2_mtimeInvalidation,
    'p1c-e1': testP1CE1_crossWorkspaceSameIdDedupe,
    'p2-e1': testP2E1_denylistMode,
    'p2-e2': testP2E2_multipleUnknownFields,
    'p3-e1': testP3E1_missingBearer401,
    'p3-e2': testP3E2_malformedBearer401,
    'p3-e3': testP3E3_unregisteredAppToken401,
    'p4-e1': testP4E1_onConflictSkip,
    'p4-e2': testP4E2_filterTagMatchesValue,
    'p4-e3': testP4E3_unknownSourceWorkspace,
    'cross-c1': testCrossC1_authBeforeVocab,
    'cross-c2': testCrossC2_crossReadAggregatesAllWorkspaces,
};

async function runOneTestInProcess(name: string): Promise<void> {
    const fn = TESTS[name];
    if (!fn) { console.error(`unknown test: ${name}`); process.exit(2); }
    await fn();
    // Hard-exit to dodge the legacy engine teardown segfaults.
    process.exit(0);
}

async function runAllTestsInChildren(): Promise<void> {
    console.log('phase6-comprehensive-coverage.ts');
    const selfPath = fileURLToPath(import.meta.url);
    const tsxBin = path.join(
        path.dirname(path.dirname(selfPath)),
        'node_modules', '.bin', 'tsx',
    );
    let pass = 0;
    let fail = 0;
    for (const name of Object.keys(TESTS)) {
        // Each child gets its OWN LORE_HOME with the same workspaces.json
        // pre-seeded so per-test the legacy graph engine state is isolated.
        const childHome = fs.mkdtempSync(path.join(TEST_HOME!, `${name}-home-`));
        seedWorkspacesJson(childHome);
        const result = spawnSync(tsxBin, [selfPath, '--child', name], {
            env: { ...process.env, LORE_HOME: childHome, LORE_PHASE6_CHILD: '1' },
            stdio: ['inherit', 'inherit', 'inherit'],
        });
        if (result.status === 0) pass += 1;
        else { fail += 1; console.error(`  ✗ ${name} exited ${result.status}`); }
    }
    console.log('');
    console.log(`Comprehensive coverage: ${pass}/${pass + fail} passed.`);
    if (fail > 0) process.exit(1);
}

if (process.env['LORE_PHASE6_CHILD'] === '1') {
    const arg = process.argv[process.argv.indexOf('--child') + 1];
    await runOneTestInProcess(arg);
} else {
    await runAllTestsInChildren();
}
