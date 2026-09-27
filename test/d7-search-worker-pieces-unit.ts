#!/usr/bin/env tsx
/**
 * d7-search-worker-pieces-unit.ts — 3.24.1: piece vectors (D7) under the
 * search worker in parent-embeds mode, and loud piece-build failures.
 *
 * THE BUG (3.24.0). With LORE_SEARCH_WORKER=1 and a parentEmbedder, the
 * child's VerbatimStore runs on a stub provider whose embed methods throw by
 * design. D7c forwarded the piece-vectors intent to the child, so every write
 * hook tried to build pieces on that stub: each upsert threw "NOT REACHABLE:
 * parent embeds — embedDocumentBatch …", was swallowed as a per-row WARN, and
 * the piece table stayed empty while writes returned ok. Separately,
 * `pieceStatusOf` read the proxy's forwarded (Promise-returning)
 * `pieceIndexStatus()` synchronously, so routing could never be `active`
 * under the worker in any mode.
 *
 * Sections:
 *   A  worker + parentEmbedder: store / storeBatch / bulkUpsertPrebuiltRows /
 *      bulkAddPrebuiltRows all produce searchable pieces; routing is active;
 *      a string piece query works; a delete removes the node's pieces.
 *   B  parity: identical piece-search rankings + scores worker-on vs in-process.
 *   C  cost: re-storing an unchanged node adds only the canonical embed.
 *   D  forced piece-build failure → not_built (worker, Lance, SQLite), one
 *      log.error in-process, persisted across reopen.
 *   F  the worker dies after a write but before its pieces are built →
 *      not_built once it restarts (an UPDATE, so coverage alone can't tell).
 *   E  a 3.24.0-damaged index (empty piece table behind a valid sidecar)
 *      reports not_built at open; buildPieceIndex rebuilds it; reopened
 *      under the worker it reports active.
 *
 * Harness: real child_process forks, a deterministic hashed bag-of-words
 * embedder (no ONNX), temp dirs only.
 *
 * Run: npx tsx test/d7-search-worker-pieces-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as lancedb from '@lancedb/lancedb';

import { VerbatimSearchWorkerProxy } from '../packages/lore/src/engines/verbatimSearchWorkerProxy.js';
import { VerbatimStore, SqliteVerbatimStore } from './helpers/testVerbatimStore.js';
import { resolvePieceRouting } from '../packages/lore/src/recall/pieceSeedSearch.js';
import { buildPieceIndex } from '../packages/lore/src/engines/pieces/pieceIndexBuild.js';
import { readPieceSidecar } from '../packages/lore/src/engines/pieces/pieceLayout.js';
import { log } from '../packages/lore/src/logger.js';
import type { EmbeddingProvider, VerbatimDocument } from '../packages/lore/src/providers/types.js';

const DIM = 16;
const BOOM_LABEL = 'BOOM LABEL';

function hashWord(w: string): number {
    let h = 2166136261;
    for (let i = 0; i < w.length; i++) { h ^= w.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
}

/** Deterministic hashed bag-of-words embedder with a word-level
 *  `splitIntoWindows` (so the parent exercises the model-tokenizer branch
 *  the child's stub never could). Counts every text it embeds. */
class WordEmbedder implements EmbeddingProvider {
    readonly modelId = 'd7-worker-word-embedder';
    readonly dimension = DIM;
    textsEmbedded = 0;
    failOnPieceLabel = false;
    /** Called (and awaited) before embedding a batch that contains a piece
     *  title row equal to this label — lets a test act mid-drain. */
    pauseOnPieceLabel: { label: string; hook: () => Promise<void> } | null = null;
    async initialize(): Promise<void> {}
    vec(text: string): number[] {
        const out = new Array<number>(DIM).fill(0);
        for (const w of text.toLowerCase().split(/\s+/).filter(Boolean)) out[hashWord(w) % DIM] += 1;
        const norm = Math.hypot(...out) || 1;
        return out.map((x) => x / norm);
    }
    async embed(text: string): Promise<number[]> { return this.vec(text); }
    async embedQuery(text: string): Promise<number[]> { return this.vec(text); }
    async embedDocument(text: string): Promise<number[]> { this.textsEmbedded++; return this.vec(text); }
    async embedDocumentBatch(texts: string[]): Promise<number[][]> {
        // A title-row piece's text is exactly the label; a canonical row's
        // text is `label\n\nbody`, so this fails piece builds only.
        if (this.failOnPieceLabel && texts.some((t) => t === BOOM_LABEL)) throw new Error('forced piece embed failure');
        const pause = this.pauseOnPieceLabel;
        if (pause && texts.some((t) => t === pause.label)) {
            this.pauseOnPieceLabel = null;
            await pause.hook();
        }
        this.textsEmbedded += texts.length;
        return texts.map((t) => this.vec(t));
    }
    async splitIntoWindows(text: string, windowTokens: number, overlapTokens: number): Promise<string[]> {
        const words = text.split(/\s+/).filter(Boolean);
        if (words.length <= windowTokens) return [words.join(' ')];
        const out: string[] = [];
        for (let s = 0; s < words.length; s += windowTokens - overlapTokens) {
            out.push(words.slice(s, s + windowTokens).join(' '));
            if (s + windowTokens >= words.length) break;
        }
        return out;
    }
}

