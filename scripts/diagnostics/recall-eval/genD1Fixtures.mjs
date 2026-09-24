#!/usr/bin/env node
/**
 * genD1Fixtures.mjs — D1 (calibrated relevance + abstention).
 *
 * Generates the two D1-specific eval fixtures the design doc requires beyond
 * D0's questions.json/gibberish.json:
 *
 *   - gibberish-heldout.json (>=60 queries): a SECOND, independent
 *     no-overlap gibberish set, distinct from gibberish.json's word bank AND
 *     domains, used to verify abstention generalizes rather than being
 *     tuned to the one set it was developed against. Verified to have zero
 *     token overlap with (a) the Riverstone corpus vocabulary, (b) the 24
 *     real questions' text, (c) the 128 calibration probes
 *     (calibrationProbes.ts) — calibration must never be tested against the
 *     exact same text it was fit on — and (d) gibberish.json itself.
 *
 *   - distractors.json (>=24): hand-authored, Riverstone-*plausible*
 *     in-domain questions the fixture genuinely does not answer (GDPR
 *     deletion, which CI provider, SSL cert renewal, ...). These are
 *     coherent, on-topic-sounding software-ops questions — NOT gibberish —
 *     so they stress the harder "is this workspace about this at all"
 *     boundary the design doc's section 5 flags as unsolved by a similarity
 *     floor alone (no pass bar; reported for visibility only).
 *
 * Run once (already committed as output); re-run only if anchors.mjs,
 * corpus.mjs, or calibrationProbes.ts's probe text changes:
 *   node scripts/diagnostics/recall-eval/genD1Fixtures.mjs
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANCHORS } from './lib/anchors.mjs';
import { buildCorpus } from './lib/corpus.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

// A word bank drawn from domains that appear in NEITHER the 16 domains used
// by calibrationProbes.ts's 128 probes (cooking, gardening, astronomy,
// history, geography, music, sports, weather/climate, wildlife/animals,
// nutrition/health, art/painting, literature, automobiles/mechanics,
// geology, textiles/crafts, travel/transportation) NOR gibberish.json's word
// bank (cooking, mythology, astronomy, textiles, geology, instruments) —
// verified mechanically below, not just by inspection.
const HELDOUT_WORDS = [
    'beekeeping', 'hive', 'apiary', 'propolis', 'drone', 'queen', 'nectar', 'swarm',
    'papermaking', 'pulp', 'vellum', 'watermark', 'deckle', 'linen', 'rag', 'bindery',
    'falconry', 'jesses', 'mews', 'talon', 'lure', 'eyass', 'gauntlet', 'quarry',
    'cartography', 'meridian', 'cartouche', 'graticule', 'contour', 'projection', 'datum', 'legend',
    'origami', 'crease', 'kirigami', 'tessellation', 'fold', 'module', 'valley', 'mountain',
    'viticulture', 'trellis', 'must', 'tannin', 'terroir', 'vintage', 'rootstock', 'canopy',
    'blacksmithing', 'anvil', 'forge', 'bellows', 'tongs', 'quench', 'tempering', 'ingot',
    'ceramics', 'kiln', 'glaze', 'slip', 'bisque', 'wedging', 'throwing', 'greenware',
];

function heldoutQuery(rngIdx) {
    const a = HELDOUT_WORDS[(rngIdx * 11 + 1) % HELDOUT_WORDS.length];
    const b = HELDOUT_WORDS[(rngIdx * 17 + 7) % HELDOUT_WORDS.length];
    const c = HELDOUT_WORDS[(rngIdx * 29 + 3) % HELDOUT_WORDS.length];
    const d = HELDOUT_WORDS[(rngIdx * 31 + 13) % HELDOUT_WORDS.length];
    const shapes = [
        [a, b, c],
        [c, a],
        [a, b, c, d],
        [d, c, a],
        [b, d],
        [a, c, d, b],
    ];
    return shapes[rngIdx % shapes.length].join(' ');
}

function tokenize(text) {
    return new Set(text.toLowerCase().match(/[a-z0-9']+/g) ?? []);
}

/** Extract single-quoted string literals from calibrationProbes.ts's probe
 *  array without importing TypeScript — this is a plain .mjs generator. */
