/**
 * pptx.ts — PowerPoint text extraction via JSZip + XML parsing.
 *
 * PPTX is a ZIP archive containing XML files. No native bindings needed —
 * JSZip (already a transitive dependency) unpacks it in-process.
 *
 * What we extract:
 *   - Slide text in presentation order (slide1.xml → slideN.xml)
 *   - Speaker notes per slide (ppt/notesSlides/notesSlide*.xml)
 *   - Slide titles are preserved as the first line of each slide section
 *
 * What we skip:
 *   - Embedded images (flagged in quality signal if file is large + sparse)
 *   - Charts (data lives in separate xl/ sub-tree, not extracted here)
 *   - Animations and transitions (metadata only, no text content)
 *   - SmartArt labels (complex shape XML — deferred)
 *
 * Text extraction: regex over <a:t> elements rather than a full DOM parse.
 * The DrawingML <a:t> tag is a leaf text run; its content is always plain
 * character data with no nested tags, making regex safe and fast here.
 */

import type { IExtractor, ExtractedContent } from './types.js';
import { ExtractorError } from './types.js';
import { assertZipWithinBudget, ZipByteBudget } from './zipGuard.js';
import { capText } from './textCap.js';

function extractAText(xml: string): string {
    const parts: string[] = [];
    // <a:t> or <a:t xml:space="preserve"> — capture content
    const re = /<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) {
        const t = m[1].trim();
        if (t) parts.push(t);
    }
    return parts.join(' ');
}

function slideIndex(name: string): number {
    // "ppt/slides/slide7.xml" → 7
    const m = name.match(/slide(\d+)\.xml$/i);
    return m ? parseInt(m[1], 10) : 999;
}

function noteIndex(name: string): number {
    const m = name.match(/notesSlide(\d+)\.xml$/i);
    return m ? parseInt(m[1], 10) : 999;
}

export const pptxExtractor: IExtractor = {
    name: 'pptx',
    mimeTypes: [
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'application/vnd.ms-powerpoint',
        'application/vnd.oasis.opendocument.presentation',
    ],

    async extract(input: Buffer, mimeType: string): Promise<ExtractedContent> {
        if (input.byteLength === 0) {
            throw new ExtractorError('Presentation is empty', 'empty');
        }

        // JSZip ships as CJS; dynamic import wraps it so .default may or
        // may not be present depending on the bundler/runtime. Cast to any
        // and resolve defensively.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let JSZip: any;
        try {
            const mod = await import('jszip') as any;
            JSZip = mod.default ?? mod;
        } catch (err) {
            throw new ExtractorError(
                `jszip unavailable: ${(err as Error).message}`,
                'unsupported',
            );
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let zip: any;
        try {
            zip = await JSZip.loadAsync(input);
        } catch (err) {
            throw new ExtractorError(
                `Failed to open presentation: ${(err as Error).message}`,
                'corrupt',
            );
        }

        // audit 2026-06-18 — decompression-bomb guard before any .async() inflate.
        // F-E01 — `budget` also caps ACTUAL inflated bytes (defends a lying header).
        try { assertZipWithinBudget(zip, 'pptx'); }
        catch (err) { throw new ExtractorError((err as Error).message, 'unsupported'); }
        const budget = new ZipByteBudget('pptx');

        // Collect slide XML files sorted by slide number
        const slideFiles = Object.keys(zip.files)
            .filter((n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n))
            .sort((a, b) => slideIndex(a) - slideIndex(b));

        if (slideFiles.length === 0) {
            throw new ExtractorError('No slides found in presentation', 'empty');
        }

        // Collect notes XML files sorted by slide number
        const noteFiles = Object.keys(zip.files)
            .filter((n) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/i.test(n))
            .sort((a, b) => noteIndex(a) - noteIndex(b));

        // Build a notes map: slideIndex → notes text
        const notesMap = new Map<number, string>();
        try {
            for (const nf of noteFiles) {
                const idx = noteIndex(nf);
                const xml = await budget.readString(zip.files[nf], nf); // F-E01
                const text = extractAText(xml);
                if (text) notesMap.set(idx, text);
            }
        } catch (err) {
            throw new ExtractorError((err as Error).message, 'unsupported');
        }

        // Extract each slide
        const sections: string[] = [];
        let slideCount = 0;

        try {
            for (const sf of slideFiles) {
                slideCount++;
                const idx = slideIndex(sf);
                const xml = await budget.readString(zip.files[sf], sf); // F-E01
                const slideText = extractAText(xml);
                const notes = notesMap.get(idx);

                const lines: string[] = [`## Slide ${slideCount}`];
                if (slideText) lines.push(slideText);
                if (notes) lines.push(`[Notes] ${notes}`);

                if (lines.length > 1) {
                    sections.push(lines.join('\n'));
                }
            }
        } catch (err) {
            throw new ExtractorError((err as Error).message, 'unsupported');
        }

        // F-E02 — cap total extracted text so a huge deck can't blow memory.
        const fullText = capText(sections.join('\n\n'));
        const imageHeavy = fullText.length < 20 && input.byteLength > 50_000;

        return {
            text: fullText,
            metadata: {
                slideCount,
                hasNotes: notesMap.size > 0,
                notesSlideCount: notesMap.size,
            },
            confidence: 1.0,
            mimeType,
            sourceBytes: input.byteLength,
            quality: imageHeavy
                ? {
                    reliable: false,
                    reason: 'image_heavy_doc',
                    suggestedUpgrade: 'either',
                    upgradeMessage: `Presentation extracted almost no text (${fullText.length} chars from ${Math.round(input.byteLength / 1024)} KB across ${slideCount} slides) — slides may be mostly images or charts.`,
                }
                : undefined,
        };
    },
};
