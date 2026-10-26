#!/usr/bin/env tsx
/**
 * test/link-discovery-engines.ts - Links Loop D (discovery + relation typing) against the real graph engines:
 * SQLite always, Postgres when LORE_PG_URL names a throwaway server. Vectors are 2-D unit vectors by angle.
 *
 *   discovery   finds an old-to-old pair Loop A missed, stamps provenance (link_on_arrival + policy_version + model
 *               fingerprint), is idempotent, never touches a caller edge, never links an autolink:false node
 *   typing      near-duplicate => a supersedes PROPOSAL (nothing superseded) + a supersession candidate; a supports
 *               verdict is written as a typed edge, NOT SOVEREIGN marked when the typer is hosted; contradicts => proposal only
 *   budgets     nodes / pairs / wall time stop the run and it resumes from the durable cursor to the same graph; busy backs off
 *   decisions   accept goes through the supersede path (old node superseded + supersedes edge); reject is never re-raised
 *
 * Run: npx tsx test/link-discovery-engines.ts
 */
import assert from 'node:assert/strict';

import { DISCOVERY_DEFAULTS, type LinkDiscoveryConfig } from '../packages/lore/src/link/discoveryConfig.js';
import { acceptProposal, rejectProposal } from '../packages/lore/src/link/discoveryAccept.js';
import { LinkDiscovery } from '../packages/lore/src/link/discoveryRunner.js';
import { SqliteDiscoveryStore } from '../packages/lore/src/link/discoveryStore.js';
import { SqliteProposalStore } from '../packages/lore/src/link/proposalStore.js';
import { RulesTyper, TypingCascade, type IRelationTyper, type RelationVerdict } from '../packages/lore/src/link/relationTyper.js';
import { StoredVectorLinker } from '../packages/lore/src/link/storedVectorLinker.js';
import type { DuplicateCandidate } from '../packages/lore/src/link/linkTypes.js';
import { FP, P, REL, linkEngines, node, pair, seed, linkEdges, type G } from './helpers/linkEngines.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const POLICY = P('p-disc', 0.8, 5);
const cfg = (over: Partial<LinkDiscoveryConfig> = {}): LinkDiscoveryConfig => ({ ...DISCOVERY_DEFAULTS, enabled: true, yieldMs: 0, ...over });

interface Rig {
    g: G;
    disc: LinkDiscovery;
    store: SqliteDiscoveryStore;
    proposals: SqliteProposalStore;
    dups: DuplicateCandidate[];
}
async function rig(g: G, vb: Awaited<ReturnType<typeof seed>>, o: { config?: Partial<LinkDiscoveryConfig>; typers?: IRelationTyper[]; isBusy?: () => boolean; now?: () => number } = {}): Promise<Rig> {
    const linker = new StoredVectorLinker(async () => ({ graph: g, verbatim: vb }) as never, POLICY, FP);
    const store = new SqliteDiscoveryStore(':memory:');
    const proposals = new SqliteProposalStore(':memory:');
    const dups: DuplicateCandidate[] = [];
    const c = cfg(o.config);
    const rules = new RulesTyper(c.supersedeSim);
    const disc = new LinkDiscovery({
        config: c, linkConfig: { dupSim: POLICY.dupSim, maxLinksPerNode: 0, k: POLICY.k }, linker, store, proposals,
        cascade: new TypingCascade([rules, ...(o.typers ?? [])]), rules, policyVersion: POLICY.policyVersion,
        addDuplicates: (_ws, d) => { dups.push(...d); },
        ...(o.isBusy ? { isBusy: o.isBusy } : {}), ...(o.now ? { now: o.now } : {}),
    });
    return { g, disc, store, proposals, dups };
}
const WS = 'lf';
async function supersededBy(g: G, id: string): Promise<string | null> {
    const m = await (g as unknown as { getNodesByIds(ids: string[]): Promise<Map<string, { supersededBy?: string | null }>> }).getNodesByIds([id]);
    return m.get(id)?.supersededBy || null;
}
/** A typer that returns a canned verdict for every pair it is asked about. */
const fakeTyper = (relation: RelationVerdict['relation'], sovereign: boolean): IRelationTyper => ({
    id: sovereign ? 'fake-local' : 'fake-hosted', sovereign,
    async type(c) { return { relation, confidence: 0.9, typer: sovereign ? 'fake-local' : 'fake-hosted', sovereign, reason: 'fake', newerId: c.b.id, olderId: c.a.id }; },
});

const { engines, close } = await linkEngines('disc');

