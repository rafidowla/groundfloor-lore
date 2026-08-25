#!/usr/bin/env tsx
/**
 * audit-bw9-htmlexport-unit.ts — re-audit 2026-06-25 (LOW x2).
 *
 *  - supply-chain: the exported snapshot loaded vis-network from an UNPINNED
 *    unpkg URL (resolves to "latest" whenever the file is opened). Now pinned to
 *    @9.1.9 with a Subresource-Integrity hash.
 *  - product-sanity: domain-specific node-type group colors (Person/Place/
 *    PersonalEvent/Memory/Contract) leaked application vocabulary into the
 *    schema-agnostic core export. Removed — unknown types use `default`.
 */

import assert from 'node:assert/strict';
import { exportGraphAsHtml } from '../packages/lore/src/engines/htmlExport.js';

function fakeGraph(nodes: Array<{ id: string; label?: string; type?: string }>) {
    return { async getTopology(_max: number) { return { nodes, edges: [] }; } } as never;
}

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

console.log('BW-9 — HTML export: pinned CDN + no domain-specific colors');

await test('vis-network is pinned with Subresource Integrity (no unpinned/latest URL)', async () => {
    const html = await exportGraphAsHtml(fakeGraph([{ id: 'n1', label: 'x', type: 'note' }]));
    assert.ok(html.includes('unpkg.com/vis-network@9.1.9/'), 'CDN URL is version-pinned');
    assert.ok(html.includes('integrity="sha384-'), 'SRI integrity attribute present');
    assert.ok(html.includes('crossorigin="anonymous"'), 'crossorigin set for SRI');
    // The unpinned form must be gone (would silently drift to latest).
    assert.ok(!html.includes('unpkg.com/vis-network/standalone'), 'no unpinned vis-network URL');
});

await test('no domain-specific node-type group colors remain (schema-agnostic core)', async () => {
    const html = await exportGraphAsHtml(fakeGraph([{ id: 'n1', label: 'x', type: 'note' }]));
    for (const domainType of ['Person:', 'Place:', 'PersonalEvent:', 'Memory:', 'Contract:']) {
        assert.ok(!html.includes(domainType), `domain group key "${domainType}" must be gone`);
    }
    // Core engine groups + default fallback stay.
    assert.ok(html.includes('decision:'), 'core "decision" group kept');
    assert.ok(html.includes('bug_pattern:'), 'core "bug_pattern" group kept');
    assert.ok(html.includes('default:'), 'default group fallback kept');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
