# Migrating to Lore 3.23.0

For embedded hosts (Atlas, MIRA, PM Helper, nirman-tapestry) upgrading from
3.22.x. Covers D7 (piece-level vectors) and D8 (local cross-encoder re-rank),
PR #146. See also: [`CHANGELOG.md`](../CHANGELOG.md) 3.23.0 entry (incl. the
*Measurements* section) and [`docs/CONFIGURATION.md`](CONFIGURATION.md) —
`LORE_RECALL_RERANK*` and `LORE_RECALL_PIECE_VECTORS` sections.

## 1. What changes by default

### D8 — re-rank is ON by default, but inert until the model is fetched

With no opinion anywhere in the precedence chain, `retrieve()` (and so
`lore.recall()`, MCP `recall`, `GET /api/recall`, cross-workspace recall)
attempts to re-rank the top `k=10` results with
`Xenova/ms-marco-MiniLM-L-6-v2` (q8), margin gate `1.0`.

Lore **never downloads the model at query time**. Until it is fetched, every
call fails open: original order, `_meta.rerank = {applied:false,
reason:'model_absent', model}`. So upgrading changes nothing about ordering
on its own — only the new `_meta.rerank` field appears.

To turn it on for real, fetch the model once per machine:

```bash
LORE_HOME=<the host's LORE_HOME, if it sets one> npx lore models fetch-rerank
```

- **Model location follows `LORE_HOME`, not `createLore({ dataDir })`.** The
  re-rank cache is `<LORE_HOME>/models/<modelId>/` (default
  `~/.groundfloor/models/`). A host that only passes `dataDir` must fetch
  into the process-level home (unset `LORE_HOME` → `~/.groundfloor`).
- The fetch is pinned to an exact upstream revision and all 4 files are
  sha256-verified before the `.complete` marker is written (~23 MB on disk).
- Once applied, results carry `rerank_score` and `_meta.rerank` carries
  `{applied, model, gateHeld, ...}`.

**Cost when active** (M5 Max, 10k-row fixture): K=10 p50/p90 260/304 ms per
query; first load ~450 ms; **+~600 MB RSS** while loaded. The model is
released after 5 minutes idle (`LORE_RECALL_RERANK_IDLE_UNLOAD_MS`, default
`300000`; `<= 0` means the default, not "never").

**Off switches** — each gives output byte-identical to 3.22 (no
`_meta.rerank`, no `rerank_score`):
- per query: `rerank:false` (`RecallOpts.rerank`, MCP `rerank`, REST `?rerank=0`)
- per workspace: `lore workspaces set-rerank <name> off` (authoritative —
  overrides a per-query `rerank:true`)
- per host: `createLore({ recallRerank: false })`
- process-wide: `LORE_RECALL_RERANK=0`

New env vars are already on the daemon's env allowlist:
`LORE_RECALL_RERANK_MAX_CONCURRENT` (default 2; over the cap a call returns
original order with `reason:'busy'`) and `LORE_RECALL_RERANK_MAX_CACHED_MODELS`
(default 3).

## 2. What is opt-in

### D7 — piece-level vectors (off by default)

Precedence: per-workspace `setWorkspacePieceVectors()` (no CLI yet) >
`createLore({ pieceVectors })` > `LORE_RECALL_PIECE_VECTORS` > off. Existing
content needs a one-time `lore migrate piece-vectors` backfill; a layout
mismatch reports `stale` and falls back to canonical vectors.

**Do not enable D7 on code-heavy workspaces yet.** Measured on the recall-eval
fixture (both engines): identifier queries rank1 85% → 45%, found@10
95% → 85% — short labels win through the title row under MAX-over-pieces.
On the SQLite engine piece search is ~3× the off p90 (137 vs 47 ms); Lance is
at parity. Storage +61% (Lance) / +77% (SQLite) at 2 pieces/node — long-form
workspaces grow more.

A SQLite → Lance promotion (250k rows) no longer rebuilds pieces inline; it
logs a warning and the piece status becomes `not_built` until
`lore migrate piece-vectors` is re-run.

## 3. Checklist

1. Bump the vendored tarball to `groundfloor-lore-3.23.0.tgz` (copy into
   `vendor/`, update the `@groundfloor/lore` line, `npm install`, commit).
2. Keep the 3.22 host `overrides` (`sharp`, `uuid`) and Node `>=22.13 <23`.
3. Decide on re-rank: accept the default and run `lore models fetch-rerank`
   (check the host has ~600 MB headroom), or set one of the off switches.
4. Code that snapshots whole recall responses: expect the new `_meta.rerank`
   field on the default path.
5. Re-run your own recall eval with re-rank applied. For Atlas this is the
   198-case acceptance gate: top-10 ≥ 99%, top-3 ≥ 97.5%, first ≥ 88%,
   re-rank p50 ≤ 400 ms.

## 4. Known limits

- Cross-workspace recall (`workspace:'*'`) has no single workspace to
  consult, so a workspace's `set-rerank off` does not apply there.
- Re-rank runs in the main process even with worker isolation enabled.
- Under the concurrency cap, which calls get `busy` (original order) is
  timing-dependent.
- `buildPieceIndex` is not exported for hosts, and there is no
  `set-piece-vectors` CLI or `--workspace` flag on the piece migration yet.
