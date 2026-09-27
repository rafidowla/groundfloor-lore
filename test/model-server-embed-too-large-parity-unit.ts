#!/usr/bin/env tsx
/**
 * model-server-embed-too-large-parity-unit.ts — Lore 3.24 review slice D3,
 * SF11 parity rule (D9 §5.5.3 decision), `too_large` half: for any input
 * the in-process provider accepts, shared mode must return an IDENTICAL
 * result — in particular, a document over the shared server's
 * `LORE_MODEL_SERVER_TEXT_CHAR_LIMIT` (default 200,000 chars) must not
 * fail in shared mode, because it does not fail in-process (in-process has
 * no hard char limit — only the model's own ~512-token truncation, see
 * `localEmbeddingProvider.ts`).
 *
 * `SharedEmbeddingProvider` handles this by catching the server's
 * `ModelServerError('too_large', ...)` and computing that ONE call
 * in-process via its lazily-created local fallback, without flipping
 * `modelStatus()` out of `shared` (this is a per-call accommodation, not a
 * degradation) and logging the fallback at `info` for operator visibility.
 *
 * Drives a REAL spawned server (via `ModelServerClient`, same pattern as
 * `model-server-client-lifecycle-unit.ts`) rather than mocking the
 * protocol — the whole point is proving the actual char-limit
 * enforcement in `connection.ts` round-trips correctly.
 *
 * `LORE_MODEL_SERVER_TEXT_CHAR_LIMIT` is deliberately set LOW (not left at
 * its 200,000-char default) and forwarded to the spawned server child via
 * `SERVER_ENV_ALLOWLIST` (confirmed to include it in paths.ts). A document
 * genuinely over the default 200k limit was tried first and found to hit a
 * pre-existing, apparently super-linear cost in `LocalEmbeddingProvider`'s
 * long-document chunking path (`splitTextIntoChunks` in
 * localEmbeddingProvider.ts, which this test's fixture does not own and
 * this slice must not edit) — 20k chars embedded in-process in ~4s, 50k in
 * ~30s, 100k in ~115s, and 150k did not finish within a 120s budget. That
 * looks like a real scalability defect, reported separately (see this
 * slice's final report) rather than worked around by shrinking the parity
 * check's intent. Lowering the SERVER's limit instead exercises the exact
 * same too_large/parity-fallback code path with a fixture small enough
 * (~6,000 chars) to embed in-process in about a second.
 *
 * Run: npx tsx test/model-server-embed-too-large-parity-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { ModelServerClient } from '../packages/lore/src/modelServer/client.js';
import { SharedEmbeddingProvider } from '../packages/lore/src/modelServer/sharedEmbeddingProvider.js';
import { serverKey, pidPath } from '../packages/lore/src/modelServer/paths.js';
import { LocalEmbeddingProvider, DEFAULT_LOCAL_MODEL_ID, DEFAULT_LOCAL_MODEL_DIM } from '../packages/lore/src/providers/localEmbeddingProvider.js';

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
};

function mkLoreHome(tag: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), `lore-ms-too-large-${tag}-`));
}

function readServerPid(loreHome: string): number | null {
    const key = serverKey(loreHome);
    const p = pidPath(loreHome, key);
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf8').trim();
    return raw ? parseInt(raw, 10) : null;
}

function isAlive(pid: number): boolean {
    const res = spawnSync('ps', ['-p', String(pid)]);
    return res.status === 0 && res.stdout.toString().includes(String(pid));
}

const spawnedPids = new Set<number>();
function trackHome(loreHome: string): void {
    const pid = readServerPid(loreHome);
    if (pid !== null) spawnedPids.add(pid);
}
function cleanupAllTrackedPids(): void {
    for (const pid of spawnedPids) {
        if (isAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
    }
}

console.log('model-server embed too_large parity (SF11) — a >200k-char document embeds identically in shared vs in-process\n');

const GENEROUS = { readyMs: 25_000, restartBudgetMs: 20_000, maxRestarts: 5, callMs: 30_000, probeMs: 1000 };

const savedCharLimit = process.env.LORE_MODEL_SERVER_TEXT_CHAR_LIMIT;
const TEST_CHAR_LIMIT = 5_000;
process.env.LORE_MODEL_SERVER_TEXT_CHAR_LIMIT = String(TEST_CHAR_LIMIT); // forwarded to the spawned server child via SERVER_ENV_ALLOWLIST

// Comfortably over the lowered limit, but small enough that in-process
// chunking (see the file doc comment above) still completes in about a
// second rather than minutes.
const bigText = 'lore review slice d3 parity fixture sentence. '.repeat(125); // ~6,000 chars

await test('a document over the shared char limit embeds identically in shared vs in-process, without a status change', async () => {
    const home = mkLoreHome('main');
    assert.ok(bigText.length > TEST_CHAR_LIMIT, `fixture text must exceed the ${TEST_CHAR_LIMIT} char limit (got ${bigText.length})`);

    const inProc = new LocalEmbeddingProvider({ modelId: DEFAULT_LOCAL_MODEL_ID, dimension: DEFAULT_LOCAL_MODEL_DIM });
    const expected = await inProc.embedDocument(bigText);

    const infoLogs: Array<{ msg: string; ctx?: Record<string, unknown> }> = [];
    const client = new ModelServerClient({ loreHome: home, clientId: 'sf11-too-large', ...GENEROUS });
    const shared = new SharedEmbeddingProvider({
        modelId: DEFAULT_LOCAL_MODEL_ID,
        dimension: DEFAULT_LOCAL_MODEL_DIM,
        client,
        log: { info: (msg, ctx) => infoLogs.push({ msg, ctx }) },
    });
    try {
        const actual = await shared.embedDocument(bigText);
        assert.deepEqual(actual, expected, 'shared-mode too_large fallback must be bit-identical to the in-process result');

        // Parity fallback is a per-call accommodation, not a degradation:
        // the client must still report shared mode, never fallback.
        assert.equal(client.status().mode, 'shared', 'a too_large parity fallback must not change modelStatus() out of shared');

        const logged = infoLogs.find((l) => l.msg.includes('falling back in-process for this one call'));
        assert.ok(logged, `expected an info log for the too_large parity fallback; got: ${JSON.stringify(infoLogs)}`);
        assert.equal(logged!.ctx?.code, 'too_large');
        assert.equal(logged!.ctx?.modelId, DEFAULT_LOCAL_MODEL_ID);

        trackHome(home);
    } finally {
        await client.dispose();
        fs.rmSync(home, { recursive: true, force: true });
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
cleanupAllTrackedPids();
if (savedCharLimit === undefined) delete process.env.LORE_MODEL_SERVER_TEXT_CHAR_LIMIT; else process.env.LORE_MODEL_SERVER_TEXT_CHAR_LIMIT = savedCharLimit;
if (failed > 0) process.exit(1);
