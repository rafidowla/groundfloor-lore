#!/usr/bin/env tsx
/**
 * test/d2-type-prefilter-e2e-unit.ts — D2 (type/kind prefilter), end-to-end
 * coverage gap.
 *
 * `test/d2-type-prefilter-unit.ts` exercises the fix at the store /
 * `resolveSeedStore()` layer directly. This file instead goes through the
 * PUBLIC surface: a real `createLore()` embedded instance, its real MCP
 * `recall` tool (called via `InMemoryTransport` + a real `Client`, the same
 * pattern `test/embedded-maintain-findings-unit.ts` uses), so the assertion
 * covers the actual wiring — `recall` tool args -> retrieve() ->
 * resolveSeedStore() -> the store's SQL/Lance prefilter — not just the
 * bottom of that chain. Runs against BOTH engine pairs (sqlite/sqlite, the
 * 3.21 default for a fresh workspace, and surreal/lance, forced via the
 * `LORE_DEFAULT_GRAPH_ENGINE`/`LORE_DEFAULT_VECTOR_ENGINE` operator escape
 * hatches the same way test/workspace-verbatim-isolation-unit.ts does).
 *
 * Fixture shape / scoping note: 80 "knowledge" nodes are ingested per engine
 * pair (matching the requested corpus size), but only 5 of them are
 * "targets" wired to a type-scoped question (one unique rare BM25 token +
 * one dedicated one-hot vector dimension each); the remaining 75 are inert
 * filler rows providing bulk/realism. This is a deliberate scope choice, not
 * an oversight: a single junk row cannot simultaneously out-rank more than a
 * handful of mutually-orthogonal query directions at once (cosine similarity
 * to N orthogonal unit vectors is bounded by sum-of-squares <= 1), so
 * proving per-node crowding-out for all 80 independently would need 80
 * dedicated one-hot dimensions and 80 matching junk variants for no extra
 * coverage value — the crowding-out MECHANISM is already proven generic
 * (engine-agnostic, node-count-agnostic) by the store-level suite in
 * d2-type-prefilter-unit.ts. What this file adds on top is proof that the
 * `types` argument actually reaches that mechanism through the real public
 * API end-to-end, for 5 independent target/question pairs, on both engine
 * pairs, on both the BM25 (search_mode:'keyword') and vector
 * (search_mode:'semantic') legs.
 *
 * Run: npx tsx test/d2-type-prefilter-e2e-unit.ts
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createLore } from '../packages/lore/src/index.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
        console.log(`  \x1b[32m✓\x1b[0m ${name}`);
        passed++;
    } catch (err) {
        console.error(`  \x1b[31m✗ ${name}\x1b[0m\n    ${(err as Error).stack ?? (err as Error).message}`);
        failed++;
    }
}

interface ToolTextResult { content: Array<{ type: string; text: string }>; isError?: boolean }
function parseToolText<T>(result: ToolTextResult): T {
    return JSON.parse(result.content[0]?.text ?? '{}') as T;
}
interface RecallSummaryLike { hits: Array<{ id: string }> }

const N_TARGETS = 5;
const DIM = N_TARGETS + 1; // one one-hot dim per target + 1 shared salt dim
const SALT_DIM = N_TARGETS;
const RARE_TOKEN = (i: number): string => `zzqke2e9182x${i}`;

/** cosine `cos` toward one-hot dim `i`, with a tiny salt-dim perturbation so
 *  same-cosine rows aren't bit-identical vectors (irrelevant to ranking). */
function vecForCosine(i: number, cos: number, salt: number): number[] {
    const sin = Math.sqrt(Math.max(0, 1 - cos * cos));
    const v = new Array(DIM).fill(0);
    v[i] = cos;
    v[SALT_DIM] = sin * ((salt % 997) / 997 || 1e-6);
    return v;
}
function hashOf(s: string): number {
    let h = 0;
    for (let k = 0; k < s.length; k++) h = (h * 31 + s.charCodeAt(k)) | 0;
    return Math.abs(h);
}

