#!/usr/bin/env tsx
/**
 * graph-metadata-shapes-unit.ts — 3.25.2 Defect 1.
 *
 * SurrealGraph is schemaless, so a node's `metadata` can be an object, array,
 * number or boolean even though `LoreNode.metadata` is typed `string`.
 * SqliteGraph used to bind `node.metadata` as-is, so an object threw
 * "SQLite3 can only bind numbers, strings, bigints, buffers, and null" on
 * upsertNode / bulkUpsertNodes / importRaw, which aborted
 * `lore migrate-graph <ws> --to sqlite`.
 *
 * Covers, against BOTH engines unless noted:
 *   - upsertNode + bulkUpsertNodes with every metadata shape never throw and
 *     read back faithfully (SQLite: JSON text; JSON.parse gives the original);
 *   - omitting metadata on an update preserves the prior value;
 *   - importRaw (SQLite only — SurrealGraph has no importRaw);
 *   - `lore migrate-graph --to sqlite` end to end on a Surreal workspace whose
 *     nodes carry object/array/number/boolean metadata: digest matched, no force;
 *   - the migration digest stays STRICT: a genuinely different node, a different
 *     metadata value, and a "5" vs "5.0" style difference still fail it.
 *
 * Run: npx tsx test/graph-metadata-shapes-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createWorkspace, loadWorkspaces, setWorkspaceGraphEngine } from '../packages/lore/src/config/workspaces.js';
import { resolveWorkspaceGraphEngine } from '../packages/lore/src/engines/graphEngineSelector.js';
import { migrateGraphToSqlite, digestOf, withSqliteMetadata } from '../packages/lore/src/engines/migrateGraphToSqlite.js';
import { metadataToSqliteText } from '../packages/lore/src/engines/sqlite/sqliteGraphRow.js';
import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import { SqliteGraph } from '../packages/lore/src/engines/sqliteGraph.js';
import type { LoreNode } from '../packages/lore/src/providers/types.js';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? String(err)}`);
        failed++;
    }
}

const tmp = (p: string): string => fs.mkdtempSync(path.join(os.tmpdir(), p));
const base = { type: 'note', label: 'L', content: 'c', tags: ['t'], project: '*', ecosystem: '*' };

/** [label, value written, expected stored JSON text]. */
const SHAPES: Array<[string, unknown, string]> = [
    ['undefined', undefined, '{}'],
    ['null', null, '{}'],
    ['empty string', '', ''],
    ['json string', '{"k":1}', '{"k":1}'],
    ['object', { a: 1, b: 'x' }, '{"a":1,"b":"x"}'],
    ['nested object', { a: { b: [1, { c: null }] } }, '{"a":{"b":[1,{"c":null}]}}'],
    ['unicode object', { k: 'café 日本' }, '{"k":"café 日本"}'],
    ['array', [1, 'a'], '[1,"a"]'],
    ['empty array', [], '[]'],
    ['number', 5, '5'],
    ['zero', 0, '0'],
    ['float', 1.5, '1.5'],
    ['true', true, 'true'],
    ['false', false, 'false'],
];

interface EngineFixture { name: string; graph: SurrealGraph | SqliteGraph; close: () => Promise<void> }
async function openEngines(): Promise<EngineFixture[]> {
    const s = new SurrealGraph(tmp('lore-meta-s-'), { workspaceId: 'ws', cacheDisabled: true });
    const q = new SqliteGraph(tmp('lore-meta-q-'), { workspaceId: 'ws', cacheDisabled: true });
    await s.initialize();
    await q.initialize();
    return [
        { name: 'surreal', graph: s, close: () => s.close() },
        { name: 'sqlite', graph: q, close: () => q.close() },
    ];
}

console.log('GRAPH METADATA SHAPES — 3.25.2 Defect 1');
console.log('='.repeat(72));

