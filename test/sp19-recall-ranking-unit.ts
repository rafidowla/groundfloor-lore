#!/usr/bin/env tsx
/**
 * sp19-recall-ranking-unit.ts — SP-19 regression.
 *
 * Finding: OPERATOR_CURATED_TYPES was a hardcoded ReadonlySet<string> with
 * domain-specific node type names ('decision', 'convention', 'bug_pattern',
 * 'architecture', 'architecture-doc', 'troubleshooting', 'note'). The ranker
 * used it as a global to grant 1.5× type-bias and implicit curation boost to
 * those specific types — schema-agnostic posture violated.
 *
 * Fix: ranking functions now accept an optional `curatedTypes` parameter
 * (and RankInputs.curatedTypes). When absent or empty, ALL types receive
 * bias 1.0 (schema-agnostic default). Callers that load a workspace schema
 * can pass curatedTypesFromSchema(schema.nodeTypes) to opt specific types in.
 * NodeTypeSpec gains an optional `operatorCurated?: boolean` field.
 *
 * Tests:
 *   (1) workspace schema with NO types marked curated → typeBias 1.0 for all
 *   (2) schema with one type marked operatorCurated:true → typeBias 1.5 for it
 *   (3) no schema / fallback (curatedTypes omitted) → typeBias 1.0 for any type
 *   (4) curationBoost with empty curatedTypes only triggers on metadata.curated
 *   (5) curationBoost with curatedTypes set triggers on type+label path
 *   (6) rankScore uses injected curatedTypes (no global hardcoded list in path)
 *   (7) OPERATOR_CURATED_TYPES still exported for backward-compat (not used in path)
 *   (8) curatedTypesFromSchema helper builds correct set from NodeTypeSpec[]
 */

import { strict as assert } from 'node:assert';

import {
    typeBias,
    curationBoost,
    rankScore,
    reRankLoreNodes,
    curatedTypesFromSchema,
    OPERATOR_CURATED_TYPES,
} from '../packages/lore/src/recall/ranking.js';

/* ------------------------------------------------------------------ */
/* helpers                                                              */
/* ------------------------------------------------------------------ */

function makeNode(type: string, label = 'some label', metadata?: string) {
    return {
        type,
        updatedAt: new Date().toISOString(),
        metadata: metadata ?? null,
        label,
    };
}

