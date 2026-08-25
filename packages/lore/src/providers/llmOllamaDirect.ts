/**
 * llmOllamaDirect.ts — Single-shot (non-streaming) Ollama invocation helpers.
 *
 * Used by quality-signal-triggered re-processing jobs (vision OCR, text
 * re-extraction). Extracted from llmDispatch.ts (file-size budget).
 * llmDispatch.ts re-exports these for backward compatibility.
 *
 * Keep-alive strategy:
 *   MoE text models (qwen3:30b-a3b)  → keep_alive: -1  (never unload — tiny
 *     activation footprint, fast to reuse, always warm for chat)
 *   Vision models (qwen3-vl:32b)     → keep_alive: "30m" (load on demand —
 *     large resident footprint, infrequent use)
 */

const OLLAMA_KEEP_ALIVE_TEXT   = -1;      // always loaded
const OLLAMA_KEEP_ALIVE_VISION = '30m';   // on-demand

const VISION_EXTRACT_PROMPT =
    'Extract ALL text visible in this image exactly as it appears, preserving ' +
    'structure (headings, tables, lists). Return only the extracted text with no ' +
    'commentary. If the image contains no readable text, return an empty string.';

/**
 * invokeOllamaVision — Send an image buffer to an Ollama vision model for
 * text extraction. Returns the full response (not streamed).
 *
 * Throws if Ollama is unreachable or the model is not loaded.
 */
export async function invokeOllamaVision(
    imageBuffer: Buffer,
    mimeType: string,
    model: string = 'qwen3-vl:32b',
    prompt: string = VISION_EXTRACT_PROMPT,
): Promise<string> {
    const base64 = imageBuffer.toString('base64');
    const resp = await fetch('http://localhost:11434/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt, images: [base64] }],
            stream: false,
            keep_alive: OLLAMA_KEEP_ALIVE_VISION,
        }),
        signal: AbortSignal.timeout(120_000), // 2 min — large images are slow
    });
    if (!resp.ok) {
        throw new Error(`Ollama vision HTTP ${resp.status}: ${await resp.text().catch(() => '')}`);
    }
    const data = await resp.json() as { message?: { content?: string } };
    return data.message?.content?.trim() ?? '';
}

/**
 * invokeOllamaText — Send a text prompt to an Ollama text model.
 * Used for structured re-extraction from already-decoded document text.
 */
export async function invokeOllamaText(
    prompt: string,
    model: string = 'qwen3:30b-a3b',
): Promise<string> {
    const resp = await fetch('http://localhost:11434/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
            stream: false,
            keep_alive: OLLAMA_KEEP_ALIVE_TEXT,
        }),
        signal: AbortSignal.timeout(60_000),
    });
    if (!resp.ok) {
        throw new Error(`Ollama text HTTP ${resp.status}: ${await resp.text().catch(() => '')}`);
    }
    const data = await resp.json() as { message?: { content?: string } };
    return data.message?.content?.trim() ?? '';
}
