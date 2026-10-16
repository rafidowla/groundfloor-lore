#!/usr/bin/env tsx
/**
 * `lore storage` categorises `.lore/verbatim.sqlite` (+ wal/shm) as embeddings, not tabular (3.35.0).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectDataHome } from '../packages/lore/src/engines/storageInspector.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-label-'));
try {
    const dir = path.join(home, '.lore');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'verbatim.sqlite'), Buffer.alloc(4096));
    fs.writeFileSync(path.join(dir, 'verbatim.sqlite-wal'), Buffer.alloc(1024));
    fs.writeFileSync(path.join(dir, 'verbatim.sqlite-shm'), Buffer.alloc(512));
    fs.writeFileSync(path.join(dir, 'collections.sqlite'), Buffer.alloc(2048));

    const b = inspectDataHome(home);
    assert.equal(b.embeddingsBytes, 4096 + 1024 + 512, 'verbatim.sqlite and its sidecars are the vector store');
    assert.equal(b.tabularBytes, 2048, 'other .sqlite files stay tabular');
    console.log('  ok   verbatim.sqlite is embeddings, collections.sqlite stays tabular');
    console.log('\n1 passed, 0 failed');
} catch (e) {
    console.error(`  FAIL ${(e as Error).message}`);
    process.exit(1);
} finally {
    fs.rmSync(home, { recursive: true, force: true });
}
