#!/usr/bin/env tsx
/**
 * test/write-target-gate-unit.ts — shared write-path security_scopes gate
 * (security/writeTargetGate.ts): mutateTargetVisible + createIdBlockedForCurrentActor.
 * Pure unit: fake lookups only, no stores, no filesystem.
 */

import assert from 'node:assert/strict';
import { runWithActor } from '../packages/lore/src/security/actorContext.js';
import {
    ID_UNAVAILABLE, ID_UNAVAILABLE_MESSAGE, mutateTargetVisible, createIdBlockedForCurrentActor,
} from '../packages/lore/src/security/writeTargetGate.js';
import type { ItemScopeDeps } from '../packages/lore/src/security/itemScopes.js';

let passed = 0;
let failed = 0;
const test = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

const bound = <T>(scopes: string[], fn: () => Promise<T>): Promise<T> => runWithActor({ portalUserId: 'u', scopes }, fn);
const ids = { nodeId: 'N', verbatimId: 'lore:N' };
const boom = (): never => { throw new Error('lookup must not run'); };

type Src = { node?: unknown; versions?: unknown[]; verbatim?: unknown };
function deps(s: Src): ItemScopeDeps & { calls: string[] } {
    const calls: string[] = [];
    const d: ItemScopeDeps & { calls: string[] } = { workspace: 'ws', calls };
    if ('node' in s) d.getGraphNode = async () => { calls.push('node'); return s.node as never; };
    if ('versions' in s) d.versionStore = { getVersions: async () => { calls.push('ver'); return s.versions; } };
    if ('verbatim' in s) d.getVerbatimRow = async () => { calls.push('vb'); return s.verbatim as never; };
    return d;
}
const throwing = (src: 'node' | 'ver' | 'vb', base: Src = {}): ItemScopeDeps => {
    const d = deps(base);
    if (src === 'node') d.getGraphNode = async () => { throw new Error('x'); };
    if (src === 'ver') d.versionStore = { getVersions: async () => { throw new Error('x'); } };
    if (src === 'vb') d.getVerbatimRow = async () => { throw new Error('x'); };
    return d;
};

console.log('constants');
await test('refusal constants are neutral', async () => {
    assert.equal(ID_UNAVAILABLE, 'id_unavailable');
    assert.doesNotMatch(ID_UNAVAILABLE_MESSAGE, /scope|permission|hidden|exist|denied|forbidden/i);
});

console.log('unbound');
const spies: ItemScopeDeps = {
    workspace: 'ws', getGraphNode: boom as never, versionStore: { getVersions: boom }, getVerbatimRow: boom as never,
};
await test('mutate unbound → true, zero lookups', async () => { assert.equal(await mutateTargetVisible(ids, spies), true); });
await test('create unbound → not blocked, zero lookups', async () => { assert.equal(await createIdBlockedForCurrentActor(ids, spies), false); });

console.log('mutateTargetVisible (bound)');
await test('visible node → true', async () => {
    assert.equal(await bound(['sales'], () => mutateTargetVisible(ids, deps({ node: { security_scopes: ['sales'] } }))), true);
});
await test('hidden node → false', async () => {
    assert.equal(await bound(['finance'], () => mutateTargetVisible(ids, deps({ node: { security_scopes: ['sales'] } }))), false);
});
await test('missing everywhere → false', async () => {
    assert.equal(await bound(['sales'], () => mutateTargetVisible(ids, deps({ node: null, versions: [], verbatim: null }))), false);
});
await test('public ([]) row visible to actor with scopes', async () => {
    assert.equal(await bound(['sales'], () => mutateTargetVisible(ids, deps({ node: { security_scopes: [] } }))), true);
});
await test('actor [] sees public row, not scoped row', async () => {
    assert.equal(await bound([], () => mutateTargetVisible(ids, deps({ node: { security_scopes: [] } }))), true);
    assert.equal(await bound([], () => mutateTargetVisible(ids, deps({ node: { security_scopes: ['sales'] } }))), false);
});
await test('deleted node resolved from version row', async () => {
    const d = deps({ node: null, versions: [{ newState: null, previousState: { security_scopes: ['sales'] } }] });
    assert.equal(await bound(['sales'], () => mutateTargetVisible(ids, d)), true);
    assert.equal(await bound(['finance'], () => mutateTargetVisible(ids, d)), false);
});

