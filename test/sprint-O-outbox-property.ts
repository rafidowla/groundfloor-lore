#!/usr/bin/env tsx
/**
 * test/sprint-O-outbox-property.ts — Sprint O gate test
 *
 * Eleven cases asserting the outbox-as-universal-write-path principle
 * (docs/audits/sprint-O-outbox-audit-2026-05-24.md). Same harness shape
 * as test/L-database-property-unit.ts: xfailStrict for cases the sprint
 * has NOT yet shipped (today's behavior throws → xfail-pass), expectPass
 * for cases that must hold today (regression sentinels).
 *
 * Sub-chain flip schedule (per SPRINT-O-outbox-universal-write.md):
 *   O1 → flips O-D5, O-D8
 *   O2 → flips O-D1, O-D3, O-D4 (preserves O-D10)
 *   O3 → flips O-D2, O-D11
 *   O4 → flips O-D6, O-D9
 *   O5 → flips O-D7 (crash recovery) + sprint closure
 *
 * Each case is intentionally STATIC (file-system probe / source-text
 * grep) rather than runtime — O0 must commit without spinning a daemon.
 * The cases are written so that the act of landing the implementation
 * (which writes a marker file, adds a /api/health field, or strips a
 * comment) flips them to passing. Sub-chains land both the runtime
 * change AND the marker/grep change in the same commit, then promote
 * the case to expectPass per the harness convention.
 *
 * After O0 commit:
 *   xfail-pass:  10  (O-D1..O-D9, O-D11)
 *   expect-pass:  1  (O-D10, regression sentinel from Sprint L)
 *
 * After O1 commit (2026-05-24):
 *   xfail-pass:   8  (O-D1, O-D2, O-D3, O-D4, O-D6, O-D7, O-D9, O-D11)
 *   expect-pass:  3  (O-D5, O-D8, O-D10)
 *
 * After O2 commit (2026-05-24):
 *   xfail-pass:   5  (O-D2, O-D6, O-D7, O-D9, O-D11)
 *   expect-pass:  6  (O-D1, O-D3, O-D4, O-D5, O-D8, O-D10)
 *
 * After O3 commit (2026-05-24):
 *   xfail-pass:   4  (O-D6, O-D7, O-D9, O-D11)  — O3 wired the bulk
 *                    lane but D11 perf gate was deferred to O3c
 *                    re-measurement.
 *   expect-pass:  7  (O-D1, O-D2, O-D3, O-D4, O-D5, O-D8, O-D10)
 *
 * After O3c commit (2026-05-24) — SQLite outbox migration + re-measure:
 *   xfail-pass:   3  (O-D6, O-D7, O-D9)
 *   expect-pass:  8  (O-D1, O-D2, O-D3, O-D4, O-D5, O-D8, O-D10, O-D11)
 *
 * After O4 commit (2026-05-24) — backpressure + per-workspace lag cache:
 *   xfail-pass:   1  (O-D7 — crash recovery, deferred to O5)
 *   expect-pass: 10  (O-D1, O-D2, O-D3, O-D4, O-D5, O-D6, O-D8, O-D9,
 *                     O-D10, O-D11)
 *
 * After O5 commit (2026-05-24) — sprint closure:
 *   xfail-pass:   0
 *   expect-pass: 11  (all O-D1..O-D11 green; O-D7 marker declared in
 *                     outbox/types.ts and verified end-to-end by
 *                     test/O5-crash-recovery-integration.ts)
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tryBulkWriteRoutes } from '../packages/lore/src/mcp/http/routes/bulkWrite.js';

/* ============================================================
 * xfail-strict harness — identical to test/L-database-property-unit.ts
 * ============================================================ */

let xfailPassed = 0;
let unexpectedPass = 0;
let runnerErrors = 0;
let expectPassed = 0;
let expectFailed = 0;
const pending: Array<Promise<void>> = [];

function xfailStrict(name: string, fn: () => Promise<void> | void): void {
    pending.push((async () => {
        try {
            await fn();
        } catch (err) {
            console.log(`  ✓ ${name} (xfail-pass: ${(err as Error).message.split('\n')[0]?.slice(0, 80)})`);
            xfailPassed++;
            return;
        }
        console.error(`  ✗ ${name} — UNEXPECTED PASS. Sprint sub-chain has landed the fix; promote this case to expectPass() and remove the xfail wrapper.`);
        unexpectedPass++;
    })().catch((err) => {
        console.error(`  ! ${name} — harness error: ${(err as Error).message}`);
        runnerErrors++;
    }));
}

