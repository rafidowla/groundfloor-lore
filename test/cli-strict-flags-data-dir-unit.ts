#!/usr/bin/env tsx
/**
 * cli-strict-flags-data-dir-unit.ts — end-to-end (spawned real CLI) coverage
 * for the strict-flag + --data-dir hardening.
 *
 * Incident: `env -u LORE_HOME lore migrate-graph default --to sqlite --data-dir
 * <copy>` ignored the unsupported `--data-dir`, fell back to ~/.groundfloor and
 * migrated the REAL `default` workspace. Here a "real home" stand-in is set as
 * LORE_HOME with its own `default` workspace and the test proves it stays
 * byte-identical while the `--data-dir` copy is the one that changes.
 *
 * Every home is a throwaway temp directory; nothing touches ~/.groundfloor.
 *
 * Run: npx tsx test/cli-strict-flags-data-dir-unit.ts
 */

import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadWorkspaces, setWorkspaceGraphEngine } from '../packages/lore/src/config/workspaces.js';
import { resolveWorkspaceGraphEngine } from '../packages/lore/src/engines/graphEngineSelector.js';
import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
const cliEntry = path.join(repoRoot, 'packages/lore/src/cli/index.ts');

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

async function freePort(): Promise<number> {
    return await new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const a = srv.address();
            const port = typeof a === 'object' && a ? a.port : 0;
            srv.close(() => resolve(port));
        });
    });
}
const port = await freePort(); // never 3847/3848

interface CliRun { status: number | null; stdout: string; stderr: string }
function runCli(args: string[], loreHome: string): CliRun {
    const r = spawnSync(tsxBin, [cliEntry, ...args], {
        env: { ...process.env, LORE_HOME: loreHome, LORE_PORT: String(port), LORE_MODEL_SERVER: '0' },
        encoding: 'utf-8',
        timeout: 120_000,
    });
    if (r.error) throw r.error;
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Stable digest of a whole directory tree (relative path + content). */
function treeDigest(root: string): string {
    const h = crypto.createHash('sha256');
    const walk = (dir: string): void => {
        for (const name of fs.readdirSync(dir).sort()) {
            const p = path.join(dir, name);
            const st = fs.lstatSync(p);
            h.update(path.relative(root, p) + '\0');
            if (st.isDirectory()) walk(p);
            else if (st.isFile()) h.update(fs.readFileSync(p));
        }
    };
    walk(root);
    return h.digest('hex');
}

function tmp(label: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), `lore-cli-strict-${label}-`));
}

/** A home whose `default` workspace is on surreal with one node. */
async function surrealHome(label: string): Promise<string> {
    const home = tmp(label);
    // loadWorkspaces() bootstraps the registry with its own `default` workspace.
    const entry = loadWorkspaces(home).workspaces.find((w) => w.name === 'default')!;
    setWorkspaceGraphEngine('default', 'surreal', home);
    const g = new SurrealGraph(entry.path, { workspaceId: 'default' });
    await g.initialize();
    await g.upsertNode({ id: 'n1', type: 'note', label: 'one', content: 'c', tags: [], project: '*', ecosystem: '*', metadata: '{}' } as never);
    await g.close();
    return home;
}

console.log('CLI strict flags + --data-dir (spawned CLI)');
console.log('='.repeat(72));

const realHome = await surrealHome('real');
const copyHome = await surrealHome('copy');
const realDigest0 = treeDigest(realHome);

await test('migrate-graph --data-dir migrates ONLY the copy; the LORE_HOME stand-in is byte-identical', () => {
    const r = runCli(['migrate-graph', 'default', '--to', 'sqlite', '--data-dir', copyHome], realHome);
    assert.equal(r.status, 0, `exit 0, got ${r.status}\n${r.stdout}\n${r.stderr}`);
    assert.ok(r.stdout.includes(copyHome), 'prints the resolved home');
    assert.ok(r.stdout.includes(path.join(copyHome, 'workspaces.json')), 'prints the registry path');
    assert.equal(resolveWorkspaceGraphEngine('default', copyHome), 'sqlite');
    assert.equal(resolveWorkspaceGraphEngine('default', realHome), 'surreal');
    assert.equal(treeDigest(realHome), realDigest0, 'real home untouched');
    assert.ok(fs.existsSync(path.join(copyHome, 'migrate-graph-backups')), 'backup lands under the data dir');
    assert.ok(!fs.existsSync(path.join(realHome, 'migrate-graph-backups')), 'no backup under the real home');
});

