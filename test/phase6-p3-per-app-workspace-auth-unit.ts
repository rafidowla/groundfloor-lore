/**
 * test/phase6-p3-per-app-workspace-auth-unit.ts
 *
 * Phase 6 P3 — per-app workspace-scoped auth tokens.
 *
 * Coverage (spec T1–T5):
 *   T1: Issue token A→workspace dev, token B→workspace acme. Two
 *       concurrent POST /api/node requests under principal A and
 *       principal B land in two different physical LocalGraph stores.
 *   T2: Principal A (bound to dev) writes to workspace acme via the
 *       body's `workspace:` field → 403 workspace_forbidden.
 *   T3: Token with `cross-workspace-read` reads workspace acme when
 *       it's bound to dev. Same token shape without that scope is
 *       gated 403 against `workspace=acme` AND against `workspace=*`.
 *   T4: Revoke a token → next lookup returns null (any in-flight
 *       middleware resolve returns null → 401 at the gauntlet).
 *   T5: `lore auth list` shows label, workspace, scopes, lastUsed.
 *
 * The tests exercise tokens.ts + auth/principal.ts + the POST /api/node
 * route handler directly via the same mock req/res pattern used by
 * P1.B / P1.C / P2. Full daemon spin-up is out of scope; the gates
 * fire entirely in the route layer once the principal is bound.
 *
 * Run:
 *   LORE_HOME=$(mktemp -d) npx tsx test/phase6-p3-per-app-workspace-auth-unit.ts
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';

const TEST_HOME = process.env['LORE_HOME'];
if (!TEST_HOME || TEST_HOME === path.join(process.env['HOME'] ?? '', '.groundfloor')) {
    console.error(
        'ERROR: LORE_HOME must be set to a fresh temp dir before running this test.\n' +
            'Use: LORE_HOME=$(mktemp -d) npx tsx test/phase6-p3-per-app-workspace-auth-unit.ts',
    );
    process.exit(2);
}

function seedWorkspacesJson(home: string, active: string, names: string[]): void {
    // Explicit 'surreal': the route handlers resolve target workspaces via
    // the engine-aware getGraphHandle(), and these tests seed/verify through
    // the same accessor — one engine (SurrealDB) on both sides.
    const workspaces = names.map((name) => ({
        name,
        path: path.join(home, 'workspaces', name),
        createdAt: '2026-05-21T00:00:00.000Z',
        graphEngine: 'surreal' as const,
    }));
    fs.mkdirSync(home, { recursive: true });
    for (const w of workspaces) {
        fs.mkdirSync(path.join(w.path, '.lore'), { recursive: true });
    }
    fs.writeFileSync(
        path.join(home, 'workspaces.json'),
        JSON.stringify({ active, workspaces }, null, 2),
    );
}

seedWorkspacesJson(TEST_HOME, 'dev', ['dev', 'acme']);

const tokens = await import('../packages/lore/src/auth/tokens.js');
const principal = await import('../packages/lore/src/auth/principal.js');
const { LocalGraphRegistry } = await import('../packages/lore/src/engines/localGraphRegistry.js');
const { tryNodesRoutes } = await import('../packages/lore/src/mcp/http/routes/nodes.js');
const { trySearchRoutes } = await import('../packages/lore/src/mcp/http/routes/search.js');

tokens._resetForTests();

// ── Mock HTTP request/response shells ─────────────────────────────────────

class MockRequest extends EventEmitter {
    public method = 'POST';
    public url = '/api/node';
    public headers: Record<string, string> = {};
    constructor(public bodyJson: object) {
        super();
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
    writeHead(code: number, h?: Record<string, string>): void;
    end(chunk?: string): void;
}

function mockResponse(): MockResponse {
    return {
        statusCode: 200,
        headers: {},
        body: '',
        writeHead(code, h = {}) { this.statusCode = code; this.headers = h; },
        end(chunk) { this.body = chunk ? String(chunk) : ''; },
    };
}

// Shared registry across the run; opening a workspace twice would
// contend on the surrealkv directory lock.
const registry = new LocalGraphRegistry();
const graphDev = await registry.getGraphHandle('dev');
const graphAcme = await registry.getGraphHandle('acme');

function nodesDeps(): unknown {
    return {
        store: {
            loreGraph: graphDev,
            loreVerbatim: { store: async () => undefined } as never,
            // Writes go through the LoreStorageClient facade (storageClient.verbatimStore),
            // not loreVerbatim.store directly — provide the delegator.
            storageClient: { verbatimStore: async () => undefined } as never,
        },
        auditLog: { log: () => undefined },
        deploymentMode: 'local',
        dataplane: null,
        graphRegistry: registry,
        coreNodeTypes: ['decision', 'note'],
    };
}

function searchDeps(): unknown {
    return {
        store: {
            loreGraph: graphDev,
            loreVerbatim: { count: async () => 0, search: async () => [] } as never,
            // Recall reads corpus stats through the facade — provide the delegators.
            storageClient: { verbatimCount: async () => 0, verbatimSearch: async () => [] } as never,
        },
        detectedScope: { workspace: 'dev', ecosystem: 'default' },
        deploymentMode: 'local',
        dataplane: null,
        graphRegistry: registry,
    };
}

// ── T1: dual-token concurrent writes land in different physical stores ────

async function testT1_dualTokenConcurrentWrites(): Promise<void> {
    const tokenA = tokens.issueToken({ workspace: 'dev', label: 'Claude Code', scopes: ['read', 'write'] });
    const tokenB = tokens.issueToken({ workspace: 'acme', label: 'domain plugin app', scopes: ['read', 'write'] });

    const principalA = {
        kind: 'app' as const,
        workspace: 'dev',
        scopes: ['read', 'write'] as const,
        label: tokenA.record.prefix,
    };
    const principalB = {
        kind: 'app' as const,
        workspace: 'acme',
        scopes: ['read', 'write'] as const,
        label: tokenB.record.prefix,
    };

    async function runWrite(p: typeof principalA, id: string, ws: string) {
        return await principal.runWithPrincipal(p as never, async () => {
            // `content` is included: SurrealGraph's default (non-FTS) search
            // path crashes on string::lowercase() over a NONE content field
            // (route-written content-less nodes store NONE), which would 500
            // T3's recalls for a reason unrelated to auth. Reported as a
            // SurrealGraph gap; this test exercises token scoping, not that.
            const req = new MockRequest({ id, type: 'decision', label: `T1 ${id}`, content: `T1 ${id} body`, workspace: ws });
            const res = mockResponse();
            await tryNodesRoutes(req as never, res as never, '/api/node', '/api/node', nodesDeps() as never);
            return res;
        });
    }

    const [resA, resB] = await Promise.all([
        runWrite(principalA, 'p3-t1-A', 'dev'),
        runWrite(principalB, 'p3-t1-B', 'acme'),
    ]);
    // First-create returns 201 (NW-7f); these were stale 200 expectations.
    assert.equal(resA.statusCode, 201, `A: got ${resA.statusCode} body=${resA.body}`);
    assert.equal(resB.statusCode, 201, `B: got ${resB.statusCode} body=${resB.body}`);

    const inDev = await graphDev.getNode('p3-t1-A');
    const inAcme = await graphAcme.getNode('p3-t1-B');
    const devLeak = await graphDev.getNode('p3-t1-B');
    const acmeLeak = await graphAcme.getNode('p3-t1-A');
    assert.ok(inDev, 'A landed in dev');
    assert.ok(inAcme, 'B landed in acme');
    assert.equal(devLeak, null, 'B did not leak into dev');
    assert.equal(acmeLeak, null, 'A did not leak into acme');
    console.log('  ✓ T1: two simultaneous tokens write to their physical stores');
}

// ── T2: cross-workspace write without scope → 403 ─────────────────────────

async function testT2_crossWorkspaceWriteForbidden(): Promise<void> {
    const tokenA = tokens.issueToken({ workspace: 'dev', label: 'A', scopes: ['read', 'write'] });
    const principalA = {
        kind: 'app' as const,
        workspace: 'dev',
        scopes: ['read', 'write'] as const,
        label: tokenA.record.prefix,
    };
    const res = await principal.runWithPrincipal(principalA as never, async () => {
        const req = new MockRequest({ id: 'p3-t2', type: 'decision', label: 'cross-write probe', workspace: 'acme' });
        const r = mockResponse();
        await tryNodesRoutes(req as never, r as never, '/api/node', '/api/node', nodesDeps() as never);
        return r;
    });
    assert.equal(res.statusCode, 403, `expected 403, got ${res.statusCode} body=${res.body}`);
    const body = JSON.parse(res.body);
    // Wave 5 canonical {code, message} envelope (was {error, reason}); the
    // human reason string is now folded into message.
    assert.equal(body.code, 'workspace_forbidden');
    assert.ok(/cross-workspace-write/.test(body.message), `message names missing scope: ${body.message}`);
    // And confirm no write happened in acme.
    assert.equal(await graphAcme.getNode('p3-t2'), null, 'forbidden write MUST NOT land in acme');
    console.log('  ✓ T2: cross-workspace write rejected with 403 workspace_forbidden');
}

// ── T3: cross-workspace read scope gating ─────────────────────────────────

async function testT3_crossWorkspaceReadScope(): Promise<void> {
    // Token without cross-workspace-read.
    const a = tokens.issueToken({ workspace: 'dev', label: 'no cross-read', scopes: ['read', 'write'] });
    const pNoCross = {
        kind: 'app' as const,
        workspace: 'dev',
        scopes: ['read', 'write'] as const,
        label: a.record.prefix,
    };
    // Token with cross-workspace-read.
    const b = tokens.issueToken({ workspace: 'dev', label: 'cross-read', scopes: ['read', 'cross-workspace-read'] });
    const pCross = {
        kind: 'app' as const,
        workspace: 'dev',
        scopes: ['read', 'cross-workspace-read'] as const,
        label: b.record.prefix,
    };

    async function recall(p: typeof pNoCross, workspace?: string) {
        return await principal.runWithPrincipal(p as never, async () => {
            const url = workspace ? `/api/recall?topic=anything&workspace=${encodeURIComponent(workspace)}` : '/api/recall?topic=anything';
            const req = new MockRequest({});
            (req as { method: string }).method = 'GET';
            const r = mockResponse();
            await trySearchRoutes(req as never, r as never, url, '/api/recall', searchDeps() as never);
            return r;
        });
    }

    // Sprint L1d — workspace is required on every read. Tests now
    // pass the principal's own workspace explicitly (`dev`) rather
    // than relying on the principal-implicit fallback that L1d
    // removed.

    // Without cross-workspace-read: own-workspace request → 200; other → 403; "*" → 403.
    const own = await recall(pNoCross, 'dev');
    assert.equal(own.statusCode, 200, `own-workspace recall should pass: ${own.body}`);
    const otherForbidden = await recall(pNoCross, 'acme');
    assert.equal(otherForbidden.statusCode, 403, `other-workspace recall should be forbidden: ${otherForbidden.statusCode} ${otherForbidden.body}`);
    const allForbidden = await recall(pNoCross, '*');
    assert.equal(allForbidden.statusCode, 403, `workspace=* without cross-read should be forbidden`);

    // With cross-workspace-read: every variant passes the gate.
    const ownC = await recall(pCross, 'dev');
    assert.equal(ownC.statusCode, 200);
    const otherC = await recall(pCross, 'acme');
    assert.equal(otherC.statusCode, 200, `cross-read should allow acme: ${otherC.body}`);
    const allC = await recall(pCross, '*');
    assert.equal(allC.statusCode, 200, `cross-read should allow workspace=*: ${allC.body}`);
    console.log('  ✓ T3: cross-workspace-read scope gates cross-workspace + "*" reads');
}

// ── T4: revoke is effective immediately ───────────────────────────────────

async function testT4_revokeEffectiveImmediately(): Promise<void> {
    const issued = tokens.issueToken({ workspace: 'dev', label: 'to-be-revoked', scopes: ['read', 'write'] });
    // Before revoke, lookup resolves.
    const before = tokens.lookupByPlaintext(issued.token);
    assert.ok(before, 'token resolvable pre-revoke');
    assert.equal(before!.label, 'to-be-revoked');

    // Revoke by prefix.
    const n = tokens.revokeByPrefix(issued.record.prefix);
    assert.ok(n >= 1, `revokeByPrefix matched at least one token (got ${n})`);

    // Lookup now returns null → middleware would map this to 401.
    const after = tokens.lookupByPlaintext(issued.token);
    assert.equal(after, null, 'revoked token MUST NOT resolve');

    // The registry still lists the row (with revokedAt set) so audit
    // can see what happened.
    const list = tokens.listTokens();
    const row = list.find((r) => r.prefix === issued.record.prefix);
    assert.ok(row, 'revoked token still surfaces in list (for audit)');
    assert.ok(row!.revokedAt, `revokedAt is set: ${row!.revokedAt}`);
    console.log('  ✓ T4: revoke makes lookup return null + records revokedAt for audit');
}

// ── T5: `lore auth list` surfaces label, workspace, scopes, lastUsed ──────

async function testT5_listShowsLabelWorkspaceScopesLastUsed(): Promise<void> {
    tokens._resetForTests();
    const issued = tokens.issueToken({
        workspace: 'dev',
        label: 'Claude Code (developer)',
        scopes: ['read', 'write', 'cross-workspace-read'],
    });
    // Simulate one auth check by touching lastUsed.
    tokens.touchLastUsed(issued.token);

    const entries = tokens.listTokens();
    assert.equal(entries.length, 1, 'one entry');
    const [row] = entries;
    assert.equal(row!.label, 'Claude Code (developer)');
    assert.equal(row!.workspace, 'dev');
    assert.deepEqual(row!.scopes, ['read', 'write', 'cross-workspace-read']);
    assert.ok(row!.lastUsedAt && row!.lastUsedAt.length > 0, 'lastUsedAt populated after touch');
    assert.equal(row!.revokedAt, null, 'active row has revokedAt=null');
    console.log('  ✓ T5: list returns label, workspace, scopes, lastUsed for audit');
}

// ── T6: a concurrent touch must NOT resurrect a revoked token (L-003) ───────
//
// Regression for the lost-update: touchLastUsed does a read-modify-write of the
// whole registry. If it could write back a snapshot taken BEFORE a concurrent
// revoke, it would silently drop the revokedAt and the token would resolve
// again. With the atomic writeRegistry + the revoke-recheck-after-read in
// touchLastUsed, a touch issued after the revoke must see revokedAt and no-op.
async function testT6_revokeSurvivesConcurrentTouch(): Promise<void> {
    tokens._resetForTests();
    const issued = tokens.issueToken({ workspace: 'dev', label: 'race', scopes: ['read', 'write'] });

    // Token resolves before revoke.
    assert.ok(tokens.lookupByPlaintext(issued.token), 'token resolvable pre-revoke');

    // Revoke, then immediately attempt a touch on the same plaintext —
    // simulating a live request's best-effort touchLastUsed racing the revoke.
    const n = tokens.revokeByPrefix(issued.record.prefix);
    assert.ok(n >= 1, `revokeByPrefix matched at least one token (got ${n})`);

    // touchLastUsed re-reads + rechecks revokedAt → must be a no-op, NOT a
    // stale-snapshot rewrite that clobbers the revocation.
    tokens.touchLastUsed(issued.token);

    // The token must STILL be unresolvable …
    assert.equal(
        tokens.lookupByPlaintext(issued.token),
        null,
        'touch after revoke MUST NOT resurrect the token',
    );
    // … and the registry row must still carry revokedAt.
    const row = tokens.listTokens().find((r) => r.prefix === issued.record.prefix);
    assert.ok(row, 'revoked token still surfaces in list');
    assert.ok(row!.revokedAt, `revokedAt remains set after concurrent touch: ${row!.revokedAt}`);

    // Also confirm the freshest on-disk registry agrees (atomic write landed).
    const onDisk = JSON.parse(fs.readFileSync(tokens.getRegistryPath(), 'utf8')) as {
        entries: Record<string, { revokedAt?: string | null }>;
    };
    const persisted = Object.values(onDisk.entries).find((e) => e.revokedAt);
    assert.ok(persisted, 'persisted registry still records the revocation after touch');
    console.log('  ✓ T6: revoke survives a concurrent touchLastUsed (no lost-update)');
}

// ── Runner ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    console.log('phase6-p3-per-app-workspace-auth-unit.ts');
    await testT1_dualTokenConcurrentWrites();
    await testT2_crossWorkspaceWriteForbidden();
    await testT3_crossWorkspaceReadScope();
    await testT4_revokeEffectiveImmediately();
    await testT5_listShowsLabelWorkspaceScopesLastUsed();
    await testT6_revokeSurvivesConcurrentTouch();
    // Close the Surreal handles — the async driver keeps the event loop
    // alive otherwise, so the process would hang after the last assertion.
    await registry.disposeAll();
    console.log('All P3 tests passed.');
}

await main();