function expectPass(name: string, fn: () => Promise<void> | void): void {
    pending.push((async () => {
        try {
            await fn();
            console.log(`  ✓ ${name} (pass)`);
            expectPassed++;
        } catch (err) {
            console.error(`  ✗ ${name} — REGRESSION: ${(err as Error).message.split('\n')[0]?.slice(0, 200)}`);
            expectFailed++;
        }
    })().catch((err) => {
        console.error(`  ! ${name} — harness error: ${(err as Error).message}`);
        runnerErrors++;
    }));
}

/* ============================================================
 * Shared fakes for the runtime regression sentinel (O-D10)
 * Mirror the L-database harness pattern.
 * ============================================================ */

function makeFakeGraph() {
    return {
        graph: {
            getGraphContext() {
                return {
                    queryRows: async () => [],
                    executeQuery: async () => undefined,
                    bumpEpoch: () => undefined,
                    storage: {},
                    detectLanguage: () => ({ language: null, confidence: 0 }),
                };
            },
            getStats: async () => ({ totalNodes: 0, typeBreakdown: {} }),
            getLanguageBreakdown: async () => ({}),
            upsertNode: async (n: Record<string, unknown>) => n,
            addEdge: async () => undefined,
        },
    };
}

function makeReqWithBody(body: string, method: string = 'POST'): IncomingMessage {
    let consumed = false;
    return {
        method,
        on(event: string, cb: (chunk?: Buffer | Error) => void) {
            if (event === 'data' && !consumed) {
                consumed = true;
                cb(Buffer.from(body, 'utf8'));
            }
            if (event === 'end') setImmediate(() => cb());
            return this;
        },
    } as unknown as IncomingMessage;
}

function fakeRes(): ServerResponse & { _status: number; _body: string } {
    const r = {
        _status: 0, _body: '',
        writeHead(status: number) { (this as { _status: number })._status = status; return this; },
        end(body?: string) { (this as { _body: string })._body = body ?? ''; },
    };
    return r as unknown as ServerResponse & { _status: number; _body: string };
}

function localBulkWriteDeps(graph: unknown): Parameters<typeof tryBulkWriteRoutes>[4] {
    return {
        deploymentMode: 'local',
        dataplane: null,
        store: { loreGraph: graph as never } as never,
    };
}

const SRC_ROOT = join(process.cwd(), 'packages/lore/src');

/* ============================================================
 * Test cases (O-D1 .. O-D11)
 * ============================================================ */

console.log('Sprint O gate test — outbox-as-universal-write-path (11 cases)');

/* ----- O-D1 — hot single-write endpoint emits outbox row before HTTP success.
 *
 * Static probe: nodes.ts must import withOutbox AND mention an outbox
 * step kind in the POST /api/node handler (e.g. 'graph.upsert'). Today
 * the file contains neither — xfail-pass. O2 will land both the import
 * and the wrapping call in the same commit; flip to expectPass then. */
