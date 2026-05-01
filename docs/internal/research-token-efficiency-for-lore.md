# Research: Token Efficiency for Lore's MCP Surface

> **Status:** Research only — no code changes proposed in this doc.
> Writes the open questions, the measurements we need, and the
> mechanisms competitors use, so that Phase 6 (and any earlier
> work that touches the MCP surface) lands with the right design.
>
> **Author:** Rafi Dowla. **Date:** 2026-04-30.
> **Companion doc:** [`research-local-preprocessor-eval.md`](research-local-preprocessor-eval.md) — separate eval of a 1.2 B local model in the response path.
> **Triggered by:** Lore's own attempts at the two-tier (`thin` / `standard` / `full`) pattern have not produced visible token savings in real Claude Code sessions. This doc figures out why.

---

## 1. Problem statement

GitNexus and jCodeMunch publish dramatic token-reduction claims (60–100×, 95 % reductions). When we built similar mode toggles into Lore, the savings did not materialise. Three possibilities:

1. **Their numbers measure a baseline we don't share.** Their wins may evaporate against Claude Code's first-class `Read` / `Grep` / `Glob`.
2. **They cut tokens in a place Lore does not yet cut.** The MCP `tools/list` schema overhead — paid on every turn, before any tool runs — is the single biggest line item, and Lore has no `tool_profile` / `compact_schemas` knob today.
3. **Agents bypass our MCP entirely** when the user names a file path or when the agent already has the file's content from a prior turn. The savings only land when the agent is forced through the MCP — a smaller fraction of real sessions than the published benchmarks assume.

This doc replaces guessing with measurement.

---

## 2. Where token cost actually accrues

There are **four distinct buckets** of tokens an MCP server can spend or save. Most analyses confuse them. Lore needs separate strategies per bucket.

| Bucket | Paid when? | Typical size | Lore today | jCodeMunch | mcp-compressor |
|---|---|---|---|---|---|
| **A. Schema overhead** (`tools/list` JSON) | Every turn — before any tool is called | 1.5–17 k tokens, depends on tool count | **No reduction knob** | `tool_profile` + `compact_schemas` (~5–6 k saved) | `get_tool_schema` + `invoke_tool` wrapper (78–97 % saved) |
| **B. Per-call response body** | Every tool call | 0.5–60 k tokens, depends on shape | Partial `mode` knob; trims unclear | Outline-first + `format=compact` (45 % median, 55 % peak) | Out of scope |
| **C. Multi-turn redundancy** | When the agent re-asks for the same thing | 1–10 k tokens / re-ask | Stable UIDs (good) | Stable UIDs + session snapshot (~200 token re-injection) | Out of scope |
| **D. Multi-tool tail** | When the agent loops `query → context → context → context` | 5–30 k tokens / loop | No "stop" signal | `negative_evidence`, `_meta.confidence`, `plan_turn` router | Out of scope |

Lore's `mode: thin | standard | full` design only touches bucket B. The biggest single competitor win — Atlassian-mcp-compressor's 17 600 → 500 token cut — is **entirely in bucket A**, which Lore has not addressed. That alone can explain why our two-tier work didn't show up in totals.

---

## 3. What we actually know — competitive deep-dive

Sources at the bottom; this section paraphrases.

### 3.1 jCodeMunch's published numbers

| Number | Scenario | Honesty |
|---|---|---|
| **95.0 % aggregate, 58–100×** | 15 task-runs across Express / FastAPI / Gin **vs full-file concatenation** | Real but the baseline is "read every file in the repo" |
| **45.5 % median, 55.4 % peak** | "MUNCH" compact wire format vs JSON | Pure byte compression; lossless |
| **15–25 %** | Production A/B test in real workflows | The honest number for normal sessions |
| **5.5×** | One Geeky-Gadgets reviewer (3850 → 700 tokens) | One scenario; cherry-picked |

The **15–25 %** figure is the one to plan against. The **95 %+** figure measures a workflow no Claude Code session resembles (full-file concatenation as the alternative).

### 3.2 jCodeMunch's actual mechanisms (in order of token impact)

