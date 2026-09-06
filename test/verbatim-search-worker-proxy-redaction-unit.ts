#!/usr/bin/env tsx
/**
 * test/verbatim-search-worker-proxy-redaction-unit.ts — regression test for the
 * v3.17.0 parent-embeds secret-redaction bypass.
 *
 * Pre-v3.17.0, store()/storeBatch() forwarded generically through the child
 * process's own VerbatimStore.storeBatch, which redacts secrets via
 * redactSecrets() before embed/persist (verbatimStore.ts:731, :881). v3.17.0
 * added a `parentEmbedder` fast path to VerbatimSearchWorkerProxy.storeBatch
 * that embeds row.text locally IN THE PARENT and sent pre-built rows straight
 * to the child's `bulkUpsertPrebuiltRows` — a low-level LanceDB primitive with
 * no redaction logic of its own. Net effect (pre-fix): a note containing a
 * secret got embedded UNREDACTED (sent raw to the embedding provider, which
 * under openai-compat can be a third-party HTTP endpoint) and PERSISTED
 * unredacted, so a later recall() returned the plaintext secret.
 *
 * The parent still redacts, and must: that is what keeps the raw secret away
 * from the embedding provider, which no child-side redaction can undo once the
 * text has left the process.
 *
 * ROUTE CHANGE (fix/verbatim-worker-nested-metadata): the parent-embeds path no
 * longer calls `bulkUpsertPrebuiltRows` — that sink rejected every document
 * with non-empty metadata ("Found field not in schema: metadata.type") and
 * skipped the store's history/skip-identical logic. It now sends the document,
 * vector attached, to the child's own `store`/`storeBatch`. Redaction is
 * unchanged and still belongs to the parent; only the method name moved. The
 * child re-runs redactSecrets, which is a no-op on already-redacted text, so
 * the text and the vector shipped with it cannot come apart.
 *
 * This test stubs out the proxy's private IPC `call()` (a TS-private, not
 * JS-private, instance method — same runtime-accessible-internals pattern as
 * test/worker-embed-overrides-unit.ts) so it never forks a real child process;
 * it only needs to observe (1) what text reaches the embedder and (2) what
 * documents reach the child (via `call`).
 *
 * Run: npx tsx test/verbatim-search-worker-proxy-redaction-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { VerbatimSearchWorkerProxy } from '../packages/lore/src/engines/verbatimSearchWorkerProxy.js';
import { redactSecrets } from '../packages/lore/src/security/secretScan.js';
import type { EmbeddingProvider, VerbatimDocument } from '../packages/lore/src/providers/types.js';

/** Records every text batch handed to embedDocumentBatch; returns a fixed
 *  vector per input so callers can check vectors landed on the right row. */
class RecordingEmbedder implements EmbeddingProvider {
    readonly dimension = 4;
    readonly modelId = 'recording-embedder-stub';
    documentBatchCalls: string[][] = [];
    async initialize(): Promise<void> {}
    async embed(text: string): Promise<number[]> { return [1, 2, 3, 4]; }
    async embedQuery(text: string): Promise<number[]> { return [1, 2, 3, 4]; }
    async embedDocument(text: string): Promise<number[]> { return [1, 2, 3, 4]; }
    async embedDocumentBatch(texts: string[]): Promise<number[][]> {
        this.documentBatchCalls.push(texts);
        return texts.map((_, i) => [i, i, i, i]);
    }
}

type CapturedCall = { method: string; args: unknown[] };

/** Shape of a document handed to the child's store/storeBatch via `call` —
 *  named once so every assertion site below shares one documented shape. */
type SentDocument = { id: string; text: string; vector?: number[] };

/** Proxy-internal `call` (TS-private, not JS-private — accessible at
 *  runtime) — named once here per the ProxyInternals convention in
 *  test/worker-embed-overrides-unit.ts, so the assumed shape is stated in
 *  exactly one place instead of an inline cast at the access site. */
type ProxyCallInternals = { call: (method: string, args: unknown[]) => Promise<unknown> };

/** Shadows the proxy's private `call` (IPC to the child) with an in-memory
 *  recorder — same instance-property-shadowing trick the proxy's own
 *  constructor uses for FORWARDED_METHODS. Avoids forking a real child
 *  process; this test only cares what storeBatch hands to `call`. */
function stubCall(proxy: VerbatimSearchWorkerProxy): CapturedCall[] {
    const calls: CapturedCall[] = [];
    const internals = proxy as unknown as ProxyCallInternals; // documented shape — see ProxyCallInternals
    internals.call = async (method: string, args: unknown[]) => {
        calls.push({ method, args });
        return undefined;
    };
    return calls;
}

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
        await fn();
        passed++;
        console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    } catch (err) {
        failed++;
        console.log(`  \x1b[31m✗ ${name}\x1b[0m`);
        console.log(`    ${(err as Error).stack ?? (err as Error).message}`);
    }
}

