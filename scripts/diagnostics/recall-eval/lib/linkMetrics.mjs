/**
 * linkMetrics.mjs -- B4 link eval: ground truth for "is this neighbour related?"
 * and the metrics computed from recall()'s `related[]` and from the link graph.
 *
 * GROUND TRUTH (read the limits before trusting a number)
 *   The Riverstone fixture is generated, so its structure is KNOWN:
 *     - every code row, note, filler node and anchor belongs to one or more
 *       COMPONENTS (scheduler, worker-pool, ...). Code rows: their one tag.
 *       Notes: their tag plus the components named in "Also touches ...".
 *       Fillers: their tag. Anchors: component names/aliases in their tags.
 *       Dup nodes: the component their text is about (DUP_COMPONENT below).
 *     - 6 near-duplicate PAIRS (fx-dup-<topic>-a / -b) restate each other.
 *     - the 2 hub nodes carry 36 `relates_to` edges to RANDOM knowledge nodes.
 *   grade(ref, x), symmetric:
 *     3  x is ref's near-duplicate partner
 *     2  x shares a component with ref and both are curated knowledge
 *        (anchor / filler / dup)
 *     1  x shares a component with ref (any other class: note, code row)
 *     0  anything else -- including every hub edge target (random by build)
 *   "relevant" means grade >= 1, "strong" means grade >= 2, "noise" means 0.
 *
 * LIMITS (also stated in the written results)
 *   - Circular: the component name appears in the text the embedder reads, so
 *     embedding similarity and this ground truth agree more than they would
 *     for real notes. Precision here is an UPPER-leaning number.
 *   - Coarse: all 625 code rows of one component are "grade 1" to each other,
 *     and a note is grade 1 to anything in its component. There is no notion
 *     of "closer within a component".
 *   - No relation TYPES: nothing here says "contradicts", "supersedes" or
 *     "depends on". Loop D's typing value cannot be measured directly; only
 *     headroom proxies (see headroom in the written results) can.
 */
import { COMPONENTS } from './corpus.mjs';

const TAG_ALIAS = { lease: 'lease-manager', dlq: 'dead-letter-queue' };
const DUP_COMPONENT = {
    'batch-size-tuning': 'scheduler',
    'connector-timeout-default': 'connector-bus',
    'audit-log-immutability': 'audit-log',
    'cli-auth-token-scope': 'cli',
    'worker-pool-min-size': 'worker-pool',
    'retry-budget-cap': 'retry-policy',
};
const CURATED = new Set(['anchor', 'filler', 'dup']);

function classOf(id) {
    if (id.startsWith('fx-code-')) return 'code';
    if (id.startsWith('fx-note-')) return 'note';
    if (id.startsWith('fx-filler-')) return 'filler';
    if (id.startsWith('fx-dup-')) return 'dup';
    if (id.startsWith('fx-hub-')) return 'hub';
    if (id.startsWith('fx-')) return 'anchor';
    return 'other';
}

