#!/usr/bin/env tsx
/**
 * test/d7-piece-recall-unit.ts — D7b (3.23, piece-level vectors), retrieval
 * routing, end-to-end coverage.
 *
 * test/d7-piece-index-unit.ts (T1) covers the storage layer (buildPieces,
 * sidecar validity, per-engine searchPieces) directly. This file goes
 * through the PUBLIC surface instead: a real `createLore()` embedded
 * instance, its real MCP `recall` tool (via `InMemoryTransport` + a real
 * `Client`, same pattern as test/d2-type-prefilter-e2e-unit.ts), so the
 * assertions cover the actual D7b wiring — recall args -> retrieve() ->
 * resolveSeedStore() -> pieceAwareSearch() -> the store's per-engine
 * searchPieces() -> BM25/RRF fusion -> D2/D5/actor-scope surfaces — not
 * just the bottom of that chain.
 *
 * Fixture technique: a deterministic, no-ONNX-load fake EmbeddingProvider
 * assigns cosine similarity along a single shared axis, using THREE
 * disjoint text markers so unrelated scenarios can reuse one small
 * provider:
 *
 *  - DETAIL_MARK, density-scaled: cos = min(0.98, occurrences * markerLen /
 *    textLen * DENSITY_SCALE). The SAME text (a node's full pooled body)
 *    scores low when the marker is one small occurrence buried in a long
 *    text, but high when the SAME occurrence is the near-entirety of a
 *    short piece window — this models the real dilution effect mean-
 *    pooling causes, without needing a real tokenizer/model. Used for (a)
 *    the buried-last-window ranking case and (b) the several-pieces/
 *    node-score-is-max case (same fixture, two marker occurrences).
 *  - DIST_MARK, fixed cos 0.5 regardless of granularity (a short document,
 *    so its pooled text and its one piece are near-identical) — sits
 *    strictly between the target's diluted pooled score (~0.1-0.2) and its
 *    concentrated piece score (~0.7-0.9), so 3 of these push the target
 *    out of pooled top-3 while losing to it in piece top-3.
 *  - MATCH_MARK, binary cos 1 (`.includes()`, so label-prefixing at the
 *    piece layer doesn't matter) — used for (c)/(d)/(e)/(f), where the
 *    point isn't ranking-quality nuance but "does the filter/pushdown/
 *    replacement/status-surfacing still apply correctly when the vector
 *    leg is routed through pieces". Crowding-out mechanics for D2 types
 *    and the D5 replacement contract are already proven generically by
 *    d2-type-prefilter-(-e2e)-unit.ts / d5-recall-surfaces-supersession-
 *    unit.ts; this file's job is only to prove piece routing doesn't
 *    bypass them, so a simple identity-style match is deliberately enough
 *    here — see file d2-type-prefilter-e2e-unit.ts's own header for the
 *    same scope reasoning applied to its crowding-out cases.
 *
 * 'stale' / 'unsupported' `_meta.piece_vectors.status` values are NOT
 * reproduced here: 'stale' needs a deliberately corrupted fingerprint/
 * layout sidecar file (a storage-layer concern, T1's territory) and
 * 'unsupported' needs a store type that lacks searchPieces/
 * pieceIndexStatus, unreachable through createLore()'s embedded Lance/
 * SQLite paths. 'active' / 'off' / 'not_built' are covered here.
 *
 * Run: npx tsx test/d7-piece-recall-unit.ts
 *      LORE_DEFAULT_VECTOR_ENGINE=sqlite LORE_DEFAULT_GRAPH_ENGINE=sqlite \
 *        npx tsx test/d7-piece-recall-unit.ts   (the :sqlite npm variant)
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createLore } from '../packages/lore/src/index.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';
import { runWithActor } from '../packages/lore/src/security/actorContext.js';

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

interface ToolTextResult { content: Array<{ type: string; text: string }>; isError?: boolean }
function parseToolText<T>(result: ToolTextResult): T {
    return JSON.parse(result.content[0]?.text ?? '{}') as T;
}
interface PieceVectorsMetaLike { status: string; layout?: string }
interface RecallSummaryLike {
    hits: Array<{ id: string }>;
    _meta: { piece_vectors?: PieceVectorsMetaLike };
}

const DIM = 2;
const DETAIL_MARK = 'ZQXDETAILANSWERTOKEN7';
/** Query-only counterpart to DETAIL_MARK — deliberately never appears in
 *  any node's content. DETAIL_MARK itself IS a literal rare token in the
 *  target's content, so querying with DETAIL_MARK verbatim would let a
 *  BM25/FTS exact-token match smuggle 'target' into the fused results
 *  regardless of vector cosine, defeating the point of the ON/OFF
 *  comparison (which needs to isolate the semantic/vector leg). */
