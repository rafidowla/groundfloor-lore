#!/usr/bin/env tsx
/**
 * test/version-no-op-unit.ts — storage-growth fix 1/3 (R1/R2) unit tests.
 *
 * Must fail on v3.24.2 (which recorded a version row on every upsert
 * unconditionally) and pass after this fix.
 *
 * Covers:
 *   P1-P6. Pure-function coverage of outbox/versionPolicy.ts:
 *          canonicalize (key-order independence), isNoOpVersion (ignore-list),
 *          shouldRecordVersion (skipTypes + missing-previousState),
 *          validateVersionHistoryPolicy.
 *   N1. Re-upsert an unchanged node N times → exactly 1 version row.
 *   N2. Timestamp-only change (createdAt/updatedAt/syncedAt differ,
 *       everything else identical) → no new row.
 *   N3. Real content change → a new row.
 *   N4. Missing previousState (null) → row still recorded, even though the
 *       new node is otherwise identical to some prior state the caller
 *       just didn't supply.
 *   N5. skipTypes → no rows for the skipped type; a different type in the
 *       same call is unaffected; a call with no policy at all (default) is
 *       unaffected (today's behaviour: always records on real/missing-prev
 *       changes, exactly like N1-N4 above with no `versionHistoryPolicy`).
 *   N6. Regression coverage for the FIELDS_CLEARED_ON_OMISSION fix, against
 *       makeSurrealLikeFakeGraph() — a fake that (unlike makeFakeGraph())
 *       does NOT fall back to the prior row for type/label/tags/project/
 *       ecosystem/metadata, matching the real Surreal write layer
 *       (engines/surreal/surrealGraphWrites.ts's toNodeDocument). Proves a
 *       caller that omits one of those fields on a partial update gets a
 *       version recorded (the bug this fix closes), that an already-empty
 *       field omitted again stays a no-op, and that a genuinely-falls-back
 *       field (status) omitted is unaffected.
 *
 * Fakes follow the same pattern as test/node-service-unit.ts (S8 tests) —
 * no shared test-helpers module exists in this codebase; each file's fakes
 * are self-contained by convention.
 */

import assert from 'node:assert/strict';
import { nodeUpsert } from '../packages/lore/src/core/nodeService.js';
import type { NodeWriteGraph, NodeUpsertArgs } from '../packages/lore/src/core/nodeService.js';
import type { LoreNode } from '../packages/lore/src/providers/types.js';
import { tagsToArray } from '../packages/lore/src/engines/normalizeTags.js';
import {
    canonicalize,
    isNoOpVersion,
    shouldRecordVersion,
    validateVersionHistoryPolicy,
    DEFAULT_IGNORED_VERSION_FIELDS,
    FIELDS_CLEARED_ON_OMISSION,
    isFieldOmissionEmpty,
} from '../packages/lore/src/outbox/versionPolicy.js';

/* ─── tiny test harness (consistent with every other test/ file) ─────── */

let passed = 0;
let failed = 0;
const pending: Array<Promise<void>> = [];

function test(name: string, fn: () => Promise<void> | void): void {
    pending.push(
        (async () => {
            try {
                await fn();
                console.log(`  ✓ ${name}`);
                passed++;
            } catch (err) {
                console.error(`  ✗ ${name}\n    ${(err as Error).message}`);
                failed++;
            }
        })(),
    );
}

console.log('storage-growth fix 1/3 — no-op version skip + per-type history policy');

/* ─── shared fakes (mirrors test/node-service-unit.ts) ───────────────── */

function makeFakeGraph(): { graph: NodeWriteGraph; live: Map<string, Record<string, unknown>> } {
    const live = new Map<string, Record<string, unknown>>();
    const graph: NodeWriteGraph = {
        async upsertNode(node: Record<string, unknown>) {
            const id = String(node.id);
            const stored = {
                ...node,
                type: node.type ?? 'decision',
                label: node.label ?? '',
                project: node.project ?? 'default',
                ecosystem: node.ecosystem ?? '*',
                // Deliberately a FRESH timestamp on every call, matching the
                // real GraphProvider contract (createdAt/updatedAt/syncedAt
                // are stamped by the provider, not the caller) — this is the
                // exact condition that made every pre-fix upsert differ.
                updatedAt: new Date().toISOString(),
                syncedAt: new Date().toISOString(),
            } as Record<string, unknown>;
            live.set(id, stored);
            return stored as never;
        },
        async deleteNode(id: string) {
            live.delete(id);
        },
    };
    return { graph, live };
}