console.log('createIdBlockedForCurrentActor (bound)');
await test('all sources absent → allowed', async () => {
    assert.equal(await bound(['sales'], () => createIdBlockedForCurrentActor(ids, deps({ node: null, versions: [], verbatim: null }))), false);
});
await test('no deps at all → allowed', async () => {
    assert.equal(await bound(['sales'], () => createIdBlockedForCurrentActor(ids, { workspace: 'ws' })), false);
});
await test('live hidden → blocked', async () => {
    assert.equal(await bound(['finance'], () => createIdBlockedForCurrentActor(ids, deps({ node: { security_scopes: ['sales'] }, versions: [], verbatim: null }))), true);
});
await test('live visible → allowed', async () => {
    assert.equal(await bound(['sales'], () => createIdBlockedForCurrentActor(ids, deps({ node: { security_scopes: ['sales'] }, versions: [], verbatim: null }))), false);
});
await test('no live node, newest version hidden → blocked', async () => {
    const d = deps({ node: null, versions: [{ newState: { security_scopes: ['sales'] } }], verbatim: null });
    assert.equal(await bound(['finance'], () => createIdBlockedForCurrentActor(ids, d)), true);
    assert.equal(await bound(['sales'], () => createIdBlockedForCurrentActor(ids, d)), false);
});
await test('delete row: newState null falls to previousState', async () => {
    const d = deps({ node: null, versions: [{ newState: null, previousState: { security_scopes: ['sales'] } }], verbatim: null });
    assert.equal(await bound(['finance'], () => createIdBlockedForCurrentActor(ids, d)), true);
});
await test('state without security_scopes key = no info, falls through to previousState', async () => {
    const d = deps({ node: null, versions: [{ newState: { label: 'x' }, previousState: { security_scopes: ['sales'] } }], verbatim: null });
    assert.equal(await bound(['finance'], () => createIdBlockedForCurrentActor(ids, d)), true);
});
await test('state without key in both states = no info, falls to next source (verbatim hidden)', async () => {
    const d = deps({ node: null, versions: [{ newState: { label: 'x' }, previousState: {} }], verbatim: { security_scopes: ['sales'] } });
    assert.equal(await bound(['finance'], () => createIdBlockedForCurrentActor(ids, d)), true);
});
await test('state without key, nothing else → allowed (not read as hidden)', async () => {
    const d = deps({ node: null, versions: [{ newState: { label: 'x' } }], verbatim: null });
    assert.equal(await bound(['finance'], () => createIdBlockedForCurrentActor(ids, d)), false);
});
await test('verbatim hidden → blocked', async () => {
    const d = deps({ node: null, versions: [], verbatim: { security_scopes: ['sales'] } });
    assert.equal(await bound(['finance'], () => createIdBlockedForCurrentActor(ids, d)), true);
});
await test('verbatim visible → allowed', async () => {
    const d = deps({ node: null, versions: [], verbatim: { security_scopes: ['sales'] } });
    assert.equal(await bound(['sales'], () => createIdBlockedForCurrentActor(ids, d)), false);
});
await test("verbatim damaged ['undefined'] → blocked", async () => {
    const d = deps({ node: null, versions: [], verbatim: { security_scopes: ['undefined'] } });
    assert.equal(await bound(['sales'], () => createIdBlockedForCurrentActor(ids, d)), true);
});
await test('verbatim row with absent scopes → blocked (fail closed)', async () => {
    const d = deps({ node: null, versions: [], verbatim: { content: 'x' } });
    assert.equal(await bound(['sales'], () => createIdBlockedForCurrentActor(ids, d)), true);
});
await test('verbatim id defaults to lore:<nodeId>', async () => {
    let seen = '';
    const d: ItemScopeDeps = { workspace: 'ws', getVerbatimRow: async (id) => { seen = id; return null; } };
    await bound(['sales'], () => createIdBlockedForCurrentActor({ nodeId: 'N' }, d));
    assert.equal(seen, 'lore:N');
});
await test('graph lookup throws → blocked', async () => {
    assert.equal(await bound(['sales'], () => createIdBlockedForCurrentActor(ids, throwing('node'))), true);
});
await test('version lookup throws → blocked', async () => {
    assert.equal(await bound(['sales'], () => createIdBlockedForCurrentActor(ids, throwing('ver', { node: null }))), true);
});
await test('verbatim lookup throws → blocked', async () => {
    assert.equal(await bound(['sales'], () => createIdBlockedForCurrentActor(ids, throwing('vb', { node: null, versions: [] }))), true);
});
await test('deny-if-any: live visible but version row hidden → blocked', async () => {
    const d = deps({ node: { security_scopes: ['sales'] }, versions: [{ newState: { security_scopes: ['finance'] } }], verbatim: null });
    assert.equal(await bound(['sales'], () => createIdBlockedForCurrentActor(ids, d)), true);
});
await test('deny-if-any: live+version visible but verbatim hidden → blocked', async () => {
    const d = deps({ node: { security_scopes: ['sales'] }, versions: [{ newState: { security_scopes: ['sales'] } }], verbatim: { security_scopes: ['finance'] } });
    assert.equal(await bound(['sales'], () => createIdBlockedForCurrentActor(ids, d)), true);
});
await test('all present sources visible → allowed', async () => {
    const d = deps({ node: { security_scopes: ['sales'] }, versions: [{ newState: { security_scopes: ['sales'] } }], verbatim: { security_scopes: ['sales'] } });
    assert.equal(await bound(['sales'], () => createIdBlockedForCurrentActor(ids, d)), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