function body(marker: string, words = 300): string {
    const filler = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];
    const out: string[] = [];
    for (let i = 0; i < words; i++) out.push(i % 50 === 25 ? marker : filler[i % filler.length]);
    return out.join(' ');
}

function doc(id: string, label: string, marker: string): VerbatimDocument {
    return {
        id,
        text: `${label}\n\n${body(marker)}`,
        metadata: { type: 'note', label, project: 'p', ecosystem: 'code', security_scopes: [] },
    } as VerbatimDocument;
}

function prebuilt(id: string, label: string, marker: string, emb: WordEmbedder): Record<string, unknown> {
    const text = `${label}\n\n${body(marker)}`;
    return {
        id, label, text, type: 'note', project: 'p', ecosystem: 'code', security_scopes: [],
        vector: emb.vec(text), contentHash: `hash-${id}`,
    };
}

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
        passed++;
        console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    } catch (err) {
        failed++;
        console.log(`  \x1b[31m✗ ${name}\x1b[0m`);
        console.log(`    ${(err as Error).stack ?? (err as Error).message}`);
    }
}

function tmp(tag: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), `d7-worker-pieces-${tag}-`));
}

type PieceCapable = {
    store(d: VerbatimDocument): Promise<void>;
    storeBatch(d: VerbatimDocument[]): Promise<void>;
    bulkUpsertPrebuiltRows(r: Array<Record<string, unknown>>): Promise<void>;
    bulkAddPrebuiltRows(r: Array<Record<string, unknown>>): Promise<void>;
    searchPieces(q: string | number[], topK: number): Promise<Array<{ nodeId: string; score: number }>>;
};

/** The same fixture through all four write paths. */
async function writeFixture(store: PieceCapable, emb: WordEmbedder): Promise<void> {
    await store.store(doc('n-store', 'Single Store Node', 'zulu'));
    await store.storeBatch([doc('n-batch-1', 'Batch Node One', 'yankee'), doc('n-batch-2', 'Batch Node Two', 'xray')]);
    await store.bulkUpsertPrebuiltRows([prebuilt('n-bulk-upsert', 'Bulk Upsert Node', 'whiskey', emb)]);
    await store.bulkAddPrebuiltRows([prebuilt('n-bulk-add', 'Bulk Add Node', 'victor', emb)]);
}

const FIXTURE_LABELS: Array<[string, string]> = [
    ['n-store', 'Single Store Node'],
    ['n-batch-1', 'Batch Node One'],
    ['n-batch-2', 'Batch Node Two'],
    ['n-bulk-upsert', 'Bulk Upsert Node'],
    ['n-bulk-add', 'Bulk Add Node'],
];

async function routingMeta(store: unknown): Promise<unknown> {
    return (await resolvePieceRouting(store)).meta;
}

async function withErrorCount<T>(fn: () => Promise<T>): Promise<{ value: T; errors: string[] }> {
    const errors: string[] = [];
    const orig = log.error.bind(log);
    (log as unknown as { error: (m: string) => void }).error = (m: string) => { errors.push(String(m)); };
    try {
        return { value: await fn(), errors };
    } finally {
        (log as unknown as { error: typeof orig }).error = orig;
    }
}

process.env.LORE_SEARCH_WORKER_READY_MS ??= '90000';

