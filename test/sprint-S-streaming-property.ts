#!/usr/bin/env tsx
/**
 * test/sprint-S-streaming-property.ts — Sprint S gate test.
 *
 * 8 cases asserting the Sprint S warm-lane streaming-ingest contract
 * (spec: lore-phase6-spec-2026-05-21/SPRINT-S-streaming-ingest-provision.md).
 * Mirrors L0 / O0 / E0 / Z0 / H0 harness pattern:
 *
 *   - S-D1..S-D5 + S-D8 are expectPass on commit (Sprint S ships
 *     as a single chain — interface + reference impl + route all
 *     land in one merge unit, so the 6 "xfail-flip-on-commit" cases
 *     are already passing at commit time).
 *   - S-D6 + S-D7 are expectPass regression sentinels (Sprint L
 *     workspace_required + Sprint O outbox-first invariants must
 *     remain green THROUGHOUT Sprint S and beyond).
 *
 * After commit:
 *   expect-pass: 8 (6 flipped + 2 sentinels)
 *
 * Cases are STATIC file-system probes / source-text greps — the gate
 * commits without spinning a daemon. Behavioral assertions live in
 * test/S-streaming-unit.ts which drives the route in-process against
 * stubs.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/* ============================================================
 * xfail-strict harness (matches sprint-H-online-migration-property.ts)
 * ============================================================ */

let xfailPassed = 0;
let unexpectedPass = 0;
let runnerErrors = 0;
let expectPassed = 0;
let expectFailed = 0;
const pending: Array<Promise<void>> = [];