function makeNodeData(id: string, overrides?: Record<string, unknown>): Record<string, unknown> {
    return {
        id,
        type: 'decision',
        label: `label for ${id}`,
        content: `content for ${id}`,
        tags: 'unit-test',
        project: 'test-workspace',
        ecosystem: '*',
        ...overrides,
    };
}

function baseArgs(id: string, targetGraph: NodeWriteGraph, nodeData?: Record<string, unknown>): NodeUpsertArgs {
    return {
        id,
        workspace: 'test-workspace',
        ecosystem: '*',
        nodeData: nodeData ?? makeNodeData(id),
        targetGraph,
        initiator: 'test:version-no-op',
    };
}

function makeFakeVersionStore(): { store: { recordVersion(v: unknown): void }; versions: unknown[] } {
    const versions: unknown[] = [];
    return { store: { recordVersion: (v: unknown) => { versions.push(v); } }, versions };
}

/* ─── P1-P6: pure-function coverage ──────────────────────────────────── */

test('P1 — canonicalize: key order does not affect JSON.stringify equality', () => {
    const a = { b: 2, a: 1, c: { y: 2, x: 1 } };
    const b = { a: 1, c: { x: 1, y: 2 }, b: 2 };
    assert.equal(JSON.stringify(canonicalize(a)), JSON.stringify(canonicalize(b)));
});

test('P2 — canonicalize: array order IS preserved (not sorted)', () => {
    const a = { list: [1, 2, 3] };
    const b = { list: [3, 2, 1] };
    assert.notEqual(JSON.stringify(canonicalize(a)), JSON.stringify(canonicalize(b)));
});

test('P3 — isNoOpVersion: identical content after ignoring default fields → true', () => {
    const prev = { id: 'x', type: 'decision', content: 'same', createdAt: 'A', updatedAt: 'A', syncedAt: 'A' };
    const next = { id: 'x', type: 'decision', content: 'same', createdAt: 'A', updatedAt: 'B', syncedAt: 'C' };
    assert.equal(isNoOpVersion(prev, next), true);
});

test('P4 — isNoOpVersion: a real content difference → false', () => {
    const prev = { id: 'x', content: 'same', updatedAt: 'A' };
    const next = { id: 'x', content: 'different', updatedAt: 'B' };
    assert.equal(isNoOpVersion(prev, next), false);
});

test('P5 — isNoOpVersion: default ignore-list matches the documented minimum', () => {
    for (const f of ['createdAt', 'updatedAt', 'syncedAt']) {
        assert.ok(DEFAULT_IGNORED_VERSION_FIELDS.includes(f), `expected ${f} in default ignore-list`);
    }
});

test('P6 — shouldRecordVersion: skipTypes wins even when content genuinely changed', () => {
    const prev = { content: 'a' };
    const next = { content: 'b' };
    assert.equal(
        shouldRecordVersion('code_symbol', prev, next, { skipTypes: ['code_symbol'] }),
        false,
    );
});

test('P7 — shouldRecordVersion: skipTypes wins over missing previousState too', () => {
    // skipTypes is a type-level opt-out and is checked first — a caller that
    // configured a type to be skipped does not want rows for it regardless
    // of whether a pre-read happened.
    assert.equal(shouldRecordVersion('code_symbol', null, {}, { skipTypes: ['code_symbol'] }), false);
    assert.equal(shouldRecordVersion('code_symbol', undefined, {}, { skipTypes: ['code_symbol'] }), false);
});

test('P8 — shouldRecordVersion: missing previousState always records for a non-skipped type', () => {
    assert.equal(shouldRecordVersion('decision', null, { content: 'x' }), true);
    assert.equal(shouldRecordVersion('decision', undefined, { content: 'x' }), true);
});

