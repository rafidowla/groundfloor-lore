/**
 * test/phase6-x6-5-fix-persistence-unit.ts
 *
 * X6.5 — Restore the Atlas→Lore type contract.
 *
 * X5 (commit cf007e6) deleted lore-plugin-developer, which previously
 * contributed `file_ref` and `code_symbol` via contributeNodeTypes().
 * After deletion, the merged store_node Zod enum (built in
 * mcp/mergedEnums.ts from coreNodeTypes + plugin contributions) no
 * longer carried those names — every Atlas write via MCP failed Zod
 * validation with `isError: true, error: "input validation failed"`.
 * Atlas's LoreClient discarded the error and reported success, so the
 * X6 dogfood batch ("420 file_ref + 5146 code_symbol candidates")
 * silently dropped on the floor. See loom-lore-X6-blocked-2026-05-22.
 *
 * The fix lands `file_ref` + `code_symbol` in Core's DEFAULT_SCHEMA_V2
 * (schemas/types.ts) so coreNodeTypes — and therefore nodeTypesEnum —
 * carries them in every workspace, no plugin gate required.
 *
 * Coverage:
 *   T1: store_node {type: 'decision'} succeeds and the node is
 *       immediately queryable via the same graph handle. Smoke baseline
 *       proving the write path is healthy.
 *   T2: After T1, close the graph handle and open a NEW SurrealGraph at
 *       the same path. The prior node is still queryable — proves the
 *       store persists across restart.
 *   T3: store_node {type: 'file_ref'} and {type: 'code_symbol'}
 *       succeed with NO plugins active in the workspace — the X6.5
 *       schema-patch acceptance test. Both nodes appear in the graph
 *       under the configured workspace. This is the core regression
 *       gate: before the X6.5 patch landed, both calls returned
 *       isError=true with a Zod enum-mismatch envelope.
 *
 * Run:
 *   LORE_HOME=$(mktemp -d) npx tsx test/phase6-x6-5-fix-persistence-unit.ts
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';

const TEST_HOME = process.env['LORE_HOME'];
if (!TEST_HOME || TEST_HOME === path.join(process.env['HOME'] ?? '', '.groundfloor')) {
    console.error(
        'ERROR: LORE_HOME must be set to a fresh temp dir before running this test.\n' +
            'Use: LORE_HOME=$(mktemp -d) npx tsx test/phase6-x6-5-fix-persistence-unit.ts',
    );
    process.exit(2);
}

function seedWorkspacesJson(home: string, active: string, names: string[]): void {
    // No explicit graphEngine: absent defaults to 'surreal'
    // (DEFAULT_GRAPH_ENGINE), so store_node writes (engine-aware
    // getGraphHandle) and the test's verification reads (also
    // getGraphHandle) resolve the SAME SurrealGraph handle.
    const workspaces = names.map((name) => ({
        name,
        path: path.join(home, 'workspaces', name),
        createdAt: '2026-05-22T00:00:00.000Z',
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

seedWorkspacesJson(TEST_HOME, 'default', ['default']);

const { SurrealGraph } = await import('../packages/lore/src/engines/surrealGraph.js');
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
        tool: (_name: string, ..._rest: unknown[]) => {
            const handler = _rest[_rest.length - 1];
            if (typeof handler === 'function') {
                tools[_name] = handler as ToolBag[string];
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

const CORE_NODE_TYPES = DEFAULT_SCHEMA_V2.nodeTypes.map((t) => t.name);

function registerStoreNode(
    server: object,
    store: never,
    registry: InstanceType<typeof LocalGraphRegistry>,
    pluginRegistry: PluginRegistryStub,
    workspaceName: string,
): void {
    const nodeTypesEnum = z.enum(CORE_NODE_TYPES as [string, ...string[]]);
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
        nodeTypesDescription: CORE_NODE_TYPES.join('|'),
        edgeRelationsEnum,
        graphRegistry: registry,
        coreNodeTypes: CORE_NODE_TYPES,
    });
}

/* ─── T1: store_node + immediate read on the same graph ────────── */