await test('migrate-graph --rollback --data-dir reverts only the copy', () => {
    const r = runCli(['migrate-graph', 'default', '--rollback', '--data-dir', copyHome], realHome);
    assert.equal(r.status, 0, `exit 0, got ${r.status}\n${r.stdout}\n${r.stderr}`);
    assert.ok(r.stdout.includes(copyHome));
    assert.equal(resolveWorkspaceGraphEngine('default', copyHome), 'surreal');
    assert.equal(treeDigest(realHome), realDigest0, 'real home untouched');
});

await test('flag order: `--to sqlite default` and `--data-dir=<path>` forms both work', () => {
    const r = runCli(['migrate-graph', '--to', 'sqlite', 'default', `--data-dir=${copyHome}`], realHome);
    assert.equal(r.status, 0, `exit 0, got ${r.status}\n${r.stdout}\n${r.stderr}`);
    assert.equal(resolveWorkspaceGraphEngine('default', copyHome), 'sqlite');
    assert.equal(treeDigest(realHome), realDigest0);
    const back = runCli(['migrate-graph', 'default', '--rollback', '--data-dir', copyHome], realHome);
    assert.equal(back.status, 0);
});

await test('unknown flag (typo of --data-dir) is a usage error and writes nothing anywhere', () => {
    const copyDigest = treeDigest(copyHome);
    const r = runCli(['migrate-graph', 'default', '--to', 'sqlite', '--data-dri', copyHome], realHome);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown flag --data-dri/);
    assert.equal(treeDigest(realHome), realDigest0, 'real home untouched');
    assert.equal(treeDigest(copyHome), copyDigest, 'copy untouched');
});

await test('missing flag value / extra positional / bad --to are usage errors', () => {
    for (const args of [
        ['migrate-graph', 'default', '--to'],
        ['migrate-graph', 'default', 'extra', '--to', 'sqlite'],
        ['migrate-graph', 'default', '--to', 'surreal'],
        ['migrate-graph', 'default', '--rollback', '--to', 'sqlite'],
        ['migrate-graph', '--to', 'sqlite'],
    ]) {
        const r = runCli(args, realHome);
        assert.equal(r.status, 1, `${args.join(' ')} → ${r.status}\n${r.stdout}${r.stderr}`);
    }
    assert.equal(treeDigest(realHome), realDigest0);
});

await test('registry path outside the data dir is refused, naming both paths', () => {
    const outside = tmp('copied-registry');
    fs.copyFileSync(path.join(realHome, 'workspaces.json'), path.join(outside, 'workspaces.json'));
    const entryPath = loadWorkspaces(realHome).workspaces.find((w) => w.name === 'default')!.path;
    const r = runCli(['migrate-graph', 'default', '--to', 'sqlite', '--data-dir', outside], realHome);
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes(entryPath), `names the registry path: ${r.stderr}`);
    assert.ok(r.stderr.includes(outside), 'names the data dir');
    assert.equal(treeDigest(realHome), realDigest0, 'real home untouched');
    assert.equal(resolveWorkspaceGraphEngine('default', realHome), 'surreal');
});

await test('--data-dir without a registry is refused and no workspaces.json is created', () => {
    const empty = tmp('empty');
    for (const args of [
        ['migrate-graph', 'default', '--to', 'sqlite', '--data-dir', empty],
        ['migrate-graph', 'default', '--rollback', '--data-dir', empty],
        ['migrate-vectors', 'default', '--to', 'sqlite', '--data-dir', empty],
    ]) {
        const r = runCli(args, realHome);
        assert.notEqual(r.status, 0, `${args.join(' ')}\n${r.stdout}${r.stderr}`);
        assert.match(r.stderr, /workspaces\.json/);
    }
    assert.deepEqual(fs.readdirSync(empty), [], 'nothing created in the empty data dir');
    assert.equal(treeDigest(realHome), realDigest0);
});

