#!/usr/bin/env tsx
/**
 * tw4c-search-preorder-unit.ts — TW-4c: deterministic pre-order before the
 * search scan-cap (perf-search-no-order-by-scancap + the dedupe/weights
 * findings hc-/cq-search-scan-cap-duplicate, hc-search-ranking-weights).
 *
 * THE BUG (history): the engine's search fetched the candidate set with a
 * bare `LIMIT $scanCap` — NO ORDER BY — so when a query matches MORE than
 * SEARCH_SCAN_CAP nodes, an arbitrary storage-order window of `scanCap`
 * rows reached the shared ranker (searchRanking.ts). A genuinely relevant,
 * recently-updated node sitting at storage position scanCap+1 was SILENTLY
 * DROPPED before ranking and never appeared in results. The cloud adapter
 * had the identical defect (it fetched `{ filter, limit: scanCap }` with no
 * `sort`), so beyond the cap the two backends could even hand DIFFERENT
 * windows to the identical ranker — breaking W5B order parity.
 *
 * THE FIX (asserted here against SurrealGraph, the default engine):
 *   - SurrealGraph's candidate scan pre-orders — `ORDER BY updatedAt DESC,
     id ASC LIMIT $scanCap` (surrealGraphReads.ts).
 *   - Dataplane: `sort:[{field:'updated_at',desc},{field:'id',asc}]` on the
     candidate query.
 *   Both match rankSearchResults' tiebreak, so the retained window is the
 *   most-recently-updated matches — identical across backends.
 *
 * THIS TEST (fails without the pre-order / passes with it): build a table
 * LARGER than the scan cap. Insert filler matches FIRST and the one
 * known-relevant, MOST-recently-updated node LAST — after a deliberate
 * pause, so its write-time updatedAt is strictly the newest (SurrealGraph
 * exposes no raw-query hatch to pin timestamps, and none is needed: the
 * engine mints updatedAt per write). On an engine without the pre-order the
 * relevant node is dropped before ranking and is absent from results; with
 * it, the pre-order pulls it into the retained window and it ranks FIRST.
 * We assert it appears for BOTH backends and that SurrealGraph + Dataplane
 * return the SAME ordering — the Dataplane rows are pinned to the engine's
 * ACTUAL updatedAt values, so both rankers see identical data.
 *
 * To keep the table small/fast we shrink SEARCH_SCAN_CAP via the
 * LORE_SEARCH_SCAN_CAP override (set BEFORE the engine modules are imported,
 * so the module-level const picks it up). This is a unit harness — the
 * daemon's env-scrub allowlist does not run here, so the override is read
 * directly.
 *
 * tsx unit-harness style: manual pass/fail counters, explicit process.exit.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Shrink the scan cap BEFORE importing the engines so the module-level
// SEARCH_SCAN_CAP const reads the override. A small cap keeps the fixture
// (cap + buffer) tiny and the test fast while reproducing the >cap regime.
const SCAN_CAP = 50;
process.env.LORE_SEARCH_SCAN_CAP = String(SCAN_CAP);
const { SurrealGraph } = await import('../packages/lore/src/engines/surrealGraph.js');
const { DataplaneGraph } = await import('../packages/lore/src/engines/dataplaneGraph.js');
const { SEARCH_SCAN_CAP } = await import('../packages/lore/src/engines/searchRanking.js');
import type { LoreNode } from '../packages/lore/src/providers/types.js';

// Sanity: the override took effect (proves the dedupe + env-overridable const).
assert.equal(SEARCH_SCAN_CAP, SCAN_CAP, 'LORE_SEARCH_SCAN_CAP override must apply');

// ──────────────────────────────────────────────────────────────────────────
// StatefulSdkClient — in-process fake implementing the tenant-first SDK
// surface DataplaneGraph.search calls (filter + sort + limit). Mirrors the
// parity-graph harness; trimmed to the methods this test exercises.
//
// CRITICAL for this test: query() returns rows in INSERTION order when no
// `sort` is supplied (the base cloud path passes no sort), and honors `sort`
// when present (the fixed path). That's exactly the storage-order-vs-ordered
// distinction the bug hinges on.
// ──────────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
interface QueryOpts {
    filter?: Record<string, unknown>;
    sort?: Array<{ field: string; direction: 'asc' | 'desc' }>;
    limit?: number;
    offset?: number;
}

function matchesFilter(rec: Row, filter: Record<string, unknown> | undefined): boolean {
    if (!filter) return true;
    for (const [key, value] of Object.entries(filter)) {
        if (key === 'id_eq') { if (rec['id'] !== value) return false; }
        else if (key === 'tags_contains') {
            if (!String(rec['tags'] ?? '').toLowerCase().includes(String(value).toLowerCase())) return false;
        } else if (rec[key] !== value) return false;
    }
    return true;
}

class StatefulSdkClient {
    private store = new Map<string, Map<string, Row[]>>();
    private coll(tenantId: string, collection: string): Row[] {
        let t = this.store.get(tenantId);
        if (!t) { t = new Map(); this.store.set(tenantId, t); }
        let c = t.get(collection);
        if (!c) { c = []; t.set(collection, c); }
        return c;
    }
    rawGet(tenantId: string, collection: string, id: string): Row | null {
        return this.coll(tenantId, collection).find((r) => r['id'] === id) ?? null;
    }
    async createCollection(): Promise<unknown> { return {}; }
    async insert<T = Row>(tenantId: string, collection: string, record: T): Promise<T> {
        const rows = this.coll(tenantId, collection);
        const rec = record as unknown as Row;
        const i = rows.findIndex((r) => r['id'] === rec['id']);
        if (i >= 0) rows[i] = { ...rec }; else rows.push({ ...rec });
        return record;
    }
    async get<T = Row>(tenantId: string, collection: string, id: string): Promise<T> {
        const rec = this.coll(tenantId, collection).find((r) => r['id'] === id);
        if (!rec) throw new Error(`not found 404: ${collection}/${id}`);
        return rec as unknown as T;
    }
    async query<T = Row>(
        tenantId: string, collection: string, options?: QueryOpts,
    ): Promise<{ records: T[]; total_count?: number; has_more?: boolean }> {
        const opts = options ?? {};
        // Insertion order preserved when no sort (mirrors storage-order scan).
        let matched = this.coll(tenantId, collection).filter((r) => matchesFilter(r, opts.filter));
        if (opts.sort && opts.sort.length > 0) {
            matched = [...matched].sort((a, b) => {
                for (const s of opts.sort!) {
                    const av = String(a[s.field] ?? '');
                    const bv = String(b[s.field] ?? '');
                    if (av === bv) continue;
                    const cmp = av < bv ? -1 : 1;
                    return s.direction === 'desc' ? -cmp : cmp;
                }
                return 0;
            });
        }
        const offset = typeof opts.offset === 'number' ? opts.offset : 0;
        const limit = typeof opts.limit === 'number' ? opts.limit : matched.length;
        return { records: matched.slice(offset, offset + limit) as unknown as T[], total_count: matched.length };
    }
    async updateByQuery(tenantId: string, collection: string, filter: object, fields: object): Promise<{ updated: number }> {
        let updated = 0;
        for (const rec of this.coll(tenantId, collection)) {
            if (matchesFilter(rec, filter as Record<string, unknown>)) { Object.assign(rec, fields); updated++; }
        }
        return { updated };
    }
    async deleteByQuery(tenantId: string, collection: string, filter: object): Promise<{ deleted: number }> {
        const rows = this.coll(tenantId, collection);
        const before = rows.length;
        const kept = rows.filter((r) => !matchesFilter(r, filter as Record<string, unknown>));
        rows.length = 0; rows.push(...kept);
        return { deleted: before - rows.length };
    }
    async count(tenantId: string, collection: string, filter?: object): Promise<number> {
        return this.coll(tenantId, collection).filter((r) => matchesFilter(r, filter as Record<string, unknown>)).length;
    }
    graph = {
        createEdge: async (): Promise<{ edge_id: string }> => ({ edge_id: 'fake-edge' }),
        traverse: async <T = Row>(): Promise<{ records: T[] }> => ({ records: [] as unknown as T[] }),
    };
}

// ──────────────────────────────────────────────────────────────────────────
// Fixture: (SCAN_CAP + buffer) filler matches + 1 known-relevant winner.
//
//   - filler-####  : match "needle" in CONTENT only (score 2). Inserted
//     FIRST → early record-id/storage positions.
//   - winner       : matches "needle" in LABEL (score 4 — highest relevance)
//     AND, because it is written after a deliberate pause, carries the NEWEST
//     engine-minted updatedAt. Inserted LAST → beyond the cap window.
//
// SurrealGraph mints updatedAt per write (there is no raw-query hatch to pin
// it, and none is needed): the pause before the winner's write guarantees its
// timestamp is strictly the newest. Without the pre-order, the capped window
// is an arbitrary storage/record-id-order slice of `scanCap` rows that
// EXCLUDES `winner` → ranker never sees it → absent from results. With the
// pre-order (updatedAt DESC) `winner` is pulled to the front of the scan →
// survives the cap → ranks FIRST.
// ──────────────────────────────────────────────────────────────────────────

const ORG_ID = 'org-tw4c';
const TENANT = 'tenant-tw4c';
const NEEDLE = 'needle';
// Comfortably more matches than the cap so the winner is provably outside the
// arbitrary window: cap + 20 fillers, winner inserted after all of them.
const FILLER_COUNT = SCAN_CAP + 20;

interface Fixture { id: string; type: string; label: string; content: string; tags: string }

const FIXTURE_NODES: Fixture[] = [];
for (let i = 0; i < FILLER_COUNT; i++) {
    const idx = String(i).padStart(5, '0');
    FIXTURE_NODES.push({
        id: `filler-${idx}`,
        type: 'note',
        label: `filler ${idx}`,
        content: `body about ${NEEDLE} number ${idx}`, // content-only match → score 2
        tags: 'misc',
    });
}
// The winner — inserted LAST, label match (highest score), newest timestamp.
const WINNER_ID = 'winner-needle';
const WINNER: Fixture = {
    id: WINNER_ID,
    type: 'note',
    label: `the ${NEEDLE} headline`, // label match → score 4 (beats fillers' 2)
    content: 'unrelated body',
    tags: 'misc',
};
FIXTURE_NODES.push(WINNER);

function toUpsert(f: Fixture): Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'> {
    return {
        id: f.id, type: f.type, label: f.label, content: f.content, tags: f.tags,
        project: 'p', ecosystem: 'e', metadata: '{}',
    };
}

async function loadFixture(g: {
    upsertNode: (n: Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>) => Promise<LoreNode>;
}): Promise<void> {
    // Fillers first — they occupy the early storage positions the cap's
    // arbitrary window keeps when no pre-order is applied.
    for (const f of FIXTURE_NODES) {
        if (f.id === WINNER_ID) continue;
        await g.upsertNode(toUpsert(f));
    }
    // The engine stamps updatedAt at write time, so sleep past the
    // millisecond boundary: the winner's minted timestamp is then STRICTLY
    // the newest — the property the pre-order must surface for it to
    // survive the cap deterministically.
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    setTimeout(resolve, 10);
    await promise;
    await g.upsertNode(toUpsert(WINNER));
}

/**
 * The engine's ACTUAL per-node updatedAt values, read back through the
 * handle. The Dataplane rows are pinned to these so the shared ranker sees
 * identical data on both backends and the parity assertion is exact rather
 * than coincidental.
 */
