#!/usr/bin/env tsx
/**
 * test/d7-piece-vectors-e2e.ts — D7b (3.23, piece-level vectors), mandatory
 * integration trace per DESIGN-3.23.md section 5 ("Integration verification
 * (mandatory)"). Not a substitute for T1 (storage layer,
 * d7-piece-index-unit.ts) or T2 (retrieval-routing surface coverage,
 * d7-piece-recall-unit.ts) — those already own ranking-quality nuance
 * (buried-window ranking, max-piece grouping, D2/D5/actor-scope/cross-
 * workspace correctness). This file's ONLY job is to walk the actual
 * production path end to end once per substrate and prove the wiring is
 * real, per the design doc's own trace steps:
 *
 *   1. createLore({ dataDir, ownsProcess:false, pieceVectors:true, an
 *      injected deterministic embedder }) on a fresh workspace (SQLite by
 *      default).
 *   2. Store 30 nodes through the PUBLIC store API — lore.nodeUpsert(),
 *      the same nodeService orchestration the MCP store_node tool and
 *      POST /api/node use (never bulkIngest, which is a separate,
 *      optimised path) — including one long-body target.
 *   3. Assert the SQLite `verbatim_pieces` row count is greater than the
 *      node count, and the piece-layout sidecar has `complete:true`.
 *   4. Recall through the MCP recall tool handler AND through
 *      lore.recall().
 *   5. Assert `_meta.piece_vectors.status === 'active'` and the target
 *      ranks #1 on both surfaces.
 *   6. Repeat with `LORE_DEFAULT_VECTOR_ENGINE=lance`.
 *   7. Tombstone the target through the delete_node tool and assert its
 *      piece rows are gone.
 *
 * Ownership note (design section 6): recallTool.ts and inProcessRecall.ts
 * are D8-owned files this slice must never touch (edit OR import). Both are
 * reached here only indirectly — through `lore.createMcpServer()` (which
 * registers recallTool.ts's tool internally) and the public
 * `lore.recall()` method (implemented via inProcessRecall.ts internally) —
 * exactly the same non-invasive pattern already used by
 * d7-piece-recall-unit.ts (T2). This is why the MCP-tool-handler leg below
 * goes through a real `McpServer` + `InMemoryTransport` + `Client` (calling
 * the actual registered tool handler) rather than d5-recall-surfaces-
 * supersession-unit.ts's alternative technique of importing a tool's own
 * `registerXTool()` and capturing its handler directly — that technique is
 * only safe for tools D7b is allowed to import (searchTool.ts,
 * deleteNode.ts are not on the forbidden list), and recall's registration
 * function lives in the forbidden recallTool.ts.
 *
 * Registered as `test:unit:d7-piece-vectors-e2e` (single script — the
 * engine repeat in step 6 is driven INTERNALLY by this file via a runtime
 * `LORE_DEFAULT_VECTOR_ENGINE` mutation between two fresh dataDirs, not by
 * two separate npm script variants like T1/T2's `:sqlite` convention,
 * since the design's own step 6 frames it as "repeat", inside one trace,
 * not a parallel test file).
 *
 * Run: npx tsx test/d7-piece-vectors-e2e.ts
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createLore } from '../packages/lore/src/index.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';
import { readPieceSidecar } from '../packages/lore/src/engines/pieces/pieceLayout.js';

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

/* ── deterministic, no-ONNX-load embedder (same 2-D cosine technique as
 * d7-piece-recall-unit.ts's PieceE2EProvider) ────────────────────────── */

const DIM = 2;
const DETAIL_MARK = 'ZQXE2EDETAILTOKEN4';
const QUERY_MARK = 'ZQXE2EQUERYTOKEN6';
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

class PieceE2EProvider implements EmbeddingProvider {
    readonly dimension = DIM;
    readonly modelId = 'd7-e2e-trace-fixed';
    readonly dtype = 'fp32';
    async initialize(): Promise<void> {}
    async embedQuery(text: string): Promise<number[]> {
        return vec(text.includes(QUERY_MARK) ? 1 : 0);
    }
    async embed(text: string): Promise<number[]> { return this.embedDocument(text); }
    async embedDocument(text: string): Promise<number[]> {
        const occ = countOccurrences(text, DETAIL_MARK);
        if (occ === 0) return vec(0);
        const density = (occ * DETAIL_MARK.length) / text.length;
        return vec(Math.min(0.98, density * DENSITY_SCALE));
    }
    async embedDocumentBatch(texts: string[]): Promise<number[][]> {
        return Promise.all(texts.map((t) => this.embedDocument(t)));
    }
}

function tmpDataDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'd7-e2e-'));
}

