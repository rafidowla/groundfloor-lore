# D9 — Shared local model server (Lore 3.24)

Status: **DRAFT — design for owner review, 2026-09-25.** Nothing built yet.

Owner decisions (Rafi, 2026-09-25) — not up for re-litigation in this doc:

| # | Decision |
|---|----------|
| O1 | Embedding model files live in the shared `<LORE_HOME>/models` cache; Lore checks there (and the legacy per-install cache) before downloading. |
| O2 | Re-rank becomes **per-host opt-in**. A model present on disk no longer turns re-rank on for every host sharing the home. |
| O3 | One shared background process serves **both** embedding and re-rank to every local Lore host on the machine. |
| O4 | Lifecycle: spawned **on demand** by the first host that needs a model, **exits by itself** when no host is connected. No launchd / login item / always-on service. |
| O5 | On failure the host **restarts the shared process first**; only if that fails does it load models in-process, and it reports that **loudly**. It keeps trying to get back to shared. |
| O6 | Shared process is **ON by default** for local hosts, with an off switch. |
| O7 | O1 + O2 + O3 ship together in **3.24**. |

Supersedes: the 2026-05-16 "no local embedding sidecar" decision (install-UX
reason). The server ships inside `@groundfloor/lore` — no extra install — so
that reason still holds. Atlas: `knowledge:decision:1790364466570-406441`.

The server holds **models only, never memories**. It is not a "shared local
Lore daemon" and must never grow storage, recall, or an MCP surface.

---

## 1. Why

On one machine today (Atlas, PM Helper, MIRA, Tapestry):

- **Disk:** each host keeps its own ~129 MB e5-small copy in
  `node_modules/@huggingface/transformers/.cache` (verified: 3 copies today).
  Reinstalls can wipe it. The download is unpinned and unverified.
- **RAM:** each host process loads its own embedding pipeline and, when
  re-rank applies, its own ~600 MB cross-encoder. 4 hosts ≈ 4× both.
- **Coupling:** the re-rank model is already shared on disk, and D8's
  default-ON means a fetch by one host silently switches re-rank on for all
  (PM Helper had to pin `recallRerank:false` in 3.23).

## 2. Scope

In 3.24:

- **Part A (O1)** — shared, pinned, verified embedding cache.
- **Part B (O2)** — re-rank default OFF; host/workspace/query/env opt-in.
- **Part C (O3–O6)** — `lore-models` server process + client, fallback,
  status reporting.

Out of scope for 3.24: non-CPU devices through the server (they stay
in-process, see §5.6), the embedded LLM (`llmDispatch`), the cloud/daemon
deployment modes (server only for local hosts), Windows named pipes beyond
"doesn't break" (§5.2).

---

## 3. Part A — shared embedding cache (O1)

Today `getOrCreateEntry` (`providers/localEmbeddingProvider.ts:255-272`)
calls `pipeline('feature-extraction', modelId, { device, dtype })` with no
`cache_dir`, so the model lands in the transformers default cache — **unless**
`llmDispatch.ts:460` already mutated the process-global `env.cacheDir`, in
which case it lands in `<LORE_HOME>/models`. Cache location currently depends
on call order.

Change:

1. `pipeline()` gets an explicit `cache_dir: loreHomePath('models')`.
   Embedding never relies on global `env` again.
2. **Resolve-before-download**, in order:
   1. `<LORE_HOME>/models/<modelId>` with a valid `.complete` marker → use it.
   2. Legacy cache (`node_modules/@huggingface/transformers/.cache/<modelId>`,
      resolved from the installed transformers package) → **copy** into the
      shared cache via staging dir, verify, write `.complete`. No download.
   3. Download into `<LORE_HOME>/models/.staging-<hex>`, verify, rename,
      write `.complete` (same mechanics as `fetch-rerank`,
      `cli/commands/modelsFetch.ts:156-300`).
   4. Offline and none of the above → today's error.
3. **Pin + verify the default model** (`Xenova/multilingual-e5-small`, q8):
   add `DEFAULT_EMBED_REVISION` + `DEFAULT_EMBED_MANIFEST` (sha256 of the
   files actually loaded) beside `rerankManifest.ts`. Non-default models:
   unpinned, unverified, as today, but still in the shared cache.
