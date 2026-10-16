#!/usr/bin/env tsx
/**
 * surreal-path-visibility-unit.ts — 3.35.0: the Surreal store's URL-escaped
 * location is made visible, and `migrate-graph` refuses a live holder.
 *
 * `surrealDataPath()` URL-normalises the path, so a home under a directory with
 * a space keeps its Surreal store at the literal sibling `…/My%20Dir/.lore/surreal`.
 * Behaviour is unchanged (moving existing stores would strand data); these tests
 * pin the VISIBILITY fixes and the live-holder preflight:
 *
 *   (g) a `warn` line per open naming both paths — only when they differ;
 *   (h) `lore status` prints the path actually used;
 *   (i) MCP `stats.graphPath` reports the engine's real store path;
 *   (j) `migrate-graph` (and `openGraphForCli`) read `<store>/LOCK`, and refuse
 *       a live holder BEFORE any backup is written.
 *
 * The holder is a real child process with a real SurrealGraph open (so the LOCK
 * format is observed, not assumed). The CLI cases drive the real entry point
 * (`cli/index.ts`, the same dispatcher `dist/lore/src/cli/index.js` ships).
 *
 * Run: npx tsx test/surreal-path-visibility-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createWorkspace, setWorkspaceGraphEngine } from '../packages/lore/src/config/workspaces.js';
import { LocalGraphRegistry } from '../packages/lore/src/engines/localGraphRegistry.js';
import { migrateGraphToSqlite } from '../packages/lore/src/engines/migrateGraphToSqlite.js';
import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import { SqliteGraph } from '../packages/lore/src/engines/sqliteGraph.js';
import { surrealDataPath, relocatedSurrealPath } from '../packages/lore/src/engines/surreal/surrealConnection.js';
import { findLiveSurrealStoreHolder } from '../packages/lore/src/cli/commands/migrateWorkspaceToWorkspaceShared.js';
import { openGraphForCli, CliDaemonLockError } from '../packages/lore/src/cli/commands/shared.js';
import { registerDiagnosticTools } from '../packages/lore/src/mcp/tools/diagnostic.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const selfPath = fileURLToPath(import.meta.url);
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
const cliEntry = path.join(repoRoot, 'packages/lore/src/cli/index.ts');

/* ───────────────────────── child roles ───────────────────────── */

const role = process.argv[2];
if (role === '--holder' || role === '--seed') {
    const base = process.argv[3]!;
    const g = new SurrealGraph(base, { workspaceId: process.argv[4], cacheDisabled: true });
    await g.initialize();
    if (role === '--seed') {
        for (const id of ['n1', 'n2', 'n3']) {
            await g.upsertNode({ id, type: 'note', label: id, content: `body ${id}`, tags: [], project: '*', ecosystem: '*', metadata: '{}' } as never);
        }
        await g.close();
        process.exit(0);
    }
    process.stdout.write('READY\n');
    let open = true;
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', async (chunk: string) => {
        if (open && chunk.includes('close')) {
            open = false;
            await g.close();
            process.stdout.write('CLOSED\n');
        }
    });
    process.stdin.on('end', async () => {
        if (open) await g.close().catch(() => undefined);
        process.exit(0);
    });
    await new Promise(() => undefined);
}

/* ───────────────────────── harness ───────────────────────── */

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

const roots: string[] = [];
const children: ChildProcess[] = [];
/** A fresh root whose path contains a space (an ANCESTOR of the home, like "Application Support"). */
function spacedRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lore sp ace-'));
    roots.push(root);
    return root;
}
function plainRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-plain-'));
    roots.push(root);
    return root;
}

async function freePort(): Promise<number> {
    return await new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const addr = srv.address();
            const port = typeof addr === 'object' && addr ? addr.port : 0;
            srv.close(() => resolve(port));
        });
    });
}

function runChild(args: string[], timeoutMs = 90_000): void {
    const r = spawnSync(tsxBin, [selfPath, ...args], { encoding: 'utf8', timeout: timeoutMs });
    assert.equal(r.status, 0, `child ${args[0]} failed:\n${r.stdout}\n${r.stderr}`);
}