/** Body text with DETAIL_MARK placed so it lands ONLY in the body's LAST
 *  480/120-char window (pieceLayout.ts's char-window fallback — no
 *  splitIntoWindows on this fixture provider) — the pooled-body occurrence
 *  is diluted across ~2 KB of filler, but the SAME occurrence dominates its
 *  own small piece window. 30-node fixture per the design trace: 1
 *  long-body target + 29 short, marker-free filler rows. */
function longBody(): string {
    return 'x'.repeat(2000) + DETAIL_MARK;
}

interface FixtureNode { id: string; content: string }
function buildFixture(): FixtureNode[] {
    const nodes: FixtureNode[] = [{ id: 'target', content: longBody() }];
    for (let n = 0; n < 29; n++) {
        nodes.push({ id: `filler-${n}`, content: `plain unrelated filler row ${n}` });
    }
    return nodes;
}

async function storeFixture(lore: Awaited<ReturnType<typeof createLore>>, nodes: FixtureNode[]): Promise<void> {
    for (const n of nodes) {
        const result = await lore.nodeUpsert({
            id: n.id,
            workspace: 'default',
            ecosystem: '*',
            nodeData: { id: n.id, type: 'knowledge', label: `Label ${n.id}`, content: n.content, project: 'default', ecosystem: '*' },
        });
        assert.ok(result.ok, `nodeUpsert(${n.id}) failed: ${JSON.stringify(result)}`);
    }
    // Belt-and-suspenders: nodeUpsert() without asyncEmbed:true embeds
    // synchronously already, but this makes the guarantee explicit and
    // costs nothing when there is nothing left pending.
    await lore.awaitEmbeds();
}

async function connectRecallClient(lore: Awaited<ReturnType<typeof createLore>>): Promise<Client> {
    const mcpServer = lore.createMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    const client = new Client({ name: 'd7-piece-vectors-e2e-test', version: '0.0.1' });
    await client.connect(clientTransport);
    return client;
}

async function recallViaMcpTool(client: Client, topic: string): Promise<RecallSummaryLike> {
    const result = await client.callTool({
        name: 'recall',
        arguments: { topic, workspace: 'default', search_mode: 'semantic', mode: 'summary' },
    }) as unknown as ToolTextResult;
    assert.ok(!result.isError, `recall tool errored: ${JSON.stringify(result)}`);
    return parseToolText<RecallSummaryLike>(result);
}

/** Direct `verbatim_pieces` row count via a fresh, read-only better-sqlite3
 *  connection to `<dataDir>/.lore/verbatim.sqlite` — the SQLite-engine-
 *  specific check the design's step 3 calls for. Pieces live in the SAME
 *  database file as the canonical verbatim store (sqliteVerbatimSchema.ts),
 *  separate from `graph.sqlite`. */
function countPieceRows(dataDir: string, whereNodeId?: string): number {
    const dbPath = path.join(dataDir, '.lore', 'verbatim.sqlite');
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
        const row = whereNodeId
            ? db.prepare('SELECT count(*) as c FROM verbatim_pieces WHERE nodeId = ?').get(whereNodeId) as { c: number }
            : db.prepare('SELECT count(*) as c FROM verbatim_pieces').get() as { c: number };
        return row.c;
    } finally {
        db.close();
    }
}

/* ── SQLite trace (design steps 1-5, plus step 7's tombstone check) ────── */

