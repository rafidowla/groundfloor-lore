#!/usr/bin/env tsx
/**
 * d7-piece-rebuild-datadir-unit.ts — 3.24.2. The D7 piece-index repair must
 * reach an EMBEDDED host's data root, not only LORE_HOME.
 *
 * 3.24.1 marks the piece index incomplete after a failed piece build/delete
 * and turns piece search off until `lore migrate piece-vectors` is run. That
 * command only ever targeted `loreHome()`, so a host like Atlas — whose store
 * is `createLore({ dataDir })`, never LORE_HOME — had no recovery path: the
 * CLI rebuilt (or no-op'd) LORE_HOME and the host's index stayed incomplete.
 *
 * Layout under test (Atlas-shaped): LORE_HOME = temp A, the host's data root
 * = temp B (its own workspaces.json, active workspace path = B). B is seeded
 * with pieces ON, then its sidecar is forced `complete: false` — exactly what
 * a 3.24.1 failed piece write leaves behind.
 *
 *   1. `lore migrate piece-vectors --data-dir B` → `Action: built`, sidecar
 *      complete, A untouched, and a fresh createLore on B with pieces on
 *      recalls with `_meta.piece_vectors.status === 'active'` (it was not
 *      active before the rebuild).
 *   2. The exported `rebuildPieceIndex({ dataDir: B })` API does the same;
 *      a second call is a no-op. `--data-dir=B --dry-run` form parses.
 *   3. Default unchanged: a bare run targets LORE_HOME and leaves B's
 *      incomplete sidecar alone.
 *   4. A nonexistent data dir errors (CLI exit 1, API throws) and creates
 *      nothing.
 *   5. (Surreal graph engine) B held by another process → the API throws
 *      PieceIndexDataDirInUseError and the CLI exits 1 telling the operator
 *      to stop that host. SQLite takes no cross-process single-writer lock,
 *      so the preflight cannot detect a holder there — logged as skipped.
 *
 * Engines: a fresh home now seeds the SQLite graph, so the base script sets
 * LORE_DEFAULT_GRAPH_ENGINE=surreal + LANCE vectors explicitly — Atlas's
 * existing data roots (graphEngine surreal or absent → surreal, vectors
 * lance). The `:sqlite` script covers the SQLite/SQLite profile.
 *
 * Embedding provider: the same deterministic fake OpenAI-compatible server
 * as d7-piece-migration-unit.ts (the CLI resolves its provider from env).
 *
 * Run: LORE_DEFAULT_VECTOR_ENGINE=lance LORE_DEFAULT_GRAPH_ENGINE=surreal npx tsx test/d7-piece-rebuild-datadir-unit.ts
 *      LORE_DEFAULT_VECTOR_ENGINE=sqlite LORE_DEFAULT_GRAPH_ENGINE=sqlite npx tsx test/d7-piece-rebuild-datadir-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

const DIM = 4;
const FAKE_MODEL_ID = 'd7-datadir-fake-embed';
const selfPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(selfPath), '..');
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');

/* ── child: hold B's graph lock until killed ──────────────────────────── */

if (process.argv[2] === '--child' && process.argv[3] === 'holder') {
    const dataDir = process.argv[4]!;
    const { openWorkspaceGraph } = await import('../packages/lore/src/engines/openWorkspaceGraph.js');
    const graph = openWorkspaceGraph(dataDir, { home: dataDir });
    await graph.initialize();
    console.log('HOLDER_READY');
    // Held until the parent SIGKILLs this process; self-timeout as a leak net.
    await new Promise((resolve) => setTimeout(resolve, 60_000));
    await graph.close();
    process.exit(0);
}

/* ── fake embedding server ────────────────────────────────────────────── */

function fakeVector(text: string): number[] {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    const out: number[] = [];
    for (let i = 0; i < DIM; i++) {
        h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
        out.push(((h >>> 0) / 0xffffffff) * 2 - 1);
    }
    return out;
}

