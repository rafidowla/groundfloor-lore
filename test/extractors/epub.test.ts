/**
 * test/extractors/epub.test.ts
 * Run: tsx test/extractors/epub.test.ts
 */

import * as assert from 'node:assert/strict';
import JSZip from 'jszip';
import { epubExtractor } from '../../packages/lore/src/engines/extractors/epub.js';
import { buildDefaultRegistry } from '../../packages/lore/src/engines/extractors/index.js';
import { ExtractorError } from '../../packages/lore/src/engines/extractors/types.js';

// ── EPUB builder helpers ──────────────────────────────────────────────────

interface EpubChapter {
    id: string;
    href: string;
    html: string;
}

interface EpubOptions {
    title?: string;
    chapters: EpubChapter[];
    omitContainer?: boolean;
    omitOpf?: boolean;
}

async function makeEpub(opts: EpubOptions): Promise<Buffer> {
    const zip = new JSZip();
    const opfPath = 'OEBPS/content.opf';

    if (!opts.omitContainer) {
        zip.file('META-INF/container.xml', `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="${opfPath}" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);
    }

    if (!opts.omitOpf) {
        const manifestItems = opts.chapters
            .map(c => `<item id="${c.id}" href="${c.href}" media-type="application/xhtml+xml"/>`)
            .join('\n    ');
        const spineItems = opts.chapters
            .map(c => `<itemref idref="${c.id}"/>`)
            .join('\n    ');

        zip.file(opfPath, `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${opts.title ?? 'Test Book'}</dc:title>
  </metadata>
  <manifest>
    ${manifestItems}
  </manifest>
  <spine>
    ${spineItems}
  </spine>
</package>`);
    }

    for (const chapter of opts.chapters) {
        zip.file(`OEBPS/${chapter.href}`, chapter.html);
    }

    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    return buf;
}

function xhtml(body: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
  <body>${body}</body>
</html>`;
}

// ── epubExtractor.extract() ───────────────────────────────────────────────

async function testEmptyBuffer(): Promise<void> {
    await assert.rejects(
        () => epubExtractor.extract(Buffer.alloc(0), 'application/epub+zip'),
        (err: unknown) => err instanceof ExtractorError && err.code === 'empty',
    );
    console.log('  ✓ empty buffer throws ExtractorError("empty")');
}

async function testSingleChapter(): Promise<void> {
    const buf = await makeEpub({
        title: 'My First Book',
        chapters: [
            {
                id: 'ch1',
                href: 'chapter1.xhtml',
                html: xhtml('<h1>Chapter One</h1><p>In the beginning there was code.</p>'),
            },
        ],
    });

    const result = await epubExtractor.extract(buf, 'application/epub+zip');

    assert.ok(result.text.includes('Chapter One'), 'h1 heading extracted');
    assert.ok(result.text.includes('In the beginning'), 'paragraph extracted');
    assert.ok(result.text.includes('## Chapter 1'), 'chapter heading present');
    assert.equal(result.metadata.title, 'My First Book', 'title from dc:title');
    assert.equal(result.metadata.chapterCount, 1, 'chapterCount = 1');
    assert.equal(result.confidence, 1.0, 'confidence 1.0');
    console.log('  ✓ single chapter — text, title, chapter heading');
}

async function testMultipleChapters(): Promise<void> {
    const buf = await makeEpub({
        title: 'Adventures in TypeScript',
        chapters: [
            { id: 'ch1', href: 'ch1.xhtml', html: xhtml('<p>First chapter content about types.</p>') },
            { id: 'ch2', href: 'ch2.xhtml', html: xhtml('<p>Second chapter about generics.</p>') },
            { id: 'ch3', href: 'ch3.xhtml', html: xhtml('<p>Third chapter on decorators.</p>') },
        ],
    });

    const result = await epubExtractor.extract(buf, 'application/epub+zip');

    assert.ok(result.text.includes('First chapter'), 'ch1 content present');
    assert.ok(result.text.includes('Second chapter'), 'ch2 content present');
    assert.ok(result.text.includes('Third chapter'), 'ch3 content present');
    assert.ok(result.text.includes('## Chapter 1'), 'ch1 heading');
    assert.ok(result.text.includes('## Chapter 2'), 'ch2 heading');
    assert.ok(result.text.includes('## Chapter 3'), 'ch3 heading');
    assert.equal(result.metadata.chapterCount, 3, 'chapterCount = 3');
    assert.equal(result.metadata.title, 'Adventures in TypeScript', 'title extracted');
    console.log('  ✓ multiple chapters — all sections present');
}

async function testSpineOrder(): Promise<void> {
    // OPF spine defines ch2, ch1 order — output must follow spine, not ZIP order
    const zip = new JSZip();
    zip.file('META-INF/container.xml', `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);
    zip.file('content.opf', `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Order Test</dc:title></metadata>
  <manifest>
    <item id="chA" href="chA.xhtml" media-type="application/xhtml+xml"/>
    <item id="chB" href="chB.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="chB"/>
    <itemref idref="chA"/>
  </spine>
</package>`);
    zip.file('chA.xhtml', xhtml('<p>Alpha content that comes second in spine.</p>'));
    zip.file('chB.xhtml', xhtml('<p>Beta content that comes first in spine.</p>'));
    const buf = await zip.generateAsync({ type: 'nodebuffer' });

    const result = await epubExtractor.extract(buf, 'application/epub+zip');

    const betaPos  = result.text.indexOf('Beta content');
    const alphaPos = result.text.indexOf('Alpha content');
    assert.ok(betaPos > -1 && alphaPos > -1, 'both chapters present');
    assert.ok(betaPos < alphaPos, 'spine order respected: Beta before Alpha');
    console.log('  ✓ spine order respected — chB before chA');
}

async function testFallbackNoContainer(): Promise<void> {
    // No META-INF/container.xml → fallback to alphabetical XHTML
    const zip = new JSZip();
    zip.file('chapter1.xhtml', xhtml('<p>Fallback chapter one.</p>'));
    zip.file('chapter2.xhtml', xhtml('<p>Fallback chapter two.</p>'));
    const buf = await zip.generateAsync({ type: 'nodebuffer' });

    const result = await epubExtractor.extract(buf, 'application/epub+zip');

    assert.ok(result.text.includes('Fallback chapter one'), 'ch1 in fallback output');
    assert.ok(result.text.includes('Fallback chapter two'), 'ch2 in fallback output');
    console.log('  ✓ fallback: no container.xml — alphabetical XHTML scan');
}

async function testHtmlStrippedInChapters(): Promise<void> {
    const buf = await makeEpub({
        chapters: [{
            id: 'ch1',
            href: 'ch1.xhtml',
            html: xhtml('<p>Clean text.</p><script>alert("bad")</script><style>.x{color:red}</style>'),
        }],
    });

    const result = await epubExtractor.extract(buf, 'application/epub+zip');
    assert.ok(result.text.includes('Clean text'), 'paragraph text preserved');
    assert.ok(!result.text.includes('alert'), 'script content stripped');
    assert.ok(!result.text.includes('color:red'), 'style content stripped');
    console.log('  ✓ HTML tags / script / style stripped within chapters');
}

async function testMetadataFields(): Promise<void> {
    const buf = await makeEpub({
        title: 'Metadata Test',
        chapters: [
            { id: 'c1', href: 'c1.xhtml', html: xhtml('<p>Chapter content here.</p>') },
            { id: 'c2', href: 'c2.xhtml', html: xhtml('<p>More content here.</p>') },
        ],
    });

    const result = await epubExtractor.extract(buf, 'application/epub+zip');
    assert.equal(result.metadata.chapterCount, 2, 'chapterCount = 2');
    assert.equal(result.metadata.extractedChapters, 2, 'extractedChapters = 2');
    assert.ok((result.metadata.totalChars as number) > 0, 'totalChars > 0');
    console.log('  ✓ metadata: chapterCount, extractedChapters, totalChars');
}

// ── Registry wiring ───────────────────────────────────────────────────────

function testRegistryWiring(): void {
    const registry = buildDefaultRegistry();

    assert.equal(
        registry.mimeFromPath('book.epub'),
        'application/epub+zip',
        '.epub MIME type',
    );

    const extractor = registry.findByMime('application/epub+zip');
    assert.ok(extractor, 'epub extractor registered');
    assert.equal(extractor?.name, 'epub', 'correct extractor name');

    console.log('  ✓ registry wiring — .epub → application/epub+zip');
}

// ── Runner ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    console.log('epub extractor tests');

    console.log('\nepubExtractor');
    await testEmptyBuffer();
    await testSingleChapter();
    await testMultipleChapters();
    await testSpineOrder();
    await testFallbackNoContainer();
    await testHtmlStrippedInChapters();
    await testMetadataFields();

    console.log('\nregistry');
    testRegistryWiring();

    console.log('\nAll epub extractor tests passed.');
}

main().catch(err => { console.error(err); process.exit(1); });
