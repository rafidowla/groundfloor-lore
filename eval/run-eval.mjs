#!/usr/bin/env node
/**
 * eval/run-eval.mjs — Lore token-savings eval runner.
 *
 * Runs every task × every mode (with-lore / without-lore), captures
 * token usage + answer text, scores against ground-truth keywords,
 * writes a per-run JSON file. Pair with `aggregate-report.mjs` to
 * turn the JSON files into a markdown report.
 *
 * Usage:
 *   LORE_EVAL_MODE=both node eval/run-eval.mjs           # both modes
 *   LORE_EVAL_MODE=with-lore node eval/run-eval.mjs      # only Lore-enabled
 *   LORE_EVAL_MODE=without-lore node eval/run-eval.mjs   # only vanilla
 *   LORE_EVAL_TASKS=eval/tasks/<file>.json node eval/run-eval.mjs
 *
 * Prerequisites:
 *   - claude CLI authenticated (we resolve the binary by walking
 *     ~/Library/Application Support/Claude/claude-code/<version>/...
 *     so PATH doesn't matter)
 *   - Lore daemon running on http://127.0.0.1:3847 (for the with-lore
 *     mode; the eval refuses to run that mode if daemon is down)
 *
 * Per-run output:
 *   eval/results/<taskId>-<mode>-<timestamp>.json
 *
 * License: original work for groundfloor-lore.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVAL_ROOT = __dirname;

const MODE = process.env.LORE_EVAL_MODE ?? 'both';
const TASKS_FILE = process.env.LORE_EVAL_TASKS ?? path.join(EVAL_ROOT, 'tasks/v1-developer-tasks.json');
const RESULTS_DIR = path.join(EVAL_ROOT, 'results');
const TIMEOUT_MS = Number(process.env.LORE_EVAL_TIMEOUT_MS ?? 180_000);

async function findClaudeBinary() {
    const base = path.join(os.homedir(), 'Library/Application Support/Claude/claude-code');
    try {
        const versions = await fs.readdir(base);
        if (versions.length === 0) throw new Error('no claude-code versions installed');
        // Pick highest semver version present
        versions.sort((a, b) => {
            const [aMajor, aMinor, aPatch] = a.split('.').map(Number);
            const [bMajor, bMinor, bPatch] = b.split('.').map(Number);
            return (bMajor - aMajor) || (bMinor - aMinor) || (bPatch - aPatch);
        });
        const candidate = path.join(base, versions[0], 'claude.app/Contents/MacOS/claude');
        await fs.access(candidate);
        return candidate;
    } catch (err) {
        // Fallback: try /opt/homebrew/bin/claude (which may be a symlink)
        try {
            await fs.access('/opt/homebrew/bin/claude');
            return '/opt/homebrew/bin/claude';
        } catch {
            throw new Error(`claude CLI not found: ${err.message}`);
        }
    }
}

async function probeDaemon() {
    try {
        const r = await fetch('http://127.0.0.1:3847/health', { signal: AbortSignal.timeout(2000) });
        return r.ok;
    } catch {
        return false;
    }
}

/**
 * Run one (task, mode) cell. Returns the captured result object.
 *
 * `claude -p <prompt> --output-format json --mcp-config <config>` runs
 * the agent non-interactively and emits a JSON line with usage + result.
 * We collect stdout, parse the trailing JSON object, and tabulate.
 */
