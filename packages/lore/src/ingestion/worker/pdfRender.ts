/**
 * ingestion/worker/pdfRender.ts - renders PDF pages to PNG so a vision model can read a scan.
 * Used only when a PDF has no text layer and a local vision engine is configured. pdfjs-dist and
 * @napi-rs/canvas are loaded on first use, so a host that never reads a scan never pays for them.
 */
import { ProcessorError } from '../contracts.js';

/** Longer side of a rendered page in pixels: legible for a vision model, small enough to send. */
const TARGET_LONG_SIDE_PX = 1600;

export interface PdfPageImage { page: number; png: Buffer }
export interface RenderedPdf { pageCount: number; pages: PdfPageImage[] }

/** Render up to `maxPages` pages of the PDF to PNG. Pages are rendered one at a time. */
export async function renderPdfPages(input: Buffer, maxPages: number): Promise<RenderedPdf> {
    let pdfjs: any;
    try { pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs'); }
    catch (err) { throw new ProcessorError(`pdf rendering unavailable: ${(err as Error).message}`, false); }
    const task = pdfjs.getDocument({ data: new Uint8Array(input), verbosity: 0, disableFontFace: true, useSystemFonts: false });
    try {
        const doc = await task.promise;
        const pages: PdfPageImage[] = [];
        const last = Math.min(doc.numPages, maxPages);
        for (let n = 1; n <= last; n++) {
            const page = await doc.getPage(n);
            try {
                const base = page.getViewport({ scale: 1 });
                const scale = Math.max(0.5, Math.min(3, TARGET_LONG_SIDE_PX / Math.max(base.width, base.height)));
                const viewport = page.getViewport({ scale });
                const { canvas, context } = doc.canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
                await page.render({ canvasContext: context, viewport, canvas }).promise;
                pages.push({ page: n, png: canvas.toBuffer('image/png') });
            } finally { try { page.cleanup(); } catch { /* best-effort */ } }
        }
        return { pageCount: doc.numPages, pages };
    } catch (err) {
        if (err instanceof ProcessorError) throw err;
        throw new ProcessorError(`pdf rendering failed: ${(err as Error).message}`, false);
    } finally { try { await task.destroy(); } catch { /* best-effort */ } }
}
