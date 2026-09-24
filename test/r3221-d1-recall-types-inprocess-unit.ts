#!/usr/bin/env tsx
/**
 * test/r3221-d1-recall-types-inprocess-unit.ts — fix/3.22.1-d1-recall-
 * option-parity.
 *
 * Defect: `lore.recall(topic, opts)` (the embedded in-process surface,
 * inProcessRecall.ts) silently dropped `types` — RetrieveOptions.types is a
 * D2 node TYPE/KIND prefilter (ANY-of, pushed into the vector + BM25 seed
 * queries) that the `recall` MCP tool and REST /api/recall have supported
 * since D2. `RecallOpts` never declared `types`, and `inProcessRecallCore`
 * destructured `opts` without it, so it was silently discarded on the one
 * embeddable surface (Atlas et al. call `lore.recall()` directly, not the
 * MCP tool).
 *
 * This pins the fix: `types: ['decision']` on a workspace where `note`
 * nodes out-rank the decisions for the topic text must return ONLY the
 * decisions.
 *
 * Run: npx tsx test/r3221-d1-recall-types-inprocess-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RecallResult, RecallResultSummary } from '../packages/lore/src/recall/recallPreset.js';

function asSummary(r: RecallResult): RecallResultSummary {
    assert.equal(r.mode, 'summary', 'expected summary-mode recall result');
    return r as RecallResultSummary;
}

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

console.log('fix/3.22.1-d1-recall-option-parity — in-process lore.recall() `types` filter\n');

const { createLore } = await import('../packages/lore/src/index.js');
const { NullEmbeddingProvider } = await import('../packages/lore/src/providers/nullEmbeddingProvider.js');

function tmpDataDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'lore-recall-types-'));
}

// fix/3.22.1-recall-parity review fix (6) — every tmpDataDir() must be
// rmSync'd in a `finally`, or a failed assertion (which throws before
// cleanup) leaks a real tmp directory per run.
function cleanup(dataDir: string): void {
    fs.rmSync(dataDir, { recursive: true, force: true });
}

await test('types filter: keeps only nodes whose type is in the requested set, even when other types out-match on text', async () => {
    const dataDir = tmpDataDir();
    const lore = await createLore({ dataDir, deploymentMode: 'embedded', embeddingProvider: new NullEmbeddingProvider() });
    try {
        // The `note` nodes repeat the marker term more densely than the
        // decisions do, so a keyword-ranked, UNFILTERED search would put a
        // note ahead of (or alongside) the decisions. Without `types`
        // reaching retrieve(), the note(s) would leak into the result.
        await lore.bulkIngest([
            { id: 'note-1', workspace: 'default', ecosystem: '*', nodeData: { id: 'note-1', type: 'note', label: 'note-1', content: 'zzyzxtypefilter zzyzxtypefilter zzyzxtypefilter note text', project: 'default', ecosystem: '*' } },
            { id: 'note-2', workspace: 'default', ecosystem: '*', nodeData: { id: 'note-2', type: 'note', label: 'note-2', content: 'zzyzxtypefilter zzyzxtypefilter zzyzxtypefilter another note', project: 'default', ecosystem: '*' } },
            { id: 'dec-1', workspace: 'default', ecosystem: '*', nodeData: { id: 'dec-1', type: 'decision', label: 'dec-1', content: 'zzyzxtypefilter decision one', project: 'default', ecosystem: '*' } },
            { id: 'dec-2', workspace: 'default', ecosystem: '*', nodeData: { id: 'dec-2', type: 'decision', label: 'dec-2', content: 'zzyzxtypefilter decision two', project: 'default', ecosystem: '*' } },
        ], { autolink: false, embed: 'sync' });

        // Baseline (no types filter) sanity check: the notes are present in
        // the unfiltered result set, confirming they really do compete for
        // ranking against the decisions (otherwise this test would pass
        // trivially even with the bug).
        const unfiltered = await lore.recall('zzyzxtypefilter', { workspace: 'default', mode: 'summary', searchMode: 'keyword', max: 10 });
        const unfilteredIds = asSummary(unfiltered).hits.map((h) => h.id).sort();
        assert.ok(unfilteredIds.includes('note-1') || unfilteredIds.includes('note-2'), 'sanity: notes must compete in the unfiltered baseline, or this test proves nothing');

        // types: ['decision'] — must return ONLY the decisions.
        const filtered = await lore.recall('zzyzxtypefilter', {
            workspace: 'default', mode: 'summary', searchMode: 'keyword', max: 10, types: ['decision'],
        });
        const filteredIds = asSummary(filtered).hits.map((h) => h.id).sort();
        assert.deepEqual(filteredIds, ['dec-1', 'dec-2'], 'types:[\'decision\'] must reach retrieve() and exclude every non-decision node');
    } finally {
        await lore.dispose();
        cleanup(dataDir);
    }
});

await test('types filter: returns a full page when enough matching-type nodes exist', async () => {
    const dataDir = tmpDataDir();
    const lore = await createLore({ dataDir, deploymentMode: 'embedded', embeddingProvider: new NullEmbeddingProvider() });
    try {
        const decisions = Array.from({ length: 5 }, (_, i) => ({
            id: `dp-${i}`, workspace: 'default', ecosystem: '*',
            nodeData: { id: `dp-${i}`, type: 'decision', label: `dp-${i}`, content: `zzyzxpagefull decision number ${i}`, project: 'default', ecosystem: '*' },
        }));
        const notes = Array.from({ length: 5 }, (_, i) => ({
            id: `np-${i}`, workspace: 'default', ecosystem: '*',
            nodeData: { id: `np-${i}`, type: 'note', label: `np-${i}`, content: `zzyzxpagefull note number ${i}`, project: 'default', ecosystem: '*' },
        }));
        await lore.bulkIngest([...decisions, ...notes], { autolink: false, embed: 'sync' });

        const result = await lore.recall('zzyzxpagefull', {
            workspace: 'default', mode: 'summary', searchMode: 'keyword', max: 3, types: ['decision'],
        });
        const hits = asSummary(result).hits;
        assert.equal(hits.length, 3, 'a full page (max:3) of decisions must be returned when 5 decisions exist');
        assert.ok(hits.every((h) => h.id.startsWith('dp-')), `every hit must be a decision, got: ${hits.map((h) => h.id).join(',')}`);
    } finally {
        await lore.dispose();
        cleanup(dataDir);
    }
});

await test('no types filter: omitting it reproduces unfiltered behaviour (no-op default)', async () => {
    const dataDir = tmpDataDir();
    const lore = await createLore({ dataDir, deploymentMode: 'embedded', embeddingProvider: new NullEmbeddingProvider() });
    try {
        await lore.bulkIngest([
            { id: 'a', workspace: 'default', ecosystem: '*', nodeData: { id: 'a', type: 'note', label: 'a', content: 'zzyzxnotype baseline', project: 'default', ecosystem: '*' } },
            { id: 'b', workspace: 'default', ecosystem: '*', nodeData: { id: 'b', type: 'decision', label: 'b', content: 'zzyzxnotype baseline', project: 'default', ecosystem: '*' } },
        ], { autolink: false, embed: 'sync' });
        const result = await lore.recall('zzyzxnotype', { workspace: 'default', mode: 'summary', searchMode: 'keyword' });
        const ids = asSummary(result).hits.map((h) => h.id).sort();
        assert.deepEqual(ids, ['a', 'b'], 'omitting types must not filter anything (byte-identical to pre-fix behaviour for existing callers)');
    } finally {
        await lore.dispose();
        cleanup(dataDir);
    }
});

// fix/3.22.1-recall-parity review fix (1) — inProcessRecallCore's final
// buildRecallResult() call never passed `maxHits`, so `lore.recall(t,
// {max:25})` in summary mode was silently capped at the presentation
// layer's own SUMMARY_MAX_HITS default (10), no matter what `max` the
// caller asked for. Also pins the [1,100] clamp on in-process `max`.
await test('max: summary mode returns MORE than the 10-hit default when max is raised (maxHits must reach buildRecallResult)', async () => {
    const dataDir = tmpDataDir();
    const lore = await createLore({ dataDir, deploymentMode: 'embedded', embeddingProvider: new NullEmbeddingProvider() });
    try {
        const nodes = Array.from({ length: 15 }, (_, i) => ({
            id: `mx-${i}`, workspace: 'default', ecosystem: '*',
            nodeData: { id: `mx-${i}`, type: 'note', label: `mx-${i}`, content: `zzyzxmaxhits note number ${i}`, project: 'default', ecosystem: '*' },
        }));
        await lore.bulkIngest(nodes, { autolink: false, embed: 'sync' });

        const defaulted = await lore.recall('zzyzxmaxhits', { workspace: 'default', mode: 'summary', searchMode: 'keyword' });
        assert.equal(asSummary(defaulted).hits.length, 10, 'sanity: the unraised default must still be capped at 10 hits');

        const raised = await lore.recall('zzyzxmaxhits', { workspace: 'default', mode: 'summary', searchMode: 'keyword', max: 25 });
        assert.equal(asSummary(raised).hits.length, 15, `max:25 must return all 15 matching nodes (summary cap must follow \`max\`, not stay pinned at 10), got ${asSummary(raised).hits.length}`);
    } finally {
        await lore.dispose();
        cleanup(dataDir);
    }
});

await test('max: clamps below 1 up to 1 (out-of-range values must not propagate raw)', async () => {
    const dataDir = tmpDataDir();
    const lore = await createLore({ dataDir, deploymentMode: 'embedded', embeddingProvider: new NullEmbeddingProvider() });
    try {
        await lore.bulkIngest([
            { id: 'cl-1', workspace: 'default', ecosystem: '*', nodeData: { id: 'cl-1', type: 'note', label: 'cl-1', content: 'zzyzxclamp one', project: 'default', ecosystem: '*' } },
            { id: 'cl-2', workspace: 'default', ecosystem: '*', nodeData: { id: 'cl-2', type: 'note', label: 'cl-2', content: 'zzyzxclamp two', project: 'default', ecosystem: '*' } },
        ], { autolink: false, embed: 'sync' });

        // max:0 must clamp to the floor (1), not to the default (10) and not
        // propagate 0 (which would mean "no hits" downstream, a different bug).
        const clamped = await lore.recall('zzyzxclamp', { workspace: 'default', mode: 'summary', searchMode: 'keyword', max: 0 });
        assert.equal(asSummary(clamped).hits.length, 1, `max:0 must clamp to the [1,100] floor (1 hit), got ${asSummary(clamped).hits.length}`);
    } finally {
        await lore.dispose();
        cleanup(dataDir);
    }
});

// ── Fix (2): cross-workspace `types` pushdown ──────────────────────────────
//
// runCrossWorkspaceRecall() (recallCrossWorkspace.ts) used to apply `types`
// only AFTER merging, which can't rescue a decision that never made it into
// a workspace's fixed-size keyword seed window in the first place. This
// drives runCrossWorkspaceRecall() directly (fixture graph, no real
// createLore multi-workspace setup needed) with a workspace whose top-
// KEYWORD_LIMIT_PER_WORKSPACE(=10) keyword hits are all `note`s, and 2
// `decision`s ranked below the window — proving `types` reaches
// GraphProvider.search()'s 7th positional arg, not just the post-merge
// filter.
await test('cross-workspace types pushdown: types:[\'decision\'] rescues decisions crowded out of a workspace\'s keyword seed window', async () => {
    const { runCrossWorkspaceRecall } = await import('../packages/lore/src/mcp/tools/recallCrossWorkspace.js');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-xws-types-'));
    try {
        fs.writeFileSync(
            path.join(home, 'workspaces.json'),
            JSON.stringify({
                active: 'xws-a',
                workspaces: [{ name: 'xws-a', path: path.join(home, 'workspaces', 'xws-a'), createdAt: '2026-09-24T00:00:00.000Z', graphEngine: 'surreal' }],
            }, null, 2),
        );

        const notes = Array.from({ length: 12 }, (_, i) => ({ id: `xn-${i}`, type: 'note', label: `xn-${i}`, content: 'zzyzxcross note', ecosystem: '*' }));
        const decisions = [
            { id: 'xd-1', type: 'decision', label: 'xd-1', content: 'zzyzxcross decision one', ecosystem: '*' },
            { id: 'xd-2', type: 'decision', label: 'xd-2', content: 'zzyzxcross decision two', ecosystem: '*' },
        ];
        const allNodes = [...notes, ...decisions];

        // Fake GraphProvider.search — honours the `types` 7th positional arg
        // (an ANY-of type filter) exactly the way the production seed
        // pushdown expects; without it, the 12 notes fill the
        // KEYWORD_LIMIT_PER_WORKSPACE(=10) window and the 2 decisions never
        // surface (proving the crowding scenario, same as the in-process
        // test above).
        const wsGraph = {
            async search(_q: string, limit = 10, _project?: string, _eco?: string, _excludeHidden?: boolean, _signals?: unknown, types?: string[]) {
                const pool = types && types.length > 0 ? allNodes.filter((n) => types.includes(n.type)) : allNodes;
                return pool.slice(0, limit).map((n) => ({ ...n, project: 'default' }));
            },
            async getNodesByIds() { return new Map(); },
            async getNode() { return null; },
            async traverse() { return []; },
        };

        const registry = {
            homeDir: () => home,
            async getGraphHandle(_ws: string) { return wsGraph as never; },
        };
        const bootVerbatim = { async count() { return 0; }, async search() { return []; } };

        const unfiltered = await runCrossWorkspaceRecall({
            topic: 'zzyzxcross', depth: 0, includeSuperseded: false,
            registry: registry as never, verbatimStore: bootVerbatim as never,
            sessionCache: { get: () => undefined, set: () => {} } as never,
            responseMode: 'full',
        });
        const unfilteredText = unfiltered.content.map((c) => c.text).join('\n');
        assert.ok(unfilteredText.includes('xn-0'), 'sanity: notes must crowd out decisions in the unfiltered baseline, or this test proves nothing');
        assert.ok(!unfilteredText.includes('xd-1'), 'sanity: decisions must be crowded out of the 10-wide keyword window in the unfiltered baseline');

        const filtered = await runCrossWorkspaceRecall({
            topic: 'zzyzxcross', depth: 0, includeSuperseded: false, types: ['decision'],
            registry: registry as never, verbatimStore: bootVerbatim as never,
            sessionCache: { get: () => undefined, set: () => {} } as never,
            responseMode: 'full',
        });
        const filteredText = filtered.content.map((c) => c.text).join('\n');
        assert.ok(filteredText.includes('xd-1') && filteredText.includes('xd-2'), `types:['decision'] must rescue both decisions from the crowded seed window: ${filteredText}`);
        assert.ok(!filteredText.includes('xn-0'), `types:['decision'] must exclude notes: ${filteredText}`);
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
