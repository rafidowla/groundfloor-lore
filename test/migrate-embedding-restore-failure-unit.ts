#!/usr/bin/env tsx
/**
 * migrate-embedding-restore-failure-unit.ts - migrateEmbeddingModel restores preserved non-node verbatim rows
 * (the ONLY copy of store_verbatim content) after the table rebuild. A failed restore used to vanish in a bare
 * `catch {}`: the result looked like a clean migration. It must be counted (`nonNodeRowsFailed`) and logged with the error class.
 *
 * Run: npx tsx test/migrate-embedding-restore-failure-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import { migrateEmbeddingModel } from '../packages/lore/src/engines/migrateEmbeddingModel.js';

process.env.LORE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-restore-home-'));
process.env.LORE_MODEL_SERVER = '0';

const POISON = 'POISON-ROW-THE-TARGET-MODEL-CANNOT-EMBED';
function provider(modelId: string, failOnPoison: boolean) {
    const dimension = 8;
    const vec = (t: string): number[] => {
        if (failOnPoison && t.includes(POISON)) throw new Error('target embedder rejected this row');
        return new Array(dimension).fill(0).map((_, i) => (t.length + i) % 7);
    };
    return { modelId, dimension, async initialize() { /* no-op */ }, async embed(t: string) { return vec(t); }, async embedQuery(t: string) { return vec(t); }, async embedDocument(t: string) { return vec(t); }, async embedDocumentBatch(ts: string[]) { return ts.map(vec); } };
}
const meta = { type: 'note', label: 'm', tags: '', project: 'w', ecosystem: '*', updatedAt: new Date().toISOString(), security_scopes: [] as string[] };

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-restore-'));
fs.mkdirSync(path.join(base, '.lore'), { recursive: true });
const graph = new SurrealGraph(base, { workspaceId: 'w' });
let failed = 0;
try {
    await graph.initialize();
    const seed = new VerbatimStore(base, provider('old-model', false) as never);
    await seed.initialize();
    await seed.store({ id: 'gmail:ok', text: 'a restorable email', metadata: meta });
    await seed.store({ id: 'gmail:bad', text: `${POISON} only copy`, metadata: meta });
    await seed.close();

    const result = await migrateEmbeddingModel(base, graph as never, { targetModelId: 'new-model', targetDimension: 8, targetProvider: provider('new-model', true) as never });

    try {
        assert.equal(result.nonNodeRowsPreserved, 1, 'the restorable row is preserved');
        assert.equal(result.nonNodeRowsFailed, 1, 'the row that could not be restored must be COUNTED, not silently dropped');
        console.log('  ok  a failed restore of a preserved non-node row is counted (and logged)');
        console.log('\n1 passed, 0 failed');
    } catch (e) { failed++; console.error(`  FAIL ${(e as Error).message}`); console.log('\n0 passed, 1 failed'); }
} finally {
    await graph.close().catch(() => undefined);
    try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* best effort */ }
}
process.exit(failed ? 1 : 0);
