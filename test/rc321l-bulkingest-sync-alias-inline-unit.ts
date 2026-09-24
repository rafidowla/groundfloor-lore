#!/usr/bin/env tsx
/**
 * test/rc321l-bulkingest-sync-alias-inline-unit.ts — Lore 3.21 step 4 (r9
 * follow-up, Opus review of the r9 recall-quality fixes).
 *
 * `bulkIngest()`'s own doc comment promises: "embed:'sync' (default) —
 * when the promise resolves, every vector IS persisted to LanceDB. No
 * drain race, no 0B stores." Before this fix, that guarantee held for the
 * main content row but NOT for `questions[]` alias rows — those were only
 * recorded to the outbox (durable, but embedded/written by the background
 * replicator on its own schedule). `mcp/bulkIngestAliasSync.ts` now embeds
 * and writes alias rows INLINE, alongside the main row, for `embed:'sync'`.
 *
 * This test proves the fix deterministically: a memory whose CONTENT
 * shares no words with one of its `questions[]` aliases must be findable,
 * via that alias phrasing, the INSTANT `bulkIngest()`'s promise resolves —
 * no wait, no retry, no flakiness. Run 5 times (fresh instance each time)
 * to rule out a timing-dependent pass.
 *
 * `searchMode:'keyword'` is used deliberately (not semantic/hybrid): since
 * the content and the alias phrasing share NO words, a keyword/BM25 match
 * can only come from the alias row's own indexed text — a clean,
 * unambiguous proof the alias row exists, is embedded, and is
 * FTS-indexed, immediately.
 *
 * Run: npx tsx test/rc321l-bulkingest-sync-alias-inline-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

console.log('RC321l — bulkIngest(embed:\'sync\') writes questions[] alias rows INLINE, not just to the outbox\n');

const { createLore } = await import('../packages/lore/src/index.js');

async function runOnce(iteration: number): Promise<void> {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `lore-sync-alias-${iteration}-`));
    const lore = await createLore({ dataDir, deploymentMode: 'embedded' });
    try {
        // Content and alias share ZERO words — any keyword match on the
        // alias phrasing can only be explained by the alias row itself
        // being present, embedded, and FTS-indexed.
        const result = await lore.bulkIngest([{
            id: 'sync-alias-parent',
            workspace: 'default',
            ecosystem: '*',
            nodeData: {
                id: 'sync-alias-parent', type: 'memory', label: 'bonus payout',
                content: 'Approved the quarterly bonus payout for the operations team.',
                project: 'default', ecosystem: '*',
            },
            questions: ['When is trash pickup on our street this week?'],
        }], { autolink: false, embed: 'sync' });
        assert.equal(result.succeeded, 1, `iteration ${iteration}: bulkIngest must report success`);

        // Query IMMEDIATELY — no delay, no retry, no drain wait — using
        // wording from the alias question only.
        const found = await lore.recall('trash pickup street', {
            workspace: 'default', ecosystem: '*', searchMode: 'keyword', mode: 'summary', max: 10, depth: 0,
        });
        assert.equal(found.mode, 'summary');
        const ids = (found as { hits: Array<{ id: string }> }).hits.map((h) => h.id);
        assert.deepEqual(ids, ['sync-alias-parent'], `iteration ${iteration}: expected the parent found via its alias immediately after bulkIngest resolved, got ${JSON.stringify(ids)}`);

        // Also assert the alias row itself never leaks as its own hit id
        // (mapAliasHitsToParent's collapsing contract).
        for (const id of ids) assert.ok(!/#q\d+$/.test(id), `iteration ${iteration}: alias row id leaked into results: ${id}`);
    } finally {
        await lore.dispose();
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
}

for (let i = 1; i <= 5; i++) {
    await test(`iteration ${i}/5: alias-only query finds the parent immediately after bulkIngest(embed:'sync') resolves`, () => runOnce(i));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
