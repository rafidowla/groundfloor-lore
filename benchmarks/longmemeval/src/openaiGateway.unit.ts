#!/usr/bin/env tsx
/**
 * openaiGateway.unit.ts — resolveOpenAiGateway's model-prefix logic and
 * per-model reasoning-disable scoping. Zero network calls, deterministic.
 */

import assert from 'node:assert/strict';
import { resolveOpenAiGateway } from './openaiGateway.js';

let passed = 0, failed = 0;
function test(name: string, fn: () => void): void {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

console.log('resolveOpenAiGateway');

test('direct OpenAI key: bare model passed through unprefixed', () => {
    const gw = resolveOpenAiGateway('sk-realOpenAiKey123', 'gpt-4o-2024-08-06');
    assert.equal(gw.endpoint, 'https://api.openai.com/v1/chat/completions');
    assert.equal(gw.modelFor('gpt-4o-2024-08-06'), 'gpt-4o-2024-08-06');
});

test('OpenRouter key + bare OpenAI-shaped model → gets the openai/ prefix', () => {
    const gw = resolveOpenAiGateway('sk-or-v1-abc123', 'gpt-4o-2024-08-06');
    assert.equal(gw.endpoint, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(gw.modelFor('gpt-4o-2024-08-06'), 'openai/gpt-4o-2024-08-06');
    assert.equal(gw.modelFor('gpt-4o-mini'), 'openai/gpt-4o-mini');
});

test('OpenRouter key + already-qualified provider/model slug → passed through AS-IS, not double-prefixed', () => {
    const gw = resolveOpenAiGateway('sk-or-v1-abc123', 'deepseek/deepseek-v4-flash-0731');
    assert.equal(gw.modelFor('deepseek/deepseek-v4-flash-0731'), 'deepseek/deepseek-v4-flash-0731');
    assert.equal(gw.modelFor('anthropic/claude-3-5-haiku'), 'anthropic/claude-3-5-haiku');
});

test('direct OpenAI key + a slash in the model is still passed through unmodified (no OpenAI use case needs this, but must not corrupt it)', () => {
    const gw = resolveOpenAiGateway('sk-realOpenAiKey123', 'deepseek/deepseek-v4-flash-0731');
    assert.equal(gw.modelFor('deepseek/deepseek-v4-flash-0731'), 'deepseek/deepseek-v4-flash-0731');
});

test('deepseek/deepseek-v4-flash-0731 via OpenRouter gets reasoning force-disabled (its own known truncation problem)', () => {
    const gw = resolveOpenAiGateway('sk-or-v1-abc123', 'deepseek/deepseek-v4-flash-0731');
    assert.deepEqual(gw.extraBody, { reasoning: { enabled: false } });
});

test('gpt-5-mini via OpenRouter does NOT get reasoning touched — forcing it off would cripple the exact capability this model is being tested for', () => {
    const gw = resolveOpenAiGateway('sk-or-v1-abc123', 'openai/gpt-5-mini');
    assert.deepEqual(gw.extraBody, {});
});

test('gpt-4o via OpenRouter does NOT get reasoning touched either — the workaround is scoped to the one model proven to need it', () => {
    const gw = resolveOpenAiGateway('sk-or-v1-abc123', 'openai/gpt-4o-2024-08-06');
    assert.deepEqual(gw.extraBody, {});
});

test('direct OpenAI gateway has an empty extraBody regardless of model (no reasoning-control concept needed there)', () => {
    const gw = resolveOpenAiGateway('sk-realOpenAiKey123', 'deepseek/deepseek-v4-flash-0731');
    assert.deepEqual(gw.extraBody, {});
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
