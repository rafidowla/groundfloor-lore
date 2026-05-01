# Eval Findings — Deterministic Transforms vs LFM2.5-1.2B (Thinking + Instruct)

> **Date:** 2026-04-30. **Author:** Rafi Dowla. **Run on:** Apple Silicon, Ollama 0.22.1, Node 20.
> **Strategy doc:** [`docs/internal/strategy-mcp-token-efficiency.md`](../../docs/internal/strategy-mcp-token-efficiency.md)
> **Companion research:** [`docs/internal/research-token-efficiency-for-lore.md`](../../docs/internal/research-token-efficiency-for-lore.md), [`docs/internal/research-local-preprocessor-eval.md`](../../docs/internal/research-local-preprocessor-eval.md)

## Headline numbers

| Approach | Total bytes-in | Total bytes-out | **Reduction** | Latency p50 | Latency p95 | Failures | Hallucinated IDs |
|---|---:|---:|---:|---:|---:|---:|---:|
| **Deterministic transforms (P1+P2 sim)** | 212 523 | 11 705 | **94.5 %** | < 1 ms | < 1 ms | 0 | 0 |
| LFM2.5-1.2B-**Thinking** | 212 523 | 20 735 | 90.2 % | 4 120 ms | 4 348 ms | **3 / 10** | 285 |
| LFM2.5-1.2B-**Instruct** | 212 523 | 3 489 | **98.4 %** | 778 ms | 8 253 ms* | 0 | 125 |

*p95 of 8.2 s is one cold-start outlier; steady-state p95 is ~880 ms.

## What it tells us

### 1. The deterministic work alone clears the bar

The strategy's success target was **30–40 %** session-wide reduction vs Claude-Code-with-`Read`. Per-response deterministic transforms (mode-thin, negative-evidence stamping, outline extraction) hit **94.5 %** on this corpus. **The Phase 6 P0/P1/P2 plan is the right plan.** It pays for itself before any LLM is in the picture.

The deterministic worst case is the two responses already < 1.2 KB (`06-impact-registertools.json` and `08-context-registertools.json`) where the transforms add a few bytes for the `_meta` envelope. The fix is trivial: **don't run the transforms when the response is already below the byte-budget threshold.** Code that out as a guard.

### 2. LFM2.5-**Thinking** is the wrong head for this workload

The Thinking variant produced **meta-commentary**, not summaries, on **8 of 10** responses. Examples:

- "The summary adheres strictly to specified constraints."
- "Preserved identifiers and process details."
- "The summary covers collision detection, active plugin tracking, and orphan resolution."

Only `02-query-content.json` and `10-doc-architecture.md` produced anything resembling an answer. The remaining outputs are useless to a downstream agent — they describe the meta-task ("a summary was made") without conveying content.

Three contributors to this failure mode:

- **Reasoning-trace dominance.** The thinking trace averaged ~5 200 bytes of CoT text before producing a 50-byte "answer". The model burned its budget arguing with itself about the prompt.
- **Length truncation.** 3 of 10 responses hit `done_reason: length` — the model never escaped the thinking phase.
- **Latency cliff.** p50 = 4.1 s — **8× the 500 ms target**. Thinking traces are expensive on this size.

### 3. LFM2.5-**Instruct** (no thinking) is dramatically better

Same family, no CoT head:

- **98.4 % reduction** (better than the deterministic floor on this corpus).
- **0 failures.**
- **All 10 outputs are real summaries**, not meta-commentary. Spot-checks below.
- **Steady-state latency 200–900 ms** per call. The 8.2 s p95 is the cold-start of the first request; subsequent requests stay sub-second. A persistent Ollama process with `OLLAMA_KEEP_ALIVE` stays in the budget.

Sample Instruct outputs:

```
03-context-thin.json:
  "The relevant code references the PluginRegistry in the lore/src/plugins/registry.ts
   file, located between lines 54 and 713. This file is part of the plugin system and is
   essential for managing plugin loading and registration."

09-file-registry.ts:
  "The code manages plugin loading, collision detection, orphan handling, and telemetry.
   It maintains a registry of plugins, checks for name conflicts, supports both built-in
   and synthetic plugins, and enforces rules like 'keep', 'drop', or 'reenable' for
   orphaned plugins. It also handles plugin registration, schema registration, and cloud
   schema hooks, ensuring proper lifecycle management and conflict resolution."
```

These are useful summaries — not headline-quality but enough for a downstream agent to know whether to drill in.

### 4. Hallucination: a real but partially-noisy signal

