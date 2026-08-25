/**
 * epub.ts — EPUB ebook text extraction via JSZip.
 *
 * EPUB is a ZIP archive containing XHTML content files referenced by
 * an OPF manifest. We follow the spine order so text reads naturally
 * (chapter 1 before chapter 2, etc.).
 *
 * Pipeline:
 *   1. Unzip with JSZip (already a transitive dep)
 *   2. Parse META-INF/container.xml → locate the OPF rootfile
 *   3. Parse the OPF → build spine item order (idref → href)
 *   4. Extract and tag-strip each spine XHTML file in order
 *   5. Concatenate with chapter headings
 *
 * Fallback: if the OPF/spine parse fails, collect all .xhtml/.html
 * files from the ZIP and process them alphabetically — recovers most
 * content even from malformed EPUBs.
 *
 * Quality signal: fires when very little text is extracted relative
 * to file size (image-heavy comic EPUB or DRM-protected file).
 */

import type { IExtractor, ExtractedContent } from './types.js';
import { ExtractorError } from './types.js';
import { assertZipWithinBudget, ZipByteBudget } from './zipGuard.js';
import { capText } from './textCap.js';
import { htmlToText } from './html.js';

function extractAttr(xml: string, tag: string, attr: string): string | null {
    const re = new RegExp(`<${tag}[^>]*\\s${attr}="([^"]*)"`, 'i');
    const m = xml.match(re);
    return m ? m[1] : null;
}

function extractSpineItems(opfXml: string): string[] {
    // Build id→href map from manifest
    const manifestItems = new Map<string, string>();
    const itemRe = /<item\s[^>]*>/gi;
    let m: RegExpExecArray | null;
    while ((m = itemRe.exec(opfXml)) !== null) {
        const id   = extractAttr(m[0], 'item', 'id') ?? extractAttrSingle(m[0], 'id');
        const href = extractAttr(m[0], 'item', 'href') ?? extractAttrSingle(m[0], 'href');
        const mt   = extractAttr(m[0], 'item', 'media-type') ?? '';
        if (id && href && (mt.includes('xhtml') || mt.includes('html') || href.match(/\.(x?html?)$/i))) {
            manifestItems.set(id, href);
        }
    }
    // Build ordered list from spine
    const hrefs: string[] = [];
    const itemrefRe = /<itemref\s[^>]*>/gi;
    while ((m = itemrefRe.exec(opfXml)) !== null) {
        const idref = extractAttr(m[0], 'itemref', 'idref') ?? extractAttrSingle(m[0], 'idref');
        if (idref && manifestItems.has(idref)) {
            hrefs.push(manifestItems.get(idref)!);
        }
    }
    return hrefs;
}

function extractAttrSingle(tag: string, attr: string): string | null {
    const re = new RegExp(`\\s${attr}="([^"]*)"`, 'i');
    const m = tag.match(re);
    return m ? m[1] : null;
}

function resolveHref(opfPath: string, href: string): string {
    // opfPath e.g. "OEBPS/content.opf"; href e.g. "chapter1.xhtml"
    const dir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
    return dir + href;
}

export const epubExtractor: IExtractor = {
    name: 'epub',
    mimeTypes: ['application/epub+zip'],

    async extract(input: Buffer, mimeType: string): Promise<ExtractedContent> {
        if (input.byteLength === 0) {
            throw new ExtractorError('EPUB is empty', 'empty');
        }

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
                `Failed to open EPUB: ${(err as Error).message}`,
                'corrupt',
            );
        }

        // audit 2026-06-18 — decompression-bomb guard before any .async() inflate.
        // F-E01 — `budget` also caps ACTUAL inflated bytes (defends a lying header).
        try { assertZipWithinBudget(zip, 'epub'); }
        catch (err) { throw new ExtractorError((err as Error).message, 'unsupported'); }
        const budget = new ZipByteBudget('epub');

        // --- Locate OPF via container.xml ---
        let opfPath: string | null = null;
        const containerFile = zip.files['META-INF/container.xml'];
        if (containerFile) {
            // F-E01 — read through the real-byte budget.
            const containerXml: string = await budget.readString(containerFile, 'META-INF/container.xml');
            opfPath = extractAttr(containerXml, 'rootfile', 'full-path');
        }

        let spineHrefs: string[] = [];
        let title: string | undefined;

        if (opfPath && zip.files[opfPath]) {
            const opfXml: string = await budget.readString(zip.files[opfPath], opfPath); // F-E01
            // Extract book title
            const titleM = opfXml.match(/<dc:title[^>]*>([^<]+)<\/dc:title>/i);
            title = titleM ? titleM[1].trim() : undefined;
            spineHrefs = extractSpineItems(opfXml).map((h) => resolveHref(opfPath!, h));
        }

        // Fallback: collect all XHTML files alphabetically
        if (spineHrefs.length === 0) {
            spineHrefs = Object.keys(zip.files)
                .filter((n) => /\.(x?html?)$/i.test(n) && !n.includes('toc'))
                .sort();
        }

        const chapters: string[] = [];
        let chapterNum = 0;

        for (const href of spineHrefs) {
            const file = zip.files[href] ?? zip.files[decodeURIComponent(href)];
            if (!file) continue;
            chapterNum++;
            const html: string = await budget.readString(file, href); // F-E01
            const text = htmlToText(html);
            if (text.length > 10) {
                chapters.push(`## Chapter ${chapterNum}\n${text}`);
            }
        }

        // F-E02 — cap total extracted text so a huge ebook can't blow memory.
        const fullText = capText(chapters.join('\n\n'));
        const imageHeavy = fullText.length < 50 && input.byteLength > 50_000;

        return {
            text: fullText,
            metadata: {
                title,
                chapterCount: chapterNum,
                extractedChapters: chapters.length,
                totalChars: fullText.length,
            },
            confidence: 1.0,
            mimeType,
            sourceBytes: input.byteLength,
            quality: imageHeavy
                ? {
                    reliable: false,
                    reason: 'image_heavy_doc',
                    suggestedUpgrade: 'either',
                    upgradeMessage: `EPUB extracted very little text (${fullText.length} chars from ${Math.round(input.byteLength / 1024)} KB) — may be image-based (comic/manga format) or DRM-protected.`,
                }
                : undefined,
        };
    },
};
