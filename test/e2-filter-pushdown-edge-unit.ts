#!/usr/bin/env tsx
/**
 * test/e2-filter-pushdown-edge-unit.ts — E2 correctness regressions for the
 * entities/topics/project pushdown (review of fix/d2-filter-pushdown-…).
 *
 * PART 1 — graph.search() differential, SqliteGraph + SurrealGraph: for 29
 * entities/topics filter cases over awkward metadata (quotes, backslashes,
 * control chars, `]` inside an earlier element, whitespace after the colon,
 * non-string elements, nested/look-alike keys, NO metadata, malformed
 * metadata), the pushed-down result must equal exactly what the old JS
 * post-filter (`passesEntitiesTopicsProject`) keeps from an unfiltered
 * search — no missing rows, no extra rows, and no throw.
 *   Pre-fix: surreal threw on a metadata-less node (string::matches on NONE)
 *   and dropped 8/29 cases; sqlite threw on malformed metadata (json_each).
 *
 * PART 2 — the same through the public surface (createLore + bulkIngest +
 * MCP `recall`), sqlite/sqlite and surreal/lance, keyword/semantic/hybrid:
 *   - entities filter with a metadata-less node in the workspace;
 *   - `project: ""` means "no project filter" (pre-fix it returned []);
 *   - a bulkIngest'd node whose vector row `project` differs from the graph
 *     node's is still found by a `project` filter.
 *
 * Run: npx tsx test/e2-filter-pushdown-edge-unit.ts
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createLore } from '../packages/lore/src/index.js';
import { SqliteGraph } from '../packages/lore/src/engines/sqliteGraph.js';
import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import { passesEntitiesTopicsProject } from '../packages/lore/src/recall/retrieveFilters.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
    catch (e) { console.error(`  \x1b[31m✗\x1b[0m ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}
const tmp = (prefix: string): string => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/* ── PART 1 — graph-level differential ── */

const TOK = 'zze2edgetok';
const LONG = 'L'.repeat(5000);
const ROWS: Array<{ id: string; meta?: unknown }> = [
    { id: 'm-acme', meta: { entities: ['Acme'], topics: ['billing'] } },
    { id: 'm-acme-lc', meta: { entities: ['acme'], topics: ['Billing'] } },
    { id: 'm-acme-x', meta: { entities: ['x', 'Acme'] } },
    { id: 'm-brk-first', meta: { entities: ['br]acket', 'Acme'], topics: ['a]b', 'billing'] } },
    { id: 'm-brk', meta: { entities: ['br]acket'] } },
    { id: 'm-dotstar', meta: { entities: ['a.*b'] } },
    { id: 'm-pipe', meta: { entities: ['a|b'] } },
    { id: 'm-quote', meta: { entities: ['quo"te', 'Acme'] } },
    { id: 'm-bslash', meta: { entities: ['back\\slash'] } },
    { id: 'm-uni', meta: { entities: ['ünïcode😀'] } },
    { id: 'm-ctrl', meta: { entities: ['tab\there', 'nl\nhere'] } },
    { id: 'm-long', meta: { entities: [LONG] } },
    { id: 'm-empty', meta: { entities: [] } },
    { id: 'm-emptyobj', meta: {} },
    { id: 'm-topic-as-ent', meta: { topics: ['Acme'] } },
    { id: 'm-num', meta: { entities: [42, 'Acme'] } },
    { id: 'm-str', meta: { entities: 'Acme' } },
    { id: 'm-nested', meta: { other: { entities: ['Acme'] } } },
    { id: 'm-strval', meta: { note: '"entities":["Acme"]' } },
    { id: 'm-ent-then-top', meta: { entities: ['e1'], topics: ['Acme'] } },
    { id: 'm-space', meta: '{"entities": ["Acme"]}' },
    { id: 'm-space-in', meta: '{ "entities" : [ "x" , "Acme" ] }' },
    { id: 'm-nometa' },                      // metadata NONE (surreal) / NULL (sqlite)
    { id: 'm-bad-empty', meta: '' },         // malformed
    { id: 'm-bad-text', meta: 'not json' },  // malformed
];
const CASES: Array<{ e?: string[]; t?: string[] }> = [
    { e: ['Acme'] }, { e: ['acme'] }, { e: ['Acme', 'x'] }, { e: ['Acme', 'br]acket'] }, { e: ['br]acket'] }, { e: ['a.*b'] }, { e: ['.*'] },
    { e: ['a|b'] }, { e: ['Acme|x'] }, { e: ['quo"te'] }, { e: ['"'] }, { e: ['back\\slash'] }, { e: ['\\'] }, { e: [']'] }, { e: ['[^\\]]*'] },
    { e: ['ünïcode😀'] }, { e: ['tab\there'] }, { e: ['nl\nhere'] }, { e: [LONG] }, { e: ['L'.repeat(20000)] }, { e: ['42'] }, { e: ['e1'] },
    { e: ['",".*'] }, { e: ['Acme"]'] },
    { t: ['billing'] }, { t: ['Billing'] }, { t: ['a]b'] }, { t: ['Acme'] }, { t: ['billing', 'a]b'] },
];
// Non-tautology anchors: cases the old semantics DO match.
const MUST_MATCH: Record<string, string[]> = {
    '{"e":["Acme"]}': ['m-acme', 'm-acme-x', 'm-brk-first', 'm-num', 'm-quote', 'm-space', 'm-space-in'],
    '{"e":["quo\\"te"]}': ['m-quote'],
    '{"e":["back\\\\slash"]}': ['m-bslash'],
    '{"e":["tab\\there"]}': ['m-ctrl'],
    '{"t":["billing","a]b"]}': ['m-brk-first'],
};

