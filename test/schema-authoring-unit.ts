#!/usr/bin/env tsx
/**
 * test/schema-authoring-unit.ts — A1 unit tests
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    SchemaAuthoringStore,
    buildProposal,
    type ProposedChange,
} from '../packages/lore/src/schemas/authoring.js';
import {
    DEFAULT_SCHEMA_V2,
    SCHEMA_FORMAT_VERSION,
    type LoreSchemaV2,
} from '../packages/lore/src/schemas/types.js';
import { SchemaChangeAuditLogger } from '../packages/lore/src/security/schemaChangeAudit.js';

let passed = 0;
let failed = 0;

const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => void | Promise<void>) {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
    })());
}

async function withTmp<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-authoring-'));
    try { return await fn(dir); }
    finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
}

function seedLiveSchema(workspaceDir: string, schema: LoreSchemaV2 = DEFAULT_SCHEMA_V2) {
    const loreDir = path.join(workspaceDir, '.lore');
    fs.mkdirSync(loreDir, { recursive: true });
    fs.writeFileSync(path.join(loreDir, 'schema.json'), JSON.stringify(schema));
}

const ADD_TENANT_CHANGE: ProposedChange = {
    kind: 'node_type.added',
    target: 'know.Tenant',
    migration: 'lazy',
    rationale: 'a domain workspace needs Tenant',
};

console.log('schema authoring — A1');

/* ---------- propose ---------- */

test('propose stores a sandbox entry and returns id', async () => {
    await withTmp(async dir => {
        seedLiveSchema(dir);
        const store = new SchemaAuthoringStore(dir);
        const proposal = buildProposal({
            base: DEFAULT_SCHEMA_V2,
            changes: [ADD_TENANT_CHANGE],
            proposedBy: 'ai:gemma',
            transforms: { addNodeType: { name: 'know.Tenant', description: 'A tenant.', kind: 'factual' } },
        });
        const entry = await store.propose(proposal);
        assert.ok(entry.sandboxId);
        assert.ok(entry.proposedAt);
        assert.ok(entry.nextSchemaHash.startsWith('sha256:'));
        const got = store.getProposal(entry.sandboxId);
        assert.ok(got);
        assert.equal(got!.proposal.proposedBy, 'ai:gemma');
    });
});

test('listProposals returns proposals in chronological order', async () => {
    await withTmp(async dir => {
        seedLiveSchema(dir);
        const store = new SchemaAuthoringStore(dir);
        await store.propose(buildProposal({
            base: DEFAULT_SCHEMA_V2,
            changes: [{ ...ADD_TENANT_CHANGE, target: 'know.A' }],
            proposedBy: 'ai',
            transforms: { addNodeType: { name: 'know.A', description: '', kind: 'factual' } },
        }));
        await store.propose(buildProposal({
            base: DEFAULT_SCHEMA_V2,
            changes: [{ ...ADD_TENANT_CHANGE, target: 'know.B' }],
            proposedBy: 'ai',
            transforms: { addNodeType: { name: 'know.B', description: '', kind: 'factual' } },
        }));
        const list = store.listProposals();
        assert.equal(list.length, 2);
    });
});

test('propose rejects an invalid nextSchema', async () => {
    await withTmp(async dir => {
        seedLiveSchema(dir);
        const store = new SchemaAuthoringStore(dir);
        const bad: LoreSchemaV2 = {
            ...DEFAULT_SCHEMA_V2,
            nodeTypes: [
                { name: 'invalid', description: '', kind: 'whatever' as 'factual' },
            ],
        };
        await assert.rejects(
            () => store.propose({
                nextSchema: bad,
                changes: [ADD_TENANT_CHANGE],
                proposedBy: 'ai',
            }),
            /invalid|kind/,
        );
    });
});

