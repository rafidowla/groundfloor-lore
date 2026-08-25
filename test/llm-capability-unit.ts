#!/usr/bin/env tsx
/**
 * llm-capability-unit.ts — getCapability resolution + per-workspace model override.
 *
 * Regression coverage for the 2026-05-17 change that threaded
 * cfg.ollamaModel through to getCapability so workspaces can pin
 * a different Ollama model than the daemon-wide DEFAULT_MODELS.ollama.
 *
 * Invariants:
 *   1. No model arg → falls back to DEFAULT_MODELS for that provider.
 *   2. Explicit model arg → cap.model echoes that string verbatim.
 *   3. llama3.1 / llama3.2 / llama3.3 / qwen3 / mistral on Ollama →
 *      toolCalling = 'native' (the agentic chat loop fires).
 *   4. Unknown Ollama models → toolCalling = 'suggestion_only'
 *      (UI falls back to button-prompts).
 *   5. Embedded provider is always text-only + suggestion_only regardless
 *      of the model arg.
 */

import assert from 'node:assert/strict';
import { getCapability, stream } from '../packages/lore/src/providers/llmDispatch.js';

function test(name: string, fn: () => void | Promise<void>): () => Promise<void> {
    return async () => {
        try {
            await fn();
            console.log(`  ok  ${name}`);
        } catch (err) {
            console.error(`  FAIL ${name}`);
            console.error(err);
            process.exitCode = 1;
        }
    };
}