function readCalibrationProbeText() {
    const src = fs.readFileSync(
        path.join(REPO_ROOT, 'packages', 'lore', 'src', 'recall', 'calibrationProbes.ts'),
        'utf8',
    );
    const start = src.indexOf('CALIBRATION_PROBES');
    const body = src.slice(start);
    const matches = [...body.matchAll(/'([^'\\]|\\.)*'/g)].map((m) => m[0].slice(1, -1));
    if (matches.length < 100) {
        throw new Error(`expected >=100 quoted probe strings in calibrationProbes.ts, found ${matches.length} — extraction regex may be stale`);
    }
    return matches.join(' ');
}

function main() {
    const corpus = buildCorpus({ codeRowCount: 500 });
    const vocab = new Set();
    for (const n of [...corpus.knowledgeNodes, ...corpus.notes, ...corpus.codeRows]) {
        for (const t of tokenize(`${n.label} ${n.content} ${(n.tags ?? []).join(' ')}`)) vocab.add(t);
    }
    for (const a of ANCHORS) {
        for (const t of tokenize(`${a.terse} ${a.chatty}`)) vocab.add(t);
    }
    for (const t of tokenize(readCalibrationProbeText())) vocab.add(t);

    const existingGibberish = JSON.parse(fs.readFileSync(path.join(__dirname, 'gibberish.json'), 'utf8'));
    for (const g of existingGibberish) {
        for (const t of tokenize(g.query)) vocab.add(t);
    }

    const heldout = [];
    let idx = 0;
    const MAX_ATTEMPTS = 5000;
    while (heldout.length < 60 && idx < MAX_ATTEMPTS) {
        const q = heldoutQuery(idx);
        idx++;
        const toks = tokenize(q);
        let overlap = false;
        for (const t of toks) if (vocab.has(t)) { overlap = true; break; }
        if (!overlap) heldout.push({ id: `gh-${heldout.length}`, query: q });
    }
    if (heldout.length < 60) {
        throw new Error(`only found ${heldout.length}/60 non-overlapping held-out gibberish queries after ${MAX_ATTEMPTS} attempts`);
    }
    for (const g of heldout) {
        for (const t of tokenize(g.query)) {
            if (vocab.has(t)) throw new Error(`held-out gibberish query "${g.query}" overlaps vocabulary on token "${t}"`);
        }
    }

    // Distractors: hand-authored, Riverstone-plausible in-domain questions
    // the fixture does not answer. No overlap check — these are meant to
    // read as coherent, on-topic software-ops questions, and some incidental
    // token overlap with the corpus ("worker", "queue", "retry") is expected
    // and correct; that's what makes them a harder case than gibberish.
    const distractors = [
        'How do we handle a GDPR data-deletion request for a tenant?',
        'What CI provider runs the Riverstone build pipeline?',
        'How does SSL certificate renewal work for the API gateway?',
        'What is our on-call escalation policy outside business hours?',
        'Which cloud region hosts the disaster-recovery replica?',
        'How do we rotate the database root credentials?',
        'What is the process for onboarding a new enterprise customer?',
        'How is customer support ticket priority determined?',
        'What load balancer do we use in front of the API?',
        'How do we handle SOC 2 audit evidence collection?',
        'What is the deprecation policy for old API versions?',
        'How does the billing system calculate usage-based invoices?',
        'What is our incident postmortem template?',
        'How do we test disaster recovery failover?',
        'What analytics platform tracks product usage?',
        'How is employee offboarding handled for system access?',
        'What is the process for requesting a new AWS account?',
        'How do we manage feature flags across environments?',
        'What is our policy on third-party dependency updates?',
        'How does the sales team request a custom demo environment?',
        'What is the data retention policy for support tickets?',
        'How do we handle a customer requesting an SLA credit?',
        'What is the process for a security vulnerability disclosure?',
        'How do we provision a new internal admin dashboard user?',
    ];
    if (distractors.length < 24) throw new Error(`need >=24 distractors, have ${distractors.length}`);

    fs.writeFileSync(path.join(__dirname, 'gibberish-heldout.json'), JSON.stringify(heldout, null, 2) + '\n');
    fs.writeFileSync(
        path.join(__dirname, 'distractors.json'),
        JSON.stringify(distractors.map((query, i) => ({ id: `dx-${i}`, query })), null, 2) + '\n',
    );
    console.log(`Wrote ${heldout.length} held-out gibberish queries, ${distractors.length} distractors. Vocab size checked against: ${vocab.size}`);
}

main();