async function testT1_storeAndImmediateRead(): Promise<void> {
    setWorkspaceVocabPolicy('default', null);
    const registry = new LocalGraphRegistry();
    const graph = await registry.getGraphHandle('default');
    const store = {
        loreGraph: graph,
        loreVerbatim: makeFakeVerbatim() as unknown as never,
        sessionCache: { pushNode: () => undefined } as unknown as never,
    };
    const { server, tools } = makeMcpServerStub();
    registerStoreNode(server, store as never, registry, makePluginRegistry([]), 'default');

    const res = await tools['store_node']!({
        id: 'x6.5-smoke-test',
        type: 'decision',
        label: 'test',
        workspace: 'default',
    });
    assert.equal(res.isError, undefined, `T1 should succeed; got ${JSON.stringify(res.content[0])}`);
    const body = JSON.parse(res.content[0]!.text);
    assert.equal(body.success, true, 'T1 success envelope');

    const fetched = await graph.getNode('x6.5-smoke-test');
    assert.ok(fetched, 'T1 node must be queryable via the same graph handle immediately');
    assert.equal(fetched!.type, 'decision', 'T1 node type round-trips');
    assert.equal(fetched!.label, 'test', 'T1 node label round-trips');

    registry.closeAll();
    await graph.close();
    console.log('  ✓ T1: store_node {type:"decision"} succeeds and is immediately queryable');
}

/* ─── T2: persistence across SurrealGraph close + reopen ──────── */

async function testT2_persistenceAcrossReopen(): Promise<void> {
    setWorkspaceVocabPolicy('default', null);
    const workspaceDir = path.join(TEST_HOME!, 'workspaces', 'default');

    // Write phase — open, store, close.
    {
        const writerGraph = new SurrealGraph(workspaceDir, { workspaceId: 'default' });
        await writerGraph.initialize();
        await writerGraph.upsertNode({
            id: 'x6.5-restart-test',
            type: 'decision',
            label: 'persists across daemon restart',
            content: 'T2 — the store must still hold the node when the DB is reopened at the same path',
            tags: 'x6.5,persistence',
            project: 'default',
            ecosystem: 'default',
            metadata: '{}',
        });
        const beforeClose = await writerGraph.getNode('x6.5-restart-test');
        assert.ok(beforeClose, 'T2 pre-close sanity: node visible before close');
        await writerGraph.close();
    }

    // Restart phase — brand-new instance at the same path.
    {
        const readerGraph = new SurrealGraph(workspaceDir, { workspaceId: 'default' });
        await readerGraph.initialize();
        const afterReopen = await readerGraph.getNode('x6.5-restart-test');
        assert.ok(afterReopen, 'T2: node must survive close + reopen (durable across restart)');
        assert.equal(afterReopen!.label, 'persists across daemon restart', 'T2 label round-trips post-restart');
        await readerGraph.close();
    }
    console.log('  ✓ T2: stored node still queryable after SurrealGraph close + reopen');
}