async function runSqliteTrace(): Promise<void> {
    console.log('\nD7 integration trace — SQLite (default engine)');

    const dataDir = tmpDataDir();
    const nodes = buildFixture();
    const lore = await createLore({
        dataDir,
        deploymentMode: 'embedded',
        ownsProcess: false,
        pieceVectors: true,
        embeddingProvider: new PieceE2EProvider(),
    });
    try {
        await storeFixture(lore, nodes);

        await test('step 3: sidecar complete:true after storing 30 nodes via the public store API', async () => {
            const sidecar = readPieceSidecar(dataDir);
            assert.ok(sidecar, 'expected a piece-layout sidecar to exist');
            assert.equal(sidecar?.complete, true, `expected sidecar.complete === true, got ${JSON.stringify(sidecar)}`);
        });

        await test('step 3: SQLite verbatim_pieces row count exceeds the node count', async () => {
            const rows = countPieceRows(dataDir);
            assert.ok(rows > nodes.length, `expected verbatim_pieces rows (${rows}) > node count (${nodes.length})`);
        });

        const client = await connectRecallClient(lore);

        await test('step 4/5 [MCP recall tool]: _meta.piece_vectors.status is active and the target ranks #1', async () => {
            const r = await recallViaMcpTool(client, QUERY_MARK);
            assert.equal(r._meta.piece_vectors?.status, 'active', `expected active piece routing, got ${JSON.stringify(r._meta.piece_vectors)}`);
            assert.equal(r.hits[0]?.id, 'target', `expected 'target' at rank #1, got ${JSON.stringify(r.hits.map((h) => h.id))}`);
        });

        await test('step 4/5 [lore.recall()]: _meta.piece_vectors.status is active and the target ranks #1', async () => {
            const r = await lore.recall(QUERY_MARK, { workspace: 'default', searchMode: 'semantic', mode: 'summary' }) as unknown as RecallSummaryLike;
            assert.equal(r._meta.piece_vectors?.status, 'active', `expected active piece routing, got ${JSON.stringify(r._meta.piece_vectors)}`);
            assert.equal(r.hits[0]?.id, 'target', `expected 'target' at rank #1, got ${JSON.stringify(r.hits.map((h) => h.id))}`);
        });

        await test("step 7: delete_node tombstones the target and its piece rows are gone", async () => {
            // The raw verbatim_pieces.nodeId column holds the canonical
            // verbatim-store key ('lore:<id>'), not the bare node id —
            // confirmed empirically (a raw query for 'target' returns 0
            // rows while the DISTINCT nodeId for this fixture is
            // 'lore:target'). This is the same canonical prefix the
            // verbatim store uses everywhere else (e.g. tombstone() keys
            // off 'lore:<id>' internally); it's orthogonal to T1's own
            // nodeId assertions, which read the de-prefixed `nodeId` field
            // off `store.search()` hit objects, not this raw column.
            const canonicalKey = 'lore:target';
            const before = countPieceRows(dataDir, canonicalKey);
            assert.ok(before > 0, 'sanity: target must have piece rows before delete');
            const delResult = await client.callTool({ name: 'delete_node', arguments: { id: 'target', workspace: 'default' } }) as unknown as ToolTextResult;
            assert.ok(!delResult.isError, `delete_node errored: ${JSON.stringify(delResult)}`);
            const after = countPieceRows(dataDir, canonicalKey);
            assert.equal(after, 0, `expected 0 piece rows for 'target' after tombstone, got ${after}`);
        });
    } finally {
        await lore.dispose();
    }
}

/* ── Lance trace (design step 6: repeat with LORE_DEFAULT_VECTOR_ENGINE=lance) ── */

async function runLanceTrace(): Promise<void> {
    console.log('\nD7 integration trace — repeat with LORE_DEFAULT_VECTOR_ENGINE=lance');

    const dataDir = tmpDataDir();
    const nodes = buildFixture();

    // engines/vectorEngineSelector.ts / config/workspaces.ts read this env
    // var at loadWorkspaces()-time (workspace-creation time), not at module
    // import time, so a runtime mutation scoped to this one createLore()
    // call works correctly. Always restored in `finally`, even on failure,
    // so it can never bleed into anything else this process does later.
    const prevEngine = process.env['LORE_DEFAULT_VECTOR_ENGINE'];
    process.env['LORE_DEFAULT_VECTOR_ENGINE'] = 'lance';
    let lore: Awaited<ReturnType<typeof createLore>> | undefined;
    try {
        lore = await createLore({
            dataDir,
            deploymentMode: 'embedded',
            ownsProcess: false,
            pieceVectors: true,
            embeddingProvider: new PieceE2EProvider(),
        });
    } finally {
        if (prevEngine === undefined) delete process.env['LORE_DEFAULT_VECTOR_ENGINE'];
        else process.env['LORE_DEFAULT_VECTOR_ENGINE'] = prevEngine;
    }

    try {
        await storeFixture(lore, nodes);
        const client = await connectRecallClient(lore);

        await test('[lance] step 4/5 [MCP recall tool]: _meta.piece_vectors.status is active and the target ranks #1', async () => {
            const r = await recallViaMcpTool(client, QUERY_MARK);
            assert.equal(r._meta.piece_vectors?.status, 'active', `expected active piece routing, got ${JSON.stringify(r._meta.piece_vectors)}`);
            assert.equal(r.hits[0]?.id, 'target', `expected 'target' at rank #1, got ${JSON.stringify(r.hits.map((h) => h.id))}`);
        });

        await test('[lance] step 4/5 [lore.recall()]: _meta.piece_vectors.status is active and the target ranks #1', async () => {
            const r = await lore!.recall(QUERY_MARK, { workspace: 'default', searchMode: 'semantic', mode: 'summary' }) as unknown as RecallSummaryLike;
            assert.equal(r._meta.piece_vectors?.status, 'active', `expected active piece routing, got ${JSON.stringify(r._meta.piece_vectors)}`);
            assert.equal(r.hits[0]?.id, 'target', `expected 'target' at rank #1, got ${JSON.stringify(r.hits.map((h) => h.id))}`);
        });
    } finally {
        await lore.dispose();
    }
}

async function main(): Promise<void> {
    console.log('d7-piece-vectors-e2e\n');
    await runSqliteTrace();
    await runLanceTrace();

    console.log(`\n${passed} passed, ${failed} failed\n`);
    if (failed > 0) process.exit(1);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