function startFakeEmbeddingServer(): Promise<{ port: number; close: () => Promise<void> }> {
    const server = http.createServer((req, res) => {
        if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            try {
                const parsed = JSON.parse(body) as { input: string[] };
                const data = parsed.input.map((text, index) => ({ index, embedding: fakeVector(text) }));
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ data }));
            } catch (err) {
                res.writeHead(500, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: (err as Error).message }));
            }
        });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const port = (server.address() as AddressInfo).port;
            resolve({ port, close: () => new Promise((r) => server.close(() => r())) });
        });
    });
}

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
        console.log(`  \x1b[32m✓\x1b[0m ${name}`);
        passed++;
    } catch (err) {
        console.error(`  \x1b[31m✗ ${name}\x1b[0m\n    ${(err as Error).stack ?? (err as Error).message}`);
        failed++;
    }
}

/* ── fixtures ─────────────────────────────────────────────────────────── */

/** LORE_HOME = fresh temp A, host data root = fresh temp B (A ≠ B). */
async function withHostLayout<T>(fn: (loreHomeDir: string, dataDir: string) => Promise<T>): Promise<T> {
    const loreHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'd7-datadir-lorehome-'));
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'd7-datadir-host-'));
    const prevHome = process.env['LORE_HOME'];
    process.env['LORE_HOME'] = loreHomeDir;
    try {
        return await fn(loreHomeDir, dataDir);
    } finally {
        if (prevHome === undefined) delete process.env['LORE_HOME'];
        else process.env['LORE_HOME'] = prevHome;
        fs.rmSync(loreHomeDir, { recursive: true, force: true });
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
}

function longBody(marker: string): string {
    return `${marker} ` + 'lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(30);
}

const N = 5;

/** Seed B through the host API with pieces ON, then force the sidecar
 *  incomplete — the state a 3.24.1 failed piece write leaves behind. */
async function seedIncomplete(dataDir: string): Promise<void> {
    const { createLore } = await import('../packages/lore/src/index.js');
    const lore = await createLore({ dataDir, deploymentMode: 'embedded', ownsProcess: false, pieceVectors: true });
    try {
        const nodes = Array.from({ length: N }, (_, i) => ({
            id: `d7dd-node-${i}`,
            workspace: 'default',
            ecosystem: '*',
            nodeData: {
                id: `d7dd-node-${i}`,
                type: 'knowledge',
                label: `D7 datadir node ${i}`,
                content: i % 2 === 0 ? longBody(`marker-${i}`) : `short body ${i}`,
                project: 'default',
                ecosystem: '*',
            },
        }));
        const result = await lore.bulkIngest(nodes, { autolink: false, embed: 'sync' });
        assert.ok(result.results.every((r) => r.ok), `seed bulkIngest had failures: ${JSON.stringify(result.results.filter((r) => !r.ok))}`);
    } finally {
        await lore.dispose();
    }

    const { writePieceSidecar, PIECE_LAYOUT_V1 } = await import('../packages/lore/src/engines/pieces/pieceLayout.js');
    const { embeddingProviderFingerprint } = await import('../packages/lore/src/providers/localEmbeddingProvider.js');
    writePieceSidecar(dataDir, {
        layout: PIECE_LAYOUT_V1.layout,
        windowTokens: PIECE_LAYOUT_V1.windowTokens,
        overlapTokens: PIECE_LAYOUT_V1.overlapTokens,
        titleRow: PIECE_LAYOUT_V1.titleRow,
        tokenizer: 'model',
        embedding: embeddingProviderFingerprint({ modelId: FAKE_MODEL_ID, dtype: undefined }),
        complete: false,
    });
}

async function sidecarComplete(dir: string): Promise<boolean | undefined> {
    const { readPieceSidecar } = await import('../packages/lore/src/engines/pieces/pieceLayout.js');
    return readPieceSidecar(dir)?.complete;
}

