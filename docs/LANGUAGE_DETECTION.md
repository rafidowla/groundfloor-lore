# Language Detection

> Last updated: 2026-04-19
>
> Design & scope for multilingual support in Lore. Explicit-only
> model — franc is exposed as a capability; core never invokes it
> implicitly.

## Principle

**Explicit over implicit. Franc is a capability, not a default.**

Core exposes `detectLanguage(text)` as a tool. Every consumer —
plugins, MCP clients, the UI, scripts — decides whether to call it.
Core itself never invokes franc automatically on stored content or
on queries. If nobody tags, the language stays `null`, which all
downstream operations treat as "English / default."

This rule exists because automatic detection on short-text or
code-shaped content (function names, identifiers, paths) is
unreliable and would silently poison the graph with mistagged
language. An explicit opt-in from each caller is safer and more
honest.

## What gets added

### 1. `language: string | null` field on `LoreNode`

- ISO 639-1 code when known (`"en"`, `"es"`, `"ja"`, …)
- `null` when unknown — not a bug, just the honest default
- Stored in the Kùzu schema, returned on reads, accepted on writes

### 2. One core utility: `detectLanguage(text, opts?)`

Location: `packages/lore/src/engines/language.ts`

- Wraps `franc` with a margin-based confidence threshold (default 0.03)
- Returns `{ language: string | null, confidence: number }` where
  `language` is an ISO 639-1 code (normalized from franc's 639-3 output)
- Confidence = `topScore - runnerUpScore`. Franc's absolute top score
  is almost always 1.0 for any plausible text, so the meaningful signal
  is how far the best candidate beats the second-best
- Below threshold (short text, mixed content, code) → `language: null`
- Pure function — no side effects, no graph access

### 3. Three exposure surfaces

All three are thin wrappers around the same core utility. One
implementation, three doorways:

| Surface | For | Why |
|---|---|---|
| `PluginGraphContext.detectLanguage(text)` | Plugin code | Primary — plugins call it from their own ingest paths |
| MCP tool `detect_language` | AI agents via MCP | External AI / Claude / Cursor / scripts through MCP |
| `POST /api/language/detect` | HTTP callers | UI, CLIs, anything not using MCP |

### 4. Optional `language` parameters on existing surfaces

Tools that store or query content gain an optional `language`
parameter the caller can pass when they already know:

| Tool | New optional param |
|---|---|
| `store_node` | `language?: string` — stored verbatim, no detection |
| `search` | `queryLanguage?: string` — used for Phase B hints |
| `recall` | `queryLanguage?: string` — same |
| `chat` (HTTP) | `queryLanguage?: string` — same |

No parameter → no language assumption → treated as English in
downstream routing.

### 5. `language` on reads

Returned as metadata:
- `/api/node?id=...` includes the field
- Search / recall responses include it per-node
- `stats` MCP tool gains a `languageBreakdown` field with per-language counts

## What does NOT get added

These were considered and rejected in the design pass (see chat
logs 2026-04-19):

- **No automatic detection on `store_node` or ingestion paths.**
  If the caller doesn't tag, the value stays `null`. Full stop.
- **No automatic detection on queries.** Same rule; caller tags
  `queryLanguage` if they care.
- **No background migration over legacy untagged nodes.** Legacy
  content stays `null`. It'll get filled as users re-touch nodes
  via re-ingest, re-reconsume, or manual edits — not by a
  silent sweep.
- **No core-owned LLM translation.** Translation is a caller
  concern. The chat pipeline already passes retrieved context
  through the user's BYOK LLM, which handles cross-language
  answers naturally. Lore doesn't need to translate; the LLM
  does it as a side effect of answering.

## Plugin contract

Plugins choose per-plugin whether language is meaningful for the
content they ingest:

| Plugin | Stance |
|---|---|
| Developer | Skips detection. Function names / file paths / identifiers aren't prose; tagging them with a language would be misleading. All developer-contributed nodes have `language: null`. |
| Personal | Calls `ctx.detectLanguage(emailBody)` at ingest time for email bodies. Email is the canonical multilingual surface. |
| Future plugins | Their call. Legal / medical documents → worth detecting. Metrics / numbers → skip. |

Core does not inspect plugin types, does not iterate plugin-owned
tables for detection, does not secretly tag plugin content. Every
plugin that wants language tagging opts in by calling the capability.

## Phase B — Cross-language search hints

When `search` / `recall` gets `queryLanguage` that's rare in the
corpus (say, user asks a Spanish question against a 99% English
graph), the response metadata includes a hint:

```json
{
  "results": [...],
  "hint": {
    "queryLanguage": "es",
    "corpusLanguageBreakdown": { "en": 142, "es": 3, "null": 1 },
    "suggestion": "Few Spanish nodes matched. Your chat LLM can translate Spanish results to English automatically. For searching to work better, consider tagging Spanish content at ingest."
  }
}
```

No automatic translation. The hint lets the caller (UI, chat
pipeline, or an AI agent) decide what to do. Typically the BYOK
LLM in the chat pipeline will handle the translation during
answer generation — no special Lore logic needed.

## Phase C — UI surface

- **Node detail drawer** shows a language badge (`EN`, `ES`,
  `JA`, …) when the node has `language` set. Nothing when `null`.
- **Settings panel** displays the corpus language breakdown
  returned by `stats` (useful for users to spot untagged legacy
  content or verify plugin tagging is working).
- **Chat / search results** surface the Phase B hint when
  present.
- **No Settings toggle for "use LLM for translation"** — not
  needed, because the chat LLM handles it naturally without
  Lore's involvement. The toggle would be UI for a knob we don't
  turn.

## Library choice

`franc` (MIT, ~80 KB, 187 languages, one transitive dep
`trigram-utils`). Zero CVEs at install time (2026-04-19).

No alternative considered seriously — franc is the obvious
minimal-dependency choice for this scope.

## Testing

Extended e2e smoke covers:
- `detect_language` returns a language above threshold for English / Spanish
- `detect_language` returns `null` below threshold (short / code text)
- `store_node` round-trips `language` tag
- `store_node` without `language` → returns `null`
- `stats` includes `languageBreakdown`
- `search` with `queryLanguage` + rare-in-corpus → response includes hint
- HTTP `/api/language/detect` mirrors MCP tool behavior

## Out of scope

- Per-language embedding tables with a router
- Localized UI strings
- Language-aware tokenization / stemming
- Automatic translation in core (LLM handles it where needed)
