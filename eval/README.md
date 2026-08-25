# Lore eval suite

Empirical token-savings benchmark for Lore. Runs a fixed set of developer questions through `claude -p` twice — once with Lore's MCP tools available, once with no MCP tools — and tabulates token usage, answer quality, and runtime.

## What you get

Run the suite, get a markdown report at `eval/results/RESULTS-<timestamp>.md` with:

- **Headline numbers**: average tokens / cost / score with vs without Lore, and the % savings
- **Per-task breakdown**: every task × every mode, side by side
- **Per-category aggregate**: navigation tasks vs analytics vs debugging, etc.
- **Caveats**: what the numbers don't tell you

The raw per-cell JSON is preserved at `eval/results/<taskId>-<mode>-<timestamp>.json` so you can inspect the actual answer text.

## Prerequisites

- `claude` CLI authenticated (Claude Code app installed)
- Lore daemon running at `http://127.0.0.1:3847` (only needed for `with-lore` mode)
- Node 20+

## Run it

```bash
# Both modes (default)
node eval/run-eval.mjs

# Only one mode
LORE_EVAL_MODE=with-lore node eval/run-eval.mjs
LORE_EVAL_MODE=without-lore node eval/run-eval.mjs

# Custom task file
LORE_EVAL_TASKS=eval/tasks/my-custom-tasks.json node eval/run-eval.mjs

# Tighter per-cell timeout (default 180s)
LORE_EVAL_TIMEOUT_MS=120000 node eval/run-eval.mjs
```

The runner prints a progress line per cell and writes a rollup file at the end:

```
[eval] mode=both, tasks=eval/tasks/v1-developer-tasks.json
[eval] claude binary: /Users/.../claude.app/Contents/MacOS/claude
[eval] loaded 10 tasks
[eval] running find-cutover-script (with-lore)...
[eval]   find-cutover-script with-lore: tokens=2841, score=1.00, 4.2s
[eval] running find-cutover-script (without-lore)...
[eval]   find-cutover-script without-lore: tokens=18432, score=1.00, 12.7s
...
[eval] done. 20 cells, 280s total
[eval] rollup: eval/results/_rollup-2026-...-Z.json
[eval] aggregate report: node eval/aggregate-report.mjs eval/results/_rollup-2026-...-Z.json
```

Then:

```bash
node eval/aggregate-report.mjs eval/results/_rollup-2026-...-Z.json
```

Generates the markdown report alongside the rollup.

## How tasks are written

`eval/tasks/v1-developer-tasks.json`:

```json
{
    "schemaVersion": 1,
    "description": "...",
    "tasks": [
        {
            "id": "find-cutover-script",
            "category": "navigation",
            "prompt": "Where is the Phase 7 destructive cutover script?",
            "groundTruth": [
                "scripts/atlas-cutover-destructive\\.mjs",
                "i-have-the-go|main"
            ],
            "rationale": "Why this task discriminates with vs without Lore"
        }
    ]
}
```

- `prompt` — what the agent sees. Plain natural-language question.
- `groundTruth` — array of regex strings. Each one is matched (case-insensitive) against the agent's answer text. Score = matches / total.
- `category` — used for the per-category aggregate.
- `rationale` — for humans reading the suite, not used by the runner.

To add tasks, copy the structure into a new file and pass it via `LORE_EVAL_TASKS`.

## Designing good tasks

Pick questions where the **information density** of the answer differs between modes:

- **Lore-favourable:** "What functions break if I rename X" → `code_impact` returns 50 lines of facts; vanilla agent reads 20 files.
- **Even:** "Explain in 2 sentences what reconnect does" → both modes do roughly the same work.
- **Vanilla-favourable** (rare in practice): tasks that are pure reading comprehension on a known small file.

A good suite has a mix. The headline number should reflect realistic developer usage, not cherry-picked best-case Lore wins.

## Repeat runs

Token counts vary between runs because:
- The agent's exploration path is non-deterministic (no temperature=0 in `--print` mode)
- Embedding state in Lore changes between runs (cursor + cache)
- API latency drifts

For a real benchmark, run the suite 3–5 times across a day and take medians. The runner doesn't auto-repeat — wrap it in a shell loop:

```bash
for i in 1 2 3 4 5; do
    node eval/run-eval.mjs
done
# Then aggregate manually or write a multi-run aggregator.
```

## Limitations honestly

- **Score is coarse.** A regex match against keywords doesn't capture semantic correctness. A task can score 1.0 with a wrong answer that happens to mention the right files.
- **No subjective quality scoring.** A real eval would have a human grade each answer 1–5; we use mechanical regex match for repeatability.
- **No multi-turn comparison.** `claude -p` is one round-trip; real chat sessions go many turns. The savings might compound or might not.
- **Task suite is small.** 10 tasks is a sniff test, not a benchmark. Add more for serious claims.
- **One model.** Whatever `claude` defaults to. The savings would shift with different models.
