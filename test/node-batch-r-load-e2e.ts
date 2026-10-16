#!/usr/bin/env tsx
/**
 * test/node-batch-r-load-e2e.ts - 3.35.0 (r) LIVE load check: plain bulk writes and `ifAbsent` creates
 * survive ArcadeDB concurrent-modification aborts (Nokshi M1/(c): 48 of 2000 `ifAbsent` creates came back
 * `arcade_unavailable`).
 *
 * Two real arcade-mode daemons (ports from the harness) on ONE ArcadeDB database, one tenant/app.
 *   Load (NODE_BATCH_R_SECONDS, default 60): 4 `ifAbsent` writers (2 per daemon) each posting bulks of fresh ids,
 *   plus 2 plain-bulk writers (1 per daemon) rewriting an OVERLAPPING pool of ids.
 *   Race: N ids, each created by 4 writers at once (2 daemons) - exactly one wins, the rest `already_exists`,
 *   and the stored content is the winner's (never an overwrite).
 * Oracle (checked against ArcadeDB directly): every `ok` fresh id exists; a failed fresh id is absent;
 * zero `already_exists` on fresh ids; counts of `arcade_unavailable`/`contention`/other; dead outbox rows;
 * retries used (LORE_NODE_BATCH_TRACE lines, engine=retry, from both daemons).
 *
 * Run: LORE_ARCADE_E2E_URL=... LORE_ARCADE_E2E_ROOT_PASSWORD_FILE=... npx tsx test/node-batch-r-load-e2e.ts
 * Env: NODE_BATCH_R_SECONDS, NODE_BATCH_R_RACES (default 60), NODE_BATCH_R_BATCH (items per bulk, default 20),
 *      NODE_BATCH_TREE / NODE_BATCH_PORTS (see the harness).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import * as H from './node-batch-arcade-harness.js';

const SECONDS = Number(process.env['NODE_BATCH_R_SECONDS'] ?? 60);
const RACES = Number(process.env['NODE_BATCH_R_RACES'] ?? 60);
const BATCH = Number(process.env['NODE_BATCH_R_BATCH'] ?? 20);
const CUSTOMER = process.env['NODE_BATCH_R_CUSTOMER'] ?? 'nbr';
const APP = 'app1';
const DB = `tenant_${CUSTOMER}_${APP}`;

const codeOf = (item: Record<string, unknown> | undefined): string => {
    if (!item) return 'no_item';
    if (item['ok'] === true) return 'ok';
    const m = /^([a-z][a-z_]*): /.exec(String(item['error'] ?? ''));
    return m ? m[1]! : `other:${String(item['error'] ?? '').slice(0, 60)}`;
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
            // `dead` + "superseded by newer same-key write" is the replicator's own coalescing of overlapping plain writes
            // (a newer row for the same id replaced it), not a lost write - counted apart from a real dead letter.
            for (const r of db.prepare("SELECT CASE WHEN status = 'dead' AND lastError LIKE 'superseded by newer same-key write%' THEN 'dead_coalesced' ELSE status END AS status, COUNT(*) AS n FROM outbox_entries GROUP BY 1").all() as Array<{ status: string; n: number }>) bump(out, r.status, r.n);
        } catch { /* not an outbox file */ } finally { try { db?.close(); } catch { /* ignore */ } }
    }
    return out;
}