4. Concurrency: two hosts first-running at once → O_EXCL lock
   `<LORE_HOME>/models/.lock-<modelId-hash>` (async poll, not
   `Atomics.wait`); loser waits for `.complete`.
5. New CLI `lore models fetch-embedding` (same flags as `fetch-rerank`) for
   offline prep; `lore models prune` must always keep the configured
   embedding model (today it would delete e5-small, `models.ts:83-89`).
6. `DEFAULT_LOCAL_MODEL_DTYPE` env read is validated (currently unchecked
   at import, `localEmbeddingProvider.ts:67`).

Output is unchanged: same files, same `modelId@dtype` fingerprint.

## 4. Part B — re-rank opt-in (O2)

- `recall/rerankConfig.ts:238`: default becomes **OFF**
  (`enabled = false`). Precedence chain otherwise unchanged
  (query → workspace → `createLore({ recallRerank })` → `LORE_RECALL_RERANK`
  → default).
- With re-rank OFF by default, `_meta.rerank` is absent by default again —
  3.22 byte-identical output, which also makes PM Helper's pin redundant
  (harmless; leave it).
- Fixes the CLI mismatch where `lore workspaces get-rerank` printed
  `enabled:false` while the runtime default was ON.
- Hosts that want it: `createLore({ recallRerank: true })` (Atlas, after its
  eval) or per workspace `lore workspaces set-rerank <ws> on`.
- **Supersedes the D8d "default ON" decision.** MIGRATION-3.24 and the Atlas
  handoff must say so: Atlas must opt in explicitly.

Known limitation kept: `setHostRerankDefault` is process-global
(`rerankConfig.ts:133-137`); two Lore instances in one process share it.

---

## 5. Part C — the shared model server (O3–O6)

### 5.1 Shape

```
host A (Atlas) ─┐                       ┌──────────────────────────────┐
host B (PMH)  ──┼── unix socket ───────▶│ lore-models (one per key)     │
host C (MIRA) ─┘   <run>/server.sock    │  LocalEmbeddingProvider(s)    │
                                         │  LocalRerankProvider(s)       │
                                         │  per-client fair queue        │
                                         └──────────────────────────────┘
```

- **Server = existing code, relocated.** The server process hosts the *same*
  `LocalEmbeddingProvider` / `LocalRerankProvider` classes, including
  chunking (`splitIntoWindows`, 448/64 windows), e5 prefixes, mean pooling,
  batch-32 rerank with `RERANK_SESSION_OPTIONS`. The client is a thin RPC
  proxy method-for-method. This is what makes output identical — we never
  re-implement inference or tokenisation on the client side.
- **Invariant: never merge requests into one forward pass.** Rerank order is
  batch-composition sensitive (`localRerankProvider.ts:365-380`); each
  request is computed exactly as it would be in-process.
- **Keyed server.** `key = hash(LORE_HOME realpath, protocol major,
  transformers version, onnxruntime-node version)`. Hosts with identical
  runtimes share one server; a host vendoring a different transformers/ORT
  gets its own server rather than subtly different vectors. Different
  `LORE_HOME` → different server (models are per home anyway).
  `LORE_HOME` here is the machine-level home (env `LORE_HOME`, else
  `~/.groundfloor`) — the same root as the `models/` cache. An embedder's
  `createLore({ dataDir })` does NOT change the key: Atlas's one-instance-
  per-project and MIRA's own `dataDir` all share one server.

### 5.2 Transport and security

- **Unix domain socket** at `<run>/server.sock`, where
  `<run>` = `<LORE_HOME>/run/model-server-<key>/` (resolved from the realpath
  of `LORE_HOME`), created 0700. No TCP port: no port collisions, no browser/DNS-rebinding
  exposure, filesystem permissions = same-user boundary.
- macOS `sun_path` limit is 104 bytes. If the path is too long (deep custom
  `LORE_HOME`), fall back to `os.tmpdir()/lore-<uid>/<key>.sock` in a
  0700 dir. Both the run dir and the socket's dir must be a real directory
  (not a symlink) owned by the current uid with no group/other bits;
  otherwise the server refuses to start and the client falls back loudly
  (never chmod-repaired). Windows (named pipe) is not a 3.24 test target.
