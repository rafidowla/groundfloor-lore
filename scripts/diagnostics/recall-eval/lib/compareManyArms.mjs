/**
 * compareManyArms.mjs -- C1: N-arm comparison of runner.mjs reports for the related[] trims
 * (per-hit cap, hub-degree drop). Called from compareLinkArms.mjs when --arm is given.
 * The first arm is the baseline; primary top-10 lists of every arm are diffed against it
 * (and against the links-off report when --off is passed). Ground truth: lib/linkMetrics.mjs.
 */
import * as fs from 'node:fs';

const pct = (x) => (x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const num = (x, d = 3) => (x === null || x === undefined ? 'n/a' : Number(x).toFixed(d));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function run({ armArgs, off, outBase, title }) {
    if (!outBase) { console.error('usage: compareLinkArms.mjs --arm "label=file.json" [--arm ...] [--off links-off.json] --out BASE'); process.exit(1); }
    const arms = armArgs.map((a) => { const i = a.lastIndexOf('='); return { label: a.slice(0, i), file: a.slice(i + 1), r: JSON.parse(fs.readFileSync(a.slice(i + 1), 'utf8')) }; });
    const offR = off ? JSON.parse(fs.readFileSync(off, 'utf8')) : null;
    const base = arms[0].r;
    const lists = (r) => r.perQuestion.flatMap((q) => ['terse', 'chatty'].map((ph) => q[ph]));
    const identical = (a, b) => { const la = lists(a), lb = lists(b); return la.filter((x, i) => same(x.ids, lb[i].ids)).length; };
    const nLists = lists(base).length;
    const rel = (r) => r.links.related;

    // related-list shape and hub share (hub nodes are the fixture's `fx-hub-*` ids)
    const shape = (r) => {
        const ls = lists(r);
        const sizes = ls.map((l) => l.related.length);
        const slots = sizes.reduce((a, b) => a + b, 0);
        const hubSlots = ls.reduce((a, l) => a + l.related.filter((x) => String(x.id).startsWith('fx-hub-')).length, 0);
        const perHit = new Map();
        let maxPerHit = 0;
        ls.forEach((l, li) => { for (const x of l.related) { const k = `${li}|${x.via}`; const v = (perHit.get(k) ?? 0) + 1; perHit.set(k, v); if (v > maxPerHit) maxPerHit = v; } });
        return { meanSize: slots / ls.length, hubShare: slots ? hubSlots / slots : null, listsWithHub: ls.filter((l) => l.related.some((x) => String(x.id).startsWith('fx-hub-'))).length, maxPerHit, empty: sizes.filter((n) => n === 0).length };
    };
    const lat = (r) => `${num(r.latency.p50, 1)} / ${num(r.latency.p95, 1)}`;

    const cols = arms.map((a) => a.label);
    const head = `| metric | ${cols.join(' | ')} |\n|---|${cols.map(() => '---').join('|')}|`;
    const row = (label, fn) => `| ${label} | ${arms.map((a) => fn(a.r)).join(' | ')} |`;
    const answerRelevantPerList = (r) => { const o = rel(r).ofExpected; return o.meanNeighbours * (o.relevantSlotShare ?? 0); };

    const table = [head,
        row('PRIMARY HITS', () => ''),
        `| top-10 identical to the baseline arm (of ${nLists} lists) | ${arms.map((a) => identical(base, a.r)).join(' | ')} |`,
        ...(offR ? [`| top-10 identical to links-off (of ${nLists} lists) | ${arms.map((a) => identical(offR, a.r)).join(' | ')} |`] : []),
        row('hit@1 / hit@3 chatty', (r) => `${pct(r.aggregate.hit1)} / ${pct(r.aggregate.hit3)}`),
        row('FIRST NEIGHBOUR OF THE EXPECTED ANSWER', () => ''),
        row('  first neighbour relevant', (r) => pct(rel(r).ofExpected.firstNeighbourRelevant)),
        row('  first neighbour strong', (r) => pct(rel(r).ofExpected.firstNeighbourStrong)),
        row('  lists where the answer keeps any neighbour (of ' + rel(base).ofExpected.listsWithExpectedHit + ')', (r) => `${rel(r).ofExpected.listsWithNeighbours}`),
        row('  lists where the answer keeps a relevant neighbour (ceiling)', (r) => pct(rel(r).ofExpected.groupsWithAnyRelevant)),
        row('  lists where the answer keeps a strong neighbour (ceiling)', (r) => pct(rel(r).ofExpected.groupsWithAnyStrong)),
        row('  neighbours of the answer per list / relevant ones per list', (r) => `${num(rel(r).ofExpected.meanNeighbours, 2)} / ${num(answerRelevantPerList(r), 2)}`),
        row('WHOLE related[] vs the expected answer', () => ''),
        row('  mean items per list', (r) => num(shape(r).meanSize, 1)),
        row('  precision@10 (relevant)', (r) => pct(rel(r).expected.relevantAt10)),
        row('  strong@10', (r) => pct(rel(r).expected.strongAt10)),
        row('  noise slot share (all slots)', (r) => pct(rel(r).expected.noiseSlotShare)),
        row('  nDCG@10, order only', (r) => num(rel(r).expected.ndcgSetAt10)),
        row('WHOLE related[] vs the hit each neighbour hangs off', () => ''),
        row('  precision@10 (relevant)', (r) => pct(rel(r).seed.relevantAt10)),
        row('  noise slot share (all slots)', (r) => pct(rel(r).seed.noiseSlotShare)),
        row('HUBS AND SIZE', () => ''),
        row('  hub nodes as share of related slots', (r) => pct(shape(r).hubShare)),
        row('  lists with a hub node in related[] (of ' + nLists + ')', (r) => `${shape(r).listsWithHub}`),
        row('  largest group under one hit', (r) => `${shape(r).maxPerHit}`),
        row('  lists with an empty related[]', (r) => `${shape(r).empty}`),
        row('recall() latency p50 / p95 (ms)', (r) => lat(r)),
    ].join('\n');

    const c = base.config;
    const md = `# ${title ?? 'Link eval C1: related[] cap and hub exclusion'}

Question: with link ordering ON (the new default), how much do a per-hit neighbour cap and a hub-degree drop improve the related[] list, and do they leave the primary hits alone?

Setup: SQLite graph + vector, real embedder (Xenova/multilingual-e5-small, q8, 384 dims, local ONNX), ${c.codeRows} code rows (${base.fixture.counts.knowledge} knowledge nodes, ${base.fixture.counts.notes} notes), depth ${c.depth}, search mode ${c.searchMode}, max ${c.max}, questions ${c.questionsFiles} (${base.aggregate.n_questions} questions x terse + chatty = ${nLists} recall calls per arm). Links from link-on-arrival (minSim 0.80, k 5), the same cached fixture as the B4 links-on arms. Arms differ only in createLore({ recallLinkOrdering, recallRelated }). Same seed and corpus in every arm; one run per arm (the pipeline is deterministic).

Arms: ${arms.map((a) => `**${a.label}** (ordering ${a.r.config.linkOrdering ? 'on' : 'off'}, cap ${a.r.config.relatedPerHit ?? 'off'}, hub degree > ${a.r.config.relatedMaxDegree ?? 'off'})`).join('; ')}.

Grades (lib/linkMetrics.mjs): 3 near-duplicate partner, 2 same component and both curated knowledge, 1 same component (note or code row), 0 unrelated. "Relevant" is grade >= 1, "strong" >= 2.

${table}

## Limits

- Synthetic corpus: the component name is in the text the embedder reads, so similarity and ground truth agree more than on real notes; precision leans optimistic.
- 97% of links are code-to-code between near-identical generated rows. The two hub nodes (\`fx-hub-*\`) have link degree 5 plus 18 explicit \`relates_to\` edges each. Real hubs (a glossary, an index note) are likelier to have hundreds of links, so absolute thresholds here do not transfer; the degree distribution is in link-eval-2026-10-24.md.
- Hubs are graded 0 against everything, so removing them always looks like a gain. A hub that a human would call loosely relevant is counted as noise.
- Fixture degree: mean 8.4, p50 7, p90 13, max 65 (links only; the hubs add explicit edges).
- One embedder, one corpus, SQLite only; Postgres runs the same code path but was not measured.
`;
    fs.mkdirSync(outBase.replace(/[^/]*$/, '') || '.', { recursive: true });
    fs.writeFileSync(`${outBase}.md`, md);
    fs.writeFileSync(`${outBase}.json`, JSON.stringify({
        generatedAt: new Date().toISOString(),
        config: { codeRows: c.codeRows, depth: c.depth, embedder: c.embedder, engine: c.engine, searchMode: c.searchMode, max: c.max, questionsFiles: c.questionsFiles },
        arms: arms.map((a) => ({
            label: a.label,
            settings: { linkOrdering: a.r.config.linkOrdering, relatedPerHit: a.r.config.relatedPerHit ?? null, relatedMaxDegree: a.r.config.relatedMaxDegree ?? null },
            primaryIdenticalToBaseline: identical(base, a.r), primaryIdenticalToLinksOff: offR ? identical(offR, a.r) : null, lists: nLists,
            primary: { hit1: a.r.aggregate.hit1, hit3: a.r.aggregate.hit3, mrr: a.r.aggregate.mrr, latency: a.r.latency },
            shape: shape(a.r), related: a.r.links.related,
        })),
    }, null, 2));
    console.log(`wrote ${outBase}.md and ${outBase}.json`);
}
