#!/usr/bin/env tsx
/**
 * b4-link-metrics-unit.ts -- pure-logic checks for the B4 link-eval harness
 * (scripts/diagnostics/recall-eval/lib/linkMetrics.mjs): ground-truth grades,
 * nDCG, related[] metrics and link-graph stats. No Lore instance, no embedder.
 */
import assert from 'node:assert/strict';
// @ts-expect-error plain .mjs harness module
import { buildCorpus } from '../scripts/diagnostics/recall-eval/lib/corpus.mjs';
// @ts-expect-error plain .mjs harness module
import { buildGroundTruth, dcg, ndcg, relatedMetrics, linkGraphStats } from '../scripts/diagnostics/recall-eval/lib/linkMetrics.mjs';

let passed = 0;
function t(name: string, fn: () => void) {
    fn();
    passed++;
    console.log(`ok - ${name}`);
}

const corpus = buildCorpus({ codeRowCount: 50 });
const gt = buildGroundTruth(corpus);

t('near-duplicate partners grade 3 both ways; self is null', () => {
    assert.equal(gt.grade('fx-dup-batch-size-tuning-a', 'fx-dup-batch-size-tuning-b'), 3);
    assert.equal(gt.grade('fx-dup-batch-size-tuning-b', 'fx-dup-batch-size-tuning-a'), 3);
    assert.equal(gt.grade('fx-dup-batch-size-tuning-a', 'fx-dup-batch-size-tuning-a'), null);
    assert.equal(gt.dupPartner.get('fx-dup-batch-size-tuning-a'), 'fx-dup-batch-size-tuning-b');
});

t('hub nodes grade 0 against everything; classes are right', () => {
    assert.equal(gt.grade('fx-decision-lease-ttl', 'fx-hub-glossary'), 0);
    assert.equal(gt.classOf('fx-hub-glossary'), 'hub');
    assert.equal(gt.classOf('fx-code-000001'), 'code');
    assert.equal(gt.classOf('fx-note-0001'), 'note');
    assert.equal(gt.classOf('fx-filler-decision-000'), 'filler');
});

t('grades are symmetric over a sample of the fixture', () => {
    const ids = [...corpus.knowledgeNodes, ...corpus.notes, ...corpus.codeRows].map((n: { id: string }) => n.id).slice(0, 120);
    for (const a of ids) for (const b of ids) assert.equal(gt.grade(a, b), gt.grade(b, a), `${a} vs ${b}`);
});

t('curated pair sharing a component is 2, curated vs code row sharing it is 1', () => {
    const curated = ['anchor', 'filler', 'dup'];
    const ids = corpus.knowledgeNodes.map((n: { id: string }) => n.id).filter((id: string) => curated.includes(gt.classOf(id)));
    const pair = ids.flatMap((a: string) => ids.map((b: string) => [a, b])).find(([a, b]: string[]) => a !== b && gt.grade(a, b) === 2);
    assert.ok(pair, 'expected at least one grade-2 curated pair');
    const [a] = pair as string[];
    const code = corpus.codeRows.map((n: { id: string }) => n.id).find((id: string) => gt.grade(a, id) === 1);
    assert.ok(code, 'expected a code row graded 1 against a curated node');
});

t('dcg / ndcg: ideal order scores 1, reversed scores less, no-gain is null', () => {
    assert.ok(Math.abs(ndcg([3, 2, 1, 0], [3, 2, 1, 0], 4)! - 1) < 1e-12);
    assert.ok(ndcg([0, 1, 2, 3], [3, 2, 1, 0], 4)! < 1);
    assert.equal(ndcg([0, 0], [0, 0], 2), null);
    assert.ok(dcg([1], 1) === 1);
});

t('relatedMetrics: order change moves nDCG and first-neighbour, not the set share', () => {
    const seed = 'fx-dup-batch-size-tuning-a';
    const good = 'fx-dup-batch-size-tuning-b'; // grade 3
    const noise = 'fx-hub-glossary'; // grade 0
    const mk = (related: string[]) => ({ expectedIds: [seed], ids: [seed], related: related.map((id) => ({ id, via: seed, relation: 'semantic_neighbor', depth: 1 })) });
    const best = relatedMetrics([mk([good, noise])], gt, 10);
    const worst = relatedMetrics([mk([noise, good])], gt, 10);
    assert.equal(best.expected.relevantAt10, worst.expected.relevantAt10);
    assert.ok(best.expected.ndcgSetAt10 > worst.expected.ndcgSetAt10);
    assert.equal(best.listsWithRelated, 1);
});

t('relatedMetrics: empty related lists are counted, not crashed on', () => {
    const m = relatedMetrics([{ expectedIds: ['fx-decision-lease-ttl'], ids: [], related: [] }], gt, 10);
    assert.equal(m.lists, 1);
    assert.equal(m.listsWithRelated, 0);
});

t('linkGraphStats: counts semantic edges apart from others and sees degree', () => {
    const nodeIds = ['fx-dup-batch-size-tuning-a', 'fx-dup-batch-size-tuning-b', 'fx-hub-glossary'];
    const edges = [
        { sourceId: nodeIds[0], targetId: nodeIds[1], relation: 'semantic_neighbor', confidenceScore: 0.95 },
        { sourceId: nodeIds[2], targetId: nodeIds[0], relation: 'relates_to', confidenceScore: 0.6 },
    ];
    const g = linkGraphStats(edges, nodeIds, gt);
    assert.equal(g.semanticEdges, 1);
    assert.equal(g.otherEdges, 1);
    assert.equal(g.linkRecall.nearDuplicatePairs.linked >= 1, true);
});

console.log(`\n${passed} passed, 0 failed`);