/** Builds node metadata from the deterministic corpus. */
export function buildGroundTruth(corpus) {
    const meta = new Map();
    const compSet = new Set(COMPONENTS);
    const all = [...corpus.knowledgeNodes, ...corpus.notes, ...corpus.codeRows];
    for (const n of all) {
        const cls = classOf(n.id);
        const comps = new Set();
        let dupGroup = null;
        if (cls === 'dup') {
            dupGroup = n.id.replace(/^fx-dup-/, '').replace(/-[ab]$/, '');
            if (DUP_COMPONENT[dupGroup]) comps.add(DUP_COMPONENT[dupGroup]);
        } else if (cls !== 'hub') {
            for (const t of n.tags ?? []) {
                const c = TAG_ALIAS[t] ?? t;
                if (compSet.has(c)) comps.add(c);
            }
            if (cls === 'note') {
                const m = /Also touches (.+?)\.$/.exec(n.content);
                if (m) for (const c of m[1].split(' and ')) if (compSet.has(c.trim())) comps.add(c.trim());
            }
        }
        meta.set(n.id, { id: n.id, cls, comps, dupGroup });
    }
    const dupPartner = new Map();
    const byGroup = new Map();
    for (const m of meta.values()) if (m.dupGroup) byGroup.set(m.dupGroup, [...(byGroup.get(m.dupGroup) ?? []), m.id]);
    for (const ids of byGroup.values()) if (ids.length === 2) { dupPartner.set(ids[0], ids[1]); dupPartner.set(ids[1], ids[0]); }

    const unknown = { id: '?', cls: 'other', comps: new Set(), dupGroup: null };
    const metaOf = (id) => meta.get(id) ?? unknown;

    function grade(refId, id) {
        if (refId === id) return null;
        const r = metaOf(refId), x = metaOf(id);
        if (r.dupGroup && r.dupGroup === x.dupGroup) return 3;
        for (const c of r.comps) {
            if (x.comps.has(c)) return CURATED.has(r.cls) && CURATED.has(x.cls) ? 2 : 1;
        }
        return 0;
    }

    // Best achievable grades for one reference over the WHOLE fixture (ideal-pool nDCG).
    const poolCache = new Map();
    function poolCounts(refId) {
        let c = poolCache.get(refId);
        if (c) return c;
        c = { g3: 0, g2: 0, g1: 0 };
        for (const id of meta.keys()) {
            const g = grade(refId, id);
            if (g === 3) c.g3++; else if (g === 2) c.g2++; else if (g === 1) c.g1++;
        }
        poolCache.set(refId, c);
        return c;
    }
    function idealPoolGrades(refId, k) {
        const c = poolCounts(refId);
        const out = [];
        for (const [g, n] of [[3, c.g3], [2, c.g2], [1, c.g1]]) for (let i = 0; i < n && out.length < k; i++) out.push(g);
        while (out.length < k) out.push(0);
        return out;
    }
    return { metaOf, grade, idealPoolGrades, dupPartner, classOf };
}

