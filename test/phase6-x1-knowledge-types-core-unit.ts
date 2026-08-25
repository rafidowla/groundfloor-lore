/**
 * test/phase6-x1-knowledge-types-core-unit.ts
 *
 * X1 — Knowledge types (decision, convention, bug_pattern,
 * architecture, troubleshooting) live in Lore Core's DEFAULT_SCHEMA_V2.
 *
 * After X1 (and the X5 deletion of lore-plugin-developer), the 5 types
 * are recognised by the vocab-policy engine in EVERY workspace
 * regardless of which plugins are active.
 *
 * Coverage:
 *   T1: store_node type=decision with NO plugins active → 200 success.
 *   T2: store_node type=bug_pattern with a non-core plugin name active
 *       → 200 success (no regression).
 *   T3: store_node type=convention with a different plugin active
 *       → 200 success.
 *   T4: every promoted type appears in Core's DEFAULT_SCHEMA_V2.
 *   T5: vocabPolicy allowlist=[decision] STILL rejects bug_pattern
 *       (P2 regression check — Core promotion didn't break the
 *       workspace-level vocab policy gate).
 *
 * Drives registerMemoryTools directly via the captured-handler stub
 * pattern used by other phase6 unit tests.
 *
 * Run:
 *   LORE_HOME=$(mktemp -d) npx tsx test/phase6-x1-knowledge-types-core-unit.ts
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';

const TEST_HOME = process.env['LORE_HOME'];
if (!TEST_HOME || TEST_HOME === path.join(process.env['HOME'] ?? '', '.groundfloor')) {
    console.error(
        'ERROR: LORE_HOME must be set to a fresh temp dir before running this test.\n' +
            'Use: LORE_HOME=$(mktemp -d) npx tsx test/phase6-x1-knowledge-types-core-unit.ts',
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
        createdAt: '2026-05-22T00:00:00.000Z',
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

seedWorkspacesJson(TEST_HOME, 'plain', ['plain', 'dev', 'cre']);

const { LocalGraphRegistry } = await import('../packages/lore/src/engines/localGraphRegistry.js');
const { registerMemoryTools } = await import('../packages/lore/src/mcp/tools/memory.js');
const { setWorkspaceVocabPolicy } = await import('../packages/lore/src/config/workspaces.js');
const { DEFAULT_SCHEMA_V2 } = await import('../packages/lore/src/schemas/types.js');

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

const sharedRegistry = new LocalGraphRegistry();
const sharedGraphPlain = await sharedRegistry.getGraphHandle('plain');
const sharedGraphDev = await sharedRegistry.getGraphHandle('dev');
const sharedGraphCre = await sharedRegistry.getGraphHandle('cre');

const CORE_NODE_TYPES = DEFAULT_SCHEMA_V2.nodeTypes.map((t) => t.name);

interface BuildEnvOpts {
    workspaceName: 'plain' | 'dev' | 'cre';
    activePlugins: string[];
    nodeTypesEnum?: ReturnType<typeof z.enum>;
}

async function buildEnv(opts: BuildEnvOpts) {
    const verbatim = makeFakeVerbatim();
    const graph =
        opts.workspaceName === 'plain'
            ? sharedGraphPlain
            : opts.workspaceName === 'dev'
            ? sharedGraphDev
            : sharedGraphCre;
    const store = {
        loreGraph: graph,
        loreVerbatim: verbatim as unknown as never,
        sessionCache: { pushNode: () => undefined } as unknown as never,
    };
    return {
        registry: sharedRegistry,
        graph,
        verbatim,
        store,
        pluginRegistry: makePluginRegistry(opts.activePlugins),
    };
}

function registerAll(
    server: object,
    store: never,
    registry: InstanceType<typeof LocalGraphRegistry>,
    pluginRegistry: PluginRegistryStub,
    workspaceName: string,
    enumTypes?: string[],
) {
    const typesForEnum = enumTypes ?? [
        ...CORE_NODE_TYPES,
        // Tests register every Core type so the Zod enum doesn't trip
        // before vocabPolicy has a chance to run.
    ];
    const nodeTypesEnum = z.enum(typesForEnum as [string, ...string[]]);
    const edgeRelationsEnum = z.enum(['related_to', 'depends_on']);
    registerMemoryTools(server as never, {
        store: store as never,
        pluginRegistry: pluginRegistry as never,
        configManager: { read: () => ({ pluginConfig: {} }) } as never,
        auditLog: { log: () => undefined } as never,
        detectedScope: { workspace: workspaceName, ecosystem: 'default' },
        getWal: () => ({ append: () => undefined } as never),
        domain: 'lore',
        edgeRelations: ['related_to', 'depends_on'],
        nodeTypesEnum,
        nodeTypesDescription: typesForEnum.join('|'),
        edgeRelationsEnum,
        graphRegistry: registry,
        coreNodeTypes: CORE_NODE_TYPES,
    });
}

/* ─── T1: decision in workspace with NO plugins active ─────────── */

async function testT1_decisionNoPlugins(): Promise<void> {
    setWorkspaceVocabPolicy('plain', null);
    const env = await buildEnv({ workspaceName: 'plain', activePlugins: [] });
    const { server, tools } = makeMcpServerStub();
    registerAll(server, env.store as never, env.registry, env.pluginRegistry, 'plain');

    const res = await tools['store_node']!({
        id: 'x1-t1-decision',
        type: 'decision',
        label: 'A core knowledge type works without any plugin',
        workspace: 'plain',
    });
    assert.equal(res.isError, undefined, `T1 should succeed; got ${JSON.stringify(res.content[0])}`);
    const body = JSON.parse(res.content[0]!.text);
    assert.equal(body.success, true, 'T1 success envelope');
    assert.ok(await env.graph.getNode('x1-t1-decision'), 'T1 node written to graph');
    console.log('  ✓ T1: store_node type=decision with NO plugins active → 200 success');
}