/** Recall on B as the host would, returning `_meta.piece_vectors.status`. */
async function pieceStatusOnHost(dataDir: string): Promise<string | undefined> {
    const { createLore } = await import('../packages/lore/src/index.js');
    const lore = await createLore({ dataDir, deploymentMode: 'embedded', ownsProcess: false, pieceVectors: true });
    try {
        const r = await lore.recall('marker-0 lorem ipsum', { workspace: 'default', searchMode: 'semantic', mode: 'summary' }) as unknown as {
            _meta: { piece_vectors?: { status?: string } };
        };
        return r._meta.piece_vectors?.status;
    } finally {
        await lore.dispose();
    }
}

/** Recursive listing (path + size + mtime) — proves a directory untouched. */
function snapshot(dir: string): string[] {
    const out: string[] = [];
    const walk = (d: string): void => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            const st = fs.statSync(p);
            out.push(`${path.relative(dir, p)} ${e.isDirectory() ? 'd' : st.size} ${st.mtimeMs}`);
            if (e.isDirectory()) walk(p);
        }
    };
    walk(dir);
    return out.sort();
}

class ExitCalled extends Error {
    constructor(public readonly code: number | undefined) { super(`process.exit(${code})`); }
}

interface CliResult {
    lines: string[];
    errLines: string[];
    exitCode?: number;
    action?: string;
    nodesRebuilt?: number;
}

/** Run the real CLI export in-process, capturing stdout/stderr and turning
 *  process.exit into a catchable result. */
async function runCli(args: string[]): Promise<CliResult> {
    const { migratePieceVectorsCommand } = await import('../packages/lore/src/cli/commands/migratePieceVectors.js');
    const lines: string[] = [];
    const errLines: string[] = [];
    const origLog = console.log, origErr = console.error, origExit = process.exit;
    console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
    console.error = (...a: unknown[]) => { errLines.push(a.map(String).join(' ')); };
    process.exit = ((code?: number) => { throw new ExitCalled(code); }) as typeof process.exit;
    let exitCode: number | undefined;
    try {
        await migratePieceVectorsCommand(args);
    } catch (err) {
        if (!(err instanceof ExitCalled)) throw err;
        exitCode = err.code;
    } finally {
        console.log = origLog;
        console.error = origErr;
        process.exit = origExit;
    }
    const field = (label: string): string | undefined => {
        const re = new RegExp(`^\\s*${label}:\\s*(.*)$`);
        for (const l of lines) { const m = re.exec(l); if (m) return m[1]!.trim(); }
        return undefined;
    };
    const rebuilt = field('Nodes rebuilt');
    return { lines, errLines, exitCode, action: field('Action'), nodesRebuilt: rebuilt === undefined ? undefined : Number(/^\d+/.exec(rebuilt)?.[0]) };
}

/* ── (1) CLI --data-dir rebuilds the host's store ─────────────────────── */

async function testCliDataDir(): Promise<void> {
    await withHostLayout(async (loreHomeDir, dataDir) => {
        await seedIncomplete(dataDir);

        const { resolvePieceRebuildTarget } = await import('../packages/lore/src/engines/pieces/rebuildPieceIndex.js');
        assert.equal(resolvePieceRebuildTarget(dataDir).basePath, dataDir, 'Atlas-shaped layout: the active workspace path is the data root itself');
        assert.equal(await sidecarComplete(dataDir), false, 'precondition: sidecar incomplete');
        const before = await pieceStatusOnHost(dataDir);
        assert.notEqual(before, 'active', 'precondition: piece search is off while the index is incomplete');

        const homeBefore = snapshot(loreHomeDir);
        const res = await runCli(['--data-dir', dataDir]);
        assert.equal(res.exitCode, undefined, `CLI exited: ${res.errLines.join('\n')}`);
        assert.equal(res.action, 'built', `expected built, got ${res.action}:\n${res.lines.join('\n')}`);
        assert.equal(res.nodesRebuilt, N);
        assert.ok(res.lines.some((l) => l.includes(`Data dir: ${dataDir}`)), 'banner names the targeted data dir');
        assert.equal(await sidecarComplete(dataDir), true, 'sidecar complete after the rebuild');
        assert.deepEqual(snapshot(loreHomeDir), homeBefore, 'LORE_HOME must be untouched by a --data-dir rebuild');

        const after = await pieceStatusOnHost(dataDir);
        assert.equal(after, 'active', `expected _meta.piece_vectors.status active after the rebuild, got ${after}`);
    });
}