1. **MCP schema reduction (bucket A).** `tool_profile: "core" | "standard" | "full"` selects 16 / 51 / 62 tools. `compact_schemas: true` strips rarely-used parameters from the schemas that DO appear. Together: ~11.5 k → ~4 k tokens on `tools/list`. Recommended config saves **~7.5 k tokens / turn**.
2. **Outline-first retrieval (bucket B).** `get_file_outline` returns symbol signatures + 1-line summaries; `get_symbol_source` then fetches one body by stable ID. Replaces the brute-read pattern of "open the whole file to find one function."
3. **MUNCH compact format (bucket B).** Custom JSON-flavoured encoding: path prefixes interned to short handles; homogeneous lists of dicts pack into single-character-tagged CSV rows; lossless. 45 % median bytes saved.
4. **Stable symbol UIDs (bucket C).** Every symbol has an ID like `Class:packages/lore/.../registry.ts:PluginRegistry`. Round-tripped between turns, no re-search needed. Lore already does this.
5. **`negative_evidence` + confidence scores (bucket D).** When a search has low confidence, the response says "this isn't here" — the agent stops looping. Saves 1–3 redundant tool calls per dead-end.
6. **Session snapshot + `plan_turn` router (bucket C/D).** ~200-token markdown summary of session-so-far for re-injection. `plan_turn(model="claude-haiku")` adapts tier to the model's context budget.

### 3.3 GitNexus's mechanisms

GitNexus publishes **no concrete token numbers**. Its tagline is "1 query vs 4+ queries" — a bucket-D claim about reducing the number of turns, not the size of any single turn. Empirical measurement on this repo confirms:

| Surface | Bytes | ~Tokens | vs `Read` of one file |
|---|---:|---:|---:|
| `Read packages/lore/src/plugins/registry.ts` | 30 593 | ~7 650 | (baseline) |
| `gitnexus context PluginRegistry` (thin) | 8 290 | ~2 070 | **−73 %** |
| `gitnexus context PluginRegistry --content` | 13 467 | ~3 365 | −56 % |
| `gitnexus impact PluginRegistry --depth 2` | 8 047 | ~2 000 | −74 % |
| `gitnexus query "plugin registry" -l 3` | 5 886 | ~1 470 | −81 % |
| `gitnexus query "plugin registry" -l 3 --content` | 65 536 | ~16 400 | **+115 %** (worse than file Read) |

A single targeted `gitnexus context` is a real win. A multi-symbol `query --content` is **worse than reading the file**. The savings are not unconditional.

### 3.4 The Atlassian / community patterns

- **Atlassian's own MCP** ships at ~10 000 tokens of schema. **GitHub's** is ~17 600 tokens for 94 tools. **Combined four-server setups** routinely hit 30 k+ tokens of context overhead per request before a single user prompt is typed.
- **Atlassian-mcp-compressor** wraps any MCP server and replaces the tool inventory with two shims: `get_tool_schema(tool_name)` and `invoke_tool(tool_name, input)`. The agent sees one thin "tool catalog" and pulls schemas on demand. **17 600 → 500 token reduction (97 %)**. Pure deterministic schema rules — no LLM.
- **Claude Code** itself recently shipped "tool search" mode where only tool names appear at session start and full schemas are fetched on demand. They cite **13 000+ tokens saved** in heavy sessions. This is the same pattern.

The schema-overhead problem is so well-known by April 2026 that there is now a small ecosystem of MCP proxies that solve it. Lore should not invent its own approach — it should adopt the `tool_profile` + lazy-schema pattern the field has converged on.

---

## 4. Lore's current state — empirical baseline

> **Need to measure for real before we change anything.** Numbers below are estimates from reading the source; replace with measurements from a live session.

### 4.1 Tool count

`grep "server.tool(" packages/lore*/src/**/*.ts packages/lore/src/mcp/server.ts` returns **27 tool registrations**:

- `packages/lore-plugin-developer/src/tools.ts` — 12 tools (`code_query`, `code_context`, `code_impact`, `code_cypher`, `gitnexus_*` aliases, `link_knowledge_to_code`, …)
- `packages/lore-plugin-developer/src/atlasToolsRegistrar.ts` — 12 tools (Atlas-named family, looks like an early Phase-6 stub)
- `packages/lore-plugin-personal/src/tools.ts` — 3 tools
- (core `mcp/server.ts` registers a recall surface — count separately)

**At 12–17 tools the schema budget is 1.5–4 k tokens** if descriptions are tight; **5–8 k tokens** if descriptions are verbose paragraphs (which several Lore tools are today). Worth measuring exact bytes via `tools/list`.

### 4.2 Two-tier response sizes — current shape