- **Defence in depth:** 32-byte token at `<run>/server.token` (0600,
  `authToken.ts` pattern); first frame must be `hello` with it
  (constant-time compare) or the connection is dropped.
- **Limits:** max frame 64 MB, max texts per request 1024, max chars per text
  = `LORE_MODEL_SERVER_TEXT_CHAR_LIMIT` (default 200000), max passages per
  rerank 64, max concurrent clients 64. Oversize → typed error, connection
  kept (the host then embeds that text in-process, see §5.5).
  Unauthenticated sockets get a 5 s `hello` deadline, a 64 KiB frame cap and
  a process-wide cap on pending connections; a malformed frame from an
  authenticated client gets a `bad_request` error, never a crash.
- Model ids validated with `resolveModelDirSafe` (no traversal). Server never
  downloads re-rank models (offline, as today); embedding download follows
  Part A rules.
- **Spawned with a minimal env**, not the host's: `PATH`, `HOME`,
  `LORE_HOME`, `TMPDIR`, and the allow-listed `LORE_EMBED_*`,
  `LORE_LOCAL_EMBEDDING_*`, `LORE_RECALL_RERANK_*`, `LORE_MODEL_SERVER_*`,
  `LORE_LOG_LEVEL`. Host secrets never reach it.
- **No payload logging.** Server logs carry ids, sizes, timings, errors —
  never query/passage/document text (PM Helper holds client email).

### 5.3 Protocol (v1)

Length-prefixed frames: `u32 length | JSON header | optional binary body`.
Vectors travel as a binary `Float32Array` body (exact, compact), not JSON.

| Request | Reply |
|---|---|
| `hello {v, token, client:{pid, loreVersion, name?}}` | `helloOk {serverPid, serverVersion, key, startedAt}` / `helloErr` |
| `embed {id, op:'query'\|'document'\|'documentBatch'\|'splitIntoWindows', model:{id,dtype,device}, texts[], windowTokens?, overlapTokens?}` | `result {id, dims, count}` + f32 body / windows JSON |
| `rerank {id, model:{id,dtype}, query, passages[]}` | `result {id, scores[]}` |
| `cancel {id}` | — (server aborts between batches, as `score()` does today) |
| `status` | `{pid, uptimeMs, clients, queueDepth, protocolVersion, idleMs, rssBytes, models:[{kind,id,dtype,lastUsedAt}]}` — `models` lists what this server has served since start (ids only); load/unload state stays internal to the providers' own idle-unload |
| `shutdown {token}` | server drains and exits (CLI `lore models server stop`) |

Errors are typed: `busy`, `timeout`, `model_absent`, `integrity_failed`,
`invalid_model`, `too_large`, `internal`. Rerank errors map 1:1 onto the
existing fail-open reasons in `rerankStage.ts`, so `_meta.rerank` semantics
don't change.

Request/response correlation, per-call deadline (`min(instance, caller)`),
`cancel`, and error revival follow `verbatimSearchWorkerProxy.ts:520-598`.

### 5.4 Server lifecycle (O4)

- **Spawn-or-connect** (client, on first model call — a host that never
  embeds never spawns anything):
  1. connect to socket → `hello`. Success → done.
  2. ENOENT / ECONNREFUSED → take `<run>/server.lock` (O_EXCL, async
     poll), **re-try connect** (someone may have won), spawn
     `process.execPath <lore dist>/modelServer/main.js` (`main.ts` under
     tsx) with `detached:true`, `stdio:'ignore'`, an allowlisted env and
     `unref()`; the server writes its own size-capped, rotated
     `<LORE_HOME>/logs/model-server.log`. Wait for the socket
     (`LORE_MODEL_SERVER_READY_MS`, default 10 s — models load lazily, so
     ready is fast).
  3. The lock always names one pid: the spawning host's until the server
     claims it, then the server's own for its whole lifetime. A lock naming
     a live pid is never stolen, whatever its age; only a dead pid makes it
     stale (a 15 s age rule applies only to an empty/unreadable lock).
     Read-modify-write of the lock runs under a short O_EXCL guard file
     (`spawnLock.ts`).
