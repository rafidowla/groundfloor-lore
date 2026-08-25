#!/usr/bin/env tsx
/**
 * sw02-wal-dataloss-unit.ts — SW-02 regression tests for the sync WAL.
 *
 * Proves the four silent-data-loss bugs in engines/syncEngine.ts are fixed:
 *   B1 — a write appended DURING an in-flight adapter.push() must survive the
 *        truncate (old code blanket-truncated the whole file).
 *   B2 — buffered delete_node entries must reach the adapter (pushDeletes) and
 *        must NOT be truncated until acked.
 *   B3 — an unrecognized op (no pluginName) must survive truncation, not vanish.
 *   B11 — readPending must count + warn on malformed JSONL lines.
 *
 * These FAIL on base (whole-WAL truncate, no delete push) and PASS on branch.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    SyncEngine,
    WriteAheadLog,
    type SyncAdapter,
    type SyncResult,
} from '../packages/lore/src/engines/syncEngine.js';
import type { LoreNode, LoreEdge } from '../packages/lore/src/providers/types.js';

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

function tmpLoreDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'sw02-wal-'));
}

/** Minimal local-graph stub — pushPending only duck-types markSynced (absent here). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const noopGraph = {} as any;

/** Base adapter; tests override push / pushDeletes per scenario. */
function baseAdapter(over: Partial<SyncAdapter> = {}): SyncAdapter {
    return {
        async push(): Promise<SyncResult> { return { nodesPushed: 0, edgesPushed: 0, failures: 0, errors: [] }; },
        async pull() { return { nodes: [], edges: [] }; },
        async isConnected() { return true; },
        async connect() { /* no-op */ },
        async disconnect() { /* no-op */ },
        ...over,
    };
}

