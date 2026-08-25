#!/usr/bin/env tsx
/**
 * sp-quota-changeset-unit.ts — L-033 / R-005: commit_changeset enforces the
 * per-workspace write quota.
 *
 * THE GAP: the per-workspace write quota (security/workspaceQuota.ts) is gated
 * on the MCP store_node hot path AND on POST /api/node — but store_node, when
 * called with a changeset_id, BUFFERS the write and returns BEFORE the quota
 * gate (storeNode.ts ~273). The commit path (versioning.ts commit_changeset)
 * never referenced the quota store, so an agent could blow past
 * workspace.maxNodes / maxStorageBytes by buffering writes into a changeset and
 * committing them — the buffered writes never hit checkWorkspaceQuota and never
 * bumped the counter.
 *
 * THE FIX: commit_changeset aggregates the buffered upserts per workspace,
 * checks checkWorkspaceQuota BEFORE applying any write (refusing the whole
 * commit atomically — graph untouched, changeset left OPEN — if it would
 * exceed), and bumps the shared counter AFTER the writes land.
 *
 * What this proves:
 *   - a changeset whose upserts would exceed maxNodes → isError envelope
 *     `workspace_quota_exceeded`, NO graph upsert is called, and the changeset
 *     is NOT marked committed (stays open).      <-- fails without the fix
 *   - a changeset under cap → commits, the counter increments by ALL upserts.
 *   - storage-bytes dimension is enforced on the summed label+content bytes.
 *   - quota unwired (cloud/tests) → no gate (back-compat).
 *
 * Run: LORE_HOME=$(mktemp -d) npx tsx test/sp-quota-changeset-unit.ts
 */

import assert from 'node:assert/strict';
import { registerVersioningTools } from '../packages/lore/src/mcp/tools/versioning.js';
import { InMemoryWorkspaceQuotaStore } from '../packages/lore/src/security/workspaceQuota.js';
import type { VersioningDeps } from '../packages/lore/src/mcp/tools/versioning.js';
import type { WorkspaceEntry } from '../packages/lore/src/config/workspaces.js';

interface RecordedTool { name: string; handler: (a: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>; }
class FakeMcpServer {
    public tools: RecordedTool[] = [];
    tool(name: string, _d: string, _s: unknown, handler: RecordedTool['handler']) { this.tools.push({ name, handler }); }
}

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
};
const classify = (r: { content: Array<{ text: string }> }): Record<string, unknown> => {
    try { return JSON.parse(r.content[0].text); } catch { return {}; }
};

type Write = { seq: number; operation: 'upsert_node' | 'delete_node'; payload: Record<string, unknown> };

/** Minimal in-memory VersionStore good enough for commit_changeset. */
function makeFakeVersionStore(writes: Write[]) {
    let status: 'open' | 'committed' | 'rolled_back' = 'open';
    const recorded: unknown[] = [];
    return {
        store: {
            getChangeset: (_id: string) => ({ changesetId: _id, workspace: 'dev', status }),
            getChangesetWrites: (_id: string) => writes,
            recordVersion: (v: unknown) => { recorded.push(v); },
            updateChangeset: (_id: string, s: 'open' | 'committed' | 'rolled_back') => { status = s; },
            getVersionsByChangeset: () => [],
            createChangeset: () => 'cs-x',
            getVersions: () => [], getDiff: () => [], addChangesetWrite: () => 1,
        },
        currentStatus: () => status,
        recordedCount: () => recorded.length,
    };
}

function makeFakeGraph() {
    const upsertCalls: string[] = [];
    return {
        upsertCalls,
        graph: {
            async upsertNode(n: { id: string }) { upsertCalls.push(n.id); return { ...n }; },
            async getNode() { return null; },
            async deleteNode() { return true; },
        },
    };
}

function makeDeps(
    writes: Write[],
    quotaStore: InMemoryWorkspaceQuotaStore | undefined,
    getEntry: ((ws: string) => WorkspaceEntry | undefined) | undefined,
): { deps: VersioningDeps; graph: ReturnType<typeof makeFakeGraph>; vs: ReturnType<typeof makeFakeVersionStore> } {
    const graph = makeFakeGraph();
    const vs = makeFakeVersionStore(writes);
    const deps = {
        versionStore: vs.store as never,
        store: { loreGraph: graph.graph } as never,
        graphRegistry: undefined,                       // → resolveTargetGraph returns boot loreGraph
        detectedScope: { workspace: 'dev', ecosystem: '*' },
        quotaStore,
        getWorkspaceEntryForQuota: getEntry,
    } as unknown as VersioningDeps;
    return { deps, graph, vs };
}

const upsert = (id: string, label = id, content = ''): Write =>
    ({ seq: 0, operation: 'upsert_node', payload: { workspace: 'dev', nodeData: { id, type: 'decision', label, content } } });
