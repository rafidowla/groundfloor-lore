/**
 * test/extractors/html.test.ts
 * Run: tsx test/extractors/html.test.ts
 */

import * as assert from 'node:assert/strict';
import { htmlToText } from '../../packages/lore/src/engines/extractors/html.js';
import { buildDefaultRegistry } from '../../packages/lore/src/engines/extractors/index.js';

// ── htmlToText — pure function ────────────────────────────────────────────

function testBasicTagStripping(): void {
    const out = htmlToText('<h1>Title</h1><p>Body text.</p>');
    assert.ok(out.includes('Title'), 'h1 text preserved');
    assert.ok(out.includes('Body text.'), 'p text preserved');
    assert.ok(!out.includes('<'), 'no tags in output');
    console.log('  ✓ basic tag stripping');
}

function testScriptStyleRemoved(): void {
    const out = htmlToText('<p>Hello</p><script>alert("xss")</script><style>.x{color:red}</style><p>World</p>');
    assert.ok(out.includes('Hello'), 'paragraph before script preserved');
    assert.ok(out.includes('World'), 'paragraph after style preserved');
    assert.ok(!out.includes('alert'), 'script content removed');
    assert.ok(!out.includes('color:red'), 'style content removed');
    console.log('  ✓ <script> and <style> blocks removed');
}

function testCommentRemoved(): void {
    const out = htmlToText('<p>Keep</p><!-- remove this -->');
    assert.ok(out.includes('Keep'), 'text preserved');
    assert.ok(!out.includes('remove this'), 'comment content removed');
    console.log('  ✓ HTML comments removed');
}

function testBlockLevelNewlines(): void {
    const out = htmlToText('<p>One</p><p>Two</p><div>Three</div>');
    // Block-level closing tags produce newlines
    assert.ok(/One[\s\S]+Two[\s\S]+Three/.test(out), 'paragraphs separated');
    console.log('  ✓ block-level tags produce newlines');
}

function testBrTag(): void {
    const out = htmlToText('Line one<br>Line two<br/>Line three');
    const lines = out.split('\n').filter(l => l.trim());
    assert.equal(lines.length, 3, 'three lines from <br>');
    console.log('  ✓ <br> converted to newline');
}

function testEntityDecoding(): void {
    const out = htmlToText('&amp; &lt; &gt; &quot; &apos; &nbsp; &#65; &#x42;');
    assert.ok(out.includes('&'), '&amp; decoded');
    assert.ok(out.includes('<'), '&lt; decoded');
    assert.ok(out.includes('>'), '&gt; decoded');
    assert.ok(out.includes('"'), '&quot; decoded');
    assert.ok(out.includes("'"), '&apos; decoded');
    assert.ok(out.includes('A'), '&#65; (A) decoded');
    assert.ok(out.includes('B'), '&#x42; (B) decoded');
    console.log('  ✓ HTML entities decoded');
}

function testWhitespaceCollapsed(): void {
    const out = htmlToText('<p>  too   many   spaces  </p>');
    assert.ok(!/ {2,}/.test(out), 'multiple spaces collapsed');
    console.log('  ✓ whitespace collapsed');
}

function testSvgTextExtracted(): void {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">
        <title>My Diagram</title>
        <text x="10" y="20">Label text</text>
        <path d="M0 0 L100 100" />
    </svg>`;
    const out = htmlToText(svg);
    assert.ok(out.includes('My Diagram'), 'SVG title preserved');
    assert.ok(out.includes('Label text'), 'SVG text element preserved');
    assert.ok(!out.includes('M0 0'), 'path data not in output');
    console.log('  ✓ SVG: title and text elements extracted, path data excluded');
}

function testNestedStructure(): void {
    const out = htmlToText('<article><h2>Section</h2><ul><li>Item A</li><li>Item B</li></ul></article>');
    assert.ok(out.includes('Section'), 'h2 preserved');
    assert.ok(out.includes('Item A'), 'li text preserved');
    assert.ok(out.includes('Item B'), 'second li preserved');
    console.log('  ✓ nested structure (article/ul/li)');
}

// ── htmlExtractor — full extract() ───────────────────────────────────────

async function testExtractorOutput(): Promise<void> {
    const registry = buildDefaultRegistry();
    const extractor = registry.findByMime('text/html');
    assert.ok(extractor, 'text/html extractor registered');

    const html = '<html><head><title>Test Page</title></head><body><h1>Hello</h1><p>World</p></body></html>';
    const result = await extractor.extract(Buffer.from(html, 'utf8'), 'text/html');

    assert.ok(result.text.includes('Hello'), 'h1 in output');
    assert.ok(result.text.includes('World'), 'p in output');
    assert.equal(result.metadata.title, 'Test Page', 'title extracted');
    assert.equal(result.confidence, 1.0, 'html confidence is 1.0');
    assert.ok((result.metadata.compressionRatio as number) > 0, 'compression ratio positive');
    console.log('  ✓ htmlExtractor.extract() — text, title, metadata');
}

async function testSvgExtractor(): Promise<void> {
    const registry = buildDefaultRegistry();
    const extractor = registry.findByMime('image/svg+xml');
    assert.ok(extractor, 'image/svg+xml extractor registered');
    const svg = '<svg><title>Chart</title><text>Data label</text></svg>';
    const result = await extractor.extract(Buffer.from(svg), 'image/svg+xml');
    assert.ok(result.text.includes('Chart') || result.text.includes('Data label'), 'SVG content extracted');
    console.log('  ✓ image/svg+xml routed to htmlExtractor');
}

// ── Registry wiring ───────────────────────────────────────────────────────

function testRegistryWiring(): void {
    const registry = buildDefaultRegistry();
    for (const ext of ['.html', '.htm']) {
        const mime = registry.mimeFromPath(`file${ext}`);
        assert.equal(mime, 'text/html', `${ext} → text/html`);
    }
    assert.equal(registry.mimeFromPath('diagram.svg'), 'image/svg+xml', '.svg → image/svg+xml');
    console.log('  ✓ registry wiring — .html, .htm, .svg');
}

// ── Runner ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    console.log('html extractor tests');

    console.log('\nhtmlToText');
    testBasicTagStripping();
    testScriptStyleRemoved();
    testCommentRemoved();
    testBlockLevelNewlines();
    testBrTag();
    testEntityDecoding();
    testWhitespaceCollapsed();
    testSvgTextExtracted();
    testNestedStructure();

    console.log('\nhtmlExtractor');
    await testExtractorOutput();
    await testSvgExtractor();

    console.log('\nregistry');
    testRegistryWiring();

    console.log('\nAll html extractor tests passed.');
}

main().catch(err => { console.error(err); process.exit(1); });
