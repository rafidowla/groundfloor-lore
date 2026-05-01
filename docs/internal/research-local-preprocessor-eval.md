# Research: Local 1.2 B Preprocessor via Ollama — Evaluation Plan

> **Status:** Research only — no code changes proposed in this doc.
> Frames the question, names a reference architecture, picks
> three candidate models, and lays out a reproducible eval so we
> can decide go / no-go without speculation.
>
> **Author:** Rafi Dowla. **Date:** 2026-04-30.
> **Companion doc:** [`research-token-efficiency-for-lore.md`](research-token-efficiency-for-lore.md) — broader research on Lore's MCP token surface. This doc is one of the deferred tracks (P4) from that doc.
> **Triggered by:** "Can we try out a local 1.2 B preprocessor using Ollama?"

---

## 1. The idea, in plain English

Today every Lore tool response goes straight from the daemon to the main agent (Claude). When a response is large — say a `code_query` that returned 50 symbols, or a `recall` that pulled a long verbatim document — the main agent pays the full token cost even though it usually wants only the headline answer.

A **local preprocessor** sits in between. When a response exceeds a token budget, the preprocessor — running on this machine, in Ollama, costing zero API tokens — summarises or trims the response before it reaches the main agent. The main agent sees a small, decision-ready answer; the daemon still has the full data on disk if a follow-up needs it.

