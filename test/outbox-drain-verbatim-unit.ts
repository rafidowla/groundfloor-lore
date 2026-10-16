#!/usr/bin/env tsx
/**
 * outbox-drain-verbatim-unit.ts — Lore 3.35.0 (n): `lore outbox drain-failed` wires a
 * read-only verbatim content witness, prints per-row reasons grouped (dry-run included),
 * and supports --lore-dir.
 *
 * Drives the REAL CLI (child process, non-3847 port, temp home) against an embedded
 * `.lore/` directory holding a SQLite verbatim store and dead `verbatim.upsert` rows:
 *   - matching content hash   -> healed ('replicated')
 *   - different content       -> stays dead, reason substrate-content-stale printed
 *   - row absent from store   -> stays dead, reason substrate-missing-verbatim printed
 * Before 3.35.0 every one of them came back `content-witness-unwired`.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

import { SqliteOutboxStore } from '../packages/lore/src/outbox/sqliteStore.js';
import type { OutboxEntry } from '../packages/lore/src/outbox/types.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';
import { SqliteVerbatimStore } from './helpers/testVerbatimStore.js';
import { groupDetailsByReason, formatReasonGroups } from '../packages/lore/src/cli/commands/outboxDrainVerbatim.js';

const repoRoot = path.resolve(import.meta.dirname, '..');
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
const CLI = path.join(repoRoot, 'packages', 'lore', 'src', 'cli', 'index.ts');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'drain-verbatim-'));
process.env['LORE_HOME'] = HOME;

class DetEmbedder implements EmbeddingProvider {
    readonly dimension = 8; readonly modelId = 'drain-det'; readonly dtype = 'fp32';
    async initialize(): Promise<void> {}
    private v(t: string): number[] { const a = new Array(8).fill(0); for (let i = 0; i < t.length; i++) a[i % 8] += t.charCodeAt(i) / 128; return a; }
    async embed(t: string) { return this.v(t); }
    async embedQuery(t: string) { return this.v(t); }
    async embedDocument(t: string) { return this.v(t); }
}

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
    try { await fn(); console.log(`  ok   ${name}`); passed++; }
    catch (e) { console.error(`  FAIL ${name}\n       ${(e as Error).message}`); failed++; }
};

let seq = 0;
async function seedDead(store: SqliteOutboxStore, id: string, text: string): Promise<string> {
    const eid = `entry-${++seq}`;
    const now = new Date().toISOString();
    await store.record({
        id: eid, operation: 'verbatim.upsert', initiator: 'test', createdAt: now, updatedAt: now,
        steps: [], completed: false, workspace: 'w', operationKind: 'verbatim.upsert',
        payload: { id, text, metadata: {} }, status: 'pending', attempts: 0,
    } as OutboxEntry);
    const error = 'boom';
    await store.markEntryStatus(eid, 'failed', { error, bumpAttempt: true });
    await store.markEntryStatus(eid, 'dead', { error, bumpAttempt: true });
    return eid;
}

function cli(args: string[]): { code: number | null; out: string; err: string } {
    const r = spawnSync(tsxBin, [CLI, 'outbox', 'drain-failed', ...args], {
        encoding: 'utf-8', timeout: 180_000,
        env: { ...process.env, LORE_HOME: HOME, LORE_PORT: '39878' },
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
}

(async () => {
    console.log('outbox drain-failed verbatim resolver (3.35.0 n)');

    await test('pure helpers: details group by reason with counts and capped ids', () => {
        const details = [
            ...Array.from({ length: 7 }, (_, i) => ({ id: `s${i}`, reason: 'substrate-content-stale', verified: false })),
            { id: 'ok1', reason: 'substrate-content-matches', verified: true },
        ];
        const g = groupDetailsByReason(details, 3);
        assert.equal(g[0]!.reason, 'substrate-content-stale');
        assert.equal(g[0]!.count, 7);
        assert.equal(g[0]!.ids.length, 3);
        assert.equal(g[0]!.more, 4);
        assert.ok(formatReasonGroups(details, 3).join('\n').includes('+4 more'));
        assert.deepEqual(formatReasonGroups([]), []);
    });

    const base = fs.mkdtempSync(path.join(HOME, 'embedded-'));
    const loreDir = path.join(base, '.lore');
    fs.mkdirSync(loreDir, { recursive: true });
    const vstore = new SqliteVerbatimStore(base, new DetEmbedder());
    await vstore.initialize();
    await vstore.store({ id: 'lore:w:ok', text: 'hello world', metadata: { updatedAt: '2026-10-01T00:00:00.000Z' } });
    await vstore.store({ id: 'lore:w:changed', text: 'stored text', metadata: { updatedAt: '2026-10-01T00:00:00.000Z' } });
    await vstore.close();

    const outbox = new SqliteOutboxStore(loreDir);
    const healId = await seedDead(outbox, 'lore:w:ok', 'hello world');
    const staleId = await seedDead(outbox, 'lore:w:changed', 'a newer edit that never landed');
    const missingId = await seedDead(outbox, 'lore:w:missing', 'never stored');
    const statusOf = async (id: string) => {
        const all = await outbox.listUnfinished();
        const e = all.find((x) => x.id === id);
        return e ? e.status : 'replicated';
    };

    await test('--dry-run --lore-dir prints grouped reasons and writes nothing', async () => {
        const r = cli(['--lore-dir', loreDir, '--dry-run']);
        assert.equal(r.code, 0, r.err + r.out);
        assert.match(r.out, /by reason/);
        assert.match(r.out, /recovered: substrate-content-matches/);
        assert.match(r.out, /left: substrate-content-stale/);
        assert.match(r.out, /left: substrate-missing-verbatim/);
        assert.doesNotMatch(r.out, /content-witness-unwired/);
        assert.match(r.out, /recovered:\s+1/);
        assert.equal(await statusOf(healId), 'dead', 'dry run changed nothing');
    });

    await test('real run heals the matching-hash row; mismatched and absent rows stay dead with reasons printed', async () => {
        const r = cli(['--lore-dir', loreDir]);
        assert.equal(r.code, 0, r.err + r.out);
        assert.match(r.out, /recovered:\s+1/);
        assert.match(r.out, /substrate-content-stale/);
        assert.equal(await statusOf(healId), 'replicated');
        assert.equal(await statusOf(staleId), 'dead');
        assert.equal(await statusOf(missingId), 'dead');
    });

    await test('the verbatim store was only read: its row count and text are unchanged', async () => {
        const s = new SqliteVerbatimStore(base, new DetEmbedder());
        await s.initialize();
        try {
            assert.equal((await s.getById('lore:w:changed'))?.text, 'stored text');
            assert.equal((await s.getHistory('lore:w:changed')).length, 1);
            assert.equal(await s.getById('lore:w:missing'), null);
        } finally { await s.close(); }
    });

    await test('help text documents --lore-dir and the verbatim witness', () => {
        const r = cli(['--help']);
        assert.match(r.out + r.err, /--lore-dir/);
        assert.match(r.out + r.err, /content\s+hash/i);
    });

    try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
})();
