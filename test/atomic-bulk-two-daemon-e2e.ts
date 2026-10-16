#!/usr/bin/env tsx
/**
 * test/atomic-bulk-two-daemon-e2e.ts - 3.35.0 S2 acceptance (plan 6.2): an `atomic:true` bulk is all-or-nothing ACROSS DAEMONS.
 *
 * Two real daemons (separate LORE_HOME, ports 48481/48482 by default) on ONE ArcadeDB database, one tenant/app. Every iteration
 * posts a 50-item atomic batch on daemon 1 while daemon 2 writes to one of the 50 (item k, random). The oracle reads ArcadeDB
 * DIRECTLY (not through Lore): all 50 share one commit (one updatedAt stamp, revision = prior + 1) or none changed.
 *   P  rival = plain upsert of item k. Allowed: batch lands and rival lands after (k at prior+2, rival's label) or before
 *      (k at prior+2, batch's label); batch 503 = nothing changed. Never some-of-50.
 *   C  rival = upsert of item k with ifRevision = prior. Alternates two modes:
 *        plain  - batch items are plain: rival 409 (batch first) or rival lands and the batch re-stamps and lands over it.
 *        cond   - batch item k carries ifRevision = prior: exactly one side lands; a batch loss is 409 revision_mismatch with
 *                 failedIndex k and NONE of the 50 written.
 *   A  abort: a batch that cannot land (ifAbsent on an existing id; or ifRevision race) leaves ZERO outbox rows (both daemons),
 *      ZERO history rows and ZERO vectors for its 50 ids, immediately and again after the outbox drains. A final batch that does
 *      land is the positive control: its rows replay (outbox drains) and revision 1 / one stamp hold.
 *
 * Run: LORE_ARCADE_E2E_URL=... LORE_ARCADE_E2E_ROOT_PASSWORD_FILE=... NODE_BATCH_PORTS=48481,48482 npx tsx test/atomic-bulk-two-daemon-e2e.ts
 * Env: ATOMIC_ITERATIONS (default 50), ATOMIC_VARIANTS (default P,C,A), ATOMIC_CUSTOMER (default atom), ATOMIC_ITEMS (default 50).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import * as H from './node-batch-arcade-harness.js';

const ITER = Number(process.env['ATOMIC_ITERATIONS'] ?? 50);
const N = Number(process.env['ATOMIC_ITEMS'] ?? 50);
const VARIANTS = (process.env['ATOMIC_VARIANTS'] ?? 'P,C,A').split(',');
const CUSTOMER = process.env['ATOMIC_CUSTOMER'] ?? 'atom';
const APP = 'app1';
const DB = `tenant_${CUSTOMER}_${APP}`;
/** Unique per run: the database persists between runs, so ids must not collide with an earlier run's. */
const RUN = Date.now().toString(36);
const rand = (lo: number, hi: number): number => lo + Math.floor(Math.random() * (hi - lo + 1));

const findFile = (dir: string, name: string): string | null => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isFile() && e.name === name) return p;
        if (e.isDirectory()) { const f = findFile(p, name); if (f) return f; }
    }
    return null;
};
/** Outbox rows on a daemon whose payload names an id starting with `prefix` (the `-exist` seed item is not part of an aborted batch). */
function outboxRows(home: string, prefix: string): Array<{ status: string; operationKind: string }> {
    const f = findFile(home, 'outbox.sqlite');
    if (!f) return [];
    const db = new Database(f, { readonly: true });
    try { return db.prepare('SELECT status, operationKind FROM outbox_entries WHERE payload LIKE ? AND payload NOT LIKE ?').all(`%"id":"${prefix}%`, '%-exist"%') as never; }
    finally { db.close(); }
}
const undrained = (rows: Array<{ status: string }>): number => rows.filter((r) => ['pending', 'pending_commit', 'in_progress', 'claimed'].includes(r.status)).length;