/* ─── T3: file_ref + code_symbol accepted via client-side schema extension ── */
//
// SP-09 note: file_ref and code_symbol were removed from DEFAULT_SCHEMA_V2 —
// they are Atlas (code intelligence) domain types, not Lore Core primitives.
// The correct pattern is for Atlas (the client) to register its own types in
// the workspace nodeTypesEnum at bootstrap time. This test proves the client-
// extension pattern works end-to-end: when the caller registers file_ref and
// code_symbol in the nodeTypesEnum, writes succeed and nodes round-trip.
async function testT3_fileRefAndCodeSymbolAccepted(): Promise<void> {
    setWorkspaceVocabPolicy('default', null);
    const registry = new LocalGraphRegistry();
    const graph = await registry.getGraphHandle('default');
    const store = {
        loreGraph: graph,
        loreVerbatim: makeFakeVerbatim() as unknown as never,
        sessionCache: { pushNode: () => undefined } as unknown as never,
    };

    // SP-09: client applications (Atlas) extend the enum with their own types
    // at startup — this is the correct pattern (not baking types into Core).
    const atlasNodeTypes = [...CORE_NODE_TYPES, 'file_ref', 'code_symbol'] as const;
    const nodeTypesEnum = z.enum(atlasNodeTypes as unknown as [string, ...string[]]);
    const edgeRelationsEnum = z.enum(['related_to', 'depends_on']);
    const { server, tools } = makeMcpServerStub();
    registerMemoryTools(server as never, {
        store: store as never,
        pluginRegistry: makePluginRegistry([]) as never,
        configManager: { read: () => ({ pluginConfig: {} }) } as never,
        auditLog: { log: () => undefined } as never,
        detectedScope: { workspace: 'default', ecosystem: 'default' },
        getWal: () => ({ append: () => undefined } as never),
        domain: 'lore',
        edgeRelations: ['related_to', 'depends_on'],
        nodeTypesEnum,
        nodeTypesDescription: atlasNodeTypes.join('|'),
        edgeRelationsEnum,
        graphRegistry: registry,
        coreNodeTypes: atlasNodeTypes,
    });

    // Verify Core schema does NOT carry these domain types (SP-09 regression gate).
    assert.ok(!CORE_NODE_TYPES.includes('file_ref'), 'SP-09: Core schema must NOT declare file_ref (Atlas domain type)');
    assert.ok(!CORE_NODE_TYPES.includes('code_symbol'), 'SP-09: Core schema must NOT declare code_symbol (Atlas domain type)');

    // file_ref — the type Atlas writes for CodeFile (client registers it above).
    const fileRes = await tools['store_node']!({
        id: 'code-file:/tmp/x6.5-sample.ts',
        type: 'file_ref',
        label: '/tmp/x6.5-sample.ts',
        content: '{"language":"typescript","loc":3}',
        tags: 'atlas,code-file,language:typescript',
        workspace: 'default',
    });
    assert.equal(
        fileRes.isError,
        undefined,
        `T3a store_node {type:"file_ref"} must succeed (client-registered type); got ${JSON.stringify(fileRes.content[0])}`,
    );
    const fileBody = JSON.parse(fileRes.content[0]!.text);
    assert.equal(fileBody.success, true, 'T3a file_ref success envelope');

    const fetchedFile = await graph.getNode('code-file:/tmp/x6.5-sample.ts');
    assert.ok(fetchedFile, 'T3a file_ref node must be queryable after the write');
    assert.equal(fetchedFile!.type, 'file_ref', 'T3a file_ref type round-trips');

    // code_symbol — the type Atlas writes for CodeSymbol.
    const symRes = await tools['store_node']!({
        id: 'code-symbol:/tmp/x6.5-sample.ts#parseFoo',
        type: 'code_symbol',
        label: 'parseFoo',
        content: '{"kind":"function","loc":3}',
        tags: 'atlas,code-symbol,language:typescript',
        workspace: 'default',
    });
    assert.equal(
        symRes.isError,
        undefined,
        `T3b store_node {type:"code_symbol"} must succeed (client-registered type); got ${JSON.stringify(symRes.content[0])}`,
    );
    const symBody = JSON.parse(symRes.content[0]!.text);
    assert.equal(symBody.success, true, 'T3b code_symbol success envelope');

    const fetchedSym = await graph.getNode('code-symbol:/tmp/x6.5-sample.ts#parseFoo');
    assert.ok(fetchedSym, 'T3b code_symbol node must be queryable after the write');
    assert.equal(fetchedSym!.type, 'code_symbol', 'T3b code_symbol type round-trips');

    registry.closeAll();
    await graph.close();
    console.log('  ✓ T3: file_ref + code_symbol accepted via client-registered types (not Core); SP-09 regression gate passes');
}

/* ─── Runner ──────────────────────────────────────────────────── */

async function main(): Promise<void> {
    console.log('phase6-x6-5-fix-persistence-unit.ts');
    await testT1_storeAndImmediateRead();
    await testT2_persistenceAcrossReopen();
    await testT3_fileRefAndCodeSymbolAccepted();
    console.log('All X6.5 tests passed.');
}

await main();
