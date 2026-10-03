#!/usr/bin/env tsx
/**
 * cloud-node-shape-unit.ts — cloud parity Slice B item 6 (D5): the cloud lore_node row
 * persists the FULL LoreNode shape (snake_case columns), and reading it back drops nothing.
 * Also: supersede/unsupersede + mark-stale use the snake_case columns, absent fields are
 * omitted (never null), partial re-upserts merge like local, the v2 schema is declared, and
 * a pre-existing v1 collection surfaces `cloud_schema_drift` (F8) without losing data.
 */
import assert from 'node:assert/strict';
import { startCloudFixture, DP_WORKSPACE, FIXTURE_CONNECTION } from './helpers/cloud-stores-fixture.js';
import type { LoreNode } from '../packages/lore/src/providers/types.js';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const W1 = 'shape-ws-one';
const W2 = 'shape-ws-two';

/** Every persisted LoreNode field set to a non-default value. Excludes the two local-only fields. */
const FULL = {
    id: 'full-1',
    type: 'decision',
    label: 'Full shape node',
    content: 'every field is set',
    tags: ['alpha', 'beta'],
    project: 'proj-x',
    ecosystem: 'eco-y',
    metadata: JSON.stringify({ source: 'unit', nested: { n: [1, 2, 3] } }),
    security_scopes: ['team-a', 'team-b'],
    language: 'fr',
    supersededBy: 'full-2',
    supersededAt: '2026-09-02T10:00:00.000Z',
    supersededReason: 'replaced by a newer decision',
    ephemeral: true,
    ttl_ms: 7200000,
    stale: true,
    classification: 'foundational',
    status: 'protected',
    classification_expires_at: '2027-01-01T00:00:00.000Z',
    success_count: 4,
    failure_count: 1,
    partial_count: 2,
    confirmation_score: 0.75,
    evidence: JSON.stringify({ url: 'https://example.test/a', captured_at: '2026-05-26' }),
    anchor_stale: true,
    anchor_stale_since: '2026-09-03T00:00:00.000Z',
    anchors: JSON.stringify([{ type: 'url', ref: 'https://example.test/a' }, { type: 'node', ref: 'decision-xyz' }]),
    validFrom: '2026-01-01T00:00:00.000Z',
    validUntil: '2026-12-31T23:59:59.000Z',
} satisfies Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>;

const NOT_ROUND_TRIPPED = new Set(['createdAt', 'updatedAt', 'syncedAt', 'lastAccessedAt', 'last_retrieved_at']);

function pickFull(n: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(FULL)) out[k] = n[k];
    return out;
}

console.log('cloud parity B item 6: full node shape');

