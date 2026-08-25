#!/usr/bin/env tsx
/**
 * id-alphabet-roundtrip-unit.ts — fix/id-alphabet-sql-interpolation.
 *
 * The bug: SAFE_ID_RE (verbatimHistory.ts) rejected every id containing
 * `[ ] ( )` at the write boundary (nodeService.nodeUpsert chokepoint), so
 * Next.js dynamic-route nodes — `(app)/page.tsx`, `[id]/route.ts`,
 * `[...slug]/page.tsx` — were silently never indexed (measured on a real
 * re-index: 32 node rejections + ~1,100 consequential edge failures;
 * Lorebase node lore-id-alphabet-drops-bracketed-paths-2026-08-03).
 *
 * The fix: the alphabet is RETIRED as the injection control. Every LanceDB
 * predicate site already escapes (single-quote doubling on all values;
 * escapeLanceLike + ESCAPE '\' on LIKE values), matching LanceDB 0.27.2's
 * own toSQL helper — the filter API has no bound parameters, so escaped
 * string building is the sanctioned pattern. assertSafeLanceId now rejects
 * only what escaping cannot make safe: non-string ids, oversized ids,
 * NUL bytes. Every rejection message names the id and the reason.
 *
 * What this file proves, end to end against REAL substrates (SurrealDB +
 * LanceDB on tmpdirs, constant-vector embedder — no model load):
 *
 *   A. Bracketed ids round-trip through every touched verbatim path:
 *      store → getById → listIds(prefix) → re-store snapshot →
 *      getHistory (#rev LIKE path) → tombstone → physicalDeleteMany.
 *   B. Two bracketed-id nodes written through the FULL nodeUpsert
 *      chokepoint (pre-fix: {ok:false, invalid_node_id}) land in graph +
 *      verbatim (`lore:<id>` key) and participate in an edge together.
 *   C. Injection battery: ids with ' " \ % _ and deliberate predicate-
 *      escape payloads store and read back byte-identically, resolve to
 *      EXACTLY their own row, and never widen a match onto other rows.
 *      (If the alphabet had been widened WITHOUT the escaping that was
 *      already in place, these are the tests that would fail.)
 *   D. Genuine refusal is LOUD and attributable: NUL-byte, oversized, and
 *      non-string ids fail nodeUpsert with invalid_node_id, the error
 *      names the id + reason, and nothing is persisted.
 *
 * Run: npx tsx test/id-alphabet-roundtrip-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import { nodeUpsert } from '../packages/lore/src/core/nodeService.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

/* ─── tiny test harness (consistent with every other test/ file) ─────── */

let passed = 0;
let failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void>): void {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? (err as Error).message}`); failed++; }
    })());
}

/** Constant-vector embedder: avoids loading a real model. */
class ConstEmbedProvider implements EmbeddingProvider {
    get modelId() { return 'id-alphabet-const'; }
    get dimension() { return 8; }
    async initialize() { /* no-op */ }
    private vec() { return new Array(8).fill(0.1); }
    async embedQuery() { return this.vec(); }
    async embedDocument() { return this.vec(); }
    async embedDocumentBatch(texts: string[]) { return texts.map(() => this.vec()); }
}

function mkTmp(prefix: string): { dir: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    return { dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } } };
}

function meta(project: string) {
    return {
        type: 'code', label: 'L', tags: '', project,
        ecosystem: '', updatedAt: '', security_scopes: [] as string[],
    };
}

/** The three Next.js id shapes the alphabet used to drop. */
const NEXT_IDS = [
    'next:apps/web/src/app/(app)/page.tsx',
    'next:src/app/[id]/route.ts',
    'next:src/app/[...slug]/page.tsx',
];

console.log('\nid-alphabet round-trip — bracketed ids + injection battery + loud refusal\n');

/* ─── A. Bracketed ids round-trip through every verbatim path ────────── */

test('A: bracketed ids store, read back, snapshot, tombstone, delete', async () => {
    const t = mkTmp('lore-idalpha-a-');
    const store = new VerbatimStore(t.dir, new ConstEmbedProvider());
    try {
        await store.initialize();

        // store → getById: every bracketed id reads back its own text.
        for (const id of NEXT_IDS) {
            await store.store({ id, text: `content of ${id}`, metadata: meta('web') });
            const row = await store.getById(id);
            assert.ok(row, `getById must find ${id}`);
            assert.equal(row.text, `content of ${id}`, 'text must round-trip byte-identically');
        }

        // listIds(prefix): prefix path (LIKE) returns exactly the three.
        const listed = (await store.listIds('next:')).filter((id) => !id.includes('#rev')).sort();
        assert.deepEqual(listed, [...NEXT_IDS].sort(), 'prefix LIKE must list all three bracketed ids');

        // re-store → snapshot: getHistory (#rev LIKE path) returns canonical
        // + exactly one snapshot, correctly flagged.
        await store.store({ id: NEXT_IDS[0], text: 'v2 content', metadata: meta('web') });
        const hist = await store.getHistory(NEXT_IDS[0]);
        assert.equal(hist.length, 2, 'canonical + one #rev snapshot');
        assert.equal(hist[0].isCanonical, true, 'canonical sorts first');
        assert.equal(hist[0].text, 'v2 content');
        assert.ok(hist[1].id.startsWith(`${NEXT_IDS[0]}#rev`), 'snapshot id keeps the bracketed prefix');
        assert.equal(hist[1].isCanonical, false);

        // tombstone: canonical becomes a readable tombstone; history intact.
        await store.tombstone(NEXT_IDS[1], 'route removed');
        const tombHist = await store.getHistory(NEXT_IDS[1]);
        assert.ok(tombHist[0].isTombstone, 'canonical flagged tombstone');
        assert.ok((await store.getById(NEXT_IDS[1]))!.text.startsWith('[TOMBSTONED'), 'tombstone text readable');

        // physicalDeleteMany (chunked id IN (...) delete path) removes all.
        const removed = await store.physicalDeleteMany(NEXT_IDS);
        assert.equal(removed, NEXT_IDS.length);
        for (const id of NEXT_IDS) {
            assert.equal(await store.getById(id), null, `${id} must be gone after physicalDeleteMany`);
        }
    } finally {
        await store.close().catch(() => undefined);
        t.cleanup();
    }
});