/* ─── T2: bug_pattern with a non-core plugin name active ───────── */

async function testT2_bugPatternWithPluginActive(): Promise<void> {
    setWorkspaceVocabPolicy('dev', null);
    // Pretend an unrelated plugin is active. Knowledge types live in
    // Core's DEFAULT_SCHEMA_V2 — store_node must accept them regardless.
    const env = await buildEnv({ workspaceName: 'dev', activePlugins: ['personal'] });
    const { server, tools } = makeMcpServerStub();
    registerAll(server, env.store as never, env.registry, env.pluginRegistry, 'dev');

    const res = await tools['store_node']!({
        id: 'x1-t2-bp',
        type: 'bug_pattern',
        label: 'core knowledge type accepted with arbitrary plugin active',
        workspace: 'dev',
    });
    assert.equal(res.isError, undefined, `T2 should succeed; got ${JSON.stringify(res.content[0])}`);
    const body = JSON.parse(res.content[0]!.text);
    assert.equal(body.success, true, 'T2 success envelope');
    assert.ok(await env.graph.getNode('x1-t2-bp'), 'T2 node written to graph');
    console.log('  ✓ T2: store_node type=bug_pattern with an unrelated plugin active → 200 (no regression)');
}

/* ─── T3: convention with a different plugin active ────────────── */

async function testT3_conventionWithDifferentPlugin(): Promise<void> {
    setWorkspaceVocabPolicy('cre', null);
    // Active plugin name is 'cre'. Vocab policy inspects active plugin
    // names against `allPluginContribs`; the point is that convention
    // is in CORE and must accept regardless of which plugin is active.
    const env = await buildEnv({ workspaceName: 'cre', activePlugins: ['cre'] });
    const { server, tools } = makeMcpServerStub();
    registerAll(server, env.store as never, env.registry, env.pluginRegistry, 'cre');

    const res = await tools['store_node']!({
        id: 'x1-t3-conv',
        type: 'convention',
        label: 'core type accepted with any plugin active',
        workspace: 'cre',
    });
    assert.equal(res.isError, undefined, `T3 should succeed; got ${JSON.stringify(res.content[0])}`);
    const body = JSON.parse(res.content[0]!.text);
    assert.equal(body.success, true, 'T3 success envelope');
    assert.ok(await env.graph.getNode('x1-t3-conv'), 'T3 node written to graph');
    console.log('  ✓ T3: store_node type=convention with arbitrary plugin → 200 success');
}

/* ─── T4: Core DEFAULT_SCHEMA_V2 carries the 5 knowledge types ─── */

async function testT4_coreOwnsKnowledgeTypes(): Promise<void> {
    const promoted = ['decision', 'convention', 'bug_pattern', 'architecture', 'troubleshooting'] as const;
    for (const name of promoted) {
        assert.ok(
            CORE_NODE_TYPES.includes(name),
            `Core DEFAULT_SCHEMA_V2.nodeTypes must include '${name}'; got [${CORE_NODE_TYPES.join(', ')}]`,
        );
    }
    console.log('  ✓ T4: Core DEFAULT_SCHEMA_V2 owns the 5 promoted knowledge types');
}

/* ─── T5: P2 vocabPolicy allowlist still rejects bug_pattern ───── */

async function testT5_vocabPolicyStillEnforces(): Promise<void> {
    setWorkspaceVocabPolicy('plain', { mode: 'allowlist', types: ['decision'], onMismatch: 'reject' });
    const env = await buildEnv({ workspaceName: 'plain', activePlugins: [] });
    const { server, tools } = makeMcpServerStub();
    registerAll(server, env.store as never, env.registry, env.pluginRegistry, 'plain');

    const res = await tools['store_node']!({
        id: 'x1-t5-bp',
        type: 'bug_pattern',
        label: 'rejected by workspace allowlist even though Core knows the type',
        workspace: 'plain',
    });
    assert.equal(res.isError, true, `T5 should reject; got ${JSON.stringify(res.content[0])}`);
    const body = JSON.parse(res.content[0]!.text);
    assert.equal(body.error, 'type_not_allowed', `expected type_not_allowed; got ${body.error}`);
    assert.ok(/bug_pattern/.test(body.reason ?? ''), 'reason mentions bug_pattern');
    assert.equal(await env.graph.getNode('x1-t5-bp'), null, 'reject MUST NOT write to graph');

    // Reset for downstream test reuse.
    setWorkspaceVocabPolicy('plain', null);
    console.log('  ✓ T5: vocabPolicy allowlist=[decision] still rejects bug_pattern (P2 intact)');
}

/* ─── Runner ──────────────────────────────────────────────────── */

async function main(): Promise<void> {
    console.log('phase6-x1-knowledge-types-core-unit.ts');
    await testT1_decisionNoPlugins();
    await testT2_bugPatternWithPluginActive();
    await testT3_conventionWithDifferentPlugin();
    await testT4_coreOwnsKnowledgeTypes();
    await testT5_vocabPolicyStillEnforces();
    // Close the shared SurrealGraph handles — the async Surreal driver
    // keeps the event loop alive otherwise, so the process would hang
    // after the last assertion instead of exiting.
    await sharedRegistry.disposeAll();
    console.log('All X1 tests passed.');
}

await main();
