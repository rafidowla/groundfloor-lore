#!/usr/bin/env tsx
/**
 * test/chaos/backup-restore-roundtrip.ts — proves that a backup
 * tarball restores into byte-identical (or close-to-identical)
 * substrate state.
 *
 * Scenario: workspace has a real SQLite file with rows, a fake
 * the legacy graph engine graph file, a fake LanceDB directory + a config sidecar.
 * Take a backup. Wipe the workspace. Restore from the tarball.
 * Verify: SQLite rows are queryable, files are present, sidelined-
 * prior-state path is correctly null (since we wiped).
 *
 * Then: do a NON-empty restore (workspace already has data).
 * Verify the prior .lore/ got sidelined and the restored data is
 * authoritative.
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';

import { backupWorkspace } from '../../packages/lore/src/engines/backup.js';
import { restoreWorkspace } from '../../packages/lore/src/engines/restore.js';

let passed = 0;
let failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void>) {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
    })());
}

function makeWorkspace(name: string, rows: Array<{ id: number; v: string }>): { wsDir: string; outDir: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lore-chaos-bk-${name}-`));
    const wsDir = path.join(dir, 'workspace');
    const loreDir = path.join(wsDir, '.lore');
    const outDir = path.join(dir, 'out');
    fs.mkdirSync(loreDir, { recursive: true });
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(loreDir, 'graph'), 'the legacy graph engine-bytes');
    fs.writeFileSync(path.join(loreDir, 'graph.wal'), 'wal');
    const db = new Database(path.join(loreDir, 'tables.sqlite'));
    db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)`);
    const stmt = db.prepare(`INSERT INTO t (id, v) VALUES (?, ?)`);
    for (const r of rows) stmt.run(r.id, r.v);
    db.close();
    fs.mkdirSync(path.join(loreDir, 'lancedb', 'lore_verbatim.lance'), { recursive: true });
    fs.writeFileSync(path.join(loreDir, 'lancedb', 'lore_verbatim.lance', 'data.bin'), 'lance');
    fs.writeFileSync(path.join(loreDir, 'config.json'), '{"k":"v"}');
    return {
        wsDir, outDir,
        cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } },
    };
}

console.log('chaos: backup → restore round-trip');

test('backup then restore into a wiped workspace yields the same SQLite rows', async () => {
    const fix = makeWorkspace('roundtrip', [
        { id: 1, v: 'alpha' }, { id: 2, v: 'beta' }, { id: 3, v: 'gamma' },
    ]);
    try {
        // Backup.
        const bk = await backupWorkspace({
            workspaceDir: fix.wsDir, workspaceName: 'rt', outDir: fix.outDir,
        });
        assert.ok(bk.bytesWritten > 0);

        // Wipe the workspace's .lore/ entirely.
        fs.rmSync(path.join(fix.wsDir, '.lore'), { recursive: true });
        assert.ok(!fs.existsSync(path.join(fix.wsDir, '.lore')));

        // Restore.
        const rs = await restoreWorkspace({
            tarballPath: bk.tarballPath,
            workspaceDir: fix.wsDir,
        });
        assert.equal(rs.sidelinedPriorTo, null, 'no prior state, nothing sidelined');
        assert.ok(rs.bytesRestored > 0);

        // Verify SQLite rows survived.
        const db = new Database(path.join(fix.wsDir, '.lore', 'tables.sqlite'), { readonly: true });
        const rows = db.prepare('SELECT id, v FROM t ORDER BY id').all() as Array<{ id: number; v: string }>;
        db.close();
        assert.deepEqual(rows, [
            { id: 1, v: 'alpha' }, { id: 2, v: 'beta' }, { id: 3, v: 'gamma' },
        ]);

        // Verify other substrate files came back.
        assert.ok(fs.existsSync(path.join(fix.wsDir, '.lore', 'graph')));
        assert.ok(fs.existsSync(path.join(fix.wsDir, '.lore', 'lancedb')));
        assert.ok(fs.existsSync(path.join(fix.wsDir, '.lore', 'config.json')));
    } finally { fix.cleanup(); }
});

test('restore into a NON-empty workspace sidelines the prior .lore/', async () => {
    const fix = makeWorkspace('sideline', [{ id: 1, v: 'old-snapshot' }]);
    try {
        const bk = await backupWorkspace({
            workspaceDir: fix.wsDir, workspaceName: 'sd', outDir: fix.outDir,
        });
        // Mutate the live workspace BETWEEN backup and restore so we
        // can prove the restored state, not the live one, is what wins.
        const live = new Database(path.join(fix.wsDir, '.lore', 'tables.sqlite'));
        live.exec('UPDATE t SET v = \'mutated\' WHERE id = 1');
        live.close();

        const rs = await restoreWorkspace({
            tarballPath: bk.tarballPath,
            workspaceDir: fix.wsDir,
        });
        assert.ok(rs.sidelinedPriorTo, 'prior state sidelined');
        assert.ok(fs.existsSync(rs.sidelinedPriorTo!), 'sideline path exists');

        // Verify restored state, not mutated state.
        const db = new Database(path.join(fix.wsDir, '.lore', 'tables.sqlite'), { readonly: true });
        const row = db.prepare('SELECT v FROM t WHERE id = 1').get() as { v: string };
        db.close();
        assert.equal(row.v, 'old-snapshot', 'restore overrode the mutation');
    } finally { fix.cleanup(); }
});

test('restore from a tarball missing .lore/ is refused', async () => {
    const fix = makeWorkspace('badtar', []);
    try {
        // Build a tarball that has nothing useful in it.
        const badTar = path.join(fix.outDir, 'fake.tar.gz');
        // Create one with manifest but no .lore — use real tar via the
        // backup module would be circular. Just create something
        // syntactically valid that lacks .lore.
        const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-'));
        fs.writeFileSync(path.join(emptyDir, 'notes.txt'), 'not a backup');
        const { spawn } = await import('node:child_process');
        await new Promise<void>((resolve, reject) => {
            const p = spawn('tar', ['-c', '-z', '-f', badTar, '-C', emptyDir, '.']);
            p.on('exit', c => c === 0 ? resolve() : reject(new Error(`tar ${c}`)));
        });
        fs.rmSync(emptyDir, { recursive: true });

        await assert.rejects(
            () => restoreWorkspace({ tarballPath: badTar, workspaceDir: fix.wsDir }),
            /missing \.lore\/.*not a Lore backup/i,
        );
    } finally { fix.cleanup(); }
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