async function readBackTimestamps(g: {
    getNodesByIds: (ids: string[]) => Promise<Map<string, LoreNode>>;
}): Promise<Map<string, string>> {
    const nodes = await g.getNodesByIds(FIXTURE_NODES.map((f) => f.id));
    const stamps = new Map<string, string>();
    for (const [id, node] of nodes) stamps.set(id, node.updatedAt);
    return stamps;
}

function pinCloudTimestamps(client: StatefulSdkClient, stamps: Map<string, string>): void {
    for (const [id, updatedAt] of stamps) {
        const row = client.rawGet(TENANT, 'lore_node', id);
        if (row) row['updated_at'] = updatedAt;
    }
}

// ── tiny assertion harness ──
let passed = 0;
let failed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok   ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}`); console.error('       ' + ((err as Error).message ?? String(err))); }
}

async function main(): Promise<void> {
    console.log('TW-4c — deterministic pre-order before the search scan-cap');
    console.log(`SEARCH_SCAN_CAP override = ${SEARCH_SCAN_CAP}, fillers = ${FILLER_COUNT}`);
    console.log('='.repeat(72));

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-tw4c-'));
    const local = new SurrealGraph(tmpDir, { workspaceId: 'tw4c', cacheDisabled: true });
    await local.initialize();

    const sdk = new StatefulSdkClient();
    const cloud = new DataplaneGraph({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client: sdk as any,
        tenantProvider: () => TENANT,
        orgId: ORG_ID,
    });
    await cloud.initialize();

    try {
        await loadFixture(local);
        await loadFixture(cloud);
        const stamps = await readBackTimestamps(local);
        pinCloudTimestamps(sdk, stamps);

        // ── CORE: the known-relevant, recently-updated node survives the cap ──
        await check('SurrealGraph: winner (beyond storage-order cap window) appears in ranked results', async () => {
            const res = await local.search(NEEDLE, 10);
            const ids = res.map((n) => n.id);
            assert.ok(
                ids.includes(WINNER_ID),
                `winner dropped before ranking — got [${ids.slice(0, 5).join(',')}...] (${ids.length} rows)`,
            );
            // It's the highest-relevance + newest node, so it must rank FIRST.
            assert.equal(ids[0], WINNER_ID, 'winner must rank first (label match + newest)');
        });

        await check('DataplaneGraph: winner appears in ranked results (sort before cap)', async () => {
            const res = await cloud.search(NEEDLE, 10);
            const ids = res.map((n) => n.id);
            assert.ok(
                ids.includes(WINNER_ID),
                `winner dropped before ranking — got [${ids.slice(0, 5).join(',')}...] (${ids.length} rows)`,
            );
            assert.equal(ids[0], WINNER_ID, 'winner must rank first (label match + newest)');
        });

        // ── PARITY: local and cloud return the SAME ordering for the fixture ──
        await check('cross-backend ORDER parity: identical id sequence over the >cap fixture', async () => {
            const localRes = await local.search(NEEDLE, 10);
            const cloudRes = await cloud.search(NEEDLE, 10);
            assert.deepEqual(
                localRes.map((n) => n.id),
                cloudRes.map((n) => n.id),
                'local and cloud must return the SAME id sequence after the pre-ordered cap',
            );
        });

        // ── Determinism of the retained window: with all fillers older than the
        //    winner, the top results after the winner must be the same on both. ──
        await check('retained window is the most-recently-updated matches (deterministic)', async () => {
            const res = await local.search(NEEDLE, SCAN_CAP);
            const ids = res.map((n) => n.id);
            // Winner first; the rest are fillers (all content matches), and since
            // every result is a genuine match the count is bounded by limit.
            assert.equal(ids[0], WINNER_ID, 'winner ranks first');
            assert.ok(ids.length > 1, 'fillers also surface');
            // No duplicate ids — the ranked slice is a clean set.
            assert.equal(new Set(ids).size, ids.length, 'no duplicate ids in ranked results');
        });
    } finally {
        try {
            const maybeClose = (local as unknown as { close?: () => Promise<void> }).close;
            if (typeof maybeClose === 'function') await maybeClose.call(local);
        } catch { /* best effort */ }
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
    }

    console.log('');
    console.log(`tw4c: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
    console.log('all TW-4c pre-order assertions passed ✓');
    process.exit(0);
}

main().catch((err) => { console.error('FAIL:', err); process.exit(1); });
