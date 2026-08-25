/**
 * test/phase6-p2-strict-schema-and-vocab-unit.ts
 *
 * Phase 6 P2 — strict additionalProperties:false on the store_node
 * surface + per-workspace vocab policy with reject / hitl / warn
 * routing.
 *
 * Coverage (spec T1–T6):
 *   T1: store_node with `project: "x"` (legacy field name) →
 *       400 unknown_field hint "Did you mean: workspace"
 *   T2: store_node with arbitrary unknown field → 400 unknown_field
 *   T3: domain_event into workspace with allowlist=[decision] +
 *       onMismatch=reject → 400 type_not_allowed
 *   T4: same with onMismatch=hitl → 202-equivalent pending_human_review
 *       envelope + node in HITL queue (InMemoryPendingOpsStore.list).
 *   T5: same with onMismatch=warn → success envelope with
 *       _meta.warning / X-Lore-Type-Warning header instructions.
 *   T6: store_node type=domain_event with NO vocab policy and NO active
 *       plugins → accepted. (SW-21/22 removed the plugin-gating branch:
       workspace vocab policy is the only type gate. Historically this
       slot asserted plugin_inactive rejections for bug_pattern →
       file_ref → domain_event as each was promoted/plugin-gated.)
 *
 * Drives registerMemoryTools directly via the same captured-handler
 * stub pattern used by phase6-p1c. Full HTTP daemon spin-up is out of
 * scope for a unit test — the strict + vocab gates fire at the tool
 * handler before any graph write.
 *
 * Run:
 *   LORE_HOME=$(mktemp -d) npx tsx test/phase6-p2-strict-schema-and-vocab-unit.ts
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';

const TEST_HOME = process.env['LORE_HOME'];
if (!TEST_HOME || TEST_HOME === path.join(process.env['HOME'] ?? '', '.groundfloor')) {
    console.error(
        'ERROR: LORE_HOME must be set to a fresh temp dir before running this test.\n' +
            'Use: LORE_HOME=$(mktemp -d) npx tsx test/phase6-p2-strict-schema-and-vocab-unit.ts',
    );
    process.exit(2);
}

function seedWorkspacesJson(home: string, active: string, names: string[]): void {
    // Explicit 'surreal': store_node resolves its target workspace through
    // the engine-aware getGraphHandle(), and these tests seed/verify
    // through the same accessor — one engine (SurrealDB) on both sides.
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

seedWorkspacesJson(TEST_HOME, 'dev', ['dev', 'domainplugin']);

const { LocalGraphRegistry } = await import('../packages/lore/src/engines/localGraphRegistry.js');
const { registerMemoryTools } = await import('../packages/lore/src/mcp/tools/memory.js');
const { setWorkspaceVocabPolicy } = await import('../packages/lore/src/config/workspaces.js');
const { InMemoryPendingOpsStore } = await import('../packages/lore/src/security/inMemoryPendingOpsStore.js');

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

function makeFakeVerbatim() {
    return {
        rows: [] as Array<{ id: string; text: string; score: number }>,
        async count() { return 0; },
        async search(_q: string, _l: number) { return []; },
        async bm25Search(_q: string, _l: number) { return []; },
        async store(_a: { id: string; text: string; metadata?: object }) {},
        async delete(_id: string) {},
    };
}

interface PluginRegistryStub {
    activeNames(): string[];
    isActive(name: string): boolean;
    active(): object[];
    registerTools(): void;
}

function makePluginRegistry(active: string[]): PluginRegistryStub {
    const set = new Set(active);
    return {
        activeNames: () => [...set],
        isActive: (name: string) => set.has(name),
        active: () => [],
        registerTools: () => undefined,
    };
}

// ── Shared setup ──────────────────────────────────────────────────────────
//
// Each test creates a NEW LocalGraphRegistry but reuses the SAME primed
// SurrealGraph instances — opening a second SurrealGraph against the same
// surrealkv directory contends on its lock. The shared registry
// holds both workspaces' graphs across the whole test run; per-test
// scaffolding just rewires the surrounding deps.

const sharedRegistry = new LocalGraphRegistry();
const sharedGraphDev = await sharedRegistry.getGraphHandle('dev');
const sharedGraphB = await sharedRegistry.getGraphHandle('domainplugin');

async function buildEnv(activePlugins: string[]) {
    const verbatim = makeFakeVerbatim();
    const pendingOpsStore = new InMemoryPendingOpsStore();
    const store = {
        loreGraph: sharedGraphDev,
        loreVerbatim: verbatim as unknown as never,
        sessionCache: { pushNode: () => undefined } as unknown as never,
    };
    return {
        registry: sharedRegistry,
        graphDev: sharedGraphDev,
        graphB: sharedGraphB,
        verbatim,
        pendingOpsStore,
        store,
        pluginRegistry: makePluginRegistry(activePlugins),
    };
}

function registerAll(
    server: object,
    store: never,
    registry: InstanceType<typeof LocalGraphRegistry>,
    pluginRegistry: PluginRegistryStub,
    pendingOpsStore: InstanceType<typeof InMemoryPendingOpsStore> | undefined,
) {
    // X1 (2026-05-22): bug_pattern is now a Core type; the previous
    // plugin-gated path is exercised via 'file_ref' (still owned by
    // the developer plugin's contributeNodeTypes()).
    const nodeTypesEnum = z.enum(['decision', 'note', 'convention', 'bug_pattern', 'file_ref', 'domain_event']);
    const edgeRelationsEnum = z.enum(['related_to', 'depends_on']);
    registerMemoryTools(server as never, {
        store: store as never,
        pluginRegistry: pluginRegistry as never,
        configManager: { read: () => ({ pluginConfig: { developer: { autoLinkOnIngest: false } } }) } as never,
        auditLog: { log: () => undefined } as never,
        detectedScope: { workspace: 'dev', ecosystem: 'default' },
        getWal: () => ({ append: () => undefined } as never),
        domain: 'lore',
        edgeRelations: ['related_to', 'depends_on'],
        nodeTypesEnum,
        nodeTypesDescription: 'decision|note|convention|bug_pattern|file_ref|domain_event',
        edgeRelationsEnum,
        graphRegistry: registry,
        pendingOpsStore: pendingOpsStore as never,
        coreNodeTypes: ['decision', 'note', 'convention', 'bug_pattern', 'architecture', 'troubleshooting'],
    });
}

// ── T1: legacy `project` field → unknown_field + workspace hint ────────────

async function testT1_projectFieldHint(): Promise<void> {
    const env = await buildEnv(['developer']);
    const { server, tools } = makeMcpServerStub();
    registerAll(server, env.store as never, env.registry, env.pluginRegistry, env.pendingOpsStore);

    const res = await tools['store_node']!({
        id: 'p2-t1', type: 'decision', label: 'silent-drop probe',
        project: 'x', // legacy field name; should be rejected, not stripped.
    });
    assert.equal(res.isError, true, `expected error envelope; got ${JSON.stringify(res.content[0])}`);
    const body = JSON.parse(res.content[0]!.text);
    assert.equal(body.error, 'unknown_field');
    assert.deepEqual(body.rejected, ['project']);
    assert.equal(body.hint, 'workspace', `Did-you-mean hint for "project" should be "workspace", got "${body.hint}"`);
    console.log('  ✓ T1: project: arg rejected with workspace hint');
}

// ── T2: arbitrary unknown field rejected ───────────────────────────────────

async function testT2_arbitraryUnknownField(): Promise<void> {
    const env = await buildEnv(['developer']);
    const { server, tools } = makeMcpServerStub();
    registerAll(server, env.store as never, env.registry, env.pluginRegistry, env.pendingOpsStore);

    const res = await tools['store_node']!({
        id: 'p2-t2', type: 'decision', label: 'arbitrary field probe',
        xyz: 123,
    });
    assert.equal(res.isError, true);
    const body = JSON.parse(res.content[0]!.text);
    assert.equal(body.error, 'unknown_field');
    assert.deepEqual(body.rejected, ['xyz']);
    console.log('  ✓ T2: arbitrary unknown field rejected');
}

// ── T3: allowlist + reject → type_not_allowed ──────────────────────────────

async function testT3_allowlistReject(): Promise<void> {
    setWorkspaceVocabPolicy('domainplugin', { mode: 'allowlist', types: ['decision'], onMismatch: 'reject' });

    const env = await buildEnv(['domainplugin']); // developer NOT active so bug_pattern stays plugin-gated
    const { server, tools } = makeMcpServerStub();
    registerAll(server, env.store as never, env.registry, env.pluginRegistry, env.pendingOpsStore);

    const res = await tools['store_node']!({
        id: 'p2-t3', type: 'domain_event', label: 'should be rejected',
        workspace: 'domainplugin',
    });
    assert.equal(res.isError, true);
    const body = JSON.parse(res.content[0]!.text);
    assert.equal(body.error, 'type_not_allowed');
    assert.ok(/domain_event/.test(body.reason), `reason mentions the rejected type: ${body.reason}`);
    // Make sure nothing actually got written.
    assert.equal(await env.graphB.getNode('p2-t3'), null, 'reject MUST NOT write to graph');
    console.log('  ✓ T3: domain_event + allowlist[decision] + reject → 400 type_not_allowed');
}

// ── T4: hitl → 202 pending_human_review + node in HITL queue ───────────────

async function testT4_hitlEnqueuesPendingOp(): Promise<void> {
    setWorkspaceVocabPolicy('domainplugin', { mode: 'allowlist', types: ['decision'], onMismatch: 'hitl' });

    const env = await buildEnv(['domainplugin']);
    const { server, tools } = makeMcpServerStub();
    registerAll(server, env.store as never, env.registry, env.pluginRegistry, env.pendingOpsStore);

    const res = await tools['store_node']!({
        id: 'p2-t4', type: 'domain_event', label: 'should be queued',
        workspace: 'domainplugin',
    });
    // NW-7f (api-004) flipped the hitl envelope to isError:true + code:
    // 'pending_review' so MCP clients can branch without text-parsing;
    // status/error stay populated for legacy string-match consumers.
    assert.equal(res.isError, true, `hitl path returns the NW-7f error-shaped envelope; got ${JSON.stringify(res)}`);
    const body = JSON.parse(res.content[0]!.text);
    assert.equal(body.code, 'pending_review');
    assert.equal(body.status, 'pending_human_review');
    assert.ok(typeof body.pending_op_id === 'string' && body.pending_op_id.length > 0, 'pending_op_id present');
    assert.equal(body.workspace, 'domainplugin');
    assert.equal(body.type, 'domain_event');
    assert.equal(await env.graphB.getNode('p2-t4'), null, 'hitl MUST NOT write to graph yet (awaits approval)');

    // Queue contents:
    const queued = await env.pendingOpsStore.list({ status: 'pending' });
    assert.ok(queued.length >= 1, 'HITL queue contains the pending op');
    const ours = queued.find((p) => p.id === body.pending_op_id);
    assert.ok(ours, 'pending op resolvable by id');
    assert.equal(ours!.operation, 'store_node');
    assert.equal(ours!.workspaceId, 'domainplugin');
    console.log('  ✓ T4: hitl → pending_human_review + node enqueued (no graph write)');
}

// ── T5: warn → success + warning header instructions ───────────────────────

async function testT5_warnIncludesWarning(): Promise<void> {
    setWorkspaceVocabPolicy('domainplugin', { mode: 'allowlist', types: ['decision'], onMismatch: 'warn' });

    const env = await buildEnv(['domainplugin']);
    const { server, tools } = makeMcpServerStub();
    registerAll(server, env.store as never, env.registry, env.pluginRegistry, env.pendingOpsStore);

    const res = await tools['store_node']!({
        id: 'p2-t5', type: 'domain_event', label: 'allowed with warning',
        workspace: 'domainplugin',
    });
    assert.equal(res.isError, undefined);
    const body = JSON.parse(res.content[0]!.text);
    assert.equal(body.success, true, 'warn path still succeeds');
    assert.ok(body._meta && typeof body._meta.warning === 'string', `_meta.warning present: ${JSON.stringify(body._meta)}`);
    assert.ok(/domain_event/.test(body._meta.warning), 'warning mentions the type');
    assert.ok(typeof body._meta.header === 'string' && body._meta.header.startsWith('X-Lore-Type-Warning:'),
        'header hint for HTTP callers attached');
    // Graph write DID happen.
    assert.ok(await env.graphB.getNode('p2-t5'), 'warn writes to graph');
    console.log('  ✓ T5: warn → 200 + X-Lore-Type-Warning instruction');
}

// ── T6: plugin-contributed type + no vocab policy → accepted (SW-21/22) ──
//
// History: this slot first asserted bug_pattern (pre-X1), then file_ref
// (pre-X6.5) plugin_inactive rejections. SW-21/22 (commit 464bf78) then
// removed the dead plugin-gating branch entirely — workspace vocab policy
// is the ONLY type gate now. This pins that removal: a plugin-contributed
// type must NOT be silently blocked by plugin state when no policy is set.

async function testT6_noPolicyAcceptsPluginType(): Promise<void> {
    // Clear any prior vocabPolicy on dev so NO type gate is set.
    setWorkspaceVocabPolicy('dev', null);

    const env = await buildEnv([]); // NO active plugins
    const { server, tools } = makeMcpServerStub();
    registerAll(server, env.store as never, env.registry, env.pluginRegistry, env.pendingOpsStore);

    const res = await tools['store_node']!({
        id: 'p2-t6', type: 'domain_event', label: 'plugin-contributed type, no policy set',
        workspace: 'dev',
    });
    assert.equal(res.isError, undefined,
        `post-SW-21/22 a plugin-contributed type with no vocab policy is accepted; got ${JSON.stringify(res.content[0])}`);
    assert.ok(await env.graphDev.getNode('p2-t6'), 'write lands in the workspace graph');
    console.log('  ✓ T6: no vocab policy → plugin-contributed type accepted (plugin gating removed, SW-21/22)');
}

// ── Runner ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    console.log('phase6-p2-strict-schema-and-vocab-unit.ts');
    await testT1_projectFieldHint();
    await testT2_arbitraryUnknownField();
    await testT3_allowlistReject();
    await testT4_hitlEnqueuesPendingOp();
    await testT5_warnIncludesWarning();
    await testT6_noPolicyAcceptsPluginType();
    // Close the shared SurrealGraph handles — the async Surreal driver
    // keeps the event loop alive otherwise, so the process would hang
    // after the last assertion instead of exiting.
    await sharedRegistry.disposeAll();
    console.log('All P2 tests passed.');
}

await main();