test('P9 — validateVersionHistoryPolicy: accepts a well-formed policy', () => {
    validateVersionHistoryPolicy({ skipTypes: ['code_symbol'], retentionDaysByType: { code_symbol: 7 } });
    validateVersionHistoryPolicy(undefined);
});

test('P10 — validateVersionHistoryPolicy: rejects non-positive retentionDaysByType', () => {
    assert.throws(() => validateVersionHistoryPolicy({ retentionDaysByType: { decision: 0 } }));
    assert.throws(() => validateVersionHistoryPolicy({ retentionDaysByType: { decision: -1 } }));
});

test('P11 — validateVersionHistoryPolicy: rejects non-string skipTypes entries', () => {
    assert.throws(() => validateVersionHistoryPolicy({ skipTypes: [1 as unknown as string] }));
});

/* ─── P12-P21: isNoOpVersion — clear-on-omission fields (bug found in       */
/*    review of 3a774082; see versionPolicy.ts's corrected doc comment and  */
/*    FIELDS_CLEARED_ON_OMISSION). The ORIGINAL isNoOpVersion compared only */
/*    newState's own keys, so omitting one of these fields was invisible to */
/*    the no-op check even though at least one local write layer (Surreal   */
/*    for 5 of them, both local engines for `tags`) clears the stored value */
/*    on omission — see engines/surreal/surrealGraphWrites.ts's             */
/*    toNodeDocument() (~98-110) and engines/sqlite/sqliteGraphRow.ts's     */
/*    toNodeRow() (~104). These P-tests fail on 3a774082 (pre-fix           */
/*    isNoOpVersion returns true for all of P12-P17) and pass after.        */

const baseVersioned = {
    id: 'x', type: 'decision', label: 'a label', content: 'same content',
    tags: ['a', 'b'], project: 'my-project', ecosystem: 'my-eco',
    metadata: '{"k":1}', status: 'active',
    createdAt: 'A', updatedAt: 'A', syncedAt: 'A',
};

test('P12 — isNoOpVersion: omitted tags on a node that HAD tags → false (must record)', () => {
    const prev = { ...baseVersioned };
    const next: Record<string, unknown> = { ...baseVersioned, updatedAt: 'B', syncedAt: 'C' };
    delete next.tags; // real caller omission — Surreal AND SQLite both clear tags to [] on omission
    assert.equal(isNoOpVersion(prev, next), false, 'omitting non-empty tags must not be treated as a no-op');
});

test('P13 — isNoOpVersion: omitted tags on a node whose tags were ALREADY empty → true (no spurious record)', () => {
    const prev = { ...baseVersioned, tags: [] };
    const next: Record<string, unknown> = { ...baseVersioned, tags: [], updatedAt: 'B', syncedAt: 'C' };
    delete next.tags;
    assert.equal(isNoOpVersion(prev, next), true, 'omitting already-empty tags must stay a no-op');
});

test('P14 — isNoOpVersion: omitted metadata (previously non-empty) → false', () => {
    const prev = { ...baseVersioned };
    const next: Record<string, unknown> = { ...baseVersioned, updatedAt: 'B' };
    delete next.metadata;
    assert.equal(isNoOpVersion(prev, next), false, 'omitting non-empty metadata (Surreal clears it) must record');
});

test('P15 — isNoOpVersion: omitted metadata that was ALREADY "{}" → true', () => {
    const prev = { ...baseVersioned, metadata: '{}' };
    const next: Record<string, unknown> = { ...baseVersioned, metadata: '{}', updatedAt: 'B' };
    delete next.metadata;
    assert.equal(isNoOpVersion(prev, next), true);
});

test('P16 — isNoOpVersion: omitted label (previously non-empty) → false', () => {
    const prev = { ...baseVersioned };
    const next: Record<string, unknown> = { ...baseVersioned, updatedAt: 'B' };
    delete next.label;
    assert.equal(isNoOpVersion(prev, next), false, 'omitting a non-empty label (Surreal clears it) must record');
});

test('P17 — isNoOpVersion: omitted label that was ALREADY empty → true', () => {
    const prev = { ...baseVersioned, label: '' };
    const next: Record<string, unknown> = { ...baseVersioned, label: '', updatedAt: 'B' };
    delete next.label;
    assert.equal(isNoOpVersion(prev, next), true);
});