- Server start: if the socket answers, or the lock names another live pid,
  exit 0 (lost the race). Otherwise unlink the dead socket, write the token,
  listen, and write `<run>/server.pid`. Liveness for clients is "does the
  socket answer"; the pid is used for lock staleness and to stop a wedged
  server. On exit a server removes the socket/pid/token/lock only if they
  still name its own pid.
- **Idle exit:** no connected clients for `LORE_MODEL_SERVER_IDLE_EXIT_MS`
  (default 60 s) and nothing in flight → remove its own files, exit 0. Also
  exits if nobody connects within 30 s of start.
- Hosts hold one persistent connection per Lore instance while alive, so the
  server lives exactly as long as some host is running. Inside the server,
  models still idle-unload (re-rank 5 min as today; embedding keeps
  `LORE_EMBED_IDLE_UNLOAD_MS`, default never) — the server itself stays
  small when idle.
- **Host event loop:** the client socket is `unref()`'d whenever nothing is
  pending, so an embedded host that forgets `dispose()` still exits (see the
  "test prints done but never exits" lesson). `dispose()` closes it.
- The server is never tied to a parent PID; it outlives any one host and
  dies only by idle-exit, `shutdown`, or crash.

### 5.5 Failure handling (O5) — restart first, fall back loudly

Embedding and re-rank are **pure functions**, so unlike the search worker
(which never retries non-idempotent writes) a failed model call **is safely
retried**.

On connection loss, connect failure, or call timeout:

1. **Restart:** up to `LORE_MODEL_SERVER_RESTARTS` (default 3) spawn-or-connect
   attempts with backoff 0.5 s / 1 s / 2 s (~4 s total, bounded by
   `LORE_MODEL_SERVER_RESTART_BUDGET_MS`, default 10 s). The in-flight call is
   retried once on the new server.
2. **Fallback:** if restart fails, the client switches to in-process
   `LocalEmbeddingProvider` / `LocalRerankProvider` (today's code path, same
   output) and the call completes. Status → `fallback`.
3. **Recover:** background probe (unref'd timer) every 60 s, doubling to a
   10 min cap after repeated failures; on success, switch back to shared,
   release the in-process models, status → `shared`.
4. **Crash-loop guard:** a server that dies > 3 times in 10 min for this
   client pins the client in fallback until the next probe window.

Re-rank keeps its own per-call timeout (`LORE_RECALL_RERANK_TIMEOUT_MS`,
default 3 s): a slow server during a recall fails open for that call exactly
as today (`reason:'timeout'`) and counts toward the restart trigger only on
connection-level failure, not on one slow call.

**"Loudly"** — every surface below fires on each *transition*
(`shared → fallback`, `fallback → shared`), not per call:

1. `log.error` once: reason, and "this app now holds its own copy of the
   models (~N MB extra)". Recovery logs at `warn`.
2. **`_meta.models`** on recall results while degraded:
   `{ served_by: 'in_process_fallback', reason, since }`. **Absent** when
   shared-and-healthy or when the server is switched off — keeps default
   output unchanged, per the `_meta` convention.
3. **`lore.modelStatus()`** on `LoreInstance`:
   `{ mode: 'shared'|'fallback'|'in_process', reason?, since, server?:{pid, key, socket} }`.
   `in_process` = server switched off / not applicable (not an error).
4. **`createLore({ onModelStatus(status) })`** callback, fired on
   transitions. Lore has no event emitter; a callback option is the smallest
   surface. Exceptions thrown by the callback are caught and logged.
5. CLI: `lore models server status` / `lore models server stop`.

Hosts (PM Helper, MIRA) will surface (2)/(4) in their own UI — agreed
follow-up after 3.24, not part of Lore.

### 5.6 When the server is used (O6)

ON by default when **all** hold:

- deployment mode is local (`embedded`, or the local daemon) — not cloud;
- the embedding provider is Lore's local one (not host-injected via
  `createLore({ embeddingProvider })`, not `openai_compat`, not `none`);
- device is `cpu` (non-CPU devices stay in-process in 3.24; logged at `info`,
  status `in_process`, not a fallback);
