# Strategy: MCP Token Efficiency for Lore — Adjusted

> **Status:** Adjusted strategy based on the gitnexus + jCodeMunch research and the locked LFM2.5-1.2B-Thinking model decision. Companion to:
> - [`research-token-efficiency-for-lore.md`](research-token-efficiency-for-lore.md) — the research findings
> - [`research-local-preprocessor-eval.md`](research-local-preprocessor-eval.md) — the model decision
> - [`../../experiments/preprocessor-eval/`](../../experiments/preprocessor-eval/) — the live eval harness + numbers
>
> **Author:** Rafi Dowla. **Date:** 2026-04-30.

---

## TL;DR — what changes vs the locked plan

| Area | Before research | After research |
|---|---|---|
| Phase 6 framing | "Register 18 `code_*` MCP tools" | **Stays.** But add a P0 schema-reduction step **before** registering them. |
| Schema overhead | Not addressed | **P0 deliverable**: lazy-schema wrapper (`lore_tool_schema` + `lore_tool_invoke`) — single biggest win, no LLM needed. |
| Two-tier `mode` | Schema accepts the parameter; trim is half-built | **P1 deliverable**: per-tool audit confirming `thin` actually returns < 400 bytes per result. |
| Multi-tool tail | No "stop" signal | **P2 deliverable**: every response carries `_meta.confidence` + `negative_evidence` when low-confidence. |
| Compact wire format | Out of scope | **Defer.** Worth it only if P0+P1+P2 don't close the gap. |
| Local LLM preprocessor | Not in plan | **New parallel track**: eval LFM2.5-1.2B-Thinking as a response-path compressor. **Independent of Phase 6** — both can ship, either can ship alone. |
| Success bar | "Match GitNexus baseline" | **30–40 % reduction vs Claude-Code-with-Read** on a held-out task suite. NOT 95 %. |

---

## 1. Why the strategy needs adjusting

The locked plan (`docs/PLAN_replace_gitnexus_in_developer_plugin.md`) describes a complete code-intelligence rebuild but says little about token-efficiency engineering. The research found:

1. **The biggest single token cost is schema overhead, paid every turn before any tool runs.** Lore has no knob for it. jCodeMunch saves 5–7 k tokens / turn here alone.
2. **Lore's existing two-tier `mode` parameter is half-built.** The schema accepts it; the implementations don't reliably trim. That's why our previous attempt at savings was invisible.
3. **The 95–100× headlines from competitors measure a baseline Lore doesn't share.** Their production A/B test puts savings at 15–25 %. The honest target for Atlas is 30–40 %.
4. **Agents bypass the MCP** when the user names a file path or when Read is faster. Tool design has to assume agents will route around the MCP unless it's clearly the cheapest option.
5. **A small local model in the response path is a complement, not a substitute** — it solves a different problem (dynamic compression of unbounded responses) and shouldn't pre-empt the deterministic wins.

---

## 2. Adjusted Phase 6 deliverables

> The locked plan §3 Phase 6 calls for registering 18 `code_*` tools + back-compat aliases. Below is the same Phase 6, with three new prerequisites bolted on the front.

### P0 — Lazy-schema wrapper (NEW)

**What:** replace the 18-tool `tools/list` exposure with two stable shims plus a small browse tool:
- `lore_tool_schema(name)` — fetches the full schema for one tool on demand.
- `lore_tool_invoke(name, input)` — executes any tool by name.
- `lore_tool_list(category?)` — returns a thin index: `{ name, one-line summary }[]`.

**Why:** matches the Atlassian-mcp-compressor pattern and the new built-in Claude Code "tool search" mode. Saves an estimated **5–10 k tokens / turn** on the catalog overhead.

**Cost:** one extra round-trip per first call to a new tool. Acceptable — the trip is cheap (sub-second) compared to the catalog cost it avoids.

**Acceptance:** `tools/list` JSON-RPC response < 600 tokens with all 18 tools available behind the shim. Verified via `experiments/preprocessor-eval/01-deterministic-eval.mjs`.

### P1 — Per-tool `mode` audit + enforcement (NEW)

**What:** for every Lore tool that accepts `mode: 'thin' | 'standard' | 'full'`, verify by direct measurement:
- `thin` → ≤ 400 bytes per result item.
- `standard` → ≤ 1.5 KB per result item.
- `full` → no cap.

**Why:** the locked "two-tier principle" is real only if the implementations enforce it. The research found this is the second-biggest miss after schema overhead.

**Acceptance:** a regression test per tool that fails if a `thin` response exceeds the cap. Integrated into `npm run test:arch` so drift is caught at commit time.

### P2 — `_meta.confidence` + `negative_evidence` (NEW)

**What:** every Lore tool response carries:
- `_meta.confidence: 0..1` — calibrated score.
- `negative_evidence: string[]` — when confidence is low, list what was searched and didn't match.