const tests = [
    test('ollama: no model arg → falls back to DEFAULT_MODELS.ollama', () => {
        const cap = getCapability('ollama');
        assert.equal(cap.provider, 'ollama');
        assert.ok(cap.model && cap.model.length > 0, 'should have a non-empty default model');
    }),

    test('ollama: explicit llama3.1:8b → cap.model = "llama3.1:8b", tool calling native', () => {
        const cap = getCapability('ollama', 'llama3.1:8b');
        assert.equal(cap.model, 'llama3.1:8b');
        assert.equal(cap.toolCalling, 'native', 'llama3.1 must be on the Ollama tool-calling allow-list');
        assert.equal(cap.acceptsImages, false);
    }),

    test('ollama: explicit llama3.2:8b → native (existing behavior preserved)', () => {
        const cap = getCapability('ollama', 'llama3.2:8b');
        assert.equal(cap.toolCalling, 'native');
    }),

    test('ollama: explicit llama3.3:70b → native (new allow-list entry)', () => {
        const cap = getCapability('ollama', 'llama3.3:70b-instruct-q4_K_M');
        assert.equal(cap.toolCalling, 'native');
    }),

    test('ollama: explicit qwen3-coder:30b → native (regression — current default)', () => {
        const cap = getCapability('ollama', 'qwen3-coder:30b');
        assert.equal(cap.toolCalling, 'native');
    }),

    test('ollama: explicit mistral-nemo:12b → native', () => {
        const cap = getCapability('ollama', 'mistral-nemo:12b');
        assert.equal(cap.toolCalling, 'native');
    }),

    test('ollama: unknown model → suggestion_only (conservative default)', () => {
        const cap = getCapability('ollama', 'some-random-fork:1b');
        assert.equal(cap.toolCalling, 'suggestion_only');
    }),

    test('ollama: vision-language model (qwen3-vl) → acceptsImages true', () => {
        const cap = getCapability('ollama', 'qwen3-vl:32b');
        assert.equal(cap.acceptsImages, true);
        assert.equal(cap.toolCalling, 'native');
    }),

    test('embedded: ignores model arg, always suggestion_only + text-only', () => {
        const cap = getCapability('embedded', 'llama3.1:8b');
        assert.equal(cap.toolCalling, 'suggestion_only');
        assert.equal(cap.acceptsImages, false);
    }),

    test('anthropic: claude-3-5-sonnet → native', () => {
        const cap = getCapability('anthropic', 'claude-3-5-sonnet-latest');
        assert.equal(cap.toolCalling, 'native');
        assert.equal(cap.acceptsImages, true);
    }),

    test('openai: gpt-4o-mini → native', () => {
        const cap = getCapability('openai', 'gpt-4o-mini');
        assert.equal(cap.toolCalling, 'native');
    }),

    // L-027 — the OpenRouter base URL is threaded as an explicit param, NOT via
    // a globally mutated process.env.LORE_OPENAI_BASE_URL held across the async
    // generator's suspension. Drive an 'openrouter' stream, suspend it mid-stream
    // (pull its first token), then run an 'openai' stream to completion while the
    // openrouter generator is still open. The 'openai' request MUST go to
    // api.openai.com with no OpenRouter attribution headers — proving no
    // cross-request endpoint/key cross-wire. With the old env-mutation this fails.
    test('L-027: a concurrent openai stream is not cross-wired to the openrouter base URL', async () => {
        const captured: Array<{ url: string; headers: Record<string, string> }> = [];
        const origFetch = globalThis.fetch;
        // Ensure no ambient base-URL override is in play for this assertion.
        const prevEnvBase = process.env.LORE_OPENAI_BASE_URL;
        delete process.env.LORE_OPENAI_BASE_URL;

        // Gate the openrouter stream so it stays suspended while openai runs.
        let releaseOpenrouter: () => void = () => {};
        const openrouterGate = new Promise<void>((r) => { releaseOpenrouter = r; });

        function sseBody(blockOnGate: boolean): ReadableStream<Uint8Array> {
            const enc = new TextEncoder();
            return new ReadableStream<Uint8Array>({
                async start(controller) {
                    // First token frame — pulling this suspends the consumer.
                    controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'));
                    if (blockOnGate) await openrouterGate;
                    controller.enqueue(enc.encode('data: [DONE]\n\n'));
                    controller.close();
                },
            });
        }

        // Fake fetch: record URL + headers, return a streaming SSE body.
        globalThis.fetch = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
            const url = String(input);
            captured.push({ url, headers: { ...(init?.headers ?? {}) } });
            const isOpenrouter = url.includes('openrouter.ai');
            return {
                ok: true,
                status: 200,
                body: sseBody(isOpenrouter),
            } as unknown as Response;
        }) as typeof globalThis.fetch;

        try {
            // 1) Start the openrouter stream and pull its first token → its fetch
            //    fires (hits openrouter.ai) and the generator suspends on the gate.
            const orGen = stream('openrouter', 'hello', 'or-key-SECRET', 'deepseek/deepseek-chat');
            const orFirst = await orGen.next();
            assert.equal(orFirst.value?.kind, 'token', 'openrouter stream yields a first token');

            // 2) While openrouter is suspended, run a full openai stream.
            const oaGen = stream('openai', 'hello', 'oa-key-SECRET', 'gpt-4o-mini');
            // openai body does not block on the gate → completes.
            for await (const _chunk of oaGen) { void _chunk; }

            // 3) Release + drain the openrouter stream.
            releaseOpenrouter();
            for await (const _chunk of orGen) { void _chunk; }

            const openrouterReq = captured.find((c) => c.url.includes('openrouter.ai'));
            const openaiReq = captured.find((c) => c.url.includes('api.openai.com'));
            assert.ok(openrouterReq, 'openrouter request went to openrouter.ai');
            assert.ok(openaiReq, 'openai request went to api.openai.com (NOT openrouter.ai)');

            // The openai request must NOT carry openrouter attribution headers
            // and must NOT have hit openrouter.ai.
            assert.ok(!openaiReq!.url.includes('openrouter.ai'), 'openai request must not be cross-wired to openrouter');
            assert.equal(openaiReq!.headers['HTTP-Referer'], undefined, 'no openrouter HTTP-Referer leaked onto openai request');
            assert.equal(openaiReq!.headers['X-Title'], undefined, 'no openrouter X-Title leaked onto openai request');
            // The openai request carried its OWN key, sent to the OpenAI endpoint.
            assert.equal(openaiReq!.headers['Authorization'], 'Bearer oa-key-SECRET');
        } finally {
            globalThis.fetch = origFetch;
            if (prevEnvBase === undefined) delete process.env.LORE_OPENAI_BASE_URL;
            else process.env.LORE_OPENAI_BASE_URL = prevEnvBase;
        }
    }),
];

(async () => {
    console.log('llm-capability-unit');
    for (const t of tests) await t();
    if (process.exitCode) {
        console.error('FAILED');
        process.exit(process.exitCode);
    }
    console.log('PASSED');
})();
