#!/usr/bin/env tsx
/**
 * test/write-scopes-followups-unit.ts — review follow-ups to the row-level
 * security_scopes write-path work:
 *   L2 validateSupersedesIds' cycle walk ends at a hidden hop (a chain through a node the
 *      actor cannot see is never confirmed — same as if that node did not exist);
 *   L3 applyWriteTimeSupersedes reports a hidden id exactly like a missing one
 *      (supersedes_partial with the engine's own reason);
 *   L5 bulk question-alias rows carry the node's stored security_scopes.
 * (L1, the verbatim reap page-by-visible fix, is tested in write-scopes-edges-verbatim-unit.ts.)
 *
 * Run: npx tsx test/write-scopes-followups-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { SqliteGraph } from '../packages/lore/src/engines/sqliteGraph.js';
import { FileOutboxStore } from '../packages/lore/src/outbox/store.js';
import { tryBulkWriteRoutes } from '../packages/lore/src/mcp/http/routes/bulkWrite.js';
import { runWithActor } from '../packages/lore/src/security/actorContext.js';
import { applyWriteTimeSupersedes, validateSupersedesIds } from '../packages/lore/src/core/supersessionPolicy.js';
import { aliasRowId } from '../packages/lore/src/core/questionAliases.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? (err as Error).message}`); failed++; }
}
const bound = <T>(scopes: string[], fn: () => Promise<T>): Promise<T> => runWithActor({ portalUserId: 'u', scopes }, fn);
const mkTmp = (p: string): string => fs.mkdtempSync(path.join(os.tmpdir(), p));

const WS = 'wsf';
interface Rig { graph: SqliteGraph; outbox: FileOutboxStore }
async function rig(): Promise<Rig> {
    const graph = new SqliteGraph(mkTmp('wsf-g-'), { workspaceId: WS });
    await graph.initialize();
    return { graph, outbox: new FileOutboxStore(mkTmp('wsf-o-')) };
}
const node = (id: string, scopes?: string[], extra: Record<string, unknown> = {}) => ({
    id, type: 'note', label: `L-${id}`, content: `content ${id}`, tags: [], project: WS, ecosystem: '*',
    metadata: '{}', ...(scopes ? { security_scopes: scopes } : {}), ...extra,
}) as never;
/** The actor [x] can see a node iff it is not labelled [y] — the same rule the shared helpers apply. */
const visibleFor = (r: Rig) => async (id: string): Promise<boolean> => {
    const n = await r.graph.getNode(id) as { security_scopes?: string[] } | null;
    return !!n && !(n.security_scopes ?? []).includes('y');
};

/* ---------- L2 ---------- */
console.log('\nL2 — cycle walk does not confirm a chain through a hidden node\n');

/** T.supersededBy = H, H.supersededBy = X. Writing T with supersedes:[X] would be a real cycle if H were visible. */
async function chainRig(hOpts: 'hidden' | 'visible' | 'absent'): Promise<Rig> {
    const r = await rig();
    await r.graph.upsertNode(node('X', ['x']));
    await r.graph.upsertNode(node('T', ['x']));
    if (hOpts !== 'absent') {
        await r.graph.upsertNode(node('H', hOpts === 'hidden' ? ['y'] : ['x']));
        await r.graph.supersedeNode('H', 'X', 'test');
        await r.graph.supersedeNode('T', 'H', 'test');
    }
    return r;
}
const check = (r: Rig, isVisible?: (id: string) => Promise<boolean>) =>
    validateSupersedesIds({ id: 'T', supersedes: ['X'], targetGraph: r.graph as never, ...(isVisible ? { isVisible } : {}) });

await test('bound + chain through a hidden node: behaves exactly as if the hidden node did not exist (no cycle reported)', async () => {
    const hidden = await chainRig('hidden');
    const absent = await chainRig('absent');
    const a = await bound(['x'], () => check(hidden, visibleFor(hidden)));
    const b = await bound(['x'], () => check(absent, visibleFor(absent)));
    assert.deepEqual(a, b);
    assert.equal(a.ok, true, 'hidden hop ends the walk');
});

await test('bound + chain through a VISIBLE node still reports the cycle; unbound over the hidden chain is unchanged (cycle)', async () => {
    const vis = await chainRig('visible');
    const v = await bound(['x'], () => check(vis, visibleFor(vis)));
    assert.equal(v.ok, false);
    const hidden = await chainRig('hidden');
    const u = await check(hidden); // unbound: no isVisible
    assert.equal(u.ok, false, 'unbound callers are not filtered');
});

