#!/usr/bin/env tsx
/**
 * manifest-ingest-unit.ts — Unit tests for the Tier 1 ingest runner.
 *
 * Covers:
 *   1. CSV: 100-row file produces 100 writer calls (the headline criterion).
 *   2. JSON: array of objects, same shape, same writer call count.
 *   3. idStrategy: column — derives stable ids from a CSV column.
 *   4. idStrategy: hash — same row twice produces the same id (idempotency).
 *   5. Bad rows are skipped, not crashed; ingest continues.
 *   6. Bad rows are reported with row number + reason.
 *   7. Field mapping: label/content/project/tags fill correctly.
 *   8. Tags: csv comma-split honors tagDelimiter override.
 *   9. Tags: JSON array form is preserved.
 *  10. Required-field absence (idStrategy.column missing on a row) → row skipped.
 *  11. Validator: ingest spec with unknown source rejected.
 *  12. Validator: idStrategy.kind=hash without columns rejected.
 *  13. Validator: mapTo references undeclared node type rejected.
 *  14. Validator: empty fields object rejected.
 */

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
    runIngest,
    validateManifest,
    ManifestValidationError,
    type IngestNodeWrite,
} from '../packages/lore/src/plugins/manifest/index.js';
import type { IngestSpec } from '../packages/lore/src/plugins/manifest.js';

let failed = 0;

function test(name: string, fn: () => void | Promise<void>): () => Promise<void> {
    return async () => {
        try {
            await fn();
            console.log(`  ok  ${name}`);
        } catch (err) {
            console.error(`  FAIL ${name}`);
            console.error((err as Error).stack ?? String(err));
            failed += 1;
        }
    };
}

/** Make a temp dir, run fn with the dir path, clean up after. */
async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lore-ingest-'));
    try {
        return await fn(dir);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}

function arrayWriter(): { writes: IngestNodeWrite[]; writer: (n: IngestNodeWrite) => void } {
    const writes: IngestNodeWrite[] = [];
    return { writes, writer: (n) => { writes.push(n); } };
}

