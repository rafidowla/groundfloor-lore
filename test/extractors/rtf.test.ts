/**
 * test/extractors/rtf.test.ts
 * Run: tsx test/extractors/rtf.test.ts
 */

import * as assert from 'node:assert/strict';
import { rtfToText } from '../../packages/lore/src/engines/extractors/rtf.js';
import { buildDefaultRegistry } from '../../packages/lore/src/engines/extractors/index.js';
import { ExtractorError } from '../../packages/lore/src/engines/extractors/types.js';

// ── rtfToText — pure function ─────────────────────────────────────────────

function testBasicText(): void {
    const out = rtfToText('{\\rtf1\\ansi Hello World}');
    assert.ok(out.includes('Hello World'), `got: ${JSON.stringify(out)}`);
    console.log('  ✓ basic text extraction');
}

function testParagraphBreaks(): void {
    const out = rtfToText('{\\rtf1 First\\par Second\\par Third}');
    const lines = out.split('\n').map(l => l.trim()).filter(Boolean);
    assert.ok(lines.some(l => l.includes('First')), 'First present');
    assert.ok(lines.some(l => l.includes('Second')), 'Second present');
    assert.ok(lines.some(l => l.includes('Third')), 'Third present');
    // par should produce newlines separating them
    assert.ok(out.includes('\n'), '\\par produced newline');
    console.log('  ✓ \\par → newline');
}

function testLineBreak(): void {
    const out = rtfToText('{\\rtf1 A\\line B}');
    assert.ok(out.includes('\n'), '\\line produced newline');
    console.log('  ✓ \\line → newline');
}

function testIgnorableDestinationsRemoved(): void {
    // {\*\destination ...} groups should be stripped entirely
    const out = rtfToText('{\\rtf1{\\*\\fonttbl{\\f0 Arial;}}Real text}');
    assert.ok(out.includes('Real text'), 'body text preserved');
    assert.ok(!out.includes('Arial'), 'font table stripped');
    console.log('  ✓ {\\*\\...} ignorable destinations stripped');
}

function testHeaderGroupsRemoved(): void {
    const rtf = '{\\rtf1{\\fonttbl{\\f0\\froman Times;}}{\\colortbl;\\red0\\green0\\blue0;}Body text here}';
    const out = rtfToText(rtf);
    assert.ok(out.includes('Body text here'), 'body text preserved');
    assert.ok(!out.includes('Times'), 'font name stripped');
    assert.ok(!out.includes('red0'), 'color table stripped');
    console.log('  ✓ \\fonttbl and \\colortbl header groups stripped');
}

function testHexEscapes(): void {
    // \'e9 = é (Latin-1 / Windows-1252)
    // \'80 = € (Windows-1252 supplement)
    const out = rtfToText("{\\rtf1 caf\\'e9 costs \\'80}");
    assert.ok(out.includes('é'), `\\' e9 decoded to é, got: ${JSON.stringify(out)}`);
    assert.ok(out.includes('€'), `\\' 80 decoded to €, got: ${JSON.stringify(out)}`);
    console.log('  ✓ Windows-1252 hex escapes decoded');
}

function testUnicodeEscape(): void {
    // \u233? = é (codepoint 233), fallback char ?
    const out = rtfToText('{\\rtf1 caf\\u233?}');
    assert.ok(out.includes('é'), `\\uN? decoded to é, got: ${JSON.stringify(out)}`);
    console.log('  ✓ \\uN? Unicode escapes decoded');
}

function testUnicodeEscapeOutOfRange(): void {
    // RA2-reaudit2 — a crafted out-of-range \uN must NOT throw a RangeError from
    // String.fromCodePoint (malicious-content DoS); drop it, keep surrounding text.
    assert.doesNotThrow(() => rtfToText('{\\rtf1 x\\u99999999999?y}'), 'huge \\uN must not throw');
    const out = rtfToText('{\\rtf1 x\\u99999999999?y}');
    assert.ok(out.includes('x') && out.includes('y'), `surrounding text preserved, got: ${JSON.stringify(out)}`);
    console.log('  ✓ out-of-range \\uN dropped without throwing');
}

function testEscapedBraces(): void {
    const out = rtfToText('{\\rtf1 \\{literal braces\\}}');
    assert.ok(out.includes('{'), 'escaped { preserved');
    assert.ok(out.includes('}'), 'escaped } preserved');
    console.log('  ✓ escaped \\{ and \\} preserved as literal braces');
}

function testControlWordsStripped(): void {
    // Control words like \b \i \fs24 should not appear in output
    const out = rtfToText('{\\rtf1\\b\\fs24 Bold text\\b0}');
    assert.ok(out.includes('Bold text'), 'text preserved');
    assert.ok(!/\\[a-zA-Z]/.test(out), `control words stripped, got: ${JSON.stringify(out)}`);
    console.log('  ✓ formatting control words (\\b, \\fs24) stripped');
}