async function main(): Promise<void> {
    const homes = [H.mkHome('r-a'), H.mkHome('r-b')];
    let d1: H.Daemon | null = null;
    let d2: H.Daemon | null = null;
    let exit = 0;
    try {
        d1 = await H.startDaemon(H.PORTS[0], homes[0]!);
        const tok = await H.provisionAndIssue(d1, CUSTOMER, APP);
        d2 = await H.startSecondDaemon(d1, H.PORTS[1], homes[1]!);
        const ds = [d1, d2];
        console.log(`daemons up: ${H.PORTS.join(', ')} tree=${H.TREE} seconds=${SECONDS} batch=${BATCH} races=${RACES}`);
        const bulk = (d: H.Daemon, nodes: Array<Record<string, unknown>>) =>
            H.call(d.port, 'POST', '/api/nodes/bulk', { token: tok, body: { workspace: APP, nodes: nodes.map((n) => ({ type: 'decision', label: 'l', ...n })) } });
        // Whole-request refusals (429 rate limit, 503 outbox/backpressure) are the daemon's own pacing: honour them like a real
        // client would, and count them separately - they are not per-item write failures.
        const paced = async (d: H.Daemon, nodes: Array<Record<string, unknown>>): Promise<H.Res> => {
            for (let a = 0; ; a++) {
                const r = await bulk(d, nodes);
                if (r.status !== 429 && r.status !== 503) return r;
                bump(pacing, `http${r.status}${a === 0 ? ':' + r.raw.slice(0, 90) : ''}`);
                if (a >= 60) return r;
                await H.sleep(Math.max(250, Number(r.json['retryAfter'] ?? r.json['retry_after'] ?? 1) * 1000));
            }
        };
        const items = (r: H.Res): Array<Record<string, unknown>> => (r.json['results'] as Array<Record<string, unknown>> | undefined) ?? [];
        for (const d of ds) await bulk(d, [{ id: `warm-${d.port}`, content: 'w' }]);

        const fails: string[] = [];
        const ifAbsentTally: Record<string, number> = {};
        const plainTally: Record<string, number> = {};
        const okIds = new Set<string>();
        const failedIds = new Set<string>();
        const httpBad: Record<string, number> = {};
        const pacing: Record<string, number> = {};
        const traceBefore = ds.map((d) => d.log.text.length);
        const deadline = Date.now() + SECONDS * 1000;
        const t0 = Date.now();

        const ifAbsentWriter = async (w: number): Promise<void> => {
            const d = ds[w % 2]!;
            for (let n = 0; Date.now() < deadline; n++) {
                const ids = Array.from({ length: BATCH }, (_, k) => `ia-${w}-${n}-${k}`);
                const r = await paced(d, ids.map((id) => ({ id, content: `c-${id}`, ifAbsent: true })));
                const res = items(r);
                if (r.status !== 200 || res.length !== ids.length) { bump(httpBad, `http${r.status}`); for (const id of ids) failedIds.add(id); continue; }
                res.forEach((it, k) => {
                    const c = codeOf(it);
                    bump(ifAbsentTally, c);
                    (c === 'ok' ? okIds : failedIds).add(ids[k]!);
                    if (c === 'already_exists') fails.push(`fresh id ${ids[k]} answered already_exists`);
                });
            }
        };
        const POOL = 150;
        const plainWriter = async (w: number): Promise<void> => {
            const d = ds[w % 2]!;
            for (let n = 0; Date.now() < deadline; n++) {
                const picked = new Set<string>();
                while (picked.size < BATCH) picked.add(`pl-${Math.floor(Math.random() * POOL)}`);
                const r = await paced(d, [...picked].map((id) => ({ id, content: `plain-${w}-${n}-${Math.random()}` })));
                const res = items(r);
                if (r.status !== 200) { bump(httpBad, `plain-http${r.status}`); continue; }
                for (const it of res) bump(plainTally, codeOf(it));
            }
        };
        await Promise.all([0, 1, 2, 3].map(ifAbsentWriter).concat([0, 1].map(plainWriter)));
        const loadSecs = (Date.now() - t0) / 1000;

        // Oracle against ArcadeDB directly.
        const stored = new Set((await H.arcadeSql(DB, "SELECT id FROM LoreNode WHERE id LIKE 'ia-%'")).map((r) => String(r['id'])));
        let failedButStored = 0, okButMissing = 0;
        for (const id of failedIds) if (stored.has(id)) failedButStored++;
        for (const id of okIds) if (!stored.has(id)) okButMissing++;
        if (okButMissing) fails.push(`${okButMissing} ids answered ok but are absent`);
        const unavailable = (ifAbsentTally['arcade_unavailable'] ?? 0) + (plainTally['arcade_unavailable'] ?? 0);

        // Duplicate-create race across both daemons.
        let raceWinnerOk = 0, raceExists = 0, raceUnavail = 0, raceOther = 0, raceOverwritten = 0;
        for (let i = 0; i < RACES; i++) {
            const id = `race-${i}`;
            const writers = [0, 1, 2, 3].map((w) => paced(ds[w % 2]!, [{ id, content: `winner-candidate-${w}`, ifAbsent: true }]).then((r) => ({ w, code: codeOf(items(r)[0]) })));
            const outs = await Promise.all(writers);
            const oks = outs.filter((o) => o.code === 'ok');
            for (const o of outs) { if (o.code === 'already_exists') raceExists++; else if (o.code === 'arcade_unavailable') raceUnavail++; else if (o.code !== 'ok') raceOther++; }
            raceWinnerOk += oks.length;
            if (oks.length !== 1) fails.push(`${id}: ${oks.length} writers answered ok (codes ${outs.map((o) => o.code).join(',')})`);
            const row = (await H.arcadeSql(DB, 'SELECT content, revision FROM LoreNode WHERE id = :id', { id }))[0];
            if (oks.length === 1 && row?.['content'] !== `winner-candidate-${oks[0]!.w}`) { raceOverwritten++; fails.push(`${id}: stored content ${String(row?.['content'])} is not the winner's`); }
            if (row && row['revision'] !== 1) fails.push(`${id}: revision ${String(row['revision'])} (an overwrite bumps it)`);
        }

        await H.sleep(1500);
        const outbox = ds.map((d) => outboxStatuses(d.home));
        const outboxTotal: Record<string, number> = {};
        for (const o of outbox) for (const [k, v] of Object.entries(o)) bump(outboxTotal, k, v);
        const dead = outboxTotal['dead'] ?? outboxTotal['dead_lettered'] ?? 0;
        const lines = ds.map((d, k) => d.log.text.slice(traceBefore[k]!).split('\n')).flat();
        const retryLines = lines.filter((l) => /retry/.test(l) && /attempt=/.test(l)).length;
        const cmeLines = lines.filter((l) => /\[arcade-retry\]/.test(l)).length;
        const exhausted = lines.filter((l) => /exhausted/.test(l)).length;

        const ifTotal = Object.values(ifAbsentTally).reduce((a, b) => a + b, 0);
        console.log(`\nload: ${loadSecs.toFixed(1)}s, 4 ifAbsent writers + 2 plain writers (overlapping pool of ${POOL})`);
        console.log(`ifAbsent fresh ids: total=${ifTotal} ${JSON.stringify(ifAbsentTally)}`);
        console.log(`plain overlapping bulk items: ${JSON.stringify(plainTally)}`);
        console.log(`whole-request failures: ${JSON.stringify(httpBad)}\npaced (429/503 honoured and re-sent): ${JSON.stringify(pacing)}`);
        console.log(`oracle: answered-ok-but-absent=${okButMissing}  failed-but-stored=${failedButStored}`);
        console.log(`arcade_unavailable (ifAbsent+plain) = ${unavailable}`);
        console.log(`race (${RACES} ids x 4 writers): ok=${raceWinnerOk} already_exists=${raceExists} arcade_unavailable=${raceUnavail} other=${raceOther} overwritten=${raceOverwritten}`);
        console.log(`outbox rows by status (both daemons): ${JSON.stringify(outboxTotal)}  dead=${dead}`);
        console.log(`retries used (trace lines): batch-helper=${retryLines} store-level=${cmeLines} exhausted=${exhausted}`);
        if (dead) fails.push(`${dead} dead outbox rows`);
        if (unavailable) fails.push(`${unavailable} items answered arcade_unavailable`);
        if (fails.length === 0) console.log('\nPASS');
        else { exit = 1; console.error(`\nFAIL: ${fails.length} violation(s):\n  ${fails.slice(0, 25).join('\n  ')}`); }
    } finally {
        H.stopDaemon(d1); H.stopDaemon(d2);
        for (const h of homes) H.rmHome(h);
    }
    process.exit(exit);
}
main().catch((e) => { console.error(e); process.exit(1); });