/** Deterministic fixed-vector provider, no ONNX load. Query vectors are
 *  one-hot toward the target index encoded in the query text (extracted via
 *  the RARE_TOKEN pattern) — this is what lets 5 INDEPENDENT target/query
 *  pairs coexist in one fixture (see file header for why a single shared
 *  query direction, as the store-level suite uses, cannot do this for >1
 *  simultaneous target). */
class E2EFixedVectorEmbedProvider implements EmbeddingProvider {
    readonly dimension = DIM;
    readonly modelId = 'd2-e2e-fixed';
    readonly dtype = 'fp32';
    async initialize(): Promise<void> {}
    async embedQuery(text: string): Promise<number[]> {
        const m = /zzqke2e9182x(\d)/.exec(text);
        const i = m ? Number(m[1]) : 0;
        return vecForCosine(i, 1, 0);
    }
    async embed(text: string): Promise<number[]> { return this.embedDocument(text); }
    async embedDocument(text: string): Promise<number[]> {
        const tm = /^TARGET(\d)/.exec(text);
        if (tm) return vecForCosine(Number(tm[1]), 0.9, hashOf(text));
        const jm = /^JUNK(\d)/.exec(text);
        if (jm) return vecForCosine(Number(jm[1]), 0.999, hashOf(text));
        if (text.startsWith('KDIST')) return vecForCosine(0, 0.1, hashOf(text)); // inert filler
        throw new Error(`unexpected fixture text: ${text}`);
    }
}

function tmpDataDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'd2-e2e-'));
}

async function connectRecallClient(lore: Awaited<ReturnType<typeof createLore>>): Promise<Client> {
    const mcpServer = lore.createMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    const client = new Client({ name: 'd2-e2e-test', version: '0.0.1' });
    await client.connect(clientTransport);
    return client;
}

async function recall(client: Client, args: Record<string, unknown>): Promise<RecallSummaryLike> {
    const result = await client.callTool({ name: 'recall', arguments: args }) as unknown as ToolTextResult;
    assert.ok(!result.isError, `recall tool errored: ${JSON.stringify(result)}`);
    return parseToolText<RecallSummaryLike>(result);
}

