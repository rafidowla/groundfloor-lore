/**
 * test/d7-piece-index-unit.ts — D7a (3.23, piece-level vectors), T1.
 *
 * Registered as both `test:unit:d7-piece-index` (Lance, default) and
 * `test:unit:d7-piece-index:sqlite` (`LORE_TEST_VECTOR_ENGINE=sqlite`) —
 * one file, both engines, via test/helpers/testVerbatimStore.js's
 * `makeVerbatimStore`/`testVectorEngine`, same convention as
 * fc1-verbatim-tombstone-unit.ts and friends.
 *
 * Uses a fully injected, deterministic fake EmbeddingProvider throughout —
 * NEVER the real Xenova/ONNX model. No model download can occur from this
 * file.
 *
 * Proves (brief item 5):
 *   - title row + windows (pieceLayout.buildPieces, model tokenizer and
 *     the char-window fallback).
 *   - the asymmetric passage/query prefix is applied EXACTLY ONCE, by the
 *     provider, never by piece-building code (the fake provider's
 *     embedDocument throws if handed already-prefixed text).
 *   - store / storeBatch / bulkAddPrebuiltRows / bulkUpsertPrebuiltRows /
 *     tombstone / physicalDelete / physicalDeleteMany all maintain the
 *     piece index, on both engines.
 *   - `#rev...` history-snapshot rows are never pieced.
 *   - OFF BY DEFAULT: no piece table/sidecar is created and existing
 *     behaviour (canonical store/search) is unchanged when `pieceVectors`
 *     is omitted or false.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { makeVerbatimStore, testVectorEngine } from './helpers/testVerbatimStore.js';
import type { EmbeddingProvider, VerbatimDocument } from '../packages/lore/src/providers/types.js';
import {
    buildPieces, stripLeadingLabel, isPieceSidecarValid, readPieceSidecar,
    writePieceSidecar, freshPieceSidecar, PIECE_LAYOUT_V1, CHAR_WINDOW_SIZE, CHAR_WINDOW_OVERLAP,
} from '../packages/lore/src/engines/pieces/pieceLayout.js';
import { embeddingProviderFingerprint } from '../packages/lore/src/providers/localEmbeddingProvider.js';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
        await fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (e) {
        failed++;
        const stack = e instanceof Error ? (e.stack ?? e.message) : String(e);
        console.log(`  ✗ ${name}`);
        console.log(stack);
    }
}

function assert(cond: unknown, msg: string): asserts cond {
    if (!cond) throw new Error(`assertion failed: ${msg}`);
}

function tmpWorkspace(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'd7-piece-'));
}

// ---- deterministic fake EmbeddingProvider ---------------------------------

const DIM = 8;

/** FNV-1a-ish hash -> per-dimension pseudo-random float, then L2-normalized.
 *  Deterministic and reproducible: the same text always yields the same
 *  vector, and different texts yield (with overwhelming probability)
 *  distinguishable vectors — enough for cosine-similarity assertions in a
 *  small synthetic corpus. */
