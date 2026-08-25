#!/usr/bin/env tsx
/**
 * test/v25-e2e.ts — V2.5 end-to-end smoke.
 *
 * Exercises every V2.5 module in concert against a real embedded SurrealDB
 * graph (the default engine since the Kùzu removal), real disk, real
 * interactions. Not a unit test — the point is to catch wiring issues that
 * pass in isolation but fail when modules meet.
 *
 * Coverage:
 *   - Schema floor + V2 schema persistence (loader)
 *   - Schema describe / summarize
 *   - SurrealGraph startup through the LoreGraphHandle surface
 *   - ReBAC L1 grant + L2 permission check (the canonical
 *     two-property-managers scenario; tuples live in .lore/rebac.sqlite,
 *     endpoint validation injected from the graph handle)
 *   - Scope resolver over the same RebacStore the evaluator reads
 *   - Classification audit + schema-change audit (real disk JSONL)
 *   - Exception queue (real disk JSONL with resolve flow)
 *   - Dedupe engine with provenance threading
 *   - Connector registry audit listener
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import type { LoreNode } from '../packages/lore/src/providers/types.js';
import { SchemaLoader } from '../packages/lore/src/schemas/loader.js';
import {
    DEFAULT_SCHEMA_V2,
    REBAC_RELATION_EDGES,
    SCHEMA_FORMAT_VERSION,
    type LoreSchemaV2,
} from '../packages/lore/src/schemas/types.js';
import {
    describeSchema,
    summarizeSchema,
} from '../packages/lore/src/schemas/describe.js';
import { RebacStore } from '../packages/lore/src/security/rebac.js';
import { RebacEvaluator } from '../packages/lore/src/security/rebacEvaluator.js';
import {
    ScopeResolver,
    type ScopeGraphAccessor,
} from '../packages/lore/src/engines/scopeResolver.js';
import {
    ClassificationAuditLogger,
} from '../packages/lore/src/security/classificationAudit.js';
import {
    SchemaChangeAuditLogger,
} from '../packages/lore/src/security/schemaChangeAudit.js';
import {
    ClassificationExceptionQueue,
} from '../packages/lore/src/security/classificationExceptionQueue.js';
import {
    DedupeEngine,
    Fingerprinters,
} from '../packages/lore/src/engines/dedupe.js';
import {
    ConnectorRegistry,
} from '../packages/lore/src/engines/connectors/registry.js';
import {
    type ConnectorAuditEvent,
    type ConnectorItem,
    type ConnectorNativeSchema,
    type ConnectorStatus,
    type IConnector,
} from '../packages/lore/src/engines/connectors/types.js';
import {
    aggregate,
    forConnectorItem,
    merge as mergeProvenance,
} from '../packages/lore/src/engines/provenance.js';

let passed = 0;
let failed = 0;

function step(name: string, fn: () => Promise<void> | void) {
    return Promise.resolve()
        .then(() => fn())
        .then(
            () => { console.log(`  ✓ ${name}`); passed++; },
            (err: Error) => {
                console.error(`  ✗ ${name}\n    ${err.message}`);
                failed++;
            },
        );
}

const NOW = new Date().toISOString();

const DOMAIN_SCHEMA: LoreSchemaV2 = {
    version: SCHEMA_FORMAT_VERSION,
    domain: 'workspace-a',
    description: 'A domain workspace',
    nodeTypes: [
        { name: 'property', description: 'A real-estate property.', kind: 'factual' },
        { name: 'lease', description: 'A lease contract.', kind: 'factual' },
        { name: 'unit', description: 'A leasable unit within a property.', kind: 'factual' },
        { name: 'conversation', description: 'A user conversation.', kind: 'episodic', appendOnly: true },
    ],
    edgeTypes: [
        ...REBAC_RELATION_EDGES,
        { name: 'leases_unit', description: 'Lease covers a Unit.' },
    ],
    permissions: {
        property: {
            view: 'viewer | editor | owner',
            approve_ticket: 'editor | owner',
            transfer_owner: 'owner',
        },
    },
    scopes: {
        'property-and-children': {
            viaEdges: ['parent'],
            direction: 'down',
            description: 'A property and every node whose parent chain leads back to it.',
        },
    },
    systemPrompt: 'You are a domain assistant.',
};

class StubConnector implements IConnector {
    readonly name = 'e2e-stub';
    readonly version = '1.0.0';
    readonly displayName = 'E2E Stub';
    readonly description = 'Test connector for the V2.5 e2e.';
    constructor(private readonly items: ConnectorItem[]) { }
    isAuthenticated(): boolean { return true; }
    getNativeSchema(): ConnectorNativeSchema {
        return {
            types: [{
                name: 'StubRecord', description: 'A test record.',
                fields: [
                    { name: 'id', type: 'string', required: true },
                    { name: 'value', type: 'string' },
                ],
            }],
            proposedMapping: { StubRecord: 'know.Note' },
        };
    }
    async *sync(): AsyncIterable<ConnectorItem> { for (const i of this.items) yield i; }
    getStatus(): ConnectorStatus { return { connected: true }; }
}

async function seedNode(
    graph: Pick<SurrealGraph, 'upsertNode'>,
    id: string,
): Promise<void> {
    // Through the public handle surface — the same path production ingest
    // takes. (The old version hand-wrote Kùzu Cypher, which bit-rotted when
    // the engine's column types changed.)
    await graph.upsertNode({
        id, type: 'subject', label: id, content: '',
        tags: [], project: '*', ecosystem: '*', metadata: '{}',
    } satisfies Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>);
}
async function main() {
    console.log('V2.5 e2e — all modules in concert');

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-v25-e2e-'));
    const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } };
    process.on('exit', cleanup);

    /* ---------- schema loader + describer ---------- */

    const loreDir = path.join(tmp, '.lore');
    fs.mkdirSync(loreDir, { recursive: true });
    fs.writeFileSync(path.join(loreDir, 'schema.json'), JSON.stringify(DOMAIN_SCHEMA));

    const schemaLoader = new SchemaLoader(tmp);
    const v2 = schemaLoader.getV2();

    await step('schema loader: V2 round-trip', () => {
        assert.equal(v2.domain, 'workspace-a');
        assert.equal(v2.nodeTypes.find(n => n.name === 'conversation')?.kind, 'episodic');
        assert.ok(v2.scopes?.['property-and-children']);
    });

    await step('schema describer: counts + summary', () => {
        const d = describeSchema(v2);
        assert.equal(d.counts.episodicNodeTypes, 1);
        assert.equal(d.counts.factualNodeTypes, 3);
        assert.equal(d.counts.permissionActions, 3);
        const s = summarizeSchema(v2);
        assert.match(s, /workspace-a workspace/);
        assert.match(s, /3 actions across 1 resource type/);
    });

    /* ---------- SurrealGraph + ReBAC L1+L2 against the real engine ---------- */

    const graph = new SurrealGraph(tmp, { workspaceId: 'v25-e2e' });
    await graph.initialize();

    // ReBAC L1 lives in .lore/rebac.sqlite; endpoint validation is INJECTED
    // and backed by whatever engine the workspace actually runs — here the
    // same handle above, exactly how the registry wires it in production.
    const rebacStore = new RebacStore(
        path.join(tmp, '.lore', 'rebac.sqlite'),
        async (ids) => {
            const found = new Set<string>();
            for (const id of ids) if (await graph.getNode(id)) found.add(id);
            return found;
        },
    );
    await rebacStore.ensureSchema();

    // Subjects (alice, bob) and resources (pA, pB, leaseA, leaseB).
    for (const id of ['alice', 'bob', 'pA', 'pB', 'leaseA', 'leaseB']) {
        await seedNode(graph, id);
    }

    await rebacStore.grant({ subject: 'alice', relation: 'editor', resource: 'pA', grantedBy: 'system' });
    await rebacStore.grant({ subject: 'bob', relation: 'editor', resource: 'pB', grantedBy: 'system' });
    await rebacStore.grant({ subject: 'leaseA', relation: 'parent', resource: 'pA', grantedBy: 'system' });
    await rebacStore.grant({ subject: 'leaseB', relation: 'parent', resource: 'pB', grantedBy: 'system' });

    const evaluator = new RebacEvaluator(rebacStore, v2);

    await step('rebac L2 e2e: Alice can approve_ticket on PropertyA', async () => {
        const r = await evaluator.check({
            subject: 'alice', action: 'approve_ticket', resource: 'pA', resourceType: 'property',
        });
        assert.equal(r.allowed, true);
    });

    await step('rebac L2 e2e: Alice CANNOT transfer_owner on PropertyA (editor != owner)', async () => {
        const r = await evaluator.check({
            subject: 'alice', action: 'transfer_owner', resource: 'pA', resourceType: 'property',
        });
        assert.equal(r.allowed, false);
    });

    await step('rebac L2 e2e: Alice can approve_ticket on leaseA via parent inheritance', async () => {
        const r = await evaluator.check({
            subject: 'alice', action: 'approve_ticket', resource: 'leaseA', resourceType: 'property',
        });
        assert.equal(r.allowed, true);
    });

    await step("rebac L2 e2e: Alice cannot reach Bob's leaseB", async () => {
        const r = await evaluator.check({
            subject: 'alice', action: 'approve_ticket', resource: 'leaseB', resourceType: 'property',
        });
        assert.equal(r.allowed, false);
    });

    /* ---------- scope resolver over the ReBAC substrate ---------- */

    // The resolver is substrate-agnostic; the accessor it gets here reads the
    // same .lore/rebac.sqlite tuples the evaluator does. (The old version
    // read Kùzu's LoreRebacEdge mirror of those tuples — a table the engine
    // no longer creates.)
    const rebacAccessor: ScopeGraphAccessor = {
        async neighborsOut(id, edgeTypes) {
            const grants = await rebacStore.listSubjectGrants(id);
            return grants.filter(g => edgeTypes.includes(g.relation)).map(g => g.resource);
        },
        async neighborsIn(id, edgeTypes) {
            const grants = await rebacStore.listResourceGrants(id);
            return grants.filter(g => edgeTypes.includes(g.relation)).map(g => g.subject);
        },
    };
    const scopeResolver = new ScopeResolver(rebacAccessor);

    await step('scope resolver e2e: down from PropertyA collects leaseA only (not leaseB)', async () => {
        const r = await scopeResolver.resolve({
            rootId: 'pA', scopeName: 'property-and-children', schema: v2,
        });
        assert.ok(r.ids.includes('pA'));
        assert.ok(r.ids.includes('leaseA'));
        assert.ok(!r.ids.includes('leaseB'));
        assert.ok(!r.ids.includes('pB'));
    });

    /* ---------- classification audit + schema-change audit ---------- */

    const classAudit = new ClassificationAuditLogger(loreDir);
    classAudit.append({
        at: NOW, workspace: 'workspace-a',
        inputFingerprint: 'fp:1', sourceId: 'filesystem:/tmp/foo.txt', connector: 'filesystem',
        decidedBy: 'rule:default-text', outcome: 'routed',
        kind: 'factual', nodeType: 'note',
    });
    classAudit.append({
        at: NOW, workspace: 'workspace-a',
        inputFingerprint: 'fp:2', decidedBy: 'ai:gemma',
        confidence: 0.55, outcome: 'queued-exception',
    });

    await step('classification audit e2e: round-trip + filter', () => {
        assert.equal(classAudit.count(), 2);
        assert.equal(classAudit.list({ outcome: 'queued-exception' }).length, 1);
    });

    const schemaAudit = new SchemaChangeAuditLogger(loreDir);
    schemaAudit.append({
        at: NOW, workspace: 'workspace-a', schemaVersionAfter: SCHEMA_FORMAT_VERSION,
        kind: 'node_type.added', target: 'know.Lease',
        proposedBy: 'ai:gemma', approvedBy: 'human:rafi', migration: 'lazy',
    });

    await step('schema-change audit e2e: write + filter', () => {
        const got = schemaAudit.list({ kind: 'node_type.added' });
        assert.equal(got.length, 1);
        assert.equal(got[0].target, 'know.Lease');
    });

    /* ---------- exception queue ---------- */

    const exQueue = new ClassificationExceptionQueue(loreDir);
    exQueue.enqueue({
        id: 'ex-1', at: NOW, workspace: 'workspace-a',
        inputFingerprint: 'fp:2',
        guess: { decidedBy: 'ai:gemma', confidence: 0.55, proposedKind: 'factual', proposedNodeType: 'know.Lease' },
        sample: { value: 'unsure' },
    });

    await step('exception queue e2e: enqueue + resolve', () => {
        assert.equal(exQueue.counts().open, 1);
        const rec = exQueue.resolve({
            entryId: 'ex-1', resolvedAt: NOW, resolvedBy: 'human:rafi',
            decision: 'route', finalKind: 'factual', finalNodeType: 'know.Lease',
        });
        assert.equal(rec.entry.id, 'ex-1');
        assert.deepEqual(exQueue.counts(), { open: 0, resolved: 1 });
    });

    /* ---------- dedupe + provenance ---------- */

    const store = new Map<string, { id: string; fields: Record<string, unknown> }>();
    const fpIndex = new Map<string, string>();
    const dedupe = new DedupeEngine(
        async (workspace, type, fp) => {
            const id = fpIndex.get(`${workspace}::${type}::${fp}`);
            if (!id) return null;
            return store.get(id)!;
        },
        async (input) => {
            store.set(input.id, { id: input.id, fields: { ...input.fields } });
            if (input.fingerprint) {
                fpIndex.set(`${input.workspace}::${input.type}::${input.fingerprint}`, input.id);
            }
        },
    );
    dedupe.register('know.Lease', Fingerprinters.bySourceId);

    const r1 = await dedupe.ingest({
        type: 'know.Lease', workspace: 'workspace-a',
        fields: { rentMonthly: 5000, propertyId: 'pA' },
        source: { connector: 'yardi', sourceId: 'lease/123' },
    });
    const r2 = await dedupe.ingest({
        type: 'know.Lease', workspace: 'workspace-a',
        fields: { rentMonthly: 5500, propertyId: 'pA' },
        source: { connector: 'yardi', sourceId: 'lease/123' },
    });

    await step('dedupe e2e: same sourceId, different value → merge with changedFields', () => {
        assert.equal(r1.action, 'created');
        assert.equal(r2.action, 'merged');
        assert.equal(r2.id, r1.id);
        assert.deepEqual(r2.mergedFields, ['rentMonthly']);
    });

    await step('provenance e2e: build + merge + aggregate', () => {
        const p1 = forConnectorItem('yardi', { sourceId: 'lease/123' });
        const p2 = forConnectorItem('mri', { sourceId: 'lease/abc' });
        const merged = mergeProvenance(p1, p2);
        assert.ok(merged.transformChain?.some(s => s.startsWith('merged-from:')));

        const agg = aggregate({
            storesHit: ['graph', 'vector'],
            contributions: [
                { nodeId: 'leaseA', provenance: p1 },
                { nodeId: 'leaseA', provenance: p2 },
                { nodeId: 'leaseB', provenance: p1 },
            ],
        });
        assert.equal(agg.sources.length, 2);
        assert.deepEqual(agg.storesHit, ['graph', 'vector']);
    });

    /* ---------- connector registry audit listener ---------- */

    const reg = new ConnectorRegistry();
    const events: ConnectorAuditEvent[] = [];
    reg.addAuditListener(e => events.push(e));
    reg.register(new StubConnector([
        { sourceId: 'stub:1', mimeType: 'text/plain', content: Buffer.from('hello'), metadata: {}, modifiedAt: NOW },
        { sourceId: 'stub:2', mimeType: 'text/plain', content: Buffer.from('world'), metadata: {}, modifiedAt: NOW },
    ]));
    const yielded: ConnectorItem[] = [];
    for await (const item of reg.syncOne('e2e-stub')) yielded.push(item);

    await step('connector registry e2e: audit emits start → item* → complete', () => {
        assert.equal(yielded.length, 2);
        const kinds = events.map(e => e.kind);
        assert.deepEqual(kinds, ['sync.start', 'sync.item', 'sync.item', 'sync.complete']);
    });

    await step('connector registry e2e: healthOf + listStatus expose version', async () => {
        const h = await reg.healthOf('e2e-stub');
        assert.equal(h.ok, true);
        const status = reg.listStatus();
        assert.equal(status[0].version, '1.0.0');
    });

    /* ---------- defaults sanity ---------- */

    await step('default schema validates (regression)', () => {
        const d = describeSchema(DEFAULT_SCHEMA_V2);
        assert.equal(d.counts.rebacRelationEdges, 5);
    });

    // Release the substrate handles we opened (SurrealDB holds a store lock;
    // better-sqlite3 a file handle).
    rebacStore.close();
    await graph.close();

    /* ---------- summary ---------- */

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main().catch(err => {
    console.error('e2e crashed:', err);
    process.exit(1);
});
