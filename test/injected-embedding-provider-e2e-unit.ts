#!/usr/bin/env tsx
/**
 * injected-embedding-provider-e2e-unit.ts — acceptance test for
 * feat/injected-embedding-provider: `CreateLoreOptions.embeddingProvider`.
 *
 * This is the sprint's key acceptance criterion: a host that injects its
 * own `EmbeddingProvider` must NEVER cause Lore to load its own local ONNX
 * pipeline, and the vectors it produces must be fully interoperable with
 * Lore's normal local-model route (same data dir, same on-disk fingerprint,
 * findable by a plain semantic search).
 *
 * SETUP. This file forks itself three ways (see the `--child-*` argv flags
 * dispatched at the bottom) — same self-forking pattern
 * verbatimSearchWorkerProxy.ts uses for its own worker:
 *
 *   PARENT (no flag):
 *     1. Loads a REAL `LocalEmbeddingProvider` once (the actual ONNX model —
 *        this is the only place in the whole test a model is DELIBERATELY
 *        loaded for the purpose of serving the injected child; the
 *        `--child-baseline` comparison child loads its own, separately, to
 *        measure the cost).
 *     2. Serves it over a tiny localhost HTTP server using the EXACT wire
 *        shape `OpenAICompatEmbeddingProvider` expects (POST /v1/embeddings,
 *        `{input: string[]}` → `{data: [{index, embedding}]}`) — reusing that
 *        already-tested class as the CHILD's injected provider, per the task's
 *        own recommendation, instead of inventing a new wire format.
 *     3. Forks `--child-injected`, passing the server's port + the real
 *        model's modelId/dimension, and separately forks `--child-baseline`
 *        (identical workload, no injection — real LocalEmbeddingProvider,
 *        no HTTP server involved) so the two RSS numbers are a fair,
 *        same-workload, same-machine comparison instead of an absolute
 *        threshold guessed in advance. (An early version of this test used a
 *        fixed 400MiB ceiling; measured baseline RSS for Lore's native deps
 *        — LanceDB, SurrealDB, better-sqlite3, the onnxruntime-node addon
 *        that createLore()'s backend probe always loads — turned out to be
 *        ~530MiB on this machine even with ZERO model loaded, so a fixed
 *        absolute ceiling was the wrong tool; a same-workload comparison
 *        isn't.)
 *     4. Waits for both children's IPC reports, then asserts: the injected
 *        child's `pipelineCache` stayed empty while the baseline child's did
 *        NOT (sanity check that this measurement actually detects a real
 *        load), and the injected child's RSS is meaningfully lower.
 *     5. Re-opens the injected child's data dir through `createLore()` with
 *        NO injected provider (the ordinary local route — auto-selects a
 *        real `LocalEmbeddingProvider`) and confirms a semantic search finds
 *        the injected child's documents.
 *     6. Reads the on-disk fingerprint and confirms it's compatible with the
 *        parent's real local model.
 *
 *   `--child-injected`:
 *     Builds an `OpenAICompatEmbeddingProvider` pointed at the parent's HTTP
 *     server, configured with the PARENT's real modelId/dimension/dtype (so the
 *     vectors it produces are byte-identical to what the parent's real model
 *     would have produced for the same text — this is the SAME model proxied
 *     over HTTP, not a fake/incompatible embedding space).
 *     `createLore({ dataDir, deploymentMode: 'embedded', embeddingProvider })`,
 *     `bulkIngest()`s 50 documents purely through the injected provider,
 *     reports back `_pipelineCacheSizeForTests()` + RSS, exits.
 *
 *   `--child-baseline`:
 *     Identical workload (50 docs, same shape, different tmp dir), but
 *     `createLore({ dataDir, deploymentMode: 'embedded' })` with NO injected
 *     provider — auto-selects and loads a real `LocalEmbeddingProvider`.
 *     Reports back the same two numbers for comparison.
 *
 * Run: npx tsx test/injected-embedding-provider-e2e-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MODE = process.argv.includes('--child-injected')
    ? 'child-injected'
    : process.argv.includes('--child-baseline')
        ? 'child-baseline'
        : 'parent';

interface ChildReport {
    type: 'report';
    ok: boolean;
    error?: string;
    wroteCount: number;
    pipelineCacheSize: number;
    rssBytes: number;
}

function forkAndAwaitReport(here: string, args: string[]): Promise<ChildReport> {
    const child = fork(here, args, { execArgv: process.execArgv, serialization: 'advanced' });
    return new Promise<ChildReport>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (!settled) { settled = true; reject(new Error(`child (${args[0]}) did not report back within 60s`)); }
        }, 60_000);
        child.on('message', (msg: unknown) => {
            const m = msg as ChildReport;
            if (m?.type === 'report' && !settled) { settled = true; clearTimeout(timer); resolve(m); }
        });
        child.on('exit', (code) => {
            if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`child (${args[0]}) exited (code=${code}) before reporting`)); }
        });
        child.on('error', (err) => {
            if (!settled) { settled = true; clearTimeout(timer); reject(err); }
        });
    });
}

// ---------------------------------------------------------------------------
// PARENT
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    console.log('injected-embedding-provider-e2e: a host-injected EmbeddingProvider never touches the local ONNX pipeline, and its vectors are fully interoperable with the normal local route');

    const { LocalEmbeddingProvider, embeddingProviderFingerprint } = await import('../packages/lore/src/providers/localEmbeddingProvider.js');
    const { OpenAICompatEmbeddingProvider } = await import('../packages/lore/src/providers/openAICompatEmbeddingProvider.js');
    const { createLore } = await import('../packages/lore/src/index.js');
    const { getActiveWorkspacePath } = await import('../packages/lore/src/config/workspaces.js');
    const { readFingerprint } = await import('../packages/lore/src/engines/embeddingFingerprint.js');

    let passed = 0, failed = 0;
    const test = async (name: string, fn: () => Promise<void>): Promise<void> => {
        try { await fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
        catch (e) { failed++; console.log(`  \x1b[31m✗ ${name}\x1b[0m\n    ${(e as Error).stack ?? (e as Error).message}`); }
    };

    const injectedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'injected-embed-e2e-injected-'));
    const baselineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'injected-embed-e2e-baseline-'));
    const marker = 'injected-provider-marker-q7x2k';

    // The PARENT runs the real local ONNX model once, purely to serve it over
    // HTTP for the injected child (see the wire shape note in the header).
    console.log('  loading the real local ONNX model in the parent (one-time cost, to serve the injected child)...');
    const realProvider = new LocalEmbeddingProvider();
    await realProvider.initialize();
    console.log(`  parent model ready: ${realProvider.modelId} (dim=${realProvider.dimension})`);

    const server = http.createServer((req, res) => {
        if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            void (async () => {
                try {
                    const parsed = JSON.parse(body) as { input: string[] };
                    const vectors = await realProvider.embedDocumentBatch!(parsed.input);
                    const data = vectors.map((embedding, index) => ({ index, embedding }));
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ data }));
                } catch (err) {
                    res.writeHead(500, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ error: (err as Error).message }));
                }
            })();
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    console.log(`  parent embedding HTTP server listening on 127.0.0.1:${port}`);

    const here = fileURLToPath(import.meta.url);

    // Fork BOTH children — the injected-provider run and the same-workload
    // baseline run — so RSS is a same-workload, same-machine comparison.
    const [injectedReport, baselineReport] = await Promise.all([
        forkAndAwaitReport(here, ['--child-injected', injectedDir, String(port), realProvider.modelId, String(realProvider.dimension), marker, realProvider.dtype]),
        forkAndAwaitReport(here, ['--child-baseline', baselineDir, marker]),
    ]);

    server.close();

    await test('child-injected: bulkIngest() through the injected provider succeeded (>=50 docs)', async () => {
        assert.ok(injectedReport.ok, `child reported failure: ${injectedReport.error}`);
        assert.ok(injectedReport.wroteCount >= 50, `expected >=50 docs written, got ${injectedReport.wroteCount}`);
    });

    await test('child-baseline (sanity control): the NORMAL local route DOES load a real pipeline for the same workload', async () => {
        assert.ok(baselineReport.ok, `baseline child reported failure: ${baselineReport.error}`);
        assert.ok(baselineReport.pipelineCacheSize > 0,
            `baseline child's pipelineCache was ${baselineReport.pipelineCacheSize} — expected >0 for a real auto-selected LocalEmbeddingProvider; if this fails, the measurement method itself is broken, not just the injected path`);
    });

    await test("child-injected NEVER loaded the local ONNX pipeline (localEmbeddingProvider.ts's pipelineCache stayed empty)", async () => {
        assert.equal(
            injectedReport.pipelineCacheSize, 0,
            `injected child's pipelineCache had ${injectedReport.pipelineCacheSize} entries — a real LocalEmbeddingProvider pipeline was loaded even though every embed should have gone through the injected provider`,
        );
    });

    await test('child-injected RSS is meaningfully lower than the same-workload baseline (real model load)', async () => {
        const injectedMb = injectedReport.rssBytes / (1024 * 1024);
        const baselineMb = baselineReport.rssBytes / (1024 * 1024);
        const deltaMb = baselineMb - injectedMb;
        console.log(`    child-injected RSS: ${injectedMb.toFixed(1)} MiB`);
        console.log(`    child-baseline RSS (real model loaded): ${baselineMb.toFixed(1)} MiB`);
        console.log(`    delta: ${deltaMb.toFixed(1)} MiB`);
        // Same workload, same machine, same Lore native deps (LanceDB,
        // SurrealDB, better-sqlite3, onnxruntime-node addon) on both sides —
        // the only structural difference is whether a real ONNX model was
        // loaded. A comparative assertion is used instead of an absolute
        // ceiling because that baseline itself varies by machine/Node build
        // (measured ~530MiB here with NO model loaded) — see the header note.
        assert.ok(deltaMb > 20,
            `expected the baseline (real model) child to cost meaningfully more RSS than the injected child; got only ${deltaMb.toFixed(1)}MiB more — too close to trust as evidence of "no model loaded"`);
    });

    await test("the normal local route (no injected provider) finds the injected child's docs via semantic search", async () => {
        const lore = await createLore({ dataDir: injectedDir, deploymentMode: 'embedded' });
        try {
            const hits = await lore.search(marker, 10);
            assert.ok(hits.length > 0, `expected at least one hit for "${marker}", got 0`);
            assert.ok(
                hits.some((h) => typeof h.id === 'string' && h.id.startsWith('injected-doc-')),
                `expected a hit whose id starts with injected-doc- among: ${hits.map((h) => h.id).join(', ')}`,
            );
        } finally {
            await lore.dispose();
        }
    });

    await test("fingerprint compatibility: the injected child's fingerprint matches the parent's real local model", async () => {
        const basePath = getActiveWorkspacePath(injectedDir);
        const fp = readFingerprint(basePath);
        assert.ok(fp, 'expected a fingerprint to have been written by the injected child');
        assert.equal(fp!.modelId, realProvider.modelId, 'modelId matches — the injected provider was configured with the parent\'s real modelId');
        assert.equal(fp!.dimension, realProvider.dimension, 'dimension matches');
        // Fingerprint parity: the injected remote-shaped provider declared the
        // same dtype as the parent's local model, so the store records it and
        // the modelId@dtype strings are identical.
        assert.equal(fp!.dtype, realProvider.dtype, 'the injected provider\'s declared dtype is recorded on the store fingerprint');
        const remote = new OpenAICompatEmbeddingProvider({
            baseUrl: 'http://127.0.0.1:1/v1', modelId: realProvider.modelId, dimension: realProvider.dimension, dtype: realProvider.dtype,
        });
        assert.equal(embeddingProviderFingerprint(remote), embeddingProviderFingerprint(realProvider), 'identical modelId@dtype fingerprint strings');
        assert.equal(embeddingProviderFingerprint(realProvider), `${realProvider.modelId}@${realProvider.dtype}`);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    fs.rmSync(injectedDir, { recursive: true, force: true });
    fs.rmSync(baselineDir, { recursive: true, force: true });
    process.exit(failed > 0 ? 1 : 0);
}

// ---------------------------------------------------------------------------
// CHILD — injected provider (never loads a local model)
// ---------------------------------------------------------------------------

async function runChildInjected(): Promise<void> {
    const [, , , tmpDir, portStr, modelId, dimStr, marker, dtype] = process.argv;
    try {
        const { OpenAICompatEmbeddingProvider } = await import('../packages/lore/src/providers/openAICompatEmbeddingProvider.js');
        const { createLore } = await import('../packages/lore/src/index.js');
        const { _pipelineCacheSizeForTests } = await import('../packages/lore/src/providers/localEmbeddingProvider.js');

        const injectedProvider = new OpenAICompatEmbeddingProvider({
            baseUrl: `http://127.0.0.1:${portStr}/v1`,
            modelId,
            dimension: Number(dimStr),
            dtype,
            apiKey: 'test-key-not-needed',
        });

        const lore = await createLore({
            dataDir: tmpDir,
            deploymentMode: 'embedded',
            embeddingProvider: injectedProvider,
        });

        const result = await lore.bulkIngest(makeNodes(marker), { embed: 'sync' });
        if (!result.ok) {
            throw new Error(`bulkIngest reported failures: ${JSON.stringify(result.results.filter((r) => !r.ok))}`);
        }

        await lore.dispose();
        sendReport({ ok: true, wroteCount: result.succeeded, pipelineCacheSize: _pipelineCacheSizeForTests(), rssBytes: process.memoryUsage().rss });
        process.exit(0);
    } catch (err) {
        sendReport({ ok: false, error: (err as Error).stack ?? String(err), wroteCount: 0, pipelineCacheSize: -1, rssBytes: process.memoryUsage().rss });
        process.exit(1);
    }
}

// ---------------------------------------------------------------------------
// CHILD — baseline (normal local route, real model, same workload)
// ---------------------------------------------------------------------------

async function runChildBaseline(): Promise<void> {
    const [, , , tmpDir, marker] = process.argv;
    try {
        const { createLore } = await import('../packages/lore/src/index.js');
        const { _pipelineCacheSizeForTests } = await import('../packages/lore/src/providers/localEmbeddingProvider.js');

        // No embeddingProvider — auto-selects + loads a real LocalEmbeddingProvider.
        const lore = await createLore({ dataDir: tmpDir, deploymentMode: 'embedded' });

        const result = await lore.bulkIngest(makeNodes(marker), { embed: 'sync' });
        if (!result.ok) {
            throw new Error(`bulkIngest reported failures: ${JSON.stringify(result.results.filter((r) => !r.ok))}`);
        }

        await lore.dispose();
        sendReport({ ok: true, wroteCount: result.succeeded, pipelineCacheSize: _pipelineCacheSizeForTests(), rssBytes: process.memoryUsage().rss });
        process.exit(0);
    } catch (err) {
        sendReport({ ok: false, error: (err as Error).stack ?? String(err), wroteCount: 0, pipelineCacheSize: -1, rssBytes: process.memoryUsage().rss });
        process.exit(1);
    }
}

function makeNodes(marker: string): Array<{ id: string; workspace: string; ecosystem: string; nodeData: Record<string, unknown> }> {
    return Array.from({ length: 50 }, (_, i) => ({
        id: `injected-doc-${i}`,
        workspace: 'default',
        ecosystem: 'injected-embedding-test',
        nodeData: {
            id: `injected-doc-${i}`,
            type: 'note',
            label: `injected doc ${i}`,
            content: `${marker} document number ${i} — written entirely through a host-injected EmbeddingProvider.`,
        },
    }));
}

function sendReport(fields: Omit<ChildReport, 'type'>): void {
    const report: ChildReport = { type: 'report', ...fields };
    process.send?.(report);
}

if (MODE === 'child-injected') {
    void runChildInjected();
} else if (MODE === 'child-baseline') {
    void runChildBaseline();
} else {
    void main();
}
