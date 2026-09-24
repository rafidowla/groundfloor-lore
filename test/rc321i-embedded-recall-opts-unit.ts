#!/usr/bin/env tsx
/**
 * test/rc321i-embedded-recall-opts-unit.ts — Lore 3.21 step 4 (r9 recall-
 * quality fix, "embedded API gap").
 *
 * `lore.recall()` on the embedded LoreInstance wraps the SAME shared
 * retrieve() core the `recall` MCP tool and REST /api/recall use — but its
 * `RecallOpts` was missing `queries`/`entities`/`topics`/`project`, all of
 * which retrieve() and the MCP tool have supported since 3.21 step 3(f).
 * That gap forced any embedder wanting query-time rephrasings to reach for
 * the MCP tool in-process (extra InMemoryTransport plumbing) instead of the
 * public embeddable surface it was documented as ("available both
 * in-process (`lore.recall(topic, opts)`) and as an MCP tool").
 *
 * This pins the fix: every one of the four new opts reaches retrieve()
 * through `lore.recall()` end-to-end. The project/entities/topics filter
 * cases use a NullEmbeddingProvider instance (no ONNX load — fast): those
 * filters apply identically regardless of which seed path found the node.
 * The `queries[]` case needs the store's OWN bm25Search() actually
 * consulted (a NullEmbeddingProvider workspace writes NO verbatim rows at
 * all, so it falls to the graph-native keyword fallback, which pre-dates
 * this fix and — like the MCP tool it mirrors — only ever searches the
 * PRIMARY `topic`, never `queries[]`; not a regression from this change),
 * so it uses the real default embedding provider instead, matching how the
 * tapestry-recall benchmark's C5/C6 configs actually exercise this option.
 *
 * Run: npx tsx test/rc321i-embedded-recall-opts-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RecallResult, RecallResultSummary } from '../packages/lore/src/recall/recallPreset.js';

/** Narrow a RecallResult to summary mode (every call here passes
 *  `mode:'summary'`) — matches the cast pattern other recall tests use. */
function asSummary(r: RecallResult): RecallResultSummary {
    assert.equal(r.mode, 'summary', 'expected summary-mode recall result');
    return r as RecallResultSummary;
}

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

console.log('RC321i — embedded lore.recall() opts parity (queries/entities/topics/project)\n');

const { createLore } = await import('../packages/lore/src/index.js');
const { NullEmbeddingProvider } = await import('../packages/lore/src/providers/nullEmbeddingProvider.js');

function tmpDataDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'lore-recall-opts-'));
}

await test('queries[]: an extra phrasing alongside `topic` surfaces a node the primary topic alone would miss', async () => {
    const dataDir = tmpDataDir();
    // Real default embedder here (not NullEmbeddingProvider) — bm25Search
    // needs actual verbatim rows, which only the real embed path writes.
    const lore = await createLore({ dataDir, deploymentMode: 'embedded' });
    try {
        await lore.bulkIngest([
            { id: 'alpha', workspace: 'default', ecosystem: '*', nodeData: { id: 'alpha', type: 'note', label: 'alpha', content: 'zzyzxalpha marker text', project: 'default', ecosystem: '*' } },
            { id: 'bravo', workspace: 'default', ecosystem: '*', nodeData: { id: 'bravo', type: 'note', label: 'bravo', content: 'zzyzxbravo distinct marker', project: 'default', ecosystem: '*' } },
        ], { autolink: false, embed: 'sync' });

        // Primary topic matches NEITHER node's text — without `queries[]`
        // this must come back empty.
        const withoutExtra = await lore.recall('nomatch-topic', { workspace: 'default', mode: 'summary', searchMode: 'keyword' });
        assert.deepEqual(asSummary(withoutExtra).hits.map((h) => h.id), [], 'a topic matching nothing must return no hits');

        // Same topic, but an extra phrasing (queries[]) that DOES match bravo.
        const withExtra = await lore.recall('nomatch-topic', {
            workspace: 'default', mode: 'summary', searchMode: 'keyword', queries: ['zzyzxbravo'],
        });
        assert.deepEqual(asSummary(withExtra).hits.map((h) => h.id), ['bravo'], 'queries[] must reach retrieve() and surface the extra-phrasing match');
    } finally {
        await lore.dispose();
    }
});

