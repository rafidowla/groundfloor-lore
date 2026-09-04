#!/usr/bin/env tsx
/**
 * test/backup-unit.ts — coordinated workspace backup (gap #12).
 *
 * Builds a fake workspace dir with a legacy-shaped file + a real
 * SQLite file + a LanceDB-shaped directory + sidecar JSON, runs the
 * backup, and asserts:
 *   - tarball is produced and non-empty
 *   - tarball contains the substrate files (verifiable via `tar -tzf`)
 *   - manifest is included with the file list
 *   - missing workspace dir throws
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';

import { backupWorkspace, tarGzip } from '../packages/lore/src/engines/backup.js';

let passed = 0;
let failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void>) {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
    })());
}

function makeFakeWorkspace(): { wsDir: string; outDir: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-backup-test-'));
    const wsDir = path.join(dir, 'workspace');
    const loreDir = path.join(wsDir, '.lore');
    const outDir = path.join(dir, 'out');
    fs.mkdirSync(loreDir, { recursive: true });
    fs.mkdirSync(outDir, { recursive: true });

    // legacy-shaped graph file (just a placeholder; backup doesn't parse).
    fs.writeFileSync(path.join(loreDir, 'graph'), 'fake-legacy-engine-bytes');
    fs.writeFileSync(path.join(loreDir, 'graph.wal'), 'fake-wal');

    // Real SQLite file with one row so the online backup has work to do.
    const db = new Database(path.join(loreDir, 'tables.sqlite'));
    db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)`);
    db.prepare(`INSERT INTO t (id, v) VALUES (?, ?)`).run(1, 'hello');
    db.close();

    // LanceDB-shaped dir.
    fs.mkdirSync(path.join(loreDir, 'lancedb', 'lore_verbatim.lance'), { recursive: true });
    fs.writeFileSync(path.join(loreDir, 'lancedb', 'lore_verbatim.lance', 'data.bin'), 'fake-lance');

    // Sidecar.
    fs.writeFileSync(path.join(loreDir, 'config.json'), '{"k":"v"}');

    return {
        wsDir, outDir,
        cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } },
    };
}

async function tarList(tarball: string): Promise<string[]> {
    return new Promise<string[]>((resolve, reject) => {
        const proc = spawn('tar', ['-tzf', tarball]);
        const chunks: Buffer[] = [];
        proc.stdout.on('data', (d) => chunks.push(d));
        proc.on('exit', (code) => {
            if (code !== 0) return reject(new Error(`tar -tzf exit ${code}`));
            resolve(Buffer.concat(chunks).toString('utf-8').split('\n').filter(Boolean));
        });
        proc.on('error', reject);
    });
}

console.log('workspace backup');

test('produces a non-empty tarball with all three substrate files', async () => {
    const fix = makeFakeWorkspace();
    try {
        const result = await backupWorkspace({
            workspaceDir: fix.wsDir,
            workspaceName: 'test-ws',
            outDir: fix.outDir,
        });
        assert.ok(fs.existsSync(result.tarballPath), 'tarball file exists');
        assert.ok(result.bytesWritten > 0, 'tarball is non-empty');
        assert.match(path.basename(result.tarballPath), /^lore-backup-test-ws-/);

        const entries = await tarList(result.tarballPath);
        assert.ok(entries.some(e => e.endsWith('.lore/graph')), 'legacy graph-engine file in tarball');
        assert.ok(entries.some(e => e.endsWith('.lore/graph.wal')), 'legacy graph-engine WAL in tarball');
        assert.ok(entries.some(e => e.endsWith('.lore/tables.sqlite')), 'sqlite in tarball');
        assert.ok(entries.some(e => e.includes('.lore/lancedb')), 'lancedb in tarball');
        assert.ok(entries.some(e => e.endsWith('.lore/config.json')), 'sidecar in tarball');
        assert.ok(entries.some(e => e.endsWith('backup-manifest.json')), 'manifest in tarball');
    } finally { fix.cleanup(); }
});

test('result.files lists the staged substrate entries', async () => {
    const fix = makeFakeWorkspace();
    try {
        const result = await backupWorkspace({
            workspaceDir: fix.wsDir, workspaceName: 'ws', outDir: fix.outDir,
        });
        assert.ok(result.files.includes('graph'));
        assert.ok(result.files.includes('graph.wal'));
        assert.ok(result.files.includes('tables.sqlite'));
        assert.ok(result.files.includes('lancedb/'));
        assert.ok(result.files.includes('config.json'));
    } finally { fix.cleanup(); }
});

test('throws when workspace dir is missing', async () => {
    const fix = makeFakeWorkspace();
    try {
        await assert.rejects(
            () => backupWorkspace({
                workspaceDir: '/nonexistent/path',
                workspaceName: 'ws', outDir: fix.outDir,
            }),
            /workspace dir not found/,
        );
    } finally { fix.cleanup(); }
});

test('throws when workspace has no .lore/', async () => {
    const fix = makeFakeWorkspace();
    try {
        fs.rmSync(path.join(fix.wsDir, '.lore'), { recursive: true });
        await assert.rejects(
            () => backupWorkspace({
                workspaceDir: fix.wsDir, workspaceName: 'ws', outDir: fix.outDir,
            }),
            /no \.lore\/ directory/,
        );
    } finally { fix.cleanup(); }
});

// L-005 regression: a non-zero `tar -c` exit during compression must surface
// as a rejection, not be masked as success by the write-stream `finish` event.
// We drive tarGzip directly with a fake `tar` binary that writes a few bytes to
// stdout (so the gzip/write pipeline flushes + emits `finish`) and then exits 1.
// Before the fix the `finish` resolve raced ahead and tarGzip "succeeded" with a
// truncated archive; after the fix tarGzip rejects with /tar exited with code/.
// Injecting the binary via the param (not global PATH) keeps the concurrently
// running happy-path tests isolated.
test('tarGzip rejects when the tar compression process exits non-zero', async () => {
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-fake-tar-'));
    const fakeTar = path.join(shimDir, 'fake-tar');
    fs.writeFileSync(fakeTar, '#!/bin/sh\nprintf "partial archive bytes"\nexit 1\n');
    fs.chmodSync(fakeTar, 0o755);
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-tar-src-'));
    const outFile = path.join(shimDir, 'out.tar.gz');
    try {
        await assert.rejects(
            () => tarGzip(srcDir, outFile, fakeTar),
            /tar exited with code/,
            'non-zero tar -c exit must reject, not resolve on stream finish',
        );
    } finally {
        try { fs.rmSync(shimDir, { recursive: true, force: true }); } catch { /* */ }
        try { fs.rmSync(srcDir, { recursive: true, force: true }); } catch { /* */ }
    }
});

// L-005 happy path: tarGzip with a real `tar` resolves and writes a tarball
// (pins that the dual-gate still settles on success).
test('tarGzip resolves and produces a tarball on a clean run', async () => {
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-tar-ok-src-'));
    const outFile = path.join(srcDir, '..', `ok-${Date.now()}.tar.gz`);
    fs.writeFileSync(path.join(srcDir, 'a.txt'), 'hello');
    try {
        await tarGzip(srcDir, outFile);
        assert.ok(fs.existsSync(outFile), 'tarball produced on clean run');
        assert.ok(fs.statSync(outFile).size > 0, 'tarball non-empty');
    } finally {
        try { fs.rmSync(srcDir, { recursive: true, force: true }); } catch { /* */ }
        try { fs.rmSync(outFile, { force: true }); } catch { /* */ }
    }
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
