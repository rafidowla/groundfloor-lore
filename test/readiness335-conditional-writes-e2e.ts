#!/usr/bin/env tsx
/**
 * test/readiness335-conditional-writes-e2e.ts - 3.35.0 readiness: conditional writes
 * (ifRevision / ifAbsent / preconditions / atomic bulk) over the real HTTP surface of a real daemon.
 *
 *   A  POST /api/node ifRevision: match -> 200; stale -> 409 revision_mismatch with currentRevision and
 *      NOTHING written; absent -> 409 currentRevision:null; malformed -> 400 invalid_if_revision
 *   B  POST /api/node preconditions: unmet -> 409 precondition_failed (failedPreconditions) and the node
 *      is not written; met -> 200
 *   C  POST /api/nodes/bulk per-item ifAbsent / ifRevision: conflicts are per-item errors, the rest land
 *   D  atomic:true: a refused batch (ifAbsent / ifRevision / precondition) leaves NOTHING - no node, no
 *      revision bump; a good batch lands whole; duplicate ids and embed:'inline' are 422
 *   E  races: 12 parallel writers on one ifRevision -> exactly one 200; 12 parallel ifAbsent creates -> one
 *   F  after all of it: outbox empty, 0 dead rows
 *
 * Real daemon (SQLite default), isolated HOME, free port. Never :3847 / ~/.groundfloor.
 * Run: npx tsx test/readiness335-conditional-writes-e2e.ts
 */
import { cleanup } from './helpers/live-daemon.js';
import { apiFor, bootDaemon, makeChecker, waitOutboxDrained } from './helpers/readiness335.js';

const { check, finish } = makeChecker('3.35.0 readiness: conditional writes over HTTP');
const WS = 'default';

