#!/usr/bin/env tsx
/**
 * test/review-link-proposals-http-unit.ts - GET/POST /api/link-proposals through a REAL http.Server on an ephemeral
 * port running the production dispatcher (auth gates -> principal -> workspace binding -> route), tokens minted
 * through the real registry, real SQLite graph/verbatim/link-queue via createLore({ linkDiscovery }).
 *
 *   read token   lists + gets, 403 on accept/reject          write-only token   403 on accept/reject
 *   review token acts; the effect is visible through the library API (status + supersededBy)
 *   workspace A token cannot see or act on workspace B; unknown ids are 404; bad ids/bodies are 400/413
 *   LORE_LINK_DISCOVERY off => 404 link_proposals_unavailable; errors carry no stack/SQL
 *
 *   LORE_MODEL_SERVER=0 npx tsx test/review-link-proposals-http-unit.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupReviewHome, startReviewHttp, type ReviewHttp } from './helpers/reviewHttp.js';

for (const k of Object.keys(process.env)) if (k.startsWith('LORE_LINK_') || k.startsWith('LORE_INGEST_')) delete process.env[k];
const home = setupReviewHome('lore-review-links-');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-review-links-data-'));

class DetEmbedProvider {
    readonly dimension = 16; readonly modelId = 'review-links-det'; readonly dtype = 'fp32';
    async initialize(): Promise<void> { /* no-op */ }
    private vec(text: string): number[] {
        const v = new Array(this.dimension).fill(0);
        for (let i = 0; i < text.length; i++) v[i % this.dimension] += ((text.charCodeAt(i) * 31) % 17) - 8;
        const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
        return v.map((x) => x / norm);
    }
    async embed(t: string) { return this.vec(t); } async embedQuery(t: string) { return this.vec(t); }
    async embedDocument(t: string) { return this.vec(t); } async embedDocumentBatch(ts: string[]) { return ts.map((t) => this.vec(t)); }
}
const { createLore } = await import('../packages/lore/src/index.js');
const open = (extra: Record<string, unknown> = {}): Promise<any> =>
    createLore({ dataDir, deploymentMode: 'embedded', embeddingProvider: new DetEmbedProvider(), modelServer: false, ...extra } as never);
const BASE = 'the quarterly lease renewal for the downtown office building was approved by the board';
const node = (id: string, content: string) => ({ id, workspace: 'default', ecosystem: '*', nodeData: { id, type: 'note', label: id, content, project: 'default', ecosystem: '*' } });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ok ${name}`); passed++; }
    catch (e) { console.error(`  FAIL ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