Lore's `recall`, `code_context`, `code_query`, `get_full`, `lore_status` tools each accept (or used to accept) a verbosity parameter. Empirical question for Phase 6 work:

| Tool | `mode: thin` returns | `mode: standard` returns | `mode: full` returns |
|---|---|---|---|
| `recall` | ? | ? | ? |
| `code_context` | ? | ? | ? |
| `code_query` | ? | ? | ? |
| `gitnexus_context` (alias) | ? | ? | ? |

These need to be filled in from real responses. The **claim** of the locked plan ("two-tier principle, full for humans, surgical for AI") needs a per-tool audit confirming each `thin` response actually trims content rather than just dropping a few fields.

### 4.3 Likely root causes — ranked hypotheses

| # | Hypothesis | Evidence supports? | Cost to verify |
|---|---|---|---|
| H1 | Schema overhead is the single biggest cost; Lore has no knob | Strong — matches every competitor's #1 fix | 1 h: count `tools/list` bytes |
| H2 | Lore's `thin` mode doesn't actually trim bytes — only drops fields | Plausible — no per-tool audit exists | 2 h: 5 sample tool calls per mode, diff bytes |
| H3 | Real Claude Code sessions bypass Lore tools when path is named | Strong — matches community reports + jCodeMunch's own 15–25 % production figure | 1 day: session-log audit on 5 recent sessions |
| H4 | Multi-tool tails (no `negative_evidence`) burn 1–3 redundant calls per query | Plausible | 4 h: instrument 1 session |
| H5 | No compact wire format → response bytes 30–45 % above floor | Plausible but secondary | Out of scope until H1/H2 done |

H1 and H2 are the cheap wins. H3 is the honesty check.

---

## 5. What we need to measure (research deliverables)

Before any code change to Lore's MCP surface, run **five measurements**. None requires touching the code path — only running existing tools and counting bytes.

| # | Measurement | How | Output |
|---|---|---|---|
| M1 | **Lore `tools/list` schema size** | Run Claude Code with Lore + the developer plugin loaded; capture the raw `tools/list` JSON-RPC response; tokenize with `tiktoken` | Single number: tokens / turn from schema |
| M2 | **Per-tool response sizes** at each mode | Make 5 calls per tool, varying `mode`; record byte sizes | Table: `tool × mode → bytes` |
| M3 | **Real-session bypass rate** | Pick 5 recent Claude Code sessions; for each user prompt, label whether the agent used Read / Grep / Glob OR a Lore code tool | Fraction `lore_used / total` per task type |
| M4 | **Schema-vs-body tokens per turn** | Pipe `npx tiktoken-cli` over a real session transcript; group by message role + tool | Stacked-bar chart: schema / system / tool-resp / user / assistant per message |
| M5 | **Comparison against `gitnexus query/context/impact`** on identical questions | Make the same 10 queries against Lore and gitnexus; record bytes | Table: `query → lore_bytes vs gitnexus_bytes` |

These five measurements give us numbers to design against. Without them, the Phase 6 design will recapitulate the Phase 5 mistake (good intentions, no measurement, no visible improvement).

---

## 6. Recommendations — what Lore should adopt, in priority order

> **No code changes proposed in this doc.** This is the research conclusion the next planning session should turn into Phase 6 deliverables.

### P0 — schema-overhead reduction (bucket A)

The single biggest lever. Two options, in increasing scope:

1. **Lazy-schema pattern (Atlassian-style).** Replace the 27-tool tools/list with two stable shims: `lore_tool_schema(name)` and `lore_tool_invoke(name, input)`. Agent sees one thin catalog (~500 tokens), pulls schemas on demand. **Expected savings: 4–10 k tokens / turn.** Drawback: extra round-trip per first call to a new tool.
2. **`tool_profile` + `compact_schemas` knobs (jCodeMunch-style).** Add a server config that selects which subset of tools is exposed (`core` / `standard` / `full`) and whether descriptions are stripped to one sentence. **Expected savings: 3–7 k tokens / turn.** Drawback: needs per-tool curation; different agents need different defaults.

Recommend **#1 as the long-term move**, **#2 as a fast follow** for the case where the agent does want richer descriptions. Both are well-trodden patterns; Lore implements them rather than inventing.

### P1 — per-tool `mode` audit + enforcement (bucket B)

For every Lore tool that accepts `mode`, verify by measurement that:

- `thin` returns ID + label + 1-line snippet only.
- `standard` returns ID + label + signature + file:line + short context.
- `full` returns full body + neighbours + metadata.

If any tool's `thin` mode is not <400 bytes for a single result, fix it. The two-tier principle is half-built today; finish the build before adding new modes.

### P2 — `negative_evidence` + `_meta.confidence` on every response (bucket D)

Telegraphing "this isn't here, stop looking" cuts the multi-tool tail by 1–3 calls. Trivial to add to existing handlers.

### P3 — Compact wire format (bucket B)

**Defer.** Useful but secondary to P0/P1. If P0 + P1 land and there's still a gap to jCodeMunch's numbers, revisit. MUNCH's spec is documented; mcp-compressor's TOON format is another option.

### P4 — Local 1.2 B preprocessor

**Separate research track.** See companion doc: [`research-local-preprocessor-eval.md`](research-local-preprocessor-eval.md). The preprocessor is interesting but it solves a different problem (dynamic response compression for unbounded responses) and shouldn't pre-empt the cheap, deterministic wins above.

---

## 7. Open questions — things to decide before Phase 6

| Q | Question | Default answer | Decide by |
|---|---|---|---|
| Q1 | Lazy-schema vs `tool_profile` — which pattern? | Lazy-schema (option 1 above) for Lore; `tool_profile` is a fast-follow | Phase 6 kickoff |
| Q2 | Where does the schema knob live — server config, workspace config, per-tool? | Workspace config (`.lore/config.json`) — different workspaces care about different tools | Phase 6 kickoff |
| Q3 | Default tool tier — what does a fresh install ship with? | `core`: ~10–12 tools the developer-plugin agent uses 80 % of the time | Phase 6 kickoff |
| Q4 | Drop the `gitnexus_*` aliases sooner if they double the schema cost? | Keep through one release per locked plan, but flag if measurement shows them as a top contributor | After M1 measurement |
| Q5 | Session snapshot tool (jCodeMunch-style)? | Defer to Phase 7+ — only useful at the right scale | Phase 6 review |
| Q6 | What's the realistic success bar Atlas should hit? | **30–40 % token reduction** vs Claude-Code-with-Read on a held-out task suite. NOT 95 %. | Phase 6 kickoff |

---

## 8. Things this doc deliberately doesn't recommend

- **Don't** chase the 95 %+ headline. It measures a baseline Lore doesn't share.
- **Don't** invent a new compact wire format before exhausting deterministic schema reduction.
- **Don't** ship a 1.2 B model preprocessor as the headline fix — it's a complement, not a substitute, and adds a new failure mode.
- **Don't** rip out the `gitnexus_*` aliases on a token-savings rationale; the locked plan keeps them for one release for AI-agent compatibility.

---

## 9. Sources

- [GitNexus README](https://github.com/abhigyanpatwari/GitNexus)
- [jCodeMunch README](https://github.com/jgravelle/jcodemunch-mcp/blob/main/README.md)
- [jCodeMunch USER_GUIDE](https://github.com/jgravelle/jcodemunch-mcp/blob/main/USER_GUIDE.md)
- [jCodeMunch vs alternatives](https://j.gravelle.us/jCodeMunch/versus.php)
- [Atlassian — MCP Compression: Preventing tool bloat in AI agents](https://www.atlassian.com/blog/developer/mcp-compression-preventing-tool-bloat-in-ai-agents)
- [Atlassian Labs — mcp-compressor](https://github.com/atlassian-labs/mcp-compressor)
- [Claude Code MCP server token overhead — MindStudio](https://www.mindstudio.ai/blog/claude-code-mcp-server-token-overhead)
- [How MCP tool definitions inflate AI agent token costs — BSWEN](https://docs.bswen.com/blog/2026-04-24-mcp-token-overhead/)
- [Pydantic — Engineering MCP tools for token efficiency](https://pydantic.dev/articles/engineering-mcp-tools-for-token-efficiency)
- [StackOne — MCP Token Optimization: 4 Approaches Compared](https://www.stackone.com/blog/mcp-token-optimization/)
- [Async Let — Do MCP Servers Really Eat Half Your Context Window?](https://www.async-let.com/posts/claude-code-mcp-token-reporting/)
- [Connect Claude Code to tools via MCP (official docs)](https://code.claude.com/docs/en/mcp)