test('P18 — isNoOpVersion: omitted project (non-"*") → false; omitted project already "*" → true', () => {
    const prevSet = { ...baseVersioned };
    const nextOmitted: Record<string, unknown> = { ...baseVersioned, updatedAt: 'B' };
    delete nextOmitted.project;
    assert.equal(isNoOpVersion(prevSet, nextOmitted), false, 'omitting a real project must record');

    const prevWildcard = { ...baseVersioned, project: '*' };
    const nextWildcardOmitted: Record<string, unknown> = { ...baseVersioned, project: '*', updatedAt: 'B' };
    delete nextWildcardOmitted.project;
    assert.equal(isNoOpVersion(prevWildcard, nextWildcardOmitted), true, 'omitting an already-"*" project stays a no-op');
});

test('P19 — isNoOpVersion: omitted ecosystem (non-"*") → false; omitted ecosystem already "*" → true', () => {
    const prevSet = { ...baseVersioned };
    const nextOmitted: Record<string, unknown> = { ...baseVersioned, updatedAt: 'B' };
    delete nextOmitted.ecosystem;
    assert.equal(isNoOpVersion(prevSet, nextOmitted), false, 'omitting a real ecosystem must record');

    const prevWildcard = { ...baseVersioned, ecosystem: '*' };
    const nextWildcardOmitted: Record<string, unknown> = { ...baseVersioned, ecosystem: '*', updatedAt: 'B' };
    delete nextWildcardOmitted.ecosystem;
    assert.equal(isNoOpVersion(prevWildcard, nextWildcardOmitted), true, 'omitting an already-"*" ecosystem stays a no-op');
});

test('P20 — isNoOpVersion: omitted type (non-empty) → false; omitted type already "" → true', () => {
    const prevSet = { ...baseVersioned };
    const nextOmitted: Record<string, unknown> = { ...baseVersioned, updatedAt: 'B' };
    delete nextOmitted.type;
    assert.equal(isNoOpVersion(prevSet, nextOmitted), false, 'omitting a real type must record');

    const prevEmpty = { ...baseVersioned, type: '' };
    const nextEmptyOmitted: Record<string, unknown> = { ...baseVersioned, type: '', updatedAt: 'B' };
    delete nextEmptyOmitted.type;
    assert.equal(isNoOpVersion(prevEmpty, nextEmptyOmitted), true);
});

test('P21 — isNoOpVersion: omitted status (a field BOTH engines fall back on) stays a no-op — control, proves the fix is not over-broad', () => {
    const prev = { ...baseVersioned, status: 'archived' };
    const next: Record<string, unknown> = { ...baseVersioned, status: 'archived', updatedAt: 'B' };
    delete next.status; // status is NOT in FIELDS_CLEARED_ON_OMISSION — both engines preserve it
    assert.equal(isNoOpVersion(prev, next), true, 'status omission genuinely falls back on both engines — must stay a no-op');
});

test('P22 — FIELDS_CLEARED_ON_OMISSION matches the documented six fields', () => {
    for (const f of ['type', 'label', 'tags', 'project', 'ecosystem', 'metadata']) {
        assert.ok(FIELDS_CLEARED_ON_OMISSION.includes(f), `expected ${f} in FIELDS_CLEARED_ON_OMISSION`);
    }
    assert.equal(FIELDS_CLEARED_ON_OMISSION.length, 6);
});

test('P23 — isFieldOmissionEmpty: per-field empty sentinels', () => {
    assert.equal(isFieldOmissionEmpty('tags', []), true);
    assert.equal(isFieldOmissionEmpty('tags', ['a']), false);
    assert.equal(isFieldOmissionEmpty('project', '*'), true);
    assert.equal(isFieldOmissionEmpty('project', ''), true);
    assert.equal(isFieldOmissionEmpty('project', 'real'), false);
    assert.equal(isFieldOmissionEmpty('ecosystem', '*'), true);
    assert.equal(isFieldOmissionEmpty('metadata', '{}'), true);
    assert.equal(isFieldOmissionEmpty('metadata', {}), true);
    assert.equal(isFieldOmissionEmpty('metadata', '{"a":1}'), false);
    assert.equal(isFieldOmissionEmpty('label', ''), true);
    assert.equal(isFieldOmissionEmpty('type', ''), true);
    assert.equal(isFieldOmissionEmpty('type', undefined), true);
    assert.equal(isFieldOmissionEmpty('type', null), true);
});

