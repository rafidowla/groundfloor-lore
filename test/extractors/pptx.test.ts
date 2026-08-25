/**
 * test/extractors/pptx.test.ts
 * Run: tsx test/extractors/pptx.test.ts
 */

import * as assert from 'node:assert/strict';
import JSZip from 'jszip';
import { pptxExtractor } from '../../packages/lore/src/engines/extractors/pptx.js';
import { buildDefaultRegistry } from '../../packages/lore/src/engines/extractors/index.js';
import { ExtractorError } from '../../packages/lore/src/engines/extractors/types.js';

// ── PPTX builder helpers ──────────────────────────────────────────────────

function slideXml(...texts: string[]): string {
    const runs = texts
        .map(t => `<a:r><a:t>${t}</a:t></a:r>`)
        .join('');
    return `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody><a:p>${runs}</a:p></p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>`;
}

function notesXml(text: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
         xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
</p:notes>`;
}

async function makePptx(
    slides: Array<{ texts: string[]; notes?: string }>,
): Promise<Buffer> {
    const zip = new JSZip();
    for (let i = 0; i < slides.length; i++) {
        const n = i + 1;
        zip.file(`ppt/slides/slide${n}.xml`, slideXml(...slides[i].texts));
        if (slides[i].notes) {
            zip.file(`ppt/notesSlides/notesSlide${n}.xml`, notesXml(slides[i].notes!));
        }
    }
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    return buf;
}

// ── pptxExtractor.extract() ───────────────────────────────────────────────

async function testEmptyBuffer(): Promise<void> {
    await assert.rejects(
        () => pptxExtractor.extract(Buffer.alloc(0), 'application/vnd.openxmlformats-officedocument.presentationml.presentation'),
        (err: unknown) => err instanceof ExtractorError && err.code === 'empty',
    );
    console.log('  ✓ empty buffer throws ExtractorError("empty")');
}

async function testSingleSlide(): Promise<void> {
    const buf = await makePptx([
        { texts: ['Welcome to Lore', 'Your knowledge graph'] },
    ]);
    const result = await pptxExtractor.extract(buf, 'application/vnd.openxmlformats-officedocument.presentationml.presentation');

    assert.ok(result.text.includes('Welcome to Lore'), 'first text run preserved');
    assert.ok(result.text.includes('Your knowledge graph'), 'second text run preserved');
    assert.ok(result.text.includes('## Slide 1'), 'slide heading present');
    assert.equal(result.metadata.slideCount, 1, 'slideCount = 1');
    assert.equal(result.confidence, 1.0, 'confidence 1.0');
    console.log('  ✓ single slide — text extracted with heading');
}

async function testMultipleSlides(): Promise<void> {
    const buf = await makePptx([
        { texts: ['Slide One Title'] },
        { texts: ['Slide Two Content'] },
        { texts: ['Slide Three Conclusion'] },
    ]);
    const result = await pptxExtractor.extract(buf, 'application/vnd.openxmlformats-officedocument.presentationml.presentation');

    assert.ok(result.text.includes('Slide One Title'), 'slide 1 text present');
    assert.ok(result.text.includes('Slide Two Content'), 'slide 2 text present');
    assert.ok(result.text.includes('Slide Three Conclusion'), 'slide 3 text present');
    assert.ok(result.text.includes('## Slide 1'), 'slide 1 heading');
    assert.ok(result.text.includes('## Slide 2'), 'slide 2 heading');
    assert.ok(result.text.includes('## Slide 3'), 'slide 3 heading');
    assert.equal(result.metadata.slideCount, 3, 'slideCount = 3');
    console.log('  ✓ multiple slides — all sections extracted');
}

async function testSpeakerNotes(): Promise<void> {
    const buf = await makePptx([
        { texts: ['Main slide content'], notes: 'Speaker note for slide 1' },
    ]);
    const result = await pptxExtractor.extract(buf, 'application/vnd.openxmlformats-officedocument.presentationml.presentation');

    assert.ok(result.text.includes('Main slide content'), 'slide body present');
    assert.ok(result.text.includes('Speaker note for slide 1'), 'notes text present');
    assert.ok(result.text.includes('[Notes]'), '[Notes] prefix present');
    assert.equal(result.metadata.hasNotes, true, 'hasNotes = true');
    assert.equal(result.metadata.notesSlideCount, 1, 'notesSlideCount = 1');
    console.log('  ✓ speaker notes extracted with [Notes] prefix');
}

async function testSlideOrder(): Promise<void> {
    // Slides should appear in numeric order even if stored out of order in ZIP
    const zip = new JSZip();
    zip.file('ppt/slides/slide3.xml', slideXml('Third'));
    zip.file('ppt/slides/slide1.xml', slideXml('First'));
    zip.file('ppt/slides/slide2.xml', slideXml('Second'));
    const buf = await zip.generateAsync({ type: 'nodebuffer' });

    const result = await pptxExtractor.extract(buf, 'application/vnd.openxmlformats-officedocument.presentationml.presentation');

    const firstPos  = result.text.indexOf('First');
    const secondPos = result.text.indexOf('Second');
    const thirdPos  = result.text.indexOf('Third');
    assert.ok(firstPos < secondPos, 'First appears before Second');
    assert.ok(secondPos < thirdPos, 'Second appears before Third');
    console.log('  ✓ slides sorted in numeric order (not alphabetical)');
}

async function testNoSlidesThrows(): Promise<void> {
    // A valid ZIP that has no ppt/slides/*.xml files
    const zip = new JSZip();
    zip.file('README.txt', 'not a presentation');
    const buf = await zip.generateAsync({ type: 'nodebuffer' });

    await assert.rejects(
        () => pptxExtractor.extract(buf, 'application/vnd.openxmlformats-officedocument.presentationml.presentation'),
        (err: unknown) => err instanceof ExtractorError && err.code === 'empty',
    );
    console.log('  ✓ ZIP with no slide files throws ExtractorError("empty")');
}

async function testMultipleTextRunsJoined(): Promise<void> {
    // Multiple <a:t> elements on the same slide should be joined
    const xml = `<?xml version="1.0"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree>
    <p:sp><p:txBody><a:p>
      <a:r><a:t>Alpha</a:t></a:r>
      <a:r><a:t>Beta</a:t></a:r>
    </a:p></p:txBody></p:sp>
    <p:sp><p:txBody><a:p>
      <a:r><a:t>Gamma</a:t></a:r>
    </a:p></p:txBody></p:sp>
  </p:spTree></p:cSld>
</p:sld>`;
    const zip = new JSZip();
    zip.file('ppt/slides/slide1.xml', xml);
    const buf = await zip.generateAsync({ type: 'nodebuffer' });

    const result = await pptxExtractor.extract(buf, 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    assert.ok(result.text.includes('Alpha'), 'Alpha present');
    assert.ok(result.text.includes('Beta'), 'Beta present');
    assert.ok(result.text.includes('Gamma'), 'Gamma present');
    console.log('  ✓ multiple <a:t> runs on one slide all extracted');
}

// ── Registry wiring ───────────────────────────────────────────────────────

function testRegistryWiring(): void {
    const registry = buildDefaultRegistry();

    assert.equal(
        registry.mimeFromPath('deck.pptx'),
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        '.pptx MIME type',
    );
    assert.equal(
        registry.mimeFromPath('old.ppt'),
        'application/vnd.ms-powerpoint',
        '.ppt MIME type',
    );
    assert.equal(
        registry.mimeFromPath('slides.odp'),
        'application/vnd.oasis.opendocument.presentation',
        '.odp MIME type',
    );

    const extractor = registry.findByMime('application/vnd.openxmlformats-officedocument.presentationml.presentation');
    assert.ok(extractor, 'pptx extractor registered');
    assert.equal(extractor?.name, 'pptx', 'correct extractor name');

    console.log('  ✓ registry wiring — .pptx, .ppt, .odp');
}

// ── Runner ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    console.log('pptx extractor tests');

    console.log('\npptxExtractor');
    await testEmptyBuffer();
    await testSingleSlide();
    await testMultipleSlides();
    await testSpeakerNotes();
    await testSlideOrder();
    await testNoSlidesThrows();
    await testMultipleTextRunsJoined();

    console.log('\nregistry');
    testRegistryWiring();

    console.log('\nAll pptx extractor tests passed.');
}

main().catch(err => { console.error(err); process.exit(1); });
