#!/usr/bin/env tsx
/**
 * run.ts — Lore 3.21 Tapestry-recall accuracy benchmark (step 4).
 *
 * Lore stays a database here: this harness calls ONLY Lore's public
 * embeddable API — `createLore` / `lore.bulkIngest` / `lore.recall` — for
 * EVERY config, including C5/C6 (query-time `queries[]` rephrasings).
 *
 * 3.21 r9 recall-quality fix (Finding C): `lore.recall()`'s `RecallOpts` used
 * to be missing `queries`/`entities`/`topics`/`project` even though the
 * shared retrieve() core and the `recall` MCP tool had supported all four
 * since 3.21 step 3(f) — the ONLY reason this harness used to reach for the
 * `recall` MCP tool in-process (via `lore.createMcpServer()` +
 * InMemoryTransport) for C5/C6 instead of the public embeddable surface.
 * That gap is now closed (recall/inProcessRecall.ts), so every config here
 * calls `lore.recall()` directly — no MCP transport, no client. No LLM call
 * anywhere — the questions[]/queries[] this harness writes/reads were
 * pre-authored by a human (see README.md "Provenance and blinding") and are
 * plain data files.
 *
 * Six configs (see src/types.ts CONFIGS):
 *   C1 BM25 only (search mode 'keyword')
 *   C2 dense only (mode 'semantic')
 *   C3 RRF hybrid (default)
 *   C4 hybrid + questions[]/summary/entities/topics at WRITE time
 *   C5 hybrid + queries[] (3 rephrasings) alongside the question at READ time
 *   C6 hybrid + both
 *
 * For each config: a fresh temp embedded Lore instance, bulkIngest all 415
 * memories (embed sync), then for each of the 295 eval questions call
 * recall (limit 10) and record the RANK of the gold memory id in the
 * returned hits. Metrics: top-1/3/5/10 hit rate, overall / per kind
 * (paraphrase|keyword|mixed) / excluding the high-question–alias-overlap
 * subset (see README.md's leakage check). Also computes a reference plain
 * BM25 (k1=1.2, b=0.75) over the same 415 memory texts, in the harness only
 * (see src/referenceBm25.ts) — never inside Lore itself — as a same-corpus
 * baseline for C1.
 *
 * Usage:
 *   npx tsx benchmarks/tapestry-recall/run.ts [--configs C1,C2,...] [--limit N] [--out path.json] [--engine surreal-lance|sqlite]
 *
 * --limit N restricts to the first N questions (smoke-testing only — never
 * use for the numbers that ship in RESULTS.md). --engine selects which
 * engines back the fresh bench workspace's graph/vector substrates
 * (src/loreHarness.ts EngineProfile) — 'surreal-lance' (default, what every
 * prior round used) or 'sqlite' (3.21 step 5a: the profile a brand-new local
 * workspace gets by default since 3.21). Must be run under Node 22 (native
 * LanceDB / better-sqlite3 bindings), same as every other benchmark in this
 * repo.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createBenchLore, SURREAL_LANCE_PROFILE, SQLITE_ONLY_PROFILE, type EngineProfile } from './src/loreHarness.js';
import { tokenize, jaccard } from './src/tokenize.js';
import { runReferenceBm25 } from './src/referenceBm25.js';
import { CONFIGS } from './src/types.js';
import type { ConfigId, ConfigSpec, Memory, EvalQuestion, AliasEntry, RephrasingEntry } from './src/types.js';
import type { BulkIngestNodeArgs } from '../../packages/lore/src/mcp/bulkIngest.js';
import type { LoreInstance } from '../../packages/lore/src/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const DATA_DIR = path.join(HERE, 'data');
const RESULTS_DIR = path.join(HERE, 'results');

const WORKSPACE = 'tapestry-bench';
const ECOSYSTEM = 'tapestry';
const RECALL_LIMIT = 10;
const KS = [1, 3, 5, 10] as const;
const HIGH_OVERLAP_THRESHOLD = 0.7;

/* ─── data loading ──────────────────────────────────────────────── */

function loadJsonl<T>(file: string): T[] {
    return fs
        .readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as T);
}

/* ─── CLI args ──────────────────────────────────────────────────── */

