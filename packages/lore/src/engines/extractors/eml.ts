/**
 * eml.ts — Email (RFC 822 / MIME) extraction via mailparser.
 *
 * Emails are the densest personal-data corpus most users have. The
 * extraction output needs to carry not just the body but the
 * From/To/Subject/Date headers so the downstream graph can create
 * Communication nodes with edges to Person and Event nodes (the
 * work a personal-domain client application will do in Phase 5).
 *
 * What we extract:
 *   - text: body (plain-text preferred, fall back to HTML stripped)
 *   - metadata.from / to / cc / bcc / subject / date
 *   - metadata.messageId (stable id for dedup on re-sync)
 *   - metadata.inReplyTo / references (thread reconstruction)
 *   - metadata.hasAttachments / attachmentCount
 *
 * What we explicitly don't do:
 *   - attach body rendering (HTML sanitization) — that's a UI concern
 *   - attachment content extraction — attachments round-trip through
 *     the registry as their own bytes (a PDF attachment to an email
 *     gets handed to pdfExtractor separately)
 */

import type { IExtractor, ExtractedContent } from './types.js';
import { ExtractorError } from './types.js';
import { capText } from './textCap.js';

export const emlExtractor: IExtractor = {
    name: 'eml',
    mimeTypes: ['message/rfc822'],
    async extract(input: Buffer, mimeType: string): Promise<ExtractedContent> {
        if (input.byteLength === 0) {
            throw new ExtractorError('Email is empty', 'empty');
        }

        let mailparser: any;
        try {
            mailparser = await import('mailparser');
        } catch (err) {
            throw new ExtractorError(
                `mailparser unavailable: ${(err as Error).message}`,
                'unsupported',
            );
        }

        let parsed: any;
        try {
            parsed = await mailparser.simpleParser(input);
        } catch (err) {
            throw new ExtractorError(
                `Failed to parse email: ${(err as Error).message}`,
                'corrupt',
            );
        }

        // Prefer text body; fall back to HTML-stripped (mailparser
        // does a reasonable job of deriving .text from .html if only
        // the latter is present, so we usually get something usable).
        const bodyText = (parsed.text ?? '').trim();

        // Flatten "display" → simple strings for easy serialization.
        // mailparser returns From/To as { value: [{ address, name }], text }.
        const flattenAddr = (addr: any): string[] => {
            if (!addr) return [];
            if (Array.isArray(addr.value)) {
                return addr.value.map((v: any) =>
                    v.name ? `${v.name} <${v.address}>` : v.address,
                );
            }
            return [addr.text ?? ''];
        };

        // Compose a header line at the top of text so embedders have
        // something to latch onto when a body is empty.
        const headerLine = [
            parsed.from ? `From: ${flattenAddr(parsed.from).join(', ')}` : null,
            parsed.to ? `To: ${flattenAddr(parsed.to).join(', ')}` : null,
            parsed.subject ? `Subject: ${parsed.subject}` : null,
            parsed.date ? `Date: ${new Date(parsed.date).toISOString()}` : null,
        ].filter(Boolean).join('\n');

        // R3-DOS-02 — cap to the 10 MB extracted-text budget.
        const text = capText(bodyText ? `${headerLine}\n\n${bodyText}` : headerLine);

        return {
            text,
            metadata: {
                from: flattenAddr(parsed.from),
                to: flattenAddr(parsed.to),
                cc: flattenAddr(parsed.cc),
                bcc: flattenAddr(parsed.bcc),
                subject: parsed.subject ?? '',
                date: parsed.date ? new Date(parsed.date).toISOString() : undefined,
                messageId: parsed.messageId ?? undefined,
                inReplyTo: parsed.inReplyTo ?? undefined,
                references: Array.isArray(parsed.references)
                    ? parsed.references
                    : (parsed.references ? [parsed.references] : []),
                hasAttachments: (parsed.attachments?.length ?? 0) > 0,
                attachmentCount: parsed.attachments?.length ?? 0,
            },
            confidence: 1.0,
            mimeType,
            sourceBytes: input.byteLength,
        };
    },
};