- not a test process (`isTestProcess()`), unless `LORE_MODEL_SERVER=1`.

Off switches: `createLore({ modelServer: false })`, `LORE_MODEL_SERVER=0`.
Re-rank inherits the same transport; whether re-rank *runs* is still Part B.

### 5.7 Behaviour that moves or changes

| Today (per host process) | 3.24 with server |
|---|---|
| Rerank concurrency cap `LORE_RECALL_RERANK_MAX_CONCURRENT`=2, immediate `busy` | Enforced **in the server, machine-wide**. Same `busy` fail-open. Default stays 2 (CPU is the real limit); measured under 4 hosts before release. |
| Embedding: no concurrency cap | Server queue, **per-client round-robin**, query embeds ahead of document batches — one host's bulk ingest can't starve another host's search. |
| `awaitEmbedMemoryHeadroom` checks host RSS | Client-side gate becomes a no-op in shared mode; server applies it to its own RSS. |
| `inferMaxBatchSize` keys on class name (`batchedEmbedder.ts:215-223`) | Replaced by an explicit `maxBatchSize` provider property; the client reports the local cap. |
| `model_absent` = client filesystem check | Unchanged — client and server share `LORE_HOME`, check stays local and cheap. |
| Rerank provider built inline in `rerankStage.ts:324`; only a test seam | New internal `RerankBackend` seam (`local` \| `shared`) chosen per instance. |
| Search worker (`LORE_SEARCH_WORKER=1`) forks load their own model when no parent embedder | Worker uses the shared client too — removes the ~600 MiB per-fork copy. |
| ORT thread pool: default, per process | Unchanged in the server (changing thread counts can change float reduction order → parity risk). Oversubscription measured, not tuned, in 3.24. |

### 5.8 Code layout

New modules only — `mcp/server.ts` and `mcp/services.ts` are at the 800-line
cap.

- `modelServer/protocol.ts` — frames, message types, error kinds, `v`.
- `modelServer/entry.ts` — server process: listen, hello/auth, queue,
  providers, idle exit, status, shutdown.
- `modelServer/client.ts` — connection, correlation, deadlines, spawn-or-connect,
  lock, restart/fallback/recover state machine, status + callback.
- `modelServer/sharedEmbeddingProvider.ts` — `EmbeddingProvider` over the
  client, identical `modelId`/`dtype`/`dimension`/fingerprint.
- `modelServer/paths.ts` — key, socket/token/pid/lock/log paths, `sun_path`
  fallback.
- `recall/rerankBackend.ts` — seam used by `rerankStage.ts`.
- `providers/embedManifest.ts`, Part A resolver in `providers/modelCache.ts`.
- `envScrub.ts` allowlist + `docs/CONFIGURATION.md` for every new `LORE_*`
  var (completeness test enforces it).

### 5.9 New configuration

| Var / option | Default | Meaning |
|---|---|---|
| `createLore({ modelServer })` / `LORE_MODEL_SERVER` | on (local) | Use the shared server. |
| `createLore({ onModelStatus })` | — | Transition callback. |
| `LORE_MODEL_SERVER_IDLE_EXIT_MS` | 60000 | Server exit after last client leaves. |
| `LORE_MODEL_SERVER_READY_MS` | 10000 | Wait for a freshly spawned server. |
| `LORE_MODEL_SERVER_RESTARTS` | 3 | Restart attempts before fallback. |
| `LORE_MODEL_SERVER_RESTART_BUDGET_MS` | 10000 | Cap on the restart phase. |
| `LORE_MODEL_SERVER_PROBE_MS` | 60000 | First recovery probe interval (doubles to 10 min). |
| `LORE_MODEL_SERVER_CALL_MS` | 120000 | Per embed call deadline (re-rank uses its own). |

Server-side only (read by the `modelServer/main.js` process itself, not by
clients — added during C2b's config-name alignment; not part of the original
table above):