function parseArgs(argv: string[]) {
    const get = (flag: string): string | undefined => {
        const i = argv.indexOf(flag);
        return i >= 0 ? argv[i + 1] : undefined;
    };
    const configsArg = get('--configs');
    const limitArg = get('--limit');
    const engineArg = get('--engine');
    if (engineArg !== undefined && engineArg !== 'surreal-lance' && engineArg !== 'sqlite') {
        throw new Error(`--engine must be 'surreal-lance' or 'sqlite', got ${JSON.stringify(engineArg)}`);
    }
    return {
        configs: (configsArg ? configsArg.split(',') : CONFIGS.map((c) => c.id)) as ConfigId[],
        questionLimit: limitArg ? Number(limitArg) : undefined,
        outFile: get('--out'),
        engineName: (engineArg ?? 'surreal-lance') as 'surreal-lance' | 'sqlite',
    };
}

/* ─── leakage check ─────────────────────────────────────────────── */

interface LeakageInfo {
    byQid: Map<string, number>;
    mean: number;
    countOver07: number;
    countOver09: number;
    excludedQids: Set<string>;
}

function computeLeakage(questions: EvalQuestion[], aliasesById: Map<string, AliasEntry>): LeakageInfo {
    const byQid = new Map<string, number>();
    let sum = 0;
    let over07 = 0;
    let over09 = 0;
    const excludedQids = new Set<string>();
    for (const q of questions) {
        const alias = aliasesById.get(q.gold);
        const qTokens = tokenize(q.question);
        let max = 0;
        for (const aq of alias?.questions ?? []) {
            const j = jaccard(qTokens, tokenize(aq));
            if (j > max) max = j;
        }
        byQid.set(q.qid, max);
        sum += max;
        if (max > HIGH_OVERLAP_THRESHOLD) {
            over07++;
            excludedQids.add(q.qid);
        }
        if (max > 0.9) over09++;
    }
    return { byQid, mean: questions.length ? sum / questions.length : 0, countOver07: over07, countOver09: over09, excludedQids };
}

/* ─── node building ─────────────────────────────────────────────── */

function buildNodes(memories: Memory[], aliasesById: Map<string, AliasEntry>, useQuestions: boolean): BulkIngestNodeArgs[] {
    return memories.map((m) => {
        const node: BulkIngestNodeArgs = {
            id: m.id,
            workspace: WORKSPACE,
            ecosystem: ECOSYSTEM,
            nodeData: {
                id: m.id,
                ecosystem: ECOSYSTEM,
                type: 'memory',
                label: m.text.slice(0, 80).replace(/\s+/g, ' '),
                content: m.text,
                tags: [...m.topics.map((t) => `topic:${t}`), `project:${m.project}`],
                project: m.project,
                createdAt: m.createdAt,
            },
        };
        if (useQuestions) {
            const alias = aliasesById.get(m.id);
            if (alias) {
                // Top-level fields (NOT nested in nodeData) — bulkIngest's
                // questions[]/summary/entities/topics alias mechanism, per
                // BulkIngestNodeArgs's doc comment (packages/lore/src/mcp/bulkIngest.ts).
                node.questions = alias.questions.slice(0, 5);
                node.summary = alias.summary;
                node.entities = alias.entities.slice(0, 20);
                node.topics = alias.topics.slice(0, 20);
            }
        }
        return node;
    });
}

/* ─── recall callers ────────────────────────────────────────────── */

interface Hit {
    id: string;
}

interface RecallCaller {
    call(topic: string, extraQueries: string[] | undefined): Promise<Hit[]>;
    teardown(): Promise<void>;
}

/**
 * Direct `lore.recall()` — used for EVERY config, including C5/C6.
 *
 * 3.21 r9 (Finding C): `RecallOpts.queries` is now threaded through the
 * embeddable `lore.recall()` surface (recall/inProcessRecall.ts), the same
 * as it already was on the `recall` MCP tool and the shared retrieve() core
 * — so C5/C6 no longer need the MCP-tool-in-process workaround this file
 * used to carry.
 */
function makeDirectCaller(lore: LoreInstance, searchMode: ConfigSpec['searchMode']): RecallCaller {
    return {
        async call(topic, extraQueries) {
            const result = await lore.recall(topic, {
                workspace: WORKSPACE,
                ecosystem: ECOSYSTEM,
                searchMode,
                max: RECALL_LIMIT,
                depth: 0,
                mode: 'summary',
                queries: extraQueries,
            });
            if (result.mode !== 'summary') throw new Error('expected summary mode');
            return result.hits.map((h) => ({ id: h.id }));
        },
        async teardown() {},
    };
}

/* ─── per-config run ────────────────────────────────────────────── */

interface QuestionOutcome {
    qid: string;
    kind: EvalQuestion['kind'];
    rank: number | null;
    leakage: number;
}

interface ConfigResult {
    id: ConfigId;
    label: string;
    searchMode: string;
    useQuestionsAtWrite: boolean;
    useQueriesAtRead: boolean;
    nQuestions: number;
    runtimeMs: number;
    overall: MetricsBlock;
    byKind: Record<string, MetricsBlock>;
    excludingHighOverlap: { n: number; overall: MetricsBlock; byKind: Record<string, MetricsBlock> };
}

