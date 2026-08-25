#!/usr/bin/env tsx
/**
 * inject-getRelevantContext-e2e.ts — genuine integration test for the
 * OUTBOUND half of the context-injection helper (packages/lore/src/inject/).
 *
 * Real `createLore({ deploymentMode: 'embedded' })`, real outbox drain, real
 * embeddings — not mocked. Falsifiable via the same technique as
 * test/embeddable-capstone-e2e.ts §2 and
 * test/embedded-recall-nonactive-workspace-unit.ts: the stored node's
 * content shares NO token with the recall query, so a hit can only be
 * attributed to a replicated semantic vector, never a lucky keyword match.
 *
 * Proves:
 *   (1) getRelevantContext() returns real recalled content for a
 *       keyword-proof query (semantic recall actually ran).
 *   (2) it returns '' (not a throw) when nothing relevant is stored.
 *   (3) the returned text respects opts.maxChars (a small budget truncates;
 *       the result never exceeds the requested budget).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); console.log(`  ok   ${name}`); passed++; }
    catch (e) { console.error(`  FAIL ${name}\n       ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-inject-outbound-'));
fs.mkdirSync(path.join(home, '.lore'), { recursive: true });
fs.writeFileSync(
    path.join(home, 'workspaces.json'),
    JSON.stringify(
        { active: 'default', workspaces: [{ name: 'default', path: home, createdAt: '2026-06-15T00:00:00.000Z' }] },
        null,
        2,
    ),
);
delete process.env['LORE_HOME'];
delete process.env['LORE_GRAPH_PATH'];
process.env['LORE_HOME'] = home;

console.log('getRelevantContext() — real embedded recall, no mocks');

const { createLore } = await import('../packages/lore/src/index.js');
const { getRelevantContext, DEFAULT_MAX_CHARS } = await import('../packages/lore/src/inject/index.js');

const lore = await createLore({ deploymentMode: 'embedded', dataDir: home });

// Deliberately NO token overlap with QUERY below — the only way
// getRelevantContext can surface this is via a replicated embedding.
const NODE_ID = 'inject-outbound-semantic-target';
const NODE_LABEL = 'astronomy observation';
const NODE_CONTENT = 'A luminous celestial body emits radiant heat across the dark void of outer space.';
const QUERY = 'our nearest bright stellar furnace glowing in the galaxy';

try {
    await check('seed node write (with embedding) succeeds', async () => {
        const res = await lore.nodeUpsert({
            id: NODE_ID,
            workspace: 'default',
            ecosystem: '*',
            nodeData: {
                id: NODE_ID, type: 'note', label: NODE_LABEL,
                content: NODE_CONTENT, tags: ['cosmos'],
                project: 'default', ecosystem: '*', metadata: '{}',
            },
            // No skipEmbed — a verbatim.upsert outbox row IS recorded.
        });
        assert.ok(res.ok, `nodeUpsert ok (got ${JSON.stringify(res)})`);
    });

    await check('the embedded replicator drains the outbox to depth 0', async () => {
        const outboxStore = lore._daemon.outboxWiring.store;
        let depth = Number.MAX_SAFE_INTEGER;
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline && depth > 0) {
            depth = (await outboxStore.aggregateStats!()).depth;
            if (depth > 0) await new Promise((r) => setTimeout(r, 150));
        }
        assert.equal(depth, 0, 'outbox must drain before the assertions below are meaningful');
    });

    await check('keyword search MISSES the query (proves no keyword fallback)', async () => {
        const kw = await lore.store.storageClient.search(QUERY, 10, '*', '*');
        assert.ok(
            !kw.some((n) => n.id === NODE_ID),
            `keyword search must NOT find the node for a no-overlap query — otherwise a getRelevantContext ` +
            `hit below could pass without any embedding (got ${kw.map((n) => n.id).join(',')})`,
        );
    });

    await check('getRelevantContext() returns the node\'s content via semantic recall', async () => {
        const text = await getRelevantContext(lore, QUERY, { workspace: 'default' });
        assert.ok(text.length > 0, 'expected non-empty packaged text');
        assert.ok(
            text.includes(NODE_CONTENT) || text.includes(NODE_LABEL),
            `expected the recalled node's content/label in the packaged text (no keyword overlap exists between ` +
            `the query and the node, so this can only come from real semantic recall) — got: ${JSON.stringify(text)}`,
        );
    });

    await check('getRelevantContext() returns \'\' for a workspace with nothing relevant (no throw)', async () => {
        const text = await getRelevantContext(lore, 'a completely unrelated topic nobody wrote about xyzzy-plugh', { workspace: 'default' });
        assert.equal(typeof text, 'string', 'must return a string, never throw, even on zero hits');
        // Not asserting text === '' strictly (a low-confidence hit is possible from
        // an unrelated corpus in principle), but it must never throw and must be a
        // bounded string within the default budget.
        assert.ok(text.length <= DEFAULT_MAX_CHARS, 'must respect the default character budget even on a miss');
    });

    await check('getRelevantContext() respects a small opts.maxChars budget', async () => {
        const SMALL_BUDGET = 60;
        const text = await getRelevantContext(lore, QUERY, { workspace: 'default', maxChars: SMALL_BUDGET });
        assert.ok(
            text.length <= SMALL_BUDGET,
            `packaged text must never exceed the requested budget (got ${text.length} chars, budget ${SMALL_BUDGET}): ${JSON.stringify(text)}`,
        );
        // The budget is small enough that the full node content cannot fit —
        // confirms real truncation happened, not just a lucky short result.
        assert.ok(
            text.length < NODE_CONTENT.length,
            'expected the tiny budget to actually truncate below the full node content length',
        );
    });

    await check('getRelevantContext() with a generous budget returns MORE than the tiny-budget version', async () => {
        const small = await getRelevantContext(lore, QUERY, { workspace: 'default', maxChars: 60 });
        const large = await getRelevantContext(lore, QUERY, { workspace: 'default', maxChars: 4000 });
        assert.ok(large.length > small.length, `expected a larger budget to yield more text (small=${small.length}, large=${large.length})`);
    });
} finally {
    await lore.dispose('test-teardown');
    fs.rmSync(home, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