async function main(): Promise<void> {
    const homes = [H.mkHome('atomic-a'), H.mkHome('atomic-b')];
    let d1: H.Daemon | null = null;
    let d2: H.Daemon | null = null;
    let exit = 0;
    const fails: string[] = [];
    try {
        d1 = await H.startDaemon(H.PORTS[0], homes[0]!);
        const tok = await H.provisionAndIssue(d1, CUSTOMER, APP);
        d2 = await H.startSecondDaemon(d1, H.PORTS[1], homes[1]!);
        const ds = [d1, d2];
        console.log(`daemons up: ${H.PORTS.join(', ')}  tree=${H.TREE}  iterations=${ITER}  items=${N}  variants=${VARIANTS.join(',')}`);

        const node = (id: string, label: string, extra: Record<string, unknown> = {}) => ({ id, type: 'decision', label, content: `c-${label}`, ...extra });
        const bulk = (d: H.Daemon, nodes: unknown[], extra: Record<string, unknown> = {}) =>
            H.call(d.port, 'POST', '/api/nodes/bulk', { token: tok, body: { workspace: APP, embed: 'skip', nodes, ...extra } });
        const single = (d: H.Daemon, body: Record<string, unknown>) => H.call(d.port, 'POST', '/api/node', { token: tok, body: { workspace: APP, ...body } });
        const ids = (tag: string): string[] => Array.from({ length: N }, (_, j) => `${tag}-${j}`);
        const read = async (list: string[]) => {
            const rows = await H.arcadeSql(DB, `SELECT id, label, revision, updatedAt FROM LoreNode WHERE id IN [${list.map((x) => `'${x}'`).join(',')}]`);
            return new Map(rows.map((r) => [String(r['id']), { label: String(r['label']), revision: Number(r['revision']), updatedAt: String(r['updatedAt']) }]));
        };
        const seed = async (tag: string, times: number): Promise<number> => {
            for (let t = 0; t < times; t++) {
                const r = await bulk(d1!, ids(tag).map((id) => node(id, 'seed')), { atomic: false });
                if (r.status !== 200 || r.json['ok'] !== true) throw new Error(`seed failed ${r.status}: ${r.raw.slice(0, 200)}`);
            }
            return times;
        };
        const timed = async <T>(delay: number, fn: () => Promise<T>): Promise<T> => { await H.sleep(delay); return fn(); };

        for (const d of ds) await single(d, { id: `warm-${d.port}`, type: 'decision', label: 'w', content: 'w' }); // warm pools

        for (const variant of VARIANTS) {
            const t0 = Date.now();
            const tally: Record<string, number> = {};
            const bump = (k: string): void => { tally[k] = (tally[k] ?? 0) + 1; };
            const traceBefore = ds.map((d) => d.log.text.length);

            if (variant === 'P' || variant === 'C') {
                for (let i = 0; i < ITER; i++) {
                    const tag = `${RUN}${variant}-${i}`;
                    const list = ids(tag);
                    const mode = variant === 'C' ? (i % 2 === 0 ? 'plain' : 'cond') : 'p';
                    await seed(tag, 1 + (i % 2));
                    const before = await read(list);
                    const r0 = before.get(list[0]!)!.revision;
                                        const k = rand(0, N - 1);
                    const batchNodes = list.map((id, j) => node(id, `batch-${tag}`, mode === 'cond' && j === k ? { ifRevision: r0 } : {}));
                    const rivalBody = variant === 'P'
                        ? node(list[k]!, `rival-${tag}`)
                        : node(list[k]!, `rival-${tag}`, { ifRevision: r0 });
                    const [rb, rr] = await Promise.all([
                        bulk(d1!, batchNodes, { atomic: true }),
                        timed(rand(0, 120), () => single(d2!, rivalBody)),
                    ]);
                    const after = await read(list);
                    const T = `${tag} mode=${mode} k=${k} r0=${r0} batch=${rb.status}${rb.json['code'] ? ':' + String(rb.json['code']) : ''} rival=${rr.status}`;
                    const rivalLanded = rr.status === 200 || rr.status === 201;
                    bump(`batch ${rb.status}${rb.json['code'] ? ':' + String(rb.json['code']) : ''}`); bump(`rival ${rr.status}`);
                    const others = list.filter((_, j) => j !== k);
                    const allSame = (pred: (v: { label: string; revision: number; updatedAt: string }) => boolean, set: string[]): boolean => set.every((id) => { const v = after.get(id); return !!v && pred(v); });
                    if (after.size !== N) { fails.push(`${T}: ${N - after.size} item(s) vanished`); continue; }
                    if (rb.status === 200) {
                        if (rb.json['ok'] !== true || rb.json['atomic'] !== true) fails.push(`${T}: 200 without ok/atomic`);
                        if (!allSame((v) => v.label === `batch-${tag}` && v.revision === r0 + 1, others)) fails.push(`${T}: batch landed but the other items are not all batch-label/revision ${r0 + 1}`);
                        if (new Set(others.map((id) => after.get(id)!.updatedAt)).size !== 1) fails.push(`${T}: items do not share one commit stamp`);
                        const kk = after.get(list[k]!)!;
                        if (rivalLanded) { if (kk.revision !== r0 + 2) fails.push(`${T}: rival landed but k is at revision ${kk.revision}, expected ${r0 + 2}`); }
                        else if (kk.revision !== r0 + 1 || kk.label !== `batch-${tag}`) fails.push(`${T}: rival did not land but k is ${kk.label}@${kk.revision}`);
                        if (variant === 'C' && mode === 'cond' && rivalLanded) fails.push(`${T}: BOTH the ifRevision batch and the ifRevision rival landed`);
                        const resRev = new Map((rb.json['results'] as Array<Record<string, unknown>>).map((x) => [String(x['id']), Number(x['revision'])]));
                        for (const id of others) if (resRev.get(id) !== r0 + 1) { fails.push(`${T}: response revision for ${id} is ${resRev.get(id)}`); break; }
                    } else {
                        // Nothing of the batch may be visible: every other item is exactly as seeded.
                        if (!allSame((v) => v.label === 'seed' && v.revision === r0, others) || others.some((id) => after.get(id)!.updatedAt !== before.get(id)!.updatedAt)) fails.push(`${T}: batch refused but some of the 50 changed`);
                        if (rb.status === 409) {
                            if (!(variant === 'C' && mode === 'cond' && rb.json['code'] === 'revision_mismatch' && rb.json['failedIndex'] === k)) fails.push(`${T}: unexpected 409 ${rb.raw.slice(0, 160)}`);
                            if (!rivalLanded) fails.push(`${T}: batch lost (409) but the rival did not land`);
                        } else if (rb.status !== 503) fails.push(`${T}: unexpected batch status ${rb.raw.slice(0, 160)}`);
                    }
                    if (variant === 'C' && mode === 'plain' && !rivalLanded && rr.status !== 409 && rr.status !== 503) fails.push(`${T}: rival neither landed nor 409`);
                    if (variant === 'P' && !rivalLanded && rr.status !== 503) fails.push(`${T}: plain rival refused ${rr.status}`);
                }
            } else if (variant === 'A') {
                const aborted: string[] = [];
                for (let i = 0; i < ITER; i++) {
                    const tag = `${RUN}A-${i}`;
                    const fresh = ids(tag).slice(0, N - 1);
                    const exist = `${tag}-exist`;
                    const sr = await bulk(d1!, [node(exist, 'seed')], { atomic: false });
                    if (sr.status !== 200) throw new Error(`seed ${sr.status}`);
                    const mode = i % 2 === 0 ? 'ifAbsent' : 'ifRevision-race';
                    const lastItem = mode === 'ifAbsent' ? node(exist, 'late', { ifAbsent: true }) : node(exist, 'late', { ifRevision: 1 });
                    const body = [...fresh.map((id) => node(id, `abort-${tag}`)), lastItem];
                    const [rb, rr] = await Promise.all([
                        H.call(d1!.port, 'POST', '/api/nodes/bulk', { token: tok, body: { workspace: APP, atomic: true, nodes: body } }), // default (queued) embed
                        mode === 'ifAbsent' ? Promise.resolve(null) : timed(rand(0, 60), () => single(d2!, node(exist, 'rival', {}))),
                    ]);
                    bump(`${mode} batch ${rb.status}${rb.json['code'] ? ':' + String(rb.json['code']) : ''}`);
                    const T = `${tag} ${mode} batch=${rb.status} rival=${rr?.status ?? '-'}`;
                    const present = await read(fresh);
                    if (rb.status === 200) {
                        if (mode === 'ifAbsent') fails.push(`${T}: an ifAbsent on an existing id landed`);
                        if (present.size !== fresh.length) fails.push(`${T}: batch landed but ${fresh.length - present.size} items missing`);
                        continue;
                    }
                    aborted.push(tag);
                    if (present.size !== 0) fails.push(`${T}: aborted but ${present.size} of the fresh items exist`);
                    if (mode === 'ifAbsent' && !(rb.status === 409 && rb.json['code'] === 'already_exists' && rb.json['failedIndex'] === N - 1)) fails.push(`${T}: expected 409 already_exists at ${N - 1}: ${rb.raw.slice(0, 160)}`);
                    if (mode !== 'ifAbsent' && !(rb.status === 409 && rb.json['code'] === 'revision_mismatch')) fails.push(`${T}: expected 409 revision_mismatch: ${rb.raw.slice(0, 160)}`);
                    for (const d of ds) { const rows = outboxRows(d.home, `${tag}-`); if (rows.length > 0) fails.push(`${T}: ${rows.length} outbox row(s) on :${d.port} right after the abort`); }
                }
                // Drain, then re-check everything that aborted: outbox, history, vectors.
                const deadline = Date.now() + 90_000;
                while (Date.now() < deadline && ds.some((d) => undrained(outboxRows(d.home, `${RUN}A-`)) > 0)) await H.sleep(500);
                const leftover = ds.map((d) => undrained(outboxRows(d.home, `${RUN}A-`)));
                let outboxForAborted = 0, historyForAborted = 0, vectorsForAborted = 0, nodesForAborted = 0;
                for (const tag of aborted) {
                    for (const d of ds) outboxForAborted += outboxRows(d.home, `${tag}-`).length;
                    nodesForAborted += (await read(ids(tag).slice(0, N - 1))).size;
                    const vr = await H.arcadeSql(DB, `SELECT id FROM LoreVerbatim WHERE id LIKE '%${tag}-%' AND NOT id LIKE '%-exist'`);
                    vectorsForAborted += vr.length;
                    for (const j of [0, Math.floor(N / 2), N - 2]) {
                        const h = await H.call(d1!.port, 'GET', `/api/nodes/${encodeURIComponent(`${tag}-${j}`)}/history?workspace=${APP}`, { token: tok });
                        historyForAborted += Number(h.json['count'] ?? 0);
                    }
                }
                console.log(`  aborted batches=${aborted.length}: outbox rows=${outboxForAborted} nodes=${nodesForAborted} vectors=${vectorsForAborted} history rows=${historyForAborted} (history sampled at 3 ids per batch)  other-outbox-leftover=${leftover.join('/')}`);
                if (outboxForAborted + nodesForAborted + vectorsForAborted + historyForAborted !== 0) fails.push(`A: aborted batches left residue (outbox ${outboxForAborted}, nodes ${nodesForAborted}, vectors ${vectorsForAborted}, history ${historyForAborted})`);
                // Positive control: a batch that DOES land replays and drains.
                const ok = ids(`${RUN}A-ok`);
                const okr = await bulk(d1!, ok.map((id) => node(id, 'ok')), { atomic: true });
                const okRows = await read(ok);
                const okOne = new Set([...okRows.values()].map((v) => v.updatedAt)).size === 1 && [...okRows.values()].every((v) => v.revision === 1);
                const t1 = Date.now() + 90_000;
                while (Date.now() < t1 && undrained(outboxRows(d1!.home, `${RUN}A-ok-`)) > 0) await H.sleep(500);
                const okOutbox = outboxRows(d1!.home, `${RUN}A-ok-`);
                console.log(`  positive control: status=${okr.status} nodes=${okRows.size} one-stamp-revision-1=${okOne} outbox rows=${okOutbox.length} undrained=${undrained(okOutbox)}`);
                if (okr.status !== 200 || okRows.size !== N || !okOne || okOutbox.length !== N || undrained(okOutbox) !== 0) fails.push('A: positive control batch did not land/replay cleanly');
            }
            const lines = ds.map((d, k) => d.log.text.slice(traceBefore[k]!).split('\n').filter((l) => l.startsWith('[node-batch]'))).flat();
            const arcadeLines = lines.filter((l) => /engine=arcade/.test(l));
            const outcomes: Record<string, number> = {};
            for (const l of arcadeLines) { const o = /outcome=(\S+)/.exec(l)?.[1] ?? '?'; outcomes[o] = (outcomes[o] ?? 0) + 1; }
            const retries = lines.filter((l) => /engine=retry/.test(l) && /contention attempt=/.test(l)).length;
            if (arcadeLines[0]) console.log(`  sample trace: ${arcadeLines[0].slice(0, 220)}`);
            console.log(`\n[${variant}] ${ITER} iterations in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
            console.log(`  responses: ${JSON.stringify(tally)}`);
            console.log(`  engine batches=${arcadeLines.length} by outcome ${JSON.stringify(outcomes)}  contention retries=${retries}  (LORE_NODE_BATCH_TRACE)`);
        }
        if (fails.length === 0) console.log(`\nPASS: zero violations (${VARIANTS.join(', ')} x ${ITER}, ${N} items per batch)`);
        else { exit = 1; console.error(`\nFAIL: ${fails.length} violation(s):\n  ${fails.slice(0, 25).join('\n  ')}`); }
    } finally {
        H.stopDaemon(d1); H.stopDaemon(d2);
        for (const h of homes) H.rmHome(h);
    }
    process.exit(exit);
}
main().catch((e) => { console.error(e); process.exit(1); });