The reference implementation already exists: **[mcp-context-proxy](https://github.com/samteezy/mcp-context-proxy)** by samteezy. It is an OpenAI-API-compatible MCP proxy that triggers compression when a response exceeds `tokenThreshold` (default 1 000 tokens). It auto-detects content type (code / JSON / text) and applies the matching strategy. One example: **14 246 → 283 tokens** on a metadata response.

This doc is not "build that." It's "evaluate whether running it in front of Lore is worth the new failure mode."

---

## 2. Why a 1.2 B model and not, say, a 7 B or 70 B?

Three constraints push the size down:

1. **Latency budget.** The preprocessor sits in the response path; every extra millisecond delays every tool call. A 1–2 B Q4-quantised model on Apple Silicon decodes 50–80 tok/s. A 200-token summary returns in ~3 s. A 7 B model would push it past 10 s and break the interactive feel.
2. **Memory budget.** A 1.2 B Q4 model uses ~700 MB–1 GB of RAM. A 7 B model uses ~5 GB. Lore's daemon already shares the laptop with Cursor / Claude Code / a browser stack; a small model is the only one that can sit hot in memory all day.
3. **Quality is enough.** The preprocessor's job is **summarise / extract / compress**, not reason or write code. Sub-2 B models in 2026 are competent at exactly that class of work. Cheap-and-okay beats slow-and-perfect for this workload.

The "1.2 B" target the user named maps cleanly to **LFM2-1.2B** (Liquid AI's edge-optimised model series). It's available on Ollama. There are sibling options at similar sizes — Qwen2.5-1.5B, SmolLM2-1.7B, Llama-3.2-1B — that should be evaluated in the same harness.

---

## 3. Candidate models

| Model | Params | RAM (Q4) | Decode (M-series) | Notable strengths | Notable weaknesses | Ollama tag |
|---|---|---|---|---|---|---|
| **LFM2-1.2B** (Liquid AI) | 1.2 B | ~700 MB | 80–120 tok/s | Edge-optimised hybrid Liquid architecture; **2× faster decode/prefill on CPU than Qwen3**; competitive with Qwen3-1.7B at 47 % fewer params; agentic-tasks + RAG + extraction explicitly named as recommended use cases | Not recommended for knowledge-intensive or programming-heavy tasks (matches our use case — we don't need either) | `sam860/LFM2:1.2b`, `LiquidAI/lfm2.5-1.2b-instruct`, `lfm2.5-thinking:1.2b` |
| **Qwen2.5-1.5B-Instruct** | 1.5 B | ~900 MB | 60–90 tok/s | Strong instruction-following; multilingual; massive ecosystem; reliable function-calling | Slightly larger than spec; older architecture | `qwen2.5:1.5b` |
| **SmolLM2-1.7B-Instruct** | 1.7 B | ~1.0 GB | 50–80 tok/s | **Best benchmarks in class**: HellaSwag 68.7 / ARC-Avg 60.5 / PIQA 77.6, beating Llama-1B and Qwen2.5-1.5B on each; HuggingFace native; explicit summarisation + function-calling training | Largest of the candidates | `smollm2:1.7b` |
| **Llama-3.2-1B-Instruct** | 1.2 B | ~700 MB | 90–120 tok/s | Smallest, fastest, **most fine-tunable** in benchmarks | Lowest baseline quality of the four; needs fine-tune to compete | `llama3.2:1b` |

> **Pick for the eval:** all four. The eval below scores them against the same task set so we get a real comparison rather than a vendor-pitch summary.

A **fifth candidate** worth including for the very-low-end: **Qwen3-0.6B** (used in mcp-context-proxy's example config). At 0.6 B / 250 ms / call it's the floor of what's feasible. Worth the ~30 minutes to add to the harness.

---

## 4. Where would the preprocessor sit in Lore?

Three possible insertion points. Each is a different design.

| Point | Where | Pros | Cons |
|---|---|---|---|
| **(a) Inside the tool handler** | Modify each MCP tool to call the local model when its response is over budget | Per-tool tuning; preprocessor sees structured intermediate state | Touches every tool; tight coupling between Lore and Ollama; hard to disable |
| **(b) MCP-server middleware** (FastMCP-style) | One layer wrapping all `tool_call` responses | Single change point; tool authors don't think about it; can be toggled per workspace | Preprocessor sees the response after JSON serialisation; structure is harder to use |
| **(c) Standalone proxy** between Lore daemon and the agent | Run mcp-context-proxy (or a fork) between Claude Code and Lore | **Zero changes to Lore source**; proven third-party project; can be used in front of any MCP server | Extra process to keep alive; another local port; needs lifecycle management |

**Recommended for the eval: (c)** — pure proxy, no Lore changes, lowest blast radius. If the eval shows wins, the migration to (b) inside Lore's MCP server is a follow-up that's easier to justify.

---

## 5. Eval plan

### 5.1 Goal

Decide go / no-go on shipping a local-preprocessor mode for Lore by the end of Q3. Concrete success criteria:

- **≥ 60 % byte reduction** on responses ≥ 2 000 tokens (Lore's current cliff for big `recall` and `code_query` results).
- **No semantic regression** — the preprocessed response must let the agent reach the same conclusion the full response would have.
- **≤ 500 ms p95 added latency** on M-series Apple Silicon.
- **≤ 1 % failure rate** (malformed output, model hallucination not caught by validators).

### 5.2 Dataset — 30 representative responses

Capture 30 real Lore tool responses across the three task families:

| Family | Tool examples | Sample size |
|---|---|---|
| **Code lookups** | `code_context`, `code_query`, `code_impact` | 12 |
| **Knowledge recall** | `recall`, `get_full`, `search` | 12 |
| **Verbatim docs** | Long PDF/markdown ingestion outputs | 6 |

For each: store the raw response (golden full version), the user prompt that produced it, and a hand-written "ideal summary" the preprocessor should emit (~ 200 tokens, decision-ready).

### 5.3 Metrics

| Metric | What it measures | How |
|---|---|---|
| **Compression ratio** | Bytes-out / bytes-in | Direct |
| **Faithfulness** | Does the summary say things the source didn't? | LLM-as-judge using Claude (one batch eval, deterministic temperature) |
| **Coverage** | Does the summary include the answer the user needed? | LLM-as-judge against the hand-written ideal |
| **Latency p50 / p95** | Wall-clock time from "model receives prompt" to "model finishes streaming" | Measured in harness |
| **Failure rate** | Malformed JSON / refusal / hallucinated structure | Counted in harness |
| **Cold-start cost** | First-call latency vs steady-state | Measured separately |

### 5.4 Harness shape

A small Node script (~100 lines, uncommitted experimental) that:

1. Loads the 30-response dataset.
2. For each response: serialises the input, sends to each candidate model via Ollama's HTTP API, captures output + timing.
3. Sends each (input, output, ideal) triplet to Claude as judge for faithfulness + coverage scores.
4. Writes a results CSV: `model × response_id → ratio, latency_p50, latency_p95, faithfulness, coverage, failed`.

No changes to Lore code. The harness lives at `experiments/preprocessor-eval/` and is treated as throwaway research.

### 5.5 Cells to fill

| Model | Compression | Faithfulness | Coverage | Latency p50 | Latency p95 | Failure % |
|---|---|---|---|---|---|---|
| LFM2-1.2B | ? | ? | ? | ? | ? | ? |
| Qwen2.5-1.5B | ? | ? | ? | ? | ? | ? |
| SmolLM2-1.7B | ? | ? | ? | ? | ? | ? |
| Llama-3.2-1B | ? | ? | ? | ? | ? | ? |
| Qwen3-0.6B (floor) | ? | ? | ? | ? | ? | ? |

Decision rule: pick the model with **highest coverage at ≥ 60 % compression**, tie-broken by latency. If no model clears the bar, the answer is "stay deterministic" (the P0/P1 work in the companion doc) and revisit when the small-model frontier moves.

---

## 6. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **Hallucinated summaries** — model invents API surfaces, line numbers, function names | Critical (would be worse than no compression) | Pass through faithfulness check; require literal substring match for any cited identifier; fall back to deterministic truncation when the check fails |
| **Latency cliff** on cold-start of Ollama process | Medium | Keep model loaded ("hot") via Ollama's `OLLAMA_KEEP_ALIVE` env; budget the cold-start cost separately |
| **Ollama lifecycle** — process dies, port races, etc. | Medium | Health-check + auto-restart; fail open (return original response) if Ollama is down |
| **Cross-model drift** — agent learns to expect specific summary shape, then we change models | Low | Pin model in workspace config; bump only on explicit user opt-in |
| **Privacy** — preprocessor sees every Lore tool response | Low (already local) | Document explicitly; never log preprocessor inputs; same security perimeter as Lore daemon today |
| **Scope creep** — temptation to use the local model for "smart routing" / "query rewriting" too | Medium | This eval is **summarisation only**. Routing is a separate eval, separate doc, separate decision. |

---

## 7. What this doc deliberately doesn't propose

- **No** rewriting Lore tools to call Ollama internally. Eval uses pattern (c) — external proxy — first.
- **No** model fine-tuning. Out-of-the-box models only; if quality is not enough off-the-shelf, the answer is "this approach doesn't work for us yet" rather than "let's tune."
- **No** preprocessor for tool **inputs** (query rewriting). That's a different problem with different tradeoffs; defer.
- **No** decision dependency on the Phase 6 P0 (schema overhead) work. The two are independent — schema overhead is per-turn, preprocessor is per-call. Both can ship; either can ship alone.

---

## 8. Open questions

| Q | Question | How to decide |
|---|---|---|
| Q1 | Is mcp-context-proxy the right harness, or do we want to build something Lore-native? | Use mcp-context-proxy as-is for the eval; build native only if results are positive AND its config doesn't fit |
| Q2 | Token-budget threshold — at what response size does the preprocessor kick in? | Start at 2 000 tokens; let M-pipeline tell us whether smaller or larger is right |
| Q3 | Per-workspace toggle? | Yes — developer workspace probably wants it on, family workspace probably not (responses are smaller, summarisation risk is higher) |
| Q4 | Streaming vs batch? | Batch — simpler, and the preprocessor target is single-call summarisation, not multi-turn |
| Q5 | Should the proxy run as a launchd service or in-process? | Launchd long-term; in-process for the eval to keep moving parts low |

---

## 9. Sources

- [LFM2 announcement — Liquid AI](https://www.liquid.ai/blog/liquid-foundation-models-v2-our-second-series-of-generative-ai-models)
- [LiquidAI/LFM2-1.2B on Hugging Face](https://huggingface.co/LiquidAI/LFM2-1.2B)
- [Ollama — sam860/LFM2:1.2b](https://ollama.com/sam860/LFM2:1.2b)
- [Ollama — lfm2.5-thinking:1.2b](https://ollama.com/library/lfm2.5-thinking:1.2b)
- [Ollama — LiquidAI/lfm2.5-1.2b-instruct](https://ollama.com/LiquidAI/lfm2.5-1.2b-instruct)
- [SmolLM2 announcement — Neurohive](https://neurohive.io/en/state-of-the-art/smollm2-open-source-compact-llm-by-hugging-face-outscoring-llama-1b-and-qwen2-5-1-5b/)
- [Qwen2.5 LLM blog](https://qwenlm.github.io/blog/qwen2.5-llm/)
- [mcp-context-proxy by samteezy](https://github.com/samteezy/mcp-context-proxy/)
- [Apple Silicon LLM Benchmarks — llmcheck.net](https://llmcheck.net/benchmarks)
- [MLX vs Ollama on Apple Silicon (2026) — willitrunai.com](https://willitrunai.com/blog/mlx-vs-ollama-apple-silicon-benchmarks)
- [Best Ollama Models 2025 — collabnix](https://collabnix.com/best-ollama-models-in-2025-complete-performance-comparison/)
- [Top 7 Small Language Models You Can Run on a Laptop — Machine Learning Mastery](https://machinelearningmastery.com/top-7-small-language-models-you-can-run-on-a-laptop/)
- [12 Small Language Models Benchmarked Across 8 Tasks — distil labs](https://www.distillabs.ai/blog/we-benchmarked-12-small-language-models-across-8-tasks-to-find-the-best-base-model-for-fine-tuning/)