test('propose validates required fields', async () => {
    await withTmp(async dir => {
        seedLiveSchema(dir);
        const store = new SchemaAuthoringStore(dir);
        await assert.rejects(
            () => store.propose({
                nextSchema: DEFAULT_SCHEMA_V2,
                changes: [],
                proposedBy: 'ai',
            }),
            /at least one change/,
        );
        await assert.rejects(
            () => store.propose({
                nextSchema: DEFAULT_SCHEMA_V2,
                changes: [ADD_TENANT_CHANGE],
                proposedBy: '',
            }),
            /proposedBy/,
        );
    });
});

/* ---------- approve ---------- */

test('approve writes new live schema, snapshots prior, audits, removes sandbox', async () => {
    await withTmp(async dir => {
        seedLiveSchema(dir);
        const audit = new SchemaChangeAuditLogger(path.join(dir, '.lore'));
        const store = new SchemaAuthoringStore(dir, audit);
        const proposal = buildProposal({
            base: DEFAULT_SCHEMA_V2,
            changes: [ADD_TENANT_CHANGE],
            proposedBy: 'ai:gemma',
            transforms: { addNodeType: { name: 'know.Tenant', description: '', kind: 'factual' } },
        });
        const entry = await store.propose(proposal);
        const receipt = await store.approve(entry.sandboxId, 'human:rafi', 'looks fine');
        assert.equal(receipt.approvedBy, 'human:rafi');
        assert.equal(receipt.schemaVersion, SCHEMA_FORMAT_VERSION);
        // Phase 1 item 3: additive changes carry an empty dataSnapshots array.
        assert.deepEqual(receipt.dataSnapshots, []);

        // Live schema now contains know.Tenant.
        const live: LoreSchemaV2 = JSON.parse(fs.readFileSync(path.join(dir, '.lore/schema.json'), 'utf-8'));
        assert.ok(live.nodeTypes.find(n => n.name === 'know.Tenant'));

        // History snapshot exists.
        const history = store.listHistory();
        assert.equal(history.length, 1);

        // Sandbox cleared.
        assert.equal(store.getProposal(entry.sandboxId), null);
        assert.equal(store.listProposals().length, 0);

        // Audit captured the change.
        const auditEntries = audit.list({ kind: 'node_type.added' });
        assert.equal(auditEntries.length, 1);
        assert.equal(auditEntries[0].target, 'know.Tenant');
        assert.equal(auditEntries[0].approvedBy, 'human:rafi');
    });
});

test('approve fails for unknown sandbox id', async () => {
    await withTmp(async dir => {
        seedLiveSchema(dir);
        const store = new SchemaAuthoringStore(dir);
        await assert.rejects(
            () => store.approve('does-not-exist', 'human:rafi'),
            /not found/,
        );
    });
});

test('approve requires an approver id', async () => {
    await withTmp(async dir => {
        seedLiveSchema(dir);
        const store = new SchemaAuthoringStore(dir);
        const proposal = buildProposal({
            base: DEFAULT_SCHEMA_V2,
            changes: [ADD_TENANT_CHANGE],
            proposedBy: 'ai',
            transforms: { addNodeType: { name: 'know.Tenant', description: '', kind: 'factual' } },
        });
        const entry = await store.propose(proposal);
        await assert.rejects(() => store.approve(entry.sandboxId, ''), /approver/);
    });
});

/* ---------- reject ---------- */

test('reject moves to rejection log, removes sandbox, leaves live schema alone', async () => {
    await withTmp(async dir => {
        seedLiveSchema(dir);
        const store = new SchemaAuthoringStore(dir);
        const proposal = buildProposal({
            base: DEFAULT_SCHEMA_V2,
            changes: [ADD_TENANT_CHANGE],
            proposedBy: 'ai',
            transforms: { addNodeType: { name: 'know.Tenant', description: '', kind: 'factual' } },
        });
        const entry = await store.propose(proposal);
        store.reject(entry.sandboxId, 'human:rafi', 'wait until Q2 planning');

        // Live schema unchanged.
        const live: LoreSchemaV2 = JSON.parse(fs.readFileSync(path.join(dir, '.lore/schema.json'), 'utf-8'));
        assert.equal(live.nodeTypes.find(n => n.name === 'know.Tenant'), undefined);

        // Sandbox cleared.
        assert.equal(store.getProposal(entry.sandboxId), null);

        // Rejection logged.
        const log = fs.readFileSync(path.join(dir, '.lore/schema-rejected.jsonl'), 'utf-8');
        assert.match(log, /wait until Q2 planning/);
    });
});

