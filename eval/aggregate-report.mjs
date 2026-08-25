#!/usr/bin/env node
/**
 * eval/aggregate-report.mjs — Turn a rollup JSON into a markdown report.
 *
 * Usage:
 *   node eval/aggregate-report.mjs eval/results/_rollup-<timestamp>.json
 *
 * Output: writes RESULTS.md alongside the rollup file. Sections:
 *   - Headline numbers (avg tokens with vs without, avg savings %)
 *   - Per-task breakdown table
 *   - Per-category breakdown
 *   - Score quality comparison
 *   - Caveats
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

function fmt(n) {
    if (n == null) return 'n/a';
    if (typeof n !== 'number') return String(n);
    if (n >= 1000) return n.toLocaleString();
    return n.toFixed(n < 10 ? 2 : 0);
}

function pct(num, den) {
    if (!num || !den) return 'n/a';
    return `${((num / den) * 100).toFixed(1)}%`;
}

function savingsPct(withLore, without) {
    if (!withLore || !without) return 'n/a';
    return `${((1 - withLore / without) * 100).toFixed(1)}%`;
}

async function main() {
    const rollupPath = process.argv[2];
    if (!rollupPath) {
        console.error('usage: node eval/aggregate-report.mjs <rollup-json-path>');
        process.exit(1);
    }
    const rollup = JSON.parse(await fs.readFile(rollupPath, 'utf-8'));
    const results = rollup.results ?? [];

    // Group by taskId, then mode.
    const byTask = new Map();
    for (const r of results) {
        if (!byTask.has(r.taskId)) byTask.set(r.taskId, {});
        byTask.get(r.taskId)[r.mode] = r;
    }

    // Aggregate.
    const taskRows = [];
    let totalWithTokens = 0;
    let totalWithoutTokens = 0;
    let totalWithCost = 0;
    let totalWithoutCost = 0;
    let countBoth = 0;
    let withScoreSum = 0;
    let withoutScoreSum = 0;
    let scoreCountWith = 0;
    let scoreCountWithout = 0;

    for (const [taskId, byMode] of byTask.entries()) {
        const withL = byMode['with-lore'];
        const woL = byMode['without-lore'];
        const wTok = withL?.totalTokens ?? null;
        const woTok = woL?.totalTokens ?? null;
        const wCost = withL?.totalCostUsd ?? null;
        const woCost = woL?.totalCostUsd ?? null;
        const wScore = withL?.score ?? null;
        const woScore = woL?.score ?? null;

        if (wTok && woTok) {
            totalWithTokens += wTok;
            totalWithoutTokens += woTok;
            countBoth += 1;
        }
        if (wCost && woCost) {
            totalWithCost += wCost;
            totalWithoutCost += woCost;
        }
        if (wScore != null) { withScoreSum += wScore; scoreCountWith += 1; }
        if (woScore != null) { withoutScoreSum += woScore; scoreCountWithout += 1; }

        taskRows.push({
            taskId,
            category: withL?.category ?? woL?.category ?? '',
            withTokens: wTok,
            withoutTokens: woTok,
            tokenSavings: wTok && woTok ? savingsPct(wTok, woTok) : 'n/a',
            withCostUsd: wCost,
            withoutCostUsd: woCost,
            withScore: wScore,
            withoutScore: woScore,
            withTurns: withL?.numTurns ?? null,
            withoutTurns: woL?.numTurns ?? null,
            withElapsedMs: withL?.elapsedMs ?? null,
            withoutElapsedMs: woL?.elapsedMs ?? null,
        });
    }

    // Per-category aggregate.
    const byCategory = new Map();
    for (const row of taskRows) {
        if (!byCategory.has(row.category)) {
            byCategory.set(row.category, { withTokens: 0, withoutTokens: 0, count: 0 });
        }
        const bucket = byCategory.get(row.category);
        if (row.withTokens && row.withoutTokens) {
            bucket.withTokens += row.withTokens;
            bucket.withoutTokens += row.withoutTokens;
            bucket.count += 1;
        }
    }

    // Build markdown.
    const lines = [];
    lines.push('# Lore eval results');
    lines.push('');
    lines.push(`Generated from: \`${path.basename(rollupPath)}\``);
    lines.push(`Run started: ${rollup.ranAt}`);
    lines.push(`Tasks: ${(rollup.tasks ?? []).length}`);
    lines.push(`Modes: ${(rollup.modes ?? []).join(', ')}`);
    lines.push(`Total run time: ${(rollup.elapsedMs / 1000 / 60).toFixed(1)} min`);
    lines.push('');

    lines.push('## Headline');
    lines.push('');
    if (countBoth > 0) {
        const avgWith = totalWithTokens / countBoth;
        const avgWithout = totalWithoutTokens / countBoth;
        lines.push(`| Metric | With Lore | Without Lore | Savings |`);
        lines.push(`|---|---|---|---|`);
        lines.push(`| Avg total tokens per task | ${fmt(avgWith)} | ${fmt(avgWithout)} | **${savingsPct(avgWith, avgWithout)}** |`);
        if (totalWithCost && totalWithoutCost) {
            lines.push(`| Avg cost per task | $${(totalWithCost / countBoth).toFixed(4)} | $${(totalWithoutCost / countBoth).toFixed(4)} | **${savingsPct(totalWithCost, totalWithoutCost)}** |`);
        }
        if (scoreCountWith > 0 && scoreCountWithout > 0) {
            lines.push(`| Avg answer score (0–1) | ${(withScoreSum / scoreCountWith).toFixed(2)} | ${(withoutScoreSum / scoreCountWithout).toFixed(2)} | — |`);
        }
        lines.push('');
        lines.push(`Sample size: ${countBoth} task(s) with both modes captured.`);
    } else {
        lines.push('No tasks ran in both modes; nothing to compare.');
    }
    lines.push('');

    lines.push('## Per-task breakdown');
    lines.push('');
    lines.push('Total tokens = `input + cache_creation + cache_read + output` (everything billed for the run).');
    lines.push('');
    lines.push('| Task | Category | Total tokens (with) | Total tokens (without) | Savings | Cost (with) | Cost (without) | Score (with) | Score (without) |');
    lines.push('|---|---|---|---|---|---|---|---|---|');
    for (const r of taskRows) {
        const wCost = r.withCostUsd != null ? `$${r.withCostUsd.toFixed(4)}` : 'n/a';
        const woCost = r.withoutCostUsd != null ? `$${r.withoutCostUsd.toFixed(4)}` : 'n/a';
        lines.push(`| \`${r.taskId}\` | ${r.category} | ${fmt(r.withTokens)} | ${fmt(r.withoutTokens)} | ${r.tokenSavings} | ${wCost} | ${woCost} | ${fmt(r.withScore)} | ${fmt(r.withoutScore)} |`);
    }
    lines.push('');

    if (byCategory.size > 0) {
        lines.push('## Per-category aggregate');
        lines.push('');
        lines.push('| Category | Tasks | Avg tokens (with) | Avg tokens (without) | Savings |');
        lines.push('|---|---|---|---|---|');
        for (const [cat, bucket] of byCategory.entries()) {
            const avgW = bucket.count > 0 ? bucket.withTokens / bucket.count : 0;
            const avgWo = bucket.count > 0 ? bucket.withoutTokens / bucket.count : 0;
            lines.push(`| ${cat} | ${bucket.count} | ${fmt(avgW)} | ${fmt(avgWo)} | ${savingsPct(avgW, avgWo)} |`);
        }
        lines.push('');
    }

    lines.push('## Caveats');
    lines.push('');
    lines.push('- Token counts come from `claude -p --output-format json`. Schema varies across versions; parser is defensive but may show `n/a` if a particular field is missing.');
    lines.push('- The "without Lore" mode runs `claude` with the built-in tools (Read, Bash, Grep, etc.) but no Lore MCP server. The agent typically explores the repo by reading files and grepping.');
    lines.push('- Scores are coarse: a regex match against ground-truth keywords. A task can score 1.0 even if the answer is partially wrong; calibrate by spot-checking `answerExcerpt` in the per-cell JSON files.');
    lines.push('- Wall-clock time depends on the embedder (Wasm CPU vs Ollama Metal) and on Anthropic API latency.');
    lines.push('- One run is one sample. For a real benchmark, repeat 3–5 times and take medians.');
    lines.push('');

    const reportPath = rollupPath.replace(/\.json$/, '.md').replace(/_rollup/, 'RESULTS');
    await fs.writeFile(reportPath, lines.join('\n'));
    console.error(`[aggregate] wrote ${reportPath}`);
    console.log(reportPath);
}

main().catch((err) => {
    console.error('[aggregate] FAILED:', err);
    process.exit(1);
});
