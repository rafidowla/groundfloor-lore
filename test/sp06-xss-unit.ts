#!/usr/bin/env tsx
/**
 * sp06-xss-unit.ts — SP-06 HTML export XSS regression.
 *
 * Proves that node/edge content containing `</script>` (and the related
 * sequences `<!--` and `<script`) cannot break out of the inline-script
 * DATA block produced by exportGraphAsHtml.
 *
 * Two assertions per test:
 *  1. The produced HTML does NOT contain a literal `</script>` inside
 *     the DATA block (the `<` is escaped to `<`).
 *  2. Round-tripping the DATA block through JSON.parse yields the
 *     original string — the escape is lossless.
 */

import assert from 'node:assert/strict';
import { exportGraphAsHtml } from '../packages/lore/src/engines/htmlExport.js';

/** Minimal stub of what getTopology returns — only the fields htmlExport reads. */
function fakeGraph(nodes: Array<{ id: string; label?: string; type?: string }>, edges: Array<{ from: string; to: string; label?: string }> = []) {
    return {
        async getTopology(_max: number) {
            return { nodes, edges };
        },
    } as never;
}

let passed = 0;
let failed = 0;
const pending: Array<Promise<void>> = [];

function test(name: string, fn: () => Promise<void>) {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? (err as Error).message}`); failed++; }
    })());
}

/* ─── XSS payload constants ─── */

/** Classic inline-script breakout: closes the script block + injects JS. */
const CLOSE_SCRIPT = '</script><img src=x onerror=alert(1)>';
/** HTML comment close that can sometimes break parsers. */
const HTML_COMMENT = '<!--<script>alert(2)</script>-->';
/** A raw <script> open inside data. */
const OPEN_SCRIPT = '<script>evil()</script>';

/* ─── helper: extract DATA block JSON from the HTML string ─── */

function extractDataJson(html: string): string {
    // The template emits: `  const DATA = {"nodes":[...],"edges":[...]};`
    // The payload is a JSON object on a single line — match from the first `{`
    // after `const DATA = ` to the matching `}` at end-of-line.
    const m = html.match(/const DATA = (\{.*?\});/);
    assert.ok(m, 'could not find DATA assignment in exported HTML');
    return m[1].trim();
}

/* ─── tests ─── */

test('node label with </script> — literal breakout absent, round-trip lossless', async () => {
    const g = fakeGraph([{ id: 'n1', label: CLOSE_SCRIPT, type: 'note' }]);
    const html = await exportGraphAsHtml(g);

    // 1. No literal `</script>` inside the DATA block (only the closing tag
    //    of the script element itself, which appears AFTER the data block).
    const dataJson = extractDataJson(html);
    assert.ok(
        !dataJson.includes('</script>'),
        `DATA block must not contain a literal </script>; got: ${dataJson.slice(0, 200)}`,
    );
    // `<` must be escaped to <
    assert.ok(dataJson.includes('\\u003c'), 'DATA block must contain \\u003c escapes');

    // 2. Round-trip: JSON.parse yields the original string.
    const parsed = JSON.parse(dataJson) as { nodes: Array<{ label: string }> };
    assert.equal(parsed.nodes[0].label, CLOSE_SCRIPT, 'round-trip must recover original label');
});

test('node label with <!-- HTML comment injection — round-trip lossless', async () => {
    const g = fakeGraph([{ id: 'n2', label: HTML_COMMENT, type: 'note' }]);
    const html = await exportGraphAsHtml(g);
    const dataJson = extractDataJson(html);

    assert.ok(!dataJson.includes('<!--'), 'DATA block must not contain literal <!--');
    assert.ok(dataJson.includes('\\u003c'), 'DATA block must contain \\u003c escapes');

    const parsed = JSON.parse(dataJson) as { nodes: Array<{ label: string }> };
    assert.equal(parsed.nodes[0].label, HTML_COMMENT);
});

test('node label with <script> open tag — literal absent, round-trip lossless', async () => {
    const g = fakeGraph([{ id: 'n3', label: OPEN_SCRIPT, type: 'note' }]);
    const html = await exportGraphAsHtml(g);
    const dataJson = extractDataJson(html);

    assert.ok(!dataJson.includes('<script>'), 'DATA block must not contain literal <script>');
    const parsed = JSON.parse(dataJson) as { nodes: Array<{ label: string }> };
    assert.equal(parsed.nodes[0].label, OPEN_SCRIPT);
});

test('edge label with </script> — breakout absent, round-trip lossless', async () => {
    const g = fakeGraph(
        [{ id: 'a', label: 'source', type: 'note' }, { id: 'b', label: 'target', type: 'note' }],
        [{ from: 'a', to: 'b', label: CLOSE_SCRIPT }],
    );
    const html = await exportGraphAsHtml(g);
    const dataJson = extractDataJson(html);

    assert.ok(!dataJson.includes('</script>'), 'edge DATA block must not contain literal </script>');
    const parsed = JSON.parse(dataJson) as { edges: Array<{ label: string }> };
    assert.equal(parsed.edges[0].label, CLOSE_SCRIPT, 'round-trip must recover original edge label');
});

test('clean graph (no XSS payload) — produced HTML is valid and contains closing </script>', async () => {
    const g = fakeGraph([{ id: 'c1', label: 'clean node', type: 'note' }]);
    const html = await exportGraphAsHtml(g);

    // The outer script element must still close properly.
    assert.ok(html.includes('</script>'), 'exported HTML must contain the closing </script> tag');
    // And the DATA block must round-trip cleanly.
    const dataJson = extractDataJson(html);
    const parsed = JSON.parse(dataJson) as { nodes: Array<{ label: string }> };
    assert.equal(parsed.nodes[0].label, 'clean node');
});

test('multiple XSS payloads in one graph — all escaped, all lossless', async () => {
    const g = fakeGraph(
        [
            { id: 'x1', label: CLOSE_SCRIPT, type: 'note' },
            { id: 'x2', label: HTML_COMMENT, type: 'note' },
            { id: 'x3', label: OPEN_SCRIPT, type: 'note' },
        ],
        [{ from: 'x1', to: 'x2', label: CLOSE_SCRIPT }],
    );
    const html = await exportGraphAsHtml(g);
    const dataJson = extractDataJson(html);

    // No literal breakout sequence present.
    assert.ok(!dataJson.includes('</script>'), 'no literal </script> in multi-payload graph');
    assert.ok(!dataJson.includes('<!--'), 'no literal <!-- in multi-payload graph');

    const parsed = JSON.parse(dataJson) as {
        nodes: Array<{ id: string; label: string }>;
        edges: Array<{ label: string }>;
    };
    const byId = Object.fromEntries(parsed.nodes.map(n => [n.id, n.label]));
    assert.equal(byId['x1'], CLOSE_SCRIPT);
    assert.equal(byId['x2'], HTML_COMMENT);
    assert.equal(byId['x3'], OPEN_SCRIPT);
    assert.equal(parsed.edges[0].label, CLOSE_SCRIPT);
});

console.log('\n=== SP-06 HTML export XSS regressions ===\n');
await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
