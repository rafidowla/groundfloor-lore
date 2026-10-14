#!/usr/bin/env tsx
/**
 * arcade-bulk-settle-unit.ts - Lore 3.34.0 slice 2 (M3b hardening of engines/arcade/arcadeBulk.ts).
 *
 * Before: a failed chunk script (including a 30 s client-side timeout, while ArcadeDB may still be
 * running it) was followed by an immediate per-node re-run through a bare catch: two overlapping
 * writers on the same ids. Now a failed script is SETTLED by re-reading the chunk's rows:
 *   applied (updatedAt = this script's stamp, revision = prior + 1)           -> ok, no re-run
 *   provably not applied (absent and was absent, or unchanged at prior rev)   -> re-run that item alone
 *   anything else (moved by someone else, vanished, re-read failed)           -> outcome_unknown, NO write
 * and only transport failures are caught; a programming error propagates.
 *
 * Deterministic: a fake `http` records the exact call order, so "the re-read happened BEFORE any
 * re-run" is asserted, not assumed.
 *
 * Run: npx tsx test/arcade-bulk-settle-unit.ts
 */
import assert from 'node:assert/strict';
import { bulkUpsertNodes } from '../packages/lore/src/engines/arcade/arcadeBulk.js';
import { ArcadeHttpError } from '../packages/lore/src/engines/arcade/arcadeHttp.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}

type Row = { id: string; revision: number; updatedAt: string; createdAt: string; security_scopes?: unknown };
const input = (id: string) => ({ id, type: 'note', label: id, content: id, tags: [] as string[], project: 'p', ecosystem: '*', metadata: '{}' });
const timeout = () => new Error('[ArcadeHttp] request timeout after 30000ms');

class Rig {
    rows = new Map<string, Row>();
    events: string[] = [];
    scripts = 0;
    /** What the chunk script does when called. Receives the stamp it was sent. */
    onScript: (stamp: string, ids: string[], rig: Rig) => void | Promise<void> = (stamp, ids, rig) => rig.apply(ids, stamp);
    /** Failure injection for SELECTs: first that returns an Error throws it. */
    onQuery: (sql: string, n: number) => Error | undefined = () => undefined;
    queries = 0;
    singles: string[] = [];
    singleFails = new Set<string>();

    seed(id: string, revision = 1): void { this.rows.set(id, { id, revision, updatedAt: '2020-01-01T00:00:00.000Z', createdAt: '2020-01-01T00:00:00.000Z' }); }
    apply(ids: string[], stamp: string): void {
        for (const id of ids) { const r = this.rows.get(id); this.rows.set(id, { id, revision: (r?.revision ?? 0) + 1, updatedAt: stamp, createdAt: r?.createdAt ?? stamp }); }
    }
    http = {
        query: async (_db: string, sql: string, params: { ids: string[] }) => {
            this.queries++;
            const kind = /updatedAt FROM/.test(sql) ? 'reread' : 'prefetch';
            this.events.push(kind);
            const err = this.onQuery(kind, this.queries);
            if (err) throw err;
            return { result: params.ids.filter((i) => this.rows.has(i)).map((i) => ({ ...this.rows.get(i)! })) };
        },
        commandScript: async (_db: string, _script: string, params: Record<string, unknown>) => {
            this.scripts++;
            this.events.push('script');
            const ids = Object.keys(params).filter((k) => /^n\d+_id$/.test(k)).map((k) => String(params[k]));
            const stamp = String(params['n0_updatedAt']);
            await this.onScript(stamp, ids, this);
            return { result: [] };
        },
    };
    single = async (node: { id: string }) => {
        this.events.push(`single:${node.id}`);
        this.singles.push(node.id);
        if (this.singleFails.has(node.id)) throw new Error('single write failed');
        this.apply([node.id], new Date().toISOString());
        return node as never;
    };
    run(ids: string[]) { return bulkUpsertNodes('db', this.http as never, ids.map(input), this.single as never); }
}

console.log('\nM3b. arcadeBulk settles a failed chunk by re-read instead of re-running it blind\n');