function expectErrors(raw: unknown, expectedPaths: string[]): void {
    try {
        validateManifest(raw);
        assert.fail('expected ManifestValidationError, none thrown');
    } catch (err) {
        if (!(err instanceof ManifestValidationError)) throw err;
        const got = err.errors.map((e) => e.path).sort();
        const want = [...expectedPaths].sort();
        assert.deepEqual(got, want, `paths mismatch — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }
}

const tests = [
    // ── CSV happy path: 100 rows → 100 writes ────────────────────
    test('CSV: 100-row file produces 100 writer calls', async () => {
        await withTmpDir(async (dir) => {
            const lines = ['id,name,email,department'];
            for (let i = 1; i <= 100; i++) {
                lines.push(`e${String(i).padStart(3, '0')},Person ${i},p${i}@x.com,Dept-${i % 5}`);
            }
            const file = path.join(dir, 'employees.csv');
            await fs.writeFile(file, lines.join('\n') + '\n');

            const { writes, writer } = arrayWriter();
            const spec: IngestSpec = {
                source: 'csv',
                file: 'employees.csv',
                mapTo: 'employee',
                idStrategy: { kind: 'column', column: 'id' },
                fields: { label: 'name', content: 'email', project: 'department' },
            };

            const report = await runIngest(spec, dir, writer);
            assert.equal(report.totalRows, 100);
            assert.equal(report.ingested, 100);
            assert.equal(report.skipped, 0);
            assert.equal(writes.length, 100);
            assert.equal(writes[0]!.id, 'e001');
            assert.equal(writes[0]!.label, 'Person 1');
            assert.equal(writes[0]!.content, 'p1@x.com');
            assert.equal(writes[0]!.project, 'Dept-1');
            assert.equal(writes[0]!.type, 'employee');
        });
    }),

    // ── JSON happy path ──────────────────────────────────────────
    test('JSON: array-of-objects produces equivalent writes', async () => {
        await withTmpDir(async (dir) => {
            const data = [
                { id: 'a1', name: 'Sarah', email: 's@x.com', dept: 'Brokerage' },
                { id: 'a2', name: 'Tom', email: 't@x.com', dept: 'Operations' },
            ];
            const file = path.join(dir, 'employees.json');
            await fs.writeFile(file, JSON.stringify(data));

            const { writes, writer } = arrayWriter();
            const spec: IngestSpec = {
                source: 'json',
                file: 'employees.json',
                mapTo: 'employee',
                idStrategy: { kind: 'column', column: 'id' },
                fields: { label: 'name', content: 'email', project: 'dept' },
            };
            const report = await runIngest(spec, dir, writer);
            assert.equal(report.ingested, 2);
            assert.equal(writes[1]!.label, 'Tom');
        });
    }),

    // ── idStrategy: hash idempotency ─────────────────────────────
    test('idStrategy=hash: same row produces the same id every run', async () => {
        await withTmpDir(async (dir) => {
            await fs.writeFile(path.join(dir, 'data.csv'),
                'name,email\nSarah,s@x.com\nTom,t@x.com\n');

            const spec: IngestSpec = {
                source: 'csv',
                file: 'data.csv',
                mapTo: 'employee',
                idStrategy: { kind: 'hash', columns: ['name', 'email'] },
                fields: { label: 'name', content: 'email' },
            };

            const run1 = arrayWriter();
            await runIngest(spec, dir, run1.writer);

            const run2 = arrayWriter();
            await runIngest(spec, dir, run2.writer);

            assert.equal(run1.writes.length, 2);
            assert.equal(run2.writes.length, 2);
            assert.equal(run1.writes[0]!.id, run2.writes[0]!.id);
            assert.equal(run1.writes[1]!.id, run2.writes[1]!.id);
            assert.notEqual(run1.writes[0]!.id, run1.writes[1]!.id);
        });
    }),

    // ── Bad rows: skipped, reported, ingest continues ────────────
    test('CSV with empty id cells skips those rows but ingests the rest', async () => {
        await withTmpDir(async (dir) => {
            await fs.writeFile(path.join(dir, 'data.csv'),
                'id,name\na1,Alice\n,Bob\nc1,Carol\n,\n');

            const { writes, writer } = arrayWriter();
            const spec: IngestSpec = {
                source: 'csv',
                file: 'data.csv',
                mapTo: 'thing',
                idStrategy: { kind: 'column', column: 'id' },
                fields: { label: 'name' },
            };
            const report = await runIngest(spec, dir, writer);
            assert.equal(report.totalRows, 4);
            assert.equal(report.ingested, 2);
            assert.equal(report.skipped, 2);
            assert.equal(report.errors.length, 2);
            assert.ok(report.errors[0]!.reason.includes('idStrategy.column'), report.errors[0]!.reason);
            assert.equal(writes.length, 2);
            assert.equal(writes[0]!.id, 'a1');
            assert.equal(writes[1]!.id, 'c1');
        });
    }),

    test('error report carries 1-based row numbers', async () => {
        await withTmpDir(async (dir) => {
            await fs.writeFile(path.join(dir, 'data.csv'),
                'id,name\na,Alice\n,Bob\nc,Carol\n');

            const { writer } = arrayWriter();
            const spec: IngestSpec = {
                source: 'csv',
                file: 'data.csv',
                mapTo: 'thing',
                idStrategy: { kind: 'column', column: 'id' },
                fields: { label: 'name' },
            };
            const report = await runIngest(spec, dir, writer);
            assert.equal(report.errors[0]!.rowNumber, 2);
        });
    }),

    // ── Tags: CSV split + JSON array preservation ────────────────
    test('tags: CSV cell is comma-split with default delimiter', async () => {
        await withTmpDir(async (dir) => {
            await fs.writeFile(path.join(dir, 'data.csv'),
                'id,name,tag_list\na1,A,"x,y, z"\n');
            const { writes, writer } = arrayWriter();
            const spec: IngestSpec = {
                source: 'csv', file: 'data.csv', mapTo: 't',
                idStrategy: { kind: 'column', column: 'id' },
                fields: { label: 'name', tags: 'tag_list' },
            };
            await runIngest(spec, dir, writer);
            assert.deepEqual(writes[0]!.tags, ['x', 'y', 'z']);
        });
    }),

    test('tags: tagDelimiter override is honored', async () => {
        await withTmpDir(async (dir) => {
            await fs.writeFile(path.join(dir, 'data.csv'),
                'id,name,tag_list\na1,A,x|y|z\n');
            const { writes, writer } = arrayWriter();
            const spec: IngestSpec = {
                source: 'csv', file: 'data.csv', mapTo: 't',
                idStrategy: { kind: 'column', column: 'id' },
                fields: { label: 'name', tags: 'tag_list' },
                tagDelimiter: '|',
            };
            await runIngest(spec, dir, writer);
            assert.deepEqual(writes[0]!.tags, ['x', 'y', 'z']);
        });
    }),

    test('tags: JSON array values are preserved as-is', async () => {
        await withTmpDir(async (dir) => {
            const data = [{ id: 'a', name: 'A', t: ['one', 'two', 'three'] }];
            await fs.writeFile(path.join(dir, 'data.json'), JSON.stringify(data));
            const { writes, writer } = arrayWriter();
            const spec: IngestSpec = {
                source: 'json', file: 'data.json', mapTo: 't',
                idStrategy: { kind: 'column', column: 'id' },
                fields: { label: 'name', tags: 't' },
            };
            await runIngest(spec, dir, writer);
            assert.deepEqual(writes[0]!.tags, ['one', 'two', 'three']);
        });
    }),

    // ── Metadata stamping ────────────────────────────────────────
    test('metadata.source_row records the 1-based row number per write', async () => {
        await withTmpDir(async (dir) => {
            await fs.writeFile(path.join(dir, 'data.csv'),
                'id,name\na,A\nb,B\nc,C\n');
            const { writes, writer } = arrayWriter();
            const spec: IngestSpec = {
                source: 'csv', file: 'data.csv', mapTo: 't',
                idStrategy: { kind: 'column', column: 'id' },
                fields: { label: 'name' },
            };
            await runIngest(spec, dir, writer);
            assert.equal(writes[0]!.metadata['source_row'], 1);
            assert.equal(writes[1]!.metadata['source_row'], 2);
            assert.equal(writes[2]!.metadata['source_row'], 3);
        });
    }),

    // ── Validator coverage ──────────────────────────────────────
    test('validator: ingest source must be csv or json', () => {
        const m = {
            manifestVersion: 1, name: 'x', version: '0.0.1', description: 'd',
            lore: {
                schema: { nodeTypes: [{ name: 't', description: 'd' }] },
                ingest: [{ source: 'xml', file: 'x', mapTo: 't',
                    idStrategy: { kind: 'column', column: 'id' },
                    fields: { label: 'name' } }],
            },
        };
        expectErrors(m, ['lore.ingest[0].source']);
    }),

    test('validator: idStrategy=hash requires columns array', () => {
        const m = {
            manifestVersion: 1, name: 'x', version: '0.0.1', description: 'd',
            lore: {
                schema: { nodeTypes: [{ name: 't', description: 'd' }] },
                ingest: [{ source: 'csv', file: 'x', mapTo: 't',
                    idStrategy: { kind: 'hash' },
                    fields: { label: 'name' } }],
            },
        };
        expectErrors(m, ['lore.ingest[0].idStrategy.columns']);
    }),

    test('validator: mapTo must reference a declared node type', () => {
        const m = {
            manifestVersion: 1, name: 'x', version: '0.0.1', description: 'd',
            lore: {
                schema: { nodeTypes: [{ name: 'declared', description: 'd' }] },
                ingest: [{ source: 'csv', file: 'x', mapTo: 'undeclared',
                    idStrategy: { kind: 'column', column: 'id' },
                    fields: { label: 'name' } }],
            },
        };
        expectErrors(m, ['lore.ingest[0].mapTo']);
    }),

    test('validator: fields object cannot be empty', () => {
        const m = {
            manifestVersion: 1, name: 'x', version: '0.0.1', description: 'd',
            lore: {
                schema: { nodeTypes: [{ name: 't', description: 'd' }] },
                ingest: [{ source: 'csv', file: 'x', mapTo: 't',
                    idStrategy: { kind: 'column', column: 'id' },
                    fields: {} }],
            },
        };
        expectErrors(m, ['lore.ingest[0].fields']);
    }),

    test('validator: unknown LoreNode field in fields map is rejected', () => {
        const m = {
            manifestVersion: 1, name: 'x', version: '0.0.1', description: 'd',
            lore: {
                schema: { nodeTypes: [{ name: 't', description: 'd' }] },
                ingest: [{ source: 'csv', file: 'x', mapTo: 't',
                    idStrategy: { kind: 'column', column: 'id' },
                    fields: { label: 'name', not_a_real_field: 'x' } }],
            },
        };
        expectErrors(m, ['lore.ingest[0].fields.not_a_real_field']);
    }),

    test('validator: full valid ingest manifest passes', () => {
        const m = {
            manifestVersion: 1, name: 'cre-iam', version: '0.1.0',
            description: 'CRE IT identity + access',
            lore: {
                schema: {
                    nodeTypes: [
                        { name: 'employee', description: 'A staff member' },
                        { name: 'application', description: 'A SaaS app' },
                    ],
                },
                ingest: [
                    {
                        id: 'employees',
                        source: 'csv',
                        file: 'data/employees.csv',
                        mapTo: 'employee',
                        idStrategy: { kind: 'column', column: 'id' },
                        fields: { label: 'name', content: 'email', project: 'department' },
                    },
                    {
                        id: 'applications',
                        source: 'json',
                        file: 'data/applications.json',
                        mapTo: 'application',
                        idStrategy: { kind: 'hash', columns: ['vendor', 'name'] },
                        fields: { label: 'name', content: 'vendor', tags: 'criticality' },
                    },
                ],
            },
        };
        const out = validateManifest(m);
        assert.equal(out.lore?.ingest?.length, 2);
    }),
];

(async () => {
    console.log('manifest-ingest-unit.ts');
    for (const t of tests) await t();
    if (failed > 0) {
        console.error(`\n${failed} failing test(s)`);
        process.exit(1);
    }
    console.log(`\nAll ${tests.length} tests passed.`);
})();