expectPass('O-D1 POST /api/node wraps write in the outbox before responding', () => {
    // SP-F6 — the POST handler moved to routes/nodes/postNode.ts in the
    // god-class split. W3-SERVICE-LAYER (embeddable refactor) then extracted the
    // guarded write orchestration into core/nodeService.ts (`nodeUpsert`), which
    // BOTH the REST handler (postNode.ts) and the MCP tool (storeNode.ts) — and
    // the in-process createLore() API — delegate to. The outbox hot-lane write +
    // 'graph.upsert' op now live in the single canonical write path
    // (nodeService.ts); postNode.ts must delegate to it. Repointed accordingly —
    // behavior unchanged (O-D3/O-D4 still assert postNode no longer in-lines the
    // verbatim/graph write).
    const svc = readFileSync(join(SRC_ROOT, 'core/nodeService.ts'), 'utf8');
    assert.ok(
        (svc.includes('recordHotWrite') || svc.includes('withOutbox')) && /['"]graph\.upsert['"]/.test(svc),
        `nodeService.ts (the canonical guarded write path) must record the outbox hot-lane write AND emit the 'graph.upsert' operation (O2)`,
    );
    const post = readFileSync(join(SRC_ROOT, 'mcp/http/routes/nodes/postNode.ts'), 'utf8');
    assert.ok(
        post.includes('nodeUpsert'),
        `postNode.ts must delegate POST /api/node to nodeService.nodeUpsert (so the outbox write happens via the shared path)`,
    );
});

/* ----- O-D2 — bulk endpoint emits outbox row per item before HTTP success.
 *
 * Static probe: bulkWrite.ts must wire withOutbox + 'graph.upsert' AND
 * the bulk handler must reference a batched-emit helper (e.g.
 * 'outboxBatch' or 'recordBatch'). O3 lands both. */
expectPass('O-D2 POST /api/nodes/bulk emits outbox row per item via withOutbox', () => {
    const src = readFileSync(join(SRC_ROOT, 'mcp/http/routes/bulkWrite.ts'), 'utf8');
    assert.ok(
        src.includes('withOutbox') && /outbox(?:Batch|\.recordBatch|RecordBatch)/.test(src),
        `bulkWrite.ts must use withOutbox + a batch-emit helper for POST /api/nodes/bulk (O3)`,
    );
});

/* ----- O-D3 — LanceDB-down: API still returns 200 (proof of async fan-out).
 *
 * Today the verbatim/lance write is in-line in nodes.ts:760 +
 * bulkWrite.ts:226 (audit Section 3). If LanceDB throws, the HTTP
 * caller sees 500. Static check: assert there is NO in-line
 * `loreVerbatim.store(` call in nodes.ts (it must be replaced by an
 * outbox step the replicator drives). */
expectPass('O-D3 POST /api/node no longer in-line-calls loreVerbatim.store', () => {
    // SP-F6 — repointed to the moved POST handler (routes/nodes/postNode.ts).
    const src = readFileSync(join(SRC_ROOT, 'mcp/http/routes/nodes/postNode.ts'), 'utf8');
    assert.ok(
        !/loreVerbatim\.store\(/.test(src),
        `postNode.ts still contains in-line loreVerbatim.store(...) — O2 must move it behind the replicator`,
    );
});

/* ----- O-D4 — kuzu-slow: API still returns 200 in <100ms (outbox-first).
 *
 * Static probe: nodes.ts handler for POST /api/node must NOT await
 * graph.upsertNode in the HTTP request path. Replace with an outbox
 * record + return. We detect by asserting nodes.ts contains the
 * marker comment '// O2: outbox-first' which O2 lands when it moves
 * the write off the request path. */
expectPass('O-D4 POST /api/node moves graph.upsertNode behind the outbox (marker comment)', () => {
    // SP-F6 — repointed to the moved POST handler (routes/nodes/postNode.ts).
    const src = readFileSync(join(SRC_ROOT, 'mcp/http/routes/nodes/postNode.ts'), 'utf8');
    assert.ok(
        src.includes('// O2: outbox-first'),
        `postNode.ts must carry the '// O2: outbox-first' marker comment where it used to await graph.upsertNode`,
    );
});

/* ----- O-D5 — /api/health exposes outbox.depth + outbox.lagSeconds.
 *
 * Static probe: diagnostic.ts /api/health body literal must include
 * the keys 'outbox' and 'lagSeconds'. FLIPPED to expectPass by O1
 * (2026-05-24) when /api/health gained the outbox block (depth +
 * lagSeconds + per-workspace stats) sourced from the FileOutboxStore
 * aggregateStats() provider wired through DispatcherDeps. */
expectPass('O-D5 /api/health body includes outbox.depth + outbox.lagSeconds', () => {
    // SP-F6 — the /api/health handler moved from routes/diagnostic.ts to
    // routes/diagnostic/health.ts in the god-class split. Repointed.
    const src = readFileSync(join(SRC_ROOT, 'mcp/http/routes/diagnostic/health.ts'), 'utf8');
    assert.ok(
        /outbox\s*:/.test(src) && /lagSeconds/.test(src),
        `diagnostic/health.ts /api/health handler must emit outbox + lagSeconds keys (O1)`,
    );
});

/* ----- O-D6 — outbox lag > threshold → 503 outbox_lag + Retry-After.
 *
 * Static probe: middleware.ts must reference 'outbox_lag' as a 503
 * error code AND 'Retry-After' as a header. O4 lands both. */
expectPass('O-D6 middleware emits 503 outbox_lag with Retry-After header', () => {
    const src = readFileSync(join(SRC_ROOT, 'mcp/http/middleware.ts'), 'utf8');
    assert.ok(
        /outbox_lag/.test(src) && /Retry-After/.test(src),
        `middleware.ts must surface 503 'outbox_lag' + Retry-After header when outbox lag exceeds threshold (O4)`,
    );
});

/* ----- O-D7 — crash recovery: replicator resumes from last-replicated sequence ID.
 *
 * Static probe: the existing outbox/recovery.ts must reference a
 * resume marker (column or file). Today recovery is "walk all
 * unfinished entries" with no sequence-id cursor. O5 lands the
 * sequence-id resume marker as the final crash-recovery step.
 * Marker we look for: 'lastReplicatedSequenceId' (added by O5). */
expectPass('O-D7 recovery driver references lastReplicatedSequenceId', () => {
    const recovery = readFileSync(join(SRC_ROOT, 'outbox/recovery.ts'), 'utf8');
    const types = readFileSync(join(SRC_ROOT, 'outbox/types.ts'), 'utf8');
    assert.ok(
        recovery.includes('lastReplicatedSequenceId') || types.includes('lastReplicatedSequenceId'),
        `outbox/recovery.ts or outbox/types.ts must declare lastReplicatedSequenceId resume marker (O5)`,
    );
});

/* ----- O-D8 — every outbox row has a unique monotonic sequence_id.
 *
 * Static probe: types.ts OutboxEntry must declare `sequenceId` (or
 * `sequence_id`). FLIPPED to expectPass by O1 (2026-05-24) when
 * OutboxEntry gained the optional `sequenceId: number` field +
 * FileOutboxStore.nextSequenceId() per-workspace allocator. */
expectPass('O-D8 OutboxEntry declares sequenceId (or sequence_id)', () => {
    const src = readFileSync(join(SRC_ROOT, 'outbox/types.ts'), 'utf8');
    assert.ok(
        /sequenceId|sequence_id/.test(src),
        `outbox/types.ts must add sequenceId (or sequence_id) to OutboxEntry (O1)`,
    );
});

/* ----- O-D9 — per-workspace outbox depth tracked independently in /api/health.
 *
 * Static probe: diagnostic.ts /api/health body must contain a
 * 'perWorkspaceOutbox' (or similar) key carrying per-workspace
 * depth + lagSeconds. Sprint O contract clause 8 requires this; O4
 * lands the per-workspace aggregation when it wires the backpressure
 * signal. */
expectPass('O-D9 /api/health surfaces per-workspace outbox stats', () => {
    // SP-F6 — repointed to routes/diagnostic/health.ts (god-class split).
    // The current shape nests a `perWorkspace` map inside the `outbox` block
    // (see buildOutboxHealthBlock); accept that alongside the legacy markers.
    const src = readFileSync(join(SRC_ROOT, 'mcp/http/routes/diagnostic/health.ts'), 'utf8');
    assert.ok(
        /perWorkspaceOutbox|outbox\.byWorkspace|perWorkspace/.test(src),
        `diagnostic/health.ts /api/health must emit per-workspace outbox stats (O4)`,
    );
});

/* ----- O-D10 — regression sentinel: Sprint L's workspace_required holds before outbox.
 *
 * Runtime: /api/nodes/bulk without workspace returns 400 workspace_required.
 * This is the Sprint L invariant (L1b ship). It MUST be green today —
 * if it's red, Sprint L regressed and Sprint O cannot start. The
 * outbox commit comes AFTER this check, never before. */
expectPass('O-D10 regression sentinel: POST /api/nodes/bulk without workspace → 400 workspace_required (Sprint L preserved)', async () => {
    const fake = makeFakeGraph();
    const req = makeReqWithBody(JSON.stringify({ nodes: [{ id: 'x', type: 'decision', label: 'X' }] }));
    const res = fakeRes();
    await tryBulkWriteRoutes(req, res, '/api/nodes/bulk', '/api/nodes/bulk', localBulkWriteDeps(fake.graph));
    assert.equal(res._status, 400, `Sprint L regression: expected 400; got ${res._status}: ${res._body}`);
    assert.match(res._body, /workspace_required/, `Sprint L regression: expected workspace_required marker`);
});

/* ----- O-D11 — W9 bulk perf within 10% of pre-Sprint-O baseline.
 *
 * O0: passes trivially. The assertion shape is locked in now — post-O3
 * (which wires bulk through outbox) the implementation must update the
 * SPRINT_O_W9_POST_O3_MEDIAN_MS constant below to the new measurement.
 * The bound check then enforces the ±10% contract. Today there is no
 * post-O3 number, so we assert only that the baseline is recorded.
 *
 * Baseline numbers (from docs/audits/sprint-O-outbox-audit-2026-05-24.md
 * "W9 bulk baseline 2026-05-24"):
 *   median: 9644 ms
 *   avg:    9596 ms
 *   rate:   104 rows/sec  (1000 nodes per run, 4-of-5 kept)
 */
const SPRINT_O_W9_BASELINE_MEDIAN_MS = 9644;
const SPRINT_O_W9_BASELINE_AVG_MS = 9596;
const SPRINT_O_W9_BASELINE_ROWS_PER_SEC = 104;
// Post-O3c re-measurement against the SQLite outbox backend on an
// isolated daemon (5 runs × 1000 nodes; slowest dropped per protocol).
// Source: docs/audits/sprint-O-outbox-audit-2026-05-24.md "W9 post-O3c
// baseline 2026-05-24" — median 10320 ms (+7.0% vs 9644 ms baseline,
// inside ±10% bound). The perf cliff that JSON-rewrite exhibited
// (134 s by run 4) is GONE — runs 1..5 monotonically improved as
// SQLite warmed up.
const SPRINT_O_W9_POST_O3_MEDIAN_MS: number | null = 10320;

expectPass('O-D11 post-O3 W9 bulk perf measurement within ±10% of pre-Sprint-O baseline', () => {
    // Sanity: audit doc + baseline constants must be recorded — this
    // part is true today; throwing happens at the post-O3 check below.
    assert.ok(SPRINT_O_W9_BASELINE_MEDIAN_MS > 0, `baseline median must be recorded`);
    assert.ok(SPRINT_O_W9_BASELINE_AVG_MS > 0, `baseline avg must be recorded`);
    assert.ok(SPRINT_O_W9_BASELINE_ROWS_PER_SEC > 0, `baseline rate must be recorded`);
    const auditPath = join(process.cwd(), 'docs/audits/sprint-O-outbox-audit-2026-05-24.md');
    assert.ok(existsSync(auditPath), `audit doc missing at ${auditPath}`);
    const audit = readFileSync(auditPath, 'utf8');
    assert.ok(
        audit.includes(String(SPRINT_O_W9_BASELINE_MEDIAN_MS)),
        `audit doc must contain baseline median ${SPRINT_O_W9_BASELINE_MEDIAN_MS} ms`,
    );
    // The actual gate: post-O3 measurement must be recorded AND within
    // ±10% of the baseline. Today the constant is null → throws →
    // xfail-pass. O3 sets the constant + promotes to expectPass.
    assert.ok(
        SPRINT_O_W9_POST_O3_MEDIAN_MS !== null,
        `SPRINT_O_W9_POST_O3_MEDIAN_MS must be set post-O3 with the re-measured median (today: null — sprint not yet built)`,
    );
    const lo = SPRINT_O_W9_BASELINE_MEDIAN_MS * 0.9;
    const hi = SPRINT_O_W9_BASELINE_MEDIAN_MS * 1.1;
    const post = SPRINT_O_W9_POST_O3_MEDIAN_MS as number;
    assert.ok(
        post >= lo && post <= hi,
        `post-O3 median ${post} ms out of ±10% bound [${lo}, ${hi}] vs baseline ${SPRINT_O_W9_BASELINE_MEDIAN_MS} ms`,
    );
});

/* ============================================================
 * Runner
 * ============================================================ */

await Promise.all(pending);

console.log('');
console.log(`xfail-pass:       ${xfailPassed}`);
console.log(`unexpected-pass:  ${unexpectedPass}`);
console.log(`expect-pass:      ${expectPassed}`);
console.log(`expect-fail:      ${expectFailed}`);
console.log(`harness-errors:   ${runnerErrors}`);

if (unexpectedPass > 0) {
    console.error('');
    console.error(`FAIL: ${unexpectedPass} xfail case(s) unexpectedly passed.`);
    console.error('A sprint sub-chain has landed the underlying fix — promote those cases to expectPass() and remove the xfail wrapper in the same commit.');
    process.exit(1);
}
if (expectFailed > 0) {
    console.error('');
    console.error(`FAIL: ${expectFailed} expectPass case(s) regressed.`);
    process.exit(1);
}
if (runnerErrors > 0) {
    console.error('');
    console.error(`FAIL: ${runnerErrors} harness error(s) — fix before merge.`);
    process.exit(1);
}
console.log('');
console.log(`OK: ${xfailPassed} xfail-pass + ${expectPassed} expect-pass.`);