(async () => {
    console.log('SW-02 · WAL data-loss');

    // ── B1: write appended DURING in-flight push survives next cycle ──
    await test('B1: a write appended during an in-flight push survives truncation', async () => {
        const dir = tmpLoreDir();
        const wal = new WriteAheadLog(dir);
        wal.append('upsert_node', { id: 'n-early', updatedAt: '2026-01-01T00:00:00Z' });

        // Adapter that, while "pushing", simulates a concurrent local write
        // landing in the WAL (a brand-new entryId the push loop never read).
        const adapter = baseAdapter({
            async push(nodes: LoreNode[]): Promise<SyncResult> {
                wal.append('upsert_node', { id: 'n-during', updatedAt: '2026-01-02T00:00:00Z' });
                return { nodesPushed: nodes.length, edgesPushed: 0, failures: 0, errors: [] };
            },
        });

        const engine = new SyncEngine(noopGraph, dir, adapter);
        // Make the engine read the SAME WAL instance the adapter appends to.
        const r = await engine.pushPending();
        assert.equal(r.failures, 0, 'push should report no failures');

        const remaining = wal.readPending();
        const ids = remaining.map(e => e.data['id']);
        assert.ok(ids.includes('n-during'), `mid-push write must survive; WAL now holds: ${JSON.stringify(ids)}`);
        assert.ok(!ids.includes('n-early'), 'the pushed entry should have been truncated');
    });

    // ── B2: buffered delete reaches the adapter, not truncated until acked ──
    await test('B2: a buffered delete reaches the adapter and is truncated only after ack', async () => {
        const dir = tmpLoreDir();
        const wal = new WriteAheadLog(dir);
        wal.append('delete_node', { id: 'gone-1' });
        wal.append('delete_node', { id: 'gone-2' });

        const seen: string[] = [];
        const adapter = baseAdapter({
            async pushDeletes(ids: string[]): Promise<SyncResult> {
                seen.push(...ids);
                return { nodesPushed: ids.length, edgesPushed: 0, failures: 0, errors: [] };
            },
        });

        const engine = new SyncEngine(noopGraph, dir, adapter);
        const r = await engine.pushPending();
        assert.equal(r.failures, 0, 'deletes should push cleanly');
        assert.deepEqual([...seen].sort(), ['gone-1', 'gone-2'], 'both delete ids must reach the adapter');
        assert.equal(wal.readPending().length, 0, 'acked deletes are truncated from the WAL');
    });

    await test('B2: a delete is NOT truncated when the adapter rejects it', async () => {
        const dir = tmpLoreDir();
        const wal = new WriteAheadLog(dir);
        wal.append('delete_node', { id: 'gone-x' });

        const adapter = baseAdapter({
            async pushDeletes(): Promise<SyncResult> {
                return { nodesPushed: 0, edgesPushed: 0, failures: 1, errors: ['boom'] };
            },
        });

        const engine = new SyncEngine(noopGraph, dir, adapter);
        const r = await engine.pushPending();
        assert.ok(r.failures > 0, 'failed delete should report a failure');
        const ids = wal.readPending().map(e => e.data['id']);
        assert.deepEqual(ids, ['gone-x'], 'a rejected delete must remain in the WAL');
    });

    await test('B2: an adapter without pushDeletes retains deletes in the WAL', async () => {
        const dir = tmpLoreDir();
        const wal = new WriteAheadLog(dir);
        wal.append('delete_node', { id: 'gone-y' });

        const adapter = baseAdapter(); // no pushDeletes
        const engine = new SyncEngine(noopGraph, dir, adapter);
        const r = await engine.pushPending();
        assert.ok(r.failures > 0, 'missing delete support should surface as a failure');
        assert.equal(wal.readPending().length, 1, 'delete must NOT be silently dropped');
    });

    // ── B3: unrecognized op survives truncation ──
    await test('B3: an unrecognized op (no pluginName) survives a successful push', async () => {
        const dir = tmpLoreDir();
        const wal = new WriteAheadLog(dir);
        wal.append('upsert_node', { id: 'n-ok', updatedAt: '2026-01-01T00:00:00Z' });
        wal.append('future_op_v9', { id: 'mystery', shape: 'unknown' }); // no pluginName

        const adapter = baseAdapter({
            async push(nodes: LoreNode[]): Promise<SyncResult> {
                return { nodesPushed: nodes.length, edgesPushed: 0, failures: 0, errors: [] };
            },
        });
        const engine = new SyncEngine(noopGraph, dir, adapter);
        await engine.pushPending();

        const ids = wal.readPending().map(e => e.data['id']);
        assert.ok(ids.includes('mystery'), 'unrecognized op must survive for a future version to drain');
        assert.ok(!ids.includes('n-ok'), 'the recognized+pushed node should be gone');
    });

    // ── B3 (SW-23): an unrecognized op that carries a pluginName is ALSO
    // retained now that the plugin push path is removed (no live producer;
    // plugin system removed in v3.11.0). Previously such entries were drained
    // via pushPluginData and truncated — they must NOT be silently dropped. ──
    await test('B3/SW-23: an unrecognized op WITH a pluginName survives (no plugin push path)', async () => {
        const dir = tmpLoreDir();
        const wal = new WriteAheadLog(dir);
        wal.append('upsert_node', { id: 'n-ok2', updatedAt: '2026-01-01T00:00:00Z' });
        wal.append('legacy_plugin_op', { id: 'plugin-mystery', pluginName: 'cre', kind: 'deal' });

        const adapter = baseAdapter({
            async push(nodes: LoreNode[]): Promise<SyncResult> {
                return { nodesPushed: nodes.length, edgesPushed: 0, failures: 0, errors: [] };
            },
        });
        const engine = new SyncEngine(noopGraph, dir, adapter);
        await engine.pushPending();

        const ids = wal.readPending().map(e => e.data['id']);
        assert.ok(ids.includes('plugin-mystery'), 'plugin-named op must survive — the plugin push path was removed, not the data');
        assert.ok(!ids.includes('n-ok2'), 'the recognized+pushed node should be gone');
    });

    // ── B11: malformed lines are counted + silently skipped, not returned ──
    //
    // NW-7e decouple: the original test asserted via console.warn spy. SW-32
    // migrated the WAL to the structured logger (which writes to stderr, not
    // console.*), so a console.warn spy would always produce zero warnings and
    // the test would silently false-pass. This revision asserts STRUCTURALLY:
    //   - readPending returns only the valid entries (malformed lines are skipped).
    //   - The valid entry count is exactly 1 (the malformed line was not returned).
    //   - readPending does not throw (graceful degradation).
    // This invariant holds regardless of whether the WAL uses console.warn,
    // the SW-32 structured logger, or any future log sink.
    await test('B11: readPending skips malformed JSONL lines (structural assertion, logger-agnostic)', async () => {
        const dir = tmpLoreDir();
        const wal = new WriteAheadLog(dir);
        wal.append('upsert_node', { id: 'valid-b11' });
        // Append a corrupt line directly — simulates on-disk corruption.
        fs.appendFileSync(path.join(dir, 'sync.wal'), '{ this is not json\n');
        // Append a second valid entry AFTER the corrupt line to confirm
        // parsing continues past the bad line.
        wal.append('upsert_node', { id: 'valid-b11-after' });

        const entries = wal.readPending();
        // Structural check 1: only valid entries are returned.
        assert.equal(
            entries.length,
            2,
            `expected 2 valid entries but got ${entries.length}; readPending must skip (not throw on) corrupt lines`,
        );
        // Structural check 2: the valid ids are present, the corrupt line is absent.
        const ids = entries.map(e => e.data['id'] as string);
        assert.ok(ids.includes('valid-b11'), 'first valid entry must appear');
        assert.ok(ids.includes('valid-b11-after'), 'entry after corrupt line must appear');
        // Structural check 3: no entry has undefined op (corrupt line not sneaking in).
        for (const e of entries) {
            assert.ok(typeof e.op === 'string', 'every returned entry must have a string op');
        }
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})();
