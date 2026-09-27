#!/usr/bin/env tsx
/**
 * d7-search-worker-pieces-e2e.ts — 3.24.1, end to end through createLore():
 * piece vectors under the search worker in parent-embeds mode, plus the
 * operator recovery path for a host already damaged by 3.24.0.
 *
 * Host shape (the one 3.24.0 broke): Lance vector engine, an injected
 * embeddingProvider (so the worker runs in parent-embeds mode), pieceVectors
 * on, and the search worker forced on per store via searchWorkerPolicy.
 *
 *   1. Ingest through the public API, recall → `_meta.piece_vectors` active.
 *   2. Reproduce the 3.24.0 on-disk state (empty piece table, sidecar still
 *      complete:true), reopen → `_meta.piece_vectors` not_built.
 *   3. Host stopped: run the real `lore migrate piece-vectors` command →
 *      action 'built'.
 *   4. Restart with the worker on → `_meta.piece_vectors` active again.
 *
 * The injected provider and the CLI's env-built provider are the same
 * OpenAI-compatible provider against one fake local server (no network, no
 * ONNX), so both sides share an embedding fingerprint — as a real host and
 * its CLI do. LORE_HOME is a fresh temp dir (see d7-piece-migration-unit.ts
 * "LORE_HOME MANAGEMENT").
 *
 * Run: npx tsx test/d7-search-worker-pieces-e2e.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import * as lancedb from '@lancedb/lancedb';

const DIM = 8;
const FAKE_MODEL_ID = 'd7-worker-e2e-fake-embed';

function fakeVector(text: string): number[] {
    const out = new Array<number>(DIM).fill(0);
    for (const w of text.toLowerCase().split(/\s+/).filter(Boolean)) {
        let h = 2166136261;
        for (let i = 0; i < w.length; i++) { h ^= w.charCodeAt(i); h = Math.imul(h, 16777619); }
        out[(h >>> 0) % DIM] += 1;
    }
    const norm = Math.hypot(...out) || 1;
    return out.map((x) => x / norm);
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

interface RecallLike { hits: Array<{ id: string }>; _meta: { piece_vectors?: { status: string; layout?: string; reason?: string } } }

async function openHost(dataDir: string) {
    const { createLore } = await import('../packages/lore/src/index.js');
    const { createEmbeddingProvider } = await import('../packages/lore/src/mcp/embeddingProviderFactory.js');
    return createLore({
        dataDir,
        deploymentMode: 'embedded',
        ownsProcess: false,
        pieceVectors: true,
        embeddingProvider: await createEmbeddingProvider(),
        searchWorkerPolicy: () => true,
    });
}

async function pieceMeta(lore: Awaited<ReturnType<typeof openHost>>): Promise<RecallLike['_meta']['piece_vectors']> {
    const r = await lore.recall('kestrel migration ledger', { workspace: 'default', searchMode: 'semantic', mode: 'summary' }) as unknown as RecallLike;
    return r._meta.piece_vectors;
}

function findPieceTableDirs(root: string): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (!e.isDirectory()) continue;
            if (e.name === 'lore_verbatim_pieces.lance') out.push(path.dirname(p));
            else walk(p);
        }
    };
    walk(root);
    return out;
}

async function runCli(args: string[]): Promise<{ lines: string[]; action?: string }> {
    const { migratePieceVectorsCommand } = await import('../packages/lore/src/cli/commands/migratePieceVectors.js');
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.map((x) => String(x)).join(' ')); };
    try {
        await migratePieceVectorsCommand(args);
    } finally {
        console.log = origLog;
    }
    const m = lines.map((l) => /^\s*Action:\s*(.*)$/.exec(l)).find(Boolean);
    return { lines, action: m?.[1]?.trim() };
}

async function main(): Promise<void> {
    console.log('d7-search-worker-pieces-e2e: createLore + search worker (parent-embeds) + lore migrate piece-vectors');

    const { port, close } = await startFakeEmbeddingServer();
    process.env['LORE_EMBEDDING_PROVIDER'] = 'openai_compat';
    process.env['LORE_EMBEDDING_BASE_URL'] = `http://127.0.0.1:${port}/v1`;
    process.env['LORE_EMBEDDING_MODEL'] = FAKE_MODEL_ID;
    process.env['LORE_EMBEDDING_DIMENSION'] = String(DIM);
    process.env['LORE_EMBEDDING_API_KEY'] = 'd7-worker-e2e-key';
    process.env['LORE_DEFAULT_VECTOR_ENGINE'] = 'lance';
    process.env['LORE_SEARCH_WORKER_READY_MS'] ??= '90000';
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'd7-worker-e2e-'));
    const prevHome = process.env['LORE_HOME'];
    process.env['LORE_HOME'] = dataDir;

    try {
        // 1. Ingest + recall under the worker.
        let lore = await openHost(dataDir);
        try {
            const nodes = Array.from({ length: 6 }, (_, i) => ({
                id: `w-node-${i}`,
                workspace: 'default',
                ecosystem: '*',
                nodeData: {
                    id: `w-node-${i}`, type: 'knowledge', label: `Worker Node ${i}`,
                    content: `${i === 3 ? 'kestrel migration ledger ' : ''}` + 'lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(30),
                    project: 'default', ecosystem: '*',
                },
            }));
            const result = await lore.bulkIngest(nodes, { autolink: false, embed: 'sync' });
            assert.ok(result.results.every((r) => r.ok), JSON.stringify(result.results.filter((r) => !r.ok)));

            const meta = await pieceMeta(lore);
            console.log(`  [observed] after ingest under the worker: _meta.piece_vectors = ${JSON.stringify(meta)}`);
            await test('1: recall under the worker reports piece_vectors active', async () => {
                assert.deepEqual(meta, { status: 'active', layout: 'pieces-v1' });
            });
        } finally {
            await lore.dispose();
        }

        const pieceDirs = findPieceTableDirs(dataDir);
        await test('1b: the worker build actually wrote piece rows to disk', async () => {
            assert.equal(pieceDirs.length, 1, `expected one piece table, found ${JSON.stringify(pieceDirs)}`);
            const t = await (await lancedb.connect(pieceDirs[0]!)).openTable('lore_verbatim_pieces');
            assert.ok(await t.countRows() > 7, `expected more piece rows than nodes, got ${await t.countRows()}`);
        });

        // 2. Reproduce the 3.24.0 damage and reopen.
        {
            const t = await (await lancedb.connect(pieceDirs[0]!)).openTable('lore_verbatim_pieces');
            await t.delete('true');
        }
        lore = await openHost(dataDir);
        try {
            const meta = await pieceMeta(lore);
            console.log(`  [observed] 3.24.0-damaged host at open: _meta.piece_vectors = ${JSON.stringify(meta)}`);
            await test('2: a damaged host reports not_built, not active', async () => {
                assert.deepEqual(meta, { status: 'not_built', reason: 'incomplete build' });
            });
        } finally {
            await lore.dispose();
        }

        // 3. Host stopped: the real migrate command.
        const cli = await runCli([]);
        await test('3: `lore migrate piece-vectors` rebuilds the damaged index', async () => {
            assert.equal(cli.action, 'built', cli.lines.join('\n'));
        });

        // 4. Restart with the worker on.
        lore = await openHost(dataDir);
        try {
            const meta = await pieceMeta(lore);
            console.log(`  [observed] after migrate + restart: _meta.piece_vectors = ${JSON.stringify(meta)}`);
            await test('4: after migrate + restart under the worker, piece_vectors is active', async () => {
                assert.deepEqual(meta, { status: 'active', layout: 'pieces-v1' });
            });
        } finally {
            await lore.dispose();
        }

        // 5. The upgrade path with no host start in between: a 3.24.0-damaged
        //    store (sidecar still complete:true) straight into the migrate
        //    command. The command's own store open must spot the gap, or the
        //    build would no-op as "already built".
        {
            const t = await (await lancedb.connect(pieceDirs[0]!)).openTable('lore_verbatim_pieces');
            await t.delete('true');
        }
        const { readPieceSidecar } = await import('../packages/lore/src/engines/pieces/pieceLayout.js');
        const sidecarBefore = readPieceSidecar(dataDir);
        const direct = await runCli([]);
        await test('5: migrate straight after upgrade (no host start) rebuilds, not "already built"', async () => {
            assert.equal(sidecarBefore?.complete, true, 'precondition: damaged sidecar still claims complete');
            assert.equal(direct.action, 'built', direct.lines.join('\n'));
            const t = await (await lancedb.connect(pieceDirs[0]!)).openTable('lore_verbatim_pieces');
            assert.ok(await t.countRows() > 6, `expected rebuilt piece rows, got ${await t.countRows()}`);
        });
    } finally {
        if (prevHome === undefined) delete process.env['LORE_HOME'];
        else process.env['LORE_HOME'] = prevHome;
        fs.rmSync(dataDir, { recursive: true, force: true });
        await close();
    }

    console.log(`\n${passed} passed, ${failed} failed\n`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