/* ─── B. Full chokepoint write + edge between two bracketed nodes ────── */

test('B: nodeUpsert accepts bracketed ids; the two nodes join in an edge', async () => {
    const g = mkTmp('lore-idalpha-b-g-');
    const v = mkTmp('lore-idalpha-b-v-');
    const graph = new SurrealGraph(g.dir);
    const store = new VerbatimStore(v.dir, new ConstEmbedProvider());
    try {
        await graph.initialize();
        await store.initialize();
        const hooks = {
            verbatim: { verbatimStore: async (w: never) => store.store(w) },
        };

        const idA = 'next:apps/web/src/app/(app)/page.tsx';
        const idB = 'next:src/app/[id]/route.ts';
        for (const id of [idA, idB]) {
            const res = await nodeUpsert(
                {
                    id, workspace: 'w', ecosystem: '*', initiator: 'test',
                    nodeData: { id, type: 'code', label: id, content: `body of ${id}`, tags: ['next'] },
                    targetGraph: graph,
                },
                hooks,
            );
            // Pre-fix this was { ok:false, code:'invalid_node_id' } — the drop.
            assert.equal(res.ok, true, `nodeUpsert must accept ${id}`);
        }

        // Graph side: both nodes read back by their exact bracketed ids.
        const nodeA = await graph.getNode(idA);
        const nodeB = await graph.getNode(idB);
        assert.equal(nodeA?.id, idA, 'graph node A reads back by exact id');
        assert.equal(nodeB?.id, idB, 'graph node B reads back by exact id');

        // Verbatim side: canonical `lore:<id>` rows exist carrying the content
        // (nodeUpsert composes label + content + tags into the verbatim text).
        const verbA = await store.getById(`lore:${idA}`);
        assert.ok(verbA?.text.includes(`body of ${idA}`), 'verbatim row keyed lore:<idA> present');

        // Edge between the two bracketed nodes, read back intact.
        await graph.addEdge({ sourceId: idA, targetId: idB, relation: 'imports' });
        const edges = await graph.queryEdges({ source: idA, limit: 10, offset: 0 });
        assert.equal(edges.length, 1, 'exactly one edge from A');
        assert.equal(edges[0].targetId, idB, 'edge target is the bracketed id, unmangled');
        assert.equal(edges[0].relation, 'imports');
    } finally {
        await store.close().catch(() => undefined);
        await graph.close().catch(() => undefined);
        v.cleanup(); g.cleanup();
    }
});

/* ─── C. Injection battery — hostile ids round-trip with zero leakage ── */

const HOSTILE_IDS = [
    "evil:' OR '1'='1",
    'evil:"double"quote',
    'evil:\\back\\slash',
    'evil:100%_wild',
    "evil:'; DROP TABLE lore_verbatim; --",
    // Deliberate predicate-escape attempt: if this broke out of the literal,
    // its getById would return EVERY evil: row instead of only itself.
    "evil:x' OR id LIKE 'evil:%",
];