/* ── (2) exported API ─────────────────────────────────────────────────── */

async function testApi(): Promise<void> {
    await withHostLayout(async (_loreHomeDir, dataDir) => {
        await seedIncomplete(dataDir);
        const { rebuildPieceIndex } = await import('../packages/lore/src/index.js');

        const dry = await runCli([`--data-dir=${dataDir}`, '--dry-run']);
        assert.equal(dry.action, 'dry-run', `--data-dir=<path> form: expected dry-run, got ${dry.action}:\n${dry.lines.join('\n')}`);
        assert.equal(await sidecarComplete(dataDir), false, 'dry-run writes nothing');

        const first = await rebuildPieceIndex({ dataDir });
        assert.equal(first.action, 'built');
        assert.equal(first.nodesRebuilt, N);
        assert.equal(first.basePath, dataDir);
        assert.equal(first.modelId, FAKE_MODEL_ID);
        assert.equal(await sidecarComplete(dataDir), true);

        const second = await rebuildPieceIndex({ dataDir });
        assert.equal(second.action, 'noop', 'second call is a no-op');

        assert.equal(await pieceStatusOnHost(dataDir), 'active');

        await assert.rejects(rebuildPieceIndex({ dataDir, drop: true, force: true }), /drop cannot be combined/);
    });
}

/* ── (3) default (no flag) behaviour unchanged ────────────────────────── */

async function testDefaultUnchanged(): Promise<void> {
    await withHostLayout(async (loreHomeDir, dataDir) => {
        await seedIncomplete(dataDir);
        const hostBefore = snapshot(dataDir);

        const res = await runCli([]);
        assert.equal(res.exitCode, undefined, `bare CLI exited: ${res.errLines.join('\n')}`);
        assert.ok(res.lines.some((l) => l.includes(`Fingerprint: ${path.join(loreHomeDir, '.lore')}`)),
            `bare run must target LORE_HOME:\n${res.lines.join('\n')}`);
        assert.ok(!res.lines.some((l) => l.includes('Data dir:')), 'no data-dir banner without the flag');
        assert.deepEqual(snapshot(dataDir), hostBefore, 'a bare run must not touch the host data root');
        assert.equal(await sidecarComplete(dataDir), false, 'host sidecar still incomplete');
    });
}

/* ── (3b) LORE_HOME=<dataDir> — the pre-3.24.2 workaround ──────────────── */

/** Documents (and pins) the route that already worked on 3.24.1 for a host
 *  whose active workspace path IS its data root (Atlas): pointing LORE_HOME
 *  at the data root makes the bare command's `loreHome()` target it. The
 *  flag/API exist because that relies on the layout coincidence and on the
 *  operator knowing to do it. */
async function testLoreHomeWorkaround(): Promise<void> {
    await withHostLayout(async (_loreHomeDir, dataDir) => {
        await seedIncomplete(dataDir);
        const prev = process.env['LORE_HOME'];
        process.env['LORE_HOME'] = dataDir;
        try {
            const res = await runCli([]);
            assert.equal(res.action, 'built', `expected built, got ${res.action}:\n${res.lines.join('\n')}`);
            assert.equal(await sidecarComplete(dataDir), true);
        } finally {
            process.env['LORE_HOME'] = prev;
        }
    });
}

/* ── (4) nonexistent data dir ─────────────────────────────────────────── */

async function testMissingDataDir(): Promise<void> {
    await withHostLayout(async (_loreHomeDir, dataDir) => {
        const missing = path.join(dataDir, 'does-not-exist');
        const res = await runCli(['--data-dir', missing]);
        assert.equal(res.exitCode, 1, 'CLI exits 1');
        assert.match(res.errLines.join('\n'), /does not exist/);
        assert.equal(fs.existsSync(missing), false, 'CLI created nothing');

        const bare = await runCli(['--data-dir']);
        assert.equal(bare.exitCode, 1, '--data-dir without a value exits 1');

        const { rebuildPieceIndex } = await import('../packages/lore/src/index.js');
        await assert.rejects(rebuildPieceIndex({ dataDir: missing }), /does not exist/);
        assert.equal(fs.existsSync(missing), false, 'API created nothing');
    });
}

