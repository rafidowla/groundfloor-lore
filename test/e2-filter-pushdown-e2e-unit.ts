#!/usr/bin/env tsx
/**
 * test/e2-filter-pushdown-e2e-unit.ts — E2 (entities/topics/project
 * prefilter), end-to-end coverage gap.
 *
 * Mirrors test/d2-type-prefilter-e2e-unit.ts exactly in shape: it goes
 * through the PUBLIC surface (a real `createLore()` embedded instance, its
 * real MCP `recall` tool via `InMemoryTransport` + a real `Client`), so the
 * assertion covers the actual wiring — `recall` tool args -> retrieve() ->
 * resolveSeedStore()/graph.search() -> the store's/graph's SQL/SurrealQL/
 * Lance prefilter — not just the bottom of that chain, which is what
 * test/e2-filter-pushdown-unit.ts already covers directly.
 *
 * `project` behaves exactly like D2's `types` (a true, unbounded-resistance
 * WHERE-clause prefilter on BOTH the vector/BM25 seed leg AND the keyword
 * leg — see retrieveSeedStore.ts's project-scoped union and retrieve.ts's
 * `workspaceScope`), so its fixture reuses D2's shape verbatim (100 junk per
 * target, 5 targets).
 *
 * `entities`/`topics` get true prefilter treatment on the KEYWORD leg only
 * (graph.search()'s json_each/string::matches predicate — see
 * sqliteGraphReads.ts / surrealGraphReads.ts) — the VECTOR/BM25 leg has no
 * queryable column for them on the verbatim row, so that leg falls back to
 * the adaptive over-fetch widening loop (SEED_MAX_HEADROOM = 16x, see
 * retrieve.ts). That fallback has bounded — not unlimited — crowding
 * resistance, so this file deliberately uses a SMALLER junk count for
 * entities/topics (50/target, N_TARGETS=3) than for project/types (100/
 * target, N_TARGETS=5): enough to prove the fallback genuinely works without
 * assuming it can out-resist an unbounded prefilter it structurally isn't.
 *
 * Run: npx tsx test/e2-filter-pushdown-e2e-unit.ts
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

type FilterKind = 'project' | 'entities' | 'topics';
const RARE_TOKEN = (kind: FilterKind, i: number): string => `zzqke2ef${kind[0]}9182x${i}`;

function dim(nTargets: number): number { return nTargets + 1; }
function saltDim(nTargets: number): number { return nTargets; }
function vecForCosine(nTargets: number, i: number, cos: number, salt: number): number[] {
    const sin = Math.sqrt(Math.max(0, 1 - cos * cos));
    const v = new Array(dim(nTargets)).fill(0);
    v[i] = cos;
    v[saltDim(nTargets)] = sin * ((salt % 997) / 997 || 1e-6);
    return v;
}
function hashOf(s: string): number {
    let h = 0;
    for (let k = 0; k < s.length; k++) h = (h * 31 + s.charCodeAt(k)) | 0;
    return Math.abs(h);
}

/** Deterministic fixed-vector provider, no ONNX load — same scheme as
 *  d2-type-prefilter-e2e-unit.ts's provider, parameterized by nTargets since
 *  project uses 5 and entities/topics use 3 (see file header). */
class E2EFixedVectorEmbedProvider implements EmbeddingProvider {
    readonly modelId = 'e2-e2e-fixed';
    readonly dtype = 'fp32';
    constructor(readonly dimension: number, private readonly kind: FilterKind) {}
    async initialize(): Promise<void> {}
    async embedQuery(text: string): Promise<number[]> {
        const re = new RegExp(`zzqke2ef${this.kind[0]}9182x(\\d+)`);
        const m = re.exec(text);
        const i = m ? Number(m[1]) : 0;
        return vecForCosine(this.dimension - 1, i, 1, 0);
    }
    async embed(text: string): Promise<number[]> { return this.embedDocument(text); }
    async embedDocument(text: string): Promise<number[]> {
        const tm = /^TARGET(\d+)/.exec(text);
        if (tm) return vecForCosine(this.dimension - 1, Number(tm[1]), 0.9, hashOf(text));
        const jm = /^JUNK(\d+)/.exec(text);
        if (jm) return vecForCosine(this.dimension - 1, Number(jm[1]), 0.999, hashOf(text));
        if (text.startsWith('KDIST')) return vecForCosine(this.dimension - 1, 0, 0.1, hashOf(text));
        throw new Error(`unexpected fixture text: ${text}`);
    }
}

function tmpDataDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'e2-e2e-'));
}

async function connectRecallClient(lore: Awaited<ReturnType<typeof createLore>>): Promise<Client> {
    const mcpServer = lore.createMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    const client = new Client({ name: 'e2-e2e-test', version: '0.0.1' });
    await client.connect(clientTransport);
    return client;
}

async function recall(client: Client, args: Record<string, unknown>): Promise<RecallSummaryLike> {
    const result = await client.callTool({ name: 'recall', arguments: args }) as unknown as ToolTextResult;
    assert.ok(!result.isError, `recall tool errored: ${JSON.stringify(result)}`);
    return parseToolText<RecallSummaryLike>(result);
}

/** Runs the full end-to-end case for one filter kind against one engine pair. */
async function runCase(
    kind: FilterKind,
    nTargets: number,
    junkPerTarget: number,
    pairLabel: string,
    env: { graph?: string; vector?: string },
): Promise<void> {
    const priorGraph = process.env['LORE_DEFAULT_GRAPH_ENGINE'];
    const priorVector = process.env['LORE_DEFAULT_VECTOR_ENGINE'];
    if (env.graph) process.env['LORE_DEFAULT_GRAPH_ENGINE'] = env.graph; else delete process.env['LORE_DEFAULT_GRAPH_ENGINE'];
    if (env.vector) process.env['LORE_DEFAULT_VECTOR_ENGINE'] = env.vector; else delete process.env['LORE_DEFAULT_VECTOR_ENGINE'];

    const dataDir = tmpDataDir();
    const lore = await createLore({ dataDir, deploymentMode: 'embedded', embeddingProvider: new E2EFixedVectorEmbedProvider(dim(nTargets), kind) });
    try {
        const targetIds = Array.from({ length: nTargets }, (_, i) => `target-${kind}-${i}`);
        const filterValue = (i: number): string => `${kind}-val-${i}`;

        const targetExtra = (i: number): Record<string, unknown> => kind === 'project'
            ? {}
            : { [kind]: [filterValue(i)] };
        const targetProject = (i: number): string | undefined => kind === 'project' ? filterValue(i) : 'default';

        const knowledgeNodes = [
            ...targetIds.map((id, i) => ({
                id, workspace: 'default', ecosystem: '*',
                nodeData: { id, type: 'knowledge', label: id, content: `TARGET${i} the canonical answer document mentions ${RARE_TOKEN(kind, i)} exactly once`, project: targetProject(i), ecosystem: '*' },
                ...targetExtra(i),
            })),
            ...Array.from({ length: Math.max(0, 80 - nTargets) }, (_, i) => ({
                id: `kdist-${kind}-${i}`, workspace: 'default', ecosystem: '*',
                nodeData: { id: `kdist-${kind}-${i}`, type: 'knowledge', label: `kdist-${kind}-${i}`, content: `KDIST unrelated knowledge filler row ${i} about nothing in particular`, project: 'default', ecosystem: '*' },
            })),
        ];
        await lore.bulkIngest(knowledgeNodes, { autolink: false, embed: 'sync' });

        const client = await connectRecallClient(lore);
        const modes: Array<'keyword' | 'semantic'> = ['keyword', 'semantic'];

        const recallArgsFor = (i: number, withFilter: boolean, mode: 'keyword' | 'semantic'): Record<string, unknown> => {
            const base: Record<string, unknown> = { topic: RARE_TOKEN(kind, i), workspace: 'default', search_mode: mode, mode: 'summary' };
            if (!withFilter) return base;
            if (kind === 'project') return { ...base, project: filterValue(i) };
            return { ...base, [kind]: [filterValue(i)] };
        };

        const baseline: Record<string, string | undefined> = {};
        for (const mode of modes) {
            for (let i = 0; i < nTargets; i++) {
                await test(`[E2:${kind}] [${pairLabel}] [${mode}] baseline (0 distractors): hit@1 == ${targetIds[i]}`, async () => {
                    const r = await recall(client, recallArgsFor(i, true, mode));
                    assert.ok(r.hits.length > 0, 'expected at least one hit');
                    assert.equal(r.hits[0].id, targetIds[i], `got ${JSON.stringify(r.hits.map((h) => h.id))}`);
                    baseline[`${mode}:${i}`] = r.hits[0].id;
                });
            }
        }

        // Distractors: same project/entities/topics VALUE the corresponding
        // target does NOT have (so the filter genuinely excludes them),
        // repeating that target's rare token + a higher/equal-strength
        // vector cosine so they legitimately threaten hit@1 absent a filter.
        const junkNodes = [];
        for (let i = 0; i < nTargets; i++) {
            const tail = new Array(40).fill(RARE_TOKEN(kind, i)).join(' ');
            const junkExtra: Record<string, unknown> = kind === 'project' ? {} : { [kind]: [`${kind}-junk-${i}`] };
            const junkProject = kind === 'project' ? `${kind}-junk-${i}` : 'default';
            for (let n = 0; n < junkPerTarget; n++) {
                const id = `junk-${kind}-${i}-${n}`;
                junkNodes.push({
                    id, workspace: 'default', ecosystem: '*',
                    nodeData: { id, type: 'knowledge', label: id, content: `JUNK${i} distractor row ${n} ${tail}`, project: junkProject, ecosystem: '*' },
                    ...junkExtra,
                });
            }
        }
        await lore.bulkIngest(junkNodes, { autolink: false, embed: 'sync' });

        for (const mode of modes) {
            for (let i = 0; i < nTargets; i++) {
                await test(`[E2:${kind}] [${pairLabel}] [${mode}] with ${junkPerTarget * nTargets} distractors + ${kind} filter: hit@1 unchanged for ${targetIds[i]}`, async () => {
                    const r = await recall(client, recallArgsFor(i, true, mode));
                    assert.ok(r.hits.length > 0, 'expected at least one hit');
                    assert.equal(r.hits[0].id, baseline[`${mode}:${i}`], `hit@1 changed after distractors were added: got ${JSON.stringify(r.hits.map((h) => h.id))}`);
                    assert.equal(r.hits[0].id, targetIds[i]);
                });
            }
        }

        // Negative control — same fixture, WITHOUT the filter, proves the
        // distractors genuinely threaten hit@1 absent it (not a tautology).
        for (const mode of modes) {
            await test(`[E2:${kind}] [${pairLabel}] [${mode}] negative control: WITHOUT ${kind}, distractors crowd out ${targetIds[0]}`, async () => {
                const r = await recall(client, recallArgsFor(0, false, mode));
                assert.notEqual(r.hits[0]?.id, targetIds[0], `expected junk to outrank the target without a ${kind} filter; got ${JSON.stringify(r.hits.map((h) => h.id))}`);
            });
        }
    } finally {
        await lore.dispose();
        if (priorGraph === undefined) delete process.env['LORE_DEFAULT_GRAPH_ENGINE']; else process.env['LORE_DEFAULT_GRAPH_ENGINE'] = priorGraph;
        if (priorVector === undefined) delete process.env['LORE_DEFAULT_VECTOR_ENGINE']; else process.env['LORE_DEFAULT_VECTOR_ENGINE'] = priorVector;
    }
}

async function main(): Promise<void> {
    console.log('e2-filter-pushdown-e2e-unit\n');

    // project — true unbounded-resistance prefilter, same fixture size as
    // D2's own types e2e test.
    await runCase('project', 5, 100, 'sqlite/sqlite', {});
    await runCase('project', 5, 100, 'surreal/lance', { graph: 'surreal', vector: 'lance' });

    // entities/topics — keyword leg is a true prefilter, vector leg is the
    // bounded adaptive-widening fallback (see file header) — smaller fixture.
    await runCase('entities', 3, 50, 'sqlite/sqlite', {});
    await runCase('entities', 3, 50, 'surreal/lance', { graph: 'surreal', vector: 'lance' });
    await runCase('topics', 3, 50, 'sqlite/sqlite', {});
    await runCase('topics', 3, 50, 'surreal/lance', { graph: 'surreal', vector: 'lance' });

    console.log(`\n${passed} passed, ${failed} failed\n`);
    if (failed > 0) process.exit(1);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
