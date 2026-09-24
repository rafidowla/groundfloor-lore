#!/usr/bin/env tsx
/**
 * outbox-deleted-workspace-retry-unit.ts — a workspace deleted with rows
 * still queued in its outbox.
 *
 * Found during the 3.20.0 memory sprint (docs/PERFORMANCE-MEMORY.md §8.5):
 * unregistering a workspace before its hot-write rows replayed produced
 * hundreds of identical "resolve for workspace ... failed" lines within
 * seconds, read as "retries forever with no backoff or cap". Reproducing it
 * on 3.19.1 showed the rows ARE bounded (maxAttempts = 5 → dead-letter after
 * ~14 s, with SP-21 backoff), but pinned three real defects, fixed here:
 *
 *   1. Sub-second backoff was ignored. listPendingForWorkspace compared
 *      `datetime(nextAttemptAt) <= datetime('now')`, and datetime() truncates
 *      to whole seconds — the first retry (base 500 ms) fired on the next
 *      10 ms busy tick (measured: attempts at 1 ms, 12 ms, 2.0 s, 6.1 s,
 *      14.1 s). Now julianday(), which keeps sub-second precision.
 *   2. One log line per row per attempt (77 rows → 462 lines, 231 in the
 *      first 5 s). Now throttled per (substrate, workspace) window.
 *   3. The retry budget was hard-coded. Now LORE_OUTBOX_MAX_ATTEMPTS /
 *      LORE_OUTBOX_RETRY_BASE_MS (defaults unchanged: 5 / 500 ms).
 *
 * And pins the recovery contract: the dead-lettered row names the missing
 * workspace, and once the workspace exists again `requeueDead` puts it back
 * and it replays into that workspace's store.
 *
 * Real SqliteOutboxStore + real wireOutbox + real WorkspaceVerbatimResolver
 * (LanceDB, with a constant embedder). No daemon, no network.
 *
 * Run: npx tsx test/outbox-deleted-workspace-retry-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-deleted-ws-'));
process.env.LORE_HOME = HOME;
// Small, test-speed retry budget — also proves the env knobs reach the wiring.
process.env.LORE_OUTBOX_RETRY_BASE_MS = '100';
process.env.LORE_OUTBOX_MAX_ATTEMPTS = '4';

const { createWorkspace, deleteWorkspace } = await import('../packages/lore/src/config/workspaces.js');
const { wireOutbox } = await import('../packages/lore/src/outbox/wiring.js');
const { WorkspaceVerbatimResolver } = await import('../packages/lore/src/outbox/workspaceVerbatimResolver.js');
const { SqliteOutboxStore } = await import('../packages/lore/src/outbox/sqliteStore.js');
const { readEnvRetryConfig, DEFAULT_OUTBOX_MAX_ATTEMPTS, DEFAULT_OUTBOX_RETRY_BASE_MS } =
    await import('../packages/lore/src/outbox/retryConfig.js');
const { logResolveFailure, _resetResolveFailureLogForTests } =
    await import('../packages/lore/src/outbox/resolveFailureLog.js');
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';
import type { OutboxEntry } from '../packages/lore/src/outbox/types.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
        passed++;
        console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    } catch (err) {
        failed++;
        console.log(`  \x1b[31m✗ ${name}\x1b[0m`);
        console.log(`    ${(err as Error).stack ?? (err as Error).message}`);
    }
}

class ConstEmbedProvider implements EmbeddingProvider {
    get modelId() { return 'outbox-deleted-ws-const'; }
    get dimension() { return 8; }
    async initialize() { /* no-op */ }
    private vec() { return new Array(8).fill(0.1); }
    async embed() { return this.vec(); }
    async embedQuery() { return this.vec(); }
    async embedDocument() { return this.vec(); }
    async embedDocumentBatch(texts: string[]) { return texts.map(() => this.vec()); }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function findEntry(store: { listUnfinished(): Promise<OutboxEntry[]> }, id: string): Promise<OutboxEntry | undefined> {
    return (await store.listUnfinished()).find((e) => e.id === id);
}

