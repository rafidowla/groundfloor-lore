# Migrating to Lore 3.24.x

For embedded hosts (Atlas, MIRA, PM Helper, nirman-tapestry) upgrading from
3.23.x. Covers the 3.24 "shared local model server" work: re-rank going back
to opt-in (Part B), the shared embedding cache (Part A), and the shared
model server process (Part C). See also:
[`CHANGELOG.md`](../CHANGELOG.md) 3.24.0 entry and
[`docs/CONFIGURATION.md`](CONFIGURATION.md) — `LORE_RECALL_RERANK*` section.

## 0. 3.24.1 — piece vectors under the search worker

**Who is affected:** hosts that run the search worker
(`LORE_SEARCH_WORKER=1`, or a `createLore({ searchWorkerPolicy })` that
returns true) **and** inject their own `embeddingProvider` **and** have piece
vectors on (`createLore({ pieceVectors: true })`, `LORE_RECALL_PIECE_VECTORS`,
or a workspace override). Hosts without the worker, or without piece vectors,
are unaffected — upgrade as usual.

**What was wrong in 3.23 / 3.24.0:** under the worker, the piece index was
never written. Every write logged a `piece upsert failed … NOT REACHABLE:
parent embeds` warning and returned ok; `_meta.piece_vectors` reported
`{ status: 'stale', reason: 'unknown' }`; recall silently used canonical
vectors only. `lore migrate piece-vectors` answered `noop` / "already built"
because the sidecar still said the build was complete.

**What to do:**

1. Upgrade worker hosts to **3.24.1**. On 3.24.0 the worker cannot build
   pieces at all.
2. If the host ingested anything under 3.23 / 3.24.0 with the worker and
   piece vectors on, run this once:
   1. Stop the host.
   2. Run `lore migrate piece-vectors` with the host's `LORE_HOME` and
      embedding settings. It should report `Action: built`.
   3. Restart the host.
3. Check `_meta.piece_vectors` on a recall: it should read
   `{ status: 'active', layout: 'pieces-v1' }`.

If you skip step 2, 3.24.1 detects the short index when it opens the store,
logs one `ERROR` naming the fix, and reports `not_built` / `incomplete build`.
Recall keeps working on canonical vectors in the meantime.

**New in 3.24.1 for every host with piece vectors on:** a piece build or
delete that fails (for example, an embedding endpoint error) now marks the
index incomplete instead of logging a warning and carrying on. You get one
`ERROR`, `_meta.piece_vectors` reports `not_built`, and piece search stays off
until `lore migrate piece-vectors` is run. It does not recover by itself
while the host is running.

## 1. Re-rank is now opt-in (reverts the 3.23 default)

**3.23 shipped re-rank ON by default (D8d).** 3.24 Part B flips that default
back to **OFF**. With no opinion anywhere in the precedence chain,
`retrieve()` (and so `lore.recall()`, MCP `recall`, `GET /api/recall`,
cross-workspace recall) now returns output **byte-identical to 3.22** — no
`_meta.rerank`, no `rerank_score`, original order, nothing added.

**Why revert:** re-rank-by-default meant every recall call attempted a
cross-encoder pass (or a `model_absent` fail-open) with no explicit signal
from the caller that it wanted the cost or the behavior change. 3.24 makes
re-rank something a host, workspace, or individual call asks for.

### What changes for you

- **If your host never fetched the re-rank model** (`lore models
  fetch-rerank` was never run) and never set an explicit on-switch: nothing
  observable changes. You were already getting `model_absent` fail-open
  output on 3.23; you now get the same original-order output with no
  `_meta.rerank` field at all instead. Any code that was tolerantly checking
  `_meta.rerank?.applied` keeps working.
- **If your host fetched the model and relied on the 3.23 default-on
  behavior** (no explicit `rerank:true`, no `set-rerank on`, no
  `LORE_RECALL_RERANK=1`, no `createLore({ recallRerank })`): re-rank
  **stops running** after this upgrade. Pick one opt-in path to keep it:

  ```ts
  // Per host, at createLore() time — recommended for "always rerank" hosts:
  createLore({ recallRerank: { enabled: true } });
  ```

  ```bash
  # Process-wide:
  LORE_RECALL_RERANK=1
  ```

  ```bash
  # Per workspace:
  lore workspaces set-rerank <name> on
  ```

  ```ts
  // Per call:
  lore.recall(query, { workspace: 'default', rerank: true });
  ```