await test('metadataToSqliteText: strings unchanged, absent -> undefined, everything else JSON', () => {
    assert.equal(metadataToSqliteText('abc'), 'abc');
    assert.equal(metadataToSqliteText(''), '');
    assert.equal(metadataToSqliteText(undefined), undefined);
    assert.equal(metadataToSqliteText(null), undefined);
    for (const [label, value, expected] of SHAPES) {
        if (value === undefined || value === null || typeof value === 'string') continue;
        assert.equal(metadataToSqliteText(value), expected, label);
    }
});

for (const engine of ['surreal', 'sqlite'] as const) {
    await test(`${engine}: upsertNode accepts every metadata shape and reads it back faithfully`, async () => {
        const fixtures = await openEngines();
        const f = fixtures.find((x) => x.name === engine)!;
        try {
            let i = 0;
            for (const [label, value, expected] of SHAPES) {
                const id = `n${i++}`;
                await f.graph.upsertNode({ id, ...base, metadata: value } as never);
                const got = await f.graph.getNode(id);
                assert.ok(got, `${label}: node exists`);
                // Same normaliser the migration digest uses: both engines agree.
                assert.equal(withSqliteMetadata(got as LoreNode).metadata, expected, `${label}: stored/read form`);
                if (engine === 'sqlite') {
                    assert.equal(typeof got.metadata, 'string', `${label}: SQLite always reads a string`);
                    if (expected !== '' && value !== undefined && value !== null && typeof value !== 'string') {
                        assert.deepEqual(JSON.parse(got.metadata), value, `${label}: JSON.parse round-trips`);
                    }
                }
            }
        } finally {
            for (const x of fixtures) await x.close();
        }
    });

    await test(`${engine}: bulkUpsertNodes with object metadata succeeds for every row`, async () => {
        const fixtures = await openEngines();
        const f = fixtures.find((x) => x.name === engine)!;
        try {
            const batch = [
                { id: 'b1', ...base, metadata: { a: 1 } },
                { id: 'b2', ...base, metadata: [1, 2] },
                { id: 'b3', ...base, metadata: '{}' },
            ];
            const results = await f.graph.bulkUpsertNodes(batch as never);
            assert.deepEqual(results.map((r) => r.ok), [true, true, true], JSON.stringify(results));
            const b1 = await f.graph.getNode('b1');
            assert.equal(withSqliteMetadata(b1 as LoreNode).metadata, '{"a":1}');
        } finally {
            for (const x of fixtures) await x.close();
        }
    });
}

await test('sqlite: an update that omits metadata keeps the prior (serialised) value', async () => {
    const fixtures = await openEngines();
    const f = fixtures.find((x) => x.name === 'sqlite')!;
    try {
        await f.graph.upsertNode({ id: 'p', ...base, metadata: { keep: 'me' } } as never);
        await f.graph.upsertNode({ id: 'p', ...base, label: 'changed' } as never);
        const got = await f.graph.getNode('p');
        assert.equal(got?.label, 'changed');
        assert.deepEqual(JSON.parse(got!.metadata), { keep: 'me' });
    } finally {
        for (const x of fixtures) await x.close();
    }
});

await test('sqlite: importRaw accepts every metadata shape and preserves timestamps', async () => {
    const dest = new SqliteGraph(tmp('lore-meta-import-'), { workspaceId: 'ws', cacheDisabled: true });
    await dest.initialize();
    try {
        const nodes = SHAPES.map(([, value], i) => ({
            id: `i${i}`, ...base, metadata: value,
            createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', syncedAt: '',
        })) as unknown as LoreNode[];
        const r = await dest.importRaw(nodes, []);
        assert.equal(r.nodeCount, SHAPES.length);
        let i = 0;
        for (const [label, , expected] of SHAPES) {
            const got = await dest.getNode(`i${i++}`);
            assert.equal(got?.metadata, expected, label);
            assert.equal(got?.updatedAt, '2026-01-02T00:00:00.000Z', `${label}: updatedAt preserved`);
        }
    } finally {
        await dest.close();
    }
});