async function main(): Promise<void> {
    const h = await bootDaemon();
    try {
        const api = apiFor(h);
        const node = (id: string, content: string, extra: Record<string, unknown> = {}) => ({ id, type: 'note', label: id, content, workspace: WS, ...extra });
        const full = async (id: string) => (await api.get(`/api/node-full?id=${id}&workspace=${WS}`)).body;
        const bulk = (nodes: unknown[], extra: Record<string, unknown> = {}) => api.post('/api/nodes/bulk', { workspace: WS, nodes, ...extra });
        const item = (r: { body: any }, i: number) => r.body?.results?.[i];

        // seed: revision 1
        const seed = await bulk([{ id: 'cw-a', type: 'note', label: 'a', content: 'v1' }]);
        check('seed lands at revision 1', item(seed, 0)?.ok === true && item(seed, 0)?.revision === 1, seed.text.slice(0, 200));

        // A
        const ok1 = await api.post('/api/node', node('cw-a', 'v2', { ifRevision: 1 }));
        check('A: ifRevision matching -> 200', ok1.status === 200 && ok1.body?.ok === true, ok1.text);
        const stale = await api.post('/api/node', node('cw-a', 'STALE-WRITE', { ifRevision: 1 }));
        check('A: stale ifRevision -> 409 revision_mismatch, currentRevision 2', stale.status === 409 && stale.body?.code === 'revision_mismatch' && stale.body?.currentRevision === 2, stale.text);
        check('A: the stale write changed nothing', (await full('cw-a'))?.content === 'v2');
        const absent = await api.post('/api/node', node('cw-ghost', 'x', { ifRevision: 4 }));
        check('A: ifRevision on an absent node -> 409, currentRevision null', absent.status === 409 && absent.body?.currentRevision === null, absent.text);
        check('A: ...and the node was not created', (await full('cw-ghost'))?.found === false);
        for (const bad of [-1, 1.5, 'two']) {
            const r = await api.post('/api/node', node('cw-a', 'bad', { ifRevision: bad }));
            check(`A: ifRevision ${JSON.stringify(bad)} -> 400 invalid_if_revision`, r.status === 400 && r.body?.code === 'invalid_if_revision', r.text);
        }
        const ok2 = await api.post('/api/node', node('cw-a', 'v3', { ifRevision: 2 }));
        check('A: ifRevision 2 -> 200 (lands at revision 3)', ok2.status === 200, ok2.text);

        // B
        const preBad = await api.post('/api/node', node('cw-b', 'should not land', { preconditions: [{ id: 'cw-a', revision: 99 }] }));
        check('B: unmet precondition -> 409 precondition_failed', preBad.status === 409 && preBad.body?.code === 'precondition_failed', preBad.text);
        const fp = preBad.body?.failedPreconditions?.[0];
        check('B: failedPreconditions names expected 99 / found 3', fp?.id === 'cw-a' && fp?.expected === 99 && fp?.found === 3, JSON.stringify(preBad.body?.failedPreconditions));
        check('B: ...and the guarded node was not written', (await full('cw-b'))?.found === false);
        const preOk = await api.post('/api/node', node('cw-b', 'landed', { preconditions: [{ id: 'cw-a', revision: 3 }] }));
        check('B: met precondition -> 201 (created)', preOk.status === 201 && preOk.body?.ok === true, preOk.text);

        // C
        const c = await bulk([
            { id: 'cw-a', type: 'note', label: 'a', content: 'ifAbsent must not overwrite', ifAbsent: true },
            { id: 'cw-c1', type: 'note', label: 'c1', content: 'new', ifAbsent: true },
            { id: 'cw-a', type: 'note', label: 'a', content: 'v4 via bulk', ifRevision: 3 },
            { id: 'cw-b', type: 'note', label: 'b', content: 'stale bulk', ifRevision: 5 },
        ]);
        check('C: existing id + ifAbsent -> item already_exists', item(c, 0)?.ok === false && String(item(c, 0)?.error).startsWith('already_exists'), JSON.stringify(item(c, 0)));
        check('C: new id + ifAbsent -> ok at revision 1', item(c, 1)?.ok === true && item(c, 1)?.revision === 1, JSON.stringify(item(c, 1)));
        check('C: matching ifRevision -> ok at revision 4', item(c, 2)?.ok === true && item(c, 2)?.revision === 4, JSON.stringify(item(c, 2)));
        check('C: stale ifRevision -> item revision_mismatch with currentRevision', item(c, 3)?.ok === false && String(item(c, 3)?.error).startsWith('revision_mismatch') && item(c, 3)?.currentRevision === 1, JSON.stringify(item(c, 3)));
        check('C: ifAbsent did not overwrite; bulk ifRevision did', (await full('cw-a'))?.content === 'v4 via bulk');
        check('C: stale bulk write changed nothing', (await full('cw-b'))?.content === 'landed');

        // D
        const aBefore = await bulk([{ id: 'cw-a', type: 'note', label: 'a', content: 'v4 via bulk', ifRevision: 4 }]); // -> revision 5, our baseline
        check('D: baseline bump to revision 5', item(aBefore, 0)?.revision === 5, aBefore.text.slice(0, 200));
        const d1 = await bulk([{ id: 'cw-d1', type: 'note', label: 'd1', content: 'x' }, { id: 'cw-a', type: 'note', label: 'a', content: 'x', ifAbsent: true }], { atomic: true });
        check('D: atomic + conflicting ifAbsent -> 409 already_exists, failedIndex 1', d1.status === 409 && d1.body?.code === 'already_exists' && d1.body?.failedIndex === 1, d1.text);
        check('D: ...first item NOT written', (await full('cw-d1'))?.found === false);
        const d2 = await bulk([{ id: 'cw-d2', type: 'note', label: 'd2', content: 'x' }, { id: 'cw-a', type: 'note', label: 'a', content: 'x', ifRevision: 1 }], { atomic: true });
        check('D: atomic + stale ifRevision -> 409 revision_mismatch, failedIndex 1', d2.status === 409 && d2.body?.code === 'revision_mismatch' && d2.body?.failedIndex === 1, d2.text);
        check('D: ...first item NOT written', (await full('cw-d2'))?.found === false);
        const d3 = await bulk([{ id: 'cw-d3', type: 'note', label: 'd3', content: 'x', preconditions: [{ id: 'cw-a', revision: 1 }] }], { atomic: true });
        check('D: atomic + unmet precondition -> 409 precondition_failed', d3.status === 409 && d3.body?.code === 'precondition_failed', d3.text);
        check('D: ...node NOT written', (await full('cw-d3'))?.found === false);
        const aRev = await bulk([{ id: 'cw-a', type: 'note', label: 'a', content: 'v4 via bulk', ifRevision: 5 }]);
        check('D: refused batches did not bump cw-a (still revision 5 -> 6)', item(aRev, 0)?.ok === true && item(aRev, 0)?.revision === 6, aRev.text.slice(0, 200));
        const d4 = await bulk([{ id: 'cw-e1', type: 'note', label: 'e1', content: 'x' }, { id: 'cw-e2', type: 'note', label: 'e2', content: 'y', ifAbsent: true }], { atomic: true });
        check('D: good atomic batch -> 200 atomic:true, 2 succeeded', d4.status === 200 && d4.body?.atomic === true && d4.body?.succeeded === 2, d4.text);
        check('D: ...both nodes present', (await full('cw-e1'))?.found === true && (await full('cw-e2'))?.found === true);
        const d5 = await bulk([{ id: 'cw-dup', type: 'note', label: 'x', content: 'x' }, { id: 'cw-dup', type: 'note', label: 'x', content: 'y' }], { atomic: true });
        check('D: duplicate ids in an atomic batch -> 422', d5.status === 422, d5.text);
        const d6 = await bulk([{ id: 'cw-inl', type: 'note', label: 'x', content: 'x' }], { atomic: true, embed: 'inline' });
        check('D: atomic + embed:inline -> 422', d6.status === 422, d6.text);
        check('D: ...neither wrote a node', (await full('cw-dup'))?.found === false && (await full('cw-inl'))?.found === false);

        // E
        const rev = (await bulk([{ id: 'cw-race', type: 'note', label: 'r', content: 'r0' }])).body?.results?.[0]?.revision as number;
        const racers = await Promise.all(Array.from({ length: 12 }, (_, i) => api.post('/api/node', node('cw-race', `racer ${i}`, { ifRevision: rev }))));
        const wins = racers.filter((r) => r.status === 200).length;
        const losses = racers.filter((r) => r.status === 409 && r.body?.code === 'revision_mismatch').length;
        check('E: 12 racers on one ifRevision -> exactly 1 win, 11 revision_mismatch', wins === 1 && losses === 11, `wins=${wins} losses=${losses} other=${racers.map((r) => r.status).join(',')}`);
        const creates = await Promise.all(Array.from({ length: 12 }, (_, i) => bulk([{ id: 'cw-race-new', type: 'note', label: 'n', content: `creator ${i}`, ifAbsent: true }])));
        const created = creates.filter((r) => item(r, 0)?.ok === true).length;
        const exists = creates.filter((r) => String(item(r, 0)?.error).startsWith('already_exists')).length;
        check('E: 12 parallel ifAbsent creates -> exactly 1 created, 11 already_exists', created === 1 && exists === 11, `created=${created} exists=${exists}`);

        // F
        const health = await waitOutboxDrained(api);
        check('F: outbox empty, 0 dead rows after every conflict', health.outbox?.depth === 0 && (health.outbox?.dead ?? 0) === 0, JSON.stringify(health.outbox));
    } catch (err) {
        check('suite ran without throwing', false, (err as Error).stack ?? String(err));
        console.error(`--- daemon log tail ---\n${h.log.text.slice(-2500)}`);
    } finally {
        cleanup(h);
    }
    finish();
}

await main();
