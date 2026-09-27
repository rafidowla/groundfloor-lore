#!/usr/bin/env tsx
/**
 * search-worker-home-isolation-unit.ts — a search worker forked from a test
 * process must resolve the parent's (temp) Lore home, not the real
 * `~/.groundfloor`.
 *
 * `resolveLoreHome()` / `isTestProcess()` key on `process.argv[1]`, and the
 * forked child's entry is `verbatimSearchWorkerEntry`, not a `test/` file.
 * Before the fix, a no-parentEmbedder worker forked by a test copied the
 * embedding model into `~/.groundfloor/models` and spawned / connected to a
 * shared model server under `~/.groundfloor/run` — from inside `npm test`.
 *
 * Checks:
 *   1. inheritedHomeEnv() pins LORE_HOME to the parent's resolution and
 *      mirrors the test-process model-server gate (LORE_MODEL_SERVER=0);
 *      explicit caller settings win.
 *   2. End to end: with LORE_HOME unset, a real forked worker's embedding
 *      model cache lands under the parent's resolved temp home.
 *
 * Run: npx tsx test/search-worker-home-isolation-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { resolveLoreHome } from '../packages/lore/src/config/loreHome.js';
import { inheritedHomeEnv, VerbatimSearchWorkerProxy } from '../packages/lore/src/engines/verbatimSearchWorkerProxy.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { failed++; console.log(`  ✗ ${name}\n    ${(err as Error).stack ?? (err as Error).message}`); }
}

const realDefault = path.join(os.homedir(), '.groundfloor');

async function main(): Promise<void> {
    console.log('search worker — inherits the parent test process\'s Lore home\n');
    delete process.env.LORE_HOME;
    delete process.env.LORE_MODEL_SERVER;
    process.env.LORE_SEARCH_WORKER_READY_MS ??= '90000';
    const parentHome = resolveLoreHome();

    await test('parent test process resolves an isolated temp home', () => {
        assert.ok(parentHome.startsWith(os.tmpdir()), parentHome);
        assert.notEqual(parentHome, realDefault);
    });

    await test('inheritedHomeEnv: unset LORE_HOME -> parent home; test process -> LORE_MODEL_SERVER=0', () => {
        assert.deepEqual(inheritedHomeEnv({}), { LORE_HOME: parentHome, LORE_MODEL_SERVER: '0' });
    });

    await test('inheritedHomeEnv: explicit LORE_HOME / LORE_MODEL_SERVER are left alone', () => {
        assert.deepEqual(inheritedHomeEnv({ LORE_HOME: '/x', LORE_MODEL_SERVER: '1' }), {});
    });

    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-home-iso-'));
    const proxy = new VerbatimSearchWorkerProxy(path.join(base, 'store'));
    try {
        await proxy.initialize();
        await test('forked worker (no parentEmbedder) caches its model under the parent\'s temp home', async () => {
            await proxy.storeBatch([
                { id: 'lore:home-iso-1', text: 'search worker home isolation document', metadata: {} },
            ] as never[]);
            assert.equal(await proxy.count(), 1);
            const models = path.join(parentHome, 'models');
            assert.ok(fs.existsSync(models), `expected the child's model cache at ${models}`);
        });
    } finally {
        await proxy.close();
        fs.rmSync(base, { recursive: true, force: true });
        fs.rmSync(parentHome, { recursive: true, force: true });
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST HARNESS FAILED:', e); process.exit(2); });