async function part1(): Promise<void> {
    for (const eng of ['sqlite', 'surreal'] as const) {
        await test(`[${eng}] graph.search entities/topics == old post-filter for ${CASES.length} cases (incl. NONE + malformed metadata)`, async () => {
            const dir = tmp(`e2-edge-${eng}-`);
            const g = eng === 'sqlite'
                ? new SqliteGraph(dir, { workspaceId: 'e2-edge', cacheDisabled: true })
                : new SurrealGraph(dir, { workspaceId: 'e2-edge', cacheDisabled: true });
            await g.initialize();
            try {
                for (const r of ROWS) {
                    const metadata = r.meta === undefined ? undefined : typeof r.meta === 'string' ? r.meta : JSON.stringify(r.meta);
                    // `metadata` omitted on purpose for m-nometa (LoreNode types it as required).
                    const n = { id: r.id, type: 'knowledge', label: r.id, content: `${r.id} ${TOK}`, tags: [], project: '*', ecosystem: '*', ...(metadata === undefined ? {} : { metadata }) };
                    await g.upsertNode(n as Parameters<SqliteGraph['upsertNode']>[0]);
                }
                const all = await g.search(TOK, 1000, '*', '*', false);
                assert.equal(all.length, ROWS.length, 'unfiltered search must see every row');
                const problems: string[] = [];
                for (const c of CASES) {
                    const key = JSON.stringify(c);
                    const label = key.replace(/L{30,}/g, 'L…');
                    const expected = all.filter((n) => passesEntitiesTopicsProject(n, c.e, c.t, undefined)).map((n) => n.id).sort();
                    for (const id of MUST_MATCH[key] ?? []) assert.ok(expected.includes(id), `fixture anchor: ${label} must match ${id}`);
                    let got: string[];
                    try {
                        got = (await g.search(TOK, 1000, '*', '*', false, undefined, undefined, c.e, c.t)).map((n) => n.id).sort();
                    } catch (err) {
                        problems.push(`${label}: THROW ${String(err).slice(0, 160)}`);
                        continue;
                    }
                    const missing = expected.filter((x) => !got.includes(x));
                    const extra = got.filter((x) => !expected.includes(x));
                    if (missing.length || extra.length) problems.push(`${label}: missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)}`);
                }
                assert.deepEqual(problems, [], `[${eng}] ${problems.length} case(s) differ:\n      ${problems.join('\n      ')}`);
            } finally {
                await g.close?.();
            }
        });
    }
}

/* ── PART 2 — public surface (createLore + bulkIngest + recall) ── */

class HashEmbedProvider implements EmbeddingProvider {
    readonly dimension = 8;
    readonly modelId = 'e2-edge-hash';
    readonly dtype = 'fp32';
    async initialize(): Promise<void> {}
    async embedQuery(text: string): Promise<number[]> { return this.embedDocument(text); }
    async embed(text: string): Promise<number[]> { return this.embedDocument(text); }
    async embedDocument(text: string): Promise<number[]> {
        let h = 7;
        const v = new Array(this.dimension).fill(0.1);
        for (let i = 0; i < text.length; i++) { h = (h * 31 + text.charCodeAt(i)) | 0; v[i % this.dimension] += ((h >>> 0) % 97) / 97; }
        return v;
    }
}

