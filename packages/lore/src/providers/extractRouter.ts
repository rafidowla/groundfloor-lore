/**
 * extractRouter.ts — Dual-path extraction router for Phase 2 of Lore V2.
 *
 * Purpose:
 *   Serve /api/extract: given a file upload, decide whether to accept it
 *   based on the currently configured LLM's capability manifest. This is
 *   the "BYOK should handle what the LLM can handle" decision recorded in
 *   memory/feedback_v2_architecture_decisions.md.
 *
 * Decisions:
 *   - Text-only provider → accept text/plain + text/markdown only
 *   - Multimodal provider → additionally accept image/(png|jpeg|webp|gif)
 *   - Anything else → HTTP 415 with the accepted-types list in the body
 *
 * Non-goals (V2):
 *   - No video / OCR / audio transcription. Lore does not parse binaries.
 *   - No DEF Cloud routing. Radio exists in UI but is greyed out.
 *
 * Side Effects: For accepted text inputs, synchronously chunks and stores
 *   via the provided graph.upsertNode-compatible callback. For accepted
 *   images, returns a 202 with a "pending chunk" marker — the actual image
 *   captioning lives in the LLM pipeline, not in Lore.
 */

import type { LlmCapability } from './llmDispatch.js';

export type ExtractionPath = 'local-byok' | 'def-cloud';

export interface ExtractPayload {
    filename: string;
    mimeType: string;
    /** Base64-encoded for binary types; raw UTF-8 string for text types. */
    content: string;
    encoding: 'utf8' | 'base64';
}

export interface ExtractDecision {
    accepted: boolean;
    status: number;
    body: {
        filename: string;
        mimeType: string;
        reason?: string;
        acceptedMimeTypes?: string[];
        plan?: {
            kind: 'text-chunking' | 'image-caption' | 'rejected';
            chunks?: number;
            preview?: string;
        };
    };
}

/**
 * decide — Pure function: given a payload and the active capability,
 * return the HTTP status + body without side effects.
 *
 * This is the single source of truth for accept/reject logic.
 */
export function decide(payload: ExtractPayload, capability: LlmCapability): ExtractDecision {
    const mimeType = payload.mimeType.toLowerCase();
    const accepts = capability.acceptedMimeTypes.map((m) => m.toLowerCase());

    if (!accepts.includes(mimeType)) {
        return {
            accepted: false,
            status: 415,
            body: {
                filename: payload.filename,
                mimeType: payload.mimeType,
                reason:
                    `Provider "${capability.provider}" (${capability.model}) does not accept ${payload.mimeType}. ` +
                    (capability.acceptsImages
                        ? 'This multimodal model accepts text and images only.'
                        : 'This text-only model accepts UTF-8 text/markdown only. Switch to a multimodal model to process images.'),
                acceptedMimeTypes: capability.acceptedMimeTypes,
                plan: { kind: 'rejected' },
            },
        };
    }

    // Text types: chunk into ~1000-char segments for downstream store_node calls.
    if (mimeType.startsWith('text/')) {
        const text = payload.encoding === 'base64'
            ? Buffer.from(payload.content, 'base64').toString('utf8')
            : payload.content;
        const chunks = Math.max(1, Math.ceil(text.length / 1000));
        return {
            accepted: true,
            status: 202,
            body: {
                filename: payload.filename,
                mimeType: payload.mimeType,
                plan: {
                    kind: 'text-chunking',
                    chunks,
                    preview: text.slice(0, 240) + (text.length > 240 ? '…' : ''),
                },
            },
        };
    }

    // Image types: Lore itself does not OCR/caption. The LLM handles that
    // during a chat turn when the image is referenced; here we just
    // acknowledge acceptance.
    return {
        accepted: true,
        status: 202,
        body: {
            filename: payload.filename,
            mimeType: payload.mimeType,
            plan: {
                kind: 'image-caption',
                preview: `Image staged; ${capability.model} will caption it on next chat reference.`,
            },
        },
    };
}
