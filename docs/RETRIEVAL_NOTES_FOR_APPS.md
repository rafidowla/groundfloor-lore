# Retrieval notes for app developers

Plain-English guidance for anyone building an app on top of Lore's search/recall
(REST `/api/search` + `/api/recall`, or the MCP `search` + `recall` tools). This
covers the deliberate behaviors that surprise people. For the internal design see
`RETRIEVAL_UNIFICATION.md`; this file is for *callers*.

## TL;DR

- All surfaces (REST, MCP, embedded, CLI) now run the **same** retrieval core, so
  the same query returns the same results everywhere.
- Lore searches **literally**. It does **not** fix typos, drop filler words, or
  invent alternate spellings. Cleaning up the user's question is **your app's
  job**, not the database's.
- Right after you save with embedding on, **semantic** search may lag a moment;
  **keyword** search is immediate.

---

## Lore searches literally — query cleanup is the app's job

Think of Lore as a very fast, very *literal* librarian. Ask for **"shafin"** and
it finds "shafin." Ask for **"safin"** (a typo) and it won't guess you meant
"shafin." There is no spell-correction, no stop-word removal, no alternate-spelling
generation, and no date-word normalization in the core. This is intentional — it's
written in the code (`recall/retrieve.ts`, decision **D3**: *"queries are searched
RAW — no typo/normalization/expansion in core"*).

**Why:** Lore is a shared database engine used by many apps. If we baked one app's
idea of "smart" into the engine, every other app would inherit those assumptions
whether they wanted them or not, and it would be hard to change later. So the
engine stays predictable, and the "make the messy question smart" step lives in
each app.

**What to do in your app:**
- Do typo-tolerance / query cleanup **before** calling Lore, or call Lore a few
  times with spelling variants and merge the results.
- Lore's **semantic** (meaning-based) search will *sometimes* catch a near-miss
  spelling — treat that as a lucky bonus, **not** a guarantee, especially for very
  short queries like a single name.

## Semantic search is probabilistic; keyword is exact

- `search_mode=keyword` → exact substring match on label/content/tags. Reliable
  and immediate, but literal.
- `search_mode=semantic` → vector similarity. Great for "find things *about* X,"
  but for short/typo'd queries it may or may not rank a given node high enough to
  appear. There is no fixed confidence threshold.
- `search_mode=hybrid` (default) → both, fused via reciprocal-rank-fusion. Best
  general default.

## Right after a write, semantic recall can lag (P14)

When you save a node with embedding enabled, Lore stores the **text immediately**
(keyword search finds it at once) but computes the **embedding** (the part that
powers semantic search) in the **background**, a moment later. So in the seconds
right after a save, a semantic search might not return the brand-new node yet.

Every recall response includes a freshness signal in `_meta`:
- `vector_index_consulted: false` → semantic was **not** consulted (e.g. the index
  was empty / not-yet-embedded content, or a non-active workspace). Keyword still
  ran.

**What to do:** don't save an item and assume semantic search finds it in the same
instant. Use keyword search for read-your-write certainty, re-check after a moment,
or branch on `vector_index_consulted`.

## "Results may be incomplete" — `scan_cap_hit` (P16)

The keyword candidate scan is bounded (`LORE_SEARCH_SCAN_CAP`, default 2000) to
protect daemon memory. If a single query matches **more** nodes than the cap in one
workspace, the oldest matches beyond the cap are dropped before ranking. When that
happens, responses now carry **`scan_cap_hit: true`** (top-level on `/api/search`,
in `_meta` on `/api/recall` and the MCP tools). The field is **absent** in the
normal case.

**What to do:** if you see `scan_cap_hit`, narrow the query (it's likely too broad)
or ask an operator to raise `LORE_SEARCH_SCAN_CAP`.

## Quick reference — REST params

Both `/api/search` and `/api/recall` accept:

| Param | Meaning |
| --- | --- |
| `workspace` | **required** — the workspace to search (`*` = cross-workspace, needs a cross-workspace-read token) |
| `search_mode` | `semantic` \| `keyword` \| `hybrid` (default `hybrid`); invalid value → HTTP 400 |
| `tags` | comma-separated; keep only nodes carrying **all** listed tags |

`/api/search` uses `q=` for the query; `/api/recall` uses `topic=` and `max=`.
