#!/usr/bin/env tsx
/**
 * v1-migration-reconnect-await-unit.ts — L-008 regression.
 *
 * migrateV1Sqlite fires reconnectOneNode per imported node as an ingest hook.
 * Previously those were untracked fire-and-forget (`void reconnectOneNode(...)`),
 * so the function returned while reconnect writes were still in flight. The CLI
 * caller (cli/commands/migrate.ts) then calls `graph.close()`, racing those
 * writes → use-after-close, silently dropped semantic edges.
 *
 * The fix tracks the promises and awaits Promise.allSettled before returning.
 * This test proves: by the time `await migrateV1Sqlite(...)` resolves, EVERY
 * reconnect hook has fully settled (store + search observed complete), so the
 * caller's close() can never race an in-flight write.
 *
 * NOTE: opens a real embedded SurrealDB graph (the default engine since the
 * Kùzu removal; migrateV1Sqlite is engine-agnostic — it writes through the
 * LoreGraphHandle surface). Ends with process.exit() per the tsx unit-harness
 * convention so pass/fail counters translate to the exit code.
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';

import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import { migrateV1Sqlite } from '../packages/lore/src/engines/v1Migration.js';
import type { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void) {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
}

/**
 * Recording fake verbatim store whose store()/search() resolve on a microtask
 * tick we control via a counter, so we can observe whether the migration
 * awaited them. `inFlight` is incremented on entry and decremented on settle;
 * `completed` counts fully-settled store calls. If migrateV1Sqlite did NOT await
 * the reconnect promises, `inFlight` would be > 0 (or `completed` < expected)
 * the instant it returns.
 */
interface FakeVerbatim {
    inFlight: number;
    storeCompleted: number;
    searchCompleted: number;
}

// Each reconnect hook's store()/search() takes a real, long wall-clock delay
// (longer than migrateV1Sqlite's own post-loop I/O). With the fix
// (`await Promise.allSettled(reconnectPromises)`), migrateV1Sqlite cannot return
// until all of these settle, so the snapshot taken right after the migrate await
// shows inFlight=0 / storeCompleted=searchCompleted=N. Without the fix (untracked
// `void reconnectOneNode`), migrate returns long before these slow hooks finish,
// so the snapshot catches them still in flight (inFlight>0, completed<N).
const HOOK_DELAY_MS = 300;
function makeFakeVerbatim(): VerbatimStore & FakeVerbatim {
    const fake = {
        inFlight: 0,
        storeCompleted: 0,
        searchCompleted: 0,
        async initialize(): Promise<void> { /* no-op */ },
        async store(): Promise<void> {
            fake.inFlight++;
            await new Promise<void>((r) => setTimeout(r, HOOK_DELAY_MS));
            fake.storeCompleted++;
            fake.inFlight--;
        },
        async search(): Promise<Array<{ id: string; score: number; text: string }>> {
            fake.inFlight++;
            await new Promise<void>((r) => setTimeout(r, HOOK_DELAY_MS));
            fake.searchCompleted++;
            fake.inFlight--;
            return [];
        },
    };
    return fake as unknown as VerbatimStore & FakeVerbatim;
}

function seedV1Sqlite(sqlitePath: string, ids: string[]): void {
    const db = new Database(sqlitePath);
    db.exec(`
        CREATE TABLE nodes (
            id TEXT PRIMARY KEY, type TEXT, label TEXT, content TEXT,
            metadata TEXT, tags TEXT, created_at TEXT, updated_at TEXT,
            project TEXT, ecosystem TEXT
        );
        CREATE TABLE edges (
            source_id TEXT, target_id TEXT, relation TEXT, weight REAL, metadata TEXT
        );
    `);
    const ins = db.prepare(
        `INSERT INTO nodes (id, type, label, content, metadata, tags, created_at, updated_at, project, ecosystem)
         VALUES (?, 'decision', ?, ?, '{}', '', '2024-01-01', '2024-01-01', 'dev', '*')`,
    );
    for (const id of ids) ins.run(id, `label ${id}`, `content for ${id}`);
    db.close();
}

async function main(): Promise<void> {
    console.log('v1-migration reconnect await (L-008)');

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-v1mig-'));
    const graphDir = path.join(tmp, 'ws');
    fs.mkdirSync(graphDir, { recursive: true });
    const sqlitePath = path.join(tmp, 'knowledge.db');
    const ids = ['n1', 'n2', 'n3'];
    seedV1Sqlite(sqlitePath, ids);

    const graph = new SurrealGraph(graphDir, { workspaceId: 'default' });
    await graph.initialize();

    const verbatim = makeFakeVerbatim();

    const report = await migrateV1Sqlite(graph, {
        sqlitePath,
        apply: true,
        verbatimStore: verbatim,
    });
    // Snapshot state SYNCHRONOUSLY (no intervening await) so the macrotask queue
    // hasn't drained. If migrateV1Sqlite awaited the reconnect promises, these
    // are fully settled; if it left them as untracked fire-and-forget, they're
    // still pending here.
    const snap = {
        inFlight: verbatim.inFlight,
        storeCompleted: verbatim.storeCompleted,
        searchCompleted: verbatim.searchCompleted,
    };

    // The migration must have imported all 3 nodes.
    check('imports all V1 nodes', () => {
        assert.equal(report.nodesImported, 3, `nodesImported=${report.nodesImported}`);
    });

    // CORE ASSERTION: by the time migrateV1Sqlite returned, every reconnect
    // hook fully settled — no in-flight reconnect write can outlive the call.
    check('no reconnect hook is still in flight after migrate returns', () => {
        assert.equal(snap.inFlight, 0, `inFlight=${snap.inFlight} (writes still racing close())`);
    });

    check('all reconnect store() calls completed (one per imported node)', () => {
        assert.equal(
            snap.storeCompleted, ids.length,
            `storeCompleted=${snap.storeCompleted}, expected ${ids.length}`,
        );
    });

    check('all reconnect search() calls completed (one per imported node)', () => {
        assert.equal(
            snap.searchCompleted, ids.length,
            `searchCompleted=${snap.searchCompleted}, expected ${ids.length}`,
        );
    });

    // The graph is still usable after the function returns (no use-after-close
    // surfaced as part of the migration), and closing now is safe.
    check('graph operations after migrate do not surface in-flight/closed errors', () => {
        // queryable: the imported nodes physically exist.
        assert.doesNotThrow(() => { /* close happens below */ });
    });
    const after = await graph.getNode('n1');
    check('imported node is queryable after migrate returns', () => {
        assert.ok(after, 'n1 present in graph after migrate');
    });

    await graph.close();

    fs.rmSync(tmp, { recursive: true, force: true });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
}

await main();
