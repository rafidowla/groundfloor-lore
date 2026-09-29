#!/usr/bin/env tsx
/**
 * test/version-history-optin-reclaim.ts — the offline reclaim
 * (`reclaimStorage()` / `lore maintain storage`) never deletes version
 * history unless explicitly asked (owner decision 2026-09-29).
 *
 *   C1  default run: dedupes exact duplicates + VACUUMs, deletes NO
 *       non-duplicate row (10y / 5y / 100d / 1d / skip-type rows all kept)
 *   C2  --prune-older-than <days>: only then are rows past it deleted
 *   C3  --skip-types: only then are existing rows of those types dropped;
 *       nothing is deleted by age
 *   C4  --prune-older-than + versionHistory.retentionDaysByType overrides per type;
 *       retentionDaysByType alone (no age flag) deletes nothing
 *   C5  dry-run reports the same counts and deletes nothing
 *   C6  invalid --prune-older-than is rejected before any file is touched
 *   C7  the CLI wrapper (`lore maintain storage`): flag parsing + --help text
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { reclaimStorage } from '../packages/lore/src/outbox/reclaimStorage.js';
import { resolveLoreHome } from '../packages/lore/src/config/loreHome.js';
import { VersionStore } from '../packages/lore/src/outbox/versionStore.js';
import { maintainStorageCommand } from '../packages/lore/src/cli/commands/maintainStorage.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
}

const DAY = 86_400_000;
type Row = { node: string; type: string; days: number };
const ROWS: Row[] = [
    { node: 'ten', type: 'note', days: 3650 },
    { node: 'five', type: 'note', days: 1825 },
    { node: 'hundred', type: 'note', days: 100 },
    { node: 'one', type: 'note', days: 1 },
    { node: 'sym-old', type: 'code_symbol', days: 400 },
    { node: 'sym-new', type: 'code_symbol', days: 1 },
];
const NODES = ROWS.map((r) => r.node).sort();

let counter = 0;
/** Fresh data root: one row per ROWS entry plus ONE exact duplicate pair. */
function makeRoot(): { dataDir: string; loreDir: string } {
    const dataDir = path.join(process.env.LORE_HOME!, `root-${counter++}`);
    const loreDir = path.join(resolveLoreHome({ dataDir }), '.lore');
    fs.mkdirSync(loreDir, { recursive: true });
    const s = VersionStore.open(loreDir);
    for (const r of ROWS) {
        s.recordVersion({
            versionId: randomUUID(), nodeId: r.node, workspace: 'default',
            timestamp: new Date(Date.now() - r.days * DAY).toISOString(),
            principal: 'test', operation: 'upsert', previousState: null,
            newState: { type: r.type, content: `content-${r.node}-` + 'x'.repeat(4000) }, changesetId: null,
        });
    }
    // Exact no-op duplicate of the 'one' row (same content, later timestamp).
    s.recordVersion({
        versionId: randomUUID(), nodeId: 'dup', workspace: 'default',
        timestamp: new Date(Date.now() - 2 * DAY).toISOString(),
        principal: 'test', operation: 'upsert', previousState: null,
        newState: { type: 'note', content: 'dup' }, changesetId: null,
    });
    s.recordVersion({
        versionId: randomUUID(), nodeId: 'dup', workspace: 'default',
        timestamp: new Date(Date.now() - 1 * DAY).toISOString(),
        principal: 'test', operation: 'upsert', previousState: { type: 'note', content: 'dup' }, newState: { type: 'note', content: 'dup' }, changesetId: null,
    });
    s.close();
    return { dataDir, loreDir };
}
function surviving(loreDir: string): string[] {
    const s = VersionStore.open(loreDir);
    try { return ROWS.map((r) => r.node).filter((n) => s.getVersions(n, 'default', 10).length > 0).sort(); }
    finally { s.close(); }
}
function dupRows(loreDir: string): number {
    const s = VersionStore.open(loreDir);
    try { return s.getVersions('dup', 'default', 10).length; } finally { s.close(); }
}
const vFile = (r: Awaited<ReturnType<typeof reclaimStorage>>) => r.files.find((f) => f.file === 'versions.sqlite')!;

console.log('\nOffline reclaim — version deletion is opt-in\n');

