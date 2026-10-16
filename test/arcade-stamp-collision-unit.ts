#!/usr/bin/env tsx
/**
 * arcade-stamp-collision-unit.ts - Lore 3.35.0 (r): an ArcadeDB `ifAbsent` create must never be answered ok because
 * ANOTHER writer's row happens to carry the same millisecond stamp.
 *
 * The 3.34.0 (M2) settle step recognised "our own insert, response lost" by `stored.createdAt === our stamp`. Two daemons
 * stamping the same millisecond and racing one id made the loser (aborted by a ConcurrentModificationException, or
 * refused with a duplicate-key error) see the winner's row, match its own stamp, and answer ok too: two ok answers for
 * one created node (found by the 3.35.0 (r) live load check, 12 of 80 four-way races).
 *
 * A definite server refusal (duplicate key, CME) proves the write did not land, so it is never matched by stamp.
 * A transport failure (timeout) keeps the stamp match: the response may be the only thing lost.
 *
 * Real ArcadeGraphStore over a small in-memory fake of the ArcadeDB HTTP transport (no ArcadeDB, no daemon, no sleeps
 * beyond the store's own sub-100 ms retry jitter).
 *
 * Run: npx tsx test/arcade-stamp-collision-unit.ts
 */
import assert from 'node:assert/strict';
import { ArcadeHttpError } from '../packages/lore/src/engines/arcade/arcadeHttp.js';
import { ArcadeGraphStore } from '../packages/lore/src/engines/arcade/arcadeGraphStore.js';
import { settleFailedUpsert } from '../packages/lore/src/engines/arcade/arcadeWriteSettle.js';
import { NodeAlreadyExistsError } from '../packages/lore/src/engines/graphShared/conditionalInsert.js';
import { RevisionConflictError } from '../packages/lore/src/engines/graphShared/revision.js';
import { classifyItemWriteError } from '../packages/lore/src/mcp/http/routes/bulkWriteErrors.js';
import { OutcomeUnknownError } from '../packages/lore/src/engines/graphShared/writeOutcome.js';
import type { LoreNode } from '../packages/lore/src/providers/types.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}

type Row = Record<string, unknown>;
type Decision = { apply: boolean; error: Error } | undefined;
class FakeArcade {
    nodes = new Map<string, Row>();
    inserts = 0;
    onInsert: ((params: Row, fake: FakeArcade, attempt: number) => Decision) | null = null;
    async command(_db: string, sql: string, params: Row = {}): Promise<{ result: unknown[] }> {
        if (/^INSERT INTO LoreNode SET /.test(sql)) {
            this.inserts++;
            const decision = this.onInsert?.(params, this, this.inserts);
            if (decision && !decision.apply) throw decision.error;
            const id = String(params['id']);
            if (this.nodes.has(id)) throw new ArcadeHttpError(409, JSON.stringify({ error: 'Found duplicate key in index', detail: `Duplicated key [${id}] found on index 'LoreNode[id]'`, exception: 'com.arcadedb.exception.DuplicatedKeyException' }));
            this.nodes.set(id, { ...params, revision: 1 });
            if (decision) throw decision.error;
        }
        return { result: [] };
    }
    async commandScript(): Promise<{ result: unknown[] }> { return { result: [] }; }
    async query(_db: string, sql: string, params: Row = {}): Promise<{ result: Row[] }> {
        if (/FROM LoreNode WHERE id = :id LIMIT 1$/.test(sql)) { const r = this.nodes.get(String(params['id'])); return { result: r ? [{ ...r }] : [] }; }
        return { result: [] };
    }
}
const rig = () => { const fake = new FakeArcade(); return { fake, graph: new ArcadeGraphStore({ tenantDb: 't', http: fake as never }) }; };
const node = (id: string, content = id) => ({ id, type: 'note', label: id, content, tags: [] as string[], project: 'p', ecosystem: '*', metadata: '{}' });
const cmeErr = () => new ArcadeHttpError(503, JSON.stringify({ error: 'Cannot execute command', detail: 'Concurrent modification on page PageId(t/1/0) ... Please retry the operation', exception: 'com.arcadedb.exception.ConcurrentModificationException' }));
/** A rival row for the id carrying the SAME stamp as the caller (two writers in one millisecond). */
const rivalWithSameStamp = (id: string, params: Row, fake: FakeArcade): void => {
    fake.nodes.set(id, { ...params, content: 'rival', revision: 1 });
};

console.log('\nifAbsent create vs a rival that shares the millisecond stamp\n');

