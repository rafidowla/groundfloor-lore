#!/usr/bin/env tsx
/**
 * dataplane-adapter-unit.ts — DataplaneAdapter umbrella shape tests.
 *
 * Doesn't make real Dataplane HTTP calls. Verifies:
 *   - mode is 'cloud'
 *   - all four surfaces exposed
 *   - analytical / tables stubs reject (not silent no-op)
 *   - caller-supplied analytical / tables override the stubs
 */

import assert from 'node:assert/strict';
import { DataplaneAdapter } from '../packages/lore/src/engines/dataplaneAdapter.js';
import type {
    CollectionStorage,
    IVerbatimStore,
    IAnalyticalStorage,
    ITableStorage,
} from '../packages/lore/src/contracts/index.js';

const stubGraph = {} as CollectionStorage;
const stubVerbatim = {} as IVerbatimStore;

let passed = 0, failed = 0;
const test = async (name: string, fn: () => void | Promise<void>) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

(async () => {
    console.log('DataplaneAdapter');

    await test('mode is "cloud"', () => {
        const a = new DataplaneAdapter({ graph: stubGraph, verbatim: stubVerbatim });
        assert.equal(a.mode, 'cloud');
    });

    await test('exposes all four surfaces', () => {
        const a = new DataplaneAdapter({ graph: stubGraph, verbatim: stubVerbatim });
        assert.ok(a.graph && a.verbatim && a.analytical && a.tables);
    });

    await test('analytical stub rejects (not silent)', async () => {
        const a = new DataplaneAdapter({ graph: stubGraph, verbatim: stubVerbatim });
        await assert.rejects(() => a.analytical.count('Sale'), /not yet wired/);
    });

    await test('tables stub rejects (not silent)', async () => {
        const a = new DataplaneAdapter({ graph: stubGraph, verbatim: stubVerbatim });
        await assert.rejects(() => a.tables.insert('X', { id: '1' }), /not yet wired/);
    });

    await test('caller-supplied analytical wins over stub', () => {
        const real = { count: async () => 7 } as unknown as IAnalyticalStorage;
        const a = new DataplaneAdapter({ graph: stubGraph, verbatim: stubVerbatim, analytical: real });
        assert.equal(a.analytical, real);
    });

    await test('caller-supplied tables wins over stub', () => {
        const real = { createTable: async () => {} } as unknown as ITableStorage;
        const a = new DataplaneAdapter({ graph: stubGraph, verbatim: stubVerbatim, tables: real });
        assert.equal(a.tables, real);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})();