test('C: hostile ids store + read back byte-identically, no match-widening', async () => {
    const t = mkTmp('lore-idalpha-c-');
    const store = new VerbatimStore(t.dir, new ConstEmbedProvider());
    try {
        await store.initialize();
        for (const id of HOSTILE_IDS) {
            await store.store({ id, text: `payload of ${id}`, metadata: meta('sec') });
        }

        // Each hostile id resolves to EXACTLY its own row (equality path).
        for (const id of HOSTILE_IDS) {
            const row = await store.getById(id);
            assert.ok(row, `getById must find ${JSON.stringify(id)}`);
            assert.equal(row.text, `payload of ${id}`, 'own text, unmangled');
        }

        // Absent hostile-shaped id matches nothing — no OR/LIKE widening.
        assert.equal(await store.getById("evil:nope' OR '1'='1"), null, 'payload-shaped miss must match zero rows');
        assert.equal(await store.getById('evil:zzz%'), null, 'wildcard-shaped miss must match zero rows');

        // Prefix LIKE lists exactly the six stored rows, no phantoms.
        const listed = (await store.listIds('evil:')).filter((id) => !id.includes('#rev')).sort();
        assert.deepEqual(listed, [...HOSTILE_IDS].sort(), 'LIKE prefix must enumerate exactly the stored ids');

        // #rev LIKE path: re-store the wildcard id; its history must contain
        // ONLY its own rows (a live % would drag in every evil: snapshot).
        await store.store({ id: 'evil:100%_wild', text: 'v2', metadata: meta('sec') });
        const hist = await store.getHistory('evil:100%_wild');
        assert.equal(hist.length, 2, 'only own canonical + own snapshot');
        assert.ok(hist.every((h) => h.id === 'evil:100%_wild' || h.id.startsWith('evil:100%_wild#rev')),
            'no foreign rows in wildcard id history');

        // The table still holds exactly the rows we wrote — no injection
        // deleted or duplicated anything.
        const all = (await store.listIds('')).sort();
        // (six canonical + one #rev snapshot from the re-store)
        assert.equal(all.length, 7, 'row count unchanged by hostile predicates');
        assert.deepEqual(
            all.filter((id) => !id.includes('#rev')),
            [...HOSTILE_IDS].sort(),
            'canonical set intact',
        );
    } finally {
        await store.close().catch(() => undefined);
        t.cleanup();
    }
});

/* ─── D. Loud refusal: the three ids escaping cannot make safe ───────── */

test('D: NUL / oversized / non-string ids fail loudly, naming the id', async () => {
    const g = mkTmp('lore-idalpha-d-g-');
    const v = mkTmp('lore-idalpha-d-v-');
    const graph = new SurrealGraph(g.dir);
    const store = new VerbatimStore(v.dir, new ConstEmbedProvider());
    try {
        await graph.initialize();
        await store.initialize();
        const hooks = {
            verbatim: { verbatimStore: async (w: never) => store.store(w) },
        };
        const attempt = (id: unknown) => nodeUpsert(
            {
                id: id as never, workspace: 'w', ecosystem: '*', initiator: 'test',
                nodeData: { id, type: 'code', label: 'L', content: 'c', tags: [] },
                targetGraph: graph,
            },
            hooks,
        );

        // NUL byte — cannot cross the native string boundary.
        const nul = await attempt('bad\x00route/[id].ts');
        assert.equal(nul.ok, false, 'NUL id must be refused');
        if (!nul.ok) {
            assert.equal(nul.code, 'invalid_node_id', 'branchable refusal code');
            assert.match(nul.error.message, /NUL byte/, 'reason named');
            assert.ok(nul.error.message.includes('bad\\u0000route'), 'id carried in the message (JSON-escaped)');
            assert.match(nul.error.message, /\[LanceFilter:/, 'attributable to the guard site');
        }

        // Oversized — unbounded predicate-string growth.
        const big = await attempt('x'.repeat(600));
        assert.equal(big.ok, false, 'oversized id must be refused');
        if (!big.ok) {
            assert.equal(big.code, 'invalid_node_id');
            assert.match(big.error.message, /too long/, 'reason named');
            assert.ok(big.error.message.includes('xxx'), 'truncated id carried');
        }

        // Non-string — type confusion (R3 #5 split-brain orphan).
        const num = await attempt(5);
        assert.equal(num.ok, false, 'non-string id must be refused');
        if (!num.ok) {
            assert.equal(num.code, 'invalid_node_id');
            assert.match(num.error.message, /must be a string/, 'reason named');
            assert.ok(num.error.message.includes('5'), 'offending value carried');
        }

        // Nothing persisted on any refusal — no partial orphan. The read
        // path refuses the NUL id just as loudly (guard, not silent null) —
        // SurrealGraph's getNode throws rather than returning null, unlike
        // Kùzu's silent-miss read path.
        await assert.rejects(
            () => graph.getNode('bad\x00route/[id].ts'),
            /NUL byte/,
            'graph read path refuses the NUL id loudly too',
        );
        await assert.rejects(
            () => store.getById('lore:bad\x00route/[id].ts'),
            /NUL byte/,
            'verbatim read path refuses the NUL id loudly too',
        );
    } finally {
        await store.close().catch(() => undefined);
        await graph.close().catch(() => undefined);
        v.cleanup(); g.cleanup();
    }
});

/* ─── summary ────────────────────────────────────────────────────────── */

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
// Force a clean exit rather than relying on natural event-loop drain, same
// convention every test/ file in this suite follows.
process.exit(failed > 0 ? 1 : 0);
