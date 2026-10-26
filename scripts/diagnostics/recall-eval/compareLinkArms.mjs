#!/usr/bin/env node
/**
 * compareLinkArms.mjs -- B4: turns three runner.mjs reports into one link-eval
 * comparison (markdown + json).
 *
 *   node scripts/diagnostics/recall-eval/compareLinkArms.mjs \
 *     --off arm-a.json --unordered arm-b.json --ordered arm-c.json --out results/link-eval-2026-10-24
 *
 * Arms (all depth 1, same questions, same seed):
 *   off        runner ... --depth 1
 *   unordered  runner ... --depth 1 --link-on-arrival
 *   ordered    runner ... --depth 1 --link-on-arrival --link-ordering
 * Ground truth + its limits: lib/linkMetrics.mjs. No product code is touched.
 *
 * C1 mode (any number of arms, e.g. ordering on / + per-hit cap / + hub exclusion):
 *   node scripts/diagnostics/recall-eval/compareLinkArms.mjs \
 *     --arm "ordering on=a.json" --arm "cap 3=b.json" ... [--off links-off.json] --out BASE
 *   The first --arm is the baseline; every arm's primary top-10 lists are compared with it (and with --off when given).
 */
import * as fs from 'node:fs';

const argv = process.argv.slice(2);
const arg = (f) => { const i = argv.indexOf(f); return i === -1 ? null : argv[i + 1]; };
const armArgs = argv.flatMap((a, i) => (a === '--arm' ? [argv[i + 1]] : []));
if (armArgs.length > 0) { await import('./lib/compareManyArms.mjs').then((m) => m.run({ armArgs, off: arg('--off'), outBase: arg('--out'), title: arg('--title') })); process.exit(0); }
const files = { off: arg('--off'), unordered: arg('--unordered'), ordered: arg('--ordered') };
const outBase = arg('--out');
if (!files.off || !files.unordered || !files.ordered || !outBase) {
    console.error('usage: compareLinkArms.mjs --off A.json --unordered B.json --ordered C.json --out BASE');
    process.exit(1);
}
const R = Object.fromEntries(Object.entries(files).map(([k, f]) => [k, JSON.parse(fs.readFileSync(f, 'utf8'))]));
const ARMS = ['off', 'unordered', 'ordered'];
const pct = (x) => (x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const num = (x, d = 3) => (x === null || x === undefined ? 'n/a' : Number(x).toFixed(d));
const row = (label, fn) => `| ${label} | ${ARMS.map((a) => fn(R[a])).join(' | ')} |`;
const head = '| metric | links off | links on, ordering off | links on, ordering on |\n|---|---|---|---|';

// (a) primary results unchanged?
const sameIds = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const primary = {};
for (const arm of ['unordered', 'ordered']) {
    let lists = 0, identical = 0;
    R.off.perQuestion.forEach((q, i) => {
        for (const ph of ['terse', 'chatty']) {
            lists++;
            if (sameIds(q[ph].ids, R[arm].perQuestion[i][ph].ids)) identical++;
        }
    });
    primary[arm] = { lists, identicalTop10: identical };
}
const agg = (r) => r.aggregate;
const primaryTable = [head,
    row('hit@1 chatty', (r) => pct(agg(r).hit1)),
    row('hit@3 chatty', (r) => pct(agg(r).hit3)),
    row('MRR chatty', (r) => num(agg(r).mrr)),
    row('hit@1 terse', (r) => pct(agg(r).hit1Terse)),
    row('hit@3 terse', (r) => pct(agg(r).hit3Terse)),
    row('MRR terse', (r) => num(agg(r).mrrTerse)),
    row('identifiers rank1 / hit@3 / found@10', (r) => `${pct(agg(r).identifiers?.rank1)} / ${pct(agg(r).identifiers?.hit3)} / ${pct(agg(r).identifiers?.found10)}`),
    row('gibberish zero-hit', (r) => pct(agg(r).zeroHitGibberishPct)),
    row('recall() latency p50 / p95 (ms)', (r) => `${num(r.latency.p50, 1)} / ${num(r.latency.p95, 1)}`),
    `| top-10 identical to links-off (of ${primary.unordered.lists} lists) | - | ${primary.unordered.identicalTop10} | ${primary.ordered.identicalTop10} |`,
].join('\n');

// (b) related[] quality
const rel = (r) => r.links.related;
const relTable = [head,
    row('lists with any related (of ' + rel(R.off).lists + ')', (r) => `${rel(r).listsWithRelated}`),
    row('mean related items per list', (r) => num(rel(r).meanRelated, 1)),
    row('NEIGHBOURS OF THE EXPECTED ANSWER', () => ''),
    row('  lists where the answer has neighbours (of ' + rel(R.off).ofExpected.listsWithExpectedHit + ' where it was a hit)', (r) => `${rel(r).ofExpected.listsWithNeighbours}`),
    row('  mean neighbours of the answer', (r) => num(rel(r).ofExpected.meanNeighbours, 1)),
    row('  relevant (grade >= 1)', (r) => pct(rel(r).ofExpected.relevantSlotShare)),
    row('  strong (grade >= 2)', (r) => pct(rel(r).ofExpected.strongSlotShare)),
    row('  noise (grade 0)', (r) => pct(rel(r).ofExpected.noiseSlotShare)),
    row('  of which hub nodes', (r) => pct(rel(r).ofExpected.noiseHubShare)),
    row('  first neighbour relevant', (r) => pct(rel(r).ofExpected.firstNeighbourRelevant)),
    row('  first neighbour strong', (r) => pct(rel(r).ofExpected.firstNeighbourStrong)),
    row('  nDCG of the order (within the answer\'s neighbours)', (r) => num(rel(r).ofExpected.ndcgWithinSeed)),
    row('  ceiling: groups with any relevant / any strong neighbour', (r) => `${pct(rel(r).ofExpected.groupsWithAnyRelevant)} / ${pct(rel(r).ofExpected.groupsWithAnyStrong)}`),
    row('WHOLE related[] (neighbours of all 10 hits), judged against the expected answer', () => ''),
    row('  precision@10 (relevant)', (r) => pct(rel(r).expected.relevantAt10)),
    row('  strong@10', (r) => pct(rel(r).expected.strongAt10)),
    row('  noise slot share (all slots)', (r) => pct(rel(r).expected.noiseSlotShare)),
    row('  nDCG@10, order only', (r) => num(rel(r).expected.ndcgSetAt10)),
    row('  nDCG@10, vs best possible in fixture', (r) => num(rel(r).expected.ndcgPoolAt10)),
    row('WHOLE related[], judged against the hit each neighbour hangs off', () => ''),
    row('  precision@10 (relevant)', (r) => pct(rel(r).seed.relevantAt10)),
    row('  noise slot share (all slots)', (r) => pct(rel(r).seed.noiseSlotShare)),
    row('  nDCG@10, order only', (r) => num(rel(r).seed.ndcgSetAt10)),
    row('PER-HIT ORDERING (all hits, groups of >= 2 neighbours)', () => ''),
    row('  first neighbour relevant', (r) => pct(rel(r).perSeed.firstNeighbourRelevant)),
    row('  nDCG within hit', (r) => num(rel(r).perSeed.ndcgWithinSeed)),
    row('  groups in perfect order', (r) => pct(rel(r).perSeed.groupsWithPerfectOrder)),
    row('NEAR-DUPLICATE PARTNER (12 lists where the answer has one)', () => ''),
    row('  partner already a primary hit', (r) => `${rel(r).dupPartner.inHits}`),
    row('  partner in related', (r) => `${rel(r).dupPartner.inRelated}`),
    row('  partner in hits or related', (r) => `${rel(r).dupPartner.inHitsOrRelated}`),
].join('\n');

// link graph (identical for the two links-on arms, same fixture)
const G = R.unordered.links.graph;
const OFFG = R.off.links.graph;
const classRows = Object.entries(G.byClass).map(([c, v]) => `| ${c} | ${v.nodes} | ${pct(v.withLink)} | ${v.degreeMean} | ${v.degreeP50} | ${v.degreeP90} | ${v.degreeMax} |`).join('\n');
const scoreRows = G.byScore.filter((b) => b.edges > 0).map((b) => `| ${b.range} | ${b.edges} | ${pct(b.relevant)} | ${pct(b.strong)} |`).join('\n');
const pairRows = Object.entries(G.pairs).sort((a, b) => b[1] - a[1]).map(([k, v]) => `| ${k} | ${v} | ${pct(v / G.semanticEdges)} |`).join('\n');
const graphMd = `Links-off fixture: ${OFFG.semanticEdges} semantic edges, ${OFFG.otherEdges} other edges (the 36 hub \`relates_to\` edges).
Links-on fixture: ${G.semanticEdges} semantic_neighbor edges over ${G.nodesTotal} nodes (${pct(G.nodesWithLink)} of nodes have at least one), degree mean ${G.degreeMean}, p50 ${G.degreeP50}, p90 ${G.degreeP90}, max ${G.degreeMax}; edge score min ${num(G.scoreMin)}, p50 ${num(G.scoreP50)}, max ${num(G.scoreMax)}. Build: link queue settled in ${R.unordered.fixture.linkBuild?.settleMs ?? 'n/a'} ms.

| class | nodes | has a link | degree mean | p50 | p90 | max |
|---|---|---|---|---|---|---|
${classRows}

Edge quality against the ground truth: ${pct(G.edgeGradeShare.g0)} of edges join unrelated nodes (grade 0), ${pct(G.edgeGradeShare.g1)} grade 1, ${pct(G.edgeGradeShare.g2)} grade 2, ${pct(G.edgeGradeShare.g3)} grade 3 (near-duplicate pairs).
Link recall among curated knowledge nodes: near-duplicate pairs linked ${G.linkRecall.nearDuplicatePairs.linked}/${G.linkRecall.nearDuplicatePairs.total}; same-component curated pairs linked ${G.linkRecall.sameComponentCuratedPairs.linked}/${G.linkRecall.sameComponentCuratedPairs.total}.
Does the edge score order edges? Probability that a related edge outscores an unrelated one: ${num(G.scoreVsRelevantAuc, 2)} (0.5 = chance).

| edge score | edges | relevant | strong |
|---|---|---|---|
${scoreRows}

| endpoint classes | edges | share |
|---|---|---|
${pairRows}
`;

const c = R.ordered.config;
const md = `# Link eval (B4) -- 2026-10-24

Question: do inferred links (a) leave primary recall unchanged, (b) make related[] better, with link ordering on vs off, and (c) is there headroom for relation typing (Loop D)?

Setup: SQLite graph + vector, real embedder (Xenova/multilingual-e5-small, q8, 384 dims, local ONNX), ${c.codeRows} code rows (${R.off.fixture.counts.knowledge} knowledge nodes, ${R.off.fixture.counts.notes} notes), depth ${c.depth}, search mode ${c.searchMode}, max ${c.max}, questions ${c.questionsFiles} (${R.off.aggregate.n_questions} questions x terse + chatty = ${rel(R.off).lists} recall calls per arm). Links come from link-on-arrival (e5-small policy: minSim 0.80, k 5). Ordering = createLore({recallLinkOrdering}). Same seed and corpus in every arm; one run per arm (the pipeline is deterministic, three repeat runs of each arm gave identical numbers).

## (a) Primary recall unchanged?

${primaryTable}

## (b) related[] quality

Grades (lib/linkMetrics.mjs): 3 near-duplicate partner, 2 same component and both curated knowledge, 1 same component (note or code row), 0 unrelated. "Relevant" is grade >= 1, "strong" >= 2. Judged against the expected answer or against the hit the neighbour hangs off, as labelled.

${relTable}

## Link graph

${graphMd}
## Limits (read before relying on any number here)

- Synthetic: the corpus is generated from component templates. The component name appears in the text the embedder reads, so similarity and ground truth agree more than they would on real notes. Precision here leans optimistic.
- Coarse ground truth: every code row and chat note of a component is "grade 1" to everything else in that component, and there is no "closer within a component". 97% of the links are code-to-code between near-identical generated rows, which says little about links between real knowledge.
- Curated knowledge is small (24 anchors, 42 fillers, 12 near-duplicates): the knowledge-to-knowledge numbers rest on a few hundred slots.
- Hub nodes (system overview, glossary) are graded 0 against everything although a human might call them loosely related. A topically close node in another component (for example the observability-vendor decision next to metrics naming) is also graded 0.
- No relation types exist in the fixture, so what typing would add cannot be measured. Only headroom proxies are reported.
- One embedder, one threshold policy, one corpus, SQLite only. Not tested: Postgres, other models, large real notes, 100k rows.
`;

fs.mkdirSync(outBase.replace(/[^/]*$/, '') || '.', { recursive: true });
fs.writeFileSync(`${outBase}.md`, md);
const jsonOut = {
    generatedAt: new Date().toISOString(),
    config: { codeRows: c.codeRows, depth: c.depth, embedder: c.embedder, engine: c.engine, searchMode: c.searchMode, max: c.max, questionsFiles: c.questionsFiles },
    primaryUnchanged: primary,
    arms: Object.fromEntries(ARMS.map((a) => [a, {
        primary: { hit1: agg(R[a]).hit1, hit3: agg(R[a]).hit3, mrr: agg(R[a]).mrr, hit1Terse: agg(R[a]).hit1Terse, hit3Terse: agg(R[a]).hit3Terse, mrrTerse: agg(R[a]).mrrTerse, identifiers: agg(R[a]).identifiers, zeroHitGibberishPct: agg(R[a]).zeroHitGibberishPct, latency: R[a].latency },
        related: R[a].links.related,
        graph: R[a].links.graph,
    }])),
};
fs.writeFileSync(`${outBase}.json`, JSON.stringify(jsonOut, null, 2));
console.log(`wrote ${outBase}.md and ${outBase}.json`);