interface MetricsBlock {
    n: number;
    hitAt: Record<number, number>;
}

function computeMetrics(outcomes: QuestionOutcome[]): MetricsBlock {
    const n = outcomes.length;
    const hitAt: Record<number, number> = {};
    for (const k of KS) {
        const hits = outcomes.filter((o) => o.rank !== null && o.rank <= k).length;
        hitAt[k] = n ? hits / n : 0;
    }
    return { n, hitAt };
}

function byKindMetrics(outcomes: QuestionOutcome[]): Record<string, MetricsBlock> {
    const kinds: EvalQuestion['kind'][] = ['paraphrase', 'keyword', 'mixed'];
    const out: Record<string, MetricsBlock> = {};
    for (const k of kinds) {
        out[k] = computeMetrics(outcomes.filter((o) => o.kind === k));
    }
    return out;
}

async function runConfig(
    config: ConfigSpec,
    memories: Memory[],
    questions: EvalQuestion[],
    aliasesById: Map<string, AliasEntry>,
    rephrasingsByQid: Map<string, RephrasingEntry>,
    leakage: LeakageInfo,
    engineProfile: EngineProfile,
): Promise<ConfigResult> {
    const start = Date.now();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `lore-tapestry-bench-${config.id}-`));
    console.log(`[${config.id}] ${config.label} — dataDir=${tmpDir}`);

    const { lore } = await createBenchLore(tmpDir, WORKSPACE, ECOSYSTEM, engineProfile);
    try {
        const nodes = buildNodes(memories, aliasesById, config.useQuestionsAtWrite);
        const ingestResult = await lore.bulkIngest(nodes, { autolink: false, embed: 'sync' });
        if (!ingestResult.ok || ingestResult.succeeded !== memories.length) {
            const failed = ingestResult.results.filter((r) => !r.ok);
            throw new Error(
                `[${config.id}] bulkIngest failed for ${failed.length}/${ingestResult.count} nodes. First: ${JSON.stringify(failed[0])}`,
            );
        }
        console.log(`[${config.id}] ingested ${ingestResult.succeeded}/${memories.length} memories`);

        const caller: RecallCaller = makeDirectCaller(lore, config.searchMode);

        const outcomes: QuestionOutcome[] = [];
        try {
            for (const q of questions) {
                const extraQueries = config.useQueriesAtRead ? rephrasingsByQid.get(q.qid)?.queries : undefined;
                const hits = await caller.call(q.question, extraQueries);

                // Assert aliases never leak into results as their own ids —
                // mapAliasHitsToParent (core/questionAliases.ts) should have
                // already collapsed every `<parent>#q<n>` row to its parent.
                for (const h of hits) {
                    if (/#q\d+$/.test(h.id)) {
                        throw new Error(`[${config.id}] alias row id leaked into recall results: ${h.id} (qid=${q.qid})`);
                    }
                }

                // Guard against any accidental duplicate ids in one result
                // set (keep the best/first rank per id, same contract as
                // mapAliasHitsToParent's read-side dedup).
                const seen = new Set<string>();
                const dedupedIds: string[] = [];
                for (const h of hits) {
                    if (seen.has(h.id)) continue;
                    seen.add(h.id);
                    dedupedIds.push(h.id);
                }

                const idx = dedupedIds.indexOf(q.gold);
                outcomes.push({
                    qid: q.qid,
                    kind: q.kind,
                    rank: idx === -1 ? null : idx + 1,
                    leakage: leakage.byQid.get(q.qid) ?? 0,
                });
            }
        } finally {
            await caller.teardown();
        }

        const excluded = outcomes.filter((o) => !leakage.excludedQids.has(o.qid));

        return {
            id: config.id,
            label: config.label,
            searchMode: config.searchMode,
            useQuestionsAtWrite: config.useQuestionsAtWrite,
            useQueriesAtRead: config.useQueriesAtRead,
            nQuestions: outcomes.length,
            runtimeMs: Date.now() - start,
            overall: computeMetrics(outcomes),
            byKind: byKindMetrics(outcomes),
            excludingHighOverlap: {
                n: excluded.length,
                overall: computeMetrics(excluded),
                byKind: byKindMetrics(excluded),
            },
        };
    } finally {
        await lore.dispose(`tapestry-recall-bench:${config.id}`);
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

/* ─── main ──────────────────────────────────────────────────────── */

async function main() {
    const args = parseArgs(process.argv.slice(2));

    const memories = loadJsonl<Memory>(path.join(DATA_DIR, 'memories.jsonl'));
    let questions = loadJsonl<EvalQuestion>(path.join(DATA_DIR, 'questions.jsonl'));
    const aliases = loadJsonl<AliasEntry>(path.join(DATA_DIR, 'aliases.jsonl'));
    const rephrasings = loadJsonl<RephrasingEntry>(path.join(DATA_DIR, 'rephrasings.jsonl'));

    if (args.questionLimit) questions = questions.slice(0, args.questionLimit);

    const aliasesById = new Map(aliases.map((a) => [a.id, a]));
    const rephrasingsByQid = new Map(rephrasings.map((r) => [r.qid, r]));

    const leakage = computeLeakage(questions, aliasesById);
    console.log(
        `Leakage check: mean maxJaccard=${leakage.mean.toFixed(3)}, >0.7: ${leakage.countOver07}, >0.9: ${leakage.countOver09} (n=${questions.length})`,
    );

    const engineProfile: EngineProfile = args.engineName === 'sqlite' ? SQLITE_ONLY_PROFILE : SURREAL_LANCE_PROFILE;
    console.log(`Engine profile: ${args.engineName} (graph=${engineProfile.graphEngine}, vector=${engineProfile.vectorEngine})`);

    const selected = CONFIGS.filter((c) => args.configs.includes(c.id));
    const results: ConfigResult[] = [];
    for (const config of selected) {
        const r = await runConfig(config, memories, questions, aliasesById, rephrasingsByQid, leakage, engineProfile);
        results.push(r);
        console.log(`[${config.id}] done in ${(r.runtimeMs / 1000).toFixed(1)}s — top1=${r.overall.hitAt[1]!.toFixed(3)} top5=${r.overall.hitAt[5]!.toFixed(3)} top10=${r.overall.hitAt[10]!.toFixed(3)}`);
    }

    // Finding A diagnostic/reference: a plain textbook BM25 over the SAME
    // 415 memory texts, computed entirely in the harness (never inside Lore)
    // — a same-corpus baseline to compare C1 against. Always computed (cheap,
    // pure JS, no Lore instance needed) regardless of --configs.
    const referenceBm25 = runReferenceBm25(memories, questions);
    console.log(
        `[reference-bm25] top1=${referenceBm25.overall.hitAt[1]!.toFixed(3)} top5=${referenceBm25.overall.hitAt[5]!.toFixed(3)} top10=${referenceBm25.overall.hitAt[10]!.toFixed(3)}`,
    );

    let commitHash = 'unknown';
    try {
        commitHash = execSync('git rev-parse HEAD', { cwd: REPO_ROOT }).toString().trim();
    } catch { /* not fatal — recorded as 'unknown' */ }

    const output = {
        generatedAt: new Date().toISOString(),
        command: `npx tsx benchmarks/tapestry-recall/run.ts ${process.argv.slice(2).join(' ')}`.trim(),
        commit: commitHash,
        nodeVersion: process.version,
        embedder: { modelId: 'Xenova/multilingual-e5-small', dtype: process.env['LORE_LOCAL_EMBEDDING_DTYPE'] ?? 'q8', dim: 384 },
        engines:
            args.engineName === 'sqlite'
                ? { graph: 'sqlite (embedded)', vector: 'sqlite (embedded)' }
                : { graph: 'surreal (SurrealDB, embedded)', vector: 'lancedb (embedded)' },
        dataset: { nMemories: memories.length, nQuestions: questions.length },
        leakage: {
            tokenization: 'lowercase, strip non-alnum, drop small stopword list, strip suffixes ing|ed|es|s',
            mean: leakage.mean,
            countOver07: leakage.countOver07,
            countOver09: leakage.countOver09,
        },
        configs: results,
        referenceBm25: {
            description: 'Plain textbook BM25 (k1=1.2, b=0.75), harness-computed over the same 415 memory texts — see src/referenceBm25.ts. Not part of Lore; a same-corpus baseline for C1.',
            ...referenceBm25,
        },
        longmemeval: {
            status: 'not run',
            reason:
                'benchmarks/longmemeval/data/longmemeval_s_cleaned.json is not present locally (gitignored, 277MB, fetched from HuggingFace per its own README). Downloading a new external file requires explicit user permission that could not be obtained in this single automated turn — see run report.',
        },
    };

    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    const outFile = args.outFile ?? path.join(RESULTS_DIR, `${new Date().toISOString().slice(0, 10)}.json`);
    fs.writeFileSync(outFile, JSON.stringify(output, null, 2));
    console.log(`Wrote ${outFile}`);
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