**Why:** the multi-tool tail (agent loops `query → context → context → context` looking for a thing that isn't there) burns 1–3 redundant calls per dead-end. Telegraphing "stop, this isn't here" cuts those tails immediately. jCodeMunch ships this; it's cheap.

**Acceptance:** all 18 `code_*` tools return both fields in every response.

### P3 — register the 18 `code_*` tools

**What:** the original Phase 6 work — but now landing through the lazy-schema shim, with the `mode` audit + negative-evidence pattern as ground rules.

**Why:** unchanged from the locked plan.

### P4 — Compact wire format (DEFER)

**What:** custom JSON-flavoured encoding (à la jCodeMunch's MUNCH or mcp-compressor's TOON). 45 % median bytes saved per response.

**Why defer:** P0 + P1 + P2 are deterministic and cheap; if they hit the 30–40 % bar, P4 is gold-plating. Revisit only if a held-out task suite shows a measurable gap.

---

## 3. Local-LLM preprocessor — parallel track

Independent of Phase 6. Lives at [`research-local-preprocessor-eval.md`](research-local-preprocessor-eval.md). Decision rule:

1. Run the deterministic eval (P0+P1+P2 simulation) first — establish the floor.
2. Run LFM2.5-Thinking eval on top of the deterministic floor.
3. Ship the preprocessor only if it adds **≥ 20 percentage points** of additional reduction beyond the deterministic floor at ≤ 500 ms p95 added latency.

If the deterministic work alone hits 30–40 % savings AND the preprocessor adds < 20 pp on top, the preprocessor is not worth the new failure mode (hallucinated summaries, Ollama lifecycle, model drift).

If the deterministic work hits 30–40 % AND the preprocessor adds another 30+ pp, ship both.

### Eval result (2026-04-30) — preprocessor parked

The eval ran. Numbers in [`experiments/preprocessor-eval/FINDINGS.md`](../../experiments/preprocessor-eval/FINDINGS.md). Three conclusions:

- **Deterministic transforms hit 94.5 % reduction on this corpus** — well clear of the 30–40 % bar without any LLM in the path.
- **LFM2.5-Thinking is the wrong head.** It produces meta-commentary ("the summary adheres strictly to specified constraints") instead of summaries on 8 of 10 responses, fails on 3, and runs at 4 s p50 latency — 8× the budget.
- **LFM2.5-Instruct (no thinking) produces real summaries at sub-second latency**, but only adds +3.9 pp beyond the deterministic floor (98.4 % vs 94.5 %). That's well below the +20 pp threshold for shipping, so the preprocessor is parked.

If a future real-session measurement shows the deterministic transforms can't compress a particular response shape, the preprocessor revisit uses **LFM2.5-Instruct**, not Thinking. The `lfm2.5-thinking:1.2b` Ollama model is **not** the right tool for this workload — the reasoning trace is overhead without measurable quality return on 1.2 B-class summarisation.

---

## 4. Success bar — concrete

| Bar | Target | Measured how |
|---|---|---|
| Schema overhead | < 600 tokens / turn (down from estimated 4–8 k) | Count `tools/list` JSON-RPC bytes, tokenize |
| Single-symbol `code_context` (thin mode) | < 400 bytes per result | Compare to `Read` of one file (typically 5–30 KB) |
| Multi-tool tail | ≤ 1.2 average tool calls / user-question | Session-log audit; aim to halve from estimated current 2–3 |
| Total session reduction | **30–40 %** vs Claude-Code-with-Read on a 10-task held-out suite | Side-by-side measurement |
| Preprocessor adds | **+20 pp or more** beyond deterministic floor | Eval harness cells in `experiments/preprocessor-eval/results/` |

---

## 5. Sequencing

1. **Now (this session):** Run the deterministic + LFM2.5-Thinking evals (small corpus, real numbers). Document findings. **No Lore code changes yet.**
2. **After Phase 1–5 of the locked plan ship** (~6–8 weeks): start Phase 6, beginning with P0 (lazy-schema). Use this strategy doc as the spec.
3. **In parallel** to Phase 6: if the LFM2.5-Thinking eval says "ship it," start the preprocessor as a standalone proxy (samteezy/mcp-context-proxy as the harness; build native if needed).
4. **End of Q3:** measure session reduction against the 30–40 % bar. If we miss, revisit P4 (compact wire format) or admit Lore-is-not-yet-token-efficient.

---

## 6. What this strategy deliberately doesn't do

- **Doesn't** chase 95 % headlines. Wrong baseline.
- **Doesn't** invent a new compact wire format before exhausting deterministic schema reduction.
- **Doesn't** make the preprocessor the headline fix. It's a complement.
- **Doesn't** delay Phase 1–5 work. The deterministic Phase 6 prerequisites (P0/P1/P2) only land after Phase 5; they're upstream of tool registration but downstream of the parser/resolver/analytics work.
