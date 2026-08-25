/**
 * test/recall-benchmarks/runBenchmarks.ts — Sprint R benchmark harness.
 *
 * Drives the ranking pipeline in-process (no daemon, no Kùzu, no
 * LanceDB) against a synthetic corpus that mirrors the Day-1 dogfood
 * failure pattern: each operator-curated "decision" / "convention" etc.
 * node is buried under ~5–10 noisy `code-symbol` nodes with comparable
 * vector-similarity scores. A correct ranking pulls the curated nodes
 * to the top; the legacy pure-vector ranking buries them.
 *
 * The harness intentionally does NOT call a real embedder. The
 * "vector-similarity" score is precomputed per (question, node) by
 * keyword overlap so the same suite runs deterministically on every
 * machine, in CI, and in seconds. The contract under test is the
 * RANKING LAYER ON TOP OF a vector store — that's what Sprint R is
 * implementing. End-to-end vector quality is a separate concern.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { rankScore } from '../../packages/lore/src/recall/ranking.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface Question {
    id: string;
    topic: string;
    expectedTypes: string[];
    expectedKeywords: string[];
    minMatchesInTop5: number;
    minMatchesInTop10: number;
}

interface CorpusNode {
    id: string;
    type: string;
    label: string;
    content: string;
    tags: string;
    updatedAt: string;
    metadata: string | null;
}

interface PerQuestionResult {
    id: string;
    topic: string;
    precisionAt5: number;
    recallAt10: number;
    top5: Array<{ id: string; type: string; score: number }>;
}

export interface BenchmarkResult {
    precisionAt5: number;
    recallAt10: number;
    perQuestion: PerQuestionResult[];
    corpusSize: number;
    questionCount: number;
}

/**
 * Build a synthetic corpus that reproduces the Day-1 failure mode:
 * for each question we plant 1-2 operator-curated answer nodes plus
 * 5-10 code-symbol decoys whose keyword overlap with the topic is
 * COMPARABLE to the real answers. Legacy ranking returns decoys
 * first; the new ranking should bury them.
 */
function buildCorpus(questions: Question[]): CorpusNode[] {
    const nodes: CorpusNode[] = [];
    const now = Date.now();
    const day = 86_400_000;

    for (let qi = 0; qi < questions.length; qi++) {
        const q = questions[qi];
        // 1-2 real answers — curated types, recent. Identical surface
        // text to the decoys below so the synthetic base score is
        // IDENTICAL — the only thing that can separate real from decoy
        // is type-bias / curation / recency, which is exactly the
        // signal Sprint R adds. Without ranking, real and decoy tie
        // and decoys win by sheer count.
        const realAnswerCount = (qi % 2 === 0) ? 2 : 1;
        const sharedLabel = `${q.topic} ${q.expectedKeywords.join(' ')}`;
        const sharedContent = `${q.topic}. ${q.expectedKeywords.join(' ')}.`;
        const sharedTags = q.expectedKeywords.join(',');
        // Decoys inserted FIRST so that under stub ranking (identical
        // base scores → stable sort by insertion order) decoys win the
        // top-5 — that's the Day-1 dogfood reproduction. Real answers
        // tail behind.
        const decoyCount = 5 + (qi % 4);
        for (let d = 0; d < decoyCount; d++) {
            nodes.push({
                id: `${q.id}-decoy-${d}`,
                type: 'code-symbol',
                label: sharedLabel,
                content: sharedContent,
                tags: sharedTags,
                updatedAt: new Date(now - (qi * day) - (d * 3600_000)).toISOString(),
                metadata: null,
            });
        }
        for (let r = 0; r < realAnswerCount; r++) {
            const t = q.expectedTypes[r % q.expectedTypes.length];
            nodes.push({
                id: `${q.id}-real-${r}`,
                type: t,
                label: sharedLabel,
                content: sharedContent,
                tags: sharedTags,
                updatedAt: new Date(now - (qi * day)).toISOString(),
                metadata: null,
            });
        }
    }

    return nodes;
}

/**
 * Synthetic "vector similarity" score for (question, node):
 * keyword overlap / question keyword count. Deterministic, reproducible,
 * captures the failure mode where multiple types of nodes match the
 * same keywords with comparable base scores.
 */
function synthBaseScore(q: Question, n: CorpusNode): number {
    const text = `${n.label} ${n.content} ${n.tags} ${n.type}`.toLowerCase();
    const kws = q.expectedKeywords.map((k) => k.toLowerCase());
    let hits = 0;
    for (const k of kws) if (text.includes(k)) hits++;
    // Also reward topic-word overlap so the score is in [0, 1] and
    // mirrors the "comparable cosine" failure mode.
    const topicWords = q.topic.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
    let twHits = 0;
    for (const w of topicWords) if (text.includes(w)) twHits++;
    const denom = (kws.length + topicWords.length) || 1;
    const raw = (hits + twHits) / denom;
    // Squash into [0.4, 0.95] so all candidates have non-zero base
    // and there's room for ranking signals to matter.
    return 0.4 + (raw * 0.55);
}

function isExpected(q: Question, n: CorpusNode): boolean {
    return q.expectedTypes.includes(n.type);
}

export async function runBenchmarks(): Promise<BenchmarkResult> {
    const qPath = path.join(__dirname, 'questions.json');
    const raw = JSON.parse(fs.readFileSync(qPath, 'utf8')) as { questions: Question[] };
    const questions = raw.questions;
    const corpus = buildCorpus(questions);
    const now = Date.now();

    const perQuestion: PerQuestionResult[] = [];
    for (const q of questions) {
        const scored = corpus.map((n) => ({
            node: n,
            score: rankScore({
                node: { type: n.type, updatedAt: n.updatedAt, metadata: n.metadata },
                baseScore: synthBaseScore(q, n),
                nowMs: now,
            }),
        })).sort((a, b) => b.score - a.score);

        const top5 = scored.slice(0, 5);
        const top10 = scored.slice(0, 10);
        const matchesIn5 = top5.filter((s) => isExpected(q, s.node)).length;
        const matchesIn10 = top10.filter((s) => isExpected(q, s.node)).length;
        const expectedTotal = corpus.filter((n) => isExpected(q, n) && n.id.startsWith(`${q.id}-real`)).length;

        perQuestion.push({
            id: q.id,
            topic: q.topic,
            precisionAt5: matchesIn5 >= q.minMatchesInTop5 ? 1 : 0,
            recallAt10: expectedTotal === 0 ? 1 : Math.min(1, matchesIn10 / expectedTotal),
            top5: top5.map((s) => ({ id: s.node.id, type: s.node.type, score: Number(s.score.toFixed(4)) })),
        });
    }

    const precisionAt5 = perQuestion.reduce((a, b) => a + b.precisionAt5, 0) / perQuestion.length;
    const recallAt10 = perQuestion.reduce((a, b) => a + b.recallAt10, 0) / perQuestion.length;

    return {
        precisionAt5,
        recallAt10,
        perQuestion,
        corpusSize: corpus.length,
        questionCount: questions.length,
    };
}

// Allow direct invocation: `tsx test/recall-benchmarks/runBenchmarks.ts`
const isDirectRun = (() => {
    try {
        const argv1 = process.argv[1] ? path.resolve(process.argv[1]) : '';
        const self = fileURLToPath(import.meta.url);
        return argv1 === self;
    } catch { return false; }
})();
if (isDirectRun) {
    runBenchmarks().then((r) => {
        console.log(JSON.stringify(r, null, 2));
    });
}
