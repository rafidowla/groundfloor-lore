#!/usr/bin/env tsx
/**
 * test/sprint-R-recall-ranking-property.ts — Sprint R gate (8 cases).
 *
 * R0 ships this with 6 cases marked xfail + 2 cross-sprint sentinels
 * expectPass. R1 flips D1/D2/D3/D8 to expectPass once the ranking
 * implementation lands. R2 flips D4/D5 to expectPass after the
 * benchmark suite hits target (or escalates if it doesn't).
 *
 * The gate verifies the Sprint R contract from
 * docs/audits/sprint-R-recall-ranking-2026-05-24.md:
 *   - Type bias: operator-curated > auto-extracted at equal similarity.
 *   - Recency decay: newer > older at equal type + similarity.
 *   - Curation signal: human-labelled > machine-labelled at equal
 *     type + similarity + recency.
 *   - Benchmarks: precision@5 ≥ 80 %, recall@10 ≥ 90 % on the
 *     operator-derived question set in test/recall-benchmarks/.
 *   - Backward compat: clients that don't request ranking still get
 *     a non-empty, plausibly-ordered response.
 *   - Cross-sprint sentinels: Sprint L workspace_required + Sprint O
 *     outbox semantics survive.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { rankScore, sortByRank, OPERATOR_CURATED_TYPES } from '../packages/lore/src/recall/ranking.js';
import { runBenchmarks } from './recall-benchmarks/runBenchmarks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
let xfailedAsExpected = 0;
let xfailedUnexpected = 0;

interface Case {
    id: string;
    name: string;
    mode: 'expectPass' | 'xfail';
    fn: () => void | Promise<void>;
}

function makeNode(over: Partial<{
    id: string;
    type: string;
    label: string;
    updatedAt: string;
    metadata: string;
}>): { id: string; type: string; label: string; updatedAt?: string | null; metadata?: string | null } {
    return {
        id: over.id ?? 'n',
        type: over.type ?? 'decision',
        label: over.label ?? 'a label',
        updatedAt: over.updatedAt ?? new Date().toISOString(),
        metadata: over.metadata ?? null,
    };
}

// Mode flips: R0 ships D1/D2/D3/D4/D5/D8 as xfail (stub ranking returns
// baseScore only). R1+R2 flip all six to expectPass once the ranking
// implementation lands. D6/D7 stay expectPass throughout as cross-sprint
// sentinels.
const SPRINT_R_PHASE = process.env.SPRINT_R_PHASE ?? 'R2';
function phaseMode(_flipAt: 'R1' | 'R2'): 'expectPass' | 'xfail' {
    if (SPRINT_R_PHASE === 'R0') return 'xfail';
    return 'expectPass';
}

const cases: Case[] = [
    {
        id: 'R-D1',
        name: 'type-bias: decision outranks code-symbol at equal base score',
        mode: phaseMode('R1'),
        fn: () => {
            const now = Date.now();
            const decision = makeNode({ id: 'd1', type: 'decision', updatedAt: new Date(now).toISOString() });
            const codesym = makeNode({ id: 'c1', type: 'code-symbol', updatedAt: new Date(now).toISOString() });
            const sD = rankScore({ node: decision, baseScore: 0.7, nowMs: now });
            const sC = rankScore({ node: codesym, baseScore: 0.7, nowMs: now });
            assert.ok(sD > sC, `expected decision (${sD}) > code-symbol (${sC}) at equal base`);
            // Also verify sortByRank surfaces decision first.
            const sorted = sortByRank([
                { node: codesym, baseScore: 0.7 },
                { node: decision, baseScore: 0.7 },
            ], { nowMs: now });
            assert.equal(sorted[0].node.id, 'd1');
        },
    },
    {
        id: 'R-D2',
        name: 'recency decay: newer node outranks older at equal type + base score',
        mode: phaseMode('R1'),
        fn: () => {
            const now = Date.now();
            const dayMs = 86_400_000;
            const fresh = makeNode({ id: 'f', type: 'decision', updatedAt: new Date(now - dayMs).toISOString() });
            const stale = makeNode({ id: 's', type: 'decision', updatedAt: new Date(now - 180 * dayMs).toISOString() });
            const sF = rankScore({ node: fresh, baseScore: 0.6, nowMs: now });
            const sS = rankScore({ node: stale, baseScore: 0.6, nowMs: now });
            assert.ok(sF > sS, `expected fresh (${sF}) > stale (${sS})`);
        },
    },
    {
        id: 'R-D3',
        name: 'curation signal: explicit metadata.curated outranks unmarked at equal type+recency+base',
        mode: phaseMode('R1'),
        fn: () => {
            const now = Date.now();
            // Use an auto-extracted type so the implicit operator-type
            // curation boost doesn't fire — only the explicit metadata
            // flag should distinguish these two.
            const curated = makeNode({
                id: 'cu',
                type: 'code-symbol',
                updatedAt: new Date(now).toISOString(),
                metadata: JSON.stringify({ curated: true }),
            });
            const uncurated = makeNode({
                id: 'un',
                type: 'code-symbol',
                updatedAt: new Date(now).toISOString(),
                metadata: null,
            });
            const sCu = rankScore({ node: curated, baseScore: 0.5, nowMs: now });
            const sUn = rankScore({ node: uncurated, baseScore: 0.5, nowMs: now });
            assert.ok(sCu > sUn, `expected curated (${sCu}) > uncurated (${sUn})`);
        },
    },
    {
        id: 'R-D4',
        name: 'benchmark: precision@5 on Day-1 dogfood question set ≥ 80 %',
        mode: phaseMode('R2'),
        fn: async () => {
            const r = await runBenchmarks();
            const PRECISION_TARGET = 0.80;
            assert.ok(
                r.precisionAt5 >= PRECISION_TARGET,
                `precision@5=${r.precisionAt5.toFixed(3)} below target ${PRECISION_TARGET} ` +
                `(per-question: ${JSON.stringify(r.perQuestion.map((q) => ({ id: q.id, p5: q.precisionAt5 })))})`,
            );
        },
    },
    {
        id: 'R-D5',
        name: 'benchmark: recall@10 on known-answer queries ≥ 90 %',
        mode: phaseMode('R2'),
        fn: async () => {
            const r = await runBenchmarks();
            const RECALL_TARGET = 0.90;
            assert.ok(
                r.recallAt10 >= RECALL_TARGET,
                `recall@10=${r.recallAt10.toFixed(3)} below target ${RECALL_TARGET}`,
            );
        },
    },
    {
        id: 'R-D6',
        name: 'sentinel: Sprint L workspace_required test file present + non-trivial',
        mode: 'expectPass',
        fn: () => {
            const p = path.join(__dirname, 'L1-workspace-required-unit.ts');
            assert.ok(fs.existsSync(p), 'Sprint L workspace-required unit test missing');
            const body = fs.readFileSync(p, 'utf8');
            assert.ok(body.includes('writeWorkspaceRequired') || body.includes('workspace_required'),
                'Sprint L gate lost its workspace_required assertion');
        },
    },
    {
        id: 'R-D7',
        name: 'sentinel: Sprint O outbox-first behavior tests present',
        mode: 'expectPass',
        fn: () => {
            const candidates = ['O3-bulk-outbox-perf-unit.ts', 'O4-backpressure-unit.ts', 'O5-crash-recovery-integration.ts'];
            for (const c of candidates) {
                assert.ok(fs.existsSync(path.join(__dirname, c)), `Sprint O sentinel ${c} missing`);
            }
        },
    },
    {
        id: 'R-D8',
        name: 'backward compat: rankScore degrades to baseScore when ranking disabled',
        mode: phaseMode('R1'),
        fn: () => {
            const prev = process.env.LORE_RECALL_RANKING;
            process.env.LORE_RECALL_RANKING = 'off';
            try {
                const now = Date.now();
                const decision = makeNode({ id: 'd', type: 'decision', updatedAt: new Date(now).toISOString() });
                const codesym = makeNode({ id: 'c', type: 'code-symbol', updatedAt: new Date(now - 365 * 86_400_000).toISOString() });
                const sD = rankScore({ node: decision, baseScore: 0.5, nowMs: now });
                const sC = rankScore({ node: codesym, baseScore: 0.5, nowMs: now });
                // Off mode: ranking is identity → both equal to baseScore.
                assert.equal(sD, 0.5);
                assert.equal(sC, 0.5);
            } finally {
                if (prev === undefined) delete process.env.LORE_RECALL_RANKING;
                else process.env.LORE_RECALL_RANKING = prev;
            }
        },
    },
];

// Quick sanity that the operator-curated table includes at least the
// canonical 5 types from the spec. Catches a regression where someone
// edits the table and accidentally moves "decision" out.
assert.ok(OPERATOR_CURATED_TYPES.has('decision'));
assert.ok(OPERATOR_CURATED_TYPES.has('convention'));
assert.ok(OPERATOR_CURATED_TYPES.has('bug_pattern'));
assert.ok(OPERATOR_CURATED_TYPES.has('architecture') || OPERATOR_CURATED_TYPES.has('architecture-doc'));
assert.ok(OPERATOR_CURATED_TYPES.has('troubleshooting'));

(async () => {
    for (const c of cases) {
        try {
            await c.fn();
            if (c.mode === 'expectPass') {
                passed++;
                console.log(`PASS  ${c.id}  ${c.name}`);
            } else {
                xfailedUnexpected++;
                console.log(`XPASS ${c.id}  (xfail expected, but passed) — ${c.name}`);
            }
        } catch (e) {
            if (c.mode === 'xfail') {
                xfailedAsExpected++;
                console.log(`xfail ${c.id}  ${c.name}  (${(e as Error).message.slice(0, 80)})`);
            } else {
                failed++;
                console.log(`FAIL  ${c.id}  ${c.name}\n      ${(e as Error).message}`);
            }
        }
    }
    console.log(`\nSprint R gate: ${passed} passed, ${failed} failed, ${xfailedAsExpected} xfail-as-expected, ${xfailedUnexpected} xpass-unexpected (phase=${SPRINT_R_PHASE})`);
    // XPASS (xfail that actually passed) is tolerated during R0 — the
    // stub may incidentally satisfy a case. It becomes a failure once
    // a case is officially flipped to expectPass at R1 or R2.
    const xpassFatal = SPRINT_R_PHASE !== 'R0';
    if (failed > 0 || (xpassFatal && xfailedUnexpected > 0)) process.exit(1);
})();