let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void) {
    try {
        fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  ✗ ${name}\n    ${msg}`);
        failed++;
        failures.push(`${name}: ${msg}`);
    }
}

/* ------------------------------------------------------------------ */
/* (1) No types marked curated → all biases 1.0                        */
/* ------------------------------------------------------------------ */
console.log('\nSP-19 (1) — schema with no curated types: all bias 1.0');
test('typeBias(decision) with empty curatedTypes = 1.0', () => {
    const empty = new Set<string>();
    assert.strictEqual(typeBias('decision', empty), 1.0);
});
test('typeBias(convention) with empty curatedTypes = 1.0', () => {
    assert.strictEqual(typeBias('convention', new Set()), 1.0);
});
test('typeBias(architecture) with empty curatedTypes = 1.0', () => {
    assert.strictEqual(typeBias('architecture', new Set()), 1.0);
});
test('typeBias(custom-type) with empty curatedTypes = 1.0', () => {
    assert.strictEqual(typeBias('custom-domain-type', new Set()), 1.0);
});

/* ------------------------------------------------------------------ */
/* (2) Schema with one type marked operatorCurated → 1.5× for it only */
/* ------------------------------------------------------------------ */
console.log('\nSP-19 (2) — schema with one curated type: 1.5× for it, 1.0× for others');
test('curatedTypesFromSchema returns set with only the marked type', () => {
    const nodeTypes = [
        { name: 'my-decision', operatorCurated: true },
        { name: 'my-fact', operatorCurated: false },
        { name: 'my-event' },
    ];
    const set = curatedTypesFromSchema(nodeTypes);
    assert.ok(set.has('my-decision'), 'my-decision should be in set');
    assert.ok(!set.has('my-fact'), 'my-fact should NOT be in set');
    assert.ok(!set.has('my-event'), 'my-event should NOT be in set');
    assert.strictEqual(set.size, 1);
});
test('typeBias(my-decision) with schema-derived curatedTypes = 1.5', () => {
    const set = curatedTypesFromSchema([{ name: 'my-decision', operatorCurated: true }]);
    assert.strictEqual(typeBias('my-decision', set), 1.5);
});
test('typeBias(my-fact) with schema-derived curatedTypes = 1.0', () => {
    const set = curatedTypesFromSchema([{ name: 'my-decision', operatorCurated: true }]);
    assert.strictEqual(typeBias('my-fact', set), 1.0);
});
test('typeBias(decision) with custom schema not listing it = 1.0', () => {
    // The old hardcoded 'decision' type gets no boost if not in schema
    const set = curatedTypesFromSchema([{ name: 'my-decision', operatorCurated: true }]);
    assert.strictEqual(typeBias('decision', set), 1.0, 'old hardcoded type must NOT be boosted if schema excludes it');
});

/* ------------------------------------------------------------------ */
/* (3) Fallback: no schema (curatedTypes omitted) → bias 1.0           */
/* ------------------------------------------------------------------ */
console.log('\nSP-19 (3) — fallback (no curatedTypes) → bias 1.0');
test('typeBias(decision) no curatedTypes arg = 1.0', () => {
    assert.strictEqual(typeBias('decision'), 1.0, 'must NOT use old hardcoded list as fallback');
});
test('typeBias(convention) no curatedTypes arg = 1.0', () => {
    assert.strictEqual(typeBias('convention'), 1.0);
});
test('typeBias(bug_pattern) no curatedTypes arg = 1.0', () => {
    assert.strictEqual(typeBias('bug_pattern'), 1.0);
});
test('typeBias(note) no curatedTypes arg = 1.0', () => {
    assert.strictEqual(typeBias('note'), 1.0);
});
test('curatedTypesFromSchema(null) returns empty set', () => {
    const s = curatedTypesFromSchema(null);
    assert.strictEqual(s.size, 0);
});
test('curatedTypesFromSchema(undefined) returns empty set', () => {
    const s = curatedTypesFromSchema(undefined);
    assert.strictEqual(s.size, 0);
});
test('curatedTypesFromSchema([]) returns empty set', () => {
    const s = curatedTypesFromSchema([]);
    assert.strictEqual(s.size, 0);
});

/* ------------------------------------------------------------------ */
/* (4) curationBoost: empty curatedTypes only fires on metadata.curated*/
/* ------------------------------------------------------------------ */
console.log('\nSP-19 (4) — curationBoost with empty curatedTypes');
test('curationBoost: metadata.curated=true fires regardless of curatedTypes', () => {
    const node = makeNode('decision', 'my label', JSON.stringify({ curated: true }));
    const boost = curationBoost(node, new Set());
    assert.ok(boost > 1.0, `boost should be >1.0, got ${boost}`);
});
test('curationBoost: decision type + empty curatedTypes + label = 1.0', () => {
    const node = makeNode('decision', 'my label');
    // With empty curatedTypes, type path should NOT fire
    assert.strictEqual(curationBoost(node, new Set()), 1.0);
});
test('curationBoost: decision type + no curatedTypes arg + label = 1.0', () => {
    const node = makeNode('decision', 'my label');
    // Must NOT use old hardcoded OPERATOR_CURATED_TYPES as fallback
    assert.strictEqual(curationBoost(node), 1.0, 'must NOT boost via hardcoded list');
});

/* ------------------------------------------------------------------ */
/* (5) curationBoost fires on type+label when curatedTypes has the type */
/* ------------------------------------------------------------------ */
console.log('\nSP-19 (5) — curationBoost fires on type+label with curatedTypes');
test('curationBoost: custom-curated type + label fires with schema-derived set', () => {
    const set = curatedTypesFromSchema([{ name: 'my-decision', operatorCurated: true }]);
    const node = makeNode('my-decision', 'a real label');
    const boost = curationBoost(node, set);
    assert.ok(boost > 1.0, `boost should be >1.0, got ${boost}`);
});
test('curationBoost: custom-curated type + empty label does NOT fire', () => {
    const set = curatedTypesFromSchema([{ name: 'my-decision', operatorCurated: true }]);
    const node = makeNode('my-decision', '   '); // whitespace-only label
    assert.strictEqual(curationBoost(node, set), 1.0);
});

/* ------------------------------------------------------------------ */
/* (6) rankScore uses injected curatedTypes                             */
/* ------------------------------------------------------------------ */
console.log('\nSP-19 (6) — rankScore threads curatedTypes correctly');
test('rankScore without curatedTypes: decision type produces same score as unknown type', () => {
    const baseScore = 0.8;
    const nowMs = Date.now();
    const decisionScore = rankScore({ node: makeNode('decision'), baseScore, nowMs });
    const unknownScore  = rankScore({ node: makeNode('unknown-type'), baseScore, nowMs });
    // Both should be equal — no type bias applied without curatedTypes
    assert.strictEqual(decisionScore, unknownScore, 'decision and unknown-type should score identically without curatedTypes');
});
test('rankScore WITH curatedTypes: marked type scores higher than unmarked type', () => {
    const baseScore = 0.8;
    const nowMs = Date.now();
    const curatedTypes = curatedTypesFromSchema([{ name: 'my-decision', operatorCurated: true }]);
    const markedScore   = rankScore({ node: makeNode('my-decision'), baseScore, nowMs, curatedTypes });
    const unmarkedScore = rankScore({ node: makeNode('other-type'),  baseScore, nowMs, curatedTypes });
    assert.ok(markedScore > unmarkedScore, `marked type (${markedScore}) should score > unmarked (${unmarkedScore})`);
});
test('rankScore with custom curatedTypes: old hardcoded type (decision) NOT boosted', () => {
    const baseScore = 0.8;
    const nowMs = Date.now();
    // Schema only marks 'my-decision', not 'decision'
    const curatedTypes = curatedTypesFromSchema([{ name: 'my-decision', operatorCurated: true }]);
    const legacyScore  = rankScore({ node: makeNode('decision'),    baseScore, nowMs, curatedTypes });
    const unmarkedScore = rankScore({ node: makeNode('other-type'), baseScore, nowMs, curatedTypes });
    assert.strictEqual(legacyScore, unmarkedScore, 'old hardcoded "decision" must not be boosted by new schema that excludes it');
});

/* ------------------------------------------------------------------ */
/* (7) OPERATOR_CURATED_TYPES still exported (backward compat)         */
/* ------------------------------------------------------------------ */
console.log('\nSP-19 (7) — OPERATOR_CURATED_TYPES still exported for backward compat');
test('OPERATOR_CURATED_TYPES is exported and is a ReadonlySet', () => {
    assert.ok(OPERATOR_CURATED_TYPES instanceof Set, 'should be a Set');
    assert.ok(OPERATOR_CURATED_TYPES.has('decision'), 'should still contain decision for compat');
});
test('OPERATOR_CURATED_TYPES is NOT consulted in typeBias hot path (no-arg call)', () => {
    // This is the key regression guard: typeBias('decision') must return 1.0, not 1.5
    // If someone re-adds `OPERATOR_CURATED_TYPES` as the fallback, this test catches it.
    assert.strictEqual(typeBias('decision'), 1.0, 'OPERATOR_CURATED_TYPES must not be the implicit fallback');
    assert.strictEqual(typeBias('convention'), 1.0);
    assert.strictEqual(typeBias('bug_pattern'), 1.0);
    assert.strictEqual(typeBias('architecture'), 1.0);
    assert.strictEqual(typeBias('troubleshooting'), 1.0);
    assert.strictEqual(typeBias('note'), 1.0);
});

/* ------------------------------------------------------------------ */
/* (8) curatedTypesFromSchema helper coverage                          */
/* ------------------------------------------------------------------ */
console.log('\nSP-19 (8) — curatedTypesFromSchema helper');
test('multiple types marked operatorCurated', () => {
    const nodeTypes = [
        { name: 'type-a', operatorCurated: true },
        { name: 'type-b', operatorCurated: true },
        { name: 'type-c', operatorCurated: false },
        { name: 'type-d' },
    ];
    const set = curatedTypesFromSchema(nodeTypes);
    assert.strictEqual(set.size, 2);
    assert.ok(set.has('type-a'));
    assert.ok(set.has('type-b'));
    assert.ok(!set.has('type-c'));
    assert.ok(!set.has('type-d'));
});
test('no types marked operatorCurated → empty set', () => {
    const nodeTypes = [
        { name: 'type-a', operatorCurated: false },
        { name: 'type-b' },
    ];
    const set = curatedTypesFromSchema(nodeTypes);
    assert.strictEqual(set.size, 0);
});

/* ------------------------------------------------------------------ */
/* Summary                                                              */
/* ------------------------------------------------------------------ */
console.log(`\nSP-19: ${passed} passed, ${failed} failed`);
if (failed > 0) {
    console.error('FAILURES:\n' + failures.map(f => `  - ${f}`).join('\n'));
    process.exit(1);
}
process.exit(0);