- **Precedence is unchanged** apart from the flipped bottom rung: per-query
  `rerank:false` > workspace `off` (authoritative) > per-query `rerank:true`
  > workspace `on` > host default (`createLore({ recallRerank })`) > env
  `LORE_RECALL_RERANK` > **default OFF** (was default ON). Note host default
  sits above the env var, not below it — a host that sets an explicit
  default wins over `LORE_RECALL_RERANK` either way.
- Already-fetched re-rank models are untouched — nothing is deleted from
  `<LORE_HOME>/models/<modelId>/`, and `lore models prune` still keeps
  whichever model is currently configured. Re-fetching is not required; only
  turning rerank back on for a given scope is.
- No new env vars were introduced by this change. `LORE_RECALL_RERANK` and
  its siblings (`_MODEL`, `_K`, `_MARGIN`, `_TIMEOUT_MS`, `_DTYPE`,
  `_IDLE_UNLOAD_MS`, `_MAX_CONCURRENT`, `_MAX_CACHED_MODELS`) are unchanged
  in shape and meaning — only the un-set default of the first one flipped.

### Internal seam (informational, no action needed for most hosts)

Re-rank scoring now goes through a `RerankBackend` seam
(`src/recall/rerankBackend.ts`) instead of `rerankStage.ts` constructing a
`LocalRerankProvider` inline. The default (and currently only) backend wraps
today's local cross-encoder exactly as before. Part C's shared backend
(routing re-rank scoring through the model server, section 3) plugs in
through the same seam; nothing to configure — it follows the model-server
switch.

### `EmbeddingProvider.maxBatchSize` (internal, no action needed)

`EmbeddingProvider` gained an optional `readonly maxBatchSize?: number`.
Built-in providers (`LocalEmbeddingProvider`, `OpenAICompatEmbeddingProvider`)
declare it at their existing effective values, so batching behavior is
unchanged. A host with a custom `EmbeddingProvider` implementation may
optionally declare this property to advertise its own batch cap; omitting it
falls back to the same conservative default `batchedEmbedder.ts` always used.

## 2. Shared embedding cache

**No action needed for most hosts.** The local embedding model now always
resolves into `<LORE_HOME>/models/<modelId>`, the same shared, verified
cache `lore models fetch-rerank` already used — instead of sometimes landing
in the `transformers` package's own default cache depending on call order.

- **First run after upgrading:** if a model is only present in the old
  `node_modules/@huggingface/transformers/.cache/<modelId>` location, it is
  copied (not re-downloaded) into `<LORE_HOME>/models` and verified. The
  legacy copy is left in place — nothing deletes it; it goes away naturally
  with `node_modules` on your next dependency reinstall.
- The default embedding model (`Xenova/multilingual-e5-small`, q8) is now
  pinned and integrity-checked the same way the re-rank model is. Output —
  the vectors themselves — is unchanged: same files, same `modelId@dtype`
  fingerprint.
- New CLI: `lore models fetch-embedding` (same flags as `fetch-rerank`) to
  warm the cache ahead of time. Purely a convenience — the same resolution
  path runs automatically on first use either way.
- `lore models prune` now always keeps whichever embedding model is
  currently configured (previously it could delete the default model the
  moment `--keep` wasn't passed).

No new env vars. See design doc [`D9-shared-model-server.md` §3](design/D9-shared-model-server.md#3-part-a--shared-embedding-cache-o1)
for the resolution-order and locking details.

## 3. Shared model server

**What it is.** Every local Lore host (Atlas, MIRA, PM Helper,
nirman-tapestry, `lore` CLI) that runs local embedding/re-rank inference on
CPU now shares one background process, `lore-models`, instead of each host
loading its own copy of the ONNX models into its own process. One process
per `(LORE_HOME, protocol version, transformers version, onnxruntime-node
version)` combination serves every host that matches — this is the same
process the global `~/.claude/CLAUDE.md` "shared Lore model process"
carve-out describes.

- It holds **no memories** — no recall, no store, no MCP surface. It only
  runs `LocalEmbeddingProvider`/`LocalRerankProvider` inference over a Unix
  domain socket at `<LORE_HOME>/run/model-server-<key>/server.sock` (0700 dir, 0600
  socket + token file, same-user boundary — no TCP port).
- **On-demand:** a host spawns it on its first embed/rerank call, not at
  startup. It exits on its own after roughly `LORE_MODEL_SERVER_IDLE_EXIT_MS`
  (default 60 s) with no connected clients and nothing in flight — don't
  expect to see it running when no local host is active, and don't treat a
  bare `ps` sighting of it as a "daemon" in the `:3847` sense; it is
  app-fronted the same way Atlas's embedded Lore is.
- Output is identical to running in-process: the server hosts the *same*
  provider classes as before, so vectors and rerank scores don't change.

**When it's used** (design doc [§5.6](design/D9-shared-model-server.md#56-when-the-server-is-used-o6)) —
on by default when all of: deployment is local (not cloud), the embedding
provider is Lore's built-in local one (not a host-injected/OpenAI-compat/`none`
provider), the device is `cpu`, and it isn't a test process (unless
`LORE_MODEL_SERVER=1`). Non-CPU devices and cloud deployments stay
in-process in 3.24 — that's not a fallback, just out of scope this release.