await test('healthy chunk: one pre-fetch, one script, no re-read, no per-node write', async () => {
    const r = new Rig(); r.seed('a', 3);
    const out = await r.run(['a', 'b']);
    assert.deepEqual(out, [{ id: 'a', ok: true }, { id: 'b', ok: true }]);
    assert.deepEqual(r.events, ['prefetch', 'script']);
    assert.equal(r.rows.get('a')!.revision, 4);
});
await test('script fails BEFORE applying (503): re-read first, then each item is re-run alone and ends ok', async () => {
    const r = new Rig(); r.seed('a', 2);
    r.onScript = () => { throw new ArcadeHttpError(503, 'unavailable'); };
    const out = await r.run(['a', 'new1']);
    assert.deepEqual(out, [{ id: 'a', ok: true }, { id: 'new1', ok: true }]);
    assert.deepEqual(r.events, ['prefetch', 'script', 'reread', 'single:a', 'single:new1'], 'the re-read precedes every re-run');
});
await test('timeout AFTER the script applied: the items are recognised as applied; nothing is re-run (no double revision bump)', async () => {
    const r = new Rig(); r.seed('a', 2);
    r.onScript = (stamp, ids, rig) => { rig.apply(ids, stamp); throw timeout(); };
    const out = await r.run(['a', 'new1']);
    assert.deepEqual(out, [{ id: 'a', ok: true }, { id: 'new1', ok: true }]);
    assert.deepEqual(r.singles, [], 'a blind re-run here would be the overlap this change removes');
    assert.equal(r.rows.get('a')!.revision, 3, 'one bump, not two');
    assert.equal(r.rows.get('new1')!.revision, 1);
});
await test('timeout while the script is STILL RUNNING: the re-read sees prior state; the item is re-run alone only if unchanged (documented residual)', async () => {
    // The fake cannot model an in-flight script that lands later; this pins what the code does with what it can see.
    const r = new Rig(); r.seed('a', 2);
    r.onScript = () => { throw timeout(); };
    const out = await r.run(['a']);
    assert.deepEqual(out, [{ id: 'a', ok: true }]);
    assert.deepEqual(r.singles, ['a']);
});
await test('moved by someone else during the failure: outcome_unknown with the current revision, and NO write', async () => {
    const r = new Rig(); r.seed('a', 2);
    r.onScript = (_s, _i, rig) => { rig.rows.set('a', { ...rig.rows.get('a')!, revision: 5, updatedAt: '2026-10-13T09:00:00.000Z' }); throw timeout(); };
    const out = await r.run(['a']);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.ok, false);
    assert.match(out[0]!.error ?? '', /^outcome_unknown: /);
    assert.equal((out[0] as { currentRevision?: number }).currentRevision, 5);
    assert.deepEqual(r.singles, []);
});
await test('vanished after the failure (existed before): outcome_unknown, currentRevision null, no write', async () => {
    const r = new Rig(); r.seed('a', 2);
    r.onScript = (_s, _i, rig) => { rig.rows.delete('a'); throw timeout(); };
    const out = await r.run(['a']);
    assert.match(out[0]!.error ?? '', /^outcome_unknown: /);
    assert.equal((out[0] as { currentRevision?: number | null }).currentRevision, null);
    assert.deepEqual(r.singles, []);
});
await test('created by someone else during the failure (absent before, present with another stamp): outcome_unknown, no write', async () => {
    const r = new Rig();
    r.onScript = (_s, _i, rig) => { rig.seed('n', 1); throw timeout(); };
    const out = await r.run(['n']);
    assert.match(out[0]!.error ?? '', /^outcome_unknown: /);
    assert.deepEqual(r.singles, []);
});
await test('re-read itself fails: every item is outcome_unknown (no currentRevision), and nothing is written', async () => {
    const r = new Rig(); r.seed('a', 2);
    r.onScript = () => { throw timeout(); };
    r.onQuery = (kind) => (kind === 'reread' ? timeout() : undefined);
    const out = await r.run(['a', 'b']);
    assert.ok(out.every((x) => !x.ok && /^outcome_unknown: /.test(x.error ?? '')));
    assert.ok(out.every((x) => !('currentRevision' in x)));
    assert.deepEqual(r.singles, []);
});
await test('mixed chunk: applied -> ok, untouched -> re-run, moved -> outcome_unknown; each decided on its own row', async () => {
    const r = new Rig(); r.seed('applied', 1); r.seed('untouched', 1); r.seed('moved', 1);
    r.onScript = (stamp, _ids, rig) => {
        rig.apply(['applied'], stamp);
        rig.rows.set('moved', { ...rig.rows.get('moved')!, revision: 9, updatedAt: '2026-10-13T09:00:00.000Z' });
        throw timeout();
    };
    const out = await r.run(['applied', 'untouched', 'moved']);
    assert.deepEqual(out.map((x) => [x.id, x.ok]), [['applied', true], ['untouched', true], ['moved', false]]);
    assert.deepEqual(r.singles, ['untouched']);
});
await test('a re-run item that fails alone is reported per item with its own error', async () => {
    const r = new Rig(); r.seed('a', 1);
    r.onScript = () => { throw new ArcadeHttpError(503, 'x'); };
    r.singleFails.add('a');
    const out = await r.run(['a']);
    assert.deepEqual(out, [{ id: 'a', ok: false, error: 'single write failed' }]);
});
await test('pre-fetch fails (nothing written yet): the chunk is written per node, the script is never sent', async () => {
    const r = new Rig();
    r.onQuery = (kind) => (kind === 'prefetch' ? new ArcadeHttpError(503, 'down') : undefined);
    const out = await r.run(['a', 'b']);
    assert.deepEqual(out, [{ id: 'a', ok: true }, { id: 'b', ok: true }]);
    assert.equal(r.scripts, 0);
    assert.deepEqual(r.singles, ['a', 'b']);
});
await test('narrowed catches: a programming error in the script call or the pre-fetch propagates and is not swallowed into a fallback write', async () => {
    const a = new Rig(); a.onScript = () => { throw new TypeError('bug'); };
    await assert.rejects(a.run(['a']), /bug/);
    assert.deepEqual(a.singles, []);
    const b = new Rig(); b.onQuery = (kind) => (kind === 'prefetch' ? new TypeError('bug2') : undefined);
    await assert.rejects(b.run(['a']), /bug2/);
    assert.deepEqual(b.singles, []);
    const c = new Rig(); c.onScript = () => { throw timeout(); }; c.onQuery = (kind) => (kind === 'reread' ? new TypeError('bug3') : undefined);
    await assert.rejects(c.run(['a']), /bug3/);
});
await test('chunking: 120 items are sent as 3 scripts; a failure in one chunk does not re-run the others', async () => {
    const r = new Rig();
    const ids = Array.from({ length: 120 }, (_, i) => `n${i}`);
    let call = 0;
    r.onScript = (stamp, chunkIds, rig) => { call++; if (call === 2) throw new ArcadeHttpError(503, 'x'); rig.apply(chunkIds, stamp); };
    const out = await r.run(ids);
    assert.equal(r.scripts, 3);
    assert.ok(out.every((x) => x.ok));
    assert.equal(r.singles.length, 50, 'only the failed chunk (items 50..99) was re-run');
    assert.equal(r.singles[0], 'n50');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
