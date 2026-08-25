#!/usr/bin/env tsx
/**
 * test/migration-checkpoint-store-unit.ts — Phase 4 batched
 * checkpointing tests for the on-disk store.
 *
 * Covers: round-trip save/load, atomic write under crash, corrupt
 * file is tolerated (returns null), clear removes the file, save
 * stamps `lastCheckpointAt`, missing parent dir is created.
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { CheckpointStore, type CheckpointState } from '../packages/lore/src/schemas/migration/checkpointStore.js';

let passed = 0;
let failed = 0;

const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void>) {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
    })());
}

async function withTmpLoreDir<T>(fn: (loreDir: string) => Promise<T>): Promise<T> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-checkpoint-'));
    const loreDir = path.join(dir, '.lore');
    try { return await fn(loreDir); }
    finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
}

function exampleState(): CheckpointState {
    return {
        planId: 'plan-42',
        startedAt: '2026-05-16T10:00:00.000Z',
        lastCheckpointAt: '2026-05-16T10:00:00.000Z',
        proposedBy: 'human:rafi',
        approvedBy: 'human:rafi',
        sandboxId: 'sandbox-abc',
        note: 'tidy old know.Tenant rows',
        ops: [
            { opIndex: 0, op: { kind: 'node_type.removed', target: 'know.Tenant' },
              status: 'in_progress', cursor: 'more', deleted: 47, modified: 0 },
            { opIndex: 1, op: { kind: 'field.removed', target: 'know.Account.legacy' },
              status: 'pending', cursor: null, deleted: 0, modified: 0 },
        ],
    };
}

console.log('CheckpointStore — Phase 4 batched checkpointing');

test('load() returns null when no checkpoint exists', async () => {
    await withTmpLoreDir(async loreDir => {
        const store = new CheckpointStore(loreDir);
        assert.equal(store.load(), null);
    });
});

test('save() then load() round-trips the state', async () => {
    await withTmpLoreDir(async loreDir => {
        const store = new CheckpointStore(loreDir);
        const state = exampleState();
        store.save(state);
        const loaded = store.load();
        assert.ok(loaded);
        assert.equal(loaded!.planId, 'plan-42');
        assert.equal(loaded!.ops.length, 2);
        assert.equal(loaded!.ops[0].deleted, 47);
        assert.equal(loaded!.ops[0].status, 'in_progress');
    });
});

test('save() stamps lastCheckpointAt with current time', async () => {
    await withTmpLoreDir(async loreDir => {
        const store = new CheckpointStore(loreDir);
        const state = exampleState();
        const before = Date.now();
        store.save(state);
        const after = Date.now();
        const loaded = store.load();
        const ts = new Date(loaded!.lastCheckpointAt).getTime();
        assert.ok(ts >= before && ts <= after,
            `lastCheckpointAt ${loaded!.lastCheckpointAt} should be between ${new Date(before).toISOString()} and ${new Date(after).toISOString()}`);
    });
});

test('save() creates the migrations/ directory if missing', async () => {
    await withTmpLoreDir(async loreDir => {
        const store = new CheckpointStore(loreDir);
        // loreDir doesn't exist yet — save must mkdir -p.
        store.save(exampleState());
        assert.ok(fs.existsSync(path.join(loreDir, 'migrations')));
        assert.ok(fs.existsSync(store.path()));
    });
});

test('clear() removes the file; no-op if absent', async () => {
    await withTmpLoreDir(async loreDir => {
        const store = new CheckpointStore(loreDir);
        store.save(exampleState());
        assert.ok(fs.existsSync(store.path()));
        store.clear();
        assert.equal(fs.existsSync(store.path()), false);
        // Second clear is a no-op.
        store.clear();
    });
});

test('load() returns null + does not throw on corrupt JSON', async () => {
    await withTmpLoreDir(async loreDir => {
        const store = new CheckpointStore(loreDir);
        fs.mkdirSync(path.dirname(store.path()), { recursive: true });
        fs.writeFileSync(store.path(), '{not json', 'utf-8');
        assert.equal(store.load(), null);
    });
});

test('load() returns null when the file has the wrong shape', async () => {
    await withTmpLoreDir(async loreDir => {
        const store = new CheckpointStore(loreDir);
        fs.mkdirSync(path.dirname(store.path()), { recursive: true });
        fs.writeFileSync(store.path(), JSON.stringify({ something: 'else' }), 'utf-8');
        assert.equal(store.load(), null);
    });
});

test('save() is atomic — no .tmp leftovers visible after success', async () => {
    await withTmpLoreDir(async loreDir => {
        const store = new CheckpointStore(loreDir);
        store.save(exampleState());
        const filesInDir = fs.readdirSync(path.dirname(store.path()));
        const tmpLeftovers = filesInDir.filter(f => f.includes('.tmp.'));
        assert.equal(tmpLeftovers.length, 0, `unexpected tmp files: ${tmpLeftovers.join(', ')}`);
    });
});

test('save() overwrites prior state on subsequent calls', async () => {
    await withTmpLoreDir(async loreDir => {
        const store = new CheckpointStore(loreDir);
        store.save(exampleState());
        const updated = exampleState();
        updated.ops[0].status = 'completed';
        updated.ops[0].deleted = 100;
        store.save(updated);
        const loaded = store.load();
        assert.equal(loaded!.ops[0].status, 'completed');
        assert.equal(loaded!.ops[0].deleted, 100);
    });
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
