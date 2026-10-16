#!/usr/bin/env tsx
/**
 * test/node-batch-two-daemon-e2e.ts - 3.35.0 S1 acceptance (plan 6.1): preconditions are safe ACROSS DAEMONS.
 *
 * Two real daemons (separate LORE_HOME, ports 48471/48472) on ONE ArcadeDB database, one tenant/app. Per iteration:
 *   1. seed X (revision r) and targets A, B (present on even iterations, absent on odd ones);
 *   2. concurrently (jittered starts): writer A on daemon 1 and writer B on daemon 2, each with
 *      preconditions:[{id:X, revision:r}], and a bumper writing X (plain upsert);
 *   3. then a LATE writer C on the other daemon, started only AFTER the bumper's response, same precondition.
 * Oracle (checked against ArcadeDB directly):
 *   - atomicity: a writer returned success <=> its node exists (a refused writer left nothing behind);
 *   - the late writer C is ALWAYS refused (409 precondition): it is ordered after the bump in real time;
 *   - stale-write proof: X.revision == r + (bump landed ? 1 : 0), and X.txTouch == number of landed writers.
 *     Every landed writer committed a touch guarded by `revision = r`; the bump moves X off r exactly once, so a
 *     landed write cannot have committed after the bump. (Skipped when NODE_BATCH_EXPECT_TOUCH=0, the old-main run.)
 * Variants: V1 bumper on daemon 1 (single-write route); V2 bumper on daemon 2; V3 bulk route writers.
 * Counts reported per variant: successes, 409s, 503 contention, other, trace-line retries.
 *
 * Run: LORE_ARCADE_E2E_URL=... LORE_ARCADE_E2E_ROOT_PASSWORD_FILE=... npx tsx test/node-batch-two-daemon-e2e.ts
 * Env: NODE_BATCH_ITERATIONS (default 100), NODE_BATCH_VARIANTS (default V1,V2,V3), NODE_BATCH_CUSTOMER (default nbtwo),
 *      NODE_BATCH_EXPECT_TOUCH (default 1), NODE_BATCH_TREE / NODE_BATCH_PORTS (see the harness).
 */
import * as H from './node-batch-arcade-harness.js';

const ITER = Number(process.env['NODE_BATCH_ITERATIONS'] ?? 100);
const VARIANTS = (process.env['NODE_BATCH_VARIANTS'] ?? 'V1,V2,V3').split(',');
const CUSTOMER = process.env['NODE_BATCH_CUSTOMER'] ?? 'nbtwo';
const APP = 'app1';
const DB = `tenant_${CUSTOMER}_${APP}`;
const EXPECT_TOUCH = (process.env['NODE_BATCH_EXPECT_TOUCH'] ?? '1') !== '0';
const rand = (lo: number, hi: number): number => lo + Math.floor(Math.random() * (hi - lo + 1));

type Verdict = 'landed' | 'precondition' | 'contention' | string;
interface Tally { landed: number; precondition: number; contention: number; other: Record<string, number> }
const newTally = (): Tally => ({ landed: 0, precondition: 0, contention: 0, other: {} });
const count = (t: Tally, v: Verdict): void => {
    if (v === 'landed' || v === 'precondition' || v === 'contention') t[v]++;
    else t.other[v] = (t.other[v] ?? 0) + 1;
};