**Off switches**, per host:

```ts
createLore({ modelServer: false });
```

```bash
LORE_MODEL_SERVER=0
```

**If it can't be reached or dies**, a host does not lose embedding/re-rank —
it restarts the server (bounded retries), then falls back to running the
same models in its own process, and later recovers back to shared
automatically. Every transition is loud, never silent:

- `log.error` once per transition (`shared → fallback`), `warn` on recovery.
- `_meta.models` appears on recall results only while degraded:
  `{ served_by: 'in_process_fallback', reason, since }`. Absent when healthy
  or when the server is switched off, so default output is unaffected.
- `lore.modelStatus()` on `LoreInstance` — `{ mode: 'shared'|'fallback'|'in_process', reason?, since, server?: {pid, key, socket} }`.
- `createLore({ onModelStatus(status) })` — a callback fired on each
  transition (Lore has no event emitter, so this is the surface).

Hosts that want to show this in their own UI can watch (2)/(4); Lore itself
only logs and reports status.

**CLI:**

```
lore models server status [--json]
lore models server stop
```

`status` prints "not running" (exit 0) if no server is up for this
`LORE_HOME`; otherwise pid, socket path, protocol version, uptime, connected
clients, and queue depth. `stop` sends a graceful shutdown over the same
protocol the server already speaks — it never signals the process by PID
pattern, and never SIGKILLs. See `lore models server status --help` /
`stop --help` for the full flag list.

Re-rank remaining opt-in (Part B) is unchanged by any of the above — see
[section 1](#1-re-rank-is-now-opt-in-reverts-the-323-default) rather than
duplicating it here; the server carries re-rank calls the same way it
carries embedding calls once re-rank is turned on for a given scope.

## 4. Embedding runtime: transformers 4.3.0 / onnxruntime-node 1.30.0

3.24.0 moves `@huggingface/transformers` ^4.1.0 -> ^4.3.0, which pulls
onnxruntime-node 1.24.3 -> 1.30.0, @huggingface/tokenizers 0.2.0 (linear-time
Unigram, so long documents chunk in ~2 s instead of ~75 s at 100k chars) and
adm-zip 0.6.1 (clears the 3.23 `npm audit` high). No action needed:

- **No re-embed.** The stored embedding fingerprint is `modelId@dtype`; it does
  not change. Vectors differ only in float noise (vs 4.2.0: min cosine 0.99902,
  mean 0.9996 over 710 texts).
- **Separate model processes during a mixed rollout.** The model-server key
  includes the transformers and onnxruntime versions, so a 3.23 host and a 3.24
  host on the same `LORE_HOME` never share a `lore-models` process.
- **Recall.** Tapestry bench C6 unchanged (top-1 79.7–80.0, top-5 95.6); a few
  configurations move by ≤1.4 pt top-1. Re-run your own eval (checklist step 5).

## 5. Checklist

1. Bump the vendored tarball to `groundfloor-lore-3.24.0.tgz` (copy into
   `vendor/`, update the `@groundfloor/lore` line, `npm install`, commit).
2. Keep the 3.23 host `overrides` (`sharp`, `uuid`) and Node `>=22.13 <23`.
3. If your host relied on re-rank running without an explicit opt-in, add
   one of the on-switches from section 1 before upgrading in production.
4. Code that snapshots whole recall responses: expect `_meta.rerank` to be
   **absent** again on the default path (it was present, fail-open, under
   3.23's default-on if the model wasn't fetched).
5. Re-run your own recall eval with your chosen re-rank setting (on or off)
   to confirm nothing regressed.