/* ─── N1-N4: nodeUpsert-level behaviour, via the shared hooks chokepoint  */

test('N1 — re-upsert an unchanged node 5 times → exactly 1 version row', async () => {
    const { graph } = makeFakeGraph();
    const { store, versions } = makeFakeVersionStore();
    const nodeData = makeNodeData('n1-node');

    let previousState: LoreNode | null = null;
    for (let i = 0; i < 5; i++) {
        const result = await nodeUpsert(baseArgs('n1-node', graph, nodeData), {
            versionStore: store as never,
            previousState,
        });
        assert.ok(result.ok === true);
        previousState = result.ok === true ? result.node : null;
    }

    assert.equal(versions.length, 1, `expected exactly 1 version row, got ${versions.length}`);
});

test('N2 — timestamp-only change (createdAt/updatedAt/syncedAt) → no new row', async () => {
    const { graph } = makeFakeGraph();
    const { store, versions } = makeFakeVersionStore();
    const nodeData = makeNodeData('n2-node');

    const first = await nodeUpsert(baseArgs('n2-node', graph, nodeData), { versionStore: store as never, previousState: null });
    assert.ok(first.ok === true);
    const firstNode: LoreNode | null = first.ok === true ? first.node : null;

    // Second upsert: same nodeData (content unchanged); the fake graph stamps
    // FRESH createdAt/updatedAt/syncedAt on every call (see makeFakeGraph),
    // exactly mirroring the real GraphProvider contract this fix targets.
    const second = await nodeUpsert(baseArgs('n2-node', graph, nodeData), {
        versionStore: store as never,
        previousState: firstNode,
    });
    assert.ok(second.ok === true);

    assert.equal(versions.length, 1, 'timestamp-only difference must not add a second row');
});

test('N3 — a real content change → a new row', async () => {
    const { graph } = makeFakeGraph();
    const { store, versions } = makeFakeVersionStore();

    const first = await nodeUpsert(baseArgs('n3-node', graph, makeNodeData('n3-node', { content: 'v1' })), {
        versionStore: store as never,
        previousState: null,
    });
    const firstNode: LoreNode | null = first.ok === true ? first.node : null;

    await nodeUpsert(baseArgs('n3-node', graph, makeNodeData('n3-node', { content: 'v2' })), {
        versionStore: store as never,
        previousState: firstNode,
    });

    assert.equal(versions.length, 2, 'real content change must add a second row');
});

test('N4 — missing previousState (null) always records, even for content matching a prior write the caller did not supply', async () => {
    const { graph } = makeFakeGraph();
    const { store, versions } = makeFakeVersionStore();
    const nodeData = makeNodeData('n4-node');

    await nodeUpsert(baseArgs('n4-node', graph, nodeData), { versionStore: store as never, previousState: null });
    // Second call: SAME content, but the caller again supplies no
    // previousState (e.g. a pre-read failed or was skipped) — must still
    // record, per R1's "never skip on missing data" rule.
    await nodeUpsert(baseArgs('n4-node', graph, nodeData), { versionStore: store as never, previousState: null });

    assert.equal(versions.length, 2, 'missing previousState must always record, never skip');
});

/* ─── N5: skipTypes end-to-end through nodeUpsert ────────────────────── */

test('N5a — skipTypes: no version rows for a skipped type, even on real content changes', async () => {
    const { graph } = makeFakeGraph();
    const { store, versions } = makeFakeVersionStore();
    const policy = { skipTypes: ['code_symbol'] };

    const first = await nodeUpsert(
        baseArgs('n5a-node', graph, makeNodeData('n5a-node', { type: 'code_symbol', content: 'v1' })),
        { versionStore: store as never, previousState: null, versionHistoryPolicy: policy },
    );
    const firstNode: LoreNode | null = first.ok === true ? first.node : null;
    await nodeUpsert(
        baseArgs('n5a-node', graph, makeNodeData('n5a-node', { type: 'code_symbol', content: 'v2' })),
        { versionStore: store as never, previousState: firstNode, versionHistoryPolicy: policy },
    );

    assert.equal(versions.length, 0, 'skipped type must never record, even on real content changes');
});

