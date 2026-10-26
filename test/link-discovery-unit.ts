#!/usr/bin/env tsx
/**
 * test/link-discovery-unit.ts - pure-logic checks for Links Loop D (discovery config, state + proposal stores, the
 * typing cascade, the NLI and judge typers, the OpenAI-compatible client, and the /metrics series). No model is
 * loaded and nothing is downloaded: the NLI classifier and the judge client are injected fakes, and the HTTP client
 * talks to an ephemeral loopback server.
 *
 * Run: npx tsx test/link-discovery-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

process.env['LORE_HOME'] = fs.mkdtempSync(path.join(os.tmpdir(), 'link-disc-unit-'));
const { renderMetrics } = await import('../packages/lore/src/mcp/http/routes/metrics.js');

import { DISCOVERY_DEFAULTS, applyDiscoveryOverrides, isLinkDiscoveryEnabled, loadDiscoveryConfig } from '../packages/lore/src/link/discoveryConfig.js';
import { SqliteDiscoveryStore, emptyDiscoveryState } from '../packages/lore/src/link/discoveryStore.js';
import { SqliteProposalStore } from '../packages/lore/src/link/proposalStore.js';
import { RulesTyper, TypingCascade, type IRelationTyper, type RelationCandidate, type TypingContext, type TypingNode } from '../packages/lore/src/link/relationTyper.js';
import { NliTyper, normalizeNliLabel } from '../packages/lore/src/link/nliTyper.js';
import { LlmJudgeTyper, OpenAiCompatibleJudgeClient, isLoopbackUrl, parseJudgeReply, type JudgeClient } from '../packages/lore/src/link/judgeTyper.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}

const tn = (id: string, createdAt: string, extra: Partial<TypingNode> = {}): TypingNode => ({ id, label: id, content: `text of ${id}`, createdAt, updatedAt: createdAt, supersededBy: null, ...extra });
const cand = (score: number, a = tn('a', '2026-01-01T00:00:00Z'), b = tn('b', '2026-02-01T00:00:00Z')): RelationCandidate => ({ a, b, score });
const ctx = (budget = 100): TypingContext & { taken: number; stops: number } => {
    const c = { taken: 0, stops: 0, workspace: 'w', takeBudget() { if (c.taken >= budget) return false; c.taken++; return true; }, onBudgetStop() { c.stops++; } };
    return c;
};

console.log('\nlink discovery unit\n');

await test('config: defaults are OFF; env parses; out-of-range env falls back; overrides win and bad ones throw', () => {
    assert.equal(DISCOVERY_DEFAULTS.enabled, false);
    assert.equal(isLinkDiscoveryEnabled({}), false);
    assert.equal(loadDiscoveryConfig({}).enabled, false);
    const c = loadDiscoveryConfig({ LORE_LINK_DISCOVERY: '1', LORE_LINK_DISCOVERY_MAX_NODES: '77', LORE_LINK_DISCOVERY_MAX_PAIRS: '-3', LORE_LINK_SUPERSEDE_SIM: '0.9', LORE_LINK_NLI: 'on', LORE_LINK_NLI_MODEL: 'x/y', LORE_LINK_JUDGE_URL: 'http://127.0.0.1:1/v1', LORE_LINK_JUDGE_BUDGET: '3' });
    assert.equal(c.enabled, true);
    assert.equal(c.maxNodes, 77);
    assert.equal(c.maxPairs, DISCOVERY_DEFAULTS.maxPairs, 'out-of-range env falls back');
    assert.equal(c.supersedeSim, 0.9);
    assert.deepEqual([c.nli.enabled, c.nli.model, c.nli.allowDownload], [true, 'x/y', false], 'download is never implied');
    assert.deepEqual([c.judge.endpoint, c.judge.budgetPerRun, c.judge.hosted], ['http://127.0.0.1:1/v1', 3, false]);
    assert.equal(applyDiscoveryOverrides(c, false).enabled, false);
    assert.equal(applyDiscoveryOverrides(loadDiscoveryConfig({}), true).enabled, true);
    const o = applyDiscoveryOverrides(c, { maxNodes: 5, judge: { budgetPerRun: 0 } });
    assert.deepEqual([o.enabled, o.maxNodes, o.judge.budgetPerRun, o.maxPairs], [true, 5, 0, c.maxPairs]);
    for (const bad of [{ maxNodes: 0 }, { maxMs: Number.NaN }, { supersedeSim: 1.5 }, { nli: { minConfidence: 2 } }, { judge: { timeoutMs: 1 } }]) {
        assert.throws(() => applyDiscoveryOverrides(c, bad as never), RangeError, JSON.stringify(bad));
    }
});

await test('discovery store: round-trips the cursor and counters, per workspace', () => {
    const s = new SqliteDiscoveryStore(':memory:');
    assert.equal(s.get('w'), null);
    s.put({ ...emptyDiscoveryState('w'), cursorUpdatedAt: '2026-01-01T00:00:00.000Z', cursorId: 'n9', passes: 2, linksAdded: 5, judgeDay: '2026-10-24', judgeUsed: 4 });
    s.put({ ...emptyDiscoveryState('v'), watermark: 'wm' });
    const g = s.get('w')!;
    assert.deepEqual([g.cursorUpdatedAt, g.cursorId, g.passes, g.linksAdded, g.judgeUsed], ['2026-01-01T00:00:00.000Z', 'n9', 2, 5, 4]);
    s.put({ ...g, cursorId: null, cursorUpdatedAt: null, watermark: 'done' });
    assert.deepEqual([s.get('w')!.cursorId, s.get('w')!.watermark, s.get('v')!.watermark], [null, 'done', 'wm']);
    assert.equal(s.list().length, 2);
    s.close();
});

await test('proposal store: unique per pair, rejected never re-raised, decide only once, log bounded + ordered', () => {
    const s = new SqliteProposalStore(':memory:');
    const p = { workspace: 'w', kind: 'supersedes' as const, fromId: 'new', toId: 'old', score: 0.99, typer: 'rules', sovereign: true, reason: 'dup' };
    assert.equal(s.add(p, 1), true);
    assert.equal(s.add(p, 2), false, 'same pair is not raised twice');
    assert.equal(s.add({ ...p, workspace: 'v' }, 2), true, 'other workspace is independent');
    const [row] = s.list('w');
    assert.equal(row!.status, 'pending');
    assert.equal(s.decide('w', row!.id, 'rejected', 5, 'me', 'no'), true);
    assert.equal(s.decide('w', row!.id, 'accepted', 6, 'me', null), false, 'a decided proposal cannot be re-decided');
    assert.equal(s.add(p, 7), false, 'a rejected pair is never re-raised');
    assert.equal(s.list('w').length, 0, 'default list is pending only');
    assert.equal(s.list('w', { status: 'any' }).length, 1);
    assert.deepEqual(s.counts(), { pending: 1, accepted: 0, rejected: 1, stale: 0 });
    assert.equal(s.add({ ...p, kind: 'contradicts', fromId: 'a', toId: 'b', score: 0.5 }, 8), true);
    assert.equal(s.list('w', { kind: 'contradicts' }).length, 1);
    for (let i = 0; i < 3; i++) s.log({ workspace: 'w', a: 'a', b: `b${i}`, relation: 'supports', typer: 'rules', sovereign: true, confidence: 0.9, outcome: 'edge_written', at: i });
    assert.deepEqual(s.listLog('w', 2).map((l) => l.b), ['b2', 'b1'], 'newest first, limited');
    s.close();
});

await test('RulesTyper: near-duplicate + differing timestamps => newer supersedes older; otherwise nothing', async () => {
    const r = new RulesTyper(0.97);
    const v = await r.type(cand(0.99));
    assert.deepEqual([v?.relation, v?.newerId, v?.olderId, v?.sovereign], ['supersedes', 'b', 'a', true]);
    assert.equal(await r.type(cand(0.9)), null, 'below the threshold');
    assert.equal(await r.type(cand(0.99, tn('a', '2026-01-01T00:00:00Z'), tn('b', '2026-01-01T00:00:00Z'))), null, 'equal timestamps: cannot tell which is newer');
    assert.equal(await r.type(cand(0.99, tn('a', '2026-01-01T00:00:00Z', { supersededBy: 'z' }))), null, 'already superseded');
    assert.equal((await r.type(cand(0.99, tn('a', '2026-03-01T00:00:00Z'), tn('b', '2026-02-01T00:00:00Z'))))?.newerId, 'a');
});

await test('NliTyper: entailment => supports, contradiction => contradicts, neutral or low confidence falls through, reverse read tried', async () => {
    const seen: string[] = [];
    const mk = (fn: (p: string, h: string) => { label: 'entailment' | 'contradiction' | 'neutral'; score: number }) =>
        new NliTyper({ model: 'm', minConfidence: 0.8, classifier: { classify: async (p, h) => { seen.push(p); return fn(p, h); } } });
    assert.equal((await mk(() => ({ label: 'entailment', score: 0.95 })).type(cand(0.9)))?.relation, 'supports');
    assert.equal((await mk(() => ({ label: 'contradiction', score: 0.9 })).type(cand(0.9)))?.relation, 'contradicts');
    assert.equal(await mk(() => ({ label: 'neutral', score: 0.99 })).type(cand(0.9)), null);
    assert.equal(await mk(() => ({ label: 'entailment', score: 0.5 })).type(cand(0.9)), null);
    seen.length = 0;
    const v = await mk((p) => (p.startsWith('b') ? { label: 'entailment', score: 0.9 } : { label: 'neutral', score: 0.9 })).type(cand(0.9));
    assert.equal(v?.relation, 'supports', 'second direction decided');
    assert.equal(v?.sovereign, true);
    assert.equal(v?.typer, 'nli:m');
    assert.equal(normalizeNliLabel('LABEL_2'), null);
    assert.equal(normalizeNliLabel('ENTAILMENT'), 'entailment');
});

await test('parseJudgeReply: tolerates prose/fences, validates relation, confidence and supersede direction', () => {
    const c = cand(0.9);
    assert.deepEqual(parseJudgeReply('```json\n{"relation":"supports","confidence":0.8,"reason":"r"}\n```', c), { relation: 'supports', confidence: 0.8, reason: 'r' });
    const s = parseJudgeReply('Sure: {"relation":"supersedes","confidence":0.9,"newer":"A"}', c)!;
    assert.deepEqual([s.newerId, s.olderId], ['a', 'b']);
    assert.equal(parseJudgeReply('{"relation":"supersedes","confidence":0.9}', c), null, 'supersedes needs a direction');
    assert.equal(parseJudgeReply('{"relation":"none","confidence":0.9}', c), null);
    assert.equal(parseJudgeReply('{"relation":"supports"}', c), null, 'confidence required');
    assert.equal(parseJudgeReply('not json', c), null);
    assert.equal(parseJudgeReply('{"relation":"supports","confidence":7}', c)?.confidence, 1, 'clamped');
});

await test('LlmJudgeTyper: budget enforced, low confidence dropped, hosted verdict marked NOT SOVEREIGN', async () => {
    let calls = 0;
    const reply = '{"relation":"contradicts","confidence":0.9,"reason":"opposite"}';
    const client = (sovereign: boolean, text = reply): JudgeClient => ({ sovereign, complete: async () => { calls++; return text; } });
    const local = new LlmJudgeTyper({ client: client(true), model: 'j', minConfidence: 0.7 });
    const c1 = ctx(1);
    const v = await local.type(cand(0.9), c1);
    assert.deepEqual([v?.relation, v?.sovereign, v?.typer], ['contradicts', true, 'judge:j']);
    assert.ok(!/NOT SOVEREIGN/.test(v?.reason ?? ''));
    assert.equal(await local.type(cand(0.9), c1), null, 'budget spent');
    assert.deepEqual([calls, c1.stops], [1, 1], 'no call is made once the budget is spent; the stop is counted');
    const hosted = await new LlmJudgeTyper({ client: client(false), model: 'h', minConfidence: 0.7 }).type(cand(0.9), ctx());
    assert.equal(hosted?.sovereign, false);
    assert.match(hosted?.reason ?? '', /NOT SOVEREIGN/);
    assert.equal(await new LlmJudgeTyper({ client: client(true, '{"relation":"supports","confidence":0.3}'), model: 'j', minConfidence: 0.7 }).type(cand(0.9), ctx()), null);
});

await test('cascade: first verdict wins, a throwing typer is skipped, sovereignty is the AND of verdict and typer', async () => {
    const errors: string[] = [];
    const boom: IRelationTyper = { id: 'boom', sovereign: true, type: async () => { throw new Error('x'); } };
    const hosted: IRelationTyper = { id: 'h', sovereign: false, type: async () => ({ relation: 'supports', confidence: 0.9, typer: 'h', sovereign: true }) };
    const never: IRelationTyper = { id: 'never', sovereign: true, type: async () => { throw new Error('should not run'); } };
    const v = await new TypingCascade([boom, hosted, never], { onError: (m) => errors.push(m) }).type(cand(0.9), ctx());
    assert.deepEqual([v?.typer, v?.sovereign], ['h', false]);
    assert.equal(errors.length, 1);
    assert.equal(await new TypingCascade([boom]).type(cand(0.9), ctx()), null);
});

await test('OpenAiCompatibleJudgeClient: loopback only unless hosted is explicit; talks to a local server; key only in the header', async () => {
    assert.equal(isLoopbackUrl('http://127.0.0.1:1234/v1'), true);
    assert.equal(isLoopbackUrl('http://localhost/v1'), true);
    assert.equal(isLoopbackUrl('https://api.example.com/v1'), false);
    assert.equal(isLoopbackUrl('http://127.0.0.1.evil.com/v1'), false, 'a look-alike hostname is not loopback');
    assert.throws(() => new OpenAiCompatibleJudgeClient({ endpoint: 'https://api.example.com/v1', model: 'm', hosted: false, timeoutMs: 1000 }), /judge_endpoint_not_local/);
    assert.throws(() => new OpenAiCompatibleJudgeClient({ endpoint: 'file:///etc/passwd', model: 'm', hosted: true, timeoutMs: 1000 }), /judge_endpoint_invalid/);
    assert.equal(new OpenAiCompatibleJudgeClient({ endpoint: 'https://api.example.com/v1', model: 'm', hosted: true, timeoutMs: 1000 }).sovereign, false);

    let seenAuth: string | undefined, seenBody = '', seenPath = '';
    const srv = http.createServer((req, res) => {
        seenAuth = req.headers.authorization; seenPath = req.url ?? '';
        let b = ''; req.on('data', (d) => { b += d; });
        req.on('end', () => { seenBody = b; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: '{"relation":"supports","confidence":0.9}' } }] })); });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    try {
        const port = (srv.address() as { port: number }).port;
        const cl = new OpenAiCompatibleJudgeClient({ endpoint: `http://127.0.0.1:${port}/v1`, model: 'mm', hosted: false, timeoutMs: 5000, apiKey: 'test-key-123' });
        assert.equal(cl.sovereign, true);
        const out = await cl.complete({ system: 's', user: 'u' });
        assert.match(out, /supports/);
        assert.equal(seenPath, '/v1/chat/completions');
        assert.equal(seenAuth, 'Bearer test-key-123');
        assert.equal(JSON.parse(seenBody).model, 'mm');
        assert.ok(!seenBody.includes('test-key-123'), 'key is not in the body');
        const typer = new LlmJudgeTyper({ client: cl, model: 'mm', minConfidence: 0.5 });
        assert.equal((await typer.type(cand(0.9), ctx()))?.relation, 'supports');
    } finally { await new Promise<void>((r) => srv.close(() => r())); }
    const bad = http.createServer((_q, res) => { res.statusCode = 500; res.end('no'); });
    await new Promise<void>((r) => bad.listen(0, '127.0.0.1', r));
    try {
        const cl = new OpenAiCompatibleJudgeClient({ endpoint: `http://127.0.0.1:${(bad.address() as { port: number }).port}`, model: 'm', hosted: false, timeoutMs: 5000 });
        await assert.rejects(() => cl.complete({ system: 's', user: 'u' }), /judge_http_500/);
    } finally { await new Promise<void>((r) => bad.close(() => r())); }
});

await test('/metrics: lore_link_discovery_* series appear only when discovery stats exist', async () => {
    const base = { lagMs: 0, queue: { ready: 0, claimed: 0, failed: 0 }, linkedTotal: 0, edgesWrittenTotal: 0, refreshedTotal: 0, invalidatedTotal: 0 };
    const withD = await renderMetrics({ linkStats: () => ({ ...base, discovery: { enabled: true, runs: 3, passes: 1, nodesScanned: 40, pairsScanned: 90, linksAdded: 7, supportsAdded: 2, proposalsRaised: 4, budgetStops: 1, pendingProposals: 3, typers: ['rules'], active: 0, lastRunAt: 1 } }) as never });
    const line = (re: RegExp): string => { const m = withD.split('\n').find((l) => re.test(l)); assert.ok(m, `metrics line ${re}`); return m!; };
    assert.match(line(/^lore_link_discovery_runs_total /), /\s3$/);
    assert.match(line(/^lore_link_discovery_links_added_total /), /\s7$/);
    assert.match(line(/^lore_link_discovery_supports_added_total /), /\s2$/);
    assert.match(line(/^lore_link_discovery_proposals_raised_total /), /\s4$/);
    assert.match(line(/^lore_link_discovery_budget_stops_total /), /\s1$/);
    assert.match(line(/^lore_link_discovery_pending_proposals /), /\s3$/);
    const without = await renderMetrics({ linkStats: () => base as never });
    assert.ok(!without.includes('lore_link_discovery'), 'no discovery stats => no discovery series');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