const QUERY_MARK = 'ZQXQUERYFORDETAIL5';
const DIST_MARK = 'ZQXDISTRACTORTOKEN9';
const MATCH_MARK = 'ZQXMATCHTOKEN3';
const DENSITY_SCALE = 10;

function vec(cos: number): number[] {
    const c = Math.max(-1, Math.min(1, cos));
    const sin = Math.sqrt(Math.max(0, 1 - c * c));
    return [c, sin];
}
function countOccurrences(text: string, marker: string): number {
    let count = 0, from = 0;
    for (;;) {
        const idx = text.indexOf(marker, from);
        if (idx === -1) return count;
        count++;
        from = idx + marker.length;
    }
}

/** Deterministic fixed-vector provider, no ONNX load. See file header for
 *  the three-marker scheme. No `splitIntoWindows` — buildPieces falls back
 *  to the fixed 480/120 char window (pieceLayout.ts's charWindows), which
 *  is what lets the fixtures below place a marker in a SPECIFIC window by
 *  character offset. */
class PieceE2EProvider implements EmbeddingProvider {
    readonly dimension = DIM;
    readonly modelId = 'd7-e2e-fixed';
    readonly dtype = 'fp32';
    async initialize(): Promise<void> {}
    async embedQuery(text: string): Promise<number[]> {
        return vec(text.includes(MATCH_MARK) || text.includes(QUERY_MARK) ? 1 : 0);
    }
    async embed(text: string): Promise<number[]> { return this.embedDocument(text); }
    async embedDocument(text: string): Promise<number[]> {
        const occ = countOccurrences(text, DETAIL_MARK);
        if (occ > 0) {
            const density = (occ * DETAIL_MARK.length) / text.length;
            return vec(Math.min(0.98, density * DENSITY_SCALE));
        }
        if (text.includes(DIST_MARK)) return vec(0.5);
        if (text.includes(MATCH_MARK)) return vec(1);
        return vec(0);
    }
    // bulkIngest's sync-mode embed step calls embedDocumentBatch
    // unconditionally (non-null-asserted) whenever embed:'sync' is used
    // with a non-null provider — an optional interface member other real
    // providers (localEmbeddingProvider.ts, openAICompatEmbeddingProvider.ts)
    // always implement. Without it every bulkIngest() call in this file
    // silently fails its vector-write step (caught internally, never
    // surfaced to the caller), leaving nodes findable only via BM25/FTS
    // on their canonical text — masking genuine semantic-leg bugs.
    async embedDocumentBatch(texts: string[]): Promise<number[][]> {
        return Promise.all(texts.map((t) => this.embedDocument(t)));
    }
}

function tmpDataDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'd7-recall-e2e-'));
}

async function connectRecallClient(lore: Awaited<ReturnType<typeof createLore>>): Promise<Client> {
    const mcpServer = lore.createMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    const client = new Client({ name: 'd7-recall-e2e-test', version: '0.0.1' });
    await client.connect(clientTransport);
    return client;
}

async function recall(client: Client, args: Record<string, unknown>): Promise<RecallSummaryLike> {
    const result = await client.callTool({ name: 'recall', arguments: args }) as unknown as ToolTextResult;
    assert.ok(!result.isError, `recall tool errored: ${JSON.stringify(result)}`);
    return parseToolText<RecallSummaryLike>(result);
}

/** Body text with DETAIL_MARK placed so it lands ONLY in the body's LAST
 *  480/120 char window (verified by hand against pieceLayout.ts's
 *  charWindows break-early loop — see file header), plus a second, weaker
 *  occurrence placed so it lands ONLY in an EARLIER window (window index
 *  2), for the "several pieces, node score = max piece" case. */