test('N5b — skipTypes: a non-skipped type in the same policy is unaffected', async () => {
    const { graph } = makeFakeGraph();
    const { store, versions } = makeFakeVersionStore();
    const policy = { skipTypes: ['code_symbol'] };

    await nodeUpsert(
        baseArgs('n5b-node', graph, makeNodeData('n5b-node', { type: 'decision', content: 'v1' })),
        { versionStore: store as never, previousState: null, versionHistoryPolicy: policy },
    );

    assert.equal(versions.length, 1, 'a type not in skipTypes must still record normally');
});

test('N5c — default (no versionHistoryPolicy) — behaviour unaffected by Fix 2, same as N1-N4', async () => {
    const { graph } = makeFakeGraph();
    const { store, versions } = makeFakeVersionStore();

    await nodeUpsert(
        baseArgs('n5c-node', graph, makeNodeData('n5c-node', { type: 'code_symbol', content: 'v1' })),
        { versionStore: store as never, previousState: null },
    );

    assert.equal(versions.length, 1, 'with no policy, even a code_* type records normally (no implicit skip)');
});

/* ─── N6: nodeUpsert against the REAL echo shape upsertNode() returns
   (the actual bug FIELDS_CLEARED_ON_OMISSION fixes) ─────────────────────

   Both real engines' exported upsertNode() (surrealGraphWrites.ts,
   sqliteGraphWrites.ts) return the SAME shape to nodeService.ts:
       { ...node, tags: tagsToArray(node.tags), createdAt, updatedAt, syncedAt }
   i.e. a spread of the caller's raw nodeData, NOT the toNodeDocument/
   toNodeRow write-document (which is a separate, DB-write-only object with
   its own per-engine fallback behaviour). Two consequences that make
   makeFakeGraph() above unsuitable for this regression:
     1. `tags` is UNCONDITIONALLY recomputed via tagsToArray(node.tags), so
        it is NEVER actually absent from this echo — tagsToArray(undefined)
        is `[]`, so an omitted tags field was already caught by the OLD
        (pre-fix) comparison, since the 'tags' key is always present. Tags
        omission is still exercised directly at the pure-function level
        (P12/P13 above, and by isNoOpVersion's own contract for any OTHER
        caller that might not force tags this way) — just not reachable as
        a "truly absent key" through this echo.
     2. `type`, `label`, and `metadata` have NO such forcing — they are only
        in the echo if the caller's nodeData literally had that key. A
        caller that omits one of those on a partial update produces a
        newState that is really, truly missing the key (not `undefined`,
        absent), which is exactly the shape the old
        `for (const key of Object.keys(newObj))` loop could never see —
        this is the actual reachable instance of the bug.
   makeSurrealLikeFakeGraph() reproduces this echo exactly (spread + forced
   tags + stamped timestamps), so N6a-c exercise the FIELDS_CLEARED_ON_OMISSION
   loop through a realistic caller shape rather than a hand-built object. */
function makeSurrealLikeFakeGraph(): { graph: NodeWriteGraph; live: Map<string, Record<string, unknown>> } {
    const live = new Map<string, Record<string, unknown>>();
    const graph: NodeWriteGraph = {
        async upsertNode(node: Record<string, unknown>) {
            const id = String(node.id);
            const prior = live.get(id);
            const stored: Record<string, unknown> = {
                ...node,
                // status DOES fall back to the prior row on both real
                // engines — included only as a contrast/control (N6d).
                status: node.status ?? (prior?.status as string | undefined) ?? 'active',
                // Forced unconditionally, exactly like the real
                // upsertNode() return on both engines — never key-absent.
                tags: tagsToArray(node.tags),
                updatedAt: new Date().toISOString(),
                syncedAt: new Date().toISOString(),
            };
            live.set(id, stored);
            return stored as never;
        },
        async deleteNode(id: string) {
            live.delete(id);
        },
    };
    return { graph, live };
}

