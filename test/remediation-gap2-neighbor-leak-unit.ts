#!/usr/bin/env tsx
/**
 * test/remediation-gap2-neighbor-leak-unit.ts — 2026-08-17 follow-up GAP 2.
 *
 * GET /api/node returns a node plus its 1-hop neighbours. The centre was
 * row-level scope confined in the first pass, but the `neighbors` array was
 * not: a node the actor can't see still surfaced — id, label, type, relation
 * AND confidence — as another node's neighbour. This test drives the real route
 * with an actor that lacks the hidden neighbour's scope and asserts the whole
 * neighbour row is absent from the response.
 */

import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tryNodesRoutes } from '../packages/lore/src/mcp/http/routes/nodes.js';
import { runWithPrincipal, type Principal } from '../packages/lore/src/auth/principal.js';
import { runWithActor } from '../packages/lore/src/security/actorContext.js';

function fakeReq(method: string, url: string): IncomingMessage {
    return { method, url, on: () => { /* no-op */ } } as unknown as IncomingMessage;
}
function fakeRes(): ServerResponse & { _status: number; _body: string } {
    const r = {
        _status: 0, _body: '',
        writeHead(status: number) { (this as { _status: number })._status = status; return this; },
        end(body?: string) { (this as { _body: string })._body = body ?? ''; },
    };
    return r as unknown as ServerResponse & { _status: number; _body: string };
}

/** A visible centre + a scope-restricted neighbour connected by one edge. */
function makeGraph() {
    const nodes = new Map<string, Record<string, unknown>>([
        ['center', { id: 'center', type: 'note', label: 'Center', project: 'ws', ecosystem: '*', tags: [], security_scopes: [], content: 'center', metadata: '{}' }],
        ['secret', { id: 'secret', type: 'note', label: 'Secret Neighbour', project: 'ws', ecosystem: '*', tags: [], security_scopes: ['finance'], content: 'secret', metadata: '{}' }],
    ]);
    return {
        initialize: async () => undefined,
        getNode: async (id: string) => nodes.get(id) ?? null,
        getNodesByIds: async (ids: string[]) => {
            const m = new Map();
            for (const id of ids) if (nodes.has(id)) m.set(id, nodes.get(id));
            return m;
        },
        queryEdges: async (q: { source?: string; target?: string; relation?: string; limit: number; offset: number }) => {
            if (q.source === 'center') {
                return [{ sourceId: 'center', targetId: 'secret', relation: 'linked_to', confidence: 'extracted', confidenceScore: 0.9 }];
            }
            return [];
        },
        search: async () => [],
        listNodes: async () => [],
        bulkList: async () => ({ nodes: [], hasMore: false, nextCursor: null }),
        getTopology: async () => ({ nodes: [], edges: [] }),
        getStats: async () => ({ nodeCount: 0, edgeCount: 0 }),
    };
}

function buildDeps(graph: ReturnType<typeof makeGraph>): Parameters<typeof tryNodesRoutes>[4] {
    const registry = {
        getOrOpen: async () => graph,
        getGraphHandle: async () => graph,
        activeName: () => 'ws',
    };
    const storageClient = Object.assign({}, graph, { verbatimCount: async () => 0, verbatimSearch: async () => [] });
    const store = { loreGraph: graph, storageClient, loreVerbatim: { count: async () => 0, search: async () => [] } };
    return {
        deploymentMode: 'local',
        dataplane: null,
        store: store as never,
        graphRegistry: registry as never,
        auditLog: {} as never,
    } as Parameters<typeof tryNodesRoutes>[4];
}

const PRINCIPAL: Principal = { kind: 'app', workspace: 'ws', scopes: ['read'], label: 'app-read' };

let passed = 0;
let failed = 0;
const test = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

(async () => {
    console.log('GAP 2 — /api/node neighbour scope confinement');

    await test('a scope-restricted neighbour is absent from GET /api/node (id/label/type/relation/confidence all hidden)', async () => {
        const res = fakeRes();
        const d = buildDeps(makeGraph());
        await runWithPrincipal(PRINCIPAL, () =>
            runWithActor({ portalUserId: 'u1', scopes: ['sales'] }, () =>
                tryNodesRoutes(fakeReq('GET', '/api/node?id=center&workspace=ws'), res, '/api/node?id=center&workspace=ws', '/api/node', d),
            ),
        );
        assert.equal(res._status, 200, res._body);
        const body = JSON.parse(res._body) as { node: { id: string }; neighbors: Array<Record<string, unknown>> };
        assert.equal(body.node.id, 'center', 'the visible centre is returned');
        const leaked = body.neighbors.some((n) => n.id === 'secret');
        assert.equal(leaked, false, `hidden neighbour must be absent; neighbors=${JSON.stringify(body.neighbors)}`);
        // Belt-and-suspenders: no neighbour row may carry the hidden node's
        // label/type/relation/confidence either.
        for (const n of body.neighbors) {
            assert.notEqual(n.label, 'Secret Neighbour', 'hidden label must not leak');
        }
    });

    await test('a scope-matching actor still sees the neighbour', async () => {
        const res = fakeRes();
        const d = buildDeps(makeGraph());
        await runWithPrincipal(PRINCIPAL, () =>
            runWithActor({ portalUserId: 'u2', scopes: ['finance'] }, () =>
                tryNodesRoutes(fakeReq('GET', '/api/node?id=center&workspace=ws'), res, '/api/node?id=center&workspace=ws', '/api/node', d),
            ),
        );
        assert.equal(res._status, 200, res._body);
        const body = JSON.parse(res._body) as { neighbors: Array<Record<string, unknown>> };
        assert.ok(body.neighbors.some((n) => n.id === 'secret'), 'finance actor must see the finance-scoped neighbour');
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})();