interface ToolTextResult { content: Array<{ type: string; text: string }>; isError?: boolean }

async function part2(pairLabel: string, env: { graph?: string; vector?: string }): Promise<void> {
    const priorGraph = process.env['LORE_DEFAULT_GRAPH_ENGINE'];
    const priorVector = process.env['LORE_DEFAULT_VECTOR_ENGINE'];
    if (env.graph) process.env['LORE_DEFAULT_GRAPH_ENGINE'] = env.graph; else delete process.env['LORE_DEFAULT_GRAPH_ENGINE'];
    if (env.vector) process.env['LORE_DEFAULT_VECTOR_ENGINE'] = env.vector; else delete process.env['LORE_DEFAULT_VECTOR_ENGINE'];
    const lore = await createLore({ dataDir: tmp('e2-edge-e2e-'), deploymentMode: 'embedded', embeddingProvider: new HashEmbedProvider() });
    try {
        const T = 'zzedgee2etok';
        const node = (id: string, extra: Record<string, unknown>, nodeData: Record<string, unknown> = {}) => ({
            id, workspace: 'default', ecosystem: 'eco-e2', ...extra,
            nodeData: { id, type: 'knowledge', label: `${id} ${T}`, content: `${id} content mentions ${T}`, ecosystem: 'eco-e2', ...nodeData },
        });
        await lore.bulkIngest([
            node('ent-yes', { entities: ['acme-e'], topics: ['topic-e'] }, { project: 'proj-e' }),
            node('ent-none', {}, { project: 'proj-e' }),     // no entities/topics -> no metadata
            node('proj-default', {}),                        // no nodeData.project: graph -> 'default', vector row -> ecosystem
        ], { autolink: false, embed: 'sync' });

        const mcp = lore.createMcpServer();
        const [ct, st] = InMemoryTransport.createLinkedPair();
        await mcp.connect(st);
        const client = new Client({ name: 'e2-edge', version: '0.0.1' });
        await client.connect(ct);
        const recall = async (args: Record<string, unknown>): Promise<string[]> => {
            const res = await client.callTool({ name: 'recall', arguments: { topic: T, workspace: 'default', ecosystem: 'eco-e2', mode: 'summary', ...args } }) as unknown as ToolTextResult;
            assert.ok(!res.isError, `recall errored: ${JSON.stringify(res).slice(0, 400)}`);
            return (JSON.parse(res.content[0]?.text ?? '{}') as { hits: Array<{ id: string }> }).hits.map((h) => h.id).sort();
        };

        for (const mode of ['keyword', 'semantic', 'hybrid'] as const) {
            await test(`[${pairLabel}] [${mode}] entities/topics filter with a metadata-less node present`, async () => {
                assert.deepEqual(await recall({ search_mode: mode, entities: ['acme-e'] }), ['ent-yes']);
                assert.deepEqual(await recall({ search_mode: mode, topics: ['topic-e'] }), ['ent-yes']);
            });
            await test(`[${pairLabel}] [${mode}] project "" == no project filter`, async () => {
                const unfiltered = await recall({ search_mode: mode });
                assert.ok(unfiltered.length >= 3, `fixture: expected all 3 nodes unfiltered, got ${JSON.stringify(unfiltered)}`);
                assert.deepEqual(await recall({ search_mode: mode, project: '' }), unfiltered);
            });
            await test(`[${pairLabel}] [${mode}] project filter finds a node whose vector-row project differs from the graph node's`, async () => {
                assert.deepEqual(await recall({ search_mode: mode, project: 'default' }), ['proj-default']);
                assert.deepEqual(await recall({ search_mode: mode, project: 'proj-e' }), ['ent-none', 'ent-yes']);
            });
        }
        await client.close();
    } finally {
        await lore.dispose();
        if (priorGraph === undefined) delete process.env['LORE_DEFAULT_GRAPH_ENGINE']; else process.env['LORE_DEFAULT_GRAPH_ENGINE'] = priorGraph;
        if (priorVector === undefined) delete process.env['LORE_DEFAULT_VECTOR_ENGINE']; else process.env['LORE_DEFAULT_VECTOR_ENGINE'] = priorVector;
    }
}

async function main(): Promise<void> {
    console.log('e2-filter-pushdown-edge-unit\n');
    await part1();
    await part2('sqlite/sqlite', {});
    await part2('surreal/lance', { graph: 'surreal', vector: 'lance' });
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
