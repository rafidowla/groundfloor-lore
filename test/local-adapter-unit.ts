#!/usr/bin/env tsx
/**
 * local-adapter-unit.ts — smoke test for LocalAdapter umbrella wiring.
 *
 * Doesn't bring up real Kùzu/LanceDB — passes minimal stub instances
 * to verify:
 *   - the umbrella exposes all four surfaces
 *   - mode is 'local'
 *   - tables defaults to the unimplementedTables stub when omitted
 *   - the stub throws (not silently no-ops)
 *
 * Real end-to-end LocalAdapter wiring will be exercised by the
 * integration tests once construction helpers land in step-2 chunk N.
 */

import assert from 'node:assert/strict';
import { LocalAdapter } from '../packages/lore/src/engines/localAdapter.js';
import type {
    CollectionStorage,
    IVerbatimStore,
    IAnalyticalStorage,
} from '../packages/lore/src/contracts/index.js';

const stubGraph = {} as CollectionStorage;
const stubVerbatim = {} as IVerbatimStore;
const stubAnalytical = {} as IAnalyticalStorage;

let _passed = 0;
let _failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        _passed++;
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).message}`);
        _failed++;
    }
}

async function run(): Promise<void> {
    console.log('LocalAdapter');

    await test('mode is "local"', () => {
        const a = new LocalAdapter({
            graph: stubGraph, verbatim: stubVerbatim, analytical: stubAnalytical,
        });
        assert.equal(a.mode, 'local');
    });

    await test('exposes all four surfaces', () => {
        const a = new LocalAdapter({
            graph: stubGraph, verbatim: stubVerbatim, analytical: stubAnalytical,
        });
        assert.ok(a.graph);
        assert.ok(a.verbatim);
        assert.ok(a.analytical);
        assert.ok(a.tables);
    });

    await test('tables stub throws (not silent)', async () => {
        const a = new LocalAdapter({
            graph: stubGraph, verbatim: stubVerbatim, analytical: stubAnalytical,
        });
        await assert.rejects(
            () => a.tables.insert('x', { id: '1' }),
            /KuzuTableStorage not yet implemented/,
        );
    });

    await test('caller-supplied tables wins over stub', () => {
        const customTables = { createTable: async () => {} } as unknown as
            import('../packages/lore/src/contracts/index.js').ITableStorage;
        const a = new LocalAdapter({
            graph: stubGraph, verbatim: stubVerbatim, analytical: stubAnalytical,
            tables: customTables,
        });
        assert.equal(a.tables, customTables);
    });

    console.log(`\n${_passed} passed, ${_failed} failed`);
    process.exit(_failed > 0 ? 1 : 0);
}

run().catch(err => {
    console.error('test runner error:', err);
    process.exit(2);
});
