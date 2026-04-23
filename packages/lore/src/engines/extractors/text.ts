/**
 * text.ts — Plain-text / markdown passthrough extractor.
 *
 * Simplest possible: decode UTF-8, return the text. No parsing, no
 * structure extraction. For markdown we don't strip or transform
 * the markup — downstream chunkers may want to preserve headings
 * for retrieval context, and the LLM is perfectly comfortable
 * reading raw markdown.
 *
 * Confidence is 1.0: there's no extraction uncertainty for a raw
 * text file. Binary data that accidentally matches a .txt extension
 * will come through as mojibake — detectable by the caller if they
 * want to, but we don't try to guess encoding here.
 */

import type { IExtractor, ExtractedContent } from './types.js';

export const textExtractor: IExtractor = {
    name: 'text',
    mimeTypes: ['text/plain', 'text/markdown', 'text/*'],
    async extract(input: Buffer, mimeType: string): Promise<ExtractedContent> {
        const text = input.toString('utf-8');
        return {
            text,
            metadata: {
                encoding: 'utf-8',
                charCount: text.length,
            },
            confidence: 1.0,
            mimeType,
            sourceBytes: input.byteLength,
        };
    },
};