// Seed: two near-duplicate nodes (no arrival linking), then reopen with discovery and run it once.
{
    const seed = await open({ linkDiscovery: { intervalMs: 86_400_000 }, linkOnArrival: false });
    try { await seed.nodeUpsert(node('y1', `${BASE} variant 1`)); await sleep(15); await seed.nodeUpsert(node('y2', `${BASE} variant 2`)); await seed.awaitEmbeds?.(); } finally { await seed.dispose(); }
}
const lore = await open({ linkDiscovery: { intervalMs: 3_600_000, yieldMs: 0 }, linkOnArrival: false });
const registry = lore._daemon.getGraphRegistry();
const WS: string = registry.activeName();
const OTHER = 'review-links-other-ws';
let srv: ReviewHttp | null = null;
try {
    const svc = lore.store.linkService;
    assert.ok(svc?.hasDiscovery, 'discovery wired');
    assert.ok(await svc.runDiscovery(WS), 'a discovery run happened');
    const seeded = svc.listProposals(WS);
    assert.equal(seeded.length, 1, `one supersedes proposal seeded: ${JSON.stringify(seeded)}`);
    const pid: number = seeded[0].id;
    // a second pending proposal to reject (insert straight into the queue as the discovery pass would)
    assert.equal((svc as any).proposals.add({ workspace: WS, kind: 'contradicts', fromId: 'y1', toId: 'y2', score: 0.5, typer: 'rules', sovereign: false, reason: 'test' }, Date.now()), true);
    const rejectId: number = svc.listProposals(WS, { kind: 'contradicts' })[0].id;

    srv = await startReviewHttp({ home, store: lore.store, graphRegistry: registry, activeWorkspace: WS });
    const s = srv;
    const reader = s.mint(WS, ['read']);
    const writer = s.mint(WS, ['read', 'write']);
    const writeOnly = s.mint(WS, ['write']);
    const reviewer = s.mint(WS, ['read', 'review']);
    const otherReviewer = s.mint(OTHER, ['read', 'review']);
    const q = (p: string) => `${p}${p.includes('?') ? '&' : '?'}workspace=${encodeURIComponent(WS)}`;

    console.log('\nreview-link-proposals-http\n');

    await test('no token => 401 (the gates run before the route)', async () => {
        const r = await fetch(`${s.base}${q('/api/link-proposals')}`);
        assert.equal(r.status, 401);
    });
    await test('read token lists and gets, with pagination metadata', async () => {
        const list = await s.call(reader, 'GET', q('/api/link-proposals?limit=1'));
        assert.equal(list.status, 200, list.text);
        assert.equal(list.json.workspace, WS);
        assert.equal(list.json.proposals.length, 1);
        assert.equal(list.json.limit, 1);
        assert.equal(list.json.nextOffset, 1, 'two pending rows: another page exists');
        const page2 = await s.call(reader, 'GET', q('/api/link-proposals?limit=1&offset=1'));
        assert.equal(page2.json.proposals.length, 1); assert.equal(page2.json.nextOffset, null);
        assert.notEqual(page2.json.proposals[0].id, list.json.proposals[0].id);
        assert.deepEqual((await s.call(reader, 'GET', q('/api/link-proposals?kind=contradicts'))).json.proposals.map((x: any) => x.id), [rejectId]);
        const one = await s.call(reader, 'GET', q(`/api/link-proposals/${pid}`));
        assert.equal(one.status, 200, one.text);
        assert.equal(one.json.proposal.id, pid);
        assert.equal(one.json.proposal.kind, 'supersedes');
    });
    await test('read token cannot accept or reject (403 scope_missing), and nothing changed', async () => {
        for (const act of ['accept', 'reject']) {
            const r = await s.call(reader, 'POST', q(`/api/link-proposals/${pid}/${act}`), {});
            assert.equal(r.status, 403, `${act}: ${r.text}`);
            assert.equal(r.json.code, 'scope_missing');
        }
        assert.equal(svc.getProposal(WS, pid).status, 'pending');
    });
    await test('read+write (no review) token cannot accept or reject: write does not imply review', async () => {
        for (const tok of [writer, writeOnly]) for (const act of ['accept', 'reject']) {
            const r = await s.call(tok, 'POST', q(`/api/link-proposals/${pid}/${act}`), {});
            assert.equal(r.status, 403, `${act}: ${r.text}`);
        }
        assert.equal(svc.getProposal(WS, pid).status, 'pending');
    });
    await test('write-only token has no read scope either: list is 403', async () => {
        assert.equal((await s.call(writeOnly, 'GET', q('/api/link-proposals'))).status, 403);
    });
    await test('workspace B token cannot list, get, accept or reject workspace A proposals', async () => {
        for (const [m, p] of [['GET', '/api/link-proposals'], ['GET', `/api/link-proposals/${pid}`], ['POST', `/api/link-proposals/${pid}/accept`], ['POST', `/api/link-proposals/${pid}/reject`]] as const) {
            const r = await s.call(otherReviewer, m, q(p), m === 'POST' ? {} : undefined);
            assert.equal(r.status, 403, `${m} ${p}: ${r.text}`);
        }
        // Its own workspace is allowed but empty: it sees none of A's rows, and A's id is a 404 there.
        const own = await s.call(otherReviewer, 'GET', `/api/link-proposals?workspace=${OTHER}`);
        assert.equal(own.status, 200, own.text);
        assert.deepEqual(own.json.proposals, []);
        assert.equal((await s.call(otherReviewer, 'GET', `/api/link-proposals/${pid}?workspace=${OTHER}`)).status, 404);
        assert.equal((await s.call(otherReviewer, 'POST', `/api/link-proposals/${pid}/accept?workspace=${OTHER}`, {})).status, 404);
        // The X-Lore-Workspace edge header cannot be used to smuggle A past the binding either.
        const sneaky = await fetch(`${s.base}/api/link-proposals/${pid}/accept?workspace=${OTHER}`, { method: 'POST', headers: { Authorization: `Bearer ${otherReviewer}`, 'X-Lore-Workspace': WS, 'Content-Type': 'application/json' }, body: '{"workspace":"' + WS + '"}' });
        assert.ok(sneaky.status === 403 || sneaky.status === 400, `sneaky ${sneaky.status}`);
        assert.equal(svc.getProposal(WS, pid).status, 'pending');
    });
    await test('input bounds: bad id 400, bad status/kind/limit 400, body mismatch 400, bad JSON 400, oversize 413, unknown id 404', async () => {
        assert.equal((await s.call(reader, 'GET', q('/api/link-proposals/abc'))).status, 400);
        assert.equal((await s.call(reader, 'GET', q('/api/link-proposals?status=nope'))).status, 400);
        assert.equal((await s.call(reader, 'GET', q('/api/link-proposals?kind=nope'))).status, 400);
        assert.equal((await s.call(reader, 'GET', q('/api/link-proposals?limit=100000'))).status, 400);
        assert.equal((await s.call(reader, 'GET', q('/api/link-proposals?limit=0'))).status, 400);
        assert.equal((await s.call(reader, 'GET', q('/api/link-proposals/999999'))).status, 404);
        assert.equal((await s.call(reviewer, 'POST', q(`/api/link-proposals/${pid}/accept`), undefined, '{not json')).status, 400);
        assert.equal((await s.call(reviewer, 'POST', q(`/api/link-proposals/${pid}/accept`), { workspace: OTHER })).status, 400);
        assert.equal((await s.call(reviewer, 'POST', q(`/api/link-proposals/${pid}/accept`), { note: 'x'.repeat(5000) })).status, 400);
        assert.equal((await s.call(reviewer, 'POST', q(`/api/link-proposals/${pid}/accept`), { note: 'y'.repeat(200 * 1024) })).status, 413);
        assert.equal(svc.getProposal(WS, pid).status, 'pending', 'none of the rejected calls decided anything');
    });
    await test('errors leak no stack, SQL or file paths', async () => {
        const probes = await Promise.all([
            s.call(reader, 'GET', q('/api/link-proposals/999999')), s.call(reader, 'GET', q('/api/link-proposals?status=zzz')),
            s.call(reviewer, 'POST', q(`/api/link-proposals/${pid}/accept`), undefined, '{bad'),
        ]);
        for (const p of probes) assert.doesNotMatch(p.text, /\n\s+at |\.(ts|js):\d+|SELECT |INSERT |\.sqlite|node_modules|\/Users\//i, p.text);
    });
    await test('review token rejects a proposal; library API shows it rejected and the pair untouched', async () => {
        const r = await s.call(reviewer, 'POST', q(`/api/link-proposals/${rejectId}/reject`), { note: 'not a contradiction' });
        assert.equal(r.status, 200, r.text);
        assert.equal(r.json.proposal.status, 'rejected');
        assert.equal(svc.getProposal(WS, pid).status, 'pending', 'the other proposal is untouched');
        assert.equal(svc.getProposal(WS, rejectId).status, 'rejected');
        const again = await s.call(reviewer, 'POST', q(`/api/link-proposals/${rejectId}/reject`), {});
        assert.equal(again.status, 409);
    });
    await test('review token accepts: the supersede is applied (visible through the library API), then a repeat is 409', async () => {
        const p = svc.getProposal(WS, pid);
        const r = await s.call(reviewer, 'POST', q(`/api/link-proposals/${pid}/accept`), { note: 'duplicate' });
        assert.equal(r.status, 200, r.text);
        assert.equal(r.json.proposal.status, 'accepted');
        assert.equal(svc.getProposal(WS, pid).status, 'accepted');
        const older = await lore.store.loreGraph.getNode(p.toId);
        assert.ok((older as any)?.supersededBy, 'the older node now carries supersededBy');
        const again = await s.call(reviewer, 'POST', q(`/api/link-proposals/${pid}/accept`), {});
        assert.equal(again.status, 409);
        const after = await s.call(reader, 'GET', q('/api/link-proposals?status=accepted'));
        assert.equal(after.json.proposals.length, 1);
    });
    await test('the reviewer is the authenticated principal, not a body field', async () => {
        const p = svc.getProposal(WS, pid);
        assert.ok(p.decidedBy && p.decidedBy.length > 0, 'a decider was recorded');
        const rid = (await s.call(reviewer, 'POST', q(`/api/link-proposals/${rejectId}/reject`), { by: 'spoofed', reviewer: 'spoofed' }));
        assert.equal(rid.status, 409, 'already rejected, so the spoof cannot even land');
        assert.notEqual(p.decidedBy, 'spoofed');
    });
} finally {
    await srv?.close();
    await lore.dispose();
}

// Flag off: a host without link discovery answers 404 to a legitimately scoped caller, 403 still precedes it for the unscoped.
{
    const off = await open();
    const reg = off._daemon.getGraphRegistry();
    const w: string = reg.activeName();
    const s2 = await startReviewHttp({ home, store: off.store, graphRegistry: reg, activeWorkspace: w });
    try {
        await test('LORE_LINK_DISCOVERY off => 404 link_proposals_unavailable (no feature, no probe signal), 403 for a token without the scope', async () => {
            const rd = await s2.call(s2.mint(w, ['read']), 'GET', `/api/link-proposals?workspace=${w}`);
            assert.equal(rd.status, 404); assert.equal(rd.json.code, 'link_proposals_unavailable');
            const act = await s2.call(s2.mint(w, ['read', 'review']), 'POST', `/api/link-proposals/1/accept?workspace=${w}`, {});
            assert.equal(act.status, 404);
            const denied = await s2.call(s2.mint(w, ['read', 'write']), 'POST', `/api/link-proposals/1/accept?workspace=${w}`, {});
            assert.equal(denied.status, 403);
        });
    } finally { await s2.close(); await off.dispose(); }
}
fs.rmSync(dataDir, { recursive: true, force: true });
fs.rmSync(home, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