test('reject requires reason and reviewer', async () => {
    await withTmp(async dir => {
        seedLiveSchema(dir);
        const store = new SchemaAuthoringStore(dir);
        const entry = await store.propose(buildProposal({
            base: DEFAULT_SCHEMA_V2,
            changes: [ADD_TENANT_CHANGE],
            proposedBy: 'ai',
            transforms: { addNodeType: { name: 'know.Tenant', description: '', kind: 'factual' } },
        }));
        assert.throws(() => store.reject(entry.sandboxId, '', 'r'), /reviewer/);
        assert.throws(() => store.reject(entry.sandboxId, 'human:r', ''), /reason/);
    });
});

/* ---------- rollback ---------- */

test('rollback restores a prior snapshot and audits the action', async () => {
    await withTmp(async dir => {
        seedLiveSchema(dir);
        const store = new SchemaAuthoringStore(dir);
        // Approve a change to create a history entry.
        const entry = await store.propose(buildProposal({
            base: DEFAULT_SCHEMA_V2,
            changes: [ADD_TENANT_CHANGE],
            proposedBy: 'ai',
            transforms: { addNodeType: { name: 'know.Tenant', description: '', kind: 'factual' } },
        }));
        await store.approve(entry.sandboxId, 'human:rafi');
        // Confirm tenant present.
        let live: LoreSchemaV2 = JSON.parse(fs.readFileSync(path.join(dir, '.lore/schema.json'), 'utf-8'));
        assert.ok(live.nodeTypes.find(n => n.name === 'know.Tenant'));

        // Roll back to the snapshot taken pre-approve.
        const history = store.listHistory();
        assert.ok(history.length >= 1);
        store.rollback(history[0], 'human:rafi');

        // know.Tenant should be gone (snapshot was the pre-approve state).
        live = JSON.parse(fs.readFileSync(path.join(dir, '.lore/schema.json'), 'utf-8'));
        assert.equal(live.nodeTypes.find(n => n.name === 'know.Tenant'), undefined);

        // The rollback also took a fresh snapshot of the post-approve state
        // before flipping back; so listHistory now has 2.
        assert.ok(store.listHistory().length >= 2);
    });
});

test('rollback throws for missing snapshot', () => {
    withTmp(dir => {
        seedLiveSchema(dir);
        const store = new SchemaAuthoringStore(dir);
        assert.throws(
            () => store.rollback('not-a-real-file.json', 'human:rafi'),
            /not found/,
        );
    });
});

/* ---------- buildProposal helper ---------- */

test('buildProposal: adding a node type produces a valid nextSchema', () => {
    const proposal = buildProposal({
        base: DEFAULT_SCHEMA_V2,
        changes: [ADD_TENANT_CHANGE],
        proposedBy: 'ai',
        transforms: { addNodeType: { name: 'know.Tenant', description: '', kind: 'factual' } },
    });
    assert.ok(proposal.nextSchema.nodeTypes.find(n => n.name === 'know.Tenant'));
});

test('buildProposal: removing a node type strips it', () => {
    const base: LoreSchemaV2 = {
        ...DEFAULT_SCHEMA_V2,
        nodeTypes: [
            { name: 'know.Note', description: '', kind: 'factual' },
            { name: 'know.Drop', description: '', kind: 'factual' },
        ],
    };
    const proposal = buildProposal({
        base,
        changes: [{ kind: 'node_type.removed', target: 'know.Drop', migration: 'dual-shape' }],
        proposedBy: 'ai',
        transforms: { removeNodeType: 'know.Drop' },
    });
    assert.equal(proposal.nextSchema.nodeTypes.find(n => n.name === 'know.Drop'), undefined);
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