await test('migrate-graph --to sqlite succeeds (digest matched, no force) for non-string metadata', async () => {
    const home = tmp('lore-meta-migrate-home-');
    loadWorkspaces(home);
    const entry = createWorkspace('meta-migrate', {}, home);
    setWorkspaceGraphEngine('meta-migrate', 'surreal', home);

    const g = new SurrealGraph(entry.path, { workspaceId: entry.name });
    await g.initialize();
    const written: Array<[string, unknown]> = [
        ['m-obj', { a: 1, nested: { b: [1, 2] } }], ['m-arr', [1, 'a']], ['m-num', 5], ['m-bool', true],
        ['m-str', '{"already":"text"}'], ['m-none', undefined],
    ];
    for (const [id, metadata] of written) await g.upsertNode({ id, ...base, metadata } as never);
    await g.addEdge({ sourceId: 'm-obj', targetId: 'm-arr', relation: 'related_to' });
    await g.close();

    const report = await migrateGraphToSqlite({ workspaceName: entry.name, home, backupOutDir: tmp('lore-meta-migrate-out-') });
    assert.equal(report.digestMatched, true, 'strict digest matched');
    assert.equal(report.readProbesMatched, true, report.readProbeDetails.join('; '));
    assert.equal(report.nodeCount, written.length);
    assert.equal(report.edgeCount, 1);
    assert.equal(resolveWorkspaceGraphEngine(entry.name, home), 'sqlite');

    const dest = new SqliteGraph(entry.path, { workspaceId: entry.name, cacheDisabled: true });
    await dest.initialize();
    try {
        assert.deepEqual(JSON.parse((await dest.getNode('m-obj'))!.metadata), { a: 1, nested: { b: [1, 2] } });
        assert.deepEqual(JSON.parse((await dest.getNode('m-arr'))!.metadata), [1, 'a']);
        assert.equal((await dest.getNode('m-num'))!.metadata, '5');
        assert.equal((await dest.getNode('m-bool'))!.metadata, 'true');
        assert.equal((await dest.getNode('m-str'))!.metadata, '{"already":"text"}');
        assert.equal((await dest.getNode('m-none'))!.metadata, '{}');
    } finally {
        await dest.close();
    }
});

await test('the migration digest stays strict: only the metadata FORM is normalised', () => {
    const node = (over: Record<string, unknown>): LoreNode => ({
        id: 'x', ...base, metadata: '{}', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', syncedAt: '',
        ...over,
    }) as unknown as LoreNode;
    const dig = (src: LoreNode[], dst: LoreNode[]): [string, string] => [digestOf(src.map(withSqliteMetadata), []), digestOf(dst, [])];

    // object on the source == its JSON text on the destination
    let [a, b] = dig([node({ metadata: { a: 1 } })], [node({ metadata: '{"a":1}' })]);
    assert.equal(a, b, 'object vs its JSON text is equal');
    // number: "5" equals, the old lossy "5.0" does not
    [a, b] = dig([node({ metadata: 5 })], [node({ metadata: '5' })]);
    assert.equal(a, b);
    [a, b] = dig([node({ metadata: 5 })], [node({ metadata: '5.0' })]);
    assert.notEqual(a, b, '5 vs "5.0" must still fail');
    // a different metadata VALUE fails
    [a, b] = dig([node({ metadata: { a: 1 } })], [node({ metadata: '{"a":2}' })]);
    assert.notEqual(a, b, 'different metadata value fails');
    // a genuinely different node (any other field) fails even with matching metadata
    [a, b] = dig([node({ metadata: { a: 1 }, content: 'one' })], [node({ metadata: '{"a":1}', content: 'two' })]);
    assert.notEqual(a, b, 'different content fails');
    [a, b] = dig([node({ metadata: { a: 1 }, updatedAt: '2026-01-01T00:00:00.000Z' })], [node({ metadata: '{"a":1}', updatedAt: '2026-01-02T00:00:00.000Z' })]);
    assert.notEqual(a, b, 'different timestamp fails');
    [a, b] = dig([node({ id: 'x' })], [node({ id: 'y' })]);
    assert.notEqual(a, b, 'different id fails');
    // a missing node fails
    [a, b] = dig([node({}), node({ id: 'z' })], [node({})]);
    assert.notEqual(a, b, 'missing node fails');
});

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