await test('project filter: keeps only nodes whose project field matches exactly', async () => {
    const dataDir = tmpDataDir();
    const lore = await createLore({ dataDir, deploymentMode: 'embedded', embeddingProvider: new NullEmbeddingProvider() });
    try {
        await lore.bulkIngest([
            { id: 'p1', workspace: 'default', ecosystem: '*', nodeData: { id: 'p1', type: 'note', label: 'p1', content: 'zzyzxproject shared term', project: 'atlas', ecosystem: '*' } },
            { id: 'p2', workspace: 'default', ecosystem: '*', nodeData: { id: 'p2', type: 'note', label: 'p2', content: 'zzyzxproject shared term', project: 'loom', ecosystem: '*' } },
        ], { autolink: false, embed: 'sync' });

        const result = await lore.recall('zzyzxproject', { workspace: 'default', mode: 'summary', searchMode: 'keyword', project: 'atlas' });
        assert.deepEqual(asSummary(result).hits.map((h) => h.id), ['p1'], 'project filter must reach retrieve() and exclude the other project');
    } finally {
        await lore.dispose();
    }
});

await test('entities/topics filters: keep only nodes whose stored metadata contains ALL requested values', async () => {
    const dataDir = tmpDataDir();
    const lore = await createLore({ dataDir, deploymentMode: 'embedded', embeddingProvider: new NullEmbeddingProvider() });
    try {
        await lore.bulkIngest([
            {
                id: 'match', workspace: 'default', ecosystem: '*',
                nodeData: {
                    id: 'match', type: 'note', label: 'match', content: 'zzyzxentity shared term', project: 'default', ecosystem: '*',
                    metadata: JSON.stringify({ entities: ['acme', 'widget'], topics: ['billing'] }),
                },
            },
            {
                id: 'partial', workspace: 'default', ecosystem: '*',
                nodeData: {
                    id: 'partial', type: 'note', label: 'partial', content: 'zzyzxentity shared term', project: 'default', ecosystem: '*',
                    metadata: JSON.stringify({ entities: ['acme'], topics: ['billing'] }),
                },
            },
        ], { autolink: false, embed: 'sync' });

        const byEntities = await lore.recall('zzyzxentity', { workspace: 'default', mode: 'summary', searchMode: 'keyword', entities: ['acme', 'widget'] });
        assert.deepEqual(asSummary(byEntities).hits.map((h) => h.id), ['match'], 'entities filter must require ALL requested values');

        const byTopics = await lore.recall('zzyzxentity', { workspace: 'default', mode: 'summary', searchMode: 'keyword', topics: ['billing'] });
        assert.deepEqual(asSummary(byTopics).hits.map((h) => h.id).sort(), ['match', 'partial'], 'topics filter independent of entities');
    } finally {
        await lore.dispose();
    }
});

await test('no-opts parity: omitting queries/entities/topics/project reproduces unfiltered single-phrasing recall', async () => {
    const dataDir = tmpDataDir();
    const lore = await createLore({ dataDir, deploymentMode: 'embedded', embeddingProvider: new NullEmbeddingProvider() });
    try {
        await lore.bulkIngest([
            { id: 'a', workspace: 'default', ecosystem: '*', nodeData: { id: 'a', type: 'note', label: 'a', content: 'zzyzxbaseline term', project: 'x', ecosystem: '*' } },
        ], { autolink: false, embed: 'sync' });
        const result = await lore.recall('zzyzxbaseline', { workspace: 'default', mode: 'summary', searchMode: 'keyword' });
        assert.deepEqual(asSummary(result).hits.map((h) => h.id), ['a'], 'unfiltered recall with no new opts must be unaffected');
    } finally {
        await lore.dispose();
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
