#!/usr/bin/env tsx
/**
 * test/promotion-pipeline-unit.ts — A5 unit tests
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    PromotionPipeline,
    type PromotionCandidate,
    type PromotionStorage,
} from '../packages/lore/src/engines/promotionPipeline.js';
import { ClassificationAuditLogger } from '../packages/lore/src/security/classificationAudit.js';
import { ClassificationExceptionQueue } from '../packages/lore/src/security/classificationExceptionQueue.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => Promise<void> | void) {
    return Promise.resolve()
        .then(() => fn())
        .then(
            () => { console.log(`  ✓ ${name}`); passed++; },
            (err: Error) => { console.error(`  ✗ ${name}\n    ${err.message}`); failed++; },
        );
}

function withTmp<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-promo-'));
    return Promise.resolve()
        .then(() => fn(dir))
        .finally(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
}

class FakePromotionStorage implements PromotionStorage {
    public created: Array<{ id: string; type: string; fields: Record<string, unknown> }> = [];
    public edges: Array<{ source: string; target: string }> = [];
    private nextId = 1;
    async createFactualNode(input: { workspace: string; type: string; fields: Record<string, unknown> }) {
        const id = `node-${this.nextId++}`;
        this.created.push({ id, type: input.type, fields: input.fields });
        return { id };
    }
    async addSupportsEdges(input: { sourceIds: string[]; targetId: string }) {
        for (const s of input.sourceIds) this.edges.push({ source: s, target: input.targetId });
    }
}

const HIGH: PromotionCandidate = {
    workspace: 'personal',
    proposedNodeType: 'know.Person',
    proposedFields: { name: 'Alice', email: 'alice@example.com' },
    inputFingerprint: 'fp:alice',
    confidence: 0.95,
    decidedBy: 'ai:gemma',
    supports: ['mem-1', 'mem-2'],
    reasoning: 'name and email co-occur in 7 conversations',
};

const LOW: PromotionCandidate = { ...HIGH, confidence: 0.42, inputFingerprint: 'fp:low' };

async function main() {
    console.log('promotion pipeline — A5');

    /* ---------- auto-apply ---------- */

    await test('confidence >= threshold: auto-apply, edges added, audit routed', async () => {
        await withTmp(async (dir) => {
            const storage = new FakePromotionStorage();
            const audit = new ClassificationAuditLogger(dir);
            const exQueue = new ClassificationExceptionQueue(dir);
            const pipeline = new PromotionPipeline(storage, audit, exQueue);
            const result = await pipeline.submit(HIGH);
            assert.equal(result.kind, 'auto-applied');
            if (result.kind === 'auto-applied') {
                assert.equal(result.confidence, 0.95);
                assert.ok(result.nodeId);
            }
            assert.equal(storage.created.length, 1);
            assert.equal(storage.created[0].type, 'know.Person');
            assert.equal(storage.edges.length, 2);
            const a = audit.list();
            assert.equal(a.length, 1);
            assert.equal(a[0].outcome, 'routed');
            assert.equal(a[0].kind, 'factual');
        });
    });

    /* ---------- below threshold queues ---------- */

    await test('confidence < threshold: enqueues to exception queue, audit queued-exception', async () => {
        await withTmp(async (dir) => {
            const storage = new FakePromotionStorage();
            const audit = new ClassificationAuditLogger(dir);
            const exQueue = new ClassificationExceptionQueue(dir);
            const pipeline = new PromotionPipeline(storage, audit, exQueue);
            const result = await pipeline.submit(LOW);
            assert.equal(result.kind, 'queued-exception');
            assert.equal(storage.created.length, 0, 'no factual node created');
            assert.equal(exQueue.counts().open, 1);
            const a = audit.list();
            assert.equal(a.length, 1);
            assert.equal(a[0].outcome, 'queued-exception');
        });
    });

    /* ---------- low + queue disabled drops ---------- */

    await test('confidence < threshold + queue disabled: drops with audit', async () => {
        await withTmp(async (dir) => {
            const storage = new FakePromotionStorage();
            const audit = new ClassificationAuditLogger(dir);
            const exQueue = new ClassificationExceptionQueue(dir);
            const pipeline = new PromotionPipeline(storage, audit, exQueue, {
                autoApplyThreshold: 0.90,
                enqueueOnLowConfidence: false,
            });
            const result = await pipeline.submit(LOW);
            assert.equal(result.kind, 'dropped');
            assert.equal(storage.created.length, 0);
            assert.equal(exQueue.counts().open, 0);
            const a = audit.list();
            assert.equal(a[0].outcome, 'dropped');
        });
    });

    /* ---------- threshold tuning ---------- */

    await test('reconfigure: lowering threshold lets borderline candidates auto-apply', async () => {
        await withTmp(async (dir) => {
            const storage = new FakePromotionStorage();
            const audit = new ClassificationAuditLogger(dir);
            const exQueue = new ClassificationExceptionQueue(dir);
            const pipeline = new PromotionPipeline(storage, audit, exQueue);
            const candidate: PromotionCandidate = { ...HIGH, confidence: 0.7, inputFingerprint: 'fp:mid' };

            const r1 = await pipeline.submit(candidate);
            assert.equal(r1.kind, 'queued-exception', 'at default 0.9, 0.7 queues');

            pipeline.reconfigure({ autoApplyThreshold: 0.5 });
            const r2 = await pipeline.submit({ ...candidate, inputFingerprint: 'fp:mid-2' });
            assert.equal(r2.kind, 'auto-applied', 'after lowering to 0.5, 0.7 auto-applies');
        });
    });

    /* ---------- validation ---------- */

    await test('submit validates required fields', async () => {
        await withTmp(async (dir) => {
            const storage = new FakePromotionStorage();
            const audit = new ClassificationAuditLogger(dir);
            const exQueue = new ClassificationExceptionQueue(dir);
            const pipeline = new PromotionPipeline(storage, audit, exQueue);
            await assert.rejects(() => pipeline.submit({ ...HIGH, workspace: '' }), /workspace/);
            await assert.rejects(() => pipeline.submit({ ...HIGH, proposedNodeType: '' }), /proposedNodeType/);
            await assert.rejects(() => pipeline.submit({ ...HIGH, decidedBy: '' }), /decidedBy/);
            await assert.rejects(() => pipeline.submit({ ...HIGH, confidence: 1.5 }), /confidence/);
            await assert.rejects(() => pipeline.submit({ ...HIGH, confidence: -0.1 }), /confidence/);
        });
    });

    /* ---------- supports edges + provenance ---------- */

    await test('supports edges added with correct sources after auto-apply', async () => {
        await withTmp(async (dir) => {
            const storage = new FakePromotionStorage();
            const audit = new ClassificationAuditLogger(dir);
            const exQueue = new ClassificationExceptionQueue(dir);
            const pipeline = new PromotionPipeline(storage, audit, exQueue);
            await pipeline.submit({ ...HIGH, supports: ['mem-A', 'mem-B', 'mem-C'] });
            assert.equal(storage.edges.length, 3);
            const sources = storage.edges.map(e => e.source).sort();
            assert.deepEqual(sources, ['mem-A', 'mem-B', 'mem-C']);
        });
    });

    await test('curator can resolve a queued candidate via the exception queue', async () => {
        await withTmp(async (dir) => {
            const storage = new FakePromotionStorage();
            const audit = new ClassificationAuditLogger(dir);
            const exQueue = new ClassificationExceptionQueue(dir);
            const pipeline = new PromotionPipeline(storage, audit, exQueue);
            const result = await pipeline.submit(LOW);
            if (result.kind !== 'queued-exception') throw new Error('expected queued');
            const open = exQueue.listOpen();
            assert.equal(open.length, 1);
            assert.equal(open[0].guess.proposedNodeType, 'know.Person');
            // Curator approves.
            const rec = exQueue.resolve({
                entryId: result.entryId,
                resolvedAt: new Date().toISOString(),
                resolvedBy: 'human:rafi',
                decision: 'route',
                finalKind: 'factual',
                finalNodeType: 'know.Person',
            });
            assert.equal(rec.entry.id, result.entryId);
            assert.deepEqual(exQueue.counts(), { open: 0, resolved: 1 });
        });
    });

    /* ---------- audit failure does not block pipeline ---------- */

    await test('audit failure does not break the pipeline', async () => {
        await withTmp(async (dir) => {
            const storage = new FakePromotionStorage();
            const audit = new ClassificationAuditLogger(dir);
            // Sabotage audit by replacing append with a thrower.
            (audit as { append: (e: unknown) => void }).append = () => { throw new Error('audit boom'); };
            const exQueue = new ClassificationExceptionQueue(dir);
            const pipeline = new PromotionPipeline(storage, audit, exQueue);
            const result = await pipeline.submit(HIGH);
            assert.equal(result.kind, 'auto-applied');
        });
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main().catch(err => {
    console.error('test runner crashed:', err);
    process.exit(1);
});
