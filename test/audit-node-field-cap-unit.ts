#!/usr/bin/env tsx
/**
 * test/audit-node-field-cap-unit.ts — Audit fix #2.
 *
 * Before fix #2, every text field on a node (content, label, metadata,
 * evidence, anchors) was unbounded. A single write could hand the engine a
 * multi-megabyte payload — a 20 MB string was accepted in the live probe.
 *
 * Fix #2 adds a 256 KB per-field cap at the nodeService core (all transports)
 * plus the store_node Zod schema. This test splits into:
 *   - Unit checks on the cap helper (instant, exhaustive boundary math)
 *   - One live end-to-end rejection of the original 20 MB attack (the path the
 *     probe actually exploited)
 *
 * The boundary/over-cap fixtures use the helper directly because embedding a
 * genuine 256 KB string through ONNX on every case is ~minutes per case — the
 * cap math is a byte-length check and doesn't need a real embed to validate.
 *
 * Pins:
 *   T1 (live): 20 MB content via nodeUpsert → rejected field_too_large (the attack)
 *   T2: exceedsNodeFieldCap boundary — under cap = false
 *   T3: exceedsNodeFieldCap boundary — over cap = true (every capped field name)
 *   T4: exceedsNodeFieldCap ignores non-strings (no false rejection)
 *   T5: the rejected node is NOT persisted (guard runs before any write)
 */

import assert from 'node:assert/strict';
import { createLore } from '../packages/lore/src/index.js';
import {
    MAX_NODE_FIELD_BYTES,
    CAPPED_NODE_TEXT_FIELDS,
    exceedsNodeFieldCap,
    utf8ByteLength,
} from '../packages/lore/src/engines/nodeFieldLimits.js';

let passed = 0, failed = 0;
const test = (name: string, fn: () => Promise<void>) => {
    return (async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
    })();
};

const KB = 1024;
const HUGE = 'z'.repeat(20 * KB * KB); // 20 MB — the original attack

async function main() {
    const dataDir = process.env.LORE_HOME!;
    const lore = await createLore({ deploymentMode: 'embedded', dataDir });

    console.log('Audit fix #2 — per-field size cap (256 KB)');
    console.log(`  cap = ${MAX_NODE_FIELD_BYTES} bytes (${MAX_NODE_FIELD_BYTES / KB} KB)`);

    await test('T1 (live) a 20 MB content string is rejected (the original attack)', async () => {
        const r = await lore.nodeUpsert({
            id: 'huge-fix2', workspace: 'default', ecosystem: 'probe',
            nodeData: { id: 'huge-fix2', type: 'note', label: 'h', content: HUGE },
            asyncEmbed: true,
        } as any);
        assert.equal(r.ok, false, '20 MB content should be rejected');
        assert.equal((r as any).code, 'field_too_large', `code=${(r as any).code}`);
        assert.match((r as any).error.message, /content/, 'should name the offending field');
    });

    await test('T2 exceedsNodeFieldCap: under-cap string → false', () => {
        const under = 'x'.repeat(MAX_NODE_FIELD_BYTES - 1);
        assert.equal(utf8ByteLength(under), MAX_NODE_FIELD_BYTES - 1);
        assert.equal(exceedsNodeFieldCap(under), false);
        // exactly at cap is allowed (not >)
        const atCap = 'x'.repeat(MAX_NODE_FIELD_BYTES);
        assert.equal(exceedsNodeFieldCap(atCap), false);
    });

    await test('T3 exceedsNodeFieldCap: over-cap string → true (every field name enumerated)', () => {
        const over = 'y'.repeat(MAX_NODE_FIELD_BYTES + 1);
        assert.equal(utf8ByteLength(over), MAX_NODE_FIELD_BYTES + 1);
        assert.equal(exceedsNodeFieldCap(over), true);
        // Confirm the field list covers exactly the fields the guard iterates.
        assert.deepEqual(
            [...CAPPED_NODE_TEXT_FIELDS].sort(),
            ['anchors', 'content', 'evidence', 'label', 'metadata'],
        );
    });

    await test('T4 exceedsNodeFieldCap ignores non-strings (no false rejection)', () => {
        assert.equal(exceedsNodeFieldCap(undefined), false);
        assert.equal(exceedsNodeFieldCap(null), false);
        assert.equal(exceedsNodeFieldCap(12345), false);
        assert.equal(exceedsNodeFieldCap({ a: 1 }), false);
        assert.equal(exceedsNodeFieldCap(['x']), false);
        assert.equal(exceedsNodeFieldCap(''), false);
    });

    await test('T5 the rejected node is NOT persisted (guard runs before any write)', async () => {
        // Try to read back the huge node from T1 — it must not exist.
        const node = await lore.store.storageClient.getNode('huge-fix2', 'default');
        assert.equal(node, null, 'rejected oversized node must not be persisted');
    });

    await lore.dispose();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('TEST HARNESS FAILED:', e); process.exit(2); });