test('N6a — omitted label on the real upsertNode() echo shape: version recorded (the bug this fix closes)', async () => {
    const { graph } = makeSurrealLikeFakeGraph();
    const { store, versions } = makeFakeVersionStore();

    const first = await nodeUpsert(
        baseArgs('n6a-node', graph, makeNodeData('n6a-node', { label: 'a real label' })),
        { versionStore: store as never, previousState: null },
    );
    const firstNode: LoreNode | null = first.ok === true ? first.node : null;
    assert.ok(firstNode, 'first upsert must succeed');
    assert.equal(firstNode!.label, 'a real label', 'precondition: first upsert must have a non-empty label');

    // Partial update: caller omits `label` entirely (the key is truly
    // absent from nodeData, not merely set to ''). Old isNoOpVersion never
    // looked at a key missing from newState, so a caller relying on
    // omit-to-preserve who instead hit a no-fallback engine field lost the
    // version record entirely.
    const partial: Record<string, unknown> = makeNodeData('n6a-node');
    delete partial.label;
    await nodeUpsert(
        baseArgs('n6a-node', graph, partial),
        { versionStore: store as never, previousState: firstNode },
    );

    assert.equal(versions.length, 2, 'omitting a previously-non-empty label field must record a version');
});

test('N6b — omitted metadata (and label again, combined) on the real echo shape: version recorded', async () => {
    const { graph } = makeSurrealLikeFakeGraph();
    const { store, versions } = makeFakeVersionStore();

    const first = await nodeUpsert(
        baseArgs('n6b-node', graph, makeNodeData('n6b-node', { metadata: '{"k":1}', label: 'has a label' })),
        { versionStore: store as never, previousState: null },
    );
    const firstNode: LoreNode | null = first.ok === true ? first.node : null;
    assert.ok(firstNode, 'first upsert must succeed');

    const partial: Record<string, unknown> = makeNodeData('n6b-node');
    delete partial.metadata;
    delete partial.label;
    await nodeUpsert(
        baseArgs('n6b-node', graph, partial),
        { versionStore: store as never, previousState: firstNode },
    );

    assert.equal(versions.length, 2, 'omitting previously-non-empty metadata/label must record a version');
});

test('N6c — omitted label on a node whose label was already empty: still a no-op', async () => {
    const { graph } = makeSurrealLikeFakeGraph();
    const { store, versions } = makeFakeVersionStore();

    const noLabel: Record<string, unknown> = makeNodeData('n6c-node');
    delete noLabel.label;
    const first = await nodeUpsert(
        baseArgs('n6c-node', graph, noLabel),
        { versionStore: store as never, previousState: null },
    );
    const firstNode: LoreNode | null = first.ok === true ? first.node : null;
    assert.ok(firstNode, 'first upsert must succeed');
    assert.equal(firstNode!.label, undefined, 'precondition: first upsert must genuinely lack a label key');

    const secondOmit: Record<string, unknown> = makeNodeData('n6c-node');
    delete secondOmit.label;
    await nodeUpsert(
        baseArgs('n6c-node', graph, secondOmit),
        { versionStore: store as never, previousState: firstNode },
    );

    assert.equal(versions.length, 1, 'omitting an already-empty/absent label field must stay a no-op');
});

test('N6d — omitted status (a field that genuinely falls back on both engines): still a no-op', async () => {
    const { graph } = makeSurrealLikeFakeGraph();
    const { store, versions } = makeFakeVersionStore();

    const first = await nodeUpsert(
        baseArgs('n6d-node', graph, makeNodeData('n6d-node', { status: 'active' })),
        { versionStore: store as never, previousState: null },
    );
    const firstNode: LoreNode | null = first.ok === true ? first.node : null;
    assert.ok(firstNode, 'first upsert must succeed');

    const partial: Record<string, unknown> = makeNodeData('n6d-node');
    delete partial.status;
    await nodeUpsert(
        baseArgs('n6d-node', graph, partial),
        { versionStore: store as never, previousState: firstNode },
    );

    assert.equal(versions.length, 1, 'a genuinely-falls-back field must not be flagged just because it is omitted');
});

/* ─── run ─────────────────────────────────────────────────────────────── */

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