function buriedDetailBody(): string {
    const base = 'x'.repeat(2000) + DETAIL_MARK; // marker at [2000,2020)
    return base.slice(0, 900) + DETAIL_MARK + base.slice(900); // + weak occurrence at [900,920)
}

function distractorContent(n: number): string {
    return `${DIST_MARK} distractor filler row ${n}`;
}

async function makeLore(dataDir: string, pieceVectors: boolean | undefined): Promise<Awaited<ReturnType<typeof createLore>>> {
    return createLore({
        dataDir, deploymentMode: 'embedded',
        embeddingProvider: new PieceE2EProvider(),
        ...(pieceVectors === undefined ? {} : { pieceVectors }),
    });
}

/* ── (a) + (b): buried-last-window ranking, ON vs OFF; several pieces ── */

async function testBuriedDetailRanking(): Promise<void> {
    const buildFixture = () => [
        { id: 'target', workspace: 'default', ecosystem: '*', nodeData: { id: 'target', type: 'knowledge', label: 'Target Node', content: buriedDetailBody(), project: 'default', ecosystem: '*' } },
        ...Array.from({ length: 3 }, (_, n) => ({
            id: `distractor-${n}`, workspace: 'default', ecosystem: '*',
            nodeData: { id: `distractor-${n}`, type: 'knowledge', label: `Distractor ${n}`, content: distractorContent(n), project: 'default', ecosystem: '*' },
        })),
        ...Array.from({ length: 5 }, (_, n) => ({
            id: `filler-${n}`, workspace: 'default', ecosystem: '*',
            nodeData: { id: `filler-${n}`, type: 'knowledge', label: `Filler ${n}`, content: `plain unrelated filler row ${n}`, project: 'default', ecosystem: '*' },
        })),
    ];

    const dataDirOn = tmpDataDir();
    const loreOn = await makeLore(dataDirOn, true);
    try {
        await loreOn.bulkIngest(buildFixture(), { autolink: false, embed: 'sync' });
        const client = await connectRecallClient(loreOn);

        await test('[pieces ON] node whose answer lives only in its last body window ranks top-3', async () => {
            const r = await recall(client, { topic: QUERY_MARK, types: ['knowledge'], workspace: 'default', search_mode: 'semantic', mode: 'summary' });
            const top3 = r.hits.slice(0, 3).map((h) => h.id);
            assert.ok(top3.includes('target'), `expected 'target' in top-3, got ${JSON.stringify(top3)}`);
            assert.equal(r._meta.piece_vectors?.status, 'active', `expected active piece routing, got ${JSON.stringify(r._meta.piece_vectors)}`);
        });

        await test('[pieces ON] several qualifying pieces of one node still count once (no duplicate hit)', async () => {
            const r = await recall(client, { topic: QUERY_MARK, types: ['knowledge'], workspace: 'default', search_mode: 'semantic', mode: 'summary', limit: 20 });
            const occurrences = r.hits.filter((h) => h.id === 'target').length;
            assert.equal(occurrences, 1, `expected 'target' exactly once in hits, got ${occurrences} (${JSON.stringify(r.hits.map((h) => h.id))})`);
        });
    } finally {
        await loreOn.dispose();
    }

    const dataDirOff = tmpDataDir();
    const loreOff = await makeLore(dataDirOff, false);
    try {
        await loreOff.bulkIngest(buildFixture(), { autolink: false, embed: 'sync' });
        const client = await connectRecallClient(loreOff);

        await test('[pieces OFF] the SAME buried-detail node does NOT rank top-3 (pooled dilution)', async () => {
            const r = await recall(client, { topic: QUERY_MARK, types: ['knowledge'], workspace: 'default', search_mode: 'semantic', mode: 'summary' });
            const top3 = r.hits.slice(0, 3).map((h) => h.id);
            assert.ok(!top3.includes('target'), `expected 'target' NOT in top-3 with pieces off, got ${JSON.stringify(top3)}`);
            assert.equal(r._meta.piece_vectors, undefined, `expected _meta.piece_vectors absent when intent is off, got ${JSON.stringify(r._meta.piece_vectors)}`);
        });
    } finally {
        await loreOff.dispose();
    }
}