async function main() {
    console.log('verbatim-search-worker-proxy-redaction: parentEmbedder storeBatch redacts secrets before embed/persist');

    const secretText = 'my api key is sk-abcdefghijklmnopqrstuvwxyz1234567890 -- keep it safe';
    const plainText = 'an ordinary note about grocery shopping';
    const redactedSecretText = redactSecrets(secretText);
    assert.notEqual(redactedSecretText, secretText, 'sanity: redactSecrets actually rewrites the sk- shaped secret');
    assert.ok(!redactedSecretText.includes('sk-abcdefghijklmnopqrstuvwxyz1234567890'), 'sanity: the raw key is gone from the expected redacted text');

    // ── (a)+(b): parentEmbedder branch — secret row redacted, plain row untouched, in the same batch ──
    const homeA = fs.mkdtempSync(path.join(os.tmpdir(), 'verbatim-proxy-redaction-a-'));
    try {
        const embedder = new RecordingEmbedder();
        const proxy = new VerbatimSearchWorkerProxy(homeA, undefined, embedder);
        const calls = stubCall(proxy);

        await test('storeBatch with parentEmbedder sends REDACTED text to embedDocumentBatch, never the raw secret', async () => {
            await proxy.storeBatch([
                { id: 'lore:secret', text: secretText, metadata: {} },
                { id: 'lore:plain', text: plainText, metadata: {} },
            ] as VerbatimDocument[]);
            assert.equal(embedder.documentBatchCalls.length, 1, 'storeBatch embeds the whole batch in one call');
            assert.deepEqual(
                embedder.documentBatchCalls[0],
                [redactedSecretText, plainText],
                'embedder receives the redacted secret text and the plain text unchanged, in row order',
            );
        });

        await test('storeBatch sends REDACTED text to the child, never the raw secret', async () => {
            assert.equal(calls.length, 1, 'exactly one call reaches the child');
            assert.equal(calls[0].method, 'storeBatch', "parentEmbedder path calls the child's own storeBatch, not a prebuilt-row sink");
            const sent = calls[0].args[0] as SentDocument[];
            assert.equal(sent.length, 2);
            const secretRow = sent.find((r) => r.id === 'lore:secret')!;
            const plainRow = sent.find((r) => r.id === 'lore:plain')!;
            assert.equal(secretRow.text, redactedSecretText, 'persisted secret row is redacted');
            assert.ok(!secretRow.text.includes('sk-abcdefghijklmnopqrstuvwxyz1234567890'), 'no raw secret reaches the LanceDB row');
            assert.ok(Array.isArray(secretRow.vector) && secretRow.vector.length === 4, 'secret row still got a real embedded vector');
            assert.equal(plainRow.text, plainText, 'plain row (no secret) is content-preserving — unchanged by redaction');
            assert.ok(Array.isArray(plainRow.vector) && plainRow.vector.length === 4, 'plain row still got a real embedded vector');
        });
    } finally {
        fs.rmSync(homeA, { recursive: true, force: true });
    }

    // ── Edge case: a row that already carries a vector (skips local embedding)
    // must still have its persisted text redacted — it is embedded nowhere,
    // but it IS persisted, through the very same call to the child. ──
    const homeB = fs.mkdtempSync(path.join(os.tmpdir(), 'verbatim-proxy-redaction-b-'));
    try {
        const embedder = new RecordingEmbedder();
        const proxy = new VerbatimSearchWorkerProxy(homeB, undefined, embedder);
        const calls = stubCall(proxy);

        await test('a row with a pre-supplied vector (skips local embedding) is still redacted before persisting', async () => {
            await proxy.storeBatch([
                { id: 'lore:prevectored-secret', text: secretText, metadata: {}, vector: [9, 9, 9, 9] },
            ] as unknown as VerbatimDocument[]);
            assert.equal(embedder.documentBatchCalls.length, 0, 'a row with vector already set never reaches embedDocumentBatch');
            assert.equal(calls.length, 1);
            const sent = calls[0].args[0] as SentDocument[];
            assert.equal(sent[0].text, redactedSecretText, 'persisted text is redacted even though this row skipped embedding');
            assert.deepEqual(sent[0].vector, [9, 9, 9, 9], 'the pre-supplied vector passes through untouched');
        });
    } finally {
        fs.rmSync(homeB, { recursive: true, force: true });
    }

    // ── store() has its OWN route now (it used to delegate to storeBatch), so
    // redaction on the single-write path needs its own case. ──
    const homeS = fs.mkdtempSync(path.join(os.tmpdir(), 'verbatim-proxy-redaction-s-'));
    try {
        const embedder = new RecordingEmbedder();
        const proxy = new VerbatimSearchWorkerProxy(homeS, undefined, embedder);
        const calls = stubCall(proxy);

        await test('store() with parentEmbedder redacts before embed and sends the redacted text on', async () => {
            await proxy.store({ id: 'lore:single-secret', text: secretText, metadata: {} } as VerbatimDocument);
            assert.deepEqual(embedder.documentBatchCalls[0], [redactedSecretText], 'the embedder never sees the raw secret');
            assert.equal(calls.length, 1);
            assert.equal(calls[0].method, 'store', "store() routes to the child's own store, not storeBatch");
            const sent = calls[0].args[0] as SentDocument;
            assert.equal(sent.text, redactedSecretText, 'the document sent to the child is redacted');
            assert.ok(Array.isArray(sent.vector) && sent.vector.length === 4, 'and carries its parent-computed vector');
        });
    } finally {
        fs.rmSync(homeS, { recursive: true, force: true });
    }

    // ── (c): no parentEmbedder — this change must not touch that path at all ──
    const homeC = fs.mkdtempSync(path.join(os.tmpdir(), 'verbatim-proxy-redaction-c-'));
    try {
        const proxy = new VerbatimSearchWorkerProxy(homeC);
        const calls = stubCall(proxy);
        const rows = [{ id: 'lore:secret', text: secretText, metadata: {} }] as VerbatimDocument[];

        await test('without a parentEmbedder, storeBatch forwards rows as-is (unmodified) to the child\'s own storeBatch', async () => {
            await proxy.storeBatch(rows);
            assert.equal(calls.length, 1);
            assert.equal(calls[0].method, 'storeBatch', 'no-parentEmbedder path forwards generically to the child\'s storeBatch');
            assert.deepEqual(calls[0].args, [rows], 'rows are forwarded unmodified — the child\'s own VerbatimStore.storeBatch does the redaction on that path');
        });
    } finally {
        fs.rmSync(homeC, { recursive: true, force: true });
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST HARNESS FAILED:', e); process.exit(2); });