/* ---------- L3 ---------- */
console.log('\nL3 — applyWriteTimeSupersedes: a hidden id is reported like a missing one\n');

await test('hidden id => supersedes_partial identical to a missing id; hidden node, edges and outbox untouched', async () => {
    const run = async (hiddenNode: boolean) => {
        const r = await rig();
        await r.graph.upsertNode(node('newer', ['x']));
        await r.graph.upsertNode(node('vis', ['x']));
        if (hiddenNode) await r.graph.upsertNode(node('gone', ['y']));
        const out = await applyWriteTimeSupersedes({
            targetGraph: r.graph as never, supersedes: ['gone', 'vis'], newId: 'newer', workspace: WS, initiator: 'test',
            outboxStore: r.outbox, logPrefix: '[t]', isVisible: visibleFor(r),
        });
        return { r, out };
    };
    const h = await run(true);
    const m = await run(false);
    assert.deepEqual(h.out, m.out, 'hidden answers exactly like missing');
    assert.equal(h.out.ok, false);
    if (!h.out.ok) {
        assert.equal(h.out.code, 'supersedes_partial');
        assert.deepEqual(h.out.applied, ['vis']);
        assert.deepEqual(h.out.unapplied, [{ id: 'gone', reason: 'old-not-found' }]);
    }
    const g = await h.r.graph.getNode('gone') as { supersededBy?: string | null } | null;
    assert.ok(!g!.supersededBy, 'hidden node not superseded');
    assert.equal((await h.r.outbox.listPendingForWorkspace(WS, 100)).length, 1, 'only the visible id wrote an outbox row');
});

/* ---------- L5 ---------- */
console.log('\nL5 — bulk question-alias rows carry the node\'s stored scopes\n');

function postReq(body: string): IncomingMessage {
    let consumed = false;
    return {
        method: 'POST',
        on(event: string, cb: (chunk?: Buffer | Error) => void) {
            if (event === 'data' && !consumed) { consumed = true; cb(Buffer.from(body, 'utf8')); }
            if (event === 'end') setImmediate(() => cb());
            return this;
        },
    } as unknown as IncomingMessage;
}
async function bulk(r: Rig, nodes: Array<Record<string, unknown>>, query: Record<string, unknown> = {}): Promise<{ status: number; body: { results: Array<{ ok: boolean }> } }> {
    let status = 0, out = '';
    const res = { writeHead(s: number) { status = s; return this; }, end(b?: string) { out = b ?? ''; } } as unknown as ServerResponse;
    await tryBulkWriteRoutes(postReq(JSON.stringify({ workspace: WS, nodes, ...query })), res, '/api/nodes/bulk', '/api/nodes/bulk', {
        store: { loreGraph: r.graph, loreVerbatim: { async getById() { return null; }, async store() { /* */ }, async tombstone() { /* */ } } } as never,
        auditLog: { log: () => undefined } as never,
        deploymentMode: 'local', dataplane: null, outboxStore: r.outbox,
    } as never);
    return { status, body: JSON.parse(out) };
}
async function aliasScopes(r: Rig, id: string): Promise<unknown[]> {
    const rows = await r.outbox.listPendingForWorkspace(WS, 10_000);
    return rows
        .filter((e) => e.operationKind === 'verbatim.upsert' && (e.payload as { id?: string }).id === aliasRowId(id, 0))
        .map((e) => (e.payload as { metadata: { security_scopes?: unknown } }).metadata.security_scopes);
}

await test('rewrite of a scoped node with questions[]: alias rows carry the node\'s scopes (bound and unbound writers)', async () => {
    for (const asBound of [false, true]) {
        const r = await rig();
        await r.graph.upsertNode(node('sc', ['x']));
        const write = () => bulk(r, [{ id: 'sc', type: 'note', label: 'L', content: 'c', questions: ['how does sc work?'] }]);
        const out = asBound ? await bound(['x'], write) : await write();
        assert.equal(out.body.results[0]!.ok, true, JSON.stringify(out.body));
        assert.deepEqual((await r.graph.getNode('sc') as { security_scopes?: string[] }).security_scopes, ['x'], 'node keeps its scopes');
        assert.deepEqual(await aliasScopes(r, 'sc'), [['x']], `alias row scopes (bound=${asBound})`);
    }
});

await test('new unscoped node: alias rows stay public ([]) — behaviour unchanged', async () => {
    const r = await rig();
    await bulk(r, [{ id: 'pub', type: 'note', label: 'L', content: 'c', questions: ['q?'] }]);
    assert.deepEqual(await aliasScopes(r, 'pub'), [[]]);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
