#!/usr/bin/env tsx
/**
 * test/supersede-atomic-live-e2e.ts - 3.35.0 (q) LIVE check: write-time `supersedes` is ONE atomic commit on ArcadeDB.
 *
 * Two real arcade-mode daemons (ports from the harness) on ONE ArcadeDB database, one tenant/app.
 *   (1) Load (SUPERSEDE_SECONDS, default 60): rounds of overlapping supersedes. Each round seeds 6 targets, then 4 writers
 *       (2 per daemon) concurrently post a successor each, whose `supersedes` windows overlap (w0 {0,1,2}, w1 {2,3,4},
 *       w2 {4,5,0}, w3 {1,3,5}); several rounds run at once. At most one successor can claim a target, so some items
 *       are refused `already_superseded` - that is a correct answer, but it must leave NOTHING behind.
 *   Oracle (ArcadeDB directly): 0 partial supersedes - every mark has its successor and its `supersedes` edge, every
 *   edge has its mark, every ok successor holds all its targets, every refused successor is absent with no edges;
 *   0 dead outbox rows; CME retries used (LORE_NODE_BATCH_TRACE lines from both daemons).
 *   (2) Re-send repair (skipped with SUPERSEDE_SKIP_REPAIR=1, e.g. for the old-main contrast): partial states built with
 *       direct SQL (mark without edge, edge without mark, successor with neither) are re-sent; the answer is `ok` with
 *       the half-done targets in `supersedesRepaired`, the missing halves exist afterwards, and a second re-send is
 *       `unchanged`.
 *
 * Run: LORE_ARCADE_E2E_URL=... LORE_ARCADE_E2E_ROOT_PASSWORD_FILE=... npx tsx test/supersede-atomic-live-e2e.ts
 * Env: SUPERSEDE_SECONDS, SUPERSEDE_PARALLEL_ROUNDS (default 3), NODE_BATCH_TREE / NODE_BATCH_PORTS (see the harness).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import * as H from './node-batch-arcade-harness.js';

const SECONDS = Number(process.env['SUPERSEDE_SECONDS'] ?? 60);
const PARALLEL = Number(process.env['SUPERSEDE_PARALLEL_ROUNDS'] ?? 3);
const SKIP_REPAIR = process.env['SUPERSEDE_SKIP_REPAIR'] === '1';
// A fresh tenant per run: ids and edge counts never collide with an earlier run's leftovers.
const CUSTOMER = `sup${Date.now().toString(36)}`;
const APP = 'app1';
const DB = `tenant_${CUSTOMER}_${APP}`;

const codeOf = (item: Record<string, unknown> | undefined): string => {
    if (!item) return 'no_item';
    if (item['ok'] === true) return item['unchanged'] === true ? 'unchanged' : 'ok';
    const m = /^([a-z][a-z_]*): /.exec(String(item['error'] ?? ''));
    return m ? m[1]! : `other:${String(item['error'] ?? '').slice(0, 70)}`;
};
const bump = (t: Record<string, number>, k: string, n = 1): void => { t[k] = (t[k] ?? 0) + n; };

function outboxStatuses(home: string): Record<string, number> {
    const out: Record<string, number> = {};
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
        .flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
    for (const f of walk(home).filter((p) => /outbox.*\.(sqlite|db)$/i.test(p))) {
        let db: Database.Database | null = null;
        try {
            db = new Database(f, { readonly: true });
            for (const r of db.prepare("SELECT status, COUNT(*) AS n FROM outbox_entries GROUP BY 1").all() as Array<{ status: string; n: number }>) bump(out, r.status, r.n);
        } catch { /* not an outbox file */ } finally { try { db?.close(); } catch { /* ignore */ } }
    }
    return out;
}

const WINDOWS = [[0, 1, 2], [2, 3, 4], [4, 5, 0], [1, 3, 5]];

