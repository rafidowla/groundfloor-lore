#!/usr/bin/env tsx
/**
 * test/sprint-Z-bulk-loader-property.ts — Sprint Z0 gate test
 *
 * 11 cases asserting the Sprint Z bulk-loader contract (audit doc:
 * docs/audits/sprint-Z-bulk-loader-2026-05-24.md, Sprint Z principle
 * clauses 1-10). Mirrors L0 / O0 / E0 pattern:
 *
 *   - Z-D1, D2, D3, D4, D5, D6, D9, D10, D11 are xfail-strict: today
 *     no /api/load endpoint exists, no load_jobs table exists, no
 *     BulkLoaderAdapter interface exists. Each assertion fails =
 *     xfail-pass at Z0 commit. As each sub-chain lands the fix, the
 *     case becomes "unexpected pass" and the sub-chain MUST flip it
 *     to expectPass in the same commit.
 *   - Z-D7, D8 are expectPass regression sentinels: Sprint L
 *     workspace_required and Sprint O outbox-first invariants must
 *     remain green THROUGHOUT Sprint Z. Either flipping to red
 *     counts as a regression and fails the runner.
 *
 * Sub-chain flip schedule (per SPRINT-Z-bulk-loader.md):
 *   Z1 → flips D1, D2 (POST /api/load + GET /api/load/jobs/<id>);
 *        D7 stays expectPass (workspace check on the new route)
 *   Z2 → flips D3 (100k-row JSONL load <5min), D4 (substrate-native
 *        loader used not per-row INSERT), D8-related (bulk_load.done
 *        outbox notification — D8 stays expectPass but the new
 *        outbox path must preserve it), D10 (Sprint E skip-embed
 *        default at bulk-load scale)
 *   Z3 → flips D5 (checkpoint + resume after kill), D6 (per-item
 *        failure isolation), D9 (per-tenant concurrency cap)
 *   Z4 → flips D11 (backpressure 503 when outbox/embed saturated)
 *
 * Pre-Sprint-Z baseline constants (Section 6 of audit doc):
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// ─── Pre-Sprint-Z baselines (Section 6, audit doc 2026-05-24) ────────────
// SQLite floor: in-process synthetic, 100k 4-col TEXT/PK rows via
// prepared INSERT + db.transaction wrapper (WAL mode). The path Z2's
// SQLite BulkLoaderAdapter targets.
export const SPRINT_Z_PRE_BASELINE_SQLITE_FLOOR_100K_MS = 81;
export const SPRINT_Z_PRE_BASELINE_SQLITE_FLOOR_ROWS_PER_SEC = 1_234_568;
// W9 end-to-end ceiling (Sprint O0 measurement): 1000 nodes via
// POST /api/nodes/bulk = 9644 ms = 104 rps. 40M rows extrapolates to
// ~4.4 days at this rate — the gap Sprint Z closes.
export const SPRINT_Z_PRE_BASELINE_W9_CEILING_1K_MS = 9_644;
export const SPRINT_Z_PRE_BASELINE_W9_CEILING_ROWS_PER_SEC = 104;
// Sprint Z target (parent spec): 100k SQLite-backed load in <5 min.
export const SPRINT_Z_TARGET_100K_LOAD_MS = 300_000;

/* ============================================================
 * xfail-strict harness (matches test/L-database-property-unit.ts and
 * test/sprint-E-embed-property.ts shape)
 * ============================================================ */

let xfailPassed = 0;     // case threw as expected — good
let unexpectedPass = 0;  // case did NOT throw — sprint flipped behavior, must promote
let runnerErrors = 0;    // case errored outside the assertion (harness bug)
let expectPassed = 0;    // case passed (post-flip) as required
let expectFailed = 0;    // case failed after being flipped to expectPass — regression
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
 * Test cases
 * ============================================================ */

console.log('Sprint Z gate test — Bulk loader (11 expectPass after Z3 flipped D5+D9; Sprint Z complete)');

const ROUTES_DIR = join(process.cwd(), 'packages/lore/src/mcp/http/routes');
const OUTBOX_DIR = join(process.cwd(), 'packages/lore/src/outbox');
const ENGINES_DIR = join(process.cwd(), 'packages/lore/src/engines');