async function main(): Promise<void> {
    console.log('outbox: rows for a deleted workspace back off, dead-letter with a clear reason, and requeue once it returns');

    // ── Section A: env knobs ──────────────────────────────────────────────
    await test('readEnvRetryConfig: defaults are the pre-existing hard-coded values', async () => {
        assert.deepEqual(readEnvRetryConfig({}), { maxAttempts: 5, retryBaseMs: 500 });
        assert.equal(DEFAULT_OUTBOX_MAX_ATTEMPTS, 5);
        assert.equal(DEFAULT_OUTBOX_RETRY_BASE_MS, 500);
    });
    await test('readEnvRetryConfig: valid overrides apply; invalid values fall back silently', async () => {
        assert.deepEqual(
            readEnvRetryConfig({ LORE_OUTBOX_MAX_ATTEMPTS: '9', LORE_OUTBOX_RETRY_BASE_MS: '250' }),
            { maxAttempts: 9, retryBaseMs: 250 },
        );
        for (const bad of ['0', '-3', '1.5', 'abc', ' ']) {
            assert.deepEqual(
                readEnvRetryConfig({ LORE_OUTBOX_MAX_ATTEMPTS: bad, LORE_OUTBOX_RETRY_BASE_MS: bad }),
                { maxAttempts: 5, retryBaseMs: 500 },
                `"${bad}" must fall back to defaults`,
            );
        }
    });

    // ── Section B: sub-second backoff is honoured (the datetime() bug) ────
    await test('a failed row is NOT due again before its sub-second backoff elapses', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-backoff-'));
        const store = new SqliteOutboxStore(dir, { retryBaseMs: 150 }); // 1st retry at +300 ms
        const now = new Date().toISOString();
        await store.record({
            id: 'b-1', operation: 'verbatim.upsert', initiator: 'test', createdAt: now, updatedAt: now,
            steps: [], completed: false, workspace: 'ws-b', operationKind: 'verbatim.upsert',
            payload: { id: 'lore:b-1', text: 't' }, status: 'pending', attempts: 0,
        });
        // Fail the row just after a wall-clock second boundary, so the +300 ms
        // retry time falls inside the SAME second. That is exactly the case the
        // old datetime() comparison got wrong (both sides truncate to that
        // second → "due" immediately); a boundary-agnostic timing would only
        // catch it by luck.
        await sleep(1000 - (Date.now() % 1000) + 5);
        await store.markEntryStatus('b-1', 'failed', { error: 'boom', bumpAttempt: true });
        const [row] = await store.listUnfinished().then((all) => all.filter((e) => e.id === 'b-1'));
        assert.ok(row.nextAttemptAt && new Date(row.nextAttemptAt).getUTCSeconds() === new Date().getUTCSeconds(),
            'precondition: the retry time is inside the current wall-clock second');
        assert.equal((await store.listPendingForWorkspace('ws-b', 10)).length, 0,
            'due immediately after failing — sub-second backoff ignored (datetime() truncation)');
        await sleep(400);
        assert.equal((await store.listPendingForWorkspace('ws-b', 10)).length, 1, 'due once the backoff has elapsed');
        store.close();
    });

    // ── Section C: log throttle ───────────────────────────────────────────
    await test('logResolveFailure: first failure logs, repeats in the window are suppressed and counted', async () => {
        _resetResolveFailureLogForTests();
        const lines: string[] = [];
        const log = (l: string) => lines.push(l);
        logResolveFailure('graph', 'gone', 'workspace_not_found', { now: 0, windowMs: 1000, log });
        for (let t = 1; t <= 50; t++) logResolveFailure('graph', 'gone', 'workspace_not_found', { now: t, windowMs: 1000, log });
        logResolveFailure('verbatim', 'gone', 'workspace_not_found', { now: 60, windowMs: 1000, log }); // separate key
        assert.equal(lines.length, 2, 'one line per (substrate, workspace) inside the window');
        logResolveFailure('graph', 'gone', 'workspace_not_found', { now: 1500, windowMs: 1000, log });
        assert.equal(lines.length, 3);
        assert.match(lines[2], /50 identical failure\(s\) suppressed/);
        assert.match(lines[0], /graph resolve for workspace "gone" failed/);
        _resetResolveFailureLogForTests();
    });

    // ── Section D: the real scenario ──────────────────────────────────────
    const provider = new ConstEmbedProvider();
    const resolver = new WorkspaceVerbatimResolver(provider, false);
    const loreDir = path.join(HOME, 'boot-lore');
    fs.mkdirSync(loreDir, { recursive: true });
    const wiring = wireOutbox({
        loreDir,
        getSyncEngine: () => ({ recoverVectorMirror: async () => ({ recovered: 0, skipped: 0 }) }) as never,
        getGraph: () => ({}) as never,          // never reached: every row below is workspace-scoped
        getVerbatim: () => ({}) as never,       // ditto — must NOT be used as a fallback
        getVerbatimForWorkspace: () => (ws: string) => resolver.getOrOpen(ws),
    });
    const store = wiring.store as InstanceType<typeof SqliteOutboxStore>;
    const attemptsAt: number[] = [];
    const origMark = store.markEntryStatus.bind(store);
    (store as unknown as { markEntryStatus: typeof origMark }).markEntryStatus = async (id, st, info) => {
        if (id === 'row-1' && (st === 'failed' || st === 'dead')) attemptsAt.push(Date.now());
        return origMark(id, st, info);
    };
    const resolveLines: string[] = [];
    const origErr = console.error;
    console.error = (...a: unknown[]) => {
        const s = a.map(String).join(' ');
        if (/resolve for workspace/.test(s)) resolveLines.push(s);
    };

    createWorkspace('doomed', undefined, HOME);
    const nowIso = new Date().toISOString();
    await store.record({
        id: 'row-1', operation: 'verbatim.upsert', initiator: 'test', createdAt: nowIso, updatedAt: nowIso,
        steps: [], completed: false, workspace: 'doomed', operationKind: 'verbatim.upsert',
        payload: { id: 'lore:doomed:row-1', text: 'written before the workspace was deleted', metadata: {} },
        status: 'pending', attempts: 0,
    });
    deleteWorkspace('doomed', HOME); // gone before the replicator ever sees the row

    const t0 = Date.now();
    wiring.replicator.start();
    // base 100 ms, 4 attempts → retries at +200, +400, +800 ms → dead by ~1.5 s
    // plus up to one 250 ms idle nap per step. Then watch 1 s more.
    for (let i = 0; i < 60; i++) {
        await sleep(100);
        if ((await findEntry(store, 'row-1'))?.status === 'dead') break;
    }
    await sleep(1000);
    const keep = setInterval(() => {}, 1000); // replicator naps are unref'd
    await wiring.replicator.stop();
    clearInterval(keep);
    console.error = origErr;

    await test('the row dead-letters after exactly LORE_OUTBOX_MAX_ATTEMPTS attempts — bounded, not forever', async () => {
        const row = await findEntry(store, 'row-1');
        assert.equal(row?.status, 'dead');
        assert.equal(row?.attempts, 4, 'maxAttempts from env (4) reached the replicator');
        assert.equal(attemptsAt.length, 4, `exactly 4 attempts, none after dead-letter (saw ${attemptsAt.length})`);
    });

    await test('retries are spaced by the exponential backoff, not the 10 ms busy tick', async () => {
        const gaps = attemptsAt.slice(1).map((t, i) => t - attemptsAt[i]);
        // expected ≥ 200, 400, 800 ms (base 100 × 2^attempts); allow 20 ms clock slack
        [200, 400, 800].forEach((min, i) => {
            assert.ok(gaps[i] >= min - 20, `gap ${i + 1} was ${gaps[i]} ms, expected ≥ ${min} ms (gaps: ${gaps.join(', ')}; total ${attemptsAt[3] - t0} ms)`);
        });
    });

    await test('the dead-letter reason names the missing workspace', async () => {
        const row = await findEntry(store, 'row-1');
        assert.match(row?.lastError ?? '', /workspace_not_found/);
        assert.match(row?.lastError ?? '', /doomed/);
    });

    await test('the resolve-failure log is throttled to one line for the whole retry run', async () => {
        assert.equal(resolveLines.length, 1, `expected 1 line, got ${resolveLines.length}`);
    });

    await test('once the workspace exists again, requeueDead + replay lands the row in THAT workspace', async () => {
        createWorkspace('doomed', undefined, HOME);
        const n = await store.requeueDead({ errorContains: 'workspace_not_found' });
        assert.equal(n, 1, 'the dead row was requeued');
        const requeued = await findEntry(store, 'row-1');
        assert.notEqual(requeued?.status, 'dead');
        assert.equal(requeued?.attempts, 0, 'requeue resets the retry budget');
        // Drive replay deterministically rather than via the timer loop.
        await (wiring.replicator as unknown as { tickOnce(): Promise<number> }).tickOnce();
        const row = (await store.listUnfinished()).find((e) => e.id === 'row-1');
        assert.ok(!row || row.status === 'replicated', `row status after replay: ${row?.status} (${row?.lastError ?? ''})`);
        const v = await resolver.getOrOpen('doomed');
        const hit = await v.getById('lore:doomed:row-1');
        assert.ok(hit, 'the verbatim row is in the recreated workspace\'s store');
    });

    await resolver.closeAll();
    store.close();
    try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* best-effort */ }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
