/**
 * git/prRisk.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * PR risk score — blast x churn x complexity over a commit range. Local git only; per-host PR APIs are Phase 9+.
 *
 * Original work authored for groundfloor-lore. Patterns informed by
 * reading GitNexus and jcodemunch source for understanding only — no
 * code copied, no structural mirroring. See `docs/PLAN_replace_gitnexus_in_developer_plugin.md`
 * section 10 for the license-compliance protocol enforced by
 * `scripts/atlas-license-check.mjs`.
 *
 * Phase: 5 (git signals — host-agnostic).
 *
 * Combines blast-radius × churn × complexity signals for symbols
 * modified within a commit range. v1 uses local git data only — host-
 * specific PR-state signals (reviewer attention, CI status, comment
 * count) are a Phase 9+ extension that adds per-host adapters.
 */

import type { ParsedRelation, ParsedSymbol } from '../parser/types.js';
import type { SymbolTable } from '../resolver/symbolTable.js';
import { blastRadius } from '../analytics/blastRadius.js';
import { detectChanges } from './detectChanges.js';
import { repoChurn, churnScore } from './churn.js';

export interface SymbolRiskFactors {
    symbol: ParsedSymbol;
    /** Blast-radius d1 count (direct dependents). */
    blastD1: number;
    /** Cyclomatic complexity. */
    complexity: number;
    /** Churn score (additions + deletions over the lookback window). */
    churn: number;
    /** Combined score: d1 × complexity × log(1 + churn). */
    score: number;
}

export interface PrRiskReport {
    /** Per-changed-symbol risk factors, sorted high to low. */
    factors: SymbolRiskFactors[];
    /** Aggregate score for the whole change set. */
    totalScore: number;
    /** Banding: low / medium / high / critical based on totalScore + max symbol score. */
    band: 'low' | 'medium' | 'high' | 'critical';
}

function bandFor(total: number, max: number): PrRiskReport['band'] {
    if (max >= 50 || total >= 200) return 'critical';
    if (max >= 20 || total >= 80) return 'high';
    if (max >= 5 || total >= 20) return 'medium';
    return 'low';
}

/**
 * Score risk for symbols changed in `commitRange` (e.g., 'main..HEAD'
 * or 'staged'). Uses the analytics blastRadius + complexity from the
 * resolved graph + local git churn.
 */
export function prRisk(
    repoRoot: string,
    table: SymbolTable,
    relations: readonly ParsedRelation[],
    options: {
        scope?: 'staged' | 'unstaged' | 'compare';
        baseRef?: string;
        sinceDaysForChurn?: number;
    } = {},
): PrRiskReport {
    const scope = options.scope ?? 'staged';
    const baseRef = options.baseRef;
    const sinceDays = options.sinceDaysForChurn ?? 30;

    const affected = detectChanges(repoRoot, table, scope, baseRef);
    const churnByFile = repoChurn(repoRoot, sinceDays);

    const factors: SymbolRiskFactors[] = [];
    for (const a of affected) {
        const br = blastRadius(a.symbol.id, table, relations, 'upstream');
        const churnStats = churnByFile.get(a.symbol.file);
        const churn = churnScore(churnStats);
        const score = (br.d1.length || 1) * Math.max(1, a.symbol.complexity) * Math.log1p(churn);
        factors.push({
            symbol: a.symbol,
            blastD1: br.d1.length,
            complexity: a.symbol.complexity,
            churn,
            score,
        });
    }

    factors.sort((x, y) => y.score - x.score);

    const totalScore = factors.reduce((acc, f) => acc + f.score, 0);
    const maxScore = factors.length > 0 ? factors[0].score : 0;

    return {
        factors,
        totalScore: Math.round(totalScore * 100) / 100,
        band: bandFor(totalScore, maxScore),
    };
}
