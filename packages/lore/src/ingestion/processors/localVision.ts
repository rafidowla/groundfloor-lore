/**
 * ingestion/processors/localVision.ts - the local vision engine: reads the text in one page image through an
 * OpenAI-compatible chat/vision endpoint (LM Studio, vLLM, llama.cpp, ...) on this machine.
 *
 * Same pattern and the same sovereignty guard as localStructurer.ts: the base URL must be loopback unless the host
 * explicitly sets `allowNonLoopback` (a GPU box on the LAN). The model server is a separate, host-owned process;
 * this class only makes requests to it. It never starts one and never lives inside the shared `lore-models` process.
 * A hosted vision API is not an option here: a non-loopback URL is refused at construction.
 */
import { ProcessorError } from '../contracts.js';
import { makeAllowlist } from '../endpointAllowlist.js';
import { postJson, type HttpConfig } from './http.js';
import { isLoopbackHost } from './localStructurer.js';

/** A vision model reports no score, so every page it reads carries this fixed, documented confidence. */
export const VISION_CONFIDENCE = 0.7;
/** Largest page image sent to the model (decoded bytes). */
export const MAX_VISION_IMAGE_BYTES = 20 * 1024 * 1024;

export interface VisionEngine {
    readonly engine: string;
    readonly model: string;
    /** Transcribe the text in one image. `page` is only used in the prompt. */
    describe(image: Buffer, mimeType: string, opts?: { page?: number }): Promise<string>;
}

export interface OpenAiVisionConfig {
    baseUrl: string;
    model: string;
    timeoutMs?: number;
    maxResponseBytes?: number;
    allowNonLoopback?: boolean;
    apiKey?: string;
    fetchImpl?: typeof fetch;
}

const SYSTEM = 'You transcribe text from document images. Reply with the text exactly as it appears, in reading order. '
    + 'Render tables as rows of cells separated by " | ". Do not describe the image, add commentary or translate. '
    + 'If the image contains no readable text, reply with an empty message.';

export class OpenAiVisionEngine implements VisionEngine {
    readonly engine = 'openai-compatible-vision';
    readonly model: string;
    private readonly http: HttpConfig;
    private readonly url: string;

    constructor(private readonly cfg: OpenAiVisionConfig) {
        const u = new URL(cfg.baseUrl);
        if (!cfg.allowNonLoopback && !isLoopbackHost(u.hostname)) {
            throw new Error(`local vision baseUrl ${u.origin} is not loopback; a hosted vision engine is not supported`);
        }
        this.model = cfg.model;
        this.url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
        this.http = {
            allowlist: makeAllowlist([u.origin]), timeoutMs: cfg.timeoutMs ?? 120_000,
            ...(cfg.maxResponseBytes ? { maxResponseBytes: cfg.maxResponseBytes } : {}), ...(cfg.fetchImpl ? { fetchImpl: cfg.fetchImpl } : {}),
        };
    }

    async describe(image: Buffer, mimeType: string, opts: { page?: number } = {}): Promise<string> {
        if (image.byteLength > MAX_VISION_IMAGE_BYTES) throw new ProcessorError(`image exceeds ${MAX_VISION_IMAGE_BYTES} bytes`, false);
        const body = {
            model: this.model, temperature: 0,
            messages: [
                { role: 'system', content: SYSTEM },
                { role: 'user', content: [
                    { type: 'text', text: opts.page ? `Transcribe the text on page ${opts.page}.` : 'Transcribe the text in this image.' },
                    { type: 'image_url', image_url: { url: `data:${mimeType};base64,${image.toString('base64')}` } },
                ] },
            ],
        };
        const { json } = await postJson(this.http, this.url, body, this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {});
        const content = (json as any)?.choices?.[0]?.message?.content;
        if (typeof content !== 'string') throw new ProcessorError('local vision engine returned no message content', false);
        return content.trim();
    }
}