/* ── (c): D2 types + actor-scope pushdown, through piece routing ──────── */

async function testTypeAndActorScopePushdown(): Promise<void> {
    const dataDir = tmpDataDir();
    const lore = await makeLore(dataDir, true);
    try {
        await lore.bulkIngest([
            { id: 'allowed', workspace: 'default', ecosystem: '*', nodeData: { id: 'allowed', type: 'knowledge', label: 'Allowed', content: `${MATCH_MARK} public knowledge row`, project: 'default', ecosystem: '*', security_scopes: [] } },
            { id: 'wrong-type', workspace: 'default', ecosystem: '*', nodeData: { id: 'wrong-type', type: 'chat', label: 'Wrong Type', content: `${MATCH_MARK} chat row, not knowledge`, project: 'default', ecosystem: '*', security_scopes: [] } },
            { id: 'scoped', workspace: 'default', ecosystem: '*', nodeData: { id: 'scoped', type: 'knowledge', label: 'Scoped', content: `${MATCH_MARK} finance-only knowledge row`, project: 'default', ecosystem: '*', security_scopes: ['finance'] } },
        ], { autolink: false, embed: 'sync' });
        const client = await connectRecallClient(lore);

        await runWithActor({ portalUserId: 'test-user', scopes: [] }, async () => {
            await test('[pieces ON] D2 types filter still applies (excludes wrong-type)', async () => {
                const r = await recall(client, { topic: MATCH_MARK, types: ['knowledge'], workspace: 'default', search_mode: 'semantic', mode: 'summary' });
                const ids = r.hits.map((h) => h.id);
                assert.ok(!ids.includes('wrong-type'), `expected 'wrong-type' excluded by types filter, got ${JSON.stringify(ids)}`);
            });

            await test('[pieces ON] actor-scope pushdown still applies (excludes finance-scoped row for a no-scope actor)', async () => {
                const r = await recall(client, { topic: MATCH_MARK, types: ['knowledge'], workspace: 'default', search_mode: 'semantic', mode: 'summary' });
                const ids = r.hits.map((h) => h.id);
                assert.ok(ids.includes('allowed'), `expected 'allowed' present, got ${JSON.stringify(ids)}`);
                assert.ok(!ids.includes('scoped'), `expected 'scoped' excluded for a no-scope actor, got ${JSON.stringify(ids)}`);
            });
        });
    } finally {
        await lore.dispose();
    }
}

/* ── (d): D5 supersession still replaces, through piece routing ───────── */

async function testSupersessionStillReplaces(): Promise<void> {
    const dataDir = tmpDataDir();
    const lore = await makeLore(dataDir, true);
    try {
        await lore.bulkIngest([
            { id: 'old', workspace: 'default', ecosystem: '*', nodeData: { id: 'old', type: 'decision', label: 'Old Decision', content: `${MATCH_MARK} the old, stale answer`, project: 'default', ecosystem: '*' }, supersedes: [] },
        ], { autolink: false, embed: 'sync' });
        await lore.bulkIngest([
            { id: 'new', workspace: 'default', ecosystem: '*', nodeData: { id: 'new', type: 'decision', label: 'New Decision', content: `${MATCH_MARK} the new, current answer`, project: 'default', ecosystem: '*' }, supersedes: ['old'] },
        ], { autolink: false, embed: 'sync' });
        const client = await connectRecallClient(lore);

        await test('[pieces ON] D5 supersession still replaces the old node with its successor', async () => {
            const r = await recall(client, { topic: MATCH_MARK, workspace: 'default', search_mode: 'semantic', mode: 'summary' });
            const ids = r.hits.map((h) => h.id);
            assert.ok(ids.includes('new'), `expected successor 'new' present, got ${JSON.stringify(ids)}`);
            assert.ok(!ids.includes('old'), `expected superseded 'old' NOT present, got ${JSON.stringify(ids)}`);
        });
    } finally {
        await lore.dispose();
    }
}

/* ── (e): workspace:'*' (cross-workspace recall) uses pieces ──────────── */