const gain = (g) => 2 ** g - 1;
export function dcg(grades, k) {
    let s = 0;
    for (let i = 0; i < Math.min(k, grades.length); i++) s += gain(grades[i]) / Math.log2(i + 2);
    return s;
}
/** nDCG of `grades` against the ideal ordering of `idealGrades` (same list sorted, or a pool). null when the ideal has no gain. */
export function ndcg(grades, idealGrades, k) {
    const ideal = dcg([...idealGrades].sort((a, b) => b - a), k);
    return ideal === 0 ? null : dcg(grades, k) / ideal;
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round = (x, d = 4) => (x === null || x === undefined ? null : Number(x.toFixed(d)));

/**
 * Metrics over a batch of recall results.
 * @param lists  [{ expectedIds, related: [{id, via}] }]
 * @param gt     buildGroundTruth() result
 * @param k      the cut for @k metrics (default 10)
 */
export function relatedMetrics(lists, gt, k = 10) {
    const out = { lists: lists.length, listsWithRelated: 0, meanRelated: null };
    const counts = lists.map((l) => l.related.length);
    out.meanRelated = round(mean(counts), 2);
    const nonEmpty = lists.filter((l) => l.related.length > 0);
    out.listsWithRelated = nonEmpty.length;

    for (const mode of ['seed', 'expected']) {
        const perList = nonEmpty.map((l) => {
            const grades = l.related.map((r) => {
                if (mode === 'seed') return gt.grade(r.via, r.id) ?? 0;
                return Math.max(...l.expectedIds.map((e) => gt.grade(e, r.id) ?? 0));
            });
            const ref = mode === 'expected' ? l.expectedIds[0] : null;
            const head = grades.slice(0, k);
            const frac = (g, pred) => (g.length ? g.filter(pred).length / g.length : null);
            return {
                relevantAtK: frac(head, (g) => g >= 1),
                strongAtK: frac(head, (g) => g >= 2),
                noiseAtK: frac(head, (g) => g === 0),
                relevantAll: frac(grades, (g) => g >= 1),
                noiseAll: frac(grades, (g) => g === 0),
                ndcgSet: ndcg(grades, grades, k),
                ndcgPool: ref ? ndcg(grades, gt.idealPoolGrades(ref, k), k) : null,
                slots: grades.length,
                noiseSlots: grades.filter((g) => g === 0).length,
                relSlots: grades.filter((g) => g >= 1).length,
                strongSlots: grades.filter((g) => g >= 2).length,
            };
        });
        const col = (key) => perList.map((p) => p[key]).filter((v) => v !== null && v !== undefined);
        const slots = perList.reduce((a, p) => a + p.slots, 0);
        out[mode] = {
            [`relevantAt${k}`]: round(mean(col('relevantAtK'))),
            [`strongAt${k}`]: round(mean(col('strongAtK'))),
            [`noiseAt${k}`]: round(mean(col('noiseAtK'))),
            relevantAll: round(mean(col('relevantAll'))),
            noiseAll: round(mean(col('noiseAll'))),
            [`ndcgSetAt${k}`]: round(mean(col('ndcgSet'))),
            [`ndcgPoolAt${k}`]: round(mean(col('ndcgPool'))),
            noiseSlotShare: slots ? round(perList.reduce((a, p) => a + p.noiseSlots, 0) / slots) : null,
            relevantSlotShare: slots ? round(perList.reduce((a, p) => a + p.relSlots, 0) / slots) : null,
            strongSlotShare: slots ? round(perList.reduce((a, p) => a + p.strongSlots, 0) / slots) : null,
            slots,
        };
    }

    // Per-seed ordering (clean ordering test: link ordering only reorders hops WITHIN a seed).
    const groups = [];
    for (const l of nonEmpty) {
        const bySeed = new Map();
        for (const r of l.related) bySeed.set(r.via, [...(bySeed.get(r.via) ?? []), r.id]);
        for (const [via, ids] of bySeed) groups.push({ via, grades: ids.map((id) => gt.grade(via, id) ?? 0) });
    }
    const multi = groups.filter((g) => g.grades.length >= 2);
    const nd = multi.map((g) => ndcg(g.grades, g.grades, g.grades.length)).filter((v) => v !== null);
    out.perSeed = {
        groups: groups.length,
        groupsWith2plus: multi.length,
        meanNeighbours: round(mean(groups.map((g) => g.grades.length)), 2),
        firstNeighbourRelevant: groups.length ? round(groups.filter((g) => g.grades[0] >= 1).length / groups.length) : null,
        firstNeighbourStrong: groups.length ? round(groups.filter((g) => g.grades[0] >= 2).length / groups.length) : null,
        ndcgWithinSeed: round(mean(nd)),
        groupsWithPerfectOrder: nd.length ? round(nd.filter((v) => v > 0.9999).length / nd.length) : null,
    };

    // Neighbours of the EXPECTED answer only (via == expected id): what an agent following the
    // right hit's links would see. Grades are against the seed, which here IS the expected node.
    const expGroups = [];
    const noiseByClass = {};
    for (const l of nonEmpty) {
        const ids = l.related.filter((r) => l.expectedIds.includes(r.via));
        if (ids.length) expGroups.push(ids.map((r) => gt.grade(r.via, r.id) ?? 0));
        for (const r of ids) if ((gt.grade(r.via, r.id) ?? 0) === 0) { const c = gt.metaOf(r.id).cls; noiseByClass[c] = (noiseByClass[c] ?? 0) + 1; }
    }
    const expMulti = expGroups.filter((g) => g.length >= 2);
    const expNd = expMulti.map((g) => ndcg(g, g, g.length)).filter((v) => v !== null);
    const expSlots = expGroups.reduce((a, g) => a + g.length, 0);
    out.ofExpected = {
        listsWithExpectedHit: lists.filter((l) => l.ids && l.ids.some((i) => l.expectedIds.includes(i))).length,
        listsWithNeighbours: expGroups.length,
        meanNeighbours: round(mean(expGroups.map((g) => g.length)), 2),
        relevantSlotShare: expSlots ? round(expGroups.reduce((a, g) => a + g.filter((x) => x >= 1).length, 0) / expSlots) : null,
        strongSlotShare: expSlots ? round(expGroups.reduce((a, g) => a + g.filter((x) => x >= 2).length, 0) / expSlots) : null,
        noiseSlotShare: expSlots ? round(expGroups.reduce((a, g) => a + g.filter((x) => x === 0).length, 0) / expSlots) : null,
        noiseHubShare: expSlots ? round((noiseByClass.hub ?? 0) / expSlots) : null,
        firstNeighbourRelevant: expGroups.length ? round(expGroups.filter((g) => g[0] >= 1).length / expGroups.length) : null,
        firstNeighbourStrong: expGroups.length ? round(expGroups.filter((g) => g[0] >= 2).length / expGroups.length) : null,
        ndcgWithinSeed: round(mean(expNd)),
        // ceiling for first-neighbour metrics: a group that has no relevant/strong neighbour at all cannot be fixed by ordering
        groupsWithAnyRelevant: expGroups.length ? round(expGroups.filter((g) => g.some((x) => x >= 1)).length / expGroups.length) : null,
        groupsWithAnyStrong: expGroups.length ? round(expGroups.filter((g) => g.some((x) => x >= 2)).length / expGroups.length) : null,
    };

    // Near-duplicate partner of the expected node: in the primary hits (then recall() leaves it out of
    // related, a direct hit wins), in related, or neither.
    const withPartner = lists.filter((l) => l.expectedIds.some((e) => gt.dupPartner.has(e)));
    let inHits = 0, inRelated = 0, either = 0;
    const ranks = [];
    for (const l of withPartner) {
        const partner = l.expectedIds.map((e) => gt.dupPartner.get(e)).find(Boolean);
        const h = (l.ids ?? []).includes(partner);
        const idx = l.related.findIndex((r) => r.id === partner);
        if (h) inHits++;
        if (idx >= 0) { inRelated++; ranks.push(idx + 1); }
        if (h || idx >= 0) either++;
    }
    out.dupPartner = { lists: withPartner.length, inHits, inRelated, inHitsOrRelated: either, meanRelatedRank: round(mean(ranks), 2) };
    return out;
}

function quantile(sorted, p) {
    return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null;
}

/**
 * Link-graph statistics from raw edges.
 * @param edges     [{sourceId,targetId,relation,confidenceScore}]
 * @param nodeIds   all fixture node ids (for coverage / degree denominators)
 */
export function linkGraphStats(edges, nodeIds, gt) {
    const sem = edges.filter((e) => e.relation === 'semantic_neighbor');
    const other = edges.filter((e) => e.relation !== 'semantic_neighbor');
    const deg = new Map();
    for (const e of sem) {
        deg.set(e.sourceId, (deg.get(e.sourceId) ?? 0) + 1);
        deg.set(e.targetId, (deg.get(e.targetId) ?? 0) + 1);
    }
    const classes = ['anchor', 'filler', 'dup', 'hub', 'note', 'code'];
    const byClass = {};
    for (const c of classes) {
        const ids = nodeIds.filter((id) => gt.metaOf(id).cls === c);
        const ds = ids.map((id) => deg.get(id) ?? 0).sort((a, b) => a - b);
        byClass[c] = {
            nodes: ids.length,
            withLink: ids.length ? round(ds.filter((d) => d > 0).length / ids.length) : null,
            degreeMean: round(mean(ds), 2), degreeP50: quantile(ds, 0.5), degreeP90: quantile(ds, 0.9), degreeMax: ds.length ? ds[ds.length - 1] : null,
        };
    }
    const allDeg = nodeIds.map((id) => deg.get(id) ?? 0).sort((a, b) => a - b);
    const pairKey = (e) => [gt.metaOf(e.sourceId).cls, gt.metaOf(e.targetId).cls].sort().join('+');
    const pairs = {};
    for (const e of sem) pairs[pairKey(e)] = (pairs[pairKey(e)] ?? 0) + 1;

    const grades = { g0: 0, g1: 0, g2: 0, g3: 0 };
    const scored = [];
    for (const e of sem) {
        const g = gt.grade(e.sourceId, e.targetId) ?? 0;
        grades[`g${g}`]++;
        scored.push({ s: e.confidenceScore ?? 1, g });
    }
    const buckets = [[0, 0.82], [0.82, 0.85], [0.85, 0.9], [0.9, 1.01]];
    const byScore = buckets.map(([lo, hi]) => {
        const xs = scored.filter((x) => x.s >= lo && x.s < hi);
        return {
            range: `${lo}-${Math.min(hi, 1)}`, edges: xs.length,
            relevant: xs.length ? round(xs.filter((x) => x.g >= 1).length / xs.length) : null,
            strong: xs.length ? round(xs.filter((x) => x.g >= 2).length / xs.length) : null,
            meanGrade: round(mean(xs.map((x) => x.g)), 3),
        };
    });
    // Does a higher score order edges better than chance? P(score of a graded-higher edge > lower), ties 0.5.
    const hiG = scored.filter((x) => x.g >= 1), loG = scored.filter((x) => x.g === 0);
    let auc = null;
    if (hiG.length && loG.length) {
        const sample = (xs, n) => (xs.length <= n ? xs : xs.filter((_, i) => i % Math.ceil(xs.length / n) === 0));
        const h = sample(hiG, 600), l = sample(loG, 600);
        let wins = 0;
        for (const a of h) for (const b of l) wins += a.s > b.s ? 1 : a.s === b.s ? 0.5 : 0;
        auc = round(wins / (h.length * l.length));
    }
    // Link recall over the curated knowledge nodes: of every pair that the ground truth calls grade 3 / grade 2,
    // how many are actually linked?
    const key = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
    const linked = new Set(sem.map((e) => key(e.sourceId, e.targetId)));
    const cur = nodeIds.filter((id) => ['anchor', 'filler', 'dup'].includes(gt.metaOf(id).cls));
    const rec = { g3: [0, 0], g2: [0, 0] };
    for (let i = 0; i < cur.length; i++) for (let j = i + 1; j < cur.length; j++) {
        const g = gt.grade(cur[i], cur[j]);
        if (g === 3 || g === 2) { const t = rec[`g${g}`]; t[1]++; if (linked.has(key(cur[i], cur[j]))) t[0]++; }
    }
    const linkRecall = { nearDuplicatePairs: { linked: rec.g3[0], total: rec.g3[1] }, sameComponentCuratedPairs: { linked: rec.g2[0], total: rec.g2[1] } };
    const sc = scored.map((x) => x.s).sort((a, b) => a - b);
    return {
        semanticEdges: sem.length, otherEdges: other.length,
        otherRelations: other.reduce((a, e) => ({ ...a, [e.relation]: (a[e.relation] ?? 0) + 1 }), {}),
        nodesTotal: nodeIds.length,
        nodesWithLink: round(allDeg.filter((d) => d > 0).length / Math.max(1, allDeg.length)),
        degreeMean: round(mean(allDeg), 2), degreeP50: quantile(allDeg, 0.5), degreeP90: quantile(allDeg, 0.9), degreeMax: allDeg.length ? allDeg[allDeg.length - 1] : null,
        byClass, pairs, linkRecall,
        edgeGradeShare: sem.length ? Object.fromEntries(Object.entries(grades).map(([k, v]) => [k, round(v / sem.length)])) : null,
        edgeGradeCounts: grades,
        scoreMin: sc[0] ?? null, scoreP50: quantile(sc, 0.5), scoreMax: sc.length ? sc[sc.length - 1] : null,
        byScore, scoreVsRelevantAuc: auc,
    };
}
