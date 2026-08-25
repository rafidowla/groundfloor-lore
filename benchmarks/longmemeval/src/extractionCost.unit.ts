#!/usr/bin/env tsx
/**
 * extractCountableFacts.unit.ts — estimateExtractionCost's per-model pricing.
 * Pure function, zero API calls. This number directly gates a real spending
 * decision, so it gets a real test — a silently wrong price here would
 * misinform whether to actually run the extraction pass.
 */

import assert from 'node:assert/strict';
import { estimateExtractionCost } from './extractionCost.js';

let passed = 0, failed = 0;
function test(name: string, fn: () => void): void {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

console.log('estimateExtractionCost');

test('defaults to gpt-4o-mini pricing when no model is given', () => {
    const c = estimateExtractionCost(1000);
    assert.equal(c.model, 'gpt-4o-mini');
    assert.equal(c.priceKnown, true);
    // 1000 sessions * 1500 in / 100 out tokens = 1.5M in, 0.1M out
    // 1.5 * 0.15 + 0.1 * 0.60 = 0.285, which floating-point rounds to 0.28
    assert.equal(c.usd, 0.28);
});

test('deepseek/deepseek-v4-flash-0731 uses its own, cheaper real pricing — not gpt-4o-mini\'s', () => {
    const c = estimateExtractionCost(1000, 'deepseek/deepseek-v4-flash-0731');
    assert.equal(c.priceKnown, true);
    // 1.5M in * 0.14 + 0.1M out * 0.28 = 0.21 + 0.028 = 0.238 -> 0.24
    assert.equal(c.usd, 0.24);
    const mini = estimateExtractionCost(1000, 'gpt-4o-mini');
    assert.ok(c.usd < mini.usd, 'deepseek should be cheaper than gpt-4o-mini at this token mix');
});

test('openai/gpt-5-mini uses its own real pricing (keyed on the exact --model string, not the bare id)', () => {
    const c = estimateExtractionCost(1000, 'openai/gpt-5-mini');
    assert.equal(c.priceKnown, true);
    // 1.5M in * 0.25 + 0.1M out * 2.0 = 0.375 + 0.2 = 0.575 -> 0.57 or 0.58 (float rounding)
    assert.ok(Math.abs(c.usd - 0.575) < 0.01);
});

test('an unrecognized model falls back to gpt-4o-mini pricing AND flags priceKnown=false', () => {
    const c = estimateExtractionCost(1000, 'some/unlisted-model');
    assert.equal(c.priceKnown, false);
    assert.equal(c.model, 'some/unlisted-model', 'reports the model actually requested, not the fallback');
    assert.equal(c.usd, estimateExtractionCost(1000, 'gpt-4o-mini').usd, 'falls back to gpt-4o-mini\'s price as the stand-in');
});

test('cost scales linearly with session count', () => {
    // Large enough session counts that the 2-decimal-place rounding on `usd`
    // is small relative to the totals being compared (at e.g. 100 vs 200
    // sessions the rounding noise itself can approach $0.01, which isn't a
    // real scaling defect — token counts, asserted below, are exact either way).
    const c1 = estimateExtractionCost(10_000, 'deepseek/deepseek-v4-flash-0731');
    const c2 = estimateExtractionCost(20_000, 'deepseek/deepseek-v4-flash-0731');
    assert.ok(Math.abs(c2.usd - c1.usd * 2) < 0.01);
    assert.equal(c2.inputTokens, c1.inputTokens * 2);
    assert.equal(c2.outputTokens, c1.outputTokens * 2);
});

test('zero sessions costs zero', () => {
    const c = estimateExtractionCost(0, 'deepseek/deepseek-v4-flash-0731');
    assert.equal(c.usd, 0);
    assert.equal(c.inputTokens, 0);
    assert.equal(c.outputTokens, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