async function main(): Promise<void> {
    console.log('d7-search-worker-pieces: piece vectors under the search worker (parent-embeds)\n');

    // ── A: worker + parentEmbedder ─────────────────────────────────────────
    const embA = new WordEmbedder();
    const homeA = tmp('a');
    const proxy = new VerbatimSearchWorkerProxy(homeA, undefined, embA, false, true);
    // ── B: the same fixture in-process ─────────────────────────────────────
    const embB = new WordEmbedder();
    const homeB = tmp('b');
    const inproc = new VerbatimStore(homeB, embB, { pieceVectors: true });
    try {
        await proxy.initialize();
        await inproc.initialize();
        await writeFixture(proxy as unknown as PieceCapable, embA);
        await writeFixture(inproc as unknown as PieceCapable, embB);

        const metaA = await routingMeta(proxy);
        console.log(`  [observed] worker _meta.piece_vectors = ${JSON.stringify(metaA)}`);

        await test('A1: routing under the worker reports active', async () => {
            assert.deepEqual(metaA, { status: 'active', layout: 'pieces-v1' });
        });

        for (const [id, label] of FIXTURE_LABELS) {
            await test(`A2: ${id} has searchable pieces under the worker`, async () => {
                const hits = await proxy.searchPieces(embA.vec(label), 3);
                assert.equal(hits[0]?.nodeId, id, `expected ${id} first, got ${JSON.stringify(hits)}`);
            });
        }

        await test('A3: a STRING piece query works under parent-embeds (embedded in the parent)', async () => {
            const hits = await proxy.searchPieces('Batch Node Two', 3);
            assert.equal(hits[0]?.nodeId, 'n-batch-2', JSON.stringify(hits));
        });

        await test('B1: piece-search rankings and scores are identical worker-on vs in-process', async () => {
            const queries = [...FIXTURE_LABELS.map(([, l]) => l), 'zulu alpha bravo', 'whiskey delta echo', 'victor golf hotel'];
            for (const q of queries) {
                const a = await proxy.searchPieces(embA.vec(q), 20);
                const b = await inproc.searchPieces(embB.vec(q), 20);
                assert.ok(a.length > 0, `worker returned no piece hits for ${q}`);
                assert.deepEqual(a.map((h) => h.nodeId), b.map((h) => h.nodeId), `ranking differs for "${q}"`);
                a.forEach((h, i) => assert.ok(Math.abs(h.score - b[i]!.score) < 1e-6, `score differs for "${q}" #${i}`));
            }
        });

        await test('C1: re-storing an unchanged node adds only the canonical embed (no piece embeds)', async () => {
            const d = doc('n-cost', 'Cost Probe Node', 'uniform');
            const before = embA.textsEmbedded;
            await proxy.store(d);
            const firstWrite = embA.textsEmbedded - before;
            const mid = embA.textsEmbedded;
            for (let i = 0; i < 5; i++) await proxy.store(d);
            const repeats = embA.textsEmbedded - mid;
            console.log(`  [observed] first write: ${firstWrite} texts embedded (1 canonical + ${firstWrite - 1} pieces); 5 unchanged re-stores: ${repeats}`);
            assert.ok(firstWrite > 1, 'the first write builds pieces in the parent');
            assert.equal(repeats, 5, 'each unchanged re-store embeds only its canonical text');
        });

        await test('A4: deleting a node removes its pieces under the worker', async () => {
            await proxy.physicalDelete('n-batch-1');
            const hits = await proxy.searchPieces(embA.vec('Batch Node One'), 20);
            assert.ok(!hits.some((h) => h.nodeId === 'n-batch-1'), JSON.stringify(hits));
        });
    } finally {
        await proxy.close().catch(() => {});
        await inproc.close().catch(() => {});
    }

    // ── D: forced piece-build failure ──────────────────────────────────────
    await test('D1: worker — a parent piece-build failure reports not_built, not active', async () => {
        const emb = new WordEmbedder();
        emb.failOnPieceLabel = true;
        const home = tmp('d1');
        const p = new VerbatimSearchWorkerProxy(home, undefined, emb, false, true);
        try {
            await p.initialize();
            await p.store(doc('boom-1', BOOM_LABEL, 'kilo'));
            assert.ok(await p.getById('boom-1'), 'the canonical write still succeeds');
            const meta = await routingMeta(p);
            assert.deepEqual(meta, { status: 'not_built', reason: 'incomplete build' });
        } finally {
            await p.close().catch(() => {});
        }
    });

    for (const [engine, Ctor] of [['lance', VerbatimStore], ['sqlite', SqliteVerbatimStore]] as const) {
        await test(`D2 [${engine}]: in-process piece-build failure → not_built, ONE log.error, persisted across reopen`, async () => {
            const emb = new WordEmbedder();
            emb.failOnPieceLabel = true;
            const home = tmp(`d2-${engine}`);
            const s1 = new Ctor(home, emb, { pieceVectors: true });
            const { errors } = await withErrorCount(async () => {
                await s1.initialize();
                for (let i = 0; i < 3; i++) await s1.store(doc(`boom-${i}`, BOOM_LABEL, `lima${i}`));
            });
            assert.deepEqual(await routingMeta(s1), { status: 'not_built', reason: 'incomplete build' });
            assert.equal(errors.length, 1, `expected exactly one log.error, got ${JSON.stringify(errors)}`);
            await s1.close();
            assert.equal(readPieceSidecar(home)?.complete, false, 'the sidecar records the incomplete build');
            const s2 = new Ctor(home, new WordEmbedder(), { pieceVectors: true });
            await s2.initialize();
            try {
                assert.deepEqual(await routingMeta(s2), { status: 'not_built', reason: 'incomplete build' });
            } finally {
                await s2.close();
            }
        });
    }

    // ── F: worker crash between a write and its piece build ───────────────
    await test('F1: worker killed before an update\'s pieces are built → not_built after restart', async () => {
        const emb = new WordEmbedder();
        const home = tmp('f1');
        const p = new VerbatimSearchWorkerProxy(home, undefined, emb, false, true);
        try {
            await p.initialize();
            await p.store(doc('crash-1', 'Crash Node', 'sierra'));
            await p.store(doc('crash-2', 'Other Node', 'tango'));
            assert.deepEqual(await routingMeta(p), { status: 'active', layout: 'pieces-v1' });
            const child = (p as unknown as { child: { pid: number; kill(sig: string): boolean } }).child;
            emb.pauseOnPieceLabel = {
                label: 'Crash Node',
                hook: async () => {
                    const exited = new Promise<void>((r) => (child as unknown as NodeJS.EventEmitter).once('exit', () => r()));
                    child.kill('SIGKILL');
                    await exited;
                },
            };
            // Same id, new body: the canonical row is replaced and the pieces
            // must be rebuilt. The child dies while the parent is embedding them.
            await p.store(doc('crash-1', 'Crash Node', 'uniform whiskey'));
            let meta: unknown;
            for (let i = 0; i < 100; i++) {
                meta = await routingMeta(p).catch(() => undefined);
                if ((meta as { status?: string } | undefined)?.status === 'not_built') break;
                await new Promise((r) => setTimeout(r, 100));
            }
            assert.deepEqual(meta, { status: 'not_built', reason: 'incomplete build' });
        } finally {
            await p.close().catch(() => {});
        }
    });

    // ── E: recovery of a 3.24.0-damaged index ──────────────────────────────
    await test('E1: empty piece table behind a valid sidecar → not_built at open; rebuild → active under the worker', async () => {
        const emb = new WordEmbedder();
        const home = tmp('e1');
        const s1 = new VerbatimStore(home, emb, { pieceVectors: true });
        await s1.initialize();
        for (let i = 0; i < 4; i++) await s1.store(doc(`rec-${i}`, `Recovery Node ${i}`, `mike${i}`));
        await s1.close();
        // Reproduce exactly what 3.24.0 left behind under the worker.
        const db = await lancedb.connect(path.join(home, '.lore', 'lancedb'));
        const t = await db.openTable('lore_verbatim_pieces');
        await t.delete('true');
        assert.equal(await t.countRows(), 0);
        assert.equal(readPieceSidecar(home)?.complete, true, 'sidecar still claims a complete build');

        const s2 = new VerbatimStore(home, emb, { pieceVectors: true });
        await s2.initialize();
        const damaged = await routingMeta(s2);
        console.log(`  [observed] damaged index at open: ${JSON.stringify(damaged)}`);
        assert.deepEqual(damaged, { status: 'not_built', reason: 'incomplete build' });
        const result = await buildPieceIndex(home, s2, emb);
        assert.equal(result.action, 'built', JSON.stringify(result));
        await s2.close();

        const p = new VerbatimSearchWorkerProxy(home, undefined, emb, false, true);
        try {
            await p.initialize();
            assert.deepEqual(await routingMeta(p), { status: 'active', layout: 'pieces-v1' });
            const hits = await p.searchPieces(emb.vec('Recovery Node 2'), 3);
            assert.equal(hits[0]?.nodeId, 'rec-2', JSON.stringify(hits));
        } finally {
            await p.close().catch(() => {});
        }
    });

    await test('E2: a healthy index with history + tombstones stays active at open (no false positive)', async () => {
        const emb = new WordEmbedder();
        const home = tmp('e2');
        const s1 = new VerbatimStore(home, emb, { pieceVectors: true });
        await s1.initialize();
        await s1.store(doc('h-1', 'History Node', 'november'));
        await s1.store(doc('h-1', 'History Node', 'oscar'));
        await s1.store(doc('h-1', 'History Node', 'papa'));
        await s1.store(doc('t-1', 'Tomb Node', 'quebec'));
        await s1.tombstone('t-1', 'test');
        await s1.close();
        const s2 = new VerbatimStore(home, emb, { pieceVectors: true });
        await s2.initialize();
        try {
            assert.deepEqual(await routingMeta(s2), { status: 'active', layout: 'pieces-v1' });
        } finally {
            await s2.close();
        }
    });

    console.log(`\n${passed} passed, ${failed} failed\n`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