async function testCrossWorkspaceUsesPieces(): Promise<void> {
    const dataDir = tmpDataDir();
    const lore = await makeLore(dataDir, true);
    try {
        // Ingested into 'default' (already auto-registered/active for an
        // embedded createLore() instance) rather than a fresh workspace
        // name — a genuine multi-workspace fan-out would need the heavier
        // workspaces.json-seeding harness used by
        // test/phase6-p1c-stdio-and-cross-workspace-unit.ts, which is out
        // of scope here. This still exercises the actual D7b code path
        // under test (the piece-routing call sites inside
        // runCrossWorkspaceRecall), just over a single already-registered
        // workspace reached via workspace:'*'.
        await lore.bulkIngest([
            { id: 'xw-target', workspace: 'default', ecosystem: '*', nodeData: { id: 'xw-target', type: 'knowledge', label: 'Cross-workspace target', content: `${MATCH_MARK} lives only in default`, project: 'default', ecosystem: '*' } },
        ], { autolink: false, embed: 'sync' });
        const client = await connectRecallClient(lore);

        await test("[pieces ON] workspace:'*' cross-workspace recall routes the semantic leg through pieces", async () => {
            const r = await recall(client, { topic: MATCH_MARK, workspace: '*', search_mode: 'semantic', mode: 'summary' });
            const ids = r.hits.map((h) => h.id);
            assert.ok(ids.includes('xw-target'), `expected 'xw-target' via cross-workspace recall, got ${JSON.stringify(ids)}`);
            assert.equal(r._meta.piece_vectors?.status, 'active', `expected active piece routing on the cross-workspace path, got ${JSON.stringify(r._meta.piece_vectors)}`);
        });
    } finally {
        await lore.dispose();
    }
}

/* ── (f): _meta.piece_vectors.status values (active / off / not_built) ── */

async function testStatusValues(): Promise<void> {
    // 'active' and 'off' are already asserted directly inside (a)'s ON/OFF
    // pair above; this covers 'not_built'. pieceIndex.initialize() opens/
    // creates a valid (empty) sidecar immediately at store-open time
    // whenever intent is on, REGARDLESS of whether the canonical store has
    // any documents yet — so "intent on, zero ingested documents" yields
    // 'active', not 'not_built'. To reach 'not_built' the canonical store
    // must have pre-existing data with no sidecar ever built for it: open
    // without pieceVectors, ingest, close, then reopen the SAME dataDir
    // with pieceVectors:true. D7b's write-path hooks only maintain a
    // sidecar prospectively — they never retroactively backfill one for
    // data that predates it (that backfill is D7c's out-of-scope `lore
    // migrate piece-vectors` / buildPieceIndex).
    const dataDir = tmpDataDir();
    const loreNoPieces = await makeLore(dataDir, false);
    try {
        await loreNoPieces.bulkIngest([
            { id: 'preexisting', workspace: 'default', ecosystem: '*', nodeData: { id: 'preexisting', type: 'knowledge', label: 'Preexisting', content: `${MATCH_MARK} ingested before pieces were ever turned on`, project: 'default', ecosystem: '*' } },
        ], { autolink: false, embed: 'sync' });
    } finally {
        await loreNoPieces.dispose();
    }

    const lore = await makeLore(dataDir, true);
    try {
        const client = await connectRecallClient(lore);
        await test("[pieces ON, reopened over pre-existing canonical data] _meta.piece_vectors.status is 'not_built' before any sidecar has been built", async () => {
            const r = await recall(client, { topic: MATCH_MARK, workspace: 'default', search_mode: 'semantic', mode: 'summary' });
            assert.equal(r._meta.piece_vectors?.status, 'not_built', `expected 'not_built', got ${JSON.stringify(r._meta.piece_vectors)}`);
        });
    } finally {
        await lore.dispose();
    }
}

async function main(): Promise<void> {
    console.log('d7-piece-recall-unit\n');
    await testBuriedDetailRanking();
    await testTypeAndActorScopePushdown();
    await testSupersessionStillReplaces();
    await testCrossWorkspaceUsesPieces();
    await testStatusValues();

    console.log(`\n${passed} passed, ${failed} failed\n`);
    if (failed > 0) process.exit(1);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