const entry = (maxNodes?: number, maxStorageBytes?: number): WorkspaceEntry =>
    ({ name: 'dev', path: '/tmp/dev', createdAt: 'x', ...(maxNodes !== undefined ? { maxNodes } : {}), ...(maxStorageBytes !== undefined ? { maxStorageBytes } : {}) } as WorkspaceEntry);

function commitTool(deps: VersioningDeps): RecordedTool {
    const srv = new FakeMcpServer();
    registerVersioningTools(srv as never, deps);
    return srv.tools.find(t => t.name === 'commit_changeset')!;
}

(async () => {
    console.log('sp-quota-changeset-unit.ts — L-033 / R-005 commit_changeset write quota');

    /* ── the headline: a changeset over maxNodes is refused at commit ── */
    await test('commit over maxNodes → workspace_quota_exceeded, graph NOT mutated, NOT committed', async () => {
        const quotaStore = new InMemoryWorkspaceQuotaStore();
        quotaStore.reconcile('dev', { nodeCount: 0, storageBytes: 0 });
        const { deps, graph, vs } = makeDeps([upsert('n1'), upsert('n2')], quotaStore, () => entry(1)); // 2 upserts vs cap 1
        const r = await commitTool(deps).handler({ changeset_id: 'cs1' });
        assert.equal(r.isError, true, 'expected an error envelope');
        const body = classify(r);
        assert.equal(body['error'], 'workspace_quota_exceeded');
        assert.equal(body['dimension'], 'maxNodes');
        assert.equal(body['cap'], 1);
        assert.equal(graph.upsertCalls.length, 0, 'refused commit MUST NOT touch the graph');
        assert.equal(vs.currentStatus(), 'open', 'refused changeset MUST stay open (not committed)');
        assert.equal(quotaStore.snapshot('dev').nodeCount, 0, 'counter not bumped on refusal');
    });

    /* ── under cap commits + bumps the counter by ALL upserts ── */
    await test('commit under cap → succeeds, counter increments by all upserts', async () => {
        const quotaStore = new InMemoryWorkspaceQuotaStore();
        quotaStore.reconcile('dev', { nodeCount: 0, storageBytes: 0 });
        const { deps, graph, vs } = makeDeps([upsert('n1', 'a'), upsert('n2', 'bb')], quotaStore, () => entry(5));
        const r = await commitTool(deps).handler({ changeset_id: 'cs1' });
        assert.notEqual(r.isError, true, `commit should succeed: ${JSON.stringify(r)}`);
        const body = classify(r);
        assert.equal(body['status'], 'committed');
        assert.equal(body['applied'], 2);
        assert.deepEqual(graph.upsertCalls, ['n1', 'n2']);
        assert.equal(vs.currentStatus(), 'committed');
        assert.equal(quotaStore.snapshot('dev').nodeCount, 2, 'counter bumped by both upserts');
        assert.equal(quotaStore.snapshot('dev').storageBytes, 3, 'bytes = "a"(1)+"bb"(2)');
    });

    /* ── pre-existing counter near cap: aggregate of buffered upserts exceeds ── */
    await test('commit refused when existing count + changeset upserts exceed cap', async () => {
        const quotaStore = new InMemoryWorkspaceQuotaStore();
        quotaStore.reconcile('dev', { nodeCount: 1, storageBytes: 0 }); // already 1 of cap 2
        const { deps, graph } = makeDeps([upsert('n1'), upsert('n2')], quotaStore, () => entry(2)); // 1 + 2 = 3 > 2
        const r = await commitTool(deps).handler({ changeset_id: 'cs1' });
        assert.equal(r.isError, true);
        assert.equal(classify(r)['dimension'], 'maxNodes');
        assert.equal(graph.upsertCalls.length, 0);
    });

    /* ── storage-bytes dimension on summed label+content ── */
    await test('commit over maxStorageBytes → refused on storage dimension', async () => {
        const quotaStore = new InMemoryWorkspaceQuotaStore();
        quotaStore.reconcile('dev', { nodeCount: 0, storageBytes: 0 });
        // 'big'(3)+'enough'(6) = 9 bytes > 4
        const { deps, graph } = makeDeps([upsert('b1', 'big', 'enough')], quotaStore, () => entry(undefined, 4));
        const r = await commitTool(deps).handler({ changeset_id: 'cs1' });
        assert.equal(r.isError, true);
        assert.equal(classify(r)['dimension'], 'maxStorageBytes');
        assert.equal(graph.upsertCalls.length, 0);
    });

    /* ── back-compat: no quotaStore wired → no gate ── */
    await test('commit with no quotaStore wired → no quota gate (cloud/legacy)', async () => {
        const { deps, graph, vs } = makeDeps([upsert('n1'), upsert('n2')], undefined, undefined);
        const r = await commitTool(deps).handler({ changeset_id: 'cs1' });
        assert.notEqual(r.isError, true, `unwired quota must not block: ${JSON.stringify(r)}`);
        assert.equal(graph.upsertCalls.length, 2, 'both writes proceed when quota unwired');
        assert.equal(vs.currentStatus(), 'committed');
    });

    console.log(`\nL-033/R-005: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
})();