await test('CME abort + a rival row with the same stamp -> already_exists, the rival row is untouched (not a second ok)', async () => {
    const { fake, graph } = rig();
    fake.onInsert = (params, f) => { rivalWithSameStamp(String(params['id']), params, f); return { apply: false, error: cmeErr() }; };
    await assert.rejects(graph.insertNodeIfAbsent(node('c1', 'mine')), (e) => e instanceof NodeAlreadyExistsError);
    assert.equal(fake.nodes.get('c1')!['content'], 'rival');
    assert.equal(fake.inserts, 1, 'a taken id is answered without another attempt');
});

await test('duplicate-key refusal + a rival row with the same stamp -> already_exists', async () => {
    const { fake, graph } = rig();
    fake.onInsert = (params, f) => { rivalWithSameStamp(String(params['id']), params, f); return undefined; };
    await assert.rejects(graph.insertNodeIfAbsent(node('c2', 'mine')), (e) => e instanceof NodeAlreadyExistsError);
    assert.equal(fake.nodes.get('c2')!['content'], 'rival');
});

await test('CME abort, id still free -> the next attempt creates it once', async () => {
    const { fake, graph } = rig();
    fake.onInsert = (_p, _f, attempt) => (attempt === 1 ? { apply: false, error: cmeErr() } : undefined);
    const got = await graph.insertNodeIfAbsent(node('c3', 'mine'));
    assert.equal(got.id, 'c3');
    assert.equal(fake.inserts, 2);
    assert.equal(fake.nodes.get('c3')!['content'], 'mine');
});