/** Registry home with one surreal workspace, seeded with 3 nodes by a short-lived child (its pid is dead afterwards). */
function seededSurrealHome(name = 'wsx'): { home: string; wsDir: string; name: string } {
    const home = path.join(spacedRoot(), 'lore-home');
    fs.mkdirSync(home, { recursive: true });
    const entry = createWorkspace(name, {}, home);
    setWorkspaceGraphEngine(name, 'surreal', home);
    runChild(['--seed', entry.path, name]);
    return { home, wsDir: entry.path, name };
}

interface Holder { child: ChildProcess; pid: number; release(): Promise<void>; stop(): Promise<void> }
async function startHolder(wsDir: string, name: string): Promise<Holder> {
    const child = spawn(tsxBin, [selfPath, '--holder', wsDir, name], { stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child);
    let out = '';
    let err = '';
    child.stdout!.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr!.on('data', (d: Buffer) => { err += d.toString(); });
    const waitFor = async (token: string, ms: number): Promise<void> => {
        const deadline = Date.now() + ms;
        while (!out.includes(token)) {
            if (Date.now() > deadline) throw new Error(`holder never printed ${token}\nstdout:${out}\nstderr:${err}`);
            if (child.exitCode !== null) throw new Error(`holder exited early (${child.exitCode})\nstdout:${out}\nstderr:${err}`);
            await new Promise((r) => setTimeout(r, 50));
        }
    };
    await waitFor('READY', 60_000);
    // The pid that holds the store is the one written into LOCK, which the tests
    // below read — never assumed equal to child.pid (tsx may wrap the process).
    const lockPid = Number(fs.readFileSync(path.join(surrealDataPath(wsDir), 'LOCK'), 'utf8').trim());
    return {
        child,
        pid: lockPid,
        async release() { child.stdin!.write('close\n'); await waitFor('CLOSED', 15_000); },
        async stop() {
            if (child.exitCode === null) {
                const exited = new Promise<void>((r) => child.once('exit', () => r()));
                child.stdin!.end();
                await exited;
            }
        },
    };
}

function lsofWorks(): boolean {
    if (process.platform === 'win32') return false;
    if (process.platform === 'linux') return true;
    return spawnSync('lsof', ['-v'], { stdio: 'ignore' }).error === undefined;
}

async function captureStderr<T>(fn: () => Promise<T>): Promise<{ result: T; stderr: string }> {
    const orig = process.stderr.write.bind(process.stderr);
    let buf = '';
    (process.stderr as { write: unknown }).write = (chunk: string | Uint8Array): boolean => {
        buf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        return true;
    };
    try {
        const result = await fn();
        return { result, stderr: buf };
    } finally {
        (process.stderr as { write: unknown }).write = orig;
    }
}

console.log('SURREAL PATH VISIBILITY + MIGRATE-GRAPH LIVE-HOLDER PREFLIGHT — 3.35.0');
console.log('='.repeat(72));

/* ───────────────────────── (g) warn at open ───────────────────────── */

await test('relocatedSurrealPath: reports the divergence for a spaced path, null for a plain one', () => {
    const spaced = path.join(spacedRoot(), 'ws');
    const moved = relocatedSurrealPath(spaced);
    assert.ok(moved, 'a space in an ancestor must relocate the store');
    assert.equal(moved.literal, path.join(spaced, '.lore', 'surreal'));
    assert.ok(moved.actual.includes('%20'), moved.actual);
    assert.equal(relocatedSurrealPath(path.join(plainRoot(), 'ws')), null);
});

await test('(g) open under a spaced path logs ONE warn naming both paths', async () => {
    const base = path.join(spacedRoot(), 'ws');
    const g = new SurrealGraph(base, { cacheDisabled: true });
    const { stderr } = await captureStderr(async () => { await g.initialize(); });
    await g.close();
    const warns = stderr.split('\n').filter((l) => l.includes(' WARN ') && l.includes('[SurrealGraph]') && l.includes('literal'));
    assert.equal(warns.length, 1, `expected exactly one relocation warning, got ${warns.length}:\n${stderr}`);
    const line = warns[0]!;
    assert.ok(line.includes(surrealDataPath(base)), 'names the real (%20) path unredacted');
    assert.ok(line.includes(path.join(base, '.lore', 'surreal')), 'names the literal path unredacted');
    assert.ok(line.includes('migrate-graph') && line.includes('BACKUP_RESTORE.md'), 'points at the remedy');
});

await test('(g) open under a plain path logs NO relocation warning', async () => {
    const base = path.join(plainRoot(), 'ws');
    const g = new SurrealGraph(base, { cacheDisabled: true });
    const { stderr } = await captureStderr(async () => { await g.initialize(); });
    await g.close();
    assert.ok(!stderr.includes('literal'), `unexpected warning:\n${stderr}`);
});

/* ───────────────────────── (i) stats graphPath ───────────────────────── */

await test('(i) stats.graphPath reports the real store path per engine', async () => {
    const home = path.join(spacedRoot(), 'lore-home');
    fs.mkdirSync(home, { recursive: true });
    const sur = createWorkspace('sur-ws', {}, home);
    setWorkspaceGraphEngine('sur-ws', 'surreal', home);
    const sql = createWorkspace('sql-ws', {}, home);
    setWorkspaceGraphEngine('sql-ws', 'sqlite', home);
    const registry = new LocalGraphRegistry({ home, autoEvict: false });
    const tools = new Map<string, (a: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>>();
    registerDiagnosticTools({ tool(n: string, _d: string, _s: unknown, h: never) { tools.set(n, h); } } as unknown as McpServer, {
        store: { loreGraph: null, storageClient: { verbatimCount: async () => 0 } },
        detectedScope: { workspace: 'sur-ws', ecosystem: '*' },
        deploymentMode: 'local',
        // Boot-time path: deliberately NOT either workspace's own directory.
        graphBasePath: path.join(plainRoot(), 'boot'),
        graphRegistry: registry,
        nodeTypesEnum: { optional: () => ({ describe: () => ({}) }) },
    } as never);
    try {
        const stats = async (workspace: string): Promise<Record<string, unknown>> => {
            const out = await tools.get('stats')!({ workspace });
            assert.ok(!out.isError, out.content[0]?.text);
            return JSON.parse(out.content[0]!.text) as Record<string, unknown>;
        };
        const s1 = await stats('sur-ws');
        assert.equal(s1['graphPath'], surrealDataPath(sur.path));
        assert.ok(String(s1['graphPath']).includes('%20'), String(s1['graphPath']));
        const s2 = await stats('sql-ws');
        assert.equal(s2['graphPath'], path.join(sql.path, '.lore', 'graph.sqlite'));
    } finally {
        await registry.disposeAll();
    }
});

/* ───────────────────────── (j) LOCK helper ───────────────────────── */

await test('(j) findLiveSurrealStoreHolder: missing / garbage / own pid / dead pid → null', () => {
    const dir = path.join(plainRoot(), 'store');
    fs.mkdirSync(dir, { recursive: true });
    assert.equal(findLiveSurrealStoreHolder(dir), null, 'missing LOCK');
    for (const junk of ['', 'not-a-pid\n', '-5\n', '0\n', '12abc\n', '1e3\n']) {
        fs.writeFileSync(path.join(dir, 'LOCK'), junk);
        assert.equal(findLiveSurrealStoreHolder(dir), null, `unparsable LOCK ${JSON.stringify(junk)}`);
    }
    fs.writeFileSync(path.join(dir, 'LOCK'), `${process.pid}\n`);
    assert.equal(findLiveSurrealStoreHolder(dir), null, 'own pid');
    const dead = spawnSync(process.execPath, ['-e', '0']);
    fs.writeFileSync(path.join(dir, 'LOCK'), `${dead.pid}\n`);
    assert.equal(findLiveSurrealStoreHolder(dir), null, 'dead pid = stale lock');
});

await test('(j) findLiveSurrealStoreHolder: a real holder is found; after it closes the store it is not', async () => {
    const { wsDir, name } = seededSurrealHome();
    const holder = await startHolder(wsDir, name);
    try {
        const raw = fs.readFileSync(path.join(surrealDataPath(wsDir), 'LOCK'), 'utf8');
        assert.match(raw, /^\d+\n?$/, `LOCK format is "<pid>\\n": ${JSON.stringify(raw)}`);
        const found = findLiveSurrealStoreHolder(surrealDataPath(wsDir));
        assert.ok(found, 'live holder must be found');
        assert.equal(found.pid, holder.pid);
        assert.equal(found.lockPath, path.join(surrealDataPath(wsDir), 'LOCK'));
        if (lsofWorks()) {
            assert.equal(found.confirmedOpen, true, 'OS confirms the holder has LOCK open');
            // surrealkv leaves LOCK (with the pid) behind after close; the live pid alone must not refuse.
            await holder.release();
            const after = findLiveSurrealStoreHolder(surrealDataPath(wsDir));
            assert.ok(after === null || after.confirmedOpen === false, 'alive pid that closed the store is not a confirmed holder');
        }
    } finally {
        await holder.stop();
    }
    assert.equal(findLiveSurrealStoreHolder(surrealDataPath(wsDir)), null, 'exited holder = stale lock');
});

/* ───────────────────────── (j) migrateGraphToSqlite ───────────────────────── */

function tarballs(dir: string): string[] {
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.tar.gz')) : [];
}

await test('(j) migrateGraphToSqlite refuses a live holder BEFORE any backup is written', async () => {
    const { home, wsDir, name } = seededSurrealHome();
    const out = path.join(home, 'backups-out');
    fs.mkdirSync(out, { recursive: true });
    const holder = await startHolder(wsDir, name);
    try {
        const t0 = Date.now();
        await assert.rejects(
            migrateGraphToSqlite({ workspaceName: name, home, backupOutDir: out }),
            (err: Error) => {
                assert.ok(err.message.includes(`pid ${holder.pid}`), err.message);
                assert.ok(err.message.includes(path.join(surrealDataPath(wsDir), 'LOCK')), err.message);
                assert.ok(/uit the app/.test(err.message), err.message);
                return true;
            },
        );
        assert.ok(Date.now() - t0 < 10_000, `must refuse fast, took ${Date.now() - t0}ms`);
        assert.deepEqual(tarballs(out), [], 'no backup may be written for a refused migration');
        assert.equal(fs.existsSync(path.join(wsDir, '.lore', 'graph.sqlite')), false);
    } finally {
        await holder.stop();
    }
});

await test('(j) migrateGraphToSqlite: --force skips the LOCK preflight (fails later at open, not at the preflight)', async () => {
    const { home, wsDir, name } = seededSurrealHome();
    const out = path.join(home, 'backups-out');
    fs.mkdirSync(out, { recursive: true });
    const holder = await startHolder(wsDir, name);
    try {
        await assert.rejects(
            migrateGraphToSqlite({ workspaceName: name, home, backupOutDir: out, force: true }),
            (err: Error) => {
                assert.ok(!/uit the app/.test(err.message) && !err.message.includes(`pid ${holder.pid}`) && !/output dir not found/.test(err.message), `--force must bypass the holder preflight: ${err.message}`);
                return true;
            },
        );
    } finally {
        await holder.stop();
    }
});

await test('(j) migrateGraphToSqlite proceeds past a stale LOCK (dead pid) and succeeds', async () => {
    const { home, wsDir, name } = seededSurrealHome();
    const lock = path.join(surrealDataPath(wsDir), 'LOCK');
    const dead = spawnSync(process.execPath, ['-e', '0']);
    fs.writeFileSync(lock, `${dead.pid}\n`);
    const out = path.join(home, 'backups-out');
    fs.mkdirSync(out, { recursive: true });
    await migrateGraphToSqlite({ workspaceName: name, home, backupOutDir: out });
    assert.equal(tarballs(out).length, 1);
    const g = new SqliteGraph(wsDir, { workspaceId: name, cacheDisabled: true });
    await g.initialize();
    try { assert.equal((await g.getStats()).nodeCount, 3); } finally { await g.close(); }
});

/* ───────────────────────── (j) openGraphForCli ───────────────────────── */

await test('(j) openGraphForCli refuses fast on a live holder, opens once it is gone', async () => {
    const { home, wsDir, name } = seededSurrealHome();
    const prevHome = process.env['LORE_HOME'];
    process.env['LORE_HOME'] = home;
    const holder = await startHolder(wsDir, name);
    try {
        const t0 = Date.now();
        await assert.rejects(
            openGraphForCli(wsDir, { workspaceId: name }),
            (err: Error) => {
                assert.ok(err instanceof CliDaemonLockError, `${err.name}: ${err.message}`);
                assert.ok(err.message.includes(`pid ${holder.pid}`), err.message);
                return true;
            },
        );
        assert.ok(Date.now() - t0 < 5_000, `must refuse before the open budget, took ${Date.now() - t0}ms`);
    } finally {
        await holder.stop();
    }
    try {
        const g = await openGraphForCli(wsDir, { workspaceId: name });
        try { assert.equal((await g.getStats()).nodeCount, 3); } finally { await g.close(); }
    } finally {
        if (prevHome === undefined) delete process.env['LORE_HOME']; else process.env['LORE_HOME'] = prevHome;
    }
});

/* ───────────────────────── wire-up: the real CLI entry ───────────────────────── */

const cliPort = await freePort(); // nothing bound — never 3847/3848
function runCli(home: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
    const r = spawnSync(tsxBin, [cliEntry, ...args], {
        env: { ...process.env, LORE_HOME: home, LORE_PORT: String(cliPort), LORE_MODEL_SERVER: '0' },
        encoding: 'utf8',
        timeout: 120_000,
    });
    if (r.error) throw r.error;
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

await test('wire-up: real CLI `migrate-graph` is refused fast while a child holds the store, succeeds after it exits', async () => {
    const { home, wsDir, name } = seededSurrealHome();
    const backups = path.join(home, 'migrate-graph-backups');
    const holder = await startHolder(wsDir, name);
    try {
        const refused = runCli(home, ['migrate-graph', name, '--to', 'sqlite']);
        assert.equal(refused.status, 1, `${refused.stdout}\n${refused.stderr}`);
        const msg = refused.stdout + refused.stderr;
        assert.ok(msg.includes(`pid ${holder.pid}`), msg);
        assert.ok(/uit the app/.test(msg), msg);
        assert.deepEqual(tarballs(backups), [], 'no backup written for the refused run');
    } finally {
        await holder.stop();
    }
    const ok = runCli(home, ['migrate-graph', name, '--to', 'sqlite']);
    assert.equal(ok.status, 0, `${ok.stdout}\n${ok.stderr}`);
    assert.equal(tarballs(backups).length, 1);
    assert.ok(fs.existsSync(path.join(wsDir, '.lore', 'graph.sqlite')));
});

await test('(h) wire-up: real CLI `status` prints the %20 Surreal path actually used', () => {
    const home = path.join(spacedRoot(), 'lore-home');
    fs.mkdirSync(path.join(home, '.lore'), { recursive: true });
    const r = runCli(home, ['status']);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const line = r.stdout.split('\n').find((l) => l.includes('Graph:'));
    assert.ok(line, r.stdout);
    assert.ok(line.trim().endsWith(surrealDataPath(home)), `status must print the resolved path: ${line}`);
    assert.ok(line.includes('%20'), line);
});

/* ───────────────────────── done ───────────────────────── */

for (const c of children) { try { c.kill('SIGKILL'); } catch { /* already gone */ } }
for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* best effort */ } }

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