{
    const fx = await startCloudFixture();
    try {
        await test('every LoreNode field (minus the two local-only ones) round-trips through getNode', async () => {
            await fx.as(W1, () => fx.graph.upsertNode(FULL as never));
            const got = await fx.as(W1, () => fx.graph.getNode('full-1')) as unknown as Record<string, unknown>;
            assert.ok(got, 'node must exist');
            assert.deepEqual(pickFull(got), FULL as unknown as Record<string, unknown>);
            // and nothing else non-trivial appeared
            for (const k of Object.keys(got)) {
                if (k in FULL || NOT_ROUND_TRIPPED.has(k)) continue;
                throw new Error(`unexpected extra field on the read node: ${k}`);
            }
        });

        await test('the row stores snake_case columns (no camelCase supersession columns)', async () => {
            const row = fx.mock.rows(DP_WORKSPACE, 'lore_node').find((r) => r['lore_id'] === 'full-1')!;
            for (const col of [
                'metadata', 'synced_at', 'valid_from', 'valid_until', 'status', 'classification',
                'classification_expires_at', 'superseded_by', 'superseded_at', 'superseded_reason',
                'stale', 'ephemeral', 'ttl_ms', 'success_count', 'failure_count', 'partial_count',
                'confirmation_score', 'evidence', 'anchor_stale', 'anchor_stale_since', 'anchors',
            ]) assert.ok(col in row, `column ${col} must be persisted`);
            assert.equal(row['superseded_by'], 'full-2');
            assert.equal(row['stale'], true);
            assert.equal(row['ttl_ms'], 7200000);
            assert.equal(row['confirmation_score'], 0.75);
            for (const bad of ['supersededBy', 'supersededAt', 'supersededReason', 'validFrom', 'validUntil', 'lastAccessedAt', 'last_retrieved_at']) {
                assert.ok(!(bad in row), `${bad} must not be a stored column`);
            }
        });

        await test('the same full node is returned by listNodes, bulkList, search and getNodes', async () => {
            const viaList = (await fx.as(W1, () => fx.graph.listNodes('decision')) as unknown as Array<Record<string, unknown>>).find((n) => n['id'] === 'full-1')!;
            assert.deepEqual(pickFull(viaList), FULL as unknown as Record<string, unknown>);
            const page = await fx.as(W1, () => fx.graph.bulkList({ limit: 10 } as never));
            const viaBulk = (page.nodes as Array<Record<string, unknown>>).find((n) => n['id'] === 'full-1')!;
            assert.deepEqual(pickFull(viaBulk), FULL as unknown as Record<string, unknown>);
            const viaSearch = (await fx.as(W1, () => fx.graph.search('every field', 5)) as unknown as Array<Record<string, unknown>>).find((n) => n['id'] === 'full-1')!;
            assert.deepEqual(pickFull(viaSearch), FULL as unknown as Record<string, unknown>);
        });

        await test('the returned value of upsertNode carries the full shape too', async () => {
            const back = await fx.as(W1, () => fx.graph.upsertNode({ ...FULL, id: 'full-ret' } as never)) as unknown as Record<string, unknown>;
            assert.deepEqual(pickFull(back), { ...FULL, id: 'full-ret' } as unknown as Record<string, unknown>);
        });

        await test('absent optional fields are omitted from the row, never written as null', async () => {
            await fx.as(W1, () => fx.graph.upsertNode({
                id: 'min-1', type: 'note', label: 'minimal', content: 'c', tags: [], project: '*', ecosystem: '*', metadata: '{}',
            } as never));
            const row = fx.mock.rows(DP_WORKSPACE, 'lore_node').find((r) => r['lore_id'] === 'min-1')!;
            for (const col of ['valid_from', 'valid_until', 'superseded_by', 'superseded_at', 'superseded_reason', 'evidence', 'anchors',
                'classification_expires_at', 'anchor_stale_since', 'ttl_ms']) {
                assert.ok(!(col in row), `${col} must be absent on a node that never set it (got ${JSON.stringify(row[col])})`);
            }
            for (const [k, v] of Object.entries(row)) assert.notEqual(v, null, `${k} must not be null`);
        });

        await test('a minimal node reads back with the local defaults (status active, classification tactical, counters 0)', async () => {
            const got = await fx.as(W1, () => fx.graph.getNode('min-1')) as unknown as Record<string, unknown>;
            assert.equal(got['status'], 'active');
            assert.equal(got['classification'], 'tactical');
            assert.equal(got['success_count'], 0);
            assert.equal(got['failure_count'], 0);
            assert.equal(got['partial_count'], 0);
            assert.equal(got['confirmation_score'], 0);
            assert.equal(got['supersededBy'], null);
            assert.equal(got['validFrom'], null);
            assert.equal(got['validUntil'], null);
            assert.equal(got['metadata'], '{}');
            assert.equal(got['stale'], undefined);
            assert.equal(got['anchors'] ?? null, null);
        });

        await test('a partial re-upsert keeps the fields it does not mention (local merge semantics)', async () => {
            await fx.as(W1, () => fx.graph.upsertNode({ id: 'full-1', type: 'decision', label: 'renamed only', content: 'every field is set', tags: ['alpha'], project: 'proj-x', ecosystem: 'eco-y', metadata: FULL.metadata } as never));
            const got = await fx.as(W1, () => fx.graph.getNode('full-1')) as unknown as Record<string, unknown>;
            assert.equal(got['label'], 'renamed only');
            assert.equal(got['validFrom'], FULL.validFrom);
            assert.equal(got['supersededBy'], FULL.supersededBy);
            assert.equal(got['stale'], true);
            assert.equal(got['success_count'], 4);
            assert.equal(got['anchors'], FULL.anchors);
            assert.equal(got['evidence'], FULL.evidence);
            assert.deepEqual(got['security_scopes'], FULL.security_scopes);
        });

        await test('an empty string clears a nullable field (local semantics)', async () => {
            await fx.as(W1, () => fx.graph.upsertNode({ ...FULL, supersededBy: '', supersededAt: '', supersededReason: '', validUntil: '' } as never));
            const got = await fx.as(W1, () => fx.graph.getNode('full-1')) as unknown as Record<string, unknown>;
            assert.equal(got['supersededBy'], null);
            assert.equal(got['supersededAt'], null);
            assert.equal(got['supersededReason'], null);
            assert.equal(got['validUntil'], null);
            assert.equal(got['validFrom'], FULL.validFrom);
        });

        await test('supersedeNode / unsupersedeNode write the snake_case columns and round-trip', async () => {
            await fx.as(W1, () => fx.graph.upsertNode({ id: 's-old', type: 'note', label: 'old', content: 'o', tags: [], project: '*', ecosystem: '*', metadata: '{}' } as never));
            await fx.as(W1, () => fx.graph.upsertNode({ id: 's-new', type: 'note', label: 'new', content: 'n', tags: [], project: '*', ecosystem: '*', metadata: '{}' } as never));
            const r = await fx.as(W1, () => fx.graph.supersedeNode('s-old', 's-new', 'newer'));
            assert.equal(r.ok, true);
            const row = fx.mock.rows(DP_WORKSPACE, 'lore_node').find((x) => x['lore_id'] === 's-old')!;
            assert.equal(row['superseded_by'], 's-new');
            assert.equal(row['superseded_reason'], 'newer');
            assert.ok(typeof row['superseded_at'] === 'string' && (row['superseded_at'] as string).length > 0);
            assert.ok(!('supersededBy' in row), 'camelCase columns must not be written any more');
            const got = await fx.as(W1, () => fx.graph.getNode('s-old')) as unknown as Record<string, unknown>;
            assert.equal(got['supersededBy'], 's-new');
            assert.equal(got['supersededReason'], 'newer');
            assert.ok(got['supersededAt']);
            assert.equal(await fx.as(W1, () => fx.graph.unsupersedeNode('s-old')), true);
            const after = await fx.as(W1, () => fx.graph.getNode('s-old')) as unknown as Record<string, unknown>;
            assert.equal(after['supersededBy'], null);
            assert.equal(after['supersededAt'], null);
            assert.equal(after['supersededReason'], null);
        });

        await test('markStaleByIds flags stale and the flag reads back', async () => {
            assert.equal(await fx.as(W1, () => fx.graph.markStaleByIds(['s-new'])), 1);
            const got = await fx.as(W1, () => fx.graph.getNode('s-new')) as unknown as Record<string, unknown>;
            assert.equal(got['stale'], true);
        });

        await test('the shape is per Lore workspace: W2 sees none of W1 and can reuse the id with other values', async () => {
            assert.equal(await fx.as(W2, () => fx.graph.getNode('full-1')), null);
            await fx.as(W2, () => fx.graph.upsertNode({ id: 'full-1', type: 'note', label: 'w2', content: 'w2', tags: [], project: '*', ecosystem: '*', metadata: '{"w":2}', validFrom: '2020-01-01T00:00:00.000Z' } as never));
            const w2 = await fx.as(W2, () => fx.graph.getNode('full-1')) as unknown as Record<string, unknown>;
            assert.equal(w2['metadata'], '{"w":2}');
            assert.equal(w2['supersededBy'], null);
            const w1 = await fx.as(W1, () => fx.graph.getNode('full-1')) as unknown as Record<string, unknown>;
            assert.equal(w1['label'], 'Full shape node');
            assert.notEqual(w1['metadata'], '{"w":2}');
        });

        await test('the pushed schema declares every v2 node column and the v2 edge columns', async () => {
            const node = fx.mock.declaredFields(DP_WORKSPACE, 'lore_node')!;
            for (const c of [
                'metadata', 'synced_at', 'valid_from', 'valid_until', 'status', 'classification', 'classification_expires_at',
                'superseded_by', 'superseded_at', 'superseded_reason', 'stale', 'ephemeral', 'ttl_ms', 'success_count', 'failure_count',
                'partial_count', 'confirmation_score', 'evidence', 'anchor_stale', 'anchor_stale_since', 'anchors',
            ]) assert.ok(node.includes(c), `lore_node must declare ${c}`);
            const edge = fx.mock.declaredFields(DP_WORKSPACE, 'lore_edge')!;
            for (const c of ['confidence', 'confidence_score']) assert.ok(edge.includes(c), `lore_edge must declare ${c}`);
        });
    } finally { await fx.close(); }
}