async function runCell(claudeBin, task, mode) {
    const configPath = path.join(EVAL_ROOT, 'configs', mode === 'with-lore' ? 'with-lore.json' : 'without-lore.json');

    return new Promise((resolve) => {
        const startedAt = Date.now();
        const args = [
            '-p', task.prompt,
            '--output-format', 'json',
            '--mcp-config', configPath,
            '--no-session-persistence',
            '--add-dir', path.resolve(EVAL_ROOT, '..'),  // grant access to repo root
            '--dangerously-skip-permissions', // non-interactive: skip approval dialogs
            // (no --bare: keep the user's normal auth path — OAuth or
            //  keychain — instead of forcing ANTHROPIC_API_KEY)
        ];

        const child = spawn(claudeBin, args, {
            env: { ...process.env },
            timeout: TIMEOUT_MS,
            stdio: ['ignore', 'pipe', 'pipe'],   // ignore stdin so claude doesn't wait on it
        });

        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (b) => { stdout += b.toString('utf-8'); });
        child.stderr.on('data', (b) => { stderr += b.toString('utf-8'); });

        child.on('close', (code) => {
            const elapsedMs = Date.now() - startedAt;

            // Parse the JSON output. claude -p --output-format json
            // emits a single JSON object with { result, total_cost_usd,
            // total_tokens, num_turns, ... }. Format may evolve; be
            // defensive.
            let parsed = null;
            try {
                parsed = JSON.parse(stdout.trim());
            } catch {
                // Sometimes there are trailing/leading noise lines; try
                // to find a JSON object.
                const m = stdout.match(/\{[\s\S]*\}/);
                if (m) {
                    try { parsed = JSON.parse(m[0]); } catch { /* give up */ }
                }
            }

            const answer = parsed?.result ?? parsed?.message ?? stdout;

            // Token shape from `claude -p --output-format json`:
            //   usage.input_tokens                — user-message-only tokens
            //   usage.cache_creation_input_tokens — system prompt + tool defs (cached)
            //   usage.cache_read_input_tokens     — cache hits
            //   usage.output_tokens               — model output
            //
            // The honest "what got billed for this run" is the SUM of
            // input_tokens + cache_creation + cache_read + output. With
            // Lore tools registered, cache_creation grows because the
            // tool catalogue + per-tool docstrings live in the system
            // prompt. So the eval should compare ALL of these, not just
            // input/output.
            const usage = parsed?.usage ?? {};
            const inputTokens = usage.input_tokens ?? null;
            const cacheCreationTokens = usage.cache_creation_input_tokens ?? null;
            const cacheReadTokens = usage.cache_read_input_tokens ?? null;
            const outputTokens = usage.output_tokens ?? null;
            const totalTokens = (inputTokens ?? 0)
                + (cacheCreationTokens ?? 0)
                + (cacheReadTokens ?? 0)
                + (outputTokens ?? 0) || null;
            const totalCost = parsed?.total_cost_usd ?? parsed?.cost_usd ?? null;
            const numTurns = parsed?.num_turns ?? null;
            const stopReason = parsed?.stop_reason ?? null;

            // Score: count of ground-truth regex patterns matched in the answer.
            let matched = 0;
            const matchDetails = [];
            for (const pattern of task.groundTruth ?? []) {
                try {
                    const re = new RegExp(pattern, 'i');
                    const hit = re.test(typeof answer === 'string' ? answer : JSON.stringify(answer));
                    matchDetails.push({ pattern, matched: hit });
                    if (hit) matched += 1;
                } catch {
                    matchDetails.push({ pattern, matched: false, error: 'invalid regex' });
                }
            }
            const totalPatterns = task.groundTruth?.length ?? 0;
            const score = totalPatterns === 0 ? null : matched / totalPatterns;

            resolve({
                taskId: task.id,
                category: task.category,
                mode,
                exitCode: code,
                elapsedMs,
                inputTokens,
                cacheCreationTokens,
                cacheReadTokens,
                outputTokens,
                totalTokens,
                totalCostUsd: totalCost,
                numTurns,
                stopReason,
                matched,
                totalPatterns,
                score,
                matchDetails,
                answerExcerpt: typeof answer === 'string' ? answer.slice(0, 600) : JSON.stringify(answer).slice(0, 600),
                stderrTail: stderr.slice(-400),
                ranAt: new Date(startedAt).toISOString(),
            });
        });

        child.on('error', (err) => {
            resolve({
                taskId: task.id,
                category: task.category,
                mode,
                exitCode: -1,
                error: err.message,
                ranAt: new Date(startedAt).toISOString(),
            });
        });
    });
}

async function main() {
    console.error(`[eval] mode=${MODE}, tasks=${TASKS_FILE}`);
    await fs.mkdir(RESULTS_DIR, { recursive: true });

    const claudeBin = await findClaudeBinary();
    console.error(`[eval] claude binary: ${claudeBin}`);

    const tasksPayload = JSON.parse(await fs.readFile(TASKS_FILE, 'utf-8'));
    const tasks = tasksPayload.tasks ?? [];
    console.error(`[eval] loaded ${tasks.length} tasks`);

    const modes = MODE === 'both' ? ['with-lore', 'without-lore'] : [MODE];

    if (modes.includes('with-lore')) {
        const alive = await probeDaemon();
        if (!alive) {
            console.error('[eval] daemon at http://127.0.0.1:3847 is NOT alive. Cannot run with-lore mode.');
            console.error('[eval]   start it: launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.groundfloor.lore.plist');
            process.exit(1);
        }
    }

    const runStart = Date.now();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');

    const allResults = [];
    for (const task of tasks) {
        for (const mode of modes) {
            console.error(`[eval] running ${task.id} (${mode})...`);
            const t0 = Date.now();
            const result = await runCell(claudeBin, task, mode);
            const dt = ((Date.now() - t0) / 1000).toFixed(1);
            console.error(`[eval]   ${task.id} ${mode}: tokens=${result.totalTokens ?? '?'}, score=${result.score?.toFixed(2) ?? '?'}, ${dt}s`);
            const outPath = path.join(RESULTS_DIR, `${task.id}-${mode}-${stamp}.json`);
            await fs.writeFile(outPath, JSON.stringify(result, null, 2));
            allResults.push(result);
        }
    }

    // Write a single rolled-up file too.
    const rollupPath = path.join(RESULTS_DIR, `_rollup-${stamp}.json`);
    await fs.writeFile(rollupPath, JSON.stringify({
        ranAt: new Date(runStart).toISOString(),
        elapsedMs: Date.now() - runStart,
        tasksFile: TASKS_FILE,
        modes,
        tasks: tasksPayload.tasks?.map((t) => ({ id: t.id, category: t.category })),
        results: allResults,
    }, null, 2));

    console.error('');
    console.error(`[eval] done. ${allResults.length} cells, ${((Date.now() - runStart) / 1000).toFixed(0)}s total`);
    console.error(`[eval] rollup: ${rollupPath}`);
    console.error(`[eval] aggregate report: node eval/aggregate-report.mjs ${rollupPath}`);
}

main().catch((err) => {
    console.error('[eval] FAILED:', err);
    process.exit(1);
});
