#!/usr/bin/env tsx
/**
 * test/fc1-import-table-dedupe-unit.ts — 2026-08-17 audit finding 1.9.
 *
 * POST /api/import wrote the WHOLE parsed file into the Collections table on
 * every call — all parsed rows, including buildNode-rejected and upsert-
 * failed ones — keyed by a fresh randomUUID importId per call, so
 * re-importing the same file silently DOUBLED every row (disposition:
 * 'reused' read as idempotence; it only referred to the table shape).
 *
 * The fix: the table write now receives ONLY rows that reached the graph,
 * keyed by a STABLE row identity (the graph id `${entityType}:${idValue}`,
 * or a content hash when no idColumn), and writeTabularRows dedupes on it.
 *
 * Harness: the REAL runImport (the shared core the HTTP route and MCP tool
 * both wrap) over a REAL SqliteTableStorage, with a Map-backed fake graph —
 * exactly the audit's repro shape ("import a 2-row file twice, assert count
 * is 2, not 4").
 *
 * Run: npx tsx test/fc1-import-table-dedupe-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SqliteTableStorage } from '../packages/lore/src/engines/sqliteTableStorage.js';
import { runImport, type ImportDeps, type ImportRequest } from '../packages/lore/src/mcp/http/routes/import.js';

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

/** Map-backed fake graph with the idempotent upsert semantics of the real one. */
function fakeGraph() {
    const nodes = new Map<string, Record<string, unknown>>();
    return {
        nodes,
        getNode: async (id: string) => nodes.get(id) ?? null,
        upsertNode: async (n: Record<string, unknown>) => { nodes.set(String(n.id), n); return n; },
    };
}

function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc1-import-'));
    const tableStorage = new SqliteTableStorage(path.join(dir, 'tables.sqlite'), path.join(dir, 'schemas.json'));
    const graph = fakeGraph();
    const deps: ImportDeps = {
        store: { tableStorage, loreGraph: graph } as never,
        detectedScope: { workspace: 'default', ecosystem: '*' },
        deploymentMode: 'local',
        dataplane: null,
    };
    return { dir, tableStorage, graph, deps, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function csvReq(rows: string[]): ImportRequest {
    return {
        format: 'csv',
        filename: 'contacts.csv',
        data: '',
        mapping: {
            entityType: 'contact',
            idColumn: 'id',
            fields: { id: 'id', email: 'label' },
        },
    };
}

async function main() {
    console.log('1.9 — re-importing the same file must not double the table');

    await test('T1.9a the audit repro: same 2-row file imported twice → table count stays 2', async () => {
        const { tableStorage, graph, deps, cleanup } = setup();
        try {
            const csv = 'id,email\nc1,a@x.io\nc2,b@x.io\n';
            const body = csvReq([]);
            const buf = Buffer.from(csv, 'utf8');

            const r1 = await runImport(deps, buf, body);
            assert.equal(r1.imported, 2);
            assert.equal(r1.table?.rowsWritten, 2);

            const r2 = await runImport(deps, buf, body);
            assert.equal(r2.imported, 2, 'graph side is idempotent upsert (2 upserts, same ids)');
            assert.equal(r2.table?.rowsWritten, 2, 'second import refreshes the 2 existing rows in place (no inserts)');
            assert.equal(r2.table?.rowsDeduplicated, 2, 'the dedupe is surfaced, not silent');

            const tableName = r1.table!.name;
            assert.equal(await tableStorage.count(tableName), 2,
                `pre-fix this was 4 — every COUNT/SUM over the import was silently doubled`);
            assert.equal(graph.nodes.size, 2);
        } finally { cleanup(); }
    });

    await test('T1.9b append mode: graph skips existing, table dedupes (no fake "rowsWritten: N")', async () => {
        const { tableStorage, deps, cleanup } = setup();
        try {
            const csv = 'id,email\nc1,a@x.io\nc2,b@x.io\n';
            const body = csvReq([]);
            const buf = Buffer.from(csv, 'utf8');
            await runImport(deps, buf, body);
            const r2 = await runImport(deps, buf, { ...body, mode: 'append' });
            assert.equal(r2.imported, 0, 'append mode: both rows already exist');
            assert.equal(r2.skipped, 2);
            // The rows ARE in the graph (from import #1), so they are recorded
            // for the table — and upserted in place under their stable keys.
            assert.equal(r2.table?.rowsWritten, 2, 'append-mode skips refresh existing table rows in place');
            assert.equal(r2.table?.rowsDeduplicated, 2);
            assert.equal(await tableStorage.count('import_contact'), 2, 'no duplicates on the skip path');
        } finally { cleanup(); }
    });

    await test('T1.9c buildNode-rejected rows (empty idColumn) never reach the table', async () => {
        const { tableStorage, deps, cleanup } = setup();
        try {
            // Row 2 has an EMPTY idColumn value → buildNode rejects it.
            const csv = 'id,email\nc1,a@x.io\n,orphan@x.io\n';
            const body = csvReq([]);
            const r = await runImport(deps, Buffer.from(csv, 'utf8'), body);
            assert.equal(r.imported, 1);
            assert.equal(r.skipped, 1, 'rejected row counted as skipped/error for the graph');
            assert.equal(r.table?.rowsWritten, 1, 'rejected row must NOT be written to the table');
            assert.equal(await tableStorage.count('import_contact'), 1);
        } finally { cleanup(); }
    });

    await test('T1.9d a CHANGED row re-imported refreshes its table row (same key, new content)', async () => {
        const { tableStorage, deps, cleanup } = setup();
        try {
            await runImport(deps, Buffer.from('id,email\nc1,a@x.io\n', 'utf8'), csvReq([]));
            // Same id, changed email. Graph upserts; the table row must be
            // REPLACED (content changed → new row under the same key), not
            // skipped as a dupe nor added as a second row.
            const r2 = await runImport(deps, Buffer.from('id,email\nc1,new@x.io\n', 'utf8'), csvReq([]));
            assert.equal(r2.imported, 1);
            const rows = await tableStorage.query('import_contact', undefined, { limit: Infinity } as never);
            assert.equal(rows.length, 1, `still one row (got ${rows.length})`);
            assert.equal(String(rows[0]!['email']), 'new@x.io', 'changed content wins');
        } finally { cleanup(); }
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST HARNESS FAILED:', e); process.exit(2); });
