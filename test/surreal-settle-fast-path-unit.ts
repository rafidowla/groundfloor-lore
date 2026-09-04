#!/usr/bin/env tsx
/**
 * surreal-settle-fast-path-unit.ts — regression pin for a round-2 QA finding
 * against `settleSurrealStore`'s `unchangedSinceStart` fast path.
 *
 * `settleSurrealStore` only stats files, so this drives it directly with a
 * fake store directory and a scheduled write standing in for surrealkv's
 * deferred flush — no real driver needed to prove the scheduling gap.
 *
 * ── THE BUG (fixed in this round) ───────────────────────────────────────
 *
 * The fast path trusted a tree that matched the PRE-LOOP snapshot the
 * instant a SINGLE poll confirmed it (~one `pollMs` after the call started,
 * ~25-27ms with defaults). This module's own header documents surrealkv's
 * deferred flush landing "~10-25 ms after `close()` resolves" — squarely
 * inside that one-poll window plus ordinary jitter. A flush landing at, say,
 * t+30ms (one `pollMs` tick late) was invisible to a fast path that had
 * already returned `quiescent` at t+25-27ms, which reintroduces exactly the
 * bug `settleSurrealStore` exists to prevent: a caller renames the directory
 * aside believing it is safe, and the deferred flush then lands inside
 * whatever now occupies that path.
 *
 * Run: npx tsx test/surreal-settle-fast-path-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { settleSurrealStore } from '../packages/lore/src/engines/surreal/surrealSettle.js';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? String(err)}`);
        failed++;
    }
}

/** Build a fake surrealkv store directory: LOCK + manifest/ + a non-empty wal/. */
function makeFakeStore(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-settle-fastpath-'));
    fs.writeFileSync(path.join(dir, 'LOCK'), '');
    fs.mkdirSync(path.join(dir, 'manifest'));
    fs.writeFileSync(path.join(dir, 'manifest', '0.manifest'), 'x'.repeat(55));
    fs.mkdirSync(path.join(dir, 'wal'));
    fs.writeFileSync(path.join(dir, 'wal', '00000000000000000000.wal'), 'x'.repeat(1862));
    return dir;
}

console.log('settleSurrealStore fast-path timing (QA round-2 regression)');

await test(
    'a write scheduled at t+30ms (one pollMs tick past the first poll) is observed before settle '
    + 'declares the store quiescent',
    async () => {
        const dir = makeFakeStore();
        const pollMs = 25;
        const lateFlushDelayMs = pollMs + 5; // 30ms — inside the documented ~10-25ms flush window + jitter.

        let flushLandedBeforeSettleReturned = false;
        const timer = setTimeout(() => {
            // Simulate surrealkv's deferred flush: sstable appears, WAL empties.
            fs.mkdirSync(path.join(dir, 'sstables'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'sstables', '1.sst'), 'y'.repeat(500));
            fs.rmSync(path.join(dir, 'wal', '00000000000000000000.wal'), { force: true });
        }, lateFlushDelayMs);
        timer.unref?.();

        try {
            const result = await settleSurrealStore(dir, { pollMs, budgetMs: 2000, minQuietMs: 150 });
            // The flush timer fires on its own schedule regardless of when settle
            // returns; what matters is whether it had ALREADY landed on disk by
            // the time settle declared victory.
            flushLandedBeforeSettleReturned = fs.existsSync(path.join(dir, 'sstables', '1.sst'))
                && !fs.existsSync(path.join(dir, 'wal', '00000000000000000000.wal'));

            assert.equal(result.outcome, 'quiescent', `expected settle to eventually report quiescent, got ${JSON.stringify(result)}`);
            assert.ok(
                flushLandedBeforeSettleReturned,
                `settle returned 'quiescent' at waitedMs=${result.waitedMs} (polls=${result.polls}) BEFORE the `
                + `deferred flush (scheduled for t+${lateFlushDelayMs}ms) had landed — the fast path trusted an `
                + 'unchanged tree too early.',
            );
        } finally {
            clearTimeout(timer);
            fs.rmSync(dir, { recursive: true, force: true });
        }
    },
);

await test(
    'a store that never changes is still settled well inside the old 150ms minQuietMs floor',
    async () => {
        const dir = makeFakeStore();
        // Nothing scheduled to change — this is the case the fast path exists
        // to speed up in the first place. It must still be faster than the
        // pre-round-1 unconditional minQuietMs floor, even after closing the
        // round-2 gap.
        const result = await settleSurrealStore(dir, { pollMs: 25, budgetMs: 2000, minQuietMs: 150 });
        assert.equal(result.outcome, 'quiescent');
        assert.ok(
            result.waitedMs < 150,
            `expected the fast path to still beat the 150ms minQuietMs floor for a truly idle store, got ${result.waitedMs}ms`,
        );
        fs.rmSync(dir, { recursive: true, force: true });
    },
);

await test(
    'a store whose wal/ is non-empty but genuinely idle since before polling started is still trusted '
    + 'by the fast path, not forced through the full minQuietMs floor',
    async () => {
        const dir = makeFakeStore();
        const result = await settleSurrealStore(dir, { pollMs: 10, budgetMs: 2000, minQuietMs: 150 });
        assert.equal(result.outcome, 'quiescent');
        assert.ok(
            result.waitedMs < 150,
            `expected the unchangedSinceStart fast path to still apply, got waitedMs=${result.waitedMs}`,
        );
        fs.rmSync(dir, { recursive: true, force: true });
    },
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
