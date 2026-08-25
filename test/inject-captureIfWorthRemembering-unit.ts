#!/usr/bin/env tsx
/**
 * inject-captureIfWorthRemembering-unit.ts — tests the INBOUND half of the
 * context-injection helper (packages/lore/src/inject/) with a STUBBED `llm`
 * callable — deterministic, no real API calls, no network.
 *
 * Still a real `createLore({ deploymentMode: 'embedded' })` instance for the
 * write/read side (proving the node is genuinely written and retrievable),
 * but the judgment side is fully deterministic via the stub.
 *
 * Proves:
 *   (a) when the stub says "worth keeping", a node is actually written and
 *       retrievable afterward.
 *   (b) when the stub says "not worth keeping", nothing gets written.
 *   (c) the returned node's `type` respects a caller-supplied `defaultType`
 *       override.
 *   Plus: a malformed LLM response is handled without throwing.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); console.log(`  ok   ${name}`); passed++; }
    catch (e) { console.error(`  FAIL ${name}\n       ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-inject-inbound-'));
fs.mkdirSync(path.join(home, '.lore'), { recursive: true });
fs.writeFileSync(
    path.join(home, 'workspaces.json'),
    JSON.stringify(
        { active: 'default', workspaces: [{ name: 'default', path: home, createdAt: '2026-06-15T00:00:00.000Z' }] },
        null,
        2,
    ),
);
delete process.env['LORE_HOME'];
delete process.env['LORE_GRAPH_PATH'];
process.env['LORE_HOME'] = home;

console.log('captureIfWorthRemembering() — stubbed llm, real writes');

const { createLore } = await import('../packages/lore/src/index.js');
const { captureIfWorthRemembering } = await import('../packages/lore/src/inject/index.js');

const lore = await createLore({ deploymentMode: 'embedded', dataDir: home });

/** Deterministic stub — never calls a real provider. */
function stubLlm(response: Record<string, unknown>): (prompt: string) => Promise<string> {
    return async () => JSON.stringify(response);
}

try {
    // ── (a) worth keeping → a node is actually written and retrievable ──
    await check('(a) worth_keeping=true writes a node, retrievable afterward', async () => {
        const result = await captureIfWorthRemembering(
            lore,
            { input: 'What did we decide about the cache TTL?', output: 'We agreed on a 15 minute TTL for the read cache.' },
            {
                llm: stubLlm({
                    worth_keeping: true,
                    type: 'decision',
                    label: 'Read cache TTL',
                    content: 'The team agreed on a 15 minute TTL for the read cache.',
                    reason: 'durable technical decision',
                }),
                workspace: 'default',
            },
        );
        assert.equal(result.stored, true, `expected stored=true (got ${JSON.stringify(result)})`);
        assert.ok(result.nodeId, 'expected a nodeId on success');
        assert.equal(result.type, 'decision', 'expected the LLM-supplied type to be used');

        const node = await lore.store.storageClient.getNode(result.nodeId!);
        assert.ok(node, 'the written node must be retrievable via the storage-client facade');
        assert.equal(node!.label, 'Read cache TTL');
        assert.equal(node!.content, 'The team agreed on a 15 minute TTL for the read cache.');
        assert.equal(node!.type, 'decision');
    });

    // ── (b) not worth keeping → nothing gets written ──
    await check('(b) worth_keeping=false writes NOTHING', async () => {
        const before = await lore.store.storageClient.search('weather small talk', 50, 'default', '*');
        const result = await captureIfWorthRemembering(
            lore,
            { input: 'nice weather today', output: 'yes, sunny and warm' },
            {
                llm: stubLlm({ worth_keeping: false, reason: 'small talk, not durable' }),
                workspace: 'default',
            },
        );
        assert.equal(result.stored, false, `expected stored=false (got ${JSON.stringify(result)})`);
        assert.equal(result.nodeId, undefined, 'no nodeId when nothing was stored');
        assert.equal(result.reason, 'small talk, not durable', 'the llm\'s stated reason should surface');
        const after = await lore.store.storageClient.search('weather small talk', 50, 'default', '*');
        assert.equal(after.length, before.length, 'search result count must be unchanged — nothing was written');
    });

    // ── (c) defaultType override is respected when the LLM omits a type ──
    await check('(c) a caller-supplied defaultType is used when the LLM verdict omits `type`', async () => {
        const result = await captureIfWorthRemembering(
            lore,
            { input: 'I prefer dark mode in every app', output: 'Noted — dark mode preference recorded.' },
            {
                llm: stubLlm({
                    // Deliberately NO `type` field — proves the fallback wiring,
                    // not just that the stub happened to echo the override.
                    worth_keeping: true,
                    label: 'UI preference: dark mode',
                    content: 'The user prefers dark mode in every application.',
                }),
                workspace: 'default',
                defaultType: 'preference', // caller override — must NOT fall back to the module's internal 'note' default.
            },
        );
        assert.equal(result.stored, true, `expected stored=true (got ${JSON.stringify(result)})`);
        assert.equal(result.type, 'preference', 'the stored type must be the caller-supplied defaultType, not the built-in "note" default');

        const node = await lore.store.storageClient.getNode(result.nodeId!);
        assert.ok(node, 'node must be retrievable');
        assert.equal(node!.type, 'preference', 'the node persisted on disk must carry the overridden type');
    });

    // ── defaultType falls back to 'note' when the caller doesn't override it ──
    await check('the built-in default type is \'note\' when the caller passes no defaultType and the LLM omits one', async () => {
        const result = await captureIfWorthRemembering(
            lore,
            { input: 'Remember X', output: 'Ok, remembering X.' },
            {
                llm: stubLlm({ worth_keeping: true, label: 'X', content: 'X is a durable fact worth keeping.' }),
                workspace: 'default',
                // No defaultType supplied.
            },
        );
        assert.equal(result.stored, true);
        assert.equal(result.type, 'note', 'expected the built-in default type "note" with no override and no LLM-supplied type');
    });

    // ── malformed LLM response is handled without throwing ──
    await check('a malformed (non-JSON) llm response returns stored:false instead of throwing', async () => {
        const result = await captureIfWorthRemembering(
            lore,
            { input: 'anything', output: 'anything' },
            { llm: async () => 'not json at all, just prose', workspace: 'default' },
        );
        assert.equal(result.stored, false);
        assert.equal(result.reason, 'llm_response_unparseable');
    });

    // ── a JSON response wrapped in a markdown fence still parses ──
    await check('an llm response wrapped in a ```json fence still parses correctly', async () => {
        const fenced = '```json\n' + JSON.stringify({ worth_keeping: false, reason: 'fenced but still valid' }) + '\n```';
        const result = await captureIfWorthRemembering(
            lore,
            { input: 'anything', output: 'anything' },
            { llm: async () => fenced, workspace: 'default' },
        );
        assert.equal(result.stored, false);
        assert.equal(result.reason, 'fenced but still valid');
    });
} finally {
    await lore.dispose('test-teardown');
    fs.rmSync(home, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