/** Runs the full end-to-end case against one engine pair. */
async function runEnginePairCase(pairLabel: string, env: { graph?: string; vector?: string }): Promise<void> {
    const priorGraph = process.env['LORE_DEFAULT_GRAPH_ENGINE'];
    const priorVector = process.env['LORE_DEFAULT_VECTOR_ENGINE'];
    if (env.graph) process.env['LORE_DEFAULT_GRAPH_ENGINE'] = env.graph; else delete process.env['LORE_DEFAULT_GRAPH_ENGINE'];
    if (env.vector) process.env['LORE_DEFAULT_VECTOR_ENGINE'] = env.vector; else delete process.env['LORE_DEFAULT_VECTOR_ENGINE'];

    const dataDir = tmpDataDir();
    const lore = await createLore({ dataDir, deploymentMode: 'embedded', embeddingProvider: new E2EFixedVectorEmbedProvider() });
    try {
        const targetIds = Array.from({ length: N_TARGETS }, (_, i) => `target-${i}`);
        const knowledgeNodes = [
            ...targetIds.map((id, i) => ({
                id, workspace: 'default', ecosystem: '*',
                nodeData: { id, type: 'knowledge', label: id, content: `TARGET${i} the canonical answer document mentions ${RARE_TOKEN(i)} exactly once`, project: 'default', ecosystem: '*' },
            })),
            ...Array.from({ length: 80 - N_TARGETS }, (_, i) => ({
                id: `kdist-${i}`, workspace: 'default', ecosystem: '*',
                nodeData: { id: `kdist-${i}`, type: 'knowledge', label: `kdist-${i}`, content: `KDIST unrelated knowledge filler row ${i} about nothing in particular`, project: 'default', ecosystem: '*' },
            })),
        ];
        await lore.bulkIngest(knowledgeNodes, { autolink: false, embed: 'sync' });

        const client = await connectRecallClient(lore);
        const modes: Array<'keyword' | 'semantic'> = ['keyword', 'semantic'];

        const baseline: Record<string, string | undefined> = {};
        for (const mode of modes) {
            for (let i = 0; i < N_TARGETS; i++) {
                await test(`[${pairLabel}] [${mode}] baseline (0 distractors): hit@1 == ${targetIds[i]} for its question`, async () => {
                    const r = await recall(client, { topic: RARE_TOKEN(i), types: ['knowledge'], workspace: 'default', search_mode: mode, mode: 'summary' });
                    assert.ok(r.hits.length > 0, 'expected at least one hit');
                    assert.equal(r.hits[0].id, targetIds[i], `got ${JSON.stringify(r.hits.map((h) => h.id))}`);
                    baseline[`${mode}:${i}`] = r.hits[0].id;
                });
            }
        }

        // Inject distractors: type 'chat' (not 'knowledge'), 100 copies of
        // each of the 5 JUNK<i> variants — same TF-inflation (BM25) /
        // higher-cosine (vector, 0.999 > target's 0.9) scheme the
        // store-level suite uses, so junk legitimately outranks its
        // matching target on both legs absent a type filter.
        const junkNodes = [];
        for (let i = 0; i < N_TARGETS; i++) {
            const tail = new Array(40).fill(RARE_TOKEN(i)).join(' ');
            for (let n = 0; n < 100; n++) {
                const id = `junk-${i}-${n}`;
                junkNodes.push({
                    id, workspace: 'default', ecosystem: '*',
                    nodeData: { id, type: 'chat', label: id, content: `JUNK${i} distractor row ${n} ${tail}`, project: 'default', ecosystem: '*' },
                });
            }
        }
        await lore.bulkIngest(junkNodes, { autolink: false, embed: 'sync' });

        for (const mode of modes) {
            for (let i = 0; i < N_TARGETS; i++) {
                await test(`[${pairLabel}] [${mode}] with 500 chat-type distractors + types:['knowledge']: hit@1 unchanged for ${targetIds[i]}`, async () => {
                    const r = await recall(client, { topic: RARE_TOKEN(i), types: ['knowledge'], workspace: 'default', search_mode: mode, mode: 'summary' });
                    assert.ok(r.hits.length > 0, 'expected at least one hit');
                    assert.equal(r.hits[0].id, baseline[`${mode}:${i}`], `hit@1 changed after distractors were added: got ${JSON.stringify(r.hits.map((h) => h.id))}`);
                    assert.equal(r.hits[0].id, targetIds[i]);
                });
            }
        }

        // Negative control — same fixture, WITHOUT `types`, proves the
        // distractors genuinely threaten hit@1 absent the filter (i.e. this
        // isn't a tautology of the fixture).
        for (const mode of modes) {
            await test(`[${pairLabel}] [${mode}] negative control: WITHOUT types, distractors crowd out ${targetIds[0]}`, async () => {
                const r = await recall(client, { topic: RARE_TOKEN(0), workspace: 'default', search_mode: mode, mode: 'summary' });
                assert.notEqual(r.hits[0]?.id, targetIds[0], `expected the 0.999-cosine/TF-inflated junk to outrank the target without a types filter; got ${JSON.stringify(r.hits.map((h) => h.id))}`);
            });
        }
    } finally {
        await lore.dispose();
        if (priorGraph === undefined) delete process.env['LORE_DEFAULT_GRAPH_ENGINE']; else process.env['LORE_DEFAULT_GRAPH_ENGINE'] = priorGraph;
        if (priorVector === undefined) delete process.env['LORE_DEFAULT_VECTOR_ENGINE']; else process.env['LORE_DEFAULT_VECTOR_ENGINE'] = priorVector;
    }
}

async function main(): Promise<void> {
    console.log('d2-type-prefilter-e2e-unit\n');
    await runEnginePairCase('sqlite/sqlite', {});
    await runEnginePairCase('surreal/lance', { graph: 'surreal', vector: 'lance' });

    console.log(`\n${passed} passed, ${failed} failed\n`);
    if (failed > 0) process.exit(1);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
