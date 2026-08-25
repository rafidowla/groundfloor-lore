#!/usr/bin/env tsx
/**
 * countableEvents.unit.ts — Bucket B structured-records table layer.
 *
 * Pure parts (factId, factToRow, formatStructuredFacts) tested with real
 * assertions and zero API calls; the write/read path tested for real against
 * a SqliteTableStorage in a per-test tmpdir (same pattern as Core's
 * test/sqlite-table-storage-unit.ts).
 *
 * Run: npx tsx benchmarks/longmemeval/src/countableEvents.unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SqliteTableStorage } from '../../../packages/lore/src/engines/sqliteTableStorage.js';
import type { Row } from '../../../packages/lore/src/contracts/tables.js';
import {
    COUNTABLE_EVENTS_TABLE,
    factId,
    factToRow,
    formatStructuredFacts,
    queryCountableFacts,
    writeCountableFacts,
    type CountableFact,
} from './countableEvents.js';

let passed = 0;
let failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void> | void) {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? (err as Error).message}`); failed++; }
    })());
}

function mkTmp(): { dbPath: string; cachePath: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-countable-'));
    return {
        dbPath: path.join(dir, 'tables.sqlite'),
        cachePath: path.join(dir, 'schemas.json'),
        cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } },
    };
}

const fact = (over: Partial<CountableFact> = {}): CountableFact => ({
    category: 'purchase',
    description: 'spent $800 on a bike',
    numericValue: 800,
    eventDate: '2024-03-15',
    sourceNodeId: 'q1::s1::0',
    ...over,
});

console.log('countableEvents — pure');

test('factId is a 32-char hex and deterministic on its own fields', () => {
    const a = factId(fact());
    const b = factId(fact());
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{32}$/);
});

test('factId changes when any identity field changes', () => {
    const base = factId(fact());
    assert.notEqual(factId(fact({ description: 'spent $900 on a bike' })), base);
    assert.notEqual(factId(fact({ category: 'visit' })), base);
    assert.notEqual(factId(fact({ numericValue: null })), base);
    assert.notEqual(factId(fact({ eventDate: null })), base);
    assert.notEqual(factId(fact({ sourceNodeId: 'q1::s2::0' })), base);
});

test('factToRow maps to the fixed schema column names', () => {
    const row = factToRow(fact(), 'ecosys');
    assert.deepEqual(row, {
        id: factId(fact()),
        ecosystem: 'ecosys',
        category: 'purchase',
        description: 'spent $800 on a bike',
        numeric_value: 800,
        event_date: '2024-03-15',
        source_node_id: 'q1::s1::0',
    });
});

test('factToRow stores null numeric_value/event_date as null', () => {
    const row = factToRow(fact({ numericValue: null, eventDate: null }), 'e');
    assert.equal(row.numeric_value, null);
    assert.equal(row.event_date, null);
});

test('formatStructuredFacts returns empty string for no rows', () => {
    assert.equal(formatStructuredFacts([]), '');
});

test('formatStructuredFacts emits one line per event with value/date, sorted', () => {
    const rows = [
        { id: '1', ecosystem: 'e', category: 'visit', description: 'zoo', numeric_value: null, event_date: '2024-02-02', source_node_id: 'q::s2::0' },
        { id: '2', ecosystem: 'e', category: 'purchase', description: 'lunch', numeric_value: 12.5, event_date: null, source_node_id: 'q::s1::0' },
        { id: '3', ecosystem: 'e', category: 'visit', description: 'museum', numeric_value: null, event_date: '2024-01-01', source_node_id: 'q::s2::1' },
    ];
    const out = formatStructuredFacts(rows);
    assert.ok(out.includes('purchase'), out);
    assert.ok(out.includes('value=12.5'), out);
    assert.ok(out.includes('date=2024-01-01'), out);
    assert.ok(out.includes('date=2024-02-02'), out);
    // category-sorted: purchase before visit; within visit, date-ascending
    assert.ok(out.indexOf('purchase') < out.indexOf('visit'), out);
    assert.ok(out.indexOf('date=2024-01-01') < out.indexOf('date=2024-02-02'), out);
    // no bare "value=" for null numeric_value
    assert.ok(!/value=null/.test(out), out);
});

console.log('countableEvents — source provenance in the prompt block');

test('every line carries src=, with the constant ecosystem segment stripped', () => {
    const out = formatStructuredFacts([
        { id: '1', ecosystem: '28dc39ac', category: 'gaming', description: 'finished Celeste', numeric_value: 10, event_date: null, source_node_id: '28dc39ac::answer_8d015d9d_4::0' },
    ]);
    assert.ok(out.includes('src=answer_8d015d9d_4::0'), out);
    assert.ok(!out.includes('28dc39ac::'), out); // question id is identical on every row → noise
});

test('a source id that is not <question>::<session>::<turn> is passed through intact', () => {
    const out = formatStructuredFacts([
        { id: '1', ecosystem: 'e', category: 'visit', description: 'zoo', numeric_value: null, event_date: null, source_node_id: 'legacy-node-id' },
    ]);
    assert.ok(out.includes('src=legacy-node-id'), out);
});

test('a row with no source_node_id emits no src= fragment', () => {
    const out = formatStructuredFacts([
        { id: '1', ecosystem: 'e', category: 'visit', description: 'zoo', numeric_value: null, event_date: null, source_node_id: null },
    ]);
    // The header legend always mentions src=; the data line must not.
    const dataLines = out.split('\n').filter((l) => l.startsWith('- '));
    assert.deepEqual(dataLines, ['- [visit] zoo']);
});

test('the header explains what src= means', () => {
    const out = formatStructuredFacts([
        { id: '1', ecosystem: 'e', category: 'visit', description: 'zoo', numeric_value: null, event_date: null, source_node_id: 'e::s::0' },
    ]);
    assert.ok(out.includes('src=<session>::<turn> is the exact turn each event was extracted from'), out);
    assert.ok(out.includes('two lines sharing a src came from the same sentence'), out);
});

// The real rows behind "How many hours have I spent playing games in total?"
// (question 28dc39ac, gold 140), answered 110 because the 30-hour hard-
// difficulty playthrough of The Last of Us Part II was read as a restatement
// of the 25-hour normal-difficulty one.
const GAMING_ROWS: Row[] = [
    { id: 'a', ecosystem: '28dc39ac', category: 'gaming', description: 'User completed The Last of Us Part II on normal difficulty, taking 25 hours', numeric_value: 25, event_date: null, source_node_id: '28dc39ac::answer_8d015d9d_1::0' },
    { id: 'b', ecosystem: '28dc39ac', category: 'gaming', description: 'Completed The Last of Us Part II on hard difficulty', numeric_value: null, event_date: null, source_node_id: '28dc39ac::answer_8d015d9d_2::0' },
    { id: 'c', ecosystem: '28dc39ac', category: 'gaming', description: 'Time spent playing The Last of Us Part II', numeric_value: 30, event_date: null, source_node_id: '28dc39ac::answer_8d015d9d_2::0' },
    { id: 'd', ecosystem: '28dc39ac', category: 'gaming', description: 'User finished playing Assassin\'s Creed Odyssey', numeric_value: null, event_date: null, source_node_id: '28dc39ac::answer_8d015d9d_3::0' },
    { id: 'e', ecosystem: '28dc39ac', category: 'gaming', description: 'User spent 70 hours playing Assassin\'s Creed Odyssey', numeric_value: 70, event_date: null, source_node_id: '28dc39ac::answer_8d015d9d_3::6' },
    { id: 'f', ecosystem: '28dc39ac', category: 'gaming', description: 'User completed Celeste in 10 hours', numeric_value: 10, event_date: null, source_node_id: '28dc39ac::answer_8d015d9d_4::0' },
    { id: 'g', ecosystem: '28dc39ac', category: 'gaming', description: 'User finished Hyper Light Drifter in 5 hours', numeric_value: 5, event_date: null, source_node_id: '28dc39ac::answer_8d015d9d_5::0' },
    { id: 'h', ecosystem: '28dc39ac', category: 'gaming', description: 'User completed The Last of Us Part II on both normal and hard difficulties', numeric_value: null, event_date: null, source_node_id: '28dc39ac::answer_8d015d9d_5::4' },
    { id: 'i', ecosystem: '28dc39ac', category: 'gaming', description: 'User completed Assassin\'s Creed Odyssey recently', numeric_value: null, event_date: null, source_node_id: '28dc39ac::answer_8d015d9d_5::6' },
];

test('the two halves of one occurrence share a src and render adjacent', () => {
    const lines = formatStructuredFacts(GAMING_ROWS).split('\n').filter((l) => l.startsWith('- '));
    const hardQualifier = lines.findIndex((l) => l.includes('on hard difficulty'));
    const hardHours = lines.findIndex((l) => l.includes('value=30'));
    assert.notEqual(hardQualifier, -1);
    assert.notEqual(hardHours, -1);
    // Same sentence → same src, and the sort tiebreak keeps them together, so
    // the qualifier that legitimises the 30 is readable next to it.
    assert.ok(lines[hardQualifier]!.includes('src=answer_8d015d9d_2::0'), lines[hardQualifier]);
    assert.ok(lines[hardHours]!.includes('src=answer_8d015d9d_2::0'), lines[hardHours]);
    assert.equal(Math.abs(hardQualifier - hardHours), 1);
});

test('the 25h and 30h playthroughs are visibly separate occurrences', () => {
    const lines = formatStructuredFacts(GAMING_ROWS).split('\n').filter((l) => l.startsWith('- '));
    const normal = lines.find((l) => l.includes('value=25'))!;
    const hard = lines.find((l) => l.includes('value=30'))!;
    assert.ok(normal.includes('src=answer_8d015d9d_1::0'), normal);
    assert.ok(hard.includes('src=answer_8d015d9d_2::0'), hard);
    assert.notEqual(
        normal.slice(normal.indexOf('src=')),
        hard.slice(hard.indexOf('src=')),
        'different playthroughs must not share a src, or they read as one occurrence',
    );
});

test('formatting never merges or drops a row — all 9 gaming rows survive', () => {
    const lines = formatStructuredFacts(GAMING_ROWS).split('\n').filter((l) => l.startsWith('- '));
    assert.equal(lines.length, GAMING_ROWS.length);
    // Every number needed for the correct total of 140 is still present.
    for (const v of [25, 30, 70, 10, 5]) {
        assert.ok(lines.some((l) => l.includes(`value=${v}`)), `lost value=${v}`);
    }
    assert.equal(
        lines
            .map((l) => Number(/value=(\d+(?:\.\d+)?)/.exec(l)?.[1] ?? 0))
            .reduce((a, b) => a + b, 0),
        140,
    );
});

console.log('countableEvents — real SQLite');

test('writeCountableFacts creates the table and round-trips typed rows', async () => {
    const tmp = mkTmp();
    try {
        const storage = new SqliteTableStorage(tmp.dbPath, tmp.cachePath);
        const facts = [fact(), fact({ category: 'visit', description: 'went to the museum', numericValue: null, eventDate: '2024-01-01', sourceNodeId: 'q1::s1::1' })];
        const r = await writeCountableFacts(storage, 'q1', facts);
        assert.deepEqual(r, { inserted: 2, skipped: 0 });

        const back = await queryCountableFacts(storage, 'q1');
        assert.equal(back.length, 2);
        const purchase = back.find((row) => row.category === 'purchase')!;
        assert.equal(purchase.numeric_value, 800); // decoded as number (float)
        assert.equal(purchase.event_date, '2024-03-15');
        assert.equal(purchase.source_node_id, 'q1::s1::0');
        assert.equal(purchase.ecosystem, 'q1');
    } finally {
        tmp.cleanup();
    }
});

test('re-running with the same facts is idempotent (no duplicates)', async () => {
    const tmp = mkTmp();
    try {
        const storage = new SqliteTableStorage(tmp.dbPath, tmp.cachePath);
        const facts = [fact()];
        await writeCountableFacts(storage, 'q1', facts);
        const again = await writeCountableFacts(storage, 'q1', facts);
        assert.deepEqual(again, { inserted: 0, skipped: 1 });
        assert.equal((await queryCountableFacts(storage, 'q1')).length, 1);
    } finally {
        tmp.cleanup();
    }
});

test('a second extraction adds only genuinely-new facts (additive)', async () => {
    const tmp = mkTmp();
    try {
        const storage = new SqliteTableStorage(tmp.dbPath, tmp.cachePath);
        await writeCountableFacts(storage, 'q1', [fact()]);
        const next = await writeCountableFacts(storage, 'q1', [
            fact(),  // duplicate — skipped
            fact({ description: 'spent $50 on a helmet', numericValue: 50, sourceNodeId: 'q1::s1::2' }), // new
        ]);
        assert.deepEqual(next, { inserted: 1, skipped: 1 });
        assert.equal((await queryCountableFacts(storage, 'q1')).length, 2);
    } finally {
        tmp.cleanup();
    }
});

test('facts are isolated by ecosystem', async () => {
    const tmp = mkTmp();
    try {
        const storage = new SqliteTableStorage(tmp.dbPath, tmp.cachePath);
        await writeCountableFacts(storage, 'q1', [fact()]);
        await writeCountableFacts(storage, 'q2', [fact({ description: 'different question', sourceNodeId: 'q2::s1::0' })]);
        assert.equal((await queryCountableFacts(storage, 'q1')).length, 1);
        assert.equal((await queryCountableFacts(storage, 'q2')).length, 1);
        assert.equal((await queryCountableFacts(storage, 'q3')).length, 0);
    } finally {
        tmp.cleanup();
    }
});

test('table name is the fixed countable_events contract', () => {
    assert.equal(COUNTABLE_EVENTS_TABLE, 'countable_events');
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