/* ── (5) data root held by a running host ─────────────────────────────── */

async function testInUse(): Promise<void> {
    await withHostLayout(async (_loreHomeDir, dataDir) => {
        await seedIncomplete(dataDir);
        const holder = spawn(tsxBin, [selfPath, '--child', 'holder', dataDir], {
            env: { ...process.env },
            stdio: ['ignore', 'pipe', 'inherit'],
            detached: true,
        });
        try {
            await new Promise<void>((resolve, reject) => {
                let buf = '';
                const timer = setTimeout(() => reject(new Error('holder did not become ready in time')), 20_000);
                holder.stdout!.on('data', (chunk) => {
                    buf += chunk.toString();
                    if (buf.includes('HOLDER_READY')) { clearTimeout(timer); resolve(); }
                });
                holder.on('exit', (code) => { clearTimeout(timer); reject(new Error(`holder exited early, code=${code}`)); });
            });

            const { rebuildPieceIndex, PieceIndexDataDirInUseError } = await import('../packages/lore/src/index.js');
            await assert.rejects(rebuildPieceIndex({ dataDir }), (err: unknown) => {
                assert.ok(err instanceof PieceIndexDataDirInUseError, `expected PieceIndexDataDirInUseError, got ${String(err)}`);
                return true;
            });

            const res = await runCli(['--data-dir', dataDir]);
            assert.equal(res.exitCode, 1);
            const err = res.errLines.join('\n');
            assert.match(err, /Stop \(or dispose the Lore instance of\) the host that owns this data directory/);
            assert.doesNotMatch(err, /launchctl/, 'must not point at the LORE_HOME daemon for a host data dir');
            assert.equal(await sidecarComplete(dataDir), false, 'nothing rebuilt while held');
        } finally {
            if (holder.pid) { try { process.kill(-holder.pid, 'SIGKILL'); } catch { /* gone */ } } else { holder.kill('SIGKILL'); }
        }
    });
}

/* ── main ──────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
    console.log('d7-piece-rebuild-datadir-unit: piece-index rebuild reaches an embedded host data root (3.24.2)');

    const { port, close } = await startFakeEmbeddingServer();
    process.env['LORE_EMBEDDING_PROVIDER'] = 'openai_compat';
    process.env['LORE_EMBEDDING_BASE_URL'] = `http://127.0.0.1:${port}/v1`;
    process.env['LORE_EMBEDDING_MODEL'] = FAKE_MODEL_ID;
    process.env['LORE_EMBEDDING_DIMENSION'] = String(DIM);
    process.env['LORE_EMBEDDING_API_KEY'] = 'd7-datadir-test-key';

    try {
        await test('CLI --data-dir rebuilds an incomplete host index → built, LORE_HOME untouched, recall active', testCliDataDir);
        await test('exported rebuildPieceIndex({ dataDir }) builds, then no-ops; --data-dir=<path> form parses', testApi);
        await test('no flag: default still targets LORE_HOME and leaves the host data root alone', testDefaultUnchanged);
        await test('LORE_HOME=<dataDir> (pre-3.24.2 workaround) also reaches an Atlas-shaped root', testLoreHomeWorkaround);
        await test('nonexistent --data-dir errors and creates nothing (CLI + API)', testMissingDataDir);
        if (process.env['LORE_DEFAULT_GRAPH_ENGINE'] !== 'surreal') {
            console.log('  - skipped: in-use refusal (only the Surreal graph takes a cross-process single-writer lock the preflight can detect)');
        } else {
            await test('data root held by another process → PieceIndexDataDirInUseError / CLI names the host, not launchd', testInUse);
        }
    } finally {
        await close();
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