function vecFromText(text: string, dim: number): number[] {
    const out: number[] = [];
    for (let d = 0; d < dim; d++) {
        let h = 2166136261 ^ d;
        for (let i = 0; i < text.length; i++) {
            h ^= text.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        // Map the 32-bit hash into (-1, 1).
        out.push(((h >>> 0) / 0xffffffff) * 2 - 1);
    }
    const norm = Math.sqrt(out.reduce((s, v) => s + v * v, 0)) || 1;
    return out.map((v) => v / norm);
}

/** A provider whose embedDocument/embedQuery apply an e5-style asymmetric
 *  prefix ("passage: " / "query: ") INSIDE the provider, exactly like
 *  LocalEmbeddingProvider does for e5 models — and which THROWS if it is
 *  ever handed text that already carries that prefix. Piece-building code
 *  (buildPieces, LancePieceIndex/SqlitePieceIndex) must therefore always
 *  hand it plain text, proving the prefix is applied exactly once, by the
 *  provider, never by the piece layer. */
class FakeAsymmetricProvider implements EmbeddingProvider {
    readonly dimension = DIM;
    readonly modelId = 'fake/d7-asymmetric';
    readonly dtype = 'fp32';

    documentCalls: string[] = [];
    queryCalls: string[] = [];
    splitCalls: string[] = [];
    supportsSplit: boolean;
    splitThrows: boolean;

    constructor(opts?: { supportsSplit?: boolean; splitThrows?: boolean }) {
        this.supportsSplit = opts?.supportsSplit ?? true;
        this.splitThrows = opts?.splitThrows ?? false;
        if (!this.supportsSplit) {
            // Structurally remove the method so callers see it as absent,
            // not merely a function that throws — pieceLayout.ts's
            // `typeof provider.splitIntoWindows === 'function'` gate must
            // see `undefined` here.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (this as any).splitIntoWindows = undefined;
        }
    }

    async initialize(): Promise<void> {}

    async embed(text: string): Promise<number[]> {
        return this.embedDocument(text);
    }

    async embedQuery(text: string): Promise<number[]> {
        this.queryCalls.push(text);
        if (text.startsWith('query: ')) throw new Error(`double-prefixed query text: ${JSON.stringify(text)}`);
        return vecFromText(`query: ${text}`, DIM);
    }

    async embedDocument(text: string): Promise<number[]> {
        this.documentCalls.push(text);
        if (text.startsWith('passage: ')) throw new Error(`double-prefixed document text: ${JSON.stringify(text)}`);
        return vecFromText(`passage: ${text}`, DIM);
    }

    async embedDocumentBatch(texts: string[]): Promise<number[][]> {
        const out: number[][] = [];
        for (const t of texts) out.push(await this.embedDocument(t));
        return out;
    }

    async splitIntoWindows(text: string, windowTokens: number, overlapTokens: number): Promise<string[]> {
        this.splitCalls.push(text);
        if (this.splitThrows) throw new Error('fake provider has no usable tokenizer');
        const words = text.split(/\s+/).filter(Boolean);
        if (words.length === 0) return [];
        const stride = Math.max(1, windowTokens - overlapTokens);
        const windows: string[] = [];
        for (let start = 0; start < words.length; start += stride) {
            const slice = words.slice(start, start + windowTokens);
            windows.push(slice.join(' '));
            if (start + windowTokens >= words.length) break;
        }
        return windows;
    }
}

function longBody(words: number): string {
    const parts: string[] = [];
    for (let i = 0; i < words; i++) parts.push(`word${i}`);
    return parts.join(' ');
}

// ============================================================================
// Section A — pieceLayout.buildPieces (no store involved)
// ============================================================================

async function sectionA(): Promise<void> {
    await test('A1: buildPieces — model tokenizer produces a title row + sequential body windows', async () => {
        const provider = new FakeAsymmetricProvider();
        const label = 'My Node Title';
        const body = longBody(300); // 300 "words" -> multiple 128/32 windows
        const { pieces, tokenizer } = await buildPieces(provider, label, body);
        assert(tokenizer === 'model', `expected model tokenizer, got ${tokenizer}`);
        assert(pieces.length >= 3, `expected several pieces for a 300-word body, got ${pieces.length}`);
        assert(pieces[0].isTitle === true, 'piece 0 must be the title row');
        assert(pieces[0].pieceIndex === 0, 'title row must have pieceIndex 0');
        assert(pieces[0].text === label, `title row text must equal the trimmed label, got ${JSON.stringify(pieces[0].text)}`);
        for (let i = 1; i < pieces.length; i++) {
            assert(pieces[i].isTitle === false, `piece ${i} must not be a title row`);
            assert(pieces[i].pieceIndex === i, `piece ${i} must have pieceIndex ${i}, got ${pieces[i].pieceIndex}`);
            assert(pieces[i].text.startsWith(`${label}\n`), `body piece ${i} must be prefixed with "${label}\\n"`);
        }
        // Provider's own splitIntoWindows was consulted, and never handed an
        // already-prefixed ("passage: "/"query: ") string.
        assert(provider.splitCalls.length === 1, `expected exactly one splitIntoWindows call, got ${provider.splitCalls.length}`);
        assert(provider.splitCalls[0] === body, 'splitIntoWindows must receive the plain trimmed body, unprefixed');
    });

    await test('A2: buildPieces — no splitIntoWindows falls back to the fixed char window (480/120)', async () => {
        const provider = new FakeAsymmetricProvider({ supportsSplit: false });
        const body = 'x'.repeat(CHAR_WINDOW_SIZE * 3);
        const { pieces, tokenizer } = await buildPieces(provider, undefined, body);
        assert(tokenizer === 'chars', `expected chars tokenizer, got ${tokenizer}`);
        assert(pieces.length > 1, 'a body 3x the char window size must split into more than one window');
        assert(pieces[0].isTitle === false, 'no label -> no title row, first piece is a body window');
        // First window body-window text (no label) must be exactly CHAR_WINDOW_SIZE chars.
        assert(pieces[0].text.length === CHAR_WINDOW_SIZE, `expected first window length ${CHAR_WINDOW_SIZE}, got ${pieces[0].text.length}`);
        void CHAR_WINDOW_OVERLAP; // referenced for documentation of the stride; exact stride math covered by pieceLayout's own internals
    });

    await test('A3: buildPieces — a throwing splitIntoWindows falls back to char windows (not re-thrown)', async () => {
        const provider = new FakeAsymmetricProvider({ supportsSplit: true, splitThrows: true });
        const body = 'y'.repeat(CHAR_WINDOW_SIZE + 10);
        const { pieces, tokenizer } = await buildPieces(provider, 'L', body);
        assert(tokenizer === 'chars', `expected fallback to chars after a throw, got ${tokenizer}`);
        assert(pieces.length >= 2, 'expected at least 2 windows for a body just over one char-window');
    });

    await test('A4: buildPieces — empty label produces no title row', async () => {
        const provider = new FakeAsymmetricProvider();
        const { pieces } = await buildPieces(provider, '', longBody(10));
        assert(pieces.every((p) => !p.isTitle), 'no piece should be a title row when label is empty');
    });

    await test('A5: stripLeadingLabel — strips exactly "label\\n\\n" when present, else unchanged', () => {
        const label = 'T';
        const withPrefix = `${label}\n\nbody text here`;
        assert(stripLeadingLabel(withPrefix, label) === 'body text here', 'must strip the label+blank-line prefix');
        const bare = 'body text here';
        assert(stripLeadingLabel(bare, label) === bare, 'text without the prefix must be returned unchanged');
        assert(stripLeadingLabel(bare, undefined) === bare, 'no label -> text unchanged');
    });

    await test('A6: prefix applied exactly once — plain piece texts never trip the provider\'s double-prefix guard', async () => {
        const provider = new FakeAsymmetricProvider();
        const { pieces } = await buildPieces(provider, 'Title', longBody(200));
        for (const p of pieces) {
            // Would throw if buildPieces (or the piece layer generally) had
            // already prepended "passage: " itself.
            await provider.embedDocument(p.text);
        }
        assert(provider.documentCalls.length === pieces.length, 'expected exactly one embedDocument call per piece');
        const batch = await provider.embedDocumentBatch(pieces.map((p) => p.text));
        assert(batch.length === pieces.length, 'embedDocumentBatch must return one vector per piece text');
    });
}

// ============================================================================
// Section B — piece sidecar (file-based, no store involved)
// ============================================================================

async function sectionB(): Promise<void> {
    await test('B1: writePieceSidecar / readPieceSidecar round-trip', () => {
        const dir = tmpWorkspace();
        const provider = new FakeAsymmetricProvider();
        assert(readPieceSidecar(dir) === null, 'a fresh workspace must have no sidecar');
        const fresh = freshPieceSidecar(provider, 'model');
        writePieceSidecar(dir, fresh);
        const read = readPieceSidecar(dir);
        assert(read !== null, 'sidecar must exist after writePieceSidecar');
        assert(read!.layout === PIECE_LAYOUT_V1.layout, 'layout id must round-trip');
        assert(read!.windowTokens === PIECE_LAYOUT_V1.windowTokens, 'windowTokens must round-trip');
        assert(read!.embedding === embeddingProviderFingerprint(provider), 'embedding fingerprint must round-trip');
    });

    await test('B2: isPieceSidecarValid — valid, layout mismatch, embedding mismatch, and absent', () => {
        const provider = new FakeAsymmetricProvider();
        const otherProvider = new FakeAsymmetricProvider();
        (otherProvider as { modelId: string }).modelId = 'fake/different-model';

        assert(isPieceSidecarValid(null, provider).valid === false, 'a null sidecar must be invalid');

        const valid = freshPieceSidecar(provider, 'model');
        const okCheck = isPieceSidecarValid(valid, provider);
        assert(okCheck.valid === true, `expected valid, got ${JSON.stringify(okCheck)}`);

        const badLayout = { ...valid, windowTokens: 64 };
        const layoutCheck = isPieceSidecarValid(badLayout, provider);
        assert(layoutCheck.valid === false && layoutCheck.reason === 'layout mismatch', `expected layout mismatch, got ${JSON.stringify(layoutCheck)}`);

        const embeddingCheck = isPieceSidecarValid(valid, otherProvider);
        assert(embeddingCheck.valid === false && embeddingCheck.reason!.startsWith('embedding fingerprint mismatch'), `expected embedding mismatch, got ${JSON.stringify(embeddingCheck)}`);

        const incomplete = { ...valid, complete: false };
        const incompleteCheck = isPieceSidecarValid(incomplete, provider);
        assert(incompleteCheck.valid === false && incompleteCheck.reason === 'incomplete build', `expected incomplete build, got ${JSON.stringify(incompleteCheck)}`);
    });
}

// ============================================================================
// Section C — store-level integration, parameterized by engine
// ============================================================================

async function embedTitleVector(provider: FakeAsymmetricProvider, label: string): Promise<number[]> {
    // The title piece's stored text is exactly the trimmed label (see A1) —
    // embedding it directly with embedDocument reproduces the same vector
    // the piece index stored it under, so a search on this vector should
    // surface that node's piece at (near-)top score.
    return provider.embedDocument(label.trim());
}

async function sectionC(): Promise<void> {
    await test('C1: OFF BY DEFAULT — no sidecar, closed piece index, canonical store/search unaffected', async () => {
        const dir = tmpWorkspace();
        const provider = new FakeAsymmetricProvider();
        const store = makeVerbatimStore(dir, provider); // pieceVectors omitted
        await store.initialize();
        const doc: VerbatimDocument = {
            id: 'off-by-default-1',
            text: 'plain body text, no piece vectors expected',
            metadata: { type: 'note', label: 'Off Node' },
        };
        await store.store(doc);

        assert(readPieceSidecar(dir) === null, 'no piece sidecar should be written when pieceVectors is off');
        const status = (store as unknown as { pieceIndexStatus(): { open: boolean; valid: boolean } }).pieceIndexStatus();
        assert(status.open === false, `expected piece index closed, got ${JSON.stringify(status)}`);
        assert(status.valid === false, `expected piece index invalid/absent, got ${JSON.stringify(status)}`);

        // Existing canonical behaviour must be entirely unaffected.
        const got = await store.getById(doc.id);
        assert(got !== null && got.text === doc.text, 'canonical store/getById must still work with pieceVectors off');

        const hits = await (store as unknown as { searchPieces(v: number[], k: number): Promise<Array<{ nodeId: string }>> })
            .searchPieces(await embedTitleVector(provider, 'Off Node'), 5);
        assert(hits.length === 0, `expected no piece hits when pieceVectors is off, got ${hits.length}`);

        await store.close();
    });

    await test('C2: store() — pieceVectors:true creates a valid index and pieces the node', async () => {
        const dir = tmpWorkspace();
        const provider = new FakeAsymmetricProvider();
        const store = makeVerbatimStore(dir, provider, { pieceVectors: true });
        await store.initialize();
        const label = 'Store Node';
        const doc: VerbatimDocument = {
            id: 'store-1',
            text: longBody(200),
            metadata: { type: 'note', label },
        };
        await store.store(doc);

        const status = (store as unknown as { pieceIndexStatus(): { open: boolean; valid: boolean } }).pieceIndexStatus();
        assert(status.open === true, `expected piece index open after store() with pieceVectors on, got ${JSON.stringify(status)}`);

        const sidecar = readPieceSidecar(dir);
        assert(sidecar !== null, 'sidecar must exist once pieceVectors is on');
        assert(isPieceSidecarValid(sidecar, provider).valid === true, 'the written sidecar must be valid for the live provider');

        const searchPieces = (store as unknown as { searchPieces(v: number[], k: number): Promise<Array<{ nodeId: string; score: number }>> }).searchPieces;
        const hits = await searchPieces.call(store, await embedTitleVector(provider, label), 5);
        assert(hits.length > 0, 'expected at least one piece hit for the title vector');
        assert(hits[0].nodeId === doc.id, `expected top hit to be ${doc.id}, got ${JSON.stringify(hits[0])}`);

        await store.close();
    });

    await test('C3: storeBatch() — pieces both nodes distinctly', async () => {
        const dir = tmpWorkspace();
        const provider = new FakeAsymmetricProvider();
        const store = makeVerbatimStore(dir, provider, { pieceVectors: true });
        await store.initialize();
        const docs: VerbatimDocument[] = [
            { id: 'batch-1', text: longBody(150), metadata: { type: 'note', label: 'Batch Alpha' } },
            { id: 'batch-2', text: longBody(150), metadata: { type: 'note', label: 'Batch Beta' } },
        ];
        await store.storeBatch(docs);

        const searchPieces = (store as unknown as { searchPieces(v: number[], k: number): Promise<Array<{ nodeId: string }>> }).searchPieces;
        const hitsAlpha = await searchPieces.call(store, await embedTitleVector(provider, 'Batch Alpha'), 5);
        const hitsBeta = await searchPieces.call(store, await embedTitleVector(provider, 'Batch Beta'), 5);
        assert(hitsAlpha[0]?.nodeId === 'batch-1', `expected batch-1 top hit for Alpha, got ${JSON.stringify(hitsAlpha)}`);
        assert(hitsBeta[0]?.nodeId === 'batch-2', `expected batch-2 top hit for Beta, got ${JSON.stringify(hitsBeta)}`);

        await store.close();
    });

    await test('C4: bulkAddPrebuiltRows() maintains pieces', async () => {
        const dir = tmpWorkspace();
        const provider = new FakeAsymmetricProvider();
        const store = makeVerbatimStore(dir, provider, { pieceVectors: true });
        await store.initialize();
        const row = {
            id: 'bulk-add-1', label: 'Bulk Add Node', text: longBody(120), type: 'note',
            project: '', ecosystem: '', security_scopes: [], vector: new Array(DIM).fill(0), contentHash: 'x',
        };
        await store.bulkAddPrebuiltRows([row]);

        const searchPieces = (store as unknown as { searchPieces(v: number[], k: number): Promise<Array<{ nodeId: string }>> }).searchPieces;
        const hits = await searchPieces.call(store, await embedTitleVector(provider, 'Bulk Add Node'), 5);
        assert(hits[0]?.nodeId === 'bulk-add-1', `expected bulk-add-1 top hit, got ${JSON.stringify(hits)}`);

        await store.close();
    });

    await test('C5: bulkUpsertPrebuiltRows() maintains pieces, and #rev rows are never pieced', async () => {
        const dir = tmpWorkspace();
        const provider = new FakeAsymmetricProvider();
        const store = makeVerbatimStore(dir, provider, { pieceVectors: true });
        await store.initialize();
        const liveRow = {
            id: 'bulk-upsert-1', label: 'Bulk Upsert Node', text: longBody(120), type: 'note',
            project: '', ecosystem: '', security_scopes: [], vector: new Array(DIM).fill(0), contentHash: 'x',
        };
        const revRow = {
            id: 'bulk-upsert-1#rev2026-01-01T00:00:00.000Z', label: 'Revision Snapshot', text: longBody(120),
            type: 'note', project: '', ecosystem: '', security_scopes: [], vector: new Array(DIM).fill(0), contentHash: 'y',
        };
        await store.bulkUpsertPrebuiltRows([liveRow, revRow]);

        const searchPieces = (store as unknown as { searchPieces(v: number[], k: number): Promise<Array<{ nodeId: string }>> }).searchPieces;
        const liveHits = await searchPieces.call(store, await embedTitleVector(provider, 'Bulk Upsert Node'), 5);
        assert(liveHits[0]?.nodeId === 'bulk-upsert-1', `expected bulk-upsert-1 top hit, got ${JSON.stringify(liveHits)}`);
        assert(!liveHits.some((h) => h.nodeId.includes('#rev')), 'no piece hit may ever belong to a #rev history-snapshot id');

        const revHits = await searchPieces.call(store, await embedTitleVector(provider, 'Revision Snapshot'), 5);
        assert(!revHits.some((h) => h.nodeId === revRow.id), `the #rev row must never be pieced, got ${JSON.stringify(revHits)}`);

        await store.close();
    });

    await test('C6: tombstone() removes the node\'s pieces', async () => {
        const dir = tmpWorkspace();
        const provider = new FakeAsymmetricProvider();
        const store = makeVerbatimStore(dir, provider, { pieceVectors: true });
        await store.initialize();
        const label = 'Tombstone Node';
        const doc: VerbatimDocument = { id: 'tomb-1', text: longBody(120), metadata: { type: 'note', label } };
        await store.store(doc);

        const searchPieces = (store as unknown as { searchPieces(v: number[], k: number): Promise<Array<{ nodeId: string }>> }).searchPieces;
        const before = await searchPieces.call(store, await embedTitleVector(provider, label), 5);
        assert(before[0]?.nodeId === 'tomb-1', 'sanity: node must be pieced before tombstone');

        await store.tombstone(doc.id, 'no longer relevant');

        const after = await searchPieces.call(store, await embedTitleVector(provider, label), 5);
        assert(!after.some((h) => h.nodeId === 'tomb-1'), `expected no live piece hits for a tombstoned node, got ${JSON.stringify(after)}`);

        await store.close();
    });

    await test('C7: physicalDelete() removes the node\'s pieces', async () => {
        const dir = tmpWorkspace();
        const provider = new FakeAsymmetricProvider();
        const store = makeVerbatimStore(dir, provider, { pieceVectors: true });
        await store.initialize();
        const label = 'PhysDelete Node';
        const doc: VerbatimDocument = { id: 'phys-1', text: longBody(120), metadata: { type: 'note', label } };
        await store.store(doc);

        const searchPieces = (store as unknown as { searchPieces(v: number[], k: number): Promise<Array<{ nodeId: string }>> }).searchPieces;
        const before = await searchPieces.call(store, await embedTitleVector(provider, label), 5);
        assert(before[0]?.nodeId === 'phys-1', 'sanity: node must be pieced before physicalDelete');

        await store.physicalDelete(doc.id);

        const after = await searchPieces.call(store, await embedTitleVector(provider, label), 5);
        assert(!after.some((h) => h.nodeId === 'phys-1'), `expected no piece hits after physicalDelete, got ${JSON.stringify(after)}`);

        await store.close();
    });

    await test('C8: physicalDeleteMany() removes pieces for every id', async () => {
        const dir = tmpWorkspace();
        const provider = new FakeAsymmetricProvider();
        const store = makeVerbatimStore(dir, provider, { pieceVectors: true });
        await store.initialize();
        const docs: VerbatimDocument[] = [
            { id: 'many-1', text: longBody(100), metadata: { type: 'note', label: 'Many One' } },
            { id: 'many-2', text: longBody(100), metadata: { type: 'note', label: 'Many Two' } },
        ];
        await store.storeBatch(docs);

        await store.physicalDeleteMany(['many-1', 'many-2']);

        const searchPieces = (store as unknown as { searchPieces(v: number[], k: number): Promise<Array<{ nodeId: string }>> }).searchPieces;
        const hits1 = await searchPieces.call(store, await embedTitleVector(provider, 'Many One'), 5);
        const hits2 = await searchPieces.call(store, await embedTitleVector(provider, 'Many Two'), 5);
        assert(!hits1.some((h) => h.nodeId === 'many-1'), 'many-1 pieces must be gone after physicalDeleteMany');
        assert(!hits2.some((h) => h.nodeId === 'many-2'), 'many-2 pieces must be gone after physicalDeleteMany');

        await store.close();
    });

    await test('C9: pieceVectors:false is equivalent to omitted (still off)', async () => {
        const dir = tmpWorkspace();
        const provider = new FakeAsymmetricProvider();
        const store = makeVerbatimStore(dir, provider, { pieceVectors: false });
        await store.initialize();
        await store.store({ id: 'explicit-off-1', text: longBody(50), metadata: { type: 'note', label: 'Explicit Off' } });
        assert(readPieceSidecar(dir) === null, 'pieceVectors:false must not create a sidecar');
        await store.close();
    });
}

// ============================================================================

async function main(): Promise<void> {
    console.log(`d7-piece-index-unit — engine: ${testVectorEngine()}`);
    console.log('Section A: pieceLayout.buildPieces');
    await sectionA();
    console.log('Section B: piece sidecar');
    await sectionB();
    console.log('Section C: store-level integration');
    await sectionC();

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main().catch((err) => {
    console.error('FATAL:', err);
    process.exit(1);
});