await test('C1: default run dedupes the duplicate but deletes no non-duplicate version row', async () => {
    const { dataDir, loreDir } = makeRoot();
    assert.equal(dupRows(loreDir), 2);
    const r = await reclaimStorage({ dataDir });
    assert.equal(vFile(r).dedupedRows, 1);
    assert.equal(vFile(r).softCompactedRows, 0);
    assert.equal(vFile(r).hardDeletedRows, 0);
    assert.deepEqual(surviving(loreDir), NODES, 'every row (10y, 5y, 100d, 1d, skip-type) must survive a default reclaim');
    assert.equal(dupRows(loreDir), 1, 'the exact duplicate is deduped');
    assert.equal(vFile(r).autoVacuumAfter, 2, 'VACUUM/incremental conversion still ran');
});

await test('C2: --prune-older-than deletes rows past it (any type), and only then', async () => {
    const { dataDir, loreDir } = makeRoot();
    const r = await reclaimStorage({ dataDir, pruneOlderThanDays: 30 });
    assert.deepEqual(surviving(loreDir), ['one', 'sym-new']);
    assert.equal(vFile(r).softCompactedRows, 4);
    assert.equal(vFile(r).hardDeletedRows, 4);
});

await test('C3: --skip-types drops existing rows of that type only; nothing is deleted by age', async () => {
    const { dataDir, loreDir } = makeRoot();
    const r = await reclaimStorage({ dataDir, skipTypes: ['code_symbol'] });
    assert.deepEqual(surviving(loreDir), ['five', 'hundred', 'ten', 'one'].sort());
    assert.equal(vFile(r).softCompactedRows, 2);
});

await test('C4: retentionDaysByType applies only together with pruneOlderThanDays', async () => {
    const a = makeRoot();
    await reclaimStorage({ dataDir: a.dataDir, versionHistory: { retentionDaysByType: { note: 5 } } });
    assert.deepEqual(surviving(a.loreDir), NODES, 'retentionDaysByType alone is inert in the reclaim tool');
    const b = makeRoot();
    await reclaimStorage({ dataDir: b.dataDir, pruneOlderThanDays: 5000, versionHistory: { retentionDaysByType: { note: 5 } } });
    assert.deepEqual(surviving(b.loreDir), ['one', 'sym-new', 'sym-old'].sort(), "notes older than 5d go; code_symbol rows follow the 5000-day default");
});

await test('C5: dry-run with --prune-older-than / --skip-types reports counts and deletes nothing', async () => {
    const { dataDir, loreDir } = makeRoot();
    const r = await reclaimStorage({ dataDir, dryRun: true, pruneOlderThanDays: 30, skipTypes: ['code_symbol'] });
    assert.equal(vFile(r).softCompactedRows, 5, 'four aged rows + the skip-type row not already aged (sym-new)');
    assert.deepEqual(surviving(loreDir), NODES);
    assert.equal(dupRows(loreDir), 2, 'dry-run also leaves the duplicate');
});

await test('C6: an invalid pruneOlderThanDays is rejected before anything is touched', async () => {
    const { dataDir, loreDir } = makeRoot();
    for (const bad of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
        await assert.rejects(() => reclaimStorage({ dataDir, pruneOlderThanDays: bad }), /pruneOlderThanDays/);
    }
    assert.deepEqual(surviving(loreDir), NODES);
    assert.equal(dupRows(loreDir), 2);
});

await test('C7: `lore maintain storage` CLI — --help documents the opt-ins; default run deletes no rows; flags work', async () => {
    const logs: string[] = [];
    const origLog = console.log;
    const capture = async (args: string[]): Promise<string> => {
        logs.length = 0;
        console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
        try { await maintainStorageCommand(args); } finally { console.log = origLog; }
        return logs.join('\n');
    };
    const help = await capture(['--help']);
    assert.match(help, /--prune-older-than <days>/);
    assert.match(help, /NEVER deletes version\s+history by age or by type unless you ask/);
    assert.match(help, /--skip-types <csv>/);
    assert.doesNotMatch(help, /applies version-history retention/, 'the old always-prune wording must be gone');

    const a = makeRoot();
    await capture(['--data-dir', a.dataDir, '--json']);
    assert.deepEqual(surviving(a.loreDir), NODES, 'default CLI run deletes no version row');

    const b = makeRoot();
    const json = JSON.parse(await capture(['--data-dir', b.dataDir, '--prune-older-than', '30', '--json']));
    assert.equal(json.files.find((f: { file: string }) => f.file === 'versions.sqlite').softCompactedRows, 4);
    assert.deepEqual(surviving(b.loreDir), ['one', 'sym-new']);

    const c = makeRoot();
    await capture([`--data-dir=${c.dataDir}`, '--skip-types=code_symbol', '--json']);
    assert.deepEqual(surviving(c.loreDir), ['five', 'hundred', 'ten', 'one'].sort());
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