{
    // F8: a collection created by an older Lore (v1 schema) never gains columns on re-push.
    const fx = await startCloudFixture();
    const stderr: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    try {
        await test('a v1 collection is detected: one cloud_schema_drift warning lists the missing columns; data still round-trips', async () => {
            // Provision the v1 collection the way an older Lore did.
            const v1 = {
                name: 'lore_node',
                fields: [
                    { name: 'id', field_type: 'string', primary_key: true, required: true },
                    { name: 'type', field_type: 'string', required: true, indexed: true },
                    { name: 'label', field_type: 'string' },
                    { name: 'content', field_type: 'string' },
                    { name: 'tags', field_type: 'string' },
                    { name: 'project', field_type: 'string', indexed: true },
                    { name: 'ecosystem', field_type: 'string', indexed: true },
                    { name: 'org_id', field_type: 'string', indexed: true, required: true },
                    { name: 'lore_workspace', field_type: 'string', indexed: true, required: true },
                    { name: 'lore_id', field_type: 'string', indexed: true, required: true },
                    { name: 'created_at', field_type: 'string' },
                    { name: 'updated_at', field_type: 'string' },
                    { name: 'language', field_type: 'string' },
                    { name: 'security_scopes', field_type: 'string' },
                ],
                indexes: [],
            };
            const res = await fetch(`${fx.mock.url}/v1/schema`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer fixture-key', 'x-api-key': 'fixture-key' }, body: JSON.stringify({ ...v1, connection: FIXTURE_CONNECTION }) });
            assert.ok(res.ok, `v1 provisioning failed: ${res.status}`);
            (process.stderr as unknown as { write: unknown }).write = (chunk: unknown) => { stderr.push(String(chunk)); return true; };
            try {
                await fx.as(W1, () => fx.graph.upsertNode(FULL as never));
                await fx.as(W1, () => fx.graph.getNode('full-1'));
            } finally { (process.stderr as unknown as { write: unknown }).write = realWrite; }
            const drift = stderr.filter((l) => l.includes('cloud_schema_drift'));
            assert.equal(drift.length, 1, `expected exactly one drift warning, got ${drift.length}`);
            for (const c of ['valid_from', 'superseded_by', 'anchors', 'confirmation_score']) assert.ok(drift[0]!.includes(c), `drift warning must list ${c}`);
            const got = await fx.as(W1, () => fx.graph.getNode('full-1')) as unknown as Record<string, unknown>;
            assert.deepEqual(pickFull(got), FULL as unknown as Record<string, unknown>);
        });
    } finally {
        (process.stderr as unknown as { write: unknown }).write = realWrite;
        await fx.close();
    }
}

console.log(`\n${failed === 0 ? 'all' : `${passed}/${passed + failed}`} ${passed + failed} unit tests ${failed === 0 ? 'passed ✓' : 'FAILED'}`);
process.exit(failed === 0 ? 0 : 1);