await test('CME abort, then a rival (any stamp) took the id before the retry -> already_exists, nothing overwritten', async () => {
    const { fake, graph } = rig();
    fake.onInsert = (_p, f, attempt) => {
        if (attempt > 1) return undefined;
        f.nodes.set('c4', { ...node('c4', 'rival'), tags: '[]', createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z', revision: 1 });
        return { apply: false, error: cmeErr() };
    };
    await assert.rejects(graph.insertNodeIfAbsent(node('c4', 'mine')), (e) => e instanceof NodeAlreadyExistsError);
    assert.equal(fake.nodes.get('c4')!['content'], 'rival');
});

await test('control: a lost response whose insert did commit (timeout) is still recognised as our own write', async () => {
    const { fake, graph } = rig();
    fake.onInsert = () => ({ apply: true, error: new Error('[ArcadeHttp] request timeout after 30000ms') });
    const got = await graph.insertNodeIfAbsent(node('c5', 'mine'));
    assert.equal(got.id, 'c5');
    assert.equal(fake.inserts, 1, 'a timeout is never retried (the outcome is unknown, not a provable no-write)');
});

await test('a timeout with nothing committed is not retried: outcome_unknown', async () => {
    const { fake, graph } = rig();
    fake.onInsert = () => ({ apply: false, error: new Error('[ArcadeHttp] request timeout after 30000ms') });
    await assert.rejects(graph.insertNodeIfAbsent(node('c6')), (e) => e instanceof OutcomeUnknownError);
    assert.equal(fake.inserts, 1);
});

console.log('\na refused connection (nothing sent) is retried, a reset is not');

const errno = (code: string): Error => Object.assign(new Error(`connect ${code} 127.0.0.1:2480`), { code });
const aggregate = (): Error => Object.assign(new Error('AggregateError'), { errors: [errno('ECONNREFUSED'), errno('ECONNREFUSED')] });

await test('ifAbsent: ECONNREFUSED once, then the insert lands -> ok, 2 inserts (the first attempt wrote nothing)', async () => {
    const { fake, graph } = rig();
    fake.onInsert = (_p, _f, attempt) => (attempt === 1 ? { apply: false, error: errno('ECONNREFUSED') } : undefined);
    const got = await graph.insertNodeIfAbsent(node('f1', 'mine'));
    assert.equal(got.id, 'f1');
    assert.equal(fake.inserts, 2);
    assert.equal(fake.nodes.get('f1')!['content'], 'mine');
});

await test('ifAbsent: ECONNREFUSED on an AggregateError (happy-eyeballs) is retried too', async () => {
    const { fake, graph } = rig();
    fake.onInsert = (_p, _f, attempt) => (attempt === 1 ? { apply: false, error: aggregate() } : undefined);
    assert.equal((await graph.insertNodeIfAbsent(node('f2'))).id, 'f2');
    assert.equal(fake.inserts, 2);
});

await test('ifAbsent is re-judged per attempt: refused, then a rival took the id -> already_exists, rival untouched', async () => {
    const { fake, graph } = rig();
    fake.onInsert = (_p, f, attempt) => {
        if (attempt > 1) return undefined;
        f.nodes.set('f3', { ...node('f3', 'rival'), tags: '[]', createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z', revision: 1 });
        return { apply: false, error: errno('ECONNREFUSED') };
    };
    await assert.rejects(graph.insertNodeIfAbsent(node('f3', 'mine')), (e) => e instanceof NodeAlreadyExistsError);
    assert.equal(fake.nodes.get('f3')!['content'], 'rival');
});

await test('ifAbsent: a refusal that outlasts the budget (1 + 2 retries) surfaces as arcade_unavailable, never outcome_unknown', async () => {
    const { fake, graph } = rig();
    fake.onInsert = () => ({ apply: false, error: errno('ECONNREFUSED') });
    const err = await graph.insertNodeIfAbsent(node('f4')).then(() => null, (e: unknown) => e);
    assert.ok(err && !(err instanceof OutcomeUnknownError), 'a refused connection provably wrote nothing');
    assert.equal(fake.inserts, 3);
    assert.match(classifyItemWriteError(err).error, /^arcade_unavailable: /);
});

await test('ifAbsent: ECONNRESET is not retried: outcome_unknown (the insert may have landed)', async () => {
    const { fake, graph } = rig();
    fake.onInsert = () => ({ apply: false, error: errno('ECONNRESET') });
    await assert.rejects(graph.insertNodeIfAbsent(node('f5')), (e) => e instanceof OutcomeUnknownError);
    assert.equal(fake.inserts, 1);
});

await test('revision-conditional create: ECONNREFUSED once then success -> ok, 2 inserts; exhausted -> arcade_unavailable; timeout -> outcome_unknown, 1 insert', async () => {
    const at = (graph: ArcadeGraphStore, id: string) => graph.upsertNodeAtRevision(node(id), 0, '2026-10-16T10:00:00.000Z');
    const a = rig();
    a.fake.onInsert = (_p, _f, attempt) => (attempt === 1 ? { apply: false, error: errno('ECONNREFUSED') } : undefined);
    assert.equal((await at(a.graph, 'g1')).id, 'g1');
    assert.equal(a.fake.inserts, 2);
    const b = rig();
    b.fake.onInsert = () => ({ apply: false, error: errno('ECONNREFUSED') });
    const err = await at(b.graph, 'g2').then(() => null, (e: unknown) => e);
    assert.equal(b.fake.inserts, 3);
    assert.match(classifyItemWriteError(err).error, /^arcade_unavailable: /);
    const c = rig();
    c.fake.onInsert = () => ({ apply: false, error: new Error('[ArcadeHttp] request timeout after 30000ms') });
    await assert.rejects(at(c.graph, 'g3'), (e) => e instanceof OutcomeUnknownError);
    assert.equal(c.fake.inserts, 1);
});

console.log('\nsettleFailedUpsert (revision-conditional writes) with a stamp collision\n');

const stored = (id: string, updatedAt: string, revision: number): LoreNode => ({ ...node(id), createdAt: updatedAt, updatedAt, revision } as unknown as LoreNode);

await test('CME abort and the stored row matches our stamp + expected revision + 1 (another writer, same ms) -> revision conflict, not "ours"', async () => {
    const stamp = '2026-10-16T10:00:00.000Z';
    await assert.rejects(
        settleFailedUpsert(async () => stored('u1', stamp, 4), 'u1', cmeErr(), { existed: true, expectedRevision: 3, updatedAt: stamp }),
        (e) => e instanceof RevisionConflictError,
    );
});

await test('duplicate-key refusal with the same collision -> revision conflict', async () => {
    const stamp = '2026-10-16T10:00:00.000Z';
    const dup = new ArcadeHttpError(409, JSON.stringify({ error: 'Found duplicate key in index', exception: 'com.arcadedb.exception.DuplicatedKeyException' }));
    await assert.rejects(
        settleFailedUpsert(async () => stored('u2', stamp, 1), 'u2', dup, { existed: false, expectedRevision: 0, updatedAt: stamp }),
        (e) => e instanceof RevisionConflictError,
    );
});

await test('control: a transport failure with a matching stored row is our own write', async () => {
    const stamp = '2026-10-16T10:00:00.000Z';
    const got = await settleFailedUpsert(async () => stored('u3', stamp, 4), 'u3', new Error('[ArcadeHttp] request timeout after 30000ms'), { existed: true, expectedRevision: 3, updatedAt: stamp });
    assert.equal(got.id, 'u3');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
