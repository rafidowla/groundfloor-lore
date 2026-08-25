#!/usr/bin/env tsx
/**
 * test/v30-phase-a-e2e.ts — V3.0-Personal Phase A end-to-end smoke.
 *
 * Exercises every Phase A module in concert against real disk and an
 * in-memory NodeStorage. Designed to surface wiring issues that pass
 * in isolation but fail when modules meet.
 *
 * Coverage:
 *
 *   1. Schema authoring: propose → approve → live schema updated.
 *   2. CRUD against the post-approval schema (a new node type works).
 *   3. Webhook receiver: signed payload triggers a handler that creates
 *      a CRUD record.
 *   4. Batch scheduler: a registered task fires CRUD writes.
 *   5. Promotion pipeline: high-confidence candidate auto-applies via
 *      storage; low-confidence queues to ClassificationExceptionQueue.
 *   6. Sync direction guard: cloud-only workspace refuses local persist.
 *   7. Multi-master sync: two-device LWW resolution with conflict log.
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    SchemaAuthoringStore,
    buildProposal,
} from '../packages/lore/src/schemas/authoring.js';
import {
    SchemaDrivenCrud,
    type NodeRecord,
    type NodeStorage,
} from '../packages/lore/src/engines/crud.js';
import {
    DEFAULT_SCHEMA_V2,
    SCHEMA_FORMAT_VERSION,
    type LoreSchemaV2,
} from '../packages/lore/src/schemas/types.js';
import {
    SchemaLoader,
} from '../packages/lore/src/schemas/loader.js';
import {
    WebhookReceiver,
    signWebhook,
} from '../packages/lore/src/engines/webhookReceiver.js';
import {
    BatchIngestionScheduler,
} from '../packages/lore/src/engines/batchScheduler.js';
import {
    PromotionPipeline,
    type PromotionStorage,
} from '../packages/lore/src/engines/promotionPipeline.js';
import {
    ClassificationAuditLogger,
} from '../packages/lore/src/security/classificationAudit.js';
import {
    ClassificationExceptionQueue,
} from '../packages/lore/src/security/classificationExceptionQueue.js';
import {
    SyncDirectionGuard,
    SyncPolicyError,
} from '../packages/lore/src/security/syncDirectionGuard.js';
import {
    ConflictLog,
    MultiMasterMerger,
} from '../packages/lore/src/engines/multiMasterSync.js';

let passed = 0;
let failed = 0;

function step(name: string, fn: () => Promise<void> | void) {
    return Promise.resolve()
        .then(() => fn())
        .then(
            () => { console.log(`  ✓ ${name}`); passed++; },
            (err: Error) => { console.error(`  ✗ ${name}\n    ${err.message}`); failed++; },
        );
}

class InMemoryNodeStorage implements NodeStorage {
    public records = new Map<string, NodeRecord>();
    async create(input: { id: string; type: string; workspace: string; fields: Record<string, unknown> }) {
        const r: NodeRecord = { id: input.id, type: input.type, workspace: input.workspace, fields: input.fields };
        this.records.set(input.id, r);
        return r;
    }
    async read(id: string) { return this.records.get(id) ?? null; }
    async update(id: string, fields: Record<string, unknown>) {
        const e = this.records.get(id);
        if (!e) return null;
        const u = { ...e, fields: { ...e.fields, ...fields } };
        this.records.set(id, u);
        return u;
    }
    async delete(id: string) { return this.records.delete(id); }
    async list(input: { type: string; workspace: string; limit?: number }) {
        const out: NodeRecord[] = [];
        for (const r of this.records.values()) {
            if (r.type === input.type && r.workspace === input.workspace) out.push(r);
            if (input.limit && out.length >= input.limit) break;
        }
        return out;
    }
}

class FakePromotionStorage implements PromotionStorage {
    public created: Array<{ id: string; type: string }> = [];
    public edges: Array<{ source: string; target: string }> = [];
    private nextId = 1;
    async createFactualNode(input: { type: string }) {
        const id = `auto-${this.nextId++}`;
        this.created.push({ id, type: input.type });
        return { id };
    }
    async addSupportsEdges(input: { sourceIds: string[]; targetId: string }) {
        for (const s of input.sourceIds) this.edges.push({ source: s, target: input.targetId });
    }
}

const PERSONAL_BASE: LoreSchemaV2 = {
    ...DEFAULT_SCHEMA_V2,
    domain: 'Personal',
    description: 'V3.0-Personal seed schema',
    nodeTypes: [
        { name: 'know.Note', description: 'A note.', kind: 'factual',
            fields: [{ name: 'title', type: 'string', required: true }, { name: 'body', type: 'string' }] },
        { name: 'know.Person', description: 'A person.', kind: 'factual',
            fields: [{ name: 'name', type: 'string', required: true }] },
        { name: 'mem.Conversation', description: 'A chat.', kind: 'episodic', appendOnly: true },
    ],
};

async function main() {
    console.log('V3.0-Personal Phase A e2e — modules in concert');

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-v30a-e2e-'));
    process.on('exit', () => {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    /* ---------- 1) schema authoring → approve → loader picks up ---------- */

    // Seed live schema.
    const loreDir = path.join(tmp, '.lore');
    fs.mkdirSync(loreDir, { recursive: true });
    fs.writeFileSync(path.join(loreDir, 'schema.json'), JSON.stringify(PERSONAL_BASE));

    const authoring = new SchemaAuthoringStore(tmp);
    const sandbox = await authoring.propose(buildProposal({
        base: PERSONAL_BASE,
        changes: [{ kind: 'node_type.added', target: 'know.Project', migration: 'lazy' }],
        proposedBy: 'ai:gemma',
        transforms: {
            addNodeType: {
                name: 'know.Project', description: 'A project.', kind: 'factual',
                fields: [{ name: 'name', type: 'string', required: true }],
            },
        },
    }));
    await authoring.approve(sandbox.sandboxId, 'human:rafi');

    await step('schema authoring: propose + approve writes new live schema with know.Project', () => {
        const loader = new SchemaLoader(tmp);
        const v2 = loader.getV2();
        assert.ok(v2.nodeTypes.find(n => n.name === 'know.Project'));
    });

    /* ---------- 2) CRUD against post-approval schema ---------- */

    const storage = new InMemoryNodeStorage();
    const loader = new SchemaLoader(tmp);
    const crud = new SchemaDrivenCrud(loader.getV2(), storage);

    await step('CRUD: create know.Project after schema evolution', async () => {
        const node = await crud.create('know.Project', { name: 'Lore V3' }, {
            subject: 'user:rafi', workspace: 'personal',
        });
        assert.equal(node.fields.name, 'Lore V3');
        assert.equal(node.fields.kind, 'factual');
        assert.equal(node.type, 'know.Project');
    });

    await step('CRUD: enforces append-only on episodic types', async () => {
        const c = await crud.create('mem.Conversation', {}, {
            subject: 'user:rafi', workspace: 'personal',
        });
        await assert.rejects(
            () => crud.update(c.id, { something: 'else' }, { subject: 'user:rafi', workspace: 'personal' }),
            /append-only/,
        );
    });

    /* ---------- 3) webhook receiver → CRUD handler ---------- */

    const SECRET = 'phase-a-webhook-secret';
    const webhook = new WebhookReceiver();
    webhook.register('gmail-stub', {
        secret: SECRET,
        handler: async (payload) => {
            const p = payload as { from: string };
            await crud.create('know.Note', { title: `Email from ${p.from}`, body: 'fake email body' }, {
                subject: 'connector:gmail-stub', workspace: 'personal',
            });
        },
    });

    await step('webhook: signed payload triggers CRUD create', async () => {
        const before = storage.records.size;
        const body = JSON.stringify({ from: 'alice@example.com' });
        const result = await webhook.receive({
            source: 'gmail-stub', rawBody: body,
            headers: { 'x-lore-signature': signWebhook(SECRET, body), 'x-lore-delivery': 'd-1' },
        });
        assert.equal(result.status, 202);
        assert.equal(storage.records.size, before + 1);
    });

    await step('webhook: bad signature → 401, no CRUD write', async () => {
        const before = storage.records.size;
        const result = await webhook.receive({
            source: 'gmail-stub', rawBody: '{"x":1}',
            headers: { 'x-lore-signature': 'sha256=tampered', 'x-lore-delivery': 'd-2' },
        });
        assert.equal(result.status, 401);
        assert.equal(storage.records.size, before);
    });

    /* ---------- 4) batch scheduler → CRUD ---------- */

    await step('batch scheduler: runOnce drives a CRUD task', async () => {
        const sched = new BatchIngestionScheduler();
        let ran = 0;
        sched.register({
            name: 'note-creator', intervalMs: 1000,
            task: async () => {
                ran++;
                await crud.create('know.Note', { title: `auto-${ran}` }, {
                    subject: 'scheduler:test', workspace: 'personal',
                });
            },
        });
        const before = storage.records.size;
        await sched.runOnce('note-creator');
        await sched.runOnce('note-creator');
        assert.equal(ran, 2);
        assert.equal(storage.records.size, before + 2);
    });

    /* ---------- 5) promotion pipeline ---------- */

    const promoStorage = new FakePromotionStorage();
    const classAudit = new ClassificationAuditLogger(loreDir);
    const exQueue = new ClassificationExceptionQueue(loreDir);
    const pipeline = new PromotionPipeline(promoStorage, classAudit, exQueue);

    await step('promotion pipeline: high-confidence candidate auto-applies', async () => {
        const result = await pipeline.submit({
            workspace: 'personal',
            proposedNodeType: 'know.Person',
            proposedFields: { name: 'Alice' },
            inputFingerprint: 'fp:alice',
            confidence: 0.95,
            decidedBy: 'ai:gemma',
            supports: ['mem-1', 'mem-2'],
        });
        assert.equal(result.kind, 'auto-applied');
        assert.equal(promoStorage.created.length, 1);
        assert.equal(promoStorage.edges.length, 2);
    });

    await step('promotion pipeline: low-confidence candidate queues for review', async () => {
        const result = await pipeline.submit({
            workspace: 'personal',
            proposedNodeType: 'know.Person',
            proposedFields: { name: 'Maybe-Bob' },
            inputFingerprint: 'fp:maybe-bob',
            confidence: 0.40,
            decidedBy: 'ai:gemma',
            supports: ['mem-3'],
        });
        assert.equal(result.kind, 'queued-exception');
        assert.equal(exQueue.counts().open, 1);
    });

    /* ---------- 6) sync direction guard ---------- */

    const guard = new SyncDirectionGuard();
    guard.register({ workspace: 'personal', policy: 'local-first' });
    guard.register({ workspace: 'cre-acme', policy: 'cloud-only' });

    await step('sync guard: personal allows persist + sync-down', () => {
        guard.assertCanPersistLocally({ workspace: 'personal' });
        guard.assertCanSyncDown('personal');
    });

    await step('sync guard: cre-acme refuses persist + sync-down (the hard rule)', () => {
        assert.throws(() => guard.assertCanPersistLocally({ workspace: 'cre-acme' }), SyncPolicyError);
        assert.throws(() => guard.assertCanSyncDown('cre-acme'), SyncPolicyError);
        // In-flight is still allowed.
        guard.assertCanReadInFlight('cre-acme');
    });

    /* ---------- 7) multi-master sync ---------- */

    const conflictLog = new ConflictLog(loreDir);
    const merger = new MultiMasterMerger(conflictLog);

    await step('multi-master sync: two-device edit, newer wallclock wins, conflict logged', () => {
        const result = merger.applyBatch(
            { nodeId: 'note-1', fields: {}, lastWrite: {} },
            [
                { nodeId: 'note-1', field: 'title', value: 'phone version', wallClockMs: 1000, lamport: 1, deviceId: 'phone' },
                { nodeId: 'note-1', field: 'title', value: 'laptop version', wallClockMs: 2000, lamport: 1, deviceId: 'laptop' },
            ],
        );
        assert.equal(result.state.fields.title, 'laptop version');
        assert.equal(result.conflictsResolved, 1);
        assert.ok(conflictLog.count() >= 1);
    });

    /* ---------- summary ---------- */

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main().catch(err => {
    console.error('e2e crashed:', err);
    process.exit(1);
});