| Var | Default | Meaning |
|---|---|---|
| `LORE_MODEL_SERVER_BOOTSTRAP_TIMEOUT_MS` | 30000 | Exit if no client ever connects within this many ms of `listen()`. `0` disables. |
| `LORE_MODEL_SERVER_MAX_CLIENTS` | 64 | Max simultaneous client connections; a connect over this is refused. |
| `LORE_MODEL_SERVER_TEXT_CHAR_LIMIT` | 200000 | Per-text char cap on any single `embed`/`rerank` string; over this is a `too_large` error, connection stays open. |
| `LORE_MODEL_SERVER_LOG_MAX_BYTES` | 10000000 | Rotate `model-server.log` once it reaches this many bytes. |
| `LORE_MODEL_SERVER_LOG_MAX_FILES` | 3 | Retained rotated log files before the oldest is dropped. |
| `LORE_MODEL_SERVER_QUEUE_MAX_PER_CLIENT` | 256 | Max queued (not-yet-dispatched) `embed` requests per connected client before a new request gets `busy`. |

---

## 6. Release gates (all must pass before the 3.24 PR is proposed for merge)

**Parity (the non-negotiable one):**
- Embeddings via server vs in-process: **bit-identical Float32** for query,
  document (short + multi-window long), `documentBatch`, `splitIntoWindows`
  on a fixed corpus incl. non-English.
- Re-rank scores bit-identical; order identical.
- Recall top-10 identical on the recall-eval fixture with the server on/off,
  re-rank on/off.

**Lifecycle:**
- 4 hosts starting simultaneously → exactly one server.
- Idle exit after last host disposes; no server when no host ever embeds.
- Stale socket / stale lock / dead pid recovery.
- `kill -9` server mid-embed → call retried and succeeds on a respawned server.
- Unspawnable server (bad entry) → fallback, `log.error` once, `_meta.models`
  present, callback fired, `modelStatus()=fallback`; fix → recovery fires.
- Host that never calls `dispose()` exits (no ref'd handles).
- Test processes don't spawn a server unless opted in.

**Security:** wrong token rejected; `run/` 0700, token 0600; oversize frames
rejected; server env contains no non-allow-listed host vars; no payload text
in server log.

**Measured (reported, not gated):** summed RSS for 4 host processes,
shared vs in-process; recall p50/p90 with and without server; rerank `busy`
rate with 4 concurrent hosts; first-call latency incl. spawn.

**Regression:** full `npm test`, `test:arch`, tsc, `npm audit --omit=dev` = 0.

## 7. Migration (3.23 → 3.24)

- Default re-rank flips to OFF → hosts that want it opt in
  (`recallRerank:true`). Atlas handoff updated accordingly.
- First run copies e5-small from the legacy cache into `<LORE_HOME>/models`
  (no download); legacy copy is left in place (removed with node_modules).
- A `lore-models` process appears while any local host runs; it is not a
  Lore daemon and holds no data. Off switch documented.
- Hosts may start reading `_meta.models` / `onModelStatus` to show warnings.

## 8. Build plan

Bounded slices (each hands back ≲200k context), Sonnet builders, Opus review:

1. **A** — shared embedding cache, manifest/pin, legacy copy, fetch/prune CLI.
2. **B** — re-rank default OFF, `RerankBackend` seam, `maxBatchSize` property.
3. **C1** — protocol + server entry (+ its unit tests).
4. **C2** — client, spawn-or-connect, restart/fallback/recover, status,
   `createLore` wiring, env allowlist, docs. (After C1.)
5. **C3** — parity, lifecycle, security suites; measurements; MIGRATION-3.24.

A, B, C1 in parallel; C2 after C1; C3 last. One integration branch, PR with
measurements, no merge without owner yes.

## 9. Risks

- **Parity drift** if anything on the server path differs (session options,
  batch composition, tokenizer instance). Mitigated by relocating, not
  re-implementing, and the bit-identical gate.
- **Single point of slowness:** one busy server can add queueing latency for
  all hosts. Mitigated by round-robin + query priority; measured.
- **Orphans:** a wedged-but-alive server (socket answers, inference hangs)
  isn't caught by idle-exit. Mitigated by per-call deadlines → restart path
  sends `shutdown`, then the client spawns fresh under the lock.
- **Global-rule confusion:** agents told "never run a local Lore daemon" may
  kill or avoid `lore-models`. Needs a one-line carve-out in the global
  instructions (owner's call).