function xfailStrict(name: string, fn: () => Promise<void> | void): void {
    pending.push((async () => {
        try { await fn(); } catch (err) {
            console.log(`  ✓ ${name} (xfail-pass: ${(err as Error).message.split('\n')[0]?.slice(0, 80)})`);
            xfailPassed++;
            return;
        }
        console.error(`  ✗ ${name} — UNEXPECTED PASS. Promote this case to expectPass() and remove the xfail wrapper.`);
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

// Reference both helpers so the harness keeps the same shape as other
// sprint property gates even though Sprint S ships every case as
// expectPass on commit.
void xfailStrict;

/* ============================================================ */

console.log('Sprint S gate test — Warm-lane streaming-ingest provision (8 expect-pass at commit)');

const LORE_SRC = join(process.cwd(), 'packages/lore/src');
const STREAMING_DIR = join(LORE_SRC, 'streaming');
const ROUTES_DIR = join(LORE_SRC, 'mcp/http/routes');
const OUTBOX_TYPES = join(LORE_SRC, 'outbox/types.ts');
const DISPATCHER = join(LORE_SRC, 'mcp/http/dispatcher.ts');

/* ----- S-D1 — POST /api/stream/connect endpoint exists + wired
 *
 * Sprint S principle: warm-lane streaming-ingest endpoint shipped as
 * a first-class HTTP route. Assertion: stream.ts exists with the
 * connect path + dispatcher imports tryStreamRoutes.
 */
expectPass('S-D1 POST /api/stream/connect route shipped + wired into dispatcher', () => {
    const routeFile = join(ROUTES_DIR, 'stream.ts');
    assert.ok(existsSync(routeFile), `expected ${routeFile} (Sprint S deliverable 1)`);
    const src = readFileSync(routeFile, 'utf8');
    assert.match(src, /\/api\/stream\/connect/, 'route must declare /api/stream/connect path');
    assert.match(src, /tryStreamRoutes/, 'route must export tryStreamRoutes dispatcher');
    const dispSrc = readFileSync(DISPATCHER, 'utf8');
    assert.match(dispSrc, /tryStreamRoutes/, 'dispatcher must import tryStreamRoutes');
    assert.match(dispSrc, /streamRegistry/, 'dispatcher must thread streamRegistry into deps');
});

/* ----- S-D2 — Newline-delimited JSON events stream → outbox commit
 *
 * Sprint S principle: each event lands in the outbox per Sprint O
 * contract. Assertion: route source threads events through the
 * LocalStreamConsumer (which calls recordHotWrite); outbox kind
 * 'stream.event' added to OutboxOperationKind union.
 */
expectPass('S-D2 stream.event outbox kind + LocalStreamConsumer commit path present', () => {
    const typesSrc = readFileSync(OUTBOX_TYPES, 'utf8');
    assert.match(typesSrc, /['"]stream\.event['"]|stream\.event/, 'outbox types.ts must declare stream.event operationKind');
    const consumer = join(STREAMING_DIR, 'streamConsumer.ts');
    assert.ok(existsSync(consumer), `expected ${consumer}`);
    const consumerSrc = readFileSync(consumer, 'utf8');
    assert.match(consumerSrc, /recordHotWrite/, 'LocalStreamConsumer must commit via recordHotWrite (Sprint O hot-lane)');
    assert.match(consumerSrc, /class\s+LocalStreamConsumer/, 'LocalStreamConsumer class must be defined');
});

/* ----- S-D3 — StreamConsumerAdapter cloud-pluggable interface present
 *
 * Sprint S principle: interface contract locks the cloud-driver shape
 * (Kafka/NATS/Kinesis drop-in). Assertion: streamConsumer.ts exports
 * StreamConsumerAdapter interface + LocalStreamConsumer impl + the
 * cloud-pluggability rationale is documented in the file header.
 */
expectPass('S-D3 StreamConsumerAdapter interface + cloud-pluggability doc present', () => {
    const consumer = join(STREAMING_DIR, 'streamConsumer.ts');
    assert.ok(existsSync(consumer), `expected ${consumer}`);
    const src = readFileSync(consumer, 'utf8');
    assert.match(src, /interface\s+StreamConsumerAdapter/, 'interface StreamConsumerAdapter must be declared');
    assert.match(src, /onEvent\s*\(/, 'StreamConsumerAdapter must expose onEvent verb');
    assert.match(src, /start\s*\(/, 'StreamConsumerAdapter must expose start verb');
    assert.match(src, /stop\s*\(/, 'StreamConsumerAdapter must expose stop verb');
    // Cloud-pluggability rationale in header (mention Kafka or NATS or Kinesis).
    assert.match(src, /Kafka|NATS|Kinesis/i, 'header must document cloud-pluggable contract (Kafka/NATS/Kinesis)');
});

/* ----- S-D4 — Connection drop mid-stream → outbox + registry consistent
 *
 * Sprint S principle: in-flight rollback + concurrency slot release on
 * client disconnect. Assertion: stream.ts wraps the pump in a finally
 * that calls registry.release(); behavioral coverage in S-streaming-unit.ts.
 */
expectPass('S-D4 stream route releases concurrency slot in finally block', () => {
    const routeFile = join(ROUTES_DIR, 'stream.ts');
    const src = readFileSync(routeFile, 'utf8');
    assert.match(src, /finally\s*\{/, 'connect handler must wrap pump in finally for slot release');
    assert.match(src, /\.release\(/, 'finally block must call registry.release()');
    // Unit test must cover the drop-mid-stream path.
    const unit = join(process.cwd(), 'test/S-streaming-unit.ts');
    assert.ok(existsSync(unit), `expected ${unit} (Sprint S deliverable 4)`);
    const unitSrc = readFileSync(unit, 'utf8');
    assert.match(unitSrc, /S-D4|drop mid-stream/, 'unit test must cover connection-drop scenario');
});

/* ----- S-D5 — Per-tenant concurrency cap (default 3; 4th rejected with 429)
 *
 * Sprint S principle: per-workspace concurrency cap mirroring Sprint Z3.
 * Assertion: StreamRegistry exists with DEFAULT_MAX_CONCURRENT_PER_WORKSPACE
 * = 3; route emits 429 + Retry-After + 'concurrency_limit' body when
 * cap exceeded.
 */
expectPass('S-D5 StreamRegistry cap=3 + route emits 429 concurrency_limit', () => {
    const registry = join(STREAMING_DIR, 'streamRegistry.ts');
    assert.ok(existsSync(registry), `expected ${registry}`);
    const regSrc = readFileSync(registry, 'utf8');
    assert.match(regSrc, /DEFAULT_MAX_CONCURRENT_PER_WORKSPACE\s*=\s*3/, 'default cap must be 3 (matches Sprint Z3 symmetry)');
    assert.match(regSrc, /LORE_STREAM_MAX_CONCURRENT_PER_WORKSPACE/, 'env override must be wired');
    const routeFile = join(ROUTES_DIR, 'stream.ts');
    const routeSrc = readFileSync(routeFile, 'utf8');
    assert.match(routeSrc, /429/, 'route must emit HTTP 429 on cap exceeded');
    assert.match(routeSrc, /concurrency_limit/, 'route must emit concurrency_limit error code');
    assert.match(routeSrc, /Retry-After/, 'route must set Retry-After header');
});

/* ----- S-D6 — Sprint L workspace_required preserved (regression sentinel)
 *
 * Must hold today and throughout Sprint S. Assertion: route invokes
 * writeWorkspaceRequired before any other gate; workspaceRequired
 * helper still exists at the canonical location.
 */
expectPass('S-D6 Sprint L workspace_required preserved in stream route (regression sentinel)', () => {
    const routeFile = join(ROUTES_DIR, 'stream.ts');
    const src = readFileSync(routeFile, 'utf8');
    assert.match(src, /writeWorkspaceRequired/, 'stream route must call writeWorkspaceRequired (Sprint L)');
    assert.match(src, /extractWorkspace/, 'stream route must call extractWorkspace (Sprint L)');
    // The canonical helper must still exist.
    const helpers = join(LORE_SRC, 'mcp/http/helpers.ts');
    assert.ok(existsSync(helpers), `expected ${helpers} (Sprint L invariant)`);
    const helpersSrc = readFileSync(helpers, 'utf8');
    assert.match(helpersSrc, /function\s+writeWorkspaceRequired/, 'writeWorkspaceRequired helper must remain exported');
});

/* ----- S-D7 — Sprint O outbox preserved (regression sentinel)
 *
 * Must hold today and throughout Sprint S. Assertion: stream consumer
 * routes every event through recordHotWrite; outbox SQLite store +
 * replicator still present.
 */
expectPass('S-D7 Sprint O outbox + hot-lane commit path preserved (regression sentinel)', () => {
    const consumer = join(STREAMING_DIR, 'streamConsumer.ts');
    const consumerSrc = readFileSync(consumer, 'utf8');
    assert.match(consumerSrc, /recordHotWrite/, 'stream consumer must commit via outbox/hotLane.recordHotWrite');
    const hotLane = join(LORE_SRC, 'outbox/hotLane.ts');
    const sqliteStore = join(LORE_SRC, 'outbox/sqliteStore.ts');
    const replicator = join(LORE_SRC, 'outbox/replicator.ts');
    assert.ok(existsSync(hotLane), `expected ${hotLane} (Sprint O invariant)`);
    assert.ok(existsSync(sqliteStore), `expected ${sqliteStore} (Sprint O invariant)`);
    assert.ok(existsSync(replicator), `expected ${replicator} (Sprint O invariant)`);
});

/* ----- S-D8 — Backpressure integration (Sprint O4 lag → 503 outbox_lag)
 *
 * Sprint S principle: backpressure check fires BEFORE concurrency slot
 * acquire so a rejected request never reserves a slot. Assertion:
 * route calls checkOutboxBackpressure before registry.open and the
 * shared 503 helper writes 'outbox_lag' + Retry-After.
 */
expectPass('S-D8 stream route integrates Sprint O4 backpressure (503 outbox_lag) before slot acquire', () => {
    const routeFile = join(ROUTES_DIR, 'stream.ts');
    const src = readFileSync(routeFile, 'utf8');
    assert.match(src, /checkOutboxBackpressure/, 'route must call checkOutboxBackpressure (Sprint O4)');
    // Ordering: backpressure check must appear BEFORE the registry.open
    // call so a rejected request never reserves a slot.
    const bpIdx = src.indexOf('checkOutboxBackpressure(');
    const openIdx = src.indexOf('streamRegistry.open(');
    // Acceptable: open is called via deps.streamRegistry.open
    const openIdx2 = src.indexOf('.streamRegistry.open(');
    const openIdx3 = src.indexOf('registry.open(');
    const earliestOpen = Math.min(
        ...[openIdx, openIdx2, openIdx3].filter((i) => i >= 0)
    );
    assert.ok(bpIdx >= 0, 'checkOutboxBackpressure call must exist');
    assert.ok(earliestOpen > bpIdx, `backpressure check (idx ${bpIdx}) must precede registry.open (idx ${earliestOpen}) so a rejected request does NOT reserve a slot`);
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