await test('--data-dir that does not exist is refused', () => {
    const missing = path.join(tmp('parent'), 'nope');
    const r = runCli(['migrate-graph', 'default', '--to', 'sqlite', '--data-dir', missing], realHome);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /does not exist/);
    assert.ok(!fs.existsSync(missing));
    assert.equal(treeDigest(realHome), realDigest0);
});

await test('migrate-vectors: --dryrun typo is refused (it must never run for real)', () => {
    const r = runCli(['migrate-vectors', 'default', '--to', 'sqlite', '--dryrun'], realHome);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown flag --dryrun/);
    assert.equal(treeDigest(realHome), realDigest0);
});

await test('migrate-vectors accepts --dedupe-identical / --stamp-from-config at parse time (usage lists them)', () => {
    const r = runCli(['migrate-vectors', 'default', '--bogus'], realHome);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--dedupe-identical/);
    assert.match(r.stderr, /--stamp-from-config/);
});

console.log('\nConverted commands reject unknown flags (exit non-zero, no work done)');
console.log('='.repeat(72));

const inert = tmp('inert');
const cases: Array<{ args: string[]; code: number }> = [
    { args: ['compact', 'ws', '--bogus'], code: 1 },
    { args: ['backup', '--bogus'], code: 1 },
    { args: ['restore', 'x.tgz', '--bogus'], code: 1 },
    { args: ['retention', 'list', '--bogus'], code: 1 },
    { args: ['maintain', '--bogus'], code: 1 },
    { args: ['maintain', 'storage', '--bogus'], code: 1 },
    { args: ['reconnect', '--bogus'], code: 1 },
    { args: ['reconsume', '--bogus'], code: 1 },
    { args: ['embed', 'reembed', '--bogus'], code: 1 },
    { args: ['outbox', 'drain-failed', '--bogus'], code: 1 },
    { args: ['outbox', 'requeue-dead', '--bogus'], code: 1 },
    { args: ['vectors', 'promote', 'ws', '--bogus'], code: 1 },
    { args: ['verbatim', 'reap', '--bogus'], code: 1 },
    { args: ['supersede', 'a', 'b', '--bogus'], code: 1 },
    { args: ['mark-stale', '--tags', 'x', '--bogus'], code: 1 },
    { args: ['snapshot', 'dir', '--output', 'o.html', '--bogus'], code: 1 },
    { args: ['workspaces', 'list', '--bogus'], code: 1 },
    { args: ['migrate', 'embedding-model', '--bogus'], code: 1 },
    { args: ['migrate', 'piece-vectors', '--bogus'], code: 1 },
    { args: ['migrate', 'v1-sqlite', '--bogus'], code: 1 },
    { args: ['migrate', 'list', '--bogus'], code: 2 },
    { args: ['migrate', 'apply', '--bogus'], code: 2 },
];
for (const c of cases) {
    await test(`lore ${c.args.join(' ')} → exit ${c.code}`, () => {
        const r = runCli(c.args, inert);
        assert.equal(r.status, c.code, `${r.status}\n${r.stdout}\n${r.stderr}`);
        assert.match(r.stderr, /unknown flag --bogus/);
        assert.ok(!fs.existsSync(path.join(inert, 'workspaces.json')), 'no registry bootstrapped');
    });
}

await test('converted commands still accept their documented flags (--help exits 0)', () => {
    for (const args of [['compact', '--help'], ['backup', '--help'], ['maintain', '--help'], ['outbox', 'drain-failed', '--help'], ['outbox', 'requeue-dead', '-h']]) {
        const r = runCli(args, inert);
        assert.equal(r.status, 0, `${args.join(' ')} → ${r.status}\n${r.stderr}`);
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
