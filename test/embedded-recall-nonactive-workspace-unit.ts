#!/usr/bin/env tsx
/**
 * embedded-recall-nonactive-workspace-unit.ts — regression for a confirmed gap:
 * the embeddable `LoreInstance.recall()` closure (mcp/server.ts) never passed
 * `workspaceVerbatimResolver` into `inProcessRecall`'s deps, unlike every other
 * recall surface (MCP tool, REST) and unlike `nodeUpsert`'s deps right above
 * it in the same factory. `resolveSeedStore` (recall/retrieve.ts) returns null
 * when `ctx.workspaceVerbatimResolver` is undefined, so `lore.recall()` against
 * any workspace OTHER than the boot/active one silently degraded to
 * keyword-only search — no semantic/BM25, no warning.
 *
 * This is a real INTEGRATION test (a genuine createLore() instance, real
 * outbox drain, real embeddings), not a mock — the bug was in how the
 * embeddable factory WIRES an already-correct underlying mechanism
 * (inProcessRecall already fully supports the resolver; a mocked test of
 * inProcessRecall alone would not have caught a missing call-site argument).
 *
 * Falsifiable via the same technique as embeddable-capstone-e2e.ts §2: the
 * node's content and the recall query share NO token, so a hit can only be
 * attributed to a replicated embedding, never a keyword/CONTAINS match.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-nonactive-recall-'));
const OTHER_PATH = path.join(home, 'workspaces', 'other');
fs.mkdirSync(path.join(home, '.lore'), { recursive: true });
fs.mkdirSync(path.join(OTHER_PATH, '.lore'), { recursive: true });
fs.writeFileSync(
    path.join(home, 'workspaces.json'),
    JSON.stringify(
        {
            active: 'default',
            workspaces: [
                { name: 'default', path: home, createdAt: '2026-06-15T00:00:00.000Z', graphEngine: 'surreal' },
                { name: 'other', path: OTHER_PATH, createdAt: '2026-06-15T00:00:00.000Z', graphEngine: 'surreal' },
            ],
        },
        null,
        2,
    ),
);
// Some subsystems (confirmed independently: AuditLog, and per this run's own
// diagnosis: the outbox's workspace-verbatim resolver) don't fully receive
// opts.dataDir and fall through to LORE_HOME instead — pin it explicitly so
// this test's second workspace ("other") is actually visible to every
// subsystem, not just the ones that honour dataDir directly.
process.env['LORE_HOME'] = home;

console.log('Embedded recall() against a non-active workspace — workspaceVerbatimResolver wiring');

const { createLore } = await import('../packages/lore/src/index.js');
const lore = await createLore({ deploymentMode: 'embedded', dataDir: home });

const NODE_ID = 'nonactive-semantic-target';
// No token overlap with QUERY below — the only way to retrieve it is a
// replicated vector consulted against WORKSPACE "other"'s own store.
const NODE_CONTENT = 'A luminous celestial body emits radiant heat across the dark void of outer space.';
const QUERY = 'our nearest bright stellar furnace glowing in the galaxy';

try {
    await check('nodeUpsert into the non-active workspace ("other") succeeds, with embedding', async () => {
        const res = await lore.nodeUpsert({
            id: NODE_ID,
            workspace: 'other',
            ecosystem: '*',
            nodeData: {
                id: NODE_ID, type: 'note', label: 'astronomy observation',
                content: NODE_CONTENT, tags: ['cosmos'],
                project: 'other', ecosystem: '*', metadata: '{}',
            },
            // No skipEmbed — a verbatim.upsert outbox row IS recorded.
        });
        assert.ok(res.ok, `nodeUpsert ok (got ${JSON.stringify(res)})`);
    });

    await check('the embedded replicator drains the outbox to depth 0', async () => {
        const outboxStore = (lore as unknown as { _daemon: { outboxWiring: { store: { aggregateStats?: () => Promise<{ depth: number }> } } } })._daemon.outboxWiring.store;
        let depth = Number.MAX_SAFE_INTEGER;
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline && depth > 0) {
            depth = (await outboxStore.aggregateStats!()).depth;
            if (depth > 0) await new Promise((r) => setTimeout(r, 150));
        }
        assert.equal(depth, 0, 'outbox must drain before the recall assertions below are meaningful');
    });

    await check(
        'lore.recall() against the NON-ACTIVE workspace finds the node via its embedding, ' +
        'and reports vector_index_consulted=true (not a silent keyword-only degrade)',
        async () => {
            const out = await lore.recall(QUERY, { workspace: 'other', mode: 'summary' }) as {
                hits: Array<{ id: string }>;
                _meta: { vector_index_consulted: boolean };
            };
            assert.ok(
                out.hits.some((h) => h.id === NODE_ID),
                `expected ${NODE_ID} in hits via semantic recall (no keyword overlap exists) — ` +
                `got [${out.hits.map((h) => h.id).join(', ')}]. If this is empty, workspaceVerbatimResolver ` +
                'is not wired into the embeddable recall() closure and the seed pass never ran against "other".',
            );
            assert.equal(
                out._meta.vector_index_consulted, true,
                'vector_index_consulted must be true — false means recall silently fell back to keyword-only',
            );
        },
    );
} finally {
    await lore.dispose('test-teardown');
    fs.rmSync(home, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