for (const eng of engines) {
    console.log(`\n${eng.name}`);

    await test('finds an old pair Loop A missed: provenance stamped, caller edge untouched, opted-out node excluded, second run adds nothing', async () => {
        const g = await eng.open();
        // a-b are close (20deg, cos .94); z is far; o is an autolink:false node right next to a; x-y carry a CALLER semantic edge.
        const vb = await seed(g, [['a', 0], ['b', 20], ['z', 90], ['o', 5], ['x', 150], ['y', 160]]);
        await g.setLinkOptOuts!(['o'], true);
        await g.addEdge({ sourceId: 'x', targetId: 'y', relation: REL, confidence: 'extracted', confidenceScore: 0.42, provenance: { origin: 'caller' } } as never);
        const r = await rig(g, vb);
        const res = await r.disc.run(WS);
        assert.equal(res.stop, 'complete');
        assert.ok(res.passCompleted);
        const live = await linkEdges(g);
        const ab = live.get(pair('a', 'b'));
        assert.ok(ab, `a-b linked: ${[...live.keys()]}`);
        assert.equal(ab!.origin, 'link_on_arrival');
        const rows = await g.queryEdges({ relation: REL, limit: 100, offset: 0, includeProvenance: true });
        const abRow = rows.find((e: any) => pair(e.sourceId, e.targetId) === pair('a', 'b')) as any;
        assert.equal(abRow.provenance.policyVersion, 'p-disc');
        assert.equal(abRow.provenance.modelFingerprint, FP);
        const xy = rows.find((e: any) => pair(e.sourceId, e.targetId) === pair('x', 'y')) as any;
        assert.equal(xy.provenance.origin, 'caller', 'caller edge keeps its origin');
        assert.equal(xy.confidenceScore, 0.42, 'caller edge keeps its score');
        assert.ok(![...live.keys()].some((k) => k.split('|').includes('o')), 'autolink:false node has no edge in either direction');
        assert.ok(![...live.keys()].some((k) => k.split('|').includes('z')), 'far node stays unlinked');
        const again = await r.disc.run(WS);
        assert.equal(again.linksAdded, 0, 'idempotent');
        assert.equal((await linkEdges(g)).size, live.size);
        const st = r.disc.stats();
        assert.ok(st.linksAdded >= 1 && st.passes >= 1 && st.pairsScanned > 0);
    });

    await test('near-duplicate => supersedes proposal + supersession candidate; nothing superseded until accepted; accept then reject', async () => {
        const g = await eng.open();
        const vb = await seed(g, [['old', 100]]);
        await sleep(15);
        await g.upsertNode(node('new')); vb.set('new', 100.5); // newer, cos(0.5deg) ~ 1
        await g.upsertNode(node('same')); vb.set('same', 100.2);
        const r = await rig(g, vb);
        await r.disc.run(WS);
        const pend = r.proposals.list(WS);
        assert.ok(pend.length >= 1, 'proposals raised');
        const p = pend.find((x) => x.kind === 'supersedes' && x.fromId === 'new' && x.toId === 'old');
        assert.ok(p, `new supersedes old proposed: ${JSON.stringify(pend.map((x) => [x.kind, x.fromId, x.toId]))}`);
        assert.equal(p!.typer, 'rules');
        assert.equal(p!.sovereign, true);
        assert.ok(r.dups.some((d) => [d.a, d.b].sort().join() === ['new', 'old'].sort().join()), 'listed as a supersession candidate');
        assert.equal(await supersededBy(g, 'old'), null, 'proposal changes nothing');
        const out = await acceptProposal({ workspace: WS, graph: g as never, proposals: r.proposals, now: Date.now }, p!.id, { by: 'tester' });
        assert.equal(out.ok, true, JSON.stringify(out));
        assert.equal(await supersededBy(g, 'old'), 'new', 'accept superseded the old node');
        const sedges = await g.queryEdges({ relation: 'supersedes', limit: 10, offset: 0 });
        assert.ok(sedges.some((e: any) => e.sourceId === 'new' && e.targetId === 'old'), 'supersedes edge written');
        assert.equal(r.proposals.get(WS, p!.id)!.status, 'accepted');
        assert.equal((await acceptProposal({ workspace: WS, graph: g as never, proposals: r.proposals, now: Date.now }, p!.id)).ok, false, 'second decision refused');
        const other = r.proposals.list(WS).find((x) => x.id !== p!.id);
        if (other) {
            const rej = rejectProposal({ workspace: WS, proposals: r.proposals, now: Date.now }, other.id, { note: 'no' });
            assert.equal(rej.ok, true);
            assert.equal(r.proposals.add({ workspace: WS, kind: other.kind, fromId: other.fromId, toId: other.toId, score: 1, typer: 'rules', sovereign: true }, Date.now()), false, 'a rejected pair is never re-raised');
        }
    });

    await test('typed outcomes: supports => typed edge (origin discovery, NOT SOVEREIGN marked when hosted); contradicts => proposal only', async () => {
        const g = await eng.open();
        const vb = await seed(g, [['s1', 10], ['s2', 25]]);
        const r = await rig(g, vb, { typers: [fakeTyper('supports', false)] });
        await r.disc.run(WS);
        const sup = await g.queryEdges({ relation: 'supports', limit: 10, offset: 0, includeProvenance: true }) as any[];
        assert.equal(sup.length, 1, 'one supports edge');
        assert.equal(sup[0].provenance.origin, 'discovery');
        assert.match(String(sup[0].provenance.modelFingerprint), /fake-hosted.*NOT-SOVEREIGN/);
        const log = r.proposals.listLog(WS, 10);
        assert.ok(log.some((l) => l.outcome === 'edge_written' && l.relation === 'supports' && l.sovereign === false), 'logged, sovereign=false');

        const g2 = await eng.open();
        const vb2 = await seed(g2, [['c1', 10], ['c2', 25]]);
        const r2 = await rig(g2, vb2, { typers: [fakeTyper('contradicts', true)] });
        await r2.disc.run(WS);
        assert.equal((await g2.queryEdges({ relation: 'contradicts', limit: 10, offset: 0 })).length, 0, 'no contradicts edge before acceptance');
        const cp = r2.proposals.list(WS, { kind: 'contradicts' });
        assert.equal(cp.length, 1);
        assert.equal(await supersededBy(g2, 'c1'), null);
        assert.equal(await supersededBy(g2, 'c2'), null);
    });

    await test('budgets stop the run and resume from the durable cursor to the same graph; busy backs off without writing', async () => {
        const spec: Array<[string, number]> = Array.from({ length: 12 }, (_, i) => [`n${String(i).padStart(2, '0')}`, i * 6]);
        const gAll = await eng.open();
        const rAll = await rig(gAll, await seed(gAll, spec));
        await rAll.disc.run(WS);
        const want = [...(await linkEdges(gAll)).keys()].sort();
        assert.ok(want.length > 5, 'fixture links');

        const g = await eng.open();
        const vb = await seed(g, spec);
        const r = await rig(g, vb, { config: { seedBatch: 2, maxNodes: 3 } });
        const first = await r.disc.run(WS);
        assert.equal(first.stop, 'budget_nodes');
        const st1 = r.store.get(WS)!;
        assert.ok(st1.cursorId !== null && st1.watermark === null, 'cursor persisted, pass not finished');
        assert.ok(r.disc.stats().budgetStops >= 1);
        let guard = 0, last = first;
        while (!last.passCompleted && guard++ < 20) last = await r.disc.run(WS);
        assert.ok(last.passCompleted, 'resumed and finished');
        assert.deepEqual([...(await linkEdges(g)).keys()].sort(), want, 'same graph as one unbudgeted run');
        assert.equal(r.store.get(WS)!.cursorId, null);
        assert.ok(r.store.get(WS)!.watermark, 'watermark set');

        const g2 = await eng.open();
        const rp = await rig(g2, await seed(g2, spec), { config: { maxPairs: 2 } });
        assert.equal((await rp.disc.run(WS)).stop, 'budget_pairs');
        let t = 0;
        const g3 = await eng.open();
        const rt = await rig(g3, await seed(g3, spec), { config: { maxMs: 100, seedBatch: 3 }, now: () => (t += 60) });
        assert.equal((await rt.disc.run(WS)).stop, 'budget_time');

        const g4 = await eng.open();
        const rb = await rig(g4, await seed(g4, spec), { isBusy: () => true });
        const busy = await rb.disc.run(WS);
        assert.equal(busy.stop, 'busy');
        assert.equal((await linkEdges(g4)).size, 0, 'busy => nothing written');
        assert.equal(rb.store.get(WS)?.cursorId ?? null, null, 'busy => cursor not advanced');
    });

    await test('later pass only re-walks recently changed nodes and picks up a new unlinked pair', async () => {
        const g = await eng.open();
        const vb = await seed(g, [['p', 0], ['q', 100]]);
        const r = await rig(g, vb);
        const one = await r.disc.run(WS);
        assert.ok(one.passCompleted);
        assert.equal((await linkEdges(g)).size, 0);
        await g.upsertNode(node('p2')); vb.set('p2', 15);
        const two = await r.disc.run(WS);
        assert.ok(two.passCompleted);
        assert.ok((await linkEdges(g)).has(pair('p', 'p2')), 'new pair found on the next pass');
    });
}

await close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