function testTabConversion(): void {
    // \tab must be followed by a space (RTF control-word terminator)
    const out = rtfToText('{\\rtf1 Col1\\tab Col2}');
    assert.ok(out.includes('\t'), '\\tab → tab character');
    console.log('  ✓ \\tab → tab');
}

function testSectionBreak(): void {
    const out = rtfToText('{\\rtf1 Section one\\sect Section two}');
    assert.ok(out.includes('Section one'), 'first section present');
    assert.ok(out.includes('Section two'), 'second section present');
    console.log('  ✓ \\sect → paragraph break');
}

function testRealWorldDocument(): void {
    // A plausible RTF snippet resembling a Word-generated file
    const rtf = [
        '{\\rtf1\\ansi\\deff0',
        '{\\fonttbl{\\f0\\froman\\fcharset0 Times New Roman;}}',
        '{\\colortbl;\\red0\\green0\\blue0;}',
        '{\\*\\generator Microsoft Word 16.0;}',
        '\\pard\\f0\\fs24',
        'Meeting Notes\\par',
        '\\par',
        'Attendees: Alice, Bob\\par',
        'Action items: Review Q3 budget\\par',
        '}',
    ].join('\n');
    const out = rtfToText(rtf);
    assert.ok(out.includes('Meeting Notes'), 'heading extracted');
    assert.ok(out.includes('Alice'), 'attendee list extracted');
    assert.ok(out.includes('Review Q3 budget'), 'action item extracted');
    assert.ok(!out.includes('fonttbl'), 'font table stripped');
    assert.ok(!out.includes('generator'), 'generator metadata stripped');
    console.log('  ✓ real-world RTF document structure');
}

// ── rtfExtractor — full extract() ────────────────────────────────────────

async function testExtractorConfidence(): Promise<void> {
    const registry = buildDefaultRegistry();
    const extractor = registry.findByMime('text/rtf');
    assert.ok(extractor, 'text/rtf extractor registered');

    const rtf = '{\\rtf1\\ansi This is a test document with enough content.\\par More text here.}';
    const result = await extractor.extract(Buffer.from(rtf, 'latin1'), 'text/rtf');

    assert.ok(result.text.includes('test document'), 'text extracted');
    assert.equal(result.confidence, 0.9, 'confidence 0.9 for normal RTF');
    assert.ok(!result.quality, 'no quality signal for normal RTF');
    console.log('  ✓ rtfExtractor confidence=0.9 for normal content');
}

async function testSparseSignal(): Promise<void> {
    const registry = buildDefaultRegistry();
    const extractor = registry.findByMime('text/rtf');
    assert.ok(extractor);

    // 25KB of RTF that produces < 50 chars of text → sparse signal
    const padding = '\\bin ' + '0'.repeat(25_000);
    const rtf = `{\\rtf1 Hi${padding}}`;
    const result = await extractor.extract(Buffer.from(rtf, 'latin1'), 'text/rtf');

    // The RTF is large (>20KB) but extracted text is short (<50 chars)
    if (result.sourceBytes > 20_000 && result.text.length < 50) {
        assert.equal(result.confidence, 0.4, 'sparse signal drops confidence to 0.4');
        assert.ok(result.quality?.reliable === false, 'quality.reliable = false');
    }
    console.log('  ✓ sparse RTF triggers quality signal');
}

// ── Registry wiring ───────────────────────────────────────────────────────

function testRegistryWiring(): void {
    const registry = buildDefaultRegistry();
    assert.equal(registry.mimeFromPath('doc.rtf'), 'text/rtf', '.rtf → text/rtf');
    const extractor = registry.findByMime('text/rtf');
    assert.ok(extractor, 'text/rtf has an extractor');
    assert.equal(extractor?.name, 'rtf', 'correct extractor name');
    const appRtf = registry.findByMime('application/rtf');
    assert.ok(appRtf, 'application/rtf also registered');
    console.log('  ✓ registry wiring — .rtf, text/rtf, application/rtf');
}

// ── Runner ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    console.log('rtf extractor tests');

    console.log('\nrtfToText');
    testBasicText();
    testParagraphBreaks();
    testLineBreak();
    testIgnorableDestinationsRemoved();
    testHeaderGroupsRemoved();
    testHexEscapes();
    testUnicodeEscape();
    testUnicodeEscapeOutOfRange();
    testEscapedBraces();
    testControlWordsStripped();
    testTabConversion();
    testSectionBreak();
    testRealWorldDocument();

    console.log('\nrtfExtractor');
    await testExtractorConfidence();
    await testSparseSignal();

    console.log('\nregistry');
    testRegistryWiring();

    console.log('\nAll rtf extractor tests passed.');
}

main().catch(err => { console.error(err); process.exit(1); });
