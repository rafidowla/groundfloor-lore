#!/usr/bin/env tsx
/**
 * test/r3222-csv-proto-header-unit.ts — 3.22.2, csv-parse ^5.6 -> ^7.0.2.
 *
 * GHSA-8cw4-87c7-c6xx ("prototype replacement still reachable via columns
 * path", csv-parse <7.0.2) sits on exactly the option set `parseCsv` uses
 * (`columns: true`). REST `/api/import` feeds user-uploaded CSV through it.
 *
 * Pins, for a CSV whose header row names `__proto__` / `constructor`:
 *   1. every parsed row is a plain object (prototype === Object.prototype);
 *   2. the header's value is kept as an own string field, not silently
 *      swallowed by a prototype setter (5.x dropped it: keys == ['name']);
 *   3. nothing leaks onto Object.prototype;
 *   4. the Collections schema path gets a sanitized column for it.
 */

import assert from 'node:assert/strict';
import { parseCsv } from '../packages/lore/src/mcp/http/routes/import.js';
import { inferTableSchema } from '../packages/lore/src/engines/tabularImport.js';

let failures = 0;
function check(name: string, fn: () => void): void {
    try { fn(); console.log(`  ✓ ${name}`); }
    catch (e) { failures++; console.log(`  ✗ ${name}\n    ${(e as Error).message}`); }
}

console.log('r3222 csv __proto__ header');

const csv = Buffer.from('name,__proto__,constructor\na,polluted,ctor\nb,x,y\n');

check('rows stay plain objects and nothing reaches Object.prototype', () => {
    const { rows } = parseCsv(csv);
    assert.equal(rows.length, 2);
    for (const r of rows) assert.equal(Object.getPrototypeOf(r), Object.prototype);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.equal(typeof ({}).constructor, 'function');
});

check('__proto__ header is kept as an own string field', () => {
    const { headers, rows } = parseCsv(csv);
    assert.deepEqual(headers, ['name', '__proto__', 'constructor']);
    const r = rows[0]!;
    assert.ok(Object.prototype.hasOwnProperty.call(r, '__proto__'), `__proto__ column dropped; keys=${JSON.stringify(Object.keys(r))}`);
    assert.equal(Object.getOwnPropertyDescriptor(r, '__proto__')?.value, 'polluted');
    assert.equal(r.constructor, 'ctor');
});

check('Collections schema gets a sanitized column for it', () => {
    const { headers, rows } = parseCsv(csv);
    const s = inferTableSchema({ entityType: 'r3222', headers, rows });
    assert.deepEqual(s.columns.map((c) => c.name), ['name', 'proto', 'constructor']);
});

if (failures > 0) { console.log(`\n${failures} FAILED`); process.exit(1); }
console.log('\nAll csv __proto__ header tests passed');