async function main(): Promise<void> {
    const homes = [H.mkHome('two-a'), H.mkHome('two-b')];
    let d1: H.Daemon | null = null;
    let d2: H.Daemon | null = null;
    let exit = 0;
    try {
        d1 = await H.startDaemon(H.PORTS[0], homes[0]!);
        const tok = await H.provisionAndIssue(d1, CUSTOMER, APP);
        d2 = await H.startSecondDaemon(d1, H.PORTS[1], homes[1]!);
        const ds = [d1, d2];
        console.log(`daemons up: ${H.PORTS.join(', ')}  tree=${H.TREE}  iterations=${ITER}  variants=${VARIANTS.join(',')}`);

        const single = (d: H.Daemon, body: Record<string, unknown>) => H.call(d.port, 'POST', '/api/node', { token: tok, body: { type: 'decision', label: 'l', content: 'c', ...body } });
        const bulkOne = (d: H.Daemon, body: Record<string, unknown>) => H.call(d.port, 'POST', '/api/nodes/bulk', { token: tok, body: { workspace: APP, nodes: [{ type: 'decision', label: 'l', content: 'c', ...body }] } });
        const verdictSingle = (r: H.Res): Verdict => {
            if (r.status === 201 || r.status === 200) return 'landed';
            if (r.status === 409 && JSON.stringify(r.json).includes('precondition')) return 'precondition';
            if (r.status === 503 && r.json['code'] === 'contention') return 'contention';
            return `http${r.status}:${String(r.json['code'] ?? '')}`;
        };
        const verdictBulk = (r: H.Res): Verdict => {
            if (r.status === 503 && r.json['code'] === 'contention') return 'contention';
            const item = (r.json['results'] as Array<Record<string, unknown>> | undefined)?.[0];
            if (r.status === 200 && item?.['ok'] === true) return 'landed';
            const blob = JSON.stringify(item ?? r.json);
            if (/precondition/.test(blob)) return 'precondition';
            if (/contention/.test(blob)) return 'contention';
            return `http${r.status}:${blob.slice(0, 80)}`;
        };

        // Warm both daemons (embedder, pools) so the first iterations are not skewed.
        for (const d of ds) await single(d, { id: `warm-${d.port}` });

        const fails: string[] = [];
        for (const variant of VARIANTS) {
            const bumpDaemon = variant === 'V2' ? d2 : d1;
            const lateDaemon = variant === 'V2' ? d1 : d2;
            const write = variant === 'V3' ? bulkOne : single;
            const verdict = variant === 'V3' ? verdictBulk : verdictSingle;
            const writers = newTally();
            const late = newTally();
            const bumps = newTally();
            let both = 0, one = 0, none = 0, bumpMissed = 0;
            const t0 = Date.now();
            const traceBefore = ds.map((d) => d.log.text.length);
            for (let i = 0; i < ITER; i++) {
                const id = (s: string) => `${variant}-${i}-${s}`;
                const X = id('X'), A = id('A'), B = id('B'), C = id('C');
                await single(d1, { id: X, content: 'seed' });
                for (let k = rand(0, 2); k > 0; k--) await single(d1, { id: X, content: `seed-${k}-${Math.random()}` });
                if (i % 2 === 0) { await single(d1, { id: A }); await single(d1, { id: B }); }
                const r = Number((await H.arcadeSql(DB, 'SELECT revision FROM LoreNode WHERE id = :id', { id: X }))[0]?.['revision'] ?? 0);
                const touch0 = Number((await H.arcadeSql(DB, 'SELECT txTouch FROM LoreNode WHERE id = :id', { id: X }))[0]?.['txTouch'] ?? 0);
                const pre = [{ id: X, revision: r }];

                const timed = async <T>(delay: number, fn: () => Promise<T>): Promise<{ v: T; end: number }> => {
                    await H.sleep(delay);
                    const v = await fn();
                    return { v, end: performance.now() };
                };
                const [rb, ra, rw] = await Promise.all([
                    timed(10, () => single(bumpDaemon, { id: X, content: `bump-${i}-${Math.random()}` })),
                    timed(rand(0, 45), () => write(d1!, { id: A, preconditions: pre })),
                    timed(rand(0, 45), () => write(d2!, { id: B, preconditions: pre })),
                ]);
                const vb = verdictSingle(rb.v), va = verdict(ra.v), vw = verdict(rw.v);
                count(bumps, vb); count(writers, va); count(writers, vw);
                const nLanded = [va, vw].filter((v) => v === 'landed').length;
                if (vb !== 'landed') bumpMissed++;
                if (nLanded === 2) both++; else if (nLanded === 1) one++; else none++;

                // Strictly after the bump's response: the opposite daemon must refuse.
                const vc = verdict(await write(lateDaemon, { id: C, preconditions: pre }));
                count(late, vc);

                const rows = await H.arcadeSql(DB, 'SELECT id, revision, txTouch FROM LoreNode WHERE id IN [:a, :b, :c, :x]', { a: A, b: B, c: C, x: X });
                const by = new Map(rows.map((row) => [String(row['id']), row]));
                const tag = `${variant} iter ${i} (r=${r}) A=${va} B=${vw} bump=${vb} C=${vc}`;
                const x = by.get(X);
                const expectRev = r + (vb === 'landed' ? 1 : 0);
                const appeared = (node: string, v: Verdict, expectPresentWhenLanded: boolean): void => {
                    const present = by.has(node);
                    if (expectPresentWhenLanded && v === 'landed' && !present) fails.push(`${tag}: ${node} reported landed but is absent`);
                    if (v !== 'landed' && present && (node === C || i % 2 === 1)) fails.push(`${tag}: ${node} refused (${v}) but exists`);
                };
                appeared(A, va, true); appeared(B, vw, true); appeared(C, vc, true);
                if (vc !== 'precondition') fails.push(`${tag}: late writer was not refused with a precondition failure`);
                if (Number(x?.['revision']) !== expectRev) fails.push(`${tag}: X.revision=${x?.['revision']} expected ${expectRev}`);
                if (EXPECT_TOUCH) {
                    const touches = Number(x?.['txTouch'] ?? 0) - touch0;
                    if (touches !== nLanded) fails.push(`${tag}: X.txTouch grew by ${touches} but ${nLanded} writers landed`);
                }
                if (vc === 'landed') fails.push(`${tag}: STALE WRITE - late writer landed after the bump`);
            }
            const lines = ds.map((d, k) => d.log.text.slice(traceBefore[k]!).split('\n').filter((l) => l.startsWith('[node-batch]'))).flat();
            const retries = lines.filter((l) => /engine=retry/.test(l) && /contention attempt=/.test(l)).length;
            const exhausted = lines.filter((l) => /engine=retry/.test(l) && /exhausted/.test(l)).length;
            const batchLines = lines.filter((l) => /engine=arcade/.test(l));
            const batches = batchLines.length;
            const outcomes: Record<string, number> = {};
            for (const l of batchLines) { const o = /outcome=(\S+)/.exec(l)?.[1] ?? '?'; outcomes[o] = (outcomes[o] ?? 0) + 1; }
            const fmt = (t: Tally) => `landed(200/201)=${t.landed} refused409=${t.precondition} contention503=${t.contention} other=${JSON.stringify(t.other)}`;
            console.log(`\n[${variant}] ${ITER} iterations in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
            console.log(`  concurrent writers A+B (2/iter): ${fmt(writers)}  | outcome mix: both=${both} one=${one} none=${none}`);
            console.log(`  late writer C   (1/iter):        ${fmt(late)}`);
            console.log(`  bumper          (1/iter):        ${fmt(bumps)}  (bump not landed: ${bumpMissed})`);
            console.log(`  engine batches=${batches} by outcome ${JSON.stringify(outcomes)}  contention retries=${retries}  retries exhausted=${exhausted}  (from LORE_NODE_BATCH_TRACE)`);
        }
        if (fails.length === 0) console.log(`\nPASS: zero violations over ${ITER * VARIANTS.length} iterations (${VARIANTS.join(', ')})`);
        else { exit = 1; console.error(`\nFAIL: ${fails.length} violation(s):\n  ${fails.slice(0, 25).join('\n  ')}`); }
        const dumpStale = fails.filter((f) => /STALE/.test(f)).length;
        console.log(`stale writes (late writer landed after the bump): ${dumpStale}`);
    } finally {
        H.stopDaemon(d1); H.stopDaemon(d2);
        for (const h of homes) H.rmHome(h);
    }
    process.exit(exit);
}
main().catch((e) => { console.error(e); process.exit(1); });