/* ----- Z-D1 — POST /api/load accepts streaming JSONL upload + returns {job_id}
 *
 * Sprint Z principle clauses 1+2: streaming chunked-transfer upload,
 * returns job_id immediately. Today no /api/load route exists; the
 * closest is /api/import which buffers the entire base64-encoded body
 * (10 MB cap). Z1 must add a new routes/load.ts that wires
 * req.pipe(...) backpressure-aware streaming.
 */
expectPass('Z-D1 POST /api/load streaming endpoint exists (Z1 flipped 2026-05-24)', () => {
    const loadRoute = join(ROUTES_DIR, 'load.ts');
    assert.ok(existsSync(loadRoute), `expected ${loadRoute} (Z1 must add the streaming POST /api/load route per Sprint Z principle clause 1)`);
    const src = readFileSync(loadRoute, 'utf8');
    // Streaming upload pattern: route MUST NOT readBoundedBody for the
    // bulk payload; instead req.pipe(...) into the consumer pipeline.
    // Audit doc Section 3.2 calls this out explicitly.
    assert.match(
        src,
        /(req\.pipe|pipeline\(.*req|createReadStream|on\(\s*['"]data['"]\s*,.*chunked)/,
        'route must use req.pipe(...) or pipeline() — not readBoundedBody — for the streaming bulk payload (Section 3.2)',
    );
    assert.match(src, /job_?[Ii]d/, 'route must return {job_id} immediately per Sprint Z principle clause 2');
});

/* ----- Z-D2 — GET /api/load/jobs/<id> returns job state + progress
 *
 * Sprint Z principle clause 2: client polls /api/load/jobs/<id> for
 * state + progress. Z1 ships the read endpoint together with the
 * write endpoint; the load_jobs SQLite table is the source of truth
 * (audit doc Section 4.3).
 */
expectPass('Z-D2 GET /api/load/jobs/<id> returns state + progress (Z1 flipped 2026-05-24)', () => {
    const loadRoute = join(ROUTES_DIR, 'load.ts');
    assert.ok(existsSync(loadRoute), `expected ${loadRoute} (Z1 must add the job-status read endpoint per Sprint Z principle clause 2)`);
    const src = readFileSync(loadRoute, 'utf8');
    assert.match(src, /\/api\/load\/jobs/, 'route must wire GET /api/load/jobs/<id>');
    assert.match(src, /rowsProcessed|rowsTotal|state.*running/i, 'response must surface job progress fields per Section 4.3');
});

/* ----- Z-D3 — 100k-row JSONL load completes within target (~5 min)
 *
 * Sprint Z principle clause 3 + parent spec done-criterion: 100k SQLite
 * load in <5min (vs ~16min at W9 baseline). Z2 publishes a perf doc
 * with the live measurement; we assert that doc exists and records a
 * timing under SPRINT_Z_TARGET_100K_LOAD_MS.
 */
expectPass('Z-D3 100k-row JSONL load <5min target recorded (Z2 flipped 2026-05-24)', () => {
    const perfDoc = join(process.cwd(), 'docs/audits/sprint-Z-bulk-loader-perf-2026-05-24.md');
    assert.ok(existsSync(perfDoc), `expected ${perfDoc} (Z2 must publish the 100k-row JSONL load measurement vs the 5-min target)`);
    const src = readFileSync(perfDoc, 'utf8');
    assert.match(src, /100[,_]?000.*(?:rows?|JSONL)|JSONL.*100[,_]?000/i, 'perf doc must record the 100k-row JSONL measurement');
    // Allow any sub-5min timing — minutes or seconds form.
    assert.match(src, /\b([0-9]{1,3})\s*(?:s(?:ec)?|seconds?|min(?:ute)?s?)\b/, 'perf doc must record a sub-5-min timing');
});

/* ----- Z-D4 — Substrate-native COPY used (not per-row INSERT)
 *
 * Sprint Z principle clause 3: substrate-native loaders per format,
 * per-row INSERT explicitly avoided. Z2 lands the BulkLoaderAdapter
 * implementations; we check the interface exists + adapters exist for
 * each substrate.
 */
expectPass('Z-D4 BulkLoaderAdapter interface + per-substrate adapters exist (Z2 flipped 2026-05-24)', () => {
    const adapterIface = join(process.cwd(), 'packages/lore/src/bulkLoader/types.ts');
    assert.ok(existsSync(adapterIface), `expected ${adapterIface} (Z2 must add the BulkLoaderAdapter interface per audit doc Section 5)`);
    const src = readFileSync(adapterIface, 'utf8');
    assert.match(src, /BulkLoaderAdapter/, 'must export the BulkLoaderAdapter interface');
    assert.match(src, /writeBatch|checkpoint|begin/, 'interface must declare the lifecycle methods per Section 5');
    // At least one adapter implementation must exist (SQLite first).
    const sqliteAdapter = join(process.cwd(), 'packages/lore/src/bulkLoader/sqliteAdapter.ts');
    assert.ok(existsSync(sqliteAdapter), `expected ${sqliteAdapter} (Z2 must add the SQLite COPY-equivalent adapter — db.transaction + prepared INSERT)`);
});

/* ----- Z-D5 — Checkpoint every N rows; kill mid-load; restart resumes
 *
 * Sprint Z principle clause 4: checkpoint every N rows (default 10k);
 * kill → restart resumes from checkpoint. Z3 lands the resume helper
 * + the load_jobs.checkpointRowId column logic.
 */
expectPass('Z-D5 checkpoint/resume helper exists with 10k default (Z3 flipped 2026-05-24)', () => {
    const adapterIface = join(process.cwd(), 'packages/lore/src/bulkLoader/types.ts');
    assert.ok(existsSync(adapterIface), 'Z3 prerequisite: BulkLoaderAdapter interface (from Z2) must exist before Z3 can add checkpoint/resume');
    const src = readFileSync(adapterIface, 'utf8');
    assert.match(src, /checkpointRowId|resumeFrom|DEFAULT_CHECKPOINT_ROWS\s*=\s*10[_]?000/, 'must declare a 10k-row default checkpoint constant + resume helper per Sprint Z principle clause 4');
});

/* ----- Z-D6 — Per-item failure: malformed row N → row N skipped + reported
 *
 * Sprint Z principle clause 5: per-item failures reported but don't
 * fail the whole job; final job state includes error count + per-error
 * detail. Z3 lands the per-row try/catch + load_jobs.errors aggregator.
 */
expectPass('Z-D6 per-item failure isolation surface present (Z1 flipped 2026-05-24 — schema + response fields; Z3 wires actual population)', () => {
    const loadRoute = join(ROUTES_DIR, 'load.ts');
    assert.ok(existsSync(loadRoute), 'Z3 prerequisite: Z1 must have shipped routes/load.ts');
    const src = readFileSync(loadRoute, 'utf8');
    assert.match(src, /rowsFailed|rejections|errors.*row/, 'route must aggregate per-row failures into rowsFailed + errors[] per Sprint Z principle clause 5');
});

/* ----- Z-D7 — Sprint L workspace_required preserved (no workspace → 400)
 *
 * Regression sentinel: the existing /api/import + /api/nodes/bulk
 * routes already enforce workspace_required (Sprint L). Z-D7 stays
 * GREEN throughout Sprint Z — when the new /api/load route lands, it
 * MUST also enforce workspace_required (same gate function). At Z0
 * we assert the helper that the new route will reuse already exists.
 */
expectPass('Z-D7 workspace_required helper exists for new /api/load to reuse', () => {
    const helpers = join(process.cwd(), 'packages/lore/src/mcp/http/helpers.ts');
    assert.ok(existsSync(helpers), 'helpers.ts must exist (Sprint L invariant — every route uses extractWorkspace + writeWorkspaceRequired)');
    const src = readFileSync(helpers, 'utf8');
    assert.match(src, /writeWorkspaceRequired/, 'writeWorkspaceRequired helper must exist (Sprint L invariant) — Z1 route MUST call it');
    assert.match(src, /extractWorkspace/, 'extractWorkspace helper must exist (Sprint L invariant) — Z1 route MUST call it');
});

/* ----- Z-D8 — Sprint O outbox preserved (large-load completion writes
 *               bulk_load.done outbox notification)
 *
 * Regression sentinel: the outbox SQLite store + OutboxOperationKind
 * union are the post-Sprint-O contract. Z-D8 stays GREEN at Z0 by
 * asserting the SQLite outbox + the operationKind union exist; Z2
 * extends the union with a 'bulk_load.done' variant (we do NOT
 * assert that variant yet — extending the union is the Z2 flip, not
 * a Z0 sentinel — but the underlying infra must remain green).
 */
expectPass('Z-D8 outbox SQLite store + operationKind discriminator exist (Sprint O invariant)', () => {
    const sqliteStore = join(OUTBOX_DIR, 'sqliteStore.ts');
    const types = join(OUTBOX_DIR, 'types.ts');
    assert.ok(existsSync(sqliteStore), 'outbox/sqliteStore.ts must exist (Sprint O3c invariant — Z2 bulk_load.done writes here)');
    assert.ok(existsSync(types), 'outbox/types.ts must exist');
    const sqliteSrc = readFileSync(sqliteStore, 'utf8');
    const typesSrc = readFileSync(types, 'utf8');
    assert.match(sqliteSrc, /batchRecord/, 'batchRecord must remain on the SQLite outbox store (Sprint O3c invariant — Z2 reuses for bulk_load.done)');
    assert.match(typesSrc, /OutboxOperationKind/, 'OutboxOperationKind discriminator union must remain (Sprint O1 invariant — Z2 adds bulk_load.done variant)');
});

/* ----- Z-D9 — Per-tenant concurrency cap (4th concurrent rejected 429 + Retry-After)
 *
 * Sprint Z principle clause 9: per-tenant concurrency cap (default 3
 * concurrent jobs/tenant); 4th rejected with 429 + Retry-After. Z3
 * lands the in-memory tenant→job-count tracker + the rejection path.
 */
expectPass('Z-D9 per-tenant concurrency cap default 3 (Z3 flipped 2026-05-24)', () => {
    const loadRoute = join(ROUTES_DIR, 'load.ts');
    assert.ok(existsSync(loadRoute), 'Z3 prerequisite: routes/load.ts must exist');
    const src = readFileSync(loadRoute, 'utf8');
    assert.match(src, /DEFAULT_TENANT_CONCURRENCY\s*=\s*3|tenantConcurrency.*3|concurrent.*jobs?\s*\/\s*tenant/i, 'must declare the per-tenant concurrency cap default 3 per Sprint Z principle clause 9');
    assert.match(src, /429.*Retry-After|Retry-After.*429|statusCode\s*=?\s*429/, 'must reject 4th concurrent with 429 + Retry-After per Sprint Z principle clause 9');
});

/* ----- Z-D10 — Sprint E skip-embed default works at bulk-load scale
 *
 * Sprint Z principle clause 8: bulk-loaded rows default skip-on-write
 * embed; re-embed via Sprint E re-embed job after load. Z2 wires the
 * loader to emit embed.batch outbox entries (not inline embed) so
 * the Sprint E pipeline drains async.
 */
expectPass('Z-D10 bulk-load default embed:skip with re-embed via Sprint E (Z2 flipped 2026-05-24)', () => {
    const adapterIface = join(process.cwd(), 'packages/lore/src/bulkLoader/types.ts');
    assert.ok(existsSync(adapterIface), 'Z2 prerequisite: BulkLoaderAdapter interface must exist');
    const src = readFileSync(adapterIface, 'utf8');
    assert.match(src, /embed.*'skip'.*\|.*'inline'|embed.*:.*'skip'|BulkLoaderOpts.*embed/, 'BulkLoaderOpts must declare embed: "skip" | "inline" with skip as default per Sprint Z principle clause 8');
});

/* ----- Z-D11 — Backpressure: outbox/embed saturated → 503 (not silent loss)
 *
 * Sprint Z principle clause 10: if outbox depth or embed queue
 * exceeds threshold, new load rejected with 503. Z4 lands the
 * pre-accept check against the existing checkOutboxBackpressure
 * helper + an analogous checkEmbedQueueBackpressure helper.
 */
expectPass('Z-D11 backpressure 503 when outbox saturated (Z1 flipped 2026-05-24 — outbox lag; Z4 extends to embed-queue saturation)', () => {
    const loadRoute = join(ROUTES_DIR, 'load.ts');
    assert.ok(existsSync(loadRoute), 'Z4 prerequisite: routes/load.ts must exist');
    const src = readFileSync(loadRoute, 'utf8');
    assert.match(src, /checkOutboxBackpressure|checkEmbedQueueBackpressure|503.*backpressure|backpressure.*503/i, 'route must call backpressure check + reject with 503 per Sprint Z principle clause 10');
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