async function main(): Promise<void> {
    const homes = [H.mkHome('sup-a'), H.mkHome('sup-b')];
    let d1: H.Daemon | null = null;
    let d2: H.Daemon | null = null;
    let exit = 0;
    try {
        d1 = await H.startDaemon(H.PORTS[0], homes[0]!);
        const tok = await H.provisionAndIssue(d1, CUSTOMER, APP);
        d2 = await H.startSecondDaemon(d1, H.PORTS[1], homes[1]!);
        const ds = [d1, d2];
        console.log(`daemons up: ${H.PORTS.join(', ')} tree=${H.TREE} seconds=${SECONDS} parallelRounds=${PARALLEL}`);
        const pacing: Record<string, number> = {};
        const bulk = async (d: H.Daemon, nodes: Array<Record<string, unknown>>): Promise<Array<Record<string, unknown>>> => {
            for (let a = 0; ; a++) {
                const r = await H.call(d.port, 'POST', '/api/nodes/bulk', { token: tok, body: { workspace: APP, nodes: nodes.map((n) => ({ type: 'decision', label: 'l', ...n })) } });
                if (r.status === 429 || r.status === 503) {
                    bump(pacing, `http${r.status}`);
                    if (a >= 60) return [];
                    await H.sleep(Math.max(250, Number(r.json['retryAfter'] ?? r.json['retry_after'] ?? 1) * 1000));
                    continue;
                }
                return (r.json['results'] as Array<Record<string, unknown>> | undefined) ?? [];
            }
        };
        for (const d of ds) await bulk(d, [{ id: `warm-${d.port}`, content: 'w' }]);

        const fails: string[] = [];
        const tally: Record<string, number> = {};
        const okSuccessors = new Map<string, string[]>();   // successor -> its targets
        const refusedSuccessors = new Set<string>();
        const unknownSuccessors = new Set<string>();         // neither ok nor a clean refusal: judged by consistency only
        const oddAnswers: string[] = [];
        const traceBefore = ds.map((d) => d.log.text.length);
        const deadline = Date.now() + SECONDS * 1000;
        const t0 = Date.now();

        const round = async (lane: number): Promise<void> => {
            for (let n = 0; Date.now() < deadline; n++) {
                const rid = `r${lane}x${n}`;
                const targets = Array.from({ length: 6 }, (_, k) => `tg-${rid}-${k}`);
                const seeded = await bulk(ds[lane % 2]!, targets.map((id) => ({ id, content: `seed-${id}` })));
                if (seeded.length !== targets.length || seeded.some((s) => codeOf(s) !== 'ok')) { bump(tally, 'seed_failed'); continue; }
                await Promise.all(WINDOWS.map(async (win, w) => {
                    const sid = `su-${rid}-${w}`;
                    const sup = win.map((k) => targets[k]!);
                    const res = await bulk(ds[w % 2]!, [{ id: sid, content: `succ-${sid}`, supersedes: sup }]);
                    const c = codeOf(res[0]);
                    bump(tally, c);
                    if (c === 'ok') okSuccessors.set(sid, sup);
                    // A clean refusal: nothing may be left behind. `arcade_error` here is ArcadeDB's commit-time RecordNotFoundException
                    // (HTTP 500 "Error on transaction commit", not classed as a CME; ~0.07% of items live): a definite failure
                    // that rolled back - tolerated as an answer, but held to the same nothing-left-behind oracle.
                    else if (c === 'already_superseded' || c === 'contention' || c === 'arcade_error') refusedSuccessors.add(sid);
                    else { unknownSuccessors.add(sid); if (oddAnswers.length < 5) oddAnswers.push(`${sid}: ${JSON.stringify(res[0]).slice(0, 400)}`); }
                }));
            }
        };
        await Promise.all(Array.from({ length: PARALLEL }, (_, l) => round(l)));
        const loadSecs = (Date.now() - t0) / 1000;

        // Oracle: read marks and edges straight from ArcadeDB.
        const pageAll = async (sql: string): Promise<Array<Record<string, unknown>>> => {
            const all: Array<Record<string, unknown>> = [];
            for (let skip = 0; ; skip += 5000) { const rows = await H.arcadeSql(DB, `${sql} SKIP ${skip} LIMIT 5000`); all.push(...rows); if (rows.length < 5000) return all; }
        };
        const marks = await pageAll("SELECT id, supersededBy FROM LoreNode WHERE supersededBy IS NOT NULL AND supersededBy <> '' ORDER BY id");
        const edges = await pageAll("SELECT outV().id AS s, inV().id AS t FROM LoreEdge WHERE relation = 'supersedes' ORDER BY s, t");
        const succNodes = new Set((await pageAll("SELECT id FROM LoreNode WHERE id LIKE 'su-%' ORDER BY id")).map((r) => String(r['id'])));
        const markOf = new Map(marks.map((r) => [String(r['id']), String(r['supersededBy'])]));
        const edgeSet = new Set(edges.map((r) => `${String(r['s'])}>${String(r['t'])}`));
        let partial = 0;
        for (const [t, s] of markOf) {
            if (!edgeSet.has(`${s}>${t}`)) { partial++; fails.push(`mark without edge: ${t} supersededBy ${s}`); }
            if (!succNodes.has(s)) { partial++; fails.push(`mark whose successor is absent: ${t} -> ${s}`); }
        }
        for (const e of edgeSet) {
            const [s, t] = e.split('>') as [string, string];
            if (markOf.get(t) !== s) { partial++; fails.push(`edge without mark: ${s} -> ${t} (mark=${markOf.get(t) ?? 'none'})`); }
        }
        for (const [s, sup] of okSuccessors) {
            for (const t of sup) {
                if (markOf.get(t) !== s) { partial++; fails.push(`ok successor ${s} does not hold ${t}`); }
                if (!edgeSet.has(`${s}>${t}`)) { partial++; fails.push(`ok successor ${s} lacks edge to ${t}`); }
            }
        }
        for (const s of refusedSuccessors) {
            if (succNodes.has(s)) { partial++; fails.push(`refused successor ${s} is stored`); }
            if ([...edgeSet].some((e) => e.startsWith(`${s}>`))) { partial++; fails.push(`refused successor ${s} left an edge`); }
        }
        // Each target has exactly one supersedes edge in (a duplicate edge or a second claimant would show here).
        const edgesPerTarget = new Map<string, number>();
        for (const r of edges) { const t = String(r['t']); edgesPerTarget.set(t, (edgesPerTarget.get(t) ?? 0) + 1); }
        for (const [t, n] of edgesPerTarget) if (n > 1) { partial++; fails.push(`target ${t} has ${n} supersedes edges`); }

        await H.sleep(2500);
        const outboxTotal: Record<string, number> = {};
        for (const d of ds) for (const [k, v] of Object.entries(outboxStatuses(d.home))) bump(outboxTotal, k, v);
        const dead = (outboxTotal['dead'] ?? 0) + (outboxTotal['dead_lettered'] ?? 0);
        const lines = ds.map((d, k) => d.log.text.slice(traceBefore[k]!).split('\n')).flat();
        const batchRetry = lines.filter((l) => /\[node-batch\]/.test(l) && /retry|contention/i.test(l)).length;
        const storeRetry = lines.filter((l) => /\[arcade-retry\]/.test(l)).length;
        const exhausted = lines.filter((l) => /exhausted/.test(l)).length;
        console.log(`\nload: ${loadSecs.toFixed(1)}s, ${PARALLEL} parallel rounds x 4 writers over 2 daemons`);
        console.log(`supersede item answers: ${JSON.stringify(tally)}`);
        console.log(`ok successors=${okSuccessors.size} refused(already_superseded+contention+arcade_error)=${refusedSuccessors.size} other=${unknownSuccessors.size}`);
        console.log(`stored: marks=${marks.length} supersedes edges=${edges.length} successor nodes=${succNodes.size}`);
        for (const o of oddAnswers) console.log(`odd answer: ${o}`);
        console.log(`PARTIAL SUPERSEDES = ${partial}`);
        console.log(`paced (429/503 honoured): ${JSON.stringify(pacing)}`);
        console.log(`outbox rows by status (both daemons): ${JSON.stringify(outboxTotal)}  dead=${dead}`);
        console.log(`CME retries (trace lines): [node-batch] retry=${batchRetry}  [arcade-retry] store-level=${storeRetry}  exhausted=${exhausted}`);
        if (dead) fails.push(`${dead} dead outbox rows`);
        for (const [c, n] of Object.entries(tally)) if (!['ok', 'already_superseded', 'contention', 'arcade_error'].includes(c) && n) fails.push(`${n} item(s) answered ${c}`);

        if (!SKIP_REPAIR) {
            console.log('\n-- (2) re-send repair --');
            const D = ds[0]!;
            const mk = (id: string) => ({ id, content: `seed-${id}` });
            const seed = ['pm-t1', 'pm-t2', 'ed-t1', 'ed-t2', 'ne-t1', 'ne-t2'];
            await bulk(D, seed.map(mk));
            // Successors exist already (the first, partial attempt wrote them); links are half-done.
            const succ = (id: string, sup: string[]) => ({ id, content: `succ-${id}`, supersedes: sup });
            await bulk(D, [{ id: 'pm-s' , content: 'succ-pm-s' }, { id: 'ed-s', content: 'succ-ed-s' }, { id: 'ne-s', content: 'succ-ne-s' }]);
            // mark-only: pm-t1 marked, no edge
            await H.arcadeSql(DB, "UPDATE LoreNode SET supersededBy = 'pm-s', supersededAt = :at, supersededReason = 'partial' WHERE id = 'pm-t1'", { at: new Date().toISOString() });
            // edge-only: ed-t1 has the edge, no mark
            await H.arcadeSql(DB, "CREATE EDGE LoreEdge FROM (SELECT FROM LoreNode WHERE id = 'ed-s') TO (SELECT FROM LoreNode WHERE id = 'ed-t1') SET relation = 'supersedes', confidence = 'extracted', confidenceScore = 1.0, bidirectional = false");
            const r1 = await bulk(D, [succ('pm-s', ['pm-t1', 'pm-t2']), succ('ed-s', ['ed-t1', 'ed-t2']), succ('ne-s', ['ne-t1', 'ne-t2'])]);
            console.log(`re-send of partials: ${JSON.stringify(r1.map((x) => ({ c: codeOf(x), rep: x['supersedesRepaired'] })))}`);
            const want = [['pm-t1'], ['ed-t1'], undefined];
            r1.forEach((x, i) => {
                if (codeOf(x) !== 'ok') fails.push(`repair item ${i} answered ${codeOf(x)}, not ok`);
                const rep = x['supersedesRepaired'] as string[] | undefined;
                const exp = want[i];
                if (exp && JSON.stringify([...(rep ?? [])].sort()) !== JSON.stringify(exp)) fails.push(`repair item ${i} repaired=${JSON.stringify(rep)} want ${JSON.stringify(exp)}`);
            });
            for (const [s, ts] of [['pm-s', ['pm-t1', 'pm-t2']], ['ed-s', ['ed-t1', 'ed-t2']], ['ne-s', ['ne-t1', 'ne-t2']]] as const) {
                for (const t of ts) {
                    const m = (await H.arcadeSql(DB, 'SELECT supersededBy FROM LoreNode WHERE id = :t', { t }))[0]?.['supersededBy'];
                    const e = (await H.arcadeSql(DB, "SELECT count(*) AS n FROM LoreEdge WHERE relation = 'supersedes' AND outV().id = :s AND inV().id = :t", { s, t }))[0]?.['n'];
                    if (m !== s || Number(e) !== 1) fails.push(`after repair ${s}->${t}: mark=${String(m)} edges=${String(e)}`);
                }
            }
            const r2 = await bulk(D, [succ('pm-s', ['pm-t1', 'pm-t2']), succ('ed-s', ['ed-t1', 'ed-t2']), succ('ne-s', ['ne-t1', 'ne-t2'])]);
            console.log(`second re-send (complete): ${JSON.stringify(r2.map((x) => codeOf(x)))}`);
            r2.forEach((x, i) => { if (codeOf(x) !== 'unchanged') fails.push(`complete re-send item ${i} answered ${codeOf(x)}, not unchanged`); });
        }

        if (fails.length === 0) console.log('\nPASS');
        else { exit = 1; console.error(`\nFAIL: ${fails.length} violation(s):\n  ${fails.slice(0, 30).join('\n  ')}`); }
    } finally {
        H.stopDaemon(d1); H.stopDaemon(d2);
        for (const h of homes) H.rmHome(h);
    }
    process.exit(exit);
}
main().catch((e) => { console.error(e); process.exit(1); });
