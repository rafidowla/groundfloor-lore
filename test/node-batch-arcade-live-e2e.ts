#!/usr/bin/env tsx
/**
 * test/node-batch-arcade-live-e2e.ts - 3.35.0 live check of the commitNodeBatch primitive through a REAL daemon
 * against a REAL ArcadeDB (26.7.1), verified by querying ArcadeDB DIRECTLY (not through Lore).
 *
 *   Check 1: a write with a precondition on another node -> that node's `txTouch` incremented, its `revision` and
 *            `updatedAt` unchanged, the written node landed, and the daemon log (LORE_NODE_BATCH_TRACE=1) shows the
 *            primitive ran (`[node-batch] engine=arcade checks=1 writes=1 outcome=ok`).
 *   Check 2: a precondition MISS -> 409, and the direct query shows nothing changed (no new row, touch counter
 *            and revision of the precondition node untouched).
 *   Check 3: the same two through POST /api/nodes/bulk.
 *
 * Run: LORE_ARCADE_E2E_URL=http://127.0.0.1:2624 LORE_ARCADE_E2E_ROOT_PASSWORD_FILE=<file> npx tsx test/node-batch-arcade-live-e2e.ts
 */
import * as H from './node-batch-arcade-harness.js';

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
    if (cond) { pass++; console.log(`  [PASS] ${label}`); }
    else { fail++; console.error(`  [FAIL] ${label}${detail !== undefined ? ` - ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); }
}

const CUSTOMER = 'nblive';
const APP = 'app1';
const DB = `tenant_${CUSTOMER}_${APP}`;
const row = async (id: string): Promise<Record<string, unknown> | undefined> =>
    (await H.arcadeSql(DB, 'SELECT id, revision, txTouch, updatedAt FROM LoreNode WHERE id = :id', { id }))[0];
const traceLines = (d: H.Daemon): string[] => d.log.text.split('\n').filter((l) => l.startsWith('[node-batch]'));

async function main(): Promise<void> {
    const home = H.mkHome('live');
    let d: H.Daemon | null = null;
    try {
        d = await H.startDaemon(H.PORTS[0], home);
        const tok = await H.provisionAndIssue(d, CUSTOMER, APP);
        const post = (body: Record<string, unknown>) => H.call(d!.port, 'POST', '/api/node', { token: tok, body: { type: 'decision', label: 'l', content: 'c', ...body } });
        const bulk = (nodes: Array<Record<string, unknown>>) => H.call(d!.port, 'POST', '/api/nodes/bulk', { token: tok, body: { workspace: APP, nodes: nodes.map((n) => ({ type: 'decision', label: 'l', content: 'c', ...n })) } });

        console.log('\n=== seed ===');
        check('seed X created', (await post({ id: 'X' })).status === 201);
        const x0 = await row('X');
        check('X at revision 1, no touches yet', x0?.['revision'] === 1 && (x0?.['txTouch'] ?? null) === null, x0);

        console.log('\n=== Check 1: precondition write (POST /api/node) ===');
        const before = traceLines(d).length;
        const r1 = await post({ id: 'T1', preconditions: [{ id: 'X', revision: 1 }] });
        check('write with a held precondition is 201', r1.status === 201, r1.raw);
        const x1 = await row('X');
        check('X.txTouch incremented by exactly 1', Number(x1?.['txTouch'] ?? 0) === Number(x0?.['txTouch'] ?? 0) + 1, x1);
        check('X.revision unchanged (still 1)', x1?.['revision'] === 1, x1);
        check('X.updatedAt unchanged', x1?.['updatedAt'] === x0?.['updatedAt'], x1);
        const t1 = await row('T1');
        check('T1 landed at revision 1', t1?.['revision'] === 1, t1);
        await H.sleep(200);
        const lines = traceLines(d).slice(before);
        check('log proves the primitive ran: engine=arcade checks=1 writes=1 outcome=ok', lines.some((l) => /engine=arcade checks=1 writes=1 outcome=ok/.test(l)), lines);

        console.log('\n=== Check 2: precondition miss (POST /api/node) ===');
        const x2 = await row('X');
        const r2 = await post({ id: 'T2', preconditions: [{ id: 'X', revision: 5 }] });
        check('write with a stale precondition is 409', r2.status === 409, `${r2.status} ${r2.raw}`);
        check('response names the failed precondition', JSON.stringify(r2.json).includes('precondition'), r2.raw);
        const x3 = await row('X');
        check('direct query: T2 does not exist', (await row('T2')) === undefined);
        check('direct query: X.revision, X.txTouch and X.updatedAt unchanged', x3?.['revision'] === x2?.['revision'] && (x3?.['txTouch'] ?? null) === (x2?.['txTouch'] ?? null) && x3?.['updatedAt'] === x2?.['updatedAt'], { x2, x3 });
        const r2b = await post({ id: 'T2', preconditions: [{ id: 'GHOST', revision: 3 }] });
        check('precondition on an absent node (revision 3) is 409 and writes nothing', r2b.status === 409 && (await row('T2')) === undefined, `${r2b.status} ${r2b.raw}`);

        console.log('\n=== Check 3: the same through POST /api/nodes/bulk ===');
        const x4 = await row('X');
        const rb = await bulk([{ id: 'B1', preconditions: [{ id: 'X', revision: 1 }] }, { id: 'B2' }]);
        check('bulk: held precondition -> 200, both written', rb.status === 200 && rb.json['succeeded'] === 2, rb.raw);
        const x5 = await row('X');
        check('bulk: X.txTouch incremented by exactly 1 (one precondition, one batch), revision unchanged', Number(x5?.['txTouch'] ?? 0) === Number(x4?.['txTouch'] ?? 0) + 1 && x5?.['revision'] === 1, { x4, x5 });
        const rm = await bulk([{ id: 'B3', preconditions: [{ id: 'X', revision: 9 }] }]);
        const b3 = await row('B3');
        check('bulk: stale precondition -> item fails, B3 not written', b3 === undefined && JSON.stringify(rm.json).includes('precondition'), rm.raw);
        const x6 = await row('X');
        check('bulk: X untouched by the miss', x6?.['txTouch'] === x5?.['txTouch'] && x6?.['revision'] === 1, { x5, x6 });
        const bulkTrace = traceLines(d).filter((l) => /engine=arcade/.test(l));
        // Two batches reached the engine (the single write and the bulk item with a held precondition); the stale
        // ones were judged from a read before any batch was built, so they leave no trace line and no touch.
        check('log shows the bulk batch went through the primitive (2 engine batches in total)', bulkTrace.length === 2, bulkTrace);
        console.log('\n  trace lines seen:\n    ' + traceLines(d).join('\n    '));
    } finally {
        H.stopDaemon(d);
        H.rmHome(home);
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