The faithfulness checker flagged 125 (Instruct) / 285 (Thinking) "fake identifiers" — strings that look like names but don't appear verbatim in the source. **Manual spot-check: most are false positives** caused by the naive substring check (e.g. `pluginRegistry.active` flagged because the dot-suffix doesn't match). Real hallucinations exist but are rarer than the count suggests. A precise faithfulness pass needs a tokenizer-aware check; the current 125 is a high-water-mark, not the real failure rate.

That said: even with overcounting, neither model is in the < 1 % failure-rate range the strategy doc set as the bar. **A faithfulness-validator + deterministic-fallback wrapper is mandatory** before shipping any LLM preprocessor.

## Decision against the strategy doc's bars

| Bar | Threshold | Deterministic | LFM2.5-Thinking | LFM2.5-Instruct |
|---|---|---|---|---|
| ≥ 60 % byte reduction on responses ≥ 2 KB | — | ✅ 94.5 % | ⚠ 90.2 % gross, but 3/10 unusable | ✅ 98.4 % |
| ≤ 500 ms p95 added latency | — | ✅ < 1 ms | ❌ 4 348 ms | ⚠ 880 ms steady-state, 8 253 ms cold |
| ≤ 1 % failure rate | — | ✅ 0 | ❌ 30 % | ✅ 0 % (with caveat on faithfulness signal noise) |
| Adds ≥ 20 pp beyond deterministic floor | — | (baseline) | ❌ −4.3 pp | ⚠ +3.9 pp |

## Recommendation

1. **Ship the deterministic Phase 6 work** (P0 lazy-schema + P1 mode-trim + P2 negative-evidence). It alone clears the 30–40 % session-wide bar by a wide margin on this corpus.
2. **Do NOT ship LFM2.5-Thinking** as a preprocessor. The Thinking head is the wrong tool for short-form summarisation. Reasoning-trace overhead breaks the latency budget AND produces meta-commentary instead of summaries.
3. **Park LFM2.5-Instruct** as a future option. It produces real summaries at acceptable steady-state latency, but the small *additional* compression beyond the deterministic floor (98.4 % vs 94.5 % = +3.9 pp) doesn't clear the strategy doc's "+20 pp or more" bar. Revisit only if a real-session measurement shows the deterministic transforms can't trim a particular response shape.
4. **The Thinking-vs-Instruct gap is the headline finding.** For Lore's response-compression workload, **always pick the non-thinking head**. The thinking trace is overhead with no measurable quality return, on 1.2 B-class models, on this task class.

## Numbers, full

- [`results/01-deterministic.csv`](results/01-deterministic.csv) — deterministic transform results
- [`results/02-llm-thinking.csv`](results/02-llm-thinking.csv) — LFM2.5-Thinking results
- [`results/02-llm-instruct.csv`](results/02-llm-instruct.csv) — LFM2.5-Instruct results
- [`results/02-llm-thinking-outputs/`](results/02-llm-thinking-outputs) — actual answers (most are meta-commentary)
- [`results/02-llm-instruct-outputs/`](results/02-llm-instruct-outputs) — actual answers (real summaries)

## Caveats

- **Corpus is gitnexus output, not Lore output.** Lore's MCP daemon was not connected during this eval. Gitnexus responses are a faithful proxy for what Lore tools will return — same shape, similar verbosity — but a real Lore session may have different distributions.
- **N = 10.** Enough for direction, not enough for narrow confidence intervals. The N = 30 dataset specified in `research-local-preprocessor-eval.md` is the next step if these numbers are surprising on real Lore sessions.
- **Faithfulness check is naive.** Flags lots of false positives. Manual spot-check confirms real hallucinations exist but at much lower than the raw flag count.
- **Schema-overhead measurement is missing.** Phase 6 P0 (lazy-schema wrapper) was estimated at 5–10 k tokens/turn savings; that's a separate measurement that needs the live Lore MCP daemon.
- **Cold-start dominates Instruct's p95.** The 8.2 s p95 is one outlier; steady-state with `OLLAMA_KEEP_ALIVE` is sub-second. A real deployment must keep the model hot.

## How to re-run

```bash
# from repo root
node experiments/preprocessor-eval/scripts/01-deterministic-eval.mjs
SUFFIX=thinking ollama pull lfm2.5-thinking:1.2b
SUFFIX=thinking node experiments/preprocessor-eval/scripts/02-llm-eval.mjs
SUFFIX=instruct MODEL=LiquidAI/lfm2.5-1.2b-instruct \
  ollama pull LiquidAI/lfm2.5-1.2b-instruct
SUFFIX=instruct MODEL=LiquidAI/lfm2.5-1.2b-instruct \
  node experiments/preprocessor-eval/scripts/02-llm-eval.mjs
```

The corpus and harness are throwaway research — kept under `experiments/preprocessor-eval/` for reproducibility but not part of `npm test`.
