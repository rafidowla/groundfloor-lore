#!/usr/bin/env node
/**
 * genQuestions.mjs — generates questions.json (>=20 real Q&A pairs, terse +
 * chatty, exact node-id expectations) and gibberish.json (>=50 no-overlap
 * queries) from the SAME deterministic corpus this harness builds, so the
 * expected ids always match what buildFixture.mjs actually writes.
 *
 * Run once (already committed as output); re-run only if anchors.mjs or the
 * gibberish word bank changes:
 *   node scripts/diagnostics/recall-eval/genQuestions.mjs
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANCHORS } from './lib/anchors.mjs';
import { buildCorpus } from './lib/corpus.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Gibberish vocabulary deliberately drawn from domains with ZERO overlap
// with the Riverstone corpus's vocabulary (cooking, mythology, astronomy,
// textiles, geology) — verified mechanically below, not just by inspection.
const GIBBERISH_WORDS = [
    'marmalade', 'griffin', 'nebula', 'tapestry', 'obsidian', 'bassoon', 'meringue', 'sphinx',
    'quasar', 'brocade', 'feldspar', 'accordion', 'gazpacho', 'centaur', 'pulsar', 'chiffon',
    'basalt', 'trombone', 'souffle', 'minotaur', 'comet', 'damask', 'granite', 'clarinet',
    'chowder', 'phoenix', 'asteroid', 'organza', 'quartz', 'tuba', 'risotto', 'pegasus',
    'meteor', 'velvet', 'schist', 'harmonica', 'biscotti', 'hydra', 'eclipse', 'gingham',
    'limestone', 'ukulele', 'falafel', 'cyclops', 'galaxy', 'paisley', 'marble', 'xylophone',
    'croissant', 'kraken', 'starlight', 'cashmere', 'sandstone', 'mandolin', 'dumpling',
    'chimera', 'orbit', 'flannel', 'pumice', 'kazoo', 'strudel', 'gorgon', 'comet', 'taffeta',
];

// IMPORTANT: no English glue/stop words here ("the", "a", "into", "for", ...)
// — ordinary prose in the corpus (knowledge nodes, chat notes, even the
// real questions themselves) is full of common stopwords, so a template
// that mixes gibberish nouns with stopwords can NEVER pass a true
// zero-lexical-overlap check and the generator would loop forever hunting
// for one that does. Content-word-only queries are the correct fixture for
// "no lexical overlap with the corpus" and are still clearly nonsense.
function gibberishQuery(rngIdx) {
    const a = GIBBERISH_WORDS[(rngIdx * 7) % GIBBERISH_WORDS.length];
    const b = GIBBERISH_WORDS[(rngIdx * 13 + 3) % GIBBERISH_WORDS.length];
    const c = GIBBERISH_WORDS[(rngIdx * 19 + 5) % GIBBERISH_WORDS.length];
    const d = GIBBERISH_WORDS[(rngIdx * 23 + 11) % GIBBERISH_WORDS.length];
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

function main() {
    // Real questions: one per anchor.
    const questions = ANCHORS.map((a) => ({
        id: `q-${a.id}`,
        terse: a.terse,
        chatty: a.chatty,
        workspace: 'default',
        expectedIds: [a.id],
    }));

    // Gibberish set (>=50), verified to have zero token overlap with the
    // full corpus vocabulary (knowledge + notes + a code-row sample —
    // checking all 10k+ code rows is unnecessary since they're generated
    // from the same small template vocab as the 10k-row sample below).
    const corpus = buildCorpus({ codeRowCount: 500 }); // small sample is enough for vocab coverage — templates repeat
    const vocab = new Set();
    for (const n of [...corpus.knowledgeNodes, ...corpus.notes, ...corpus.codeRows]) {
        for (const t of tokenize(`${n.label} ${n.content} ${(n.tags ?? []).join(' ')}`)) vocab.add(t);
    }
    // Also fold in the anchors' terse/chatty question text — a gibberish
    // query must not overlap the *questions* either.
    for (const a of ANCHORS) {
        for (const t of tokenize(`${a.terse} ${a.chatty}`)) vocab.add(t);
    }

    const gibberish = [];
    let idx = 0;
    const MAX_ATTEMPTS = 5000;
    while (gibberish.length < 60 && idx < MAX_ATTEMPTS) {
        const q = gibberishQuery(idx);
        idx++;
        const toks = tokenize(q);
        let overlap = false;
        for (const t of toks) {
            if (vocab.has(t)) { overlap = true; break; }
        }
        if (!overlap) {
            gibberish.push({ id: `g-${gibberish.length}`, query: q });
        }
    }
    if (gibberish.length < 60) {
        throw new Error(`only found ${gibberish.length}/60 non-overlapping gibberish queries after ${MAX_ATTEMPTS} attempts — widen GIBBERISH_WORDS or the shape templates`);
    }

    // Mechanical re-verification pass (belt and suspenders): fail loudly if
    // any slipped through.
    for (const g of gibberish) {
        for (const t of tokenize(g.query)) {
            if (vocab.has(t)) {
                throw new Error(`gibberish query "${g.query}" overlaps corpus vocabulary on token "${t}"`);
            }
        }
    }

    fs.writeFileSync(path.join(__dirname, 'questions.json'), JSON.stringify(questions, null, 2) + '\n');
    fs.writeFileSync(path.join(__dirname, 'gibberish.json'), JSON.stringify(gibberish, null, 2) + '\n');
    console.log(`Wrote ${questions.length} questions, ${gibberish.length} verified-non-overlapping gibberish queries. Vocab size: ${vocab.size}`);
}

main();
