#!/usr/bin/env tsx
/**
 * test/link-model-policy-unit.ts - link thresholds are keyed by embedding-model fingerprint.
 *
 *   resolver   e5-small (any dtype) => 0.80/5 calibrated; an unknown model => the same numbers, flagged
 *              uncalibrated and logged ONCE per fingerprint
 *   config     env vars override the model policy; policy version defaults to p0-2; no fingerprint => defaults
 *   edges      links written through createLore carry policy_version p0-2 and the provider's fingerprint
 *
 *   LORE_HOME=<scratch> LORE_MODEL_SERVER=0 npx tsx test/link-model-policy-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';
import { DEFAULT_LOCAL_MODEL_ID, embeddingProviderFingerprint } from '../packages/lore/src/providers/localEmbeddingProvider.js';
import { MODEL_LINK_POLICIES, UNCALIBRATED_LINK_POLICY, resetUncalibratedWarnings, resolveModelLinkPolicy } from '../packages/lore/src/link/linkModelPolicy.js';
import { LINK_DEFAULTS, loadLinkConfig } from '../packages/lore/src/link/linkConfig.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); console.log(`  ok  ${name}`); passed++; }
    catch (e) { console.error(`  FAIL ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

await test('e5-small is calibrated at 0.80 / k 5, with or without a dtype suffix', () => {
    for (const fp of [DEFAULT_LOCAL_MODEL_ID, `${DEFAULT_LOCAL_MODEL_ID}@q8`, `${DEFAULT_LOCAL_MODEL_ID}@fp32`]) {
        const p = resolveModelLinkPolicy(fp, () => assert.fail('calibrated model must not log'));
        assert.deepEqual([p.minSim, p.k, p.calibrated], [0.8, 5, true], fp);
    }
    assert.deepEqual(MODEL_LINK_POLICIES[DEFAULT_LOCAL_MODEL_ID], { minSim: 0.8, k: 5 });
});

await test('an unknown model gets 0.80 / 5, flagged uncalibrated, and logs once per fingerprint', () => {
    resetUncalibratedWarnings();
    const logs: string[] = [];
    const a = resolveModelLinkPolicy('acme/other-model@fp16', (m) => logs.push(m));
    resolveModelLinkPolicy('acme/other-model@fp16', (m) => logs.push(m));
    assert.deepEqual([a.minSim, a.k, a.calibrated], [UNCALIBRATED_LINK_POLICY.minSim, UNCALIBRATED_LINK_POLICY.k, false]);
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /acme\/other-model@fp16/);
    resolveModelLinkPolicy('acme/other-model@q8', (m) => logs.push(m));
    resolveModelLinkPolicy(null, (m) => logs.push(m));
    assert.equal(logs.length, 3, 'a different fingerprint (and an unknown one) logs again, once each');
});

await test('loadLinkConfig: model policy, env override, default policy version p0-2', () => {
    resetUncalibratedWarnings();
    assert.equal(LINK_DEFAULTS.policyVersion, 'p0-2');
    const base = loadLinkConfig({} as NodeJS.ProcessEnv, DEFAULT_LOCAL_MODEL_ID);
    assert.deepEqual([base.minSim, base.k, base.policyVersion], [0.8, 5, 'p0-2']);
    const unknown = loadLinkConfig({} as NodeJS.ProcessEnv, 'acme/x', () => undefined);
    assert.deepEqual([unknown.minSim, unknown.k], [0.8, 5]);
    const noModel = loadLinkConfig({} as NodeJS.ProcessEnv);
    assert.deepEqual([noModel.minSim, noModel.k, noModel.policyVersion], [LINK_DEFAULTS.minSim, LINK_DEFAULTS.k, 'p0-2']);
    const env = loadLinkConfig({ LORE_LINK_MIN_SIM: '0.91', LORE_LINK_K: '3', LORE_LINK_POLICY_VERSION: 'p9' } as NodeJS.ProcessEnv, DEFAULT_LOCAL_MODEL_ID);
    assert.deepEqual([env.minSim, env.k, env.policyVersion], [0.91, 3, 'p9'], 'env wins over the model policy');
});

class DetEmbedProvider implements EmbeddingProvider {
    readonly dimension = 16;
    readonly modelId = 'link-policy-det';
    readonly dtype = 'fp32';
    async initialize(): Promise<void> { /* no-op */ }
    private vec(text: string): number[] {
        const v = new Array(this.dimension).fill(0);
        for (let i = 0; i < text.length; i++) v[i % this.dimension] += text.charCodeAt(i) / 128;
        const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
        return v.map((x) => x / norm);
    }
    async embed(t: string): Promise<number[]> { return this.vec(t); }
    async embedQuery(t: string): Promise<number[]> { return this.vec(t); }
    async embedDocument(t: string): Promise<number[]> { return this.vec(t); }
    async embedDocumentBatch(ts: string[]): Promise<number[][]> { return ts.map((t) => this.vec(t)); }
}

await test('edges written on arrival carry policy p0-2 and the provider fingerprint', async () => {
    process.env.LORE_LINK_ON_ARRIVAL = '1';
    process.env.LORE_LINK_QUIET_MS = '20';
    process.env.LORE_LINK_YIELD_MS = '1';
    const { createLore } = await import('../packages/lore/src/index.js');
    const provider = new DetEmbedProvider();
    const lore: any = await (createLore as any)({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'lore-link-policy-')), deploymentMode: 'embedded', embeddingProvider: provider });
    try {
        const base = 'the quarterly lease renewal for the downtown office building was approved by the board';
        for (const n of [1, 2]) {
            await lore.nodeUpsert({ id: `n${n}`, workspace: 'default', ecosystem: '*', nodeData: { id: `n${n}`, type: 'note', label: `n${n}`, content: `${base} variant ${n}`, project: 'default', ecosystem: '*' } });
            await lore.awaitEmbeds?.();
        }
        await lore.store.autolinkTracker?.drain?.(5000);
        await lore.store.linkService.flush();
        const edges = await lore.store.loreGraph.queryEdges({ limit: 100, offset: 0, relation: 'semantic_neighbor', includeProvenance: true });
        assert.ok(edges.length >= 1, 'a link exists');
        for (const e of edges) {
            assert.equal(e.provenance?.origin, 'link_on_arrival');
            assert.equal(e.provenance?.policyVersion, 'p0-2');
            assert.equal(e.provenance?.modelFingerprint, embeddingProviderFingerprint(provider));
        }
    } finally { await lore.dispose(); }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
