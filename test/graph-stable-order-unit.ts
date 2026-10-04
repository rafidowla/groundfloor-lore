#!/usr/bin/env tsx
/**
 * graph-stable-order-unit.ts — 3.27.1: deterministic enumeration order.
 *
 * WHY: after a reindex thousands of nodes share ONE `updatedAt`. `listNodes` /
 * `listNodeSummaries` ordered by `updatedAt DESC` alone, so the order among ties
 * (and any "first N" slice a caller takes — Atlas's sampleSymbols) was left to
 * each engine's planner and differed between SQLite and Surreal. The rule is now
 * `updatedAt DESC, id ASC` on both engines (house convention, as search/bulkList).
 *
 * Proof, per engine (SqliteGraph, SurrealGraph) with the SAME fixture:
 *   - 50 nodes with IDENTICAL updatedAt, inserted in shuffled order: listNodes,
 *     listNodeSummaries and lintGraph return ascending id; limit=N is the first N.
 *   - mixed updatedAt: primary order (newest first) unchanged, ties ascending.
 *   - both engines return the same sequence.
 *   - SQLite: EXPLAIN QUERY PLAN shows idx_nodes_updatedAt serves the new ORDER BY
 *     (no USE TEMP B-TREE FOR ORDER BY).
 * updatedAt is pinned through the raw path (importRaw on SQLite, a direct UPDATE
 * on Surreal) because the public upsert stamps now().
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import { SqliteGraph } from '../packages/lore/src/engines/sqliteGraph.js';
import { toNodeRid } from '../packages/lore/src/engines/surreal/surrealRecordId.js';
import { formatOrphanMessage } from '../packages/lore/src/engines/graphShared/lintMessages.js';

let passed = 0;
let failed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok   ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}`); console.error('       ' + ((err as Error).message ?? String(err))); }
}

// Mixed-case, digits-vs-padding, underscore and non-ASCII ids so byte order vs
// "natural" order differences between engines would show up.
const IDS: string[] = ['Z-last', 'a-first', 'B-upper', '_under', 'n-9', 'n-10', 'é-accent', 'sym-1:a/b'];
for (let i = 0; IDS.length < 50; i++) IDS.push(`sym-${String(i * 7 % 41).padStart(3, '0')}-${i}`);
const TIE = '2026-05-01T00:00:00.000Z';

function shuffled<T>(xs: T[]): T[] {
    const a = [...xs];
    let s = 12345;
    for (let i = a.length - 1; i > 0; i--) {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        const j = s % (i + 1);
        [a[i], a[j]] = [a[j]!, a[i]!];
    }
    return a;
}
const asc = (xs: string[]): string[] => [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

type Engine = { name: string; g: SqliteGraph | SurrealGraph; pin(id: string, updatedAt: string): Promise<void> };

async function seed(e: Engine, updatedAtOf: (id: string) => string): Promise<void> {
    for (const id of shuffled(IDS)) {
        await e.g.upsertNode({
            id, type: 'decision', label: `label ${id}`, content: `c ${id}`, tags: ['t'],
            project: 'p', ecosystem: 'e', metadata: '{}',
        });
        await e.pin(id, updatedAtOf(id));
    }
}

async function main(): Promise<void> {
    const sqliteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-stable-order-sqlite-'));
    const surrealDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-stable-order-surreal-'));
    const sqlite = new SqliteGraph(sqliteDir, { workspaceId: 'stable-order', cacheDisabled: true });
    const surreal = new SurrealGraph(surrealDir, { workspaceId: 'stable-order', cacheDisabled: true });
    await sqlite.initialize();
    await surreal.initialize();

    const engines: Engine[] = [
        {
            name: 'sqlite', g: sqlite,
            async pin(id, updatedAt) {
                const n = await sqlite.getNode(id);
                assert.ok(n, `seeded node ${id} missing`);
                await sqlite.importRaw([{ ...n, updatedAt }], []);
            },
        },
        {
            name: 'surreal', g: surreal,
            async pin(id, updatedAt) {
                await (surreal as unknown as { query: (s: string, v: Record<string, unknown>) => Promise<unknown> })
                    .query('UPDATE $rid SET updatedAt = $t', { rid: toNodeRid(id, 'test'), t: updatedAt });
            },
        },
    ];

    try {
        console.log('GRAPH-STABLE-ORDER — updatedAt DESC, id ASC on every engine');

        // ── Phase 1: all ties ──────────────────────────────────────────────
        for (const e of engines) await seed(e, () => TIE);
        const want = asc(IDS);
        const tieSeq: Record<string, string[]> = {};
        for (const e of engines) {
            const g = e.g;
            await check(`${e.name}: listNodes over 50 identical-updatedAt rows is id-ascending`, async () => {
                const rows = await g.listNodes(undefined, undefined, '*', '*', undefined, { unbounded: true });
                tieSeq[e.name] = rows.map((n) => n.id);
                assert.deepEqual(tieSeq[e.name], want);
            });
            await check(`${e.name}: listNodes limit=N is the first N of that order (filtered + unfiltered)`, async () => {
                for (const n of [1, 7, 25, 49]) {
                    const rows = await g.listNodes(undefined, undefined, '*', '*', n);
                    assert.deepEqual(rows.map((r) => r.id), want.slice(0, n), `limit=${n}`);
                }
                const typed = await g.listNodes('decision', 't', 'p', 'e', 10);
                assert.deepEqual(typed.map((r) => r.id), want.slice(0, 10));
            });
            await check(`${e.name}: listNodeSummaries (ordered) is id-ascending; limit=N is the first N`, async () => {
                const all = await g.listNodeSummaries(undefined, undefined, '*', '*', undefined, { unbounded: true });
                assert.deepEqual(all.map((r) => r.id), want);
                const some = await g.listNodeSummaries(undefined, undefined, '*', '*', 13);
                assert.deepEqual(some.map((r) => r.id), want.slice(0, 13));
            });
            await check(`${e.name}: lintGraph (orphans) is id-ascending`, async () => {
                const msgs = await g.lintGraph();
                assert.deepEqual(msgs, want.map((id) => formatOrphanMessage('decision', id)));
            });
        }
        await check('both engines return the same listNodes sequence', () => {
            assert.deepEqual(tieSeq['sqlite'], tieSeq['surreal']);
        });

        // ── Phase 2: mixed updatedAt (3 tie groups); primary order unchanged ─
        const groupOf = (id: string): number => IDS.indexOf(id) % 3;
        const times = ['2026-04-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'];
        for (const e of engines) for (const id of IDS) await e.pin(id, times[groupOf(id)]!);
        const wantMixed = [...IDS].sort((a, b) => {
            const ta = times[groupOf(a)]!; const tb = times[groupOf(b)]!;
            if (ta !== tb) return ta < tb ? 1 : -1;       // newest first
            return a < b ? -1 : a > b ? 1 : 0;            // then id ascending
        });
        const mixedSeq: Record<string, string[]> = {};
        for (const e of engines) {
            await check(`${e.name}: mixed updatedAt keeps newest-first, ties id-ascending (listNodes + summaries)`, async () => {
                const rows = await e.g.listNodes(undefined, undefined, '*', '*', undefined, { unbounded: true });
                mixedSeq[e.name] = rows.map((n) => n.id);
                assert.deepEqual(mixedSeq[e.name], wantMixed);
                const sums = await e.g.listNodeSummaries(undefined, undefined, '*', '*', undefined, { unbounded: true });
                assert.deepEqual(sums.map((s) => s.id), wantMixed);
                const lim = await e.g.listNodes(undefined, undefined, '*', '*', 20);
                assert.deepEqual(lim.map((n) => n.id), wantMixed.slice(0, 20));
            });
        }
        await check('both engines return the same mixed-updatedAt sequence', () => {
            assert.deepEqual(mixedSeq['sqlite'], mixedSeq['surreal']);
        });

        // ── SQLite plan: the existing index still serves the new ORDER BY ────
        await check('sqlite: EXPLAIN QUERY PLAN for listNodes uses idx_nodes_updatedAt, no temp B-tree sort', () => {
            const db = (sqlite as unknown as { db(): { prepare(s: string): { all(...a: unknown[]): Array<{ detail: string }> } } }).db();
            const plan = db.prepare('EXPLAIN QUERY PLAN SELECT * FROM nodes ORDER BY updatedAt DESC, id ASC LIMIT ?')
                .all(100).map((r) => r.detail).join(' | ');
            assert.match(plan, /idx_nodes_updatedAt/, plan);
            assert.doesNotMatch(plan, /TEMP B-TREE/i, plan);
        });
    } finally {
        await surreal.close().catch(() => undefined);
        await sqlite.close().catch(() => undefined);
        fs.rmSync(sqliteDir, { recursive: true, force: true });
        fs.rmSync(surrealDir, { recursive: true, force: true });
    }

    console.log(`\ngraph-stable-order: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exitCode = 1;
}

main().catch((err) => { console.error('FAIL:', err); process.exitCode = 1; });
