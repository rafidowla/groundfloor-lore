#!/usr/bin/env tsx
/**
 * tw6b-no-chat-no-ui-unit.ts — TW-6b acceptance guard.
 *
 * Owner decision (DECISIONS.md 2026-06-15): Lore Core is API + MCP only —
 * no UI, no served management dashboard, no LLM chat surface. A management
 * UI is a separate cloud application, built later.
 *
 * This test asserts the CHAT + SERVED-UI surfaces are GONE while the
 * data pipeline (ingestion / extraction / export API / recall / embeddings)
 * is INTACT.
 *
 * Removed (must NOT resolve):
 *   - packages/lore/src/mcp/http/routes/chat.ts        (/api/chat surface)
 *   - packages/lore/src/mcp/http/routes/chat/          (chat node-context helpers)
 *   - packages/lore/src/providers/localLlamaProvider.ts (embedded chat GGUF)
 *   - src/public/explore.html                          (served dashboard asset)
 *   - /explore route (no longer matched by tryStaticRoutes)
 *
 * Kept (must resolve + behave):
 *   - /api/export/html via tryStaticRoutes (data portability, not a UI)
 *   - extraction router + capability manifest (getCapability)
 *   - ingestion route family
 *   - recall + embeddings
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const srcDir = path.join(repoRoot, 'packages', 'lore', 'src');

// ── LORE_HOME must precede any dynamic import that loads workspaces.ts ──
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tw6b-'));
process.env['LORE_HOME'] = TEST_HOME;

let passed = 0;
let failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void> | void): void {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? (err as Error).message}`); failed++; }
    })());
}

console.log('TW-6b — no chat, no served UI; pipeline intact');

// ── 1. Chat + served-UI source artifacts are deleted ──────────────────
test('routes/chat.ts is removed', () => {
    assert.ok(!fs.existsSync(path.join(srcDir, 'mcp/http/routes/chat.ts')),
        'mcp/http/routes/chat.ts still exists');
});
test('routes/chat/ helper dir is removed', () => {
    assert.ok(!fs.existsSync(path.join(srcDir, 'mcp/http/routes/chat')),
        'mcp/http/routes/chat/ still exists');
});
test('providers/localLlamaProvider.ts is removed', () => {
    assert.ok(!fs.existsSync(path.join(srcDir, 'providers/localLlamaProvider.ts')),
        'providers/localLlamaProvider.ts still exists');
});
test('src/public/explore.html served dashboard asset is removed', () => {
    assert.ok(!fs.existsSync(path.join(repoRoot, 'src/public/explore.html')),
        'src/public/explore.html still exists');
});

// ── 2. Dispatcher no longer wires the chat family ─────────────────────
test('dispatcher.ts does not register tryChatRoutes / /api/chat', () => {
    const disp = fs.readFileSync(path.join(srcDir, 'mcp/http/dispatcher.ts'), 'utf8');
    assert.ok(!disp.includes('tryChatRoutes'), 'dispatcher still imports/calls tryChatRoutes');
});

// ── 3. Chat-only config knobs are gone ────────────────────────────────
test('chat-only config knobs (keepEmbeddedModelHot, autoExecuteChatActions) are removed', async () => {
    const { DEFAULT_CONFIG } = await import('../packages/lore/src/config/configManager.js');
    assert.ok(!('keepEmbeddedModelHot' in DEFAULT_CONFIG), 'keepEmbeddedModelHot still in DEFAULT_CONFIG');
    assert.ok(!('autoExecuteChatActions' in DEFAULT_CONFIG), 'autoExecuteChatActions still in DEFAULT_CONFIG');
});

// ── 4. /explore is no longer routed; /api/export/html still is ────────
function mkRes(): { res: ServerResponse; cap: { statusCode: number | null } } {
    const cap = { statusCode: null as number | null };
    const res = {
        writeHead(code: number) { cap.statusCode = code; return this; },
        end() { return this; },
    } as unknown as ServerResponse;
    return { res, cap };
}

test('tryStaticRoutes does NOT handle /explore (served dashboard gone)', async () => {
    const { tryStaticRoutes } = await import('../packages/lore/src/mcp/http/routes/static.js');
    const { res, cap } = mkRes();
    const req = { method: 'GET' } as IncomingMessage;
    // deps.store is never touched on the /explore path (route is gone), so a
    // minimal stub is safe — the matcher returns false before any store access.
    const handled = await tryStaticRoutes(req, res, '/explore', '/explore', { store: {} as never });
    assert.equal(handled, false, '/explore is still handled by tryStaticRoutes');
    assert.equal(cap.statusCode, null, '/explore wrote a response — it should be unhandled');
});

test('tryStaticRoutes still matches /api/export/html (data-export API kept)', async () => {
    const { tryStaticRoutes } = await import('../packages/lore/src/mcp/http/routes/static.js');
    const { res } = mkRes();
    const req = { method: 'GET' } as IncomingMessage;
    // Force the export to throw (no real graph) so we exercise the MATCH
    // without standing up substrates. A matched route returns true regardless
    // of success/failure; an unmatched route returns false.
    const handled = await tryStaticRoutes(
        req, res, '/api/export/html', '/api/export/html',
        { store: { loreGraph: {} } as never },
    );
    assert.equal(handled, true, '/api/export/html is no longer matched');
});

// ── 5. Pipeline modules still resolve (no collateral damage) ──────────
test('extraction router + capability manifest still resolve', async () => {
    const router = await import('../packages/lore/src/providers/extractRouter.js');
    assert.equal(typeof router.decide, 'function', 'extractRouter.decide missing');
    const dispatch = await import('../packages/lore/src/providers/llmDispatch.js');
    assert.equal(typeof dispatch.getCapability, 'function', 'llmDispatch.getCapability missing');
    assert.equal(typeof dispatch.invokeOllamaText, 'function', 'llmDispatch.invokeOllamaText missing');
    assert.equal(typeof dispatch.invokeOllamaVision, 'function', 'llmDispatch.invokeOllamaVision missing');
});

test('ingestion route family still resolves', async () => {
    const ingestion = await import('../packages/lore/src/mcp/http/routes/ingestion.js');
    assert.ok(ingestion, 'ingestion routes module failed to load');
});

test('recall engine still resolves', async () => {
    const recall = await import('../packages/lore/src/engines/reconnect.js');
    assert.equal(typeof recall.reconnectOneNode, 'function', 'reconnect engine missing');
});

// ── summary ────────────────────────────────────────────────────────────
await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
