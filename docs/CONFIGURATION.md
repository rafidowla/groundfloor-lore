# Lore Configuration Reference

Complete reference for every `LORE_*` and `DATAPLANE_*` environment variable
recognized by the Lore daemon and CLI. Every entry in this document corresponds
to at least one `process.env` read in `packages/lore/src/`.

> **Security note:** All variables except POSIX/Node essentials are stripped
> from the **daemon's** inherited environment at startup by `envScrub` in
> `src/security/envScrub.ts`. Only the variables listed in the
> `ALLOWED_VARS` allowlist in that file survive into the running process.
> Variables not on the allowlist are silently dropped before any module code
> reads them.
>
> This applies to the **daemon only** — the process Lore owns, entered via
> `main()`, which calls `createLore({ ownsProcess: true })`. If you EMBED Lore
> as a library (`createLore(...)` from your own application), the scrub does
> **not** run and your process's environment is left untouched, in every
> deployment mode. Embedding hosts therefore keep full responsibility for their
> own env hygiene — and, conversely, need not defend their own config against
> Lore. See `SECURITY_MODEL.md` §9.

---

## Table of Contents

1. [Core / Daemon](#1-core--daemon)
2. [Embedding](#2-embedding)
   - [Provider selection](#21-provider-selection)
   - [OpenAI-compatible (generic)](#22-openai-compatible-generic-provider)
   - [OpenAI legacy alias](#23-openai-legacy-alias)
   - [Ollama](#24-ollama)
   - [Batched embedding tuning](#25-batched-embedding-tuning)
   - [Local / in-process (ONNX)](#26-local--in-process-onnx)
2a. [Shared Model Server](#2a-shared-model-server)
2b. [Shared Model Server — Client](#2b-shared-model-server--client)
3. [Sync / Dataplane](#3-sync--dataplane)
   - [Cloud Arcade (ArcadeDB multi-tenant)](#3a-cloud-arcade-arcadedb-multi-tenant)
4. [Maintenance (`lore maintain`)](#4-maintenance-lore-maintain)
   - [Scheduled compaction timer](#scheduled-compaction-timer)
5. [Security & Auth](#5-security--auth)
6. [Outbox & Replication](#6-outbox--replication)
7. [Bulk Load & Streaming](#7-bulk-load--streaming)
8. [Recall & Ranking](#8-recall--ranking)
9. [Database Internals](#9-database-internals)
10. [Observability](#10-observability)
11. [Ingestion & File Watching](#11-ingestion--file-watching)
12. [Tool Surface (MCP)](#12-tool-surface-mcp)
13. [LLM Dispatch](#13-llm-dispatch)
14. [Development / Eval](#14-development--eval)
15. [Embedded mode (library)](#15-embedded-mode-library)

---

## 1. Core / Daemon

### `LORE_HOME`

| | |
|---|---|
| **Default** | `~/.groundfloor` |
| **Surface** | daemon, CLI (all subcommands) |

Relocates the entire Lore data root: workspaces, audit log, auth tokens,
model cache, archive sink, and ingestion config. Consulted before any config
file can be read — it is the directory the config file lives in — so an env
var is the only cycle-free signal. Must be an absolute path.

Source: `src/config/loreHome.ts`

---

### `LORE_PORT`

| | |
|---|---|
| **Default** | `3847` |
| **Surface** | daemon (`lore serve --http`), CLI health-checks |

HTTP port the daemon listens on. Also used by CLI subcommands
(`lore compact`, `lore migrate`, etc.) when they probe the live daemon over
`http://127.0.0.1:<LORE_PORT>/api/health`.

Source: `src/mcp/server.ts`

---

### `LORE_LOG_LEVEL`

| | |
|---|---|
| **Default** | `info` (implementation-defined) |
| **Surface** | daemon |

Controls the daemon's log verbosity. Recognized by the logging layer at
startup. Valid values are implementation-specific; common choices are
`debug`, `info`, `warn`, `error`.

Source: `src/security/envScrub.ts` (allowlisted); consumed by the daemon
logging layer.

---

### `LORE_WORKSPACE`

| | |
|---|---|
| **Default** | _(none — uses the registry's active workspace)_ |
| **Surface** | daemon |

Forces a specific workspace to be active. When set, the daemon treats this
as the active workspace instead of reading `workspaces.json`. Useful in
automated / CI environments where a workspace is created out-of-band.

Source: `src/security/envScrub.ts` (allowlisted as "forces a specific active
workspace").

---

### `LORE_DEPLOYMENT_MODE`

| | |
|---|---|
| **Default** | `local` |
| **Values** | `local` \| `cloud` |
| **Surface** | daemon |

Selects the operating mode for the daemon. `local` runs against the embedded
SurrealDB + LanceDB substrates under `LORE_HOME`. `cloud` routes data access
through the Dataplane SDK. Env value takes precedence over the `deploymentMode`
key in `~/.groundfloor/config.json`. Invalid values are logged and fall back
to the config-file value (or `local`).

Source: `src/config/configManager.ts`

---

### `LORE_CACHE_DISABLED`

| | |
|---|---|
| **Default** | off (cache enabled) |
| **Values** | `1` to disable |
| **Surface** | daemon (LocalGraph, VerbatimStore) |

Operator killswitch for the in-process read cache. Set `=1` to bypass the
cache entirely. Used by the benchmark harness and useful when troubleshooting
stale reads. Takes precedence over any config-file setting.

Source: `src/engines/localGraph.ts`, `src/engines/verbatimStore.ts`

---

### `LORE_DEFAULT_GRAPH_ENGINE`

| | |
|---|---|
| **Default** | `sqlite` (3.21 step 1d) |
| **Values** | `surreal` to opt out; any other value (or unset) is `sqlite` |
| **Surface** | `lore workspaces create`, fresh-home seeding (first daemon boot with no `workspaces.json`) |

Which graph engine a brand-**new** local workspace's `graphEngine` field is
written as. Only affects workspace *creation* — an EXISTING workspace's
`graphEngine` field (including an absent one, which still means `surreal`)
is never rewritten by this variable. Set `LORE_DEFAULT_GRAPH_ENGINE=surreal`
to keep creating pre-3.21-style SurrealDB-backed workspaces on a host that
is not ready to switch (e.g. relies on a workflow the SQLite engine does not
support yet, such as `lore migrate-graph`'s upstream direction).

Source: `src/config/workspaces.ts` (`createWorkspace`, fresh-home seeding),
`src/engines/graphEngineSelector.ts` (`resolveNewWorkspaceGraphEngine`).

---

### `LORE_DEFAULT_VECTOR_ENGINE`

| | |
|---|---|
| **Default** | `sqlite` (3.21 step 2) |
| **Values** | `lance` to opt out; any other value (or unset) is `sqlite` |
| **Surface** | `lore workspaces create`, fresh-home seeding (first daemon boot with no `workspaces.json`) |

Which vector engine a brand-**new** local workspace's `vectorEngine` field is
written as. Same shape as `LORE_DEFAULT_GRAPH_ENGINE`: only affects workspace
*creation* — an EXISTING workspace's `vectorEngine` field (including an
absent one, which still means `lance`) is never rewritten by this variable.
Set `LORE_DEFAULT_VECTOR_ENGINE=lance` to keep creating pre-3.21-style
LanceDB-backed workspaces on a host that is not ready to switch. A
`sqlite`-vector workspace can still be promoted to `lance` automatically in
the background — see `LORE_VECTOR_PROMOTE_ROWS` below — independent of this
variable, which only governs what a NEW workspace starts on.
The reverse (an existing `lance` workspace → `sqlite`) is the explicit,
offline `lore migrate-vectors <workspace> --to sqlite` (3.27.1; see
`docs/MIGRATION-3.21.md`) — this variable never moves an existing workspace.
Running a workspace with the graph on `sqlite` and the vectors on `lance` (or
the reverse) is a supported, long-term configuration, not a transitional
state; each engine is migrated independently by its own command
(`lore migrate-graph`, `lore migrate-vectors`).

Source: `src/config/workspaces.ts` (`createWorkspace`, fresh-home seeding),
`src/engines/vectorEngineSelector.ts` (`resolveNewWorkspaceVectorEngine`).

---

### `LORE_ARCHIVE_DIR`

| | |
|---|---|
| **Default** | `<LORE_HOME>/archive` |
| **Surface** | daemon (`archive` engine) |

Overrides the output directory for `lore maintain` archive snapshots. Useful
for operators with external drives or network-attached storage.

Source: `src/engines/archive.ts`

---

### `LORE_BACKUP_KEEP`

| | |
|---|---|
| **Default** | `7` |
| **Surface** | CLI (`lore backup`) |

Number of most-recent backups to retain per workspace during rotation.
Equivalent to `lore backup --keep N`. Positive integer.

Source: `src/cli/commands/backup.ts`

---

### `LORE_FRESHNESS_TTL_HOURS`

| | |
|---|---|
| **Default** | `24` |
| **Surface** | daemon (freshnessEngine, `/api/freshness` route, `corpus_health` MCP tool) |

Staleness threshold in hours. Nodes whose effective recency timestamp is older
than this value are considered stale by `GET /api/freshness` and the
`corpus_health` tool. Can be overridden per-request by passing `ttl_hours` in
the route payload.

Source: `src/engines/freshnessEngine.ts`

---

### `LORE_ACCESS_FLUSH_MS`

| | |
|---|---|
| **Default** | `60000` (60 s) |
| **Surface** | daemon (accessTracker) |

Interval in milliseconds between flushes of the access-time tracker to the
graph store. The access tracker records when a node was last retrieved, which
drives recency scoring (`LORE_RECALL_RECENCY_HALF_LIFE_DAYS`) and the
`'retrieval'` cold-signal in `lore maintain`. Shorter intervals trade I/O for
fresher recency data.

Source: `src/engines/accessTracker.ts`

---

### `LORE_OCR_LANGUAGES`

| | |
|---|---|
| **Default** | `eng` |
| **Surface** | daemon (image extractor) |

Comma-separated list of Tesseract language packs to use when extracting text
from image files (`.png`, `.jpg`, etc.). Each entry must correspond to an
installed Tesseract data file. Example: `LORE_OCR_LANGUAGES=eng,fra,deu`.

Source: `src/engines/extractors/image.ts`

---

### `LORE_WHISPER_BIN`

| | |
|---|---|
| **Default** | _(unset — PATH lookup)_ |
| **Surface** | daemon (audio + video extractors) |

Explicit path to the whisper.cpp CLI used to transcribe audio/video. When set
to an existing file it is used directly; when unset, Lore falls back to a PATH
lookup for `whisper`, `whisper-cpp`, then `main`. Pin this to avoid PATH
ambiguity — in particular the generic `main` name could otherwise resolve to an
unrelated executable earlier in PATH. Example:
`LORE_WHISPER_BIN=/opt/whisper.cpp/main`.

Source: `src/engines/extractors/whisperBin.ts`

---

## 2. Embedding

### 2.1 Provider Selection

#### `LORE_EMBEDDING_PROVIDER`

| | |
|---|---|
| **Default** | auto-detected (Ollama if running, else local ONNX) |
| **Values** | `openai_compat` \| `local` \| `xenova` \| `none` |
| **Surface** | daemon (embedding pipeline) |

Explicitly selects the embedding backend. When unset, the daemon probes for
Ollama and falls back to the local ONNX provider.

- `openai_compat` — remote OpenAI-compatible API; requires
  `LORE_EMBEDDING_BASE_URL`, `LORE_EMBEDDING_MODEL`, and
  `LORE_EMBEDDING_DIMENSION`.
- `local` / `xenova` — in-process ONNX via `@huggingface/transformers`; see
  `LORE_LOCAL_EMBEDDING_MODEL`.
- `none` (also accepts `disabled` / `off`; 3.21) — disables embeddings
  entirely via `NullEmbeddingProvider`. Node writes succeed with no vector
  write attempted; recall's semantic leg degrades cleanly to the
  keyword/BM25/graph path (flagging `vector_leg_skipped` on the
  response) instead of erroring. The on-disk embedding fingerprint is
  never stamped or compared for a `none`-provider workspace. Programmatic
  equivalent: `createLore({ embeddingProvider: new NullEmbeddingProvider() })`
  (`src/providers/nullEmbeddingProvider.ts`), which also takes precedence
  over this env var when both are set.

Source: `src/providers/pickEmbeddingProvider.ts`, `src/mcp/services.ts`,
`src/mcp/embeddingProviderFactory.ts`

---

### 2.2 OpenAI-Compatible (Generic) Provider

These four variables are required when `LORE_EMBEDDING_PROVIDER=openai_compat`.

#### `LORE_EMBEDDING_BASE_URL`

| | |
|---|---|
| **Default** | _(required)_ |
| **Surface** | daemon (openAICompatEmbeddingProvider) |

Base URL of the OpenAI-compatible embeddings API endpoint. Example:
`https://api.openai.com/v1` or an OpenRouter/self-hosted address.

Source: `src/mcp/services.ts`

---

#### `LORE_EMBEDDING_MODEL`

| | |
|---|---|
| **Default** | _(required)_ |
| **Surface** | daemon |

Model identifier for the OpenAI-compatible embedding endpoint. Example:
`text-embedding-3-small`.

Source: `src/mcp/services.ts`

---

#### `LORE_EMBEDDING_DIMENSION`

| | |
|---|---|
| **Default** | _(required)_ |
| **Surface** | daemon |

Output vector dimension of the chosen embedding model. Must be a positive
integer. Example: `1536` for `text-embedding-3-small`.

Source: `src/mcp/services.ts`

---

#### `LORE_EMBEDDING_API_KEY`

| | |
|---|---|
| **Default** | _(none — some endpoints are keyless)_ |
| **Surface** | daemon |

API key for the OpenAI-compatible embedding endpoint. Optional when using a
keyless local gateway.

Source: `src/mcp/services.ts`

---

#### `LORE_EMBEDDER_CHAR_LIMIT`

| | |
|---|---|
| **Default** | `500` |
| **Surface** | daemon (openAICompatEmbeddingProvider) |

Maximum number of characters sent per embed request to the remote API. The
conservative default (500) prevents server-side errors on long inputs with
models that have small token windows. Operators using models with larger
windows (e.g. `text-embedding-3-small` supports 8,191 tokens) should raise
this limit. Example: `LORE_EMBEDDER_CHAR_LIMIT=30000`.

Source: `src/providers/openAICompatEmbeddingProvider.ts`

---

### 2.3 OpenAI Legacy Alias

These variables are the legacy form of the `openai_compat` knobs. They are
recognized alongside `LORE_EMBEDDING_*` when no explicit provider is set.
Prefer the `LORE_EMBEDDING_*` form for new configurations.

#### `LORE_OPENAI_API_KEY`

| | |
|---|---|
| **Default** | _(falls back to `OPENAI_API_KEY`)_ |
| **Surface** | daemon, CLI (`lore embedder`) |

OpenAI API key for the embedding provider when using the legacy openai path.

Source: `src/providers/pickEmbeddingProvider.ts`

---

#### `LORE_OPENAI_BASE_URL`

| | |
|---|---|
| **Default** | `https://api.openai.com/v1` |
| **Surface** | daemon (LLM dispatch, embedding provider) |

Base URL override for OpenAI-compatible API calls (both embeddings and any LLM
completion calls in the daemon). Set to `https://openrouter.ai/api/v1` to
route through OpenRouter.

Source: `src/providers/pickEmbeddingProvider.ts`, `src/providers/llmDispatch.ts`

---

#### `LORE_OPENAI_MODEL`

| | |
|---|---|
| **Default** | `text-embedding-3-small` |
| **Surface** | daemon (legacy openai embedding path) |

Embedding model when using the legacy openai provider selection.

Source: `src/providers/pickEmbeddingProvider.ts`

---

#### `LORE_OPENAI_DIM`

| | |
|---|---|
| **Default** | `1536` |
| **Surface** | daemon (legacy openai embedding path) |

Vector dimension for the legacy openai embedding path.

Source: `src/providers/pickEmbeddingProvider.ts`

---

### 2.4 Ollama

#### `LORE_OLLAMA_HOST`

| | |
|---|---|
| **Default** | `http://127.0.0.1:11434` (falls back to `OLLAMA_HOST` env if set) |
| **Surface** | daemon (Ollama probe) |

Base URL of the Ollama server. Used when the daemon auto-detects Ollama
as the preferred embedding backend.

Source: `src/providers/pickEmbeddingProvider.ts`

---

#### `LORE_OLLAMA_EMBED_MODEL`

| | |
|---|---|
| **Default** | first installed model matching the known list (`nomic-embed-text`, `mxbai-embed-large`) |
| **Surface** | daemon |

Forces a specific Ollama model for embeddings. Any model installed in Ollama
can be specified. Example: `LORE_OLLAMA_EMBED_MODEL=mxbai-embed-large`.

Source: `src/providers/pickEmbeddingProvider.ts`

---

#### `LORE_OLLAMA_EMBED_DIM`

| | |
|---|---|
| **Default** | `768` |
| **Surface** | daemon |

Vector dimension of the Ollama embedding model. Required when overriding with
a model whose dimension differs from the Ollama default list (`nomic-embed-text`
= 768, `mxbai-embed-large` = 1024).

Source: `src/providers/pickEmbeddingProvider.ts`

---

### 2.5 Batched Embedding Tuning

#### `LORE_EMBED_BATCH_MAX`

| | |
|---|---|
| **Default** | RAM-adaptive (local/Xenova: ~8 texts/GB, clamped 8–256; ≥32 GB → 256) \| `1000` (OpenAI-compatible) |
| **Surface** | daemon (batchedEmbedder) |

Maximum number of texts per embedding model call. When set, replaces the
per-provider default for whichever provider is active. The local default now
scales to the host's total RAM (`embedBatchCap()`) so a small machine never
runs a forward pass big enough to OOM; set this to pin a fixed value. The cap
is enforced by chunking — callers never need to pre-slice.

Source: `src/embed/memoryBudget.ts`, `src/embed/batchedEmbedder.ts`

---

#### `LORE_EMBED_MEM_PCT`

| | |
|---|---|
| **Default** | `70` |
| **Surface** | daemon (embed back-pressure) |

Memory back-pressure threshold: embedding pauses while the process RSS exceeds
this percentage of total system RAM, so a large initial bulk-embed self-throttles
on a constrained host instead of spiking memory. After `LORE_EMBED_MEM_WAIT_MS`
it proceeds throttled (never deadlocks). On roomy hosts it never triggers.

Source: `src/embed/memoryBudget.ts`

---

#### `LORE_EMBED_MEM_WAIT_MS`

| | |
|---|---|
| **Default** | `15000` |
| **Surface** | daemon (embed back-pressure) |

Maximum time the embed back-pressure gate (`LORE_EMBED_MEM_PCT`) waits for memory
to fall back under budget before proceeding anyway (throttle, not block).

Source: `src/embed/memoryBudget.ts`

---

#### `LORE_SEARCH_CONCURRENCY`

| | |
|---|---|
| **Default** | scales to CPU cores, clamped 2–8 |
| **Surface** | daemon / embedded (search admission gate) |

Maximum number of searches allowed to touch the native search engine (LanceDB
vector + full-text) at once. A burst of concurrent searches beyond this waits
briefly in a FIFO queue instead of stampeding the native layer — the condition
that can hard-crash the process. Raise it for throughput on big hosts; lower it
on constrained ones. The one-time full-text index build runs exclusively (drains
in-flight searches) so it never overlaps live reads.

Source: `src/engines/searchGate.ts`

---

#### `LORE_SEARCH_QUEUE_MAX`

| | |
|---|---|
| **Default** | `LORE_SEARCH_CONCURRENCY` × 8 |
| **Surface** | daemon / embedded (search admission gate) |

How many searches may wait in the admission queue before the gate sheds load:
beyond this, a new search fails fast with a `search_overloaded` ("busy, retry
shortly") error instead of piling more work onto a saturated engine.

Source: `src/engines/searchGate.ts`

---

#### `LORE_SEARCH_QUEUE_WAIT_MS`

| | |
|---|---|
| **Default** | `30000` (30s) |
| **Surface** | daemon / embedded (search admission gate) |

Max time a queued **read** may wait for admission before it fails fast with
`SearchOverloadError` instead of riding out the caller's full call timeout.
Generous enough that it never trims a normal read under bounded concurrency,
but puts a ceiling under a stuck or slow holder. Never applied to
`exclusive()` — an index build must always be admitted eventually.

Source: `src/engines/searchGate.ts`

---

#### `LORE_SEARCH_WORKER`

| | |
|---|---|
| **Default** | off (in-process) |
| **Surface** | daemon / embedded (non-cloud) |

Opt-in **worker-process isolation** for the native search engine. When enabled
(`1`/`true`/`on`/`yes`), the LanceDB-backed vector store runs in a dedicated
**child process**; the host forwards every store/search call to it over IPC. The
point: the search substrate is a native add-on, and a native fault (SIGSEGV) is
uncatchable in JS and aborts whatever process it runs in. In-process, that takes
the whole host down; isolated, it kills only the worker — the supervisor restarts
it (and the worker's on-open self-heal rebuilds a corrupt index), so the host
stays up. Off by default: the in-process path is unchanged. Recommended once a
single host serves many concurrent agents (fleet / Cloud digital employees).

Trade-off: each call crosses a process boundary (small added latency + a startup
model-load per worker). The worker rebuilds its embedding provider from the
inherited env, so results match the in-process path. Not applicable in `cloud`
mode (the Dataplane fronts storage). Never engages inside a worker
(`LORE_IS_SEARCH_WORKER`) to prevent recursive forking.

**Per-store override (programmatic, not an env var):** a host embedding Lore
can pass `searchWorkerPolicy?: (basePath: string) => boolean` to `createLore()`
to decide isolation per store instead of process-wide — e.g. keep a tiny
knowledge store in-process (a forked child costs ~90MB of duplicated runtime
for one table handle) while isolating a large one. The policy is consulted
once per store path, at first open, and its answer is authoritative for that
store; when omitted, this env gate applies exactly as above. The recursion
guard still wins regardless — inside a worker the answer is always
in-process, policy or not.

Source: `src/engines/verbatimSearchWorkerProxy.ts`, `src/mcp/services.ts`,
`src/mcp/server.ts` (`CreateLoreOptions.searchWorkerPolicy`),
`src/outbox/workspaceVerbatimResolver.ts`

---

#### `LORE_SEARCH_WORKER_READY_MS` · `LORE_SEARCH_WORKER_CALL_MS` · `LORE_SEARCH_WORKER_MAX_RESTARTS`

| | |
|---|---|
| **Defaults** | `60000` · `120000` · `5` |
| **Surface** | daemon / embedded (only when `LORE_SEARCH_WORKER` is on) |

Tuning for the search worker supervisor: how long to wait for a (re)spawned
worker to become ready (covers model load + a possible self-heal rebuild); the
per-call IPC timeout (covers a large `storeBatch` / index build); and the
consecutive-crash cap after which the supervisor stops restarting and fails
calls fast (so a genuinely broken workspace surfaces instead of crash-looping).

`LORE_WORKER_BASE_PATH`, `LORE_WORKER_EMBED_OVERRIDES`,
`LORE_WORKER_PARENT_EMBEDS`, `LORE_WORKER_EMBED_DIM`,
`LORE_WORKER_EMBED_MODEL`, `LORE_WORKER_EMBED_DTYPE`,
`LORE_WORKER_STRICT_FINGERPRINT`, `LORE_WORKER_PIECE_VECTORS`,
`LORE_WORKER_MODEL_SERVER`, and
`LORE_IS_SEARCH_WORKER` are **internal**
— the parent sets them on the child when it forks a worker (workspace path,
serialized embedding overrides, whether embedding stays in the parent, the
parent provider's vector dimension/model identity/dtype, whether the parent
opened this workspace with strict fingerprint checking — see
`verbatimFingerprintGate.ts` —, the workspace's already-resolved
piece-vectors intent (D7c, 3.23 — so the child's own `VerbatimStore`
construction doesn't have to re-resolve `LORE_RECALL_PIECE_VECTORS` /
per-workspace overrides itself), whether the host opted out of the shared
model server (D9, 3.24 — `CreateLoreOptions.modelServer === false` mirrored
into the child so a worker without a `parentEmbedder` respects the same
opt-out its host's own `attachModelServer` call gets), and the recursion
guard). Do not set them yourself.

Source: `src/engines/verbatimSearchWorkerProxy.ts`

---

#### `LORE_EMBED_TICK_MS`

| | |
|---|---|
| **Default** | `5000` (5 seconds) |
| **Surface** | daemon (outbox replicator embed-batch flush) |

Worst-case ceiling in milliseconds for the embed-batch flush cadence. The
outbox replicator's idle sleep (250 ms) and busy sleep (10 ms) mean queued
embed rows flush far sooner in practice. This value is the documented
upper bound operators use to estimate "how stale can a queued embed be?"

Source: `src/embed/batchedEmbedder.ts`

---

#### `LORE_REEMBED_CHUNK`

| | |
|---|---|
| **Default** | `256` |
| **Surface** | CLI/daemon (`lore embed reembed`, re-embed job) |

Per-outbox-row chunk size for the re-embed job. Each outbox row carries this
many node texts; the replicator's E3 consolidation may further merge adjacent
rows. Matches the local Xenova per-call cap so each row maps to exactly one
model call when drained.

Source: `src/embed/reEmbedJob.ts`

---

### 2.6 Local / In-Process (ONNX)

#### `LORE_LOCAL_EMBEDDING_MODEL`

| | |
|---|---|
| **Default** | `Xenova/multilingual-e5-small` (384-dim) |
| **Surface** | daemon |

HuggingFace model ID for the in-process ONNX embedding pipeline. The model is
downloaded and cached on first use. Changing the model against an existing
workspace requires running `lore migrate embedding-model` to re-embed stored
vectors.

Source: `src/providers/localEmbeddingProvider.ts`, `src/mcp/services.ts`

---

#### `LORE_LOCAL_EMBEDDING_DTYPE`

| | |
|---|---|
| **Default** | `q8` |
| **Values** | `fp32` \| `fp16` \| `q8` (8-bit quantized) \| `q4` |
| **Surface** | daemon (ONNX runtime) |

Quantization of the in-process ONNX embedding model. `q8` is the default —
~4× smaller download and faster inference. Set `fp32` when exact parity with
a full-precision reference embedding is required (e.g. reproducing vectors
generated elsewhere). Changing this against an existing workspace changes the
produced vectors, so re-embed (`lore migrate embedding-model`) if you need the
stored vectors to match. An unset or blank value silently defaults to `q8`;
any other value that isn't one of the four above is invalid — it logs a
warning naming the bad value and falls back to `q8` rather than being passed
through to the ONNX runtime unchecked.

Source: `src/providers/localEmbeddingProvider.ts`

---

**Shared model cache (D9, Lore 3.24).** The local embedding model resolves
through the same shared, verified cache design as the re-rank model above
(`<LORE_HOME>/models/`), via `providers/modelCache.ts`. On first use per
`modelId`+`dtype`, resolution tries, in order: (1) an already-installed copy
under the shared cache (a `.complete` marker present); (2) a legacy
pre-3.24 `@huggingface/transformers` on-disk cache, if one exists, copied
through a staging directory and verified before being trusted — no network;
(3) a download into `.staging-<random>`, verified, then atomically renamed
into place with `.complete` written last. Unlike re-rank, embedding is not
optional, so a download-verify failure is a hard error (nothing is
silently skipped) rather than a fail-open no-op. Concurrent callers for the
same model+dtype (same process or different processes) share one download
via an `O_EXCL` lock file (`.lock-<hash>`, stale after ~60s). The default
model+dtype (`Xenova/multilingual-e5-small` @ `q8`) is additionally pinned
to an exact upstream revision and sha256-verified file-by-file
(`providers/embedManifest.ts`), identically to the re-rank model's pin +
verify scheme; a non-default `--model`/`--dtype` has no manifest coverage.
`lore models prune` always keeps whichever embedding model is currently
configured (`LORE_LOCAL_EMBEDDING_MODEL` or the default), so a routine
prune never deletes the model in active use.

To warm the shared cache ahead of time (a convenience, not a prerequisite —
`embedQuery`/`embedDocument` resolve and download on first use themselves):

```
lore models fetch-embedding [--model <id>] [--dtype fp32|fp16|q8|q4] [--revision <rev>]
```

**The cache follows `LORE_HOME`, not `dataDir`.** The model cache is always
`<LORE_HOME>/models/`, even when an embedded host passes a per-instance
`createLore({ dataDir })`. Pre-fetch with the same `LORE_HOME` the host runs
under, or the host will not see the files.

**A failed warm-up does not fail open.** Opening a store (LanceDB, SQLite
verbatim store, Dataplane adapter) primes the embedding model, but a failure
there (for example a one-off `ETIMEDOUT` reaching Hugging Face) is logged as a
single warning and the store still opens. Open needs only the provider's static
model id, dimension and dtype, never a loaded model. The model load is retried
by the next call that needs an embedding; if it fails again that call throws an
`EmbedModelUnavailableError` naming the model id, dtype, cache directory, the
missing file (or the download failure cause) and the fix
(`lore models fetch-embedding`). After a failed download no new download is
attempted for 30 s (`EMBED_DOWNLOAD_RETRY_PAUSE_MS`): calls inside the pause get
the same error at once, with `retryInMs` set, instead of each paying a connect
timeout. The pause is per model and per process; a model that lands in the cache
meanwhile is used immediately. `preloadLocalModel()` is an explicit
warm-up request and still throws. The re-rank model never downloads at runtime
and is not loaded at open, so it is unaffected.

**Never download (opt-in).** Set `LORE_MODELS_OFFLINE=1` (or `true`) to make a
cache miss fail immediately, with no network attempt, instead of downloading.
A marker hit and a local legacy-cache copy still work. `lore models
fetch-embedding` still downloads when the switch is on (it is the explicit
fetch command) and prints a note saying so. The switch is read from the
environment per call and is passed through to the shared model server.

Source: `src/providers/modelCache.ts`, `src/providers/embedManifest.ts`,
`src/cli/commands/modelsFetchEmbedding.ts`

---

#### `LORE_MODELS_OFFLINE`

| | |
|---|---|
| **Default** | _(unset — off)_ |
| **Surface** | daemon, embedded host |

Set to `1` or `true` to forbid implicit model downloads: a cache miss on the
embedding model fails immediately with an error naming the model id, dtype,
cache directory and missing file, and the fix (`lore models fetch-embedding`).
Off by default. Unlike a failed warm-up, this is deterministic, so a store still
opens and the error surfaces on the first embed.

Source: `src/providers/modelCache.ts`

---

#### `LORE_LOCAL_EMBEDDING_DIM`

| | |
|---|---|
| **Default** | `384` |
| **Surface** | daemon |

Vector dimension of the local embedding model. Only needed when overriding
`LORE_LOCAL_EMBEDDING_MODEL` with a model whose dimension differs from 384.

Source: `src/mcp/services.ts`

---

#### `LORE_LOCAL_EMBEDDING_DEVICE`

| | |
|---|---|
| **Default** | `cpu` |
| **Values** | `cpu` \| `coreml` \| `webgpu` \| `cuda` \| `auto` \| `gpu` |
| **Surface** | daemon (ONNX runtime) |

ONNX Runtime execution provider for the in-process embedding pipeline.
Opt-in — new installs use `cpu` by default. To use Apple Silicon CoreML
acceleration, set `=coreml`. Run `lore embedder check` to see which
providers are available on the host.

Source: `src/providers/localEmbeddingProvider.ts`, `src/mcp/services.ts`

---

#### `LORE_EMBED_IDLE_UNLOAD_MS`

| | |
|---|---|
| **Default** | `0` (never unload — today's behavior, unchanged unless set) |
| **Surface** | daemon / embedding host (in-process ONNX pipeline) |

Idle timeout in milliseconds before the in-process local-embedding ONNX
pipeline is unloaded from memory. Unlike `LORE_MODEL_IDLE_UNLOAD_MS` (the
embedded-LLM pipeline, which always idle-unloads), this defaults to **0 —
never unload** because the local embedding pipeline was measured to be
leak-free per embed cycle (`docs/PERFORMANCE-MEMORY.md` §8.3), so keeping it
resident is the correct default rather than a workaround for a leak. Setting
this to a positive value is a pure opt-in for hosts that index in bursts and
want the pipeline to release memory while idle (e.g. an embedding host
targeting near-zero resident memory between indexing runs). A subsequent
embed call transparently reloads the pipeline; correctness never depends on
whether the cache is warm. A pipeline actively running an embed call is never
unloaded regardless of this setting. Call `releaseLocalEmbeddingPipeline()`
(exported from the package root) to release immediately rather than waiting
for the idle window.

Source: `src/providers/localEmbeddingProvider.ts`

---

## 2a. Shared Model Server

D9 (3.24) — a single local process (`modelServer/`) that serves in-process
ONNX embedding and rerank inference over a Unix domain socket to every Lore
host on the machine, so N hosts sharing a machine share one warm pipeline
instead of each loading its own. Hosts spawn-or-connect to this process
(spawn/connect logic is a separate build slice); the vars below configure
the server process itself. Socket, token and pidfile paths are keyed per
`(LORE_HOME, protocol version, @huggingface/transformers version,
onnxruntime-node version)` and are not independently configurable — see
`src/modelServer/paths.ts`.

#### `LORE_MODEL_SERVER_IDLE_EXIT_MS`

| | |
|---|---|
| **Default** | `60000` (60s) |
| **Surface** | model-server process |

How long the server waits with no connected clients and nothing in flight
before exiting cleanly. `0` disables idle-exit (the server runs until killed
or sent a `shutdown` protocol message / SIGTERM). A client reconnecting
later transparently spawns a fresh server.

Source: `src/modelServer/config.ts`, `src/modelServer/server.ts`

---

#### `LORE_MODEL_SERVER_BOOTSTRAP_TIMEOUT_MS`

| | |
|---|---|
| **Default** | `30000` (30s) |
| **Surface** | model-server process |

If no client ever connects within this many ms of the server starting to
listen, it exits cleanly rather than idling forever on a spawn that nobody
followed up on. `0` disables this check.

Source: `src/modelServer/config.ts`, `src/modelServer/server.ts`

---

#### `LORE_MODEL_SERVER_MAX_CLIENTS`

| | |
|---|---|
| **Default** | `64` |
| **Surface** | model-server process |

Maximum simultaneous client connections. A connection beyond this cap is
refused (destroyed) immediately rather than queued.

Source: `src/modelServer/config.ts`, `src/modelServer/server.ts`

---

#### `LORE_MODEL_SERVER_TEXT_CHAR_LIMIT`

| | |
|---|---|
| **Default** | `200000` |
| **Surface** | model-server process |

Per-text character cap enforced on `embed`/`rerank` request payloads before
they're dispatched to a provider. A request exceeding this returns a
`too_large` protocol error and the connection is kept open (only that one
request is rejected).

Source: `src/modelServer/config.ts`, `src/modelServer/connection.ts`

---

#### `LORE_MODEL_SERVER_LOG_MAX_BYTES`

| | |
|---|---|
| **Default** | `10000000` (10MB) |
| **Surface** | model-server process |

Size threshold that triggers rotation of `<LORE_HOME>/logs/model-server.log`.
This log never contains query/passage/document text by construction (only
ids, op names, counts, byte sizes and timings are logged) — see
`src/modelServer/log.ts`'s header comment.

Source: `src/modelServer/config.ts`, `src/modelServer/log.ts`

---

#### `LORE_MODEL_SERVER_LOG_MAX_FILES`

| | |
|---|---|
| **Default** | `3` |
| **Surface** | model-server process |

Number of rotated `model-server.log.N` backups kept before the oldest is
dropped.

Source: `src/modelServer/config.ts`, `src/modelServer/log.ts`

---

#### `LORE_MODEL_SERVER_QUEUE_MAX_PER_CLIENT`

| | |
|---|---|
| **Default** | `256` |
| **Surface** | model-server process |

Per-client cap on not-yet-dispatched `embed` requests in the round-robin
queue (see `src/modelServer/queue.ts`). A client exceeding this gets a
`busy` protocol error on its next `embed` call rather than an unbounded
queue backlog. Does not apply to `rerank`, which is never queued — it fails
fast with `busy` once the server's re-rank cap is reached
(`LORE_MODEL_SERVER_RERANK_MAX_CONCURRENT` below).

Source: `src/modelServer/config.ts`, `src/modelServer/connection.ts`

---

#### `LORE_MODEL_SERVER_RERANK_MAX_CONCURRENT`

| | |
|---|---|
| **Default** | `LORE_RECALL_RERANK_MAX_CONCURRENT` if set, else `4` |
| **Surface** | model-server process |

Concurrent re-rank score runs inside the shared model server. In-process,
each host has its own `LORE_RECALL_RERANK_MAX_CONCURRENT` slots (default
`2`); the server serves every local host from one pool, so it defaults
higher. A request over the cap fails open immediately with
`_meta.rerank.reason: 'busy'` (original order). Minimum `1`. Read when the
server starts, from the environment of the host that spawned it.

Source: `src/modelServer/config.ts`, `src/providers/localRerankProvider.ts`

---

#### CLI: `lore models server status` / `lore models server stop`

```
lore models server status [--json]
lore models server stop
```

`status` connects to this `LORE_HOME`'s server socket and prints pid,
socket path, protocol version, uptime, connected clients and queue depth;
if no server is running it prints "not running" and exits `0` (not an
error — the server is spawned on demand). `--json` prints the same fields
as JSON instead of the human-readable form.

`stop` sends a `shutdown` protocol message using the server's own auth
token (same as any client) and waits for it to exit gracefully; it never
signals the process by pid or pattern, and never `SIGKILL`s. If no server
is running it exits `0` immediately. If the server doesn't shut down
gracefully, it exits non-zero and reports why rather than forcing the
process down.

Source: `src/cli/commands/modelsServer.ts`

---

## 2b. Shared Model Server — Client

D9 (3.24) slice C2a — the client side of §2a: how a Lore host decides
whether to use the shared model server at all, and how it behaves while
trying to reach one. Applicability (local mode only, Lore's own local
embedding/rerank providers, device `cpu` only, off in a test process unless
overridden — see `src/modelServer/applicability.ts`) is not itself
env-configurable beyond the on/off switch below; everything else here tunes
timing once the client has decided to try.

One server per machine-level `LORE_HOME` (env, else `~/.groundfloor`) — the
same root as the shared `models/` cache. `createLore({ dataDir })` does not
change which server a host uses, so embedders with different `dataDir`s share
one server.

#### `LORE_MODEL_SERVER`

| | |
|---|---|
| **Default** | unset (auto: on outside a test process, off inside one) |
| **Surface** | any Lore host process |

Overrides the shared-client on/off decision. `0` opts this process out
entirely — it always uses its own in-process embedding/rerank providers,
the same as `createLore({ modelServer: false })`. `1` forces the client on
even inside a test process, where it is otherwise disabled by default so
that ordinary test runs never spawn a background server. Ignored (no
effect) when applicability is already false for another reason (non-local
mode, a non-default provider, a non-`cpu` device).

Source: `src/modelServer/applicability.ts`

---

#### `LORE_MODEL_SERVER_READY_MS`

| | |
|---|---|
| **Default** | `10000` (10s) |
| **Surface** | any Lore host process |

Total time budget for one spawn-or-connect attempt: probing for an
already-listening server, and, if none is found, spawning one and polling
until it accepts connections or this budget runs out.

Source: `src/modelServer/applicability.ts`, `src/modelServer/clientConnection.ts`

---

#### `LORE_MODEL_SERVER_RESTARTS`

| | |
|---|---|
| **Default** | `3` |
| **Surface** | any Lore host process |

Maximum spawn/reconnect attempts within one connect cycle before the client
gives up and transitions to fallback (in-process) mode. Paired with
`LORE_MODEL_SERVER_RESTART_BUDGET_MS` below — whichever limit is hit first
ends the attempt loop, since a fast-failing server could otherwise exhaust
many attempts well under the time budget.

Source: `src/modelServer/applicability.ts`, `src/modelServer/client.ts`

---

#### `LORE_MODEL_SERVER_RESTART_BUDGET_MS`

| | |
|---|---|
| **Default** | `10000` (10s) |
| **Surface** | any Lore host process |

Total elapsed time across all restart attempts in one connect cycle before
the client gives up and transitions to fallback mode. See
`LORE_MODEL_SERVER_RESTARTS` above.

Source: `src/modelServer/applicability.ts`, `src/modelServer/client.ts`

---

#### `LORE_MODEL_SERVER_PROBE_MS`

| | |
|---|---|
| **Default** | `60000` (60s) |
| **Surface** | any Lore host process |

While in fallback mode (shared server unreachable), how often the client
probes for a recovered server in the background. A successful probe clears
fallback and logs a recovery warning; probing itself never blocks a caller
— in-process providers keep serving requests the whole time.

Source: `src/modelServer/applicability.ts`, `src/modelServer/client.ts`

---

#### `LORE_MODEL_SERVER_CALL_MS`

| | |
|---|---|
| **Default** | `120000` (2min) |
| **Surface** | any Lore host process |

Per-call deadline applied to `embed` calls against a live shared-server
connection. A call that exceeds this is treated as a liveness failure (the
connection is torn down and a restart/fallback is triggered), not merely a
slow response. Does not apply to `rerank`, which relies solely on its own
caller-supplied timeout (`LORE_RECALL_RERANK_TIMEOUT_MS`, §8) so a slow
rerank fails open without looking like a dead connection.

Source: `src/modelServer/applicability.ts`, `src/modelServer/client.ts`

---

## 3. Sync / Dataplane

### `LORE_CLOUD_URL`

| | |
|---|---|
| **Default** | _(unset — local-only mode)_ |
| **Surface** | daemon (cloud sync client) |

Base URL of the Lore cloud sync endpoint. When unset, the daemon runs in
local-only mode and all sync operations are no-ops. When set, the daemon
creates an `HttpSyncClient` targeting this URL.

Source: `src/sync/createCloudSyncClient.ts`

---

### `LORE_CLOUD_AUTH_TOKEN`

| | |
|---|---|
| **Default** | _(none)_ |
| **Surface** | daemon (cloud sync client) |

Bearer token for authenticating sync calls to `LORE_CLOUD_URL`. Used when
the daemon cannot reach the keychain (e.g. headless server environments).

Source: `src/sync/createCloudSyncClient.ts`

---

### `DATAPLANE_URL`

| | |
|---|---|
| **Default** | `http://localhost:8080` |
| **Surface** | daemon (cloud mode — `LORE_DEPLOYMENT_MODE=cloud`) |

Base URL of the Dataplane service. Required in cloud mode. Legacy env-sourced
path; keychain storage is preferred for production deployments.

Source: `src/mcp/services.ts`

---

### `DATAPLANE_API_KEY`

| | |
|---|---|
| **Default** | _(none)_ |
| **Surface** | daemon (cloud mode) |

API key for the Dataplane service. In cloud mode, the daemon first checks the
system keychain (account `dataplane`); `DATAPLANE_API_KEY` is the backward-
compatible fallback, useful in CI. Also accepted in local mode for opportunistic
local-sync.

**Local-sync is registry-gated.** The sync adapter built from this key only
pushes and pulls Lore workspaces that exist in the host's own workspace registry
(`workspaces.json` under its Lore home). A workspace that is not in that registry
is refused with `cloud_scope_workspace_not_allowed` instead of being synced. Hosts
that set `DATAPLANE_API_KEY` in local mode (Atlas, MIRA, PM Helper) must create
the workspace through Lore's own workspace provisioning before it can sync; earlier
versions pushed any workspace name without this check.

**Cloud rows are keyed by a permanent workspace id.** Each registry entry carries
an immutable `id` (UUID); synced rows use it, not the workspace name. Renaming a
workspace keeps its rows; deleting and recreating one under the same name starts
empty (new id); aliases share their target's id. When a Dataplane-backed store is
built (cloud mode or this local-sync mode), entries written before the field
existed get an id added to `workspaces.json` once (atomic, only the `id` field
changes, path fields untouched). Hosts that never use a Dataplane key are never
rewritten. There is no data migration; rows of a deleted workspace are left in
Dataplane.

Source: `src/mcp/services.ts`, `src/mcp/server.ts`

---

### `DATAPLANE_WORKSPACE_ID`

| | |
|---|---|
| **Default** | _(falls back to `DATAPLANE_TENANT_ID`, then `groundfloor_lore`)_ |
| **Surface** | daemon (cloud mode) |

The Dataplane workspace Lore's storage is provisioned in (preferred name;
`DATAPLANE_TENANT_ID` is the legacy alias). The workspace is fixed by the API
credential: the engine ignores any client-supplied tenant header. Lore workspaces
(the application's tenants) are separated inside it by the `lore_workspace` column,
and `DATAPLANE_ORG_ID` is the Lore instance.

Source: `src/mcp/cloudBootConfig.ts`

---

### `DATAPLANE_CONNECTION`

| | |
|---|---|
| **Default** | _(unset)_ |
| **Surface** | daemon (cloud mode; also the local-sync adapter) |

The one Dataplane connector (database) every Lore call names: graph, verbatim
store, version store, history transactions and the sync adapter all send it.
Set it to the connector that holds the Lore collections (for example
`postgresql`).

Why it matters: when a call names no connector the engine chooses one **per
route** (sqlite for CRUD, query, bulk and vector; postgresql for keyword search
and `/v1/transaction`; surrealdb for graph traverse), unless the engine's own
`DEFAULT_CONNECTOR` overrides all of them. One logical store can then be split
across databases, so keyword search or a history transaction runs against a
database that does not hold the data.

When unset Lore keeps working but is conservative: it never sends
`/v1/transaction` (change and history rows are written separately, failures
counted in `/health`), and it logs `cloud_connection_unset` once at boot.
Keyword search and traverse still follow the engine's per-route defaults, so
set this (or the engine's `DEFAULT_CONNECTOR`) in any real cloud deployment. A
connector that cannot run transactions (sqlite) answers 501 on the first
history write and is then treated the same way as unset.

Source: `src/mcp/cloudBootConfig.ts`, `src/mcp/cloudStores.ts`

---

### `DATAPLANE_TENANT_ID`

| | |
|---|---|
| **Default** | `groundfloor_lore` |
| **Surface** | daemon (cloud mode) |

Tenant identifier for the Dataplane service. Scopes all operations to a
specific tenant namespace.

Source: `src/mcp/services.ts`

---

### `DATAPLANE_ORG_ID`

| | |
|---|---|
| **Default** | _(required in cloud mode; `default` in local-sync mode)_ |
| **Surface** | daemon (cloud mode) |

Organization identifier within the Dataplane tenant. Required when
`LORE_DEPLOYMENT_MODE=cloud`; the daemon refuses to start without it in that
mode to prevent silent cross-org data leakage.

Source: `src/mcp/services.ts`

---

## 3a. Cloud Arcade (ArcadeDB multi-tenant)

> **Off by default.** This entire path (`spike/arcadedb-multitenant`) only
> activates in `arcade` deployment mode (`LORE_DEPLOYMENT_MODE=arcade`) — a
> db-per-app multi-tenant shape backed by a shared ArcadeDB server. A normal
> `local`/`cloud`-mode install never reads these variables.

### `LORE_ARCADE_CA_FILE`

| | |
|---|---|
| **Default** | _(none — system trust store only)_ |
| **Surface** | daemon (arcade HTTP client) |

Path to a private CA certificate file used to validate the TLS connection to
a non-localhost ArcadeDB server. Additive only — certificate validation
(`rejectUnauthorized`) is always on; there is no insecure-TLS escape hatch.
Ignored for plain-HTTP (localhost) connections.

Source: `src/engines/arcade/arcadeHttp.ts`

---

### `LORE_ARCADE_MAX_CONNECTIONS`

| | |
|---|---|
| **Default** | `16` |
| **Surface** | daemon (arcade HTTP client) |

Keep-alive connection pool size (`maxSockets`) for the arcade HTTP client
Agent, shared per ArcadeDB base URL across all cells (tenants/apps) hitting
that server. Raise on a host serving many concurrent arcade cells against one
ArcadeDB instance.

Source: `src/engines/arcade/arcadeHttp.ts`

---

### `LORE_ARCADE_SECRET_BACKEND`

| | |
|---|---|
| **Default** | `sqlite` |
| **Values** | `sqlite` \| `keychain` \| `env` \| `kms` |
| **Surface** | daemon (arcade secret store) |

Selects where per-app ArcadeDB service-account passwords are stored. `sqlite`
keeps them in the registry DB (default). `keychain` uses the OS keychain.
`env` resolves them from `ARCADE_SECRET_<SANITIZED_REF>` environment
variables. `kms` envelope-encrypts them at rest (see
`LORE_ARCADE_KMS_PROVIDER`). An invalid value logs a warning and falls back
to `sqlite`.

Source: `src/engines/arcade/arcadeSecretStore.ts`

---

### `LORE_ARCADE_LEASE_BACKEND`

| | |
|---|---|
| **Default** | `sqlite` |
| **Values** | `sqlite` \| `arcadedb` |
| **Surface** | daemon (arcade cross-daemon cell lease) |

Selects the store used for the cross-daemon fencing lease that arbitrates
which daemon owns a given tenant/app "cell" at a time. `sqlite` is single-host
(default); `arcadedb` stores the lease in ArcadeDB itself, the shape needed
for real multi-host HA. Any value other than `arcadedb` resolves to `sqlite`.

Source: `src/engines/arcade/arcadeCellLease.ts`

---

### `LORE_ARCADE_KMS_PROVIDER`

| | |
|---|---|
| **Default** | `local-kek` |
| **Values** | `local-kek` (only option shipped locally) |
| **Surface** | daemon (arcade KMS secret store, only when `LORE_ARCADE_SECRET_BACKEND=kms`) |

Selects the `KmsKeyProvider` implementation used to envelope-encrypt arcade
secrets. `local-kek` wraps/unwraps data-encryption keys with a locally-held
KEK (`LORE_ARCADE_KMS_KEK` / `LORE_ARCADE_KMS_KEK_FILE`) — proves the envelope
format end-to-end without a cloud dependency. Real `aws-kms`/`gcp-kms`
providers are a drop-in seam (needs-real-cloud validation) but are not
shipped in this build; requesting one fails loud rather than silently
falling back to the local KEK.

Source: `src/engines/arcade/arcadeKmsSecretStore.ts`

---

### `LORE_ARCADE_KMS_KEK_FILE`

| | |
|---|---|
| **Default** | _(none)_ |
| **Surface** | daemon (arcade KMS secret store, `local-kek` provider) |

Path to a file holding the base64-encoded 32-byte KEK (key-encryption key)
used by `LocalKekKmsProvider`. The file must be mode `0600` (owner-only) —
Lore fails loud if it is group/other-readable. Preferred over
`LORE_ARCADE_KMS_KEK` in production since only the path (not the secret
itself) needs to be allowlisted into the daemon's environment.

Source: `src/engines/arcade/arcadeKmsSecretStore.ts`

---

### `LORE_ARCADE_KMS_KEK`

| | |
|---|---|
| **Default** | _(none)_ |
| **Surface** | daemon (arcade KMS secret store, `local-kek` provider) |

The base64-encoded 32-byte KEK itself, supplied directly as an env var. One
of `LORE_ARCADE_KMS_KEK` or `LORE_ARCADE_KMS_KEK_FILE` is required when
`LORE_ARCADE_KMS_PROVIDER=local-kek` (the default provider); Lore fails
closed with neither set. Prefer `LORE_ARCADE_KMS_KEK_FILE` in production —
this variable puts the raw key material directly in the process environment.

Source: `src/engines/arcade/arcadeKmsSecretStore.ts`

---

## 4. Maintenance (`lore maintain`)

All `LORE_MAINTAIN_*` variables control the policy resolved by
`src/engines/maintain/policy.ts`. Precedence: defaults → env → CLI flags.

### `LORE_MAINTAIN_RETENTION_DAYS`

| | |
|---|---|
| **Default** | `90` |
| **Surface** | CLI/MCP (`lore maintain`, `maintain` MCP tool) |

Nodes whose recency timestamp is older than this many days become candidates
for the node-retention operation (archive or delete, per
`LORE_MAINTAIN_NODE_ACTION`). Set to `0` to retain everything indefinitely.

---

### `LORE_MAINTAIN_CLEANUP_VERSIONS_OLDER_THAN`

| | |
|---|---|
| **Default** | `7d` |
| **Format** | Duration string: integer + `d`/`h`/`m`/`s`; bare integer = days |
| **Surface** | CLI/MCP |

LanceDB delta versions older than this duration are eligible for the
version-cleanup operation. Example: `14d`, `168h`, `604800s`.

---

### `LORE_MAINTAIN_COMPACT_FRAGMENT_THRESHOLD`

| | |
|---|---|
| **Default** | `200` |
| **Surface** | CLI/MCP |

Minimum fragment count before the compaction operation runs on a LanceDB
table. Tables with fewer fragments than this threshold are skipped.

---

### `LORE_MAINTAIN_EPHEMERAL_TTL_DAYS`

| | |
|---|---|
| **Default** | `14` |
| **Surface** | CLI/MCP |

Ephemeral workspaces older than this many days are eligible for expiry.
Ephemeral workspaces are identified by `LORE_MAINTAIN_EPHEMERAL_PATTERNS`.

---

### `LORE_MAINTAIN_EPHEMERAL_PATTERNS`

| | |
|---|---|
| **Default** | `e2e-*,*-smoke,*-test` |
| **Format** | Comma- or space-separated glob patterns |
| **Surface** | CLI/MCP |

Glob patterns identifying ephemeral workspaces by name. Workspaces whose
names match any pattern are candidates for expiry after
`LORE_MAINTAIN_EPHEMERAL_TTL_DAYS`.

---

### `LORE_MAINTAIN_PROTECT_TAGS`

| | |
|---|---|
| **Default** | `pinned,protected` |
| **Format** | Comma- or space-separated tag names |
| **Surface** | CLI/MCP |

Node tags that exempt a node from all maintenance operations (archive, delete,
version cleanup). Any node carrying at least one of these tags is never touched
by `lore maintain`.

---

### `LORE_MAINTAIN_NODE_ACTION`

| | |
|---|---|
| **Default** | `archive` |
| **Values** | `archive` \| `delete` |
| **Surface** | CLI/MCP |

Action taken on cold nodes during the node-retention operation. `archive`
writes the node to the archive sink (non-destructive; node can be restored).
`delete` permanently removes the node and its vectors.

---

### `LORE_MAINTAIN_COLD_SIGNAL`

| | |
|---|---|
| **Default** | `retrieval` |
| **Values** | `retrieval` \| `access` \| `update` |
| **Surface** | CLI/MCP |

Recency clock used to determine whether a node is "cold":

- `retrieval` — `last_retrieved_at` (intentional recall/search/get_full). Only
  deliberate retrieval keeps a node warm. Default and recommended.
- `access` — `lastAccessedAt` (any read including graph-view loads). Warmer.
- `update` — `updatedAt` (legacy pre-access-tracking behavior).

All three fall back to `updatedAt` → `createdAt` when the chosen field is empty.

---

### `LORE_MAINTAIN_COMPACTION`

| | |
|---|---|
| **Default** | `true` (enabled) |
| **Values** | `1`/`true`/`on`/`yes` to enable; `0`/`false`/`off`/`no` to disable |
| **Surface** | CLI/MCP |

Enables or disables the LanceDB fragment-compaction operation in `lore maintain`.

---

### `LORE_MAINTAIN_VERSION_CLEANUP`

| | |
|---|---|
| **Default** | `true` (enabled) |
| **Values** | boolean string |
| **Surface** | CLI/MCP |

Enables or disables the LanceDB version-cleanup operation in `lore maintain`.

---

### `LORE_MAINTAIN_NODE_RETENTION`

| | |
|---|---|
| **Default** | `true` (enabled) |
| **Values** | boolean string |
| **Surface** | CLI/MCP |

Enables or disables the node-retention (cold-node archive/delete) operation.

---

### `LORE_MAINTAIN_EPHEMERAL_EXPIRY`

| | |
|---|---|
| **Default** | `true` (enabled) |
| **Values** | boolean string |
| **Surface** | CLI/MCP |

Enables or disables the ephemeral-workspace expiry operation.

---

### Scheduled compaction timer

Distinct from the `LORE_MAINTAIN_*` on-demand policy above: these two
variables control the **background timer** that periodically runs storage
compaction automatically (local/daemon mode only — gated off in embedded
mode, where the host owns maintenance).

### `LORE_COMPACT_INTERVAL_MS`

| | |
|---|---|
| **Default** | `86400000` (24 hours) |
| **Surface** | daemon (scheduled compaction timer) |

Cadence in milliseconds between automatic storage-compaction passes
(graph/vector). Storage compaction is cheap to defer — LanceDB tolerates
fragmentation for a while, so running the pass too often just spends I/O for
no benefit. Non-finite or non-positive values fall back to the default.

Source: `src/mcp/compactionScheduler.ts`

---

### `LORE_COMPACT_SCHEDULE_DISABLED`

| | |
|---|---|
| **Default** | off (scheduled compaction enabled) |
| **Values** | `1` to disable |
| **Surface** | daemon (scheduled compaction timer) |

Opt-out of the scheduled compaction timer entirely — e.g. for an operator who
compacts externally via a `lore compact` cron job, or who wants full manual
control over the maintenance window. Only the exact string `1` disables it.

Source: `src/mcp/compactionScheduler.ts`

---

Same shape, for `versions.sqlite` — one immutable row is recorded per node
write. **Age-based deletion of this history is opt-in (owner decision
2026-09-29). By default nothing is ever deleted by age: the daemon no longer
prunes version history after 90 days.** These four variables control the
daemon's background timer, which — only when pruning is enabled — periodically
soft-compacts old rows, hard-deletes already-compacted rows (nothing reads
one; every read path excludes `compacted=1`), then reclaims space online. For
embedded `createLore()` hosts the same switch is the `versionHistory.pruning`
option (see `docs/API_REFERENCE.md`); the effective policy is readable, never
writable, through `lore.getVersionHistoryPolicy()`, the
`get_version_history_policy` MCP tool and `GET /api/version-history/policy`.

### `LORE_VERSION_PRUNE_ENABLED`

| | |
|---|---|
| **Default** | off (version history is kept forever) |
| **Values** | `1` / `true` to enable, `0` / `false` to force off |
| **Surface** | daemon (scheduled version-prune timer) and the read-only policy surfaces |

Explicitly enables age-based deletion of `node_versions` rows. When enabled
without `LORE_VERSION_RETENTION_DAYS`, the retention window is **2557 days
(7 years)**. `0` / `false` forces pruning off even if
`LORE_VERSION_RETENTION_DAYS` is set. An embedded host's
`versionHistory.pruning` option takes precedence over this variable. Not
settable through MCP or REST.

Source: `src/outbox/versionPruningPolicy.ts`

---

### `LORE_VERSION_RETENTION_DAYS`

| | |
|---|---|
| **Default** | unset (pruning disabled); 2557 (7 years) when pruning is enabled without this variable |
| **Surface** | daemon (scheduled version-prune timer) |

Retention window in days. **Setting it to a positive number explicitly also
enables pruning at that value** (backward compatibility for operators who
already set it) and logs a one-time startup notice. Unset, non-finite or
non-positive values do not enable pruning. Rows older than the window are
pruned, except protected-node rows (any row whose state JSON contains
`"status":"protected"`), which are retained regardless of age. Per-type
overrides (`retentionDaysByType`) apply only when pruning is enabled.

Source: `src/outbox/versionPruningPolicy.ts`, `src/mcp/versionPruneScheduler.ts`

---

### `LORE_VERSION_PRUNE_INTERVAL_MS`

| | |
|---|---|
| **Default** | `86400000` (24 hours) |
| **Surface** | daemon (scheduled version-prune timer; only scheduled when pruning is enabled) |

Cadence in milliseconds between automatic version-prune passes. Non-finite or
non-positive values fall back to the default.

Source: `src/mcp/versionPruneScheduler.ts`

---

### `LORE_VERSION_PRUNE_SCHEDULE_DISABLED`

| | |
|---|---|
| **Default** | off |
| **Values** | `1` to disable |
| **Surface** | daemon (scheduled version-prune timer) |

Kill switch: even with pruning enabled, do not run the scheduled timer, for an
operator who prunes on their own cadence. Only the exact string `1` disables
it. Has no effect when pruning is disabled (nothing is scheduled anyway).

Source: `src/mcp/versionPruneScheduler.ts`

---

## 5. Security & Auth

### `LORE_MCP_AUTH_TOKEN`

| | |
|---|---|
| **Default** | _(none — auth not required)_ |
| **Surface** | daemon (HTTP middleware, MCP socket auth) |

Shared secret for the MCP `/mcp` endpoint and HTTP middleware. When set, the
daemon requires callers to present this token as a Bearer token or matching
header. When unset, the daemon runs without token auth (suitable for local
loopback-only deployments). In cloud mode this is the service-to-service
shared secret.

Source: `src/mcp/server.ts`, `src/mcp/http/middleware.ts`

---

### `LORE_RATE_LIMIT_CAP`

| | |
|---|---|
| **Default** | `5000` (local) / `1000` (cloud, per tenant) |
| **Surface** | daemon (HTTP rate limiter) |

Token-bucket capacity (burst ceiling) for the `generic` rate-limit bucket.
Higher values allow larger bursts. Does not affect dedicated buckets for
`chat`, `extract`, `reconnect`, or `destructive` endpoints.

Source: `src/security/rateLimit.ts`

---

### `LORE_RATE_LIMIT_REFILL`

| | |
|---|---|
| **Default** | `500`/s (local) / `100`/s (cloud) |
| **Surface** | daemon (HTTP rate limiter) |

Token refill rate in tokens per second for the `generic` bucket. Does not
affect per-class bucket limits for `chat`, `extract`, etc.

Source: `src/security/rateLimit.ts`

---

### `LORE_SWEEP_DELETE_ORPHANS`

| | |
|---|---|
| **Default** | off (observe-only) |
| **Values** | `1` to enable cascade-delete |
| **Surface** | daemon (consistency sweeper) |

Opt-in to cascade-delete orphaned vectors (LanceDB rows with no corresponding
graph node) during the consistency sweep. Default is observe-only to prevent
accidental data loss. Set `=1` after verifying the sweep reports look correct.

Source: `src/diagnostics/sweeper.ts`

---

### `LORE_AUDIT_EXPORTER`

| | |
|---|---|
| **Default** | `file` |
| **Values** | `file` \| `none` \| `splunk` \| `datadog` \| `elastic` |
| **Surface** | daemon (audit subsystem) |

Selects the audit-log export backend. `file` tails `audit.jsonl` and is the
default for local mode. `none` disables export (audit.jsonl is still written).
`splunk`, `datadog`, and `elastic` are cloud-activation targets; setting one
of these currently logs a warning and falls back to `file` until the named
impl is wired.

Source: `src/audit/exporter.ts`

---

## 6. Outbox & Replication

### `LORE_OUTBOX_BACKEND`

| | |
|---|---|
| **Default** | `sqlite` |
| **Values** | `sqlite` \| `json` |
| **Surface** | daemon (outbox wiring) |

Selects the outbox storage backend. `sqlite` is the production default.
`json` uses a file-based store and is an emergency fallback for environments
where SQLite is unavailable.

Source: `src/outbox/wiring.ts`

---

### `LORE_OUTBOX_LAG_THRESHOLD_SECONDS`

| | |
|---|---|
| **Default** | `30` |
| **Surface** | daemon (outbox lag cache) |

Global outbox lag threshold in seconds. When the replication lag exceeds this
value, the daemon emits backpressure signals. Per-workspace config can
override this.

Source: `src/outbox/lagCache.ts`

---

### `LORE_OUTBOX_DEPTH_THRESHOLD`

| | |
|---|---|
| **Default** | `10000` |
| **Surface** | daemon (outbox lag cache) |

Global outbox depth threshold (number of unprocessed entries). When the
outbox depth exceeds this value, the daemon emits backpressure signals.

Source: `src/outbox/lagCache.ts`

---

### `LORE_OUTBOX_SELFHEAL_INTERVAL_MS`

| | |
|---|---|
| **Default** | `60000` (60 s) |
| **Surface** | daemon (outbox replicator) |

How often the self-heal sweep runs to reprocess stuck outbox entries. Shorter
intervals recover from transient failures faster at the cost of more frequent
SQLite reads.

Source: `src/outbox/replicator.ts`

---

### `LORE_OUTBOX_SELFHEAL_GRACE_MS`

| | |
|---|---|
| **Default** | `5000` (5 s) |
| **Surface** | daemon (outbox replicator) |

Minimum age of an outbox entry (in milliseconds) before the self-heal sweep
considers it stuck. Prevents racing in-flight replications.

Source: `src/outbox/replicator.ts`

---

### `LORE_OUTBOX_SELFHEAL_BATCH`

| | |
|---|---|
| **Default** | `256` |
| **Surface** | daemon (outbox replicator) |

Maximum number of stuck entries reprocessed per self-heal sweep iteration.
Limits the CPU/IO impact of self-heal on the daemon's hot path.

Source: `src/outbox/replicator.ts`

---

### `LORE_OUTBOX_PRUNE_REPLICATED_MS`

| | |
|---|---|
| **Default** | `604800000` (7 days) |
| **Values** | milliseconds; `0` disables pruning |
| **Surface** | daemon (outbox replicator) |

Outbox entries with status `replicated` older than this many milliseconds are
pruned on the self-heal cadence. Set to `0` to disable pruning (entries
accumulate indefinitely).

Source: `src/outbox/replicator.ts`

---

### `LORE_OUTBOX_POLL_MS`

| | |
|---|---|
| **Default** | `250` |
| **Surface** | daemon (outbox replicator) |

Idle-sleep duration in milliseconds between polling loops when no pending
outbox work is found across all workspaces. Lower values make the replicator
more responsive at the cost of increased CPU wake-ups in idle state.

Source: `src/outbox/replicator.ts`

---

### `LORE_OUTBOX_BUSY_MS`

| | |
|---|---|
| **Default** | `10` |
| **Surface** | daemon (outbox replicator) |

Sleep duration in milliseconds between non-empty processing ticks. Allows
the event loop to breathe between batches when the outbox has work.

Source: `src/outbox/replicator.ts`

---

### `LORE_OUTBOX_MAX_ATTEMPTS`

| | |
|---|---|
| **Default** | `5` |
| **Surface** | daemon + embedded (outbox replicator) |

Number of failed replay attempts before an outbox row is dead-lettered
(`status = 'dead'`, with the last error as its reason). Retries in between
are spaced by the exponential backoff below. A row whose target workspace
was deleted fails with `workspace_not_found` on every attempt, so this is
also how long such rows stay retryable. With the defaults, that is about
14 s after the first failure. Dead rows are recoverable: once the
workspace is back, `lore outbox requeue-dead` returns them to the queue.
Must be a positive integer; anything else falls back to the default.

Source: `src/outbox/retryConfig.ts`

---

### `LORE_OUTBOX_RETRY_BASE_MS`

| | |
|---|---|
| **Default** | `500` |
| **Surface** | daemon + embedded (outbox replicator, SQLite backend) |

First step of the per-row retry backoff, in milliseconds. After a failed
attempt, the row's next attempt is scheduled `base × 2^attempts` later,
capped at 30 s: 1 s, 2 s, 4 s, 8 s with the default. The legacy
`LORE_OUTBOX_BACKEND=json` store has no backoff and ignores this knob.
Must be a positive integer; anything else falls back to the default.

Source: `src/outbox/retryConfig.ts`, `src/outbox/sqliteStore.ts`

---

### `LORE_OUTBOX_CONSOLIDATION_CAP`

| | |
|---|---|
| **Default** | `1024` |
| **Surface** | daemon (outbox replicator) |

Maximum total `texts.length` when consolidating adjacent `embed.batch` outbox
rows into a single dispatch call. Set to `0` to disable consolidation
(per-row dispatch only). Reduces model warm-up overhead on bulk-embed bursts.

Source: `src/outbox/replicator.ts`

---

### `LORE_REPLICATOR_CONSOLIDATION_MAX`

| | |
|---|---|
| **Default** | `256` |
| **Surface** | daemon (outbox replicator) |

Maximum number of adjacent `verbatim.upsert` outbox rows consolidated into a
single `verbatim.upsert.batch` dispatch per tick. Batching reduces LanceDB
fragment proliferation. Set to `0` to disable (per-row dispatch only).

Source: `src/outbox/replicator.ts`

---

## 7. Bulk Load & Streaming

### `LORE_LOAD_MAX_BYTES`

| | |
|---|---|
| **Default** | `10737418240` (10 GiB) |
| **Surface** | daemon (`POST /api/load`) |

Maximum body size for the bulk-load upload endpoint. Uploads that exceed this
limit are rejected with HTTP 413. Distinct from the hot-lane body cap (10 MiB).

Source: `src/mcp/http/routes/load.ts`

---

### `LORE_LOAD_MAX_CONCURRENT_PER_WORKSPACE`

| | |
|---|---|
| **Default** | `3` |
| **Surface** | daemon (`POST /api/load`) |

Maximum number of concurrent bulk-load jobs per workspace. A fourth concurrent
request is rejected with HTTP 429.

Source: `src/storage/loadJobsConcurrency.ts`

---

### `LORE_LOAD_TEMP_RETENTION_HOURS_COMPLETE`

| | |
|---|---|
| **Default** | `24` |
| **Surface** | daemon (load job cleanup) |

Hours to retain temporary upload files for completed load jobs before deletion.

Source: `src/storage/loadJobsConcurrency.ts`

---

### `LORE_LOAD_TEMP_RETENTION_HOURS_FAILED`

| | |
|---|---|
| **Default** | `168` (7 days) |
| **Surface** | daemon (load job cleanup) |

Hours to retain temporary upload files for failed load jobs. Longer retention
gives operators time to inspect failed uploads before they are cleaned up.

Source: `src/storage/loadJobsConcurrency.ts`

---

### `LORE_STREAM_MAX_BYTES`

| | |
|---|---|
| **Default** | `1073741824` (1 GiB) |
| **Surface** | daemon (`POST /api/stream`) |

Maximum total body size for the streaming ingest endpoint. Intended for
long-lived row-shaped streams; larger than the hot-lane cap but smaller than
the bulk-load cap.

Source: `src/mcp/http/routes/stream.ts`

---

### `LORE_STREAM_MAX_LINE_BYTES`

| | |
|---|---|
| **Default** | `1048576` (1 MiB) |
| **Surface** | daemon (`POST /api/stream`) |

Maximum size of a single line in the NDJSON streaming body. Lines exceeding
this limit are rejected to prevent memory exhaustion from pathologically long
JSON objects.

Source: `src/mcp/http/routes/stream.ts`

---

### `LORE_STREAM_MAX_CONCURRENT_PER_WORKSPACE`

| | |
|---|---|
| **Default** | `3` |
| **Surface** | daemon (stream registry) |

Maximum number of concurrent streaming sessions per workspace.

Source: `src/streaming/streamRegistry.ts`

---

### `LORE_STREAM_CONSUMER`

| | |
|---|---|
| **Default** | built-in |
| **Values** | _(future: `kafka`)_ |
| **Surface** | daemon (stream consumer) |

Future cloud-pluggability swap point for the stream consumer backend. Not
yet an active runtime knob — present in source as the architectural seam for
the Kafka connector.

Source: `src/streaming/streamConsumer.ts`

---

### `LORE_LANCE_BATCH_ROWS`

| | |
|---|---|
| **Default** | `5000` |
| **Surface** | daemon (LanceDB bulk loader) |

Number of rows per batch when the LanceDB adapter writes bulk-load data.
Larger values trade memory for fewer round trips; smaller values reduce peak
memory at the cost of more write operations.

Source: `src/bulkLoader/lanceAdapter.ts`

---

### `LORE_SUPERSESSION_ENFORCE`

| | |
|---|---|
| **Default** | off |
| **Values** | `1` / `true` to enable |
| **Surface** | daemon, stdio, embedded (write paths for decision/convention/architecture) |

Host-level default for write-time supersession enforcement (D5). When on,
storing a `decision`, `convention` or `architecture` node requires an explicit
`supersedes` list (empty is a valid answer), refuses a store whose nearest
near-duplicate is not listed unless forced, and refuses prose containing
`SUPERSEDES <id>` without the matching edge. A per-workspace setting overrides
it; `createLore({ supersessionEnforce })` overrides the env var. Successor
replacement at recall time is always on regardless of this flag.

Source: `src/core/supersessionPolicy.ts`

---

## 8. Recall & Ranking

### `LORE_RECALL_RANKING`

| | |
|---|---|
| **Default** | enabled |
| **Values** | `off` to disable |
| **Surface** | daemon (`/api/recall`, recall MCP tools) |

Controls the multi-signal ranking applied to recall results. When enabled,
results are re-scored by combining vector similarity, recency decay, and
access frequency. Set `=off` to disable all signals and return raw vector
scores (useful for debugging or benchmarking the embedding quality).

Source: `src/recall/ranking.ts`

---

### `LORE_RECALL_CANDIDATE_FLOOR`

| | |
|---|---|
| **Default** | `0` (legacy — flipped back from `50` by the review round 2 gating rule, see below) |
| **Values** | integer `0`-`200`; `0` = legacy (candidate window equals `limit` exactly); `50` is the recommended opt-in value |
| **Surface** | daemon (`/api/recall`, `/api/search`, recall MCP tools, embedded `lore.recall()`) |

D3 (prefix-stable ranking): the candidate-generation window (vector seed
fetch, keyword `graph.search`, the starvation-retry bound) is sized as
`candLimit = max(limit, candidateFloor)`, and only the final result slice
uses the caller's `limit`. This makes `top-k@k` a true prefix of
`top-50@50` for every `limit <= candidateFloor` — the same query no longer
surfaces a materially different top result just because a caller asked for
fewer results. Values above `200` clamp to `200`; invalid/garbage input
falls back to `0` (legacy), never to `50`.

**Review round 2 gating decision (2026-09-23):** the default was `50`
through round 1. Real-10k re-measurement
(`scripts/diagnostics/recall-eval/results/d3-before-after.md`) showed
`candidateFloor=50` combined with `LORE_RECALL_LEXICAL_BASE=rrf` (this knob
in isolation, holding the other at its legacy value) collapses real-question
hit@1 from 87.5%/100% (chatty/terse, legacy) to 4.2%/45.8% on sqlite
(37.5%/66.7% on surreal-lance) — `stableProv`'s fixed RRF normalization
(added to fix a separate identifiers regression) has no ceiling in `rrf`
mode, so a mid-rank single-list keyword match can normalize up near 1.0 and
outrank the true semantic top hit. That inflation is only bounded when
`LORE_RECALL_LEXICAL_BASE=anchored` is ALSO set — a cross-knob dependency
the gating rule (per-knob, no regression vs legacy) does not tolerate.
**Review round 3:** any floor > 0 now FORCES `LORE_RECALL_LEXICAL_BASE=anchored`
(an explicit `rrf` option/env is ignored while the floor is active), so the
unsafe floor-only combination above is no longer reachable. To opt in to
prefix-stable ranking, set `LORE_RECALL_CANDIDATE_FLOOR=50`; nothing else is
required. Trade-off (real 10k fixture, sqlite, legacy → opt-in): prefix
stability 16.7% → 100%, negatives with a lexical-only top-1 11/32 → 0/32
(re-measured after the 3.22.1 result-window fix; 13/32 before it),
real-question hit@1/hit@3 unchanged (single query and multi-query
`queries[]`, 100% hit@3 both); identifiers rank1 85% → 65% and
found@10 95% → 85% (surreal/lance: 80% → 65%, 90% → 85%).

Source: `src/recall/candidateWindow.ts`

---

### `LORE_RECALL_LEXICAL_BASE`

| | |
|---|---|
| **Default** | `rrf` (legacy — flipped back from `anchored` by the review round 2 gating rule, see below) |
| **Values** | `rrf` (default, legacy), `anchored` (opt-in) |
| **Surface** | daemon (`/api/recall`, `/api/search`, recall MCP tools, embedded `lore.recall()`) |

D3 (prefix-stable ranking): controls the base score assigned to a seed with
no semantic (vector) score — a bm25-only or keyword-only hit. `anchored`
caps that seed's base score at a strength-aware ceiling between `semFloor`
and `semTop` (round 2: a selective/rare match, e.g. an exact identifier, can
reach near `semTop`; a broad/common match stays capped near `semFloor`,
byte-identical to the round-1 `semFloor * prov` formula at zero selectivity)
— see `lexicalOnlyBase`/`lexicalSelectivity` in `src/recall/candidateWindow.ts`.
`rrf` (default) keeps the seed's raw RRF/keyword-rank provenance score
unchanged (pre-D3 behaviour). Has no effect on a query with no semantic leg
at all (nothing to anchor against).

**Review round 2 gating decision (2026-09-23):** the default was `anchored`
through round 1, then made strength-aware to fix a HIGH review finding
(anchored-default identifiers rank1 0/12, found@10 1/12 vs legacy 10/12,
12/12). The strength-aware fix closed most of that gap, but the real-10k
re-measurement still shows the `anchored` default short of legacy on the
identifiers pass — rank1 85.0%→65.0%, found@10 95.0%→85.0% (sqlite);
80.0%→65.0%, 90.0%→85.0% (surreal-lance). The gating rule requires
identifiers rank1/found@10 not drop vs legacy; this drops, so the default
reverts to `rrf`. `anchored`'s real-question hit@1/hit@3 and negatives
numbers are strictly better than legacy (negatives top-1-lexical-only:
7/20→0/20 offtopic, 4/12→0/12 unanswerable, sqlite; re-measured after
the 3.22.1 result-window fix) — only the identifiers
pass regressed — so it remains available as an explicit opt-in for
workloads that don't need top identifier recall. Setting it alone (floor 0)
gives the anchored scoring without the prefix guarantee (sqlite: identifiers
rank1 70%, found@10 85%; negatives lexical-only top-1 3/32). It is ignored —
always `anchored` — whenever `LORE_RECALL_CANDIDATE_FLOOR` > 0. See
`scripts/diagnostics/recall-eval/results/d3-before-after.md` for full
numbers.

Source: `src/recall/candidateWindow.ts`

---

### `LORE_RECALL_STAGE_TIMING`

| | |
|---|---|
| **Default** | off |
| **Values** | `1` to enable |
| **Surface** | daemon (`/api/recall`, retrieve) |

Debug-only: when set to `1`, each retrieve logs JSON stage timings (`embed`,
`vector`, `fts`, `hydrate`, `filter`, plus `total_ms`). Leave unset in
production; this is measurement for WP5, not a ranking or behavior change.

Source: `src/recall/recallStageTiming.ts`

---

### `LORE_RECALL_RECENCY_HALF_LIFE_DAYS`

| | |
|---|---|
| **Default** | `30` |
| **Surface** | daemon (recall ranking) |

Half-life in days for the exponential recency decay component of recall
ranking. A node last updated exactly `N` days ago scores `exp(-N / half-life)`
for recency. Shorter half-lives penalize old nodes more aggressively.

Source: `src/recall/ranking.ts`

---

## 9. Database Internals

### `LORE_CALL_TALLY`

| | |
|---|---|
| **Default** | on (`0` or `false` disables) |
| **Surface** | daemon + embedded (per graph instance) |

Counts which graph operations a host issues and at what argument shapes —
operation name, call count, and a bucketed shape (`limit=unbounded`,
`limit<=100`, `depth=3`). Read it from a graph instance's `callTally.snapshot()`.

Why it exists: Lore's audit log records writes only, and the tool-dispatch log
sees only calls arriving through Lore's own MCP server. An **embedded** host —
which is how Atlas runs Lore — bypasses both, so there was no record of what it
asks for. A Phase 7 engine comparison had to infer the operation mix by reading
the consumer's source instead of measuring it.

Counting is per-instance, in-memory integers: no file, no handler, no shared
registry, and two instances in one process cannot see each other's counts. It is
therefore not process-global state and needs no ownership gate (`CLAUDE.md`).

Default on, because a counter that is off by default is not there on the day
someone needs the answer. Measured overhead against a real read: **-1.0%** on
200 `getNode` calls, i.e. lost in round-trip noise (`test/call-tally-unit.ts`).
`CallTally.setEnabled(false)` also toggles it at runtime for a measurement
window.

Source: `src/engines/callTally.ts`

### `LORE_BULK_INGEST_CONCURRENCY`

| | |
|---|---|
| **Default** | `16` |
| **Surface** | bulk ingest (`bulkIngest`) |

Width of the worker pool driving node upserts in flight at once during a
`bulkIngest`. SurrealGraph serializes writes only per-id (a `KeyedMutex`),
not globally, so distinct-id concurrent writes are safe at this width
(verified directly: 300-550 node batches at the default width land
100% correctly). The setting exists to bound worst-case memory/backpressure
on a very large reindex, not to protect a connection pool — there is no
pool on this path. See `LORE_SURREAL_COUNT_VIEW` for the one concurrency
caveat that does apply (the optional `getStats()` view, not writes).

Source: `src/mcp/bulkIngest.ts`

---

### `LORE_LANCE_POOL_SIZE`

| | |
|---|---|
| **Default** | `16` |
| **Range** | `[1, 32]` |
| **Surface** | daemon (LanceDB table-handle pool) |

Number of LanceDB read-table handles in the pool. Values outside `[1, 32]`
are clamped.

Source: `src/engines/lanceTablePool.ts`

---

### `LORE_POOL_MAX_WAITERS`

| | |
|---|---|
| **Default** | `200` |
| **Range** | `[1, ∞)` |
| **Surface** | daemon (LanceDB pool) |

Maximum number of requests that may queue waiting for a pool connection.
When this limit is reached, new requests immediately receive a `503
server_overloaded` response with `Retry-After: 1` instead of hanging until
the client times out.

Source: `src/engines/poolLimits.ts`

---

### `LORE_POOL_ACQUIRE_TIMEOUT_MS`

| | |
|---|---|
| **Default** | `30000` |
| **Range** | `[1, ∞)` |
| **Surface** | daemon (LanceDB pool) |

Maximum milliseconds a queued pool acquire may wait before the request
receives a `503 server_overloaded` response. This is a backstop for requests
that queued before `LORE_POOL_MAX_WAITERS` was reached but are still waiting
too long.

Source: `src/engines/poolLimits.ts`

---

### `LORE_LANCE_ADD_COLUMN_SUPPORTED`

| | |
|---|---|
| **Default** | `true` |
| **Values** | `true` \| `1` \| `false` \| `0` |
| **Surface** | daemon (LanceDB migration adapter) |

Capability flag for whether the installed LanceDB build supports adding a
column in-place. When `false`, the adapter takes the table-rebuild path.

Source: `src/migration/adapters/lanceMigrationAdapter.ts`

---

### `LORE_SQLITE_VECTOR_CACHE_MB`

| | |
|---|---|
| **Default** | `64` |
| **Surface** | daemon + embedded (`SqliteVerbatimStore` JS vector-search fallback) |

Memory budget in megabytes for `SqliteVerbatimStore`'s JS brute-force vector
search fallback (used when the optional `sqlite-vec` native extension fails
to load). Below this budget the fallback caches every canonical row's
decoded vector in memory as a `Float32Array` matrix, rebuilt lazily and
invalidated on every write. Above it, a query streams rows from SQLite in
chunks instead — slower per query, but bounded memory regardless of store
size. `0` always streams (never caches).

Source: `src/engines/sqliteVerbatimVector.ts`

---

### `LORE_SQLITE_VECTOR_DISABLE_NATIVE`

| | |
|---|---|
| **Default** | off |
| **Surface** | daemon + embedded (`SqliteVerbatimStore`) |

Test/ops escape hatch: forces the JS brute-force vector-search fallback even
when the `sqlite-vec` native extension is installed and would otherwise
load successfully. Set to `1` to exercise (or benchmark) the fallback path
on a machine where `sqlite-vec` is present.

Only affects the canonical/pooled vector column
(`sqliteVerbatimVector.ts`'s `nativeVectorSearch`/`BruteForceVectorCache`).
D7's piece index (`sqlitePieceIndex.ts`) never reads this var and has no
`sqlite-vec` fast path at all — its `searchPieces()` is JS brute-force
unconditionally, by design (piece-search raw query speed was out of scope
for D7a/D7b). `scripts/diagnostics/piece-bench.mjs --sqlite-vector-path
brute-force` sets this before opening either of its fixtures, but only the
piece-vectors-off leg's timing moves as a result.

Source: `src/engines/sqliteVerbatimSchema.ts`

---

### `LORE_VECTOR_PROMOTE_ROWS`

| | |
|---|---|
| **Default** | `250000` |
| **Surface** | daemon (SQLite → LanceDB verbatim-store promotion trigger) |

Canonical-row threshold at which a `SqliteVerbatimStore` workspace becomes
eligible for automatic promotion to LanceDB (checked as a cheap counter
compare after each committed write, not a `COUNT(*)`). `0` disables the
automatic trigger entirely — promotion can still be run manually via
`lore vectors promote <workspace>`.

Source: `src/engines/verbatimPromotion.ts`

---

### `LORE_SEARCH_CACHE_TTL_MS`

| | |
|---|---|
| **Default** | `1500` |
| **Surface** | daemon (VerbatimStore search cache) |

Time-to-live in milliseconds for verbatim search-cache entries (both semantic
and BM25). Shorter values reduce staleness windows after writes; longer values
deflect more repeated-query load. Cache is invalidated immediately on any write
via the epoch bump regardless of TTL.

Source: `src/engines/verbatimStore.ts`

---

### `LORE_DEFERRED_SCAN_CACHE_TTL_MS`

| | |
|---|---|
| **Default** | `60000` (60s) |
| **Surface** | daemon + embedded (recall's deferred-node sidecar) |

Time-to-live in milliseconds for the per-workspace cache of `findDeferredMatches`'s
corpus scan (the `deferred-*` node lookup that powers recall's "deferred work"
sidecar). Without this cache the scan re-walks the entire workspace on every
single recall call — set to `0` to disable caching entirely (not recommended
above a few hundred nodes). Resolving a deferred node (`resolve_deferred`)
invalidates its workspace's cache immediately regardless of TTL; a brand-new
`deferred-*` node created elsewhere waits out the TTL before it can surface.

Source: `src/engines/deferred.ts`

---
### `LORE_SEARCH_SCAN_CAP`

| | |
|---|---|
| **Default** | `2000` |
| **Surface** | daemon + embedded (keyword search) |

Maximum number of candidate rows fetched (in `updatedAt DESC, id ASC` order) before the shared ranker scores and limits them. Bounds memory/latency on large workspaces; the deterministic pre-order ensures the most-recent/most-relevant rows are kept even when a query matches more than the cap. Shared by LocalGraph and the Dataplane adapter so both backends rank the same rows.

Source: `src/engines/searchRanking.ts`

---

### `LORE_ANALYTICAL_SCAN_CAP`

| | |
|---|---|
| **Default** | `200000` |
| **Surface** | daemon + embedded (analytical `timeSeries` + `groupBy`/`aggregate`) |

Maximum number of matched rows `SqliteAnalyticalStorage.timeSeries`/`groupBy` scan before aggregating over the full matched set (`timeSeries` buckets in JS; `groupBy` collapses via SQL `GROUP BY`). An unbounded scan over a large collection/time-window would exhaust memory or run an unbounded full-table scan. When a query would exceed this cap the call **fails loud** (`AnalyticalScanCapExceeded` — "narrow the filter or time range") rather than silently truncating the input — a truncated scan would corrupt the aggregation (missing buckets/groups, wrong sums). The REST siblings (`POST /api/time-series`, `POST /api/aggregate`) map this to `400 analytical_scan_cap_exceeded`; the `aggregate`/`time_series` MCP tools surface it as a structured tool error. Raise it only if you genuinely need wider series/groups and have the memory/latency headroom.

Source: `src/engines/sqliteAnalyticalStorage.ts` (this cap silently stopped being enforced after the prior graph-engine removal, until it was restored per `docs/audit/` finding X-scancap)

---

### `LORE_ANALYTICAL_GROUP_LIMIT`

| | |
|---|---|
| **Default** | `10000` |
| **Surface** | daemon + embedded (analytical `groupBy` and `distinct`) |

Maximum number of rows `groupBy` (one per group) and `distinct` (one per distinct value) return — distinct from `LORE_ANALYTICAL_SCAN_CAP` above, which bounds rows *scanned* before aggregating; this bounds rows *returned* after aggregating/deduplicating. Applied even when the caller passes no `limit` at all: a high-cardinality `groupField`/`field` (an id, hash, or timestamp column) would otherwise return one row per distinct value with no bound. An explicit `limit` above this cap is clamped down to it rather than refused. Either way — no limit given, or an explicit limit clamped — the `aggregate` MCP tool and `POST /api/aggregate` REST sibling add `truncated: true` to the response (for both the `groupBy` and `distinct` shapes) so a caller knows more rows may exist. Matches the prior legacy-engine-backed implementation's hardcoded 10 000 default for the same reason, restored here after it was dropped in the SQLite rebuild.

Source: `src/contracts/analytical.ts` (`resolveGroupByLimit`), applied to both `groupBy` and `distinct` in `src/engines/sqliteAnalyticalStorage.ts`

---

### `LORE_TOPOLOGY_SCAN_CAP`

| | |
|---|---|
| **Default** | `50000` |
| **Surface** | daemon + embedded (topology / language overviews) |

Maximum number of node rows scanned for the cloud (Dataplane) client-side
group-by topology overviews (`getTopologyOverview`, `getTopologyOverviewByType`,
`getLanguageBreakdown`). When a workspace exceeds the cap the overview is
computed over the first N rows and flags `truncated: true` (the language
breakdown surfaces it via a reserved `_truncated` key). Previously the cloud
path capped at 10000 with no override while the local path capped at 50000 — a
silent parity gap. The cloud path now defaults to 50000 (matching the local
`TOPOLOGY_OVERVIEW_NODE_CAP` constant) and honors this override. Clamped to
`[1, 1000000]`.

Source: `src/engines/dataplaneGraphTopology.ts` (local default in
`src/engines/graphTopology.ts`)

---

### `LORE_RECALL_FANOUT_WS_CAP`

| | |
|---|---|
| **Default** | `50` |
| **Surface** | daemon (`GET /api/recall?workspace=*`) |

Maximum number of workspaces scanned by a single cross-workspace
(`workspace="*"`) recall. The workspace list is sliced to this cap before any
graph is opened, so a large `workspaces.json` never forces every graph handle
open for one query. Clamped to `[1, 10000]`.

Source: `src/mcp/http/routes/search.ts`

---

### `LORE_RECALL_FANOUT_CONCURRENCY`

| | |
|---|---|
| **Default** | `8` |
| **Surface** | daemon (`GET /api/recall?workspace=*`) |

Maximum number of per-workspace scans run in parallel during a cross-workspace
recall. Replaces the former serial one-workspace-at-a-time fan-out. Higher
values reduce latency at the cost of more concurrent SurrealDB/LanceDB reads.
Clamped to `[1, 64]`.

Source: `src/mcp/http/routes/search.ts`

---

### `LORE_RECALL_ABSTAIN`

| | |
|---|---|
| **Default** | unset (off) |
| **Surface** | daemon + embedded (`search`/`recall` MCP tools, `GET /api/search`, `GET /api/recall`, `lore.recall()`) |

D1 calibrated abstention. `1`/`true` makes a named-workspace search/recall
return zero results (`_meta.abstained: true`) when the primary query's top
vector-leg similarity, z-scored against the workspace's own off-topic null
distribution (128 fixed probes, fitted on first use per open store), falls
below `LORE_RECALL_RELEVANCE_FLOOR`. An explicit per-call `abstain`
(MCP param, `?abstain=true|false`, `RecallOpts.abstain`) always wins. Never
applies to `mode:'keyword'`, `workspace="*"`, or a calibration status other
than `ok`. `_meta` fields (`top_similarity`, `top_relevance`, `floor`,
`below_floor`, `abstained`, `abstain_overridden`, `calibration{status,…}`)
and per-hit `similarity`/`relevance` are reported regardless of this flag;
raw `score` is unchanged. See `docs/design/D1-calibrated-abstention.md`.

Source: `src/recall/retrieve.ts`

---

### `LORE_RECALL_RELEVANCE_FLOOR`

| | |
|---|---|
| **Default** | `2.0` |
| **Surface** | same as `LORE_RECALL_ABSTAIN` |

Default z-score floor for abstention (per-call `relevance_floor` /
`relevanceFloor` wins). Only consulted when abstention is on. A non-numeric
value disables gating (fails open).

Source: `src/recall/retrieve.ts`

---

### `LORE_RECALL_ABSTAIN_TERM_COVERAGE`

| | |
|---|---|
| **Default** | unset (off) |
| **Surface** | env only for MCP / HTTP (no per-call switch on those surfaces); the embedded `lore.recall()` / `retrieve()` per-call `abstainTermCoverage` option wins over the env |

**Experimental — failed unseen validation; leave off.** On an independent
question set it added 4–6 wrongly-refused real answers out of 88 and caught no
extra distractors; its only proven benefit is refusing questions about
identifiers that do not exist (D1 §3.10.5).

Opt-in second abstention signal (D1 §3.10). Only consulted when abstention is
on. For a query whose z-score is above the floor but below floor + 2.5, recall
also abstains when the weighted fraction of the query's content terms found in
the top-5 FINAL ranked hits (after lexical fusion and the D3 identifier lane)
is below `LORE_RECALL_TERM_COVERAGE_MIN`, or when the query names strongly
code-shaped identifiers (snake_case, paths, `#123`, camelCase methods, dotted
member paths) and none of them occurs in any ranked seed. Matching is
forgiving: stemming, compound/prefix match, acronym <-> expansion, number
words and a small general synonym table. Queries in unsegmented scripts (CJK,
Thai, ...) are never judged (fail open). The exact-identifier rescue still
overrides. Surfaced in `_meta` as `abstain_reason` and `term_coverage`; with
this flag off, `_meta` carries neither field (identical to before D1 §3.10).
No model, no network; measured cost about 0.1 ms p50 / 0.5 ms p99 per query.

Source: `src/recall/termCoverage.ts`

---

### `LORE_RECALL_TERM_COVERAGE_MIN`

| | |
|---|---|
| **Default** | `0.1` |
| **Surface** | same as `LORE_RECALL_ABSTAIN_TERM_COVERAGE` (env only for MCP / HTTP) |

Weighted term-coverage threshold for the term-coverage abstention signal.
Clamped to [0, 1]; a non-numeric value falls back to the default. Tuned on the
recall-eval dev set (D1 §3.10.2): higher values catch few extra distractors
and cost real answers. Even at 0.1 the signal failed unseen validation
(D1 §3.10.5) — experimental.

Source: `src/recall/termCoverage.ts`

---

### `LORE_RECALL_PIECE_VECTORS`

| | |
|---|---|
| **Default** | unset (off) |
| **Values** | `1` / `true` (case-insensitive) to enable |
| **Surface** | daemon, stdio, embedded (`createLore({ pieceVectors })`, `lore migrate piece-vectors`, seed search inside `recall`/`search`) |

D7 (3.23) piece-level vectors: opt-in. Host-level default for whether a
workspace's verbatim seed search routes through the piece index (title row +
overlapping 128-token windows, 32-token overlap) instead of the single
canonical per-node vector. Precedence, highest first: an explicit
per-workspace override (`workspaces.json`'s `pieceVectors.enabled` for that
entry — set via `setWorkspacePieceVectors()`; there is no CLI subcommand for
it yet, only `lore migrate piece-vectors` for the index itself) — then
`createLore({ pieceVectors })` — then this env var — then off. Turning intent
on does not by itself populate the index: a live-write workspace builds it
incrementally as new/updated nodes are stored (`verbatimStore.ts`'s write
paths call `pieceIndex.upsertForRows()`), but a workspace with existing
content needs a one-time `lore migrate piece-vectors` backfill. Until the
index is `active` (see `_meta.piece_vectors` in `docs/API_REFERENCE.md`), seed
search silently falls back to the pooled/canonical path — turning this on
never breaks retrieval, it only makes it start using pieces once they exist.

Source: `src/engines/pieces/pieceSettings.ts`, `src/engines/openWorkspaceVerbatim.ts`

---

### `LORE_RECALL_PIECE_FANOUT`

| | |
|---|---|
| **Default** | `8` |
| **Surface** | same as `LORE_RECALL_PIECE_VECTORS`, only consulted when piece routing is active |

Over-fetch multiplier for piece-aware seed search. `pieceAwareSearch` asks the
piece index for `limit * LORE_RECALL_PIECE_FANOUT` rows (clamped to
`[64, 2000]`) before grouping hits back down to one score per node (max
across that node's matching pieces) and truncating to `limit` — multiple
pieces from the same node otherwise crowd out distinct nodes in the raw
top-N. If the grouped result is still under-filled and the first fetch hit
its cap exactly, one requery doubles `n` (capped at `4000`). Clamped to
`[2, 32]`; a non-numeric value falls back to the default.

Source: `src/recall/pieceSeedSearch.ts`

---

### `LORE_RECALL_RERANK` / `LORE_RECALL_RERANK_MODEL` / `LORE_RECALL_RERANK_K` / `LORE_RECALL_RERANK_MARGIN`

| | |
|---|---|
| **Default** | **OFF** (3.24 Part B — was ON under D8d); model `Xenova/ms-marco-MiniLM-L-6-v2`; `k=10`; `margin=1.0` |
| **Surface** | daemon + embedded (`recall` MCP tool, `GET /api/recall`, `lore.recall()`, cross-workspace recall) |

D8 local cross-encoder re-rank, **opt-in as of 3.24 Part B**. With no
opinion anywhere in the precedence chain, retrieve() output is byte-identical
to pre-D8 output — no `_meta.rerank`, no `rerank_score`, original order,
nothing added. Rerank only runs when something below explicitly turns it on.
When it is turned on and the model isn't cached yet (the common case until an
operator runs `lore models fetch-rerank`), this fails open exactly like any
other rerank failure — original order, `_meta.rerank = {applied:false,
reason:'model_absent', model}`.

**On switches** (any one of these opts a call into rerank):
- Per query: `rerank:true` (MCP `rerank` param / `?rerank=1` — REST's
  primary, documented form; `?rerank=true`, case-insensitive, is also
  accepted as an alias — / `RecallOpts.rerank:true`).
- Per workspace: `lore workspaces set-rerank <name> on`.
- Per host: `createLore({ recallRerank: { enabled: true } })`.
- Process-wide: `LORE_RECALL_RERANK=1` (or `true`/`on`).

**Precedence (highest to lowest)**:
1. Per-query `rerank:false` — always wins, unconditionally off.
2. Per-workspace `off` — **authoritative**: even an explicit per-query
   `rerank:true` does NOT override a workspace set to off.
   `_meta.rerank = {applied:false, reason:'workspace_disabled'}`.
3. Per-query `rerank:true` — on (unless #1/#2 above already decided it).
4. Per-workspace `on` — on.
5. Host default (`createLore({ recallRerank })` option) — whatever that
   host configured. This sits ABOVE the env var: a host that explicitly
   sets a default wins even if `LORE_RECALL_RERANK` says otherwise.
6. `LORE_RECALL_RERANK` env var — `1`/`true`/`on` or `0`/`false`/`off`.
7. **Default: OFF** (3.24 Part B; was ON under D8d). No opinion anywhere
   above means "do not attempt rerank" — output matches pre-D8 exactly.

`model`/`k`/`margin`: per-workspace override (`--model`/`--k`/`--margin` on
`set-rerank`) > matching env var > default. Cross-workspace recall
(`workspace:'*'`) has no single workspace to consult, so its precedence
collapses to per-call > host default > env > default-off. `k` is clamped to
`[2, 20]`.

**Default (no opinion) is byte-identical to pre-D8 output.** With nothing
set anywhere in the chain, the response shape is exactly what it was before
rerank existed — no `_meta.rerank`, no `rerank_score`, original order,
nothing added. Only an explicit opt-in (per-query, workspace, host default,
or env) makes the response differ from pre-D8d behavior, by attempting a
rerank and reporting `_meta.rerank` either way (applied or fail-open).

When enabled, retrieve()'s top-K candidates are rescored by a local
cross-encoder and reordered, protected by a margin gate: the incumbent #1
result only moves if the challenger beats it by at least `margin` — this
prevents a marginal re-rank score flip from bumping a confidently-correct
top hit. `_meta.rerank` (`{model, applied, gate_held, replaced_top, reason?,
k, margin, latency_ms, pieces_scored, pieces_capped?}`) and a per-hit
`rerank_score` are added to the response — snake_case, alongside the
existing camelCase-vs-snake_case boundary the rest of `_meta` already
follows.

**Fail-open, always.** Any failure returns the original, unmodified
retrieve() order with `_meta.rerank.applied: false` and a `reason`. Re-rank
never throws and never silently reorders on partial failure. Full `reason`
enum:

| `reason` | Meaning |
|---|---|
| `model_absent` | Model not cached under `<LORE_HOME>/models/<modelId>/` (no `.complete` marker) — run `lore models fetch-rerank`. This is the expected reason when a call opts into rerank on a fresh install before the model is fetched. |
| `workspace_disabled` | The workspace's `set-rerank` policy is `off` — authoritative, overrides even a per-query `rerank:true`. |
| `invalid_model` | Configured model id fails the `"org/name"`-shape check (F3). |
| `integrity_failed` | Cached files exist but don't match the pinned sha256 manifest (default model only, F4) — treated as compromised/corrupt, never trusted. |
| `busy` | Process-wide concurrency limit reached; call proceeds unranked rather than queuing (F2). |
| `timeout` | `LORE_RECALL_RERANK_TIMEOUT_MS` (default `10000`) exceeded — enforced by a real `Promise.race`, not cooperative cancellation alone, so it fires even against a scorer that ignores its abort signal. |
| `too_few_results` | Fewer than 2 candidates — nothing meaningful to reorder. |
| `error` | Any other load/scoring exception. |

**English-only by default.** The default model
(`Xenova/ms-marco-MiniLM-L-6-v2`) is English-only. For a non-English
workspace, set a multilingual cross-encoder's Transformers.js ONNX model id
via `LORE_RECALL_RERANK_MODEL` or `lore workspaces set-rerank <name> on
--model <id>` — availability of a suitable ONNX export must be verified per
model; Lore does not hard-code one. `LORE_RECALL_RERANK_DTYPE`
(`fp32`/`fp16`/`q8`/`q4`, default `q8`) is a single process-wide setting
(no per-call or per-workspace dtype surface).

**Offline / no-download rule.** Every re-rank code path on the retrieve()
hot path (`recall/rerankStage.ts` → `providers/localRerankProvider.ts`)
always passes `local_files_only: true` and fails open with
`reason:'model_absent'` if the model isn't already cached under
`<LORE_HOME>/models/<modelId>/` — it never downloads. The **only** way to
fetch a re-rank model is the explicit, operator-run CLI command:

```
lore models fetch-rerank [--model <id>] [--dtype fp32|fp16|q8|q4] [--revision <rev>]
```

This is the one code path in the whole feature allowed `local_files_only:
false`. `lore models prune` always keeps whichever re-rank model is
currently configured (env or default), so a routine prune never deletes
what `fetch-rerank` just downloaded. An idle-loaded model is released after
`LORE_RECALL_RERANK_IDLE_UNLOAD_MS` (default `300000`, 5 min) of no
re-rank calls. There is no "never unload" value: `<= 0` or a non-number
falls back to the 5-minute default (unlike `LORE_EMBED_IDLE_UNLOAD_MS`,
where `0` means never); set a large value to keep it resident. Up to
`LORE_RECALL_RERANK_MAX_CACHED_MODELS` (default `3`, minimum `1`) distinct
model+dtype sessions are kept resident at once (LRU, idle-evicted first) —
relevant once a workspace overrides `model`/`dtype` away from the default.
`LORE_RECALL_RERANK_MAX_CONCURRENT` (default `2`, minimum `1`) caps how
many re-rank scoring runs may execute at once across the whole process; a
call arriving while the cap is reached is not queued — it returns the
original order with `reason:'busy'` (F2 — bounds the CPU any caller can
force onto the cross-encoder).

**Pin + verify (F4/F5, D8d).** The default model at the default dtype
(`q8`) is pinned to an exact upstream commit (`DEFAULT_RERANK_REVISION` in
`providers/rerankManifest.ts`) and every one of its 4 files is checked
against a hardcoded sha256 manifest before it's trusted. `fetch-rerank`
downloads into a `.staging-<random>` directory first, verifies all 4
hashes, and only then atomically renames the verified directory into place
and writes a `.complete` marker — `rerankModelCached()` requires that
marker, so a partial, failed, or unverified download is never mistaken for
"ready to use," and a hash mismatch aborts with nothing written to the
cache (`reason:'integrity_failed'` if a previously-good cache is later
tampered with or corrupted on disk). A non-default `--model`/`--dtype` has
no manifest coverage — pass `--revision` to pin it to a specific commit
anyway; integrity for a non-default model rests on that pin plus the
`.complete` marker requirement alone, not a content hash.

**Memory.** The cross-encoder session is created with `session_options:
{enableCpuMemArena: true, enableMemPattern: false}`. ONNX Runtime's default
`enableMemPattern` caches memory layout keyed by input tensor *shape*, which
speeds up repeated inference at a fixed shape but grows unboundedly on this
workload — the batch remainder and per-piece sequence length (up to the
truncation cap) both vary almost every call, so the cache is never reused.
`enableCpuMemArena` stays on; disabling it makes RSS more erratic, not less.
Measured against real production-shaped queries (K=10, ~37-41 pieces/query):
RSS plateaus around **~890MB** after model load plus sustained querying, vs
**~1.3GB** under ORT's defaults, on an M-series Mac — a ~32% reduction with
no change to latency or reranked order (verified identical across 198
queries, 2 independent runs each way). Forward batch size stays at 32:
smaller batches reduce memory further but were rejected after producing
measurable, non-float-noise reranking-order drift under the q8-quantized
model. Full methodology and variant matrix (build-time evidence, not
shipped): `evidence/d8c/memory-matrix.md`.

Source: `src/recall/rerankConfig.ts`, `src/recall/rerankStage.ts`,
`src/recall/rerankBackend.ts`, `src/providers/localRerankProvider.ts`,
`src/cli/commands/modelsFetch.ts`

---

### `LORE_SEARCH_WEIGHT_LABEL` / `LORE_SEARCH_WEIGHT_CONTENT` / `LORE_SEARCH_WEIGHT_TAGS`

| | |
|---|---|
| **Default** | `4` / `2` / `1` |
| **Surface** | daemon + embedded (keyword search ranking) |

Per-field relevance weights for keyword search ranking: a label match outranks a content match, which outranks a tags-only match. Defaults (4/2/1) are unchanged; override only to retune relevance. Shared source of truth for LocalGraph and Dataplane so local and cloud rank identically.

Source: `src/engines/searchRanking.ts`

---

### `LORE_SEARCH_CACHE_MAX_ENTRIES`

| | |
|---|---|
| **Default** | `500` |
| **Surface** | daemon (VerbatimStore search cache) |

Maximum number of entries in the verbatim search-result LRU cache. Larger
values increase cache hit rates at the cost of more heap memory. Each entry
holds a result array; default 500 supports diverse filter/scope combinations
without churning.

Source: `src/engines/verbatimStore.ts`

---

### `LORE_VERBATIM_NATIVE_CLOSE`

| | |
|---|---|
| **Default** | `1` (natives close) |
| **Surface** | daemon / embedded (VerbatimStore) |

Kill switch for STEP2-CLOSE-PATH-DESIGN.md (a): by default, `VerbatimStore.close()`
calls the native LanceDB `Table.close()` / `Connection.close()` so the memory those
handles hold is actually released, instead of merely dereferencing them. Setting
this to `0`, `false`, or `off` restores the 3.19.1 dereference-only close — an
escape hatch if a future LanceDB version's native close ever regresses. On a
write-drain timeout the natives are never closed for that round regardless of
this setting (logged, dereferenced only) — the same worst case as 3.19.1.

Source: `src/engines/verbatimStore.ts`, `src/engines/verbatimWriteGate.ts`

---

### `LORE_VERBATIM_CLOSE_DRAIN_MS`

| | |
|---|---|
| **Default** | `5000` |
| **Surface** | daemon / embedded (VerbatimStore) |

How long `VerbatimStore.close()` waits for in-flight and queued writes on its Lance
table before giving up (positive integer, milliseconds; anything else uses the
default). After a drain timeout the table handles are released and any write still
queued behind `close()` rejects with `VerbatimStoreClosedError` instead of resolving
as a no-op (3.28.0). Raise it for slow disks or very large batches; tests lower it.

### `LORE_COMPACT_GRACE_MS`

| | |
|---|---|
| **Default** | `600000` (10 minutes) |
| **Surface** | daemon (`VerbatimStore.compact()`) |

Grace-window duration in milliseconds for LanceDB compaction (`optimize()`).
Files newer than this threshold are not pruned, shielding in-flight commits
from the `auto_cleanup` race (lance#3718). Lower values reclaim disk faster
but increase race-window risk. Aggressive offline compaction can use `0` with
`deleteUnverified: true`.

Source: `src/engines/verbatimStore.ts`

---

### `LORE_REGISTRY_IDLE_TTL_MS`

| | |
|---|---|
| **Default** | `0` (idle eviction disabled) — **changed in 3.20.0**, was `1800000` (30 min) |
| **Surface** | daemon (LocalGraphRegistry) |

Idle-eviction threshold for cached workspace (graph) handles. **As of
3.20.0, 0/unset disables the background sweep entirely** — a workspace
graph opened once stays open for the life of the process. Set to a
positive value (e.g. `1800000` for the pre-3.20.0 behaviour) to re-enable
the periodic sweep at that TTL; the sweep then closes SurrealDB handles
idle longer than the configured window, same as before.

**Why the default changed:** `@surrealdb/node` 3.0.3 never frees a
datastore's native allocation on `close()` (docs/PERFORMANCE-MEMORY.md §9)
— every eviction-then-reopen of a graph costs ~100 MB, permanently, with no
corresponding memory returned by the eviction that supposedly justified it.
Idle graph eviction is therefore net-negative on this driver until that
upstream bug is fixed (docs/PERFORMANCE-MEMORY.md §9 "What it means for
hosts", §11). `LORE_MAX_OPEN_WORKSPACES`'s own over-cap LRU eviction (a
separate mechanism, unaffected by this default) still bounds the number of
simultaneously-open workspace graphs. The vector-store (LanceDB) side does
NOT share this problem — see `LORE_VERBATIM_IDLE_TTL_MS` below, unchanged.

Calling `evictIdle(now, idleMs)` directly with an explicit `idleMs` (as
`scripts/measure-memory-configs.mjs` and several tests do) still works
exactly as before regardless of this default — only the *background timer*
is gated on it.

Source: `src/engines/localGraphRegistry.ts`

---

### `LORE_REGISTRY_SWEEP_MS`

| | |
|---|---|
| **Default** | `600000` (10 minutes) |
| **Surface** | daemon (LocalGraphRegistry) |

Interval between background idle-workspace eviction sweeps. Only relevant
when `LORE_REGISTRY_IDLE_TTL_MS` is set to a positive value — with the
3.20.0 default (`0`), no sweep timer is armed at all, so this interval has
nothing to trigger. The sweep, when enabled, closes handles idle longer
than `LORE_REGISTRY_IDLE_TTL_MS`. Lower values keep memory tighter at the
cost of more frequent sweep overhead.

Source: `src/engines/localGraphRegistry.ts`

---

### `LORE_VERBATIM_IDLE_TTL_MS`

| | |
|---|---|
| **Default** | `1800000` (30 minutes) |
| **Surface** | daemon (WorkspaceVerbatimResolver) |

Idle-eviction threshold for cached per-workspace LanceDB (verbatim) handles —
the vector-store sibling of `LORE_REGISTRY_IDLE_TTL_MS`. Same default so the
graph and vector halves of an idle workspace go idle together. Skipped for a
workspace with pending embed-queue or outbox work regardless of idle time
(eviction releases handles, never queued data).

Source: `src/outbox/workspaceVerbatimResolver.ts`

---

### `LORE_VERBATIM_SWEEP_MS`

| | |
|---|---|
| **Default** | `600000` (10 minutes) |
| **Surface** | daemon (WorkspaceVerbatimResolver) |

Interval between background idle-workspace eviction sweeps for the verbatim
resolver — the vector-store sibling of `LORE_REGISTRY_SWEEP_MS`. This sweep
is INDEPENDENT of the graph registry's: SurrealDB's native addon does not
release memory on close (see docs/PERFORMANCE-MEMORY.md §9), so only the
LanceDB/verbatim half evicts automatically — the graph half is evicted only
by `LocalGraphRegistry`'s own, separately-gated sweep.

Source: `src/outbox/workspaceVerbatimResolver.ts`

---

### `LORE_MAX_OPEN_WORKSPACES`

| | |
|---|---|
| **Default** | `8` |
| **Surface** | daemon (LocalGraphRegistry) |

Maximum number of workspace graphs kept open before the registry evicts the
least-recently-accessed one (LRU). Each open workspace holds a SurrealDB
handle + a connection pool + a LanceDB handle (~10–50 MB RSS). Lower on a memory-tight
host; raise on a big-RAM daemon that fans out across many workspaces.

Source: `src/engines/localGraphRegistry.ts`

---

### `LORE_DATAPLANE_HEALTH_TIMEOUT_MS`

| | |
|---|---|
| **Default** | `2000` (2 seconds) |
| **Surface** | daemon (cloud-mode boot health-ping) |

Abort timeout for the one-shot Dataplane `GET /health` ping fired at boot. The
ping is non-fatal (a slow/unreachable remote just marks the daemon `offline`);
widen this only for a reachable-but-slow remote so boot doesn't false-negative.

Source: `src/mcp/services.ts`

---

### `LORE_CONSISTENCY_SWEEP_MS`

| | |
|---|---|
| **Default** | `1800000` (30 minutes) |
| **Surface** | daemon (consistency sweeper) |

Interval between cross-substrate consistency-reconciliation sweeps
(SurrealDB ↔ LanceDB drift repair). Lower to reconcile drift sooner at the cost of more
frequent sweep overhead.

Source: `src/diagnostics/sweeper.ts`

---

### `LORE_RETENTION_FIRST_FIRE_MS`

| | |
|---|---|
| **Default** | `60000` (1 minute) |
| **Surface** | daemon (retention scheduler) |

Delay after daemon boot before the first retention sweep fires. The default
defers the sweep so startup isn't blocked by it.

Source: `src/mcp/retentionScheduler.ts`

---

### `LORE_RETENTION_INTERVAL_MS`

| | |
|---|---|
| **Default** | `86400000` (24 hours) |
| **Surface** | daemon (retention scheduler) |

Interval between repeat retention sweeps after the first one fires. Retention
is idempotent (re-tombstoning is a no-op), so a tighter cadence is safe.

Source: `src/mcp/retentionScheduler.ts`

---

### `LORE_LOG_ROTATION_MS`

| | |
|---|---|
| **Default** | `1800000` (30 minutes) |
| **Surface** | daemon (in-uptime log rotation) |

Interval between in-uptime log-rotation passes during the daemon's lifetime
(in addition to the rotation that runs once at boot). A positive integer
overrides the default; invalid or absent falls back to 30 minutes. Has no
effect in embedded mode (no daemon, no rotation timer).

Source: `src/mcp/server.ts`

---

### `LORE_BULK_LOADER_DIM`

| | |
|---|---|
| **Default** | active embedding provider's `dimension` |
| **Surface** | daemon (substrate-native bulk loader) |

Vector dimension the substrate-native bulk loader writes into prebuilt LanceDB
rows. By default it is **derived from the active embedding provider** (e.g.
`384` for the local MiniLM default, `1536`/`1024` for an `openai_compat`
provider), so prebuilt rows always match the live embedding width. Set a
positive integer only to override that derivation; a non-positive or
non-integer value is ignored and the provider dimension is used.

Source: `src/mcp/server.ts`

---

## 10. Observability

### `LORE_METRICS`

| | |
|---|---|
| **Default** | off |
| **Values** | `on` to enable |
| **Surface** | daemon (`GET /metrics`) |

Enables the Prometheus-compatible `/metrics` scrape endpoint. When unset or
set to any value other than `on`, the route returns HTTP 404 with a hint.
Do not expose this endpoint on a public interface without access controls.

Source: `src/mcp/http/routes/metrics.ts`

---

### `LORE_OTEL_EXPORTER_OTLP_ENDPOINT`

| | |
|---|---|
| **Default** | _(none — tracing disabled)_ |
| **Surface** | daemon (OpenTelemetry hooks) |

OTLP gRPC or HTTP endpoint for OpenTelemetry trace export. When set, the
daemon hooks are "ready" and export spans to this collector. When unset,
tracing is a no-op. Example: `http://localhost:4318`.

Source: `src/observability/otelHooks.ts`

---

### `LORE_OTEL_SERVICE_NAME`

| | |
|---|---|
| **Default** | `lore` |
| **Surface** | daemon (OpenTelemetry hooks) |

Service name reported in exported spans. Override to distinguish multiple Lore
instances in a distributed trace viewer.

Source: `src/observability/otelHooks.ts`

---

### `LORE_OTEL_SAMPLING`

| | |
|---|---|
| **Default** | `ratio:0.05` (5%) |
| **Values** | `always` \| `never` \| `ratio:<0..1>` |
| **Surface** | daemon (OpenTelemetry hooks) |

Trace sampling strategy. `always` samples every request (high volume, useful
for debugging). `never` disables all sampling. `ratio:0.05` samples 5% of
requests. Only meaningful when `LORE_OTEL_EXPORTER_OTLP_ENDPOINT` is set.

Source: `src/observability/otelHooks.ts`

---

## 11. Ingestion & File Watching

### `LORE_WATCH_PATHS`

| | |
|---|---|
| **Default** | _(none — file watching disabled)_ |
| **Format** | Colon-separated absolute paths |
| **Surface** | daemon (local source watcher) |

Absolute paths to watch for file changes and auto-ingest into the active
workspace. Each path is also added to the path allowlist so the daemon can
read files under it. Paths that would widen the allowlist to the filesystem
root (`/`) are rejected.

Source: `src/engines/localSourceWatcher.ts`, `src/security/pathAllowlist.ts`

---

### `LORE_WATCH_EXTENSIONS`

| | |
|---|---|
| **Default** | _(all supported extractable extensions)_ |
| **Format** | Comma-separated extensions without leading dot |
| **Surface** | daemon (local source watcher) |

File extensions to track when watching `LORE_WATCH_PATHS`. Example:
`LORE_WATCH_EXTENSIONS=md,ts,txt`.

Source: `src/engines/localSourceWatcher.ts`

---

### `LORE_WATCH_RECURSIVE`

| | |
|---|---|
| **Default** | off |
| **Values** | `true` \| `1` \| `yes` to enable |
| **Surface** | daemon (local source watcher) |

When enabled, the file watcher descends into subdirectories of the paths in
`LORE_WATCH_PATHS`.

Source: `src/engines/localSourceWatcher.ts`

---

## 12. Tool Surface (MCP)

### `LORE_TOOL_TIER`

| | |
|---|---|
| **Default** | `default` |
| **Values** | `default` \| `slim` \| `opt-in` |
| **Surface** | daemon (MCP server, tool registration) |

Controls which MCP tools are exposed:

- `default` — full tool surface.
- `slim` — reduced surface; experimental, for clients with tool-count limits.
- `opt-in` — only tools explicitly opted in are exposed.

Source: `src/mcp/server.ts`

---

### `LORE_TOOL_SHIM`

| | |
|---|---|
| **Default** | off |
| **Values** | `on` to enable |
| **Surface** | daemon (MCP server, lazy-tool-shim) |

Enables the lazy-tool-shim registry. When on, all tools are hidden behind
three meta-tools (`lore_tool_list`, `lore_tool_schema`, `lore_tool_invoke`).
This reduces the tool count visible to the MCP client from ~50+ to 3,
working around clients that have hard limits on the number of tool definitions
they will accept.

Source: `src/mcp/createMcpServer.ts`, `src/engines/lazyToolShim.ts`

---

### `LORE_TOOL_DISPATCH_LOG`

| | |
|---|---|
| **Default** | enabled |
| **Values** | `0` to disable |
| **Surface** | daemon (MCP server) |

Enables or disables writing tool dispatch records to
`<lore-dir>/tool-dispatch.jsonl`. Set `=0` to opt out of the dispatch log
(reduces I/O in high-throughput environments).

Source: `src/mcp/createMcpServer.ts`

---

## 13. LLM Dispatch

These variables tune the built-in LLM dispatch layer (`src/providers/llmDispatch.ts`).

### `LORE_EMBEDDED_MODEL`

| | |
|---|---|
| **Default** | `onnx-community/gemma-3-1b-it-ONNX` |
| **Surface** | daemon (embedded LLM provider) |

HuggingFace model ID for the built-in ONNX embedded LLM pipeline. The model is
downloaded on first use to `<LORE_HOME>/models/`. Changing this on an existing
install simply picks up the new model on the next chat request; the old cached
weights remain on disk until manually removed.

Source: `src/providers/llmDispatch.ts`

---

### `LORE_MODEL_IDLE_UNLOAD_MS`

| | |
|---|---|
| **Default** | `180000` (3 minutes) |
| **Surface** | daemon (embedded LLM provider) |

Idle timeout in milliseconds before the embedded ONNX model is unloaded from
memory. After this period of inactivity the model weights are released,
recovering ~1.2–1.5 GB of RAM. The next request pays a one-time reload
cost (~5–10 s). (The `keepEmbeddedModelHot` keep-hot toggle was removed in
TW-6b with the chat surface — the model always idle-unloads so a database
never pins that RAM indefinitely.)

Source: `src/providers/llmDispatch.ts`

---

### `LORE_LLM_NUM_CTX`

| | |
|---|---|
| **Default** | `32768` |
| **Surface** | daemon (Ollama LLM provider) |

Context window size (`num_ctx`) passed to Ollama. The Ollama server default (2048)
is too small for system-prompt-injected workspaces; this override ensures the
full system prompt is visible to the model.

Source: `src/providers/llmDispatch.ts`

---

### `LORE_LLM_MAX_TOKENS`

| | |
|---|---|
| **Default** | `1024` |
| **Surface** | daemon (Anthropic LLM provider) |

Maximum tokens per Anthropic API response. Increase for longer answers; decrease
to reduce cost on high-throughput deployments.

Source: `src/providers/llmDispatch.ts`

---

## 14. Development / Eval

### `LORE_EVAL_ITERATIONS`

| | |
|---|---|
| **Default** | `1` (single run) |
| **Surface** | eval suite |

Number of iterations for the eval multi-run averaging harness. Set higher
to reduce variance in benchmark results. Only read by the eval suite, not
the production daemon.

Source: `src/security/envScrub.ts` (allowlisted for eval use).

---

### `LORE_TEST_WORKER_HOOKS`

| | |
|---|---|
| **Default** | off |
| **Surface** | search worker (test-only) |

When set to `1`, exposes `__testHold` / `__testCounters` / `checkGateDeadline`
test hooks on the search worker so unit tests can deterministically hold a
call open or inspect gate/queue counters. Never set in production.

Source: `src/engines/verbatimStore.ts`, `src/engines/verbatimWorkerProtocol.ts`,
`src/security/envScrub.ts` (allowlisted for test use).

---

## 15. Embedded mode (library)

This section covers the `createLore()` programmatic options. Environment
variables in all other sections apply to the daemon / CLI. When running in
embedded mode the host process sets options via `createLore(opts)` — no
daemon is started, no config file is consulted for these settings.

### `deploymentMode` option

| | |
|---|---|
| **Type** | `'embedded' \| 'local' \| 'cloud'` |
| **Default** | `LORE_DEPLOYMENT_MODE` env → config file → `'local'` |

Selects the substrate and transport mode for a `createLore()` call:

- `'embedded'` — in-process only. SurrealDB + LanceDB + SQLite outbox, no TCP
  socket, no daemon threads, no process-level signal/error handlers installed.
  In-process outbox replication runs so `search`/`recall` find newly written
  nodes without a daemon. The host process owns the lifecycle; call `dispose()`
  to release all handles.
- `'local'` — local SurrealDB + LanceDB substrates, but wired for daemon mode
  (stdio or HTTP transport via `main()`). Use `'embedded'` for library use.
- `'cloud'` — Dataplane SDK substrates, wired for daemon mode with the cloud
  adapter. Requires `DATAPLANE_URL`, `DATAPLANE_API_KEY`, `DATAPLANE_ORG_ID`.

The env var `LORE_DEPLOYMENT_MODE` remains the fallback for daemon launches
(`lore serve --http`). A programmatic `createLore({ deploymentMode: 'embedded' })`
call takes precedence over the env var for that instance.

Source: `packages/lore/src/mcp/server.ts` (`createLore`, `CreateLoreOptions`)

---

### `dataDir` option

| | |
|---|---|
| **Type** | `string` (absolute path) |
| **Default** | `LORE_HOME` env → `~/.groundfloor` |

Per-instance Lore data root. Set this to a unique path when embedding
multiple Lore instances in one process — each instance will maintain a fully
isolated on-disk graph (SurrealDB, LanceDB vectors, SQLite outbox).

Without `dataDir`, two `createLore()` calls in the same process will share the
global `LORE_HOME` workspace state and can corrupt each other's data. Always
supply distinct `dataDir` values when running multiple embedded instances.

```ts
const loreA = await createLore({ deploymentMode: 'embedded', dataDir: '/data/a' });
const loreB = await createLore({ deploymentMode: 'embedded', dataDir: '/data/b' });
// A and B are fully isolated.
```

Source: `packages/lore/src/mcp/server.ts` (`createLore`, `CreateLoreOptions`)

---

### At-rest encryption (embedded mode)

Encryption at rest is not wired into the data path in any deployment mode.
Rely on OS/filesystem encryption (FileVault, LUKS, dm-crypt, etc.) to protect
the on-disk graph at `dataDir`. App-layer at-rest encryption is out of scope
for this release and will be tracked as a future work item. See
`docs/SECURITY_ADVISORIES.md` for the full posture.

---

### SDK distribution caveat

The `groundfloor-lore` package currently has a `file:../../v3/groundfloor-ts-sdk`
dev dependency that requires the sibling SDK repo to be present on the same
machine. A fresh install without the SDK sibling will fail `tsc`. Publishing
the SDK to a registry (and pinning it as a versioned dependency) is tracked as
**TW-1b / SW-10** (parked pending SDK team release). This does not affect
runtime use of embedded mode — the SDK is only needed for cloud-mode and the
full build.

---

## SurrealDB engine

SurrealDB is the graph engine — the only one; the prior local graph engine
was fully removed 2026-08-21 (see `docs/KUZU_REMOVAL.md`). It was built as a
second local graph engine alongside the one it replaced
(`docs/SURREALDB_BUILD_PLAN.md`, Phase 1) and has been the default
construction path since; these variables tune the
`SurrealGraph` / `LoreStorageClient.fromSurreal(...)` every local workspace
now uses. Graph substrate only: collections, analytical storage,
pending-ops, and ReBAC are on SQLite; vectors stay on LanceDB.

SurrealDB core is BSL 1.1 — embedding is permitted, offering it as a hosted
service is not. The engine is **local/embedded only**, enforced by
`src/storage/surrealLicenceGuard.ts` and arch rule D-022.

### `LORE_SURREAL_BACKEND`

| | |
|---|---|
| **Default** | `surrealkv` |
| **Surface** | local + embedded (SurrealDB engine only) |

On-disk storage backend: `surrealkv` or `rocksdb`. An unrecognised value warns
and falls back to the default rather than failing the daemon.

**Do not switch to `rocksdb` for a real workspace.** Measured on
`@surrealdb/node@3.0.3` (`scripts/diagnostics/surreal-backend-matrix.mjs`),
rocksdb never releases its directory lock after `close()` — for the lifetime of
the process. That blocks reopening the workspace in the same process AND from
any other process, so a daemon that touched a workspace once would lock out the
CLI, migrations, and backups until it exited. surrealkv releases the lock in
~500 ms. rocksdb remains selectable because it is ~20× faster on single-row
writes, which makes it useful for benchmarking.

Source: `src/engines/surreal/surrealConnection.ts`

---

### `LORE_SURREAL_COUNT_VIEW`

| | |
|---|---|
| **Default** | **off** (set to `1` to enable) |
| **Surface** | local + embedded (SurrealDB engine only) |

Maintains a pre-computed view (`node_counts`, grouped by project+type) that
`getStats` can read instead of running a full-table `GROUP BY`. Measured at
50 000 nodes: `getStats` p95 **204 ms → 22 ms (9.3×)** — but that speedup
comes with a real correctness risk, so it is opt-in, not the default.

**Why it's off by default (2026-08-21):** under concurrent writers that
share a (project, type) group — the normal shape of a bulk ingest into one
workspace — surrealdb-core 3.0.2's view-maintenance transactions can commit
with a lost update. The node rows themselves all land correctly; only the
view's running count silently drifts low. Every open of a flag-on workspace
now drops and re-defines the view (a full backfill from the live table), so
the drift no longer survives a restart — but it is not self-healing within
a session, and it is still a real correctness risk while the process stays
up. Reproduced directly: 300 concurrent distinct-id upserts into one group
left the view at 63–64/300 while all 300 nodes were genuinely present.
Serial writes, or writers spread across distinct (project, type) groups, are
unaffected — `test/surreal-feature-matrix-unit.ts` pins that correctness.

**A leftover view also made deletes fail (fixed in 3.20.2).** Every
workspace that ever booted with this flag on between 2026-08-05 and
2026-08-21 kept the view even after the flag flipped to opt-in, because
nothing ever removed it — SurrealDB kept maintaining a view nobody read.
Once concurrent writers drove that unread view's count to zero for a group,
every later write that touched the same group (`deleteNode`, `supersedeNode`,
`unsupersedeNode`, `markStaleByIds`/`markStaleByTags`, and silently on the
read-path `stampAccessTimes`) failed with:

```
The database encountered unreachable logic: id#... Deletion for a view but
no record exists for that view
```

As of 3.20.2, `applySurrealSchema` runs `REMOVE TABLE IF EXISTS node_counts`
whenever the flag is off, which drops any leftover view on the workspace's
next open and repairs the failure above with no migration step. If you hit
this error on an older build, upgrade and reopen the workspace once.

Turn it on only if you can guarantee the workspace never receives
concurrent bulk writes into one (project, type) group, or don't rely on
`getStats().nodeCount`/`typeBreakdown` for anything correctness-sensitive:

- It **backfills**, so enabling it on a workspace that already has data is safe.
- It is maintained through inserts, group-key changes and deletes, including
  the engine's edge-then-node delete sequence — under SERIAL writes.
- Unlike `DEFINE INDEX`, it does **not** retain the store's directory lock, so
  the workspace can still be reopened.

Set `LORE_SURREAL_COUNT_VIEW=1` to enable. Set back to unset/`0` to roll
back — as of 3.20.2 this **drops** the view on the workspace's next open
(`REMOVE TABLE IF EXISTS node_counts`), it does not leave it on disk. That is
both the rollback and the repair for the failure described above; still no
migration step and no manual cleanup either direction.

Not extended to edge counts: a view over the `edge` RELATION table is broken
upstream (the count never decrements, and one combination panics the engine —
`surrealdb-core-3.0.2 doc/table.rs:434`). The residual ~22 ms of `getStats` is
that live edge count regardless of this flag.

Source: `src/engines/surreal/surrealConnection.ts`

---

### `LORE_SURREAL_FTS`

| | |
|---|---|
| **Default** | unset (off) |
| **Surface** | local + embedded (SurrealDB engine only) |

Defines a full-text analyzer plus BM25 indexes on `label` and `content`, and
routes `search` through them instead of substring matching.

**Measured, and the measurement says do not use it.** At 50 000 nodes it makes
`search` p95 **439 ms → 373 ms — 1.18×**, and costs:

- **Substring search stops working.** Matching becomes whole-word, so
  `search('kapp')` no longer finds `kappa`. Four parity assertions fail; see
  `npm run bench:surreal-fts-parity` for the exact set.
- **3.2× disk** (99 → 313 MB) and **2.5× memory** (326 → 807 MB).
- **2.8× slower ingest** (216 → 78 nodes/s).
- It inherits the `DEFINE INDEX` defect below, so an FTS workspace **cannot be
  reopened** by the process that opened it.

It is kept, flagged off and tested, so the dead end stays measured rather than
re-litigated. Tag matching is deliberately left on the exact-membership path
even when this is on.

Source: `src/engines/surreal/surrealConnection.ts`

---

### `LORE_SURREAL_DEFINE_INDEXES`

| | |
|---|---|
| **Default** | unset (indexes are NOT defined) |
| **Surface** | local + embedded (SurrealDB engine only) |

Set to `1` to define secondary indexes (`type`, `project`, `ecosystem`,
`updatedAt`, `supersededBy`, edge `relation`).

Off by default because `@surrealdb/node@3.0.3` leaks a live libuv handle from
the `DEFINE INDEX` that actually builds an index: **the host process never
exits afterwards.** Only the first boot of a workspace is affected (a no-op
`IF NOT EXISTS` re-define is clean), which makes it look like a fluke rather
than a bug. Asserted as a ratchet by `test/surreal-process-exit-unit.ts`.

Since the prior local graph engine's removal (2026-08-21) SurrealDB is the only graph engine, so
leaving this off means the live workspace runs with no secondary indexes at
all — see `docs/PERFORMANCE_NOTES.md` §1 for the current-state discussion
of what that costs on hot list/cursor readers. Use this flag for the
Phase-2 real-scale measurement, where a hung process at the end of a
benchmark run is acceptable.

Source: `src/engines/surreal/surrealConnection.ts`

---

### `LORE_SURREAL_OPEN_TIMEOUT_MS`

| | |
|---|---|
| **Default** | `2000` |
| **Surface** | local + embedded (SurrealDB engine only) |

Per-attempt timeout when connecting to the embedded store. The driver releases
the directory lock asynchronously after `close()`, so an immediate reopen
blocks — and it blocks by never settling the promise while holding no libuv
handle, which makes Node exit 13 with no error and no log line. Racing each
attempt against this timeout is what converts that silence into a retry.

Source: `src/engines/surreal/surrealConnection.ts`

---

### `LORE_SURREAL_OPEN_BUDGET_MS`

| | |
|---|---|
| **Default** | `15000` |
| **Surface** | local + embedded (SurrealDB engine only) |

Total time budget across open retries before giving up with a named error
identifying a held directory lock as the likely cause. Raise it on a slow disk;
lowering it makes a genuinely-locked workspace fail faster.

Source: `src/engines/surreal/surrealConnection.ts`

---

### `LORE_SURREAL_SETTLE_BUDGET_MS`

| | |
|---|---|
| **Default** | `2000` |
| **Surface** | local + embedded (SurrealDB engine only) |

Hard ceiling on how long `settleSurrealStore` waits for an on-disk store to
stop changing after `close()` before giving up and reporting `{ settled:
false, outcome: 'timeout' }` (best-effort — a store that never settles in
time is a slow close, never a failed one). Set to `0` to disable the wait
entirely. Raise it on a slow disk if timeouts show up in `restore`/`backup`
warnings under normal load.

Source: `src/engines/surreal/surrealSettle.ts`

---

### `LORE_SURREAL_SETTLE_POLL_MS`

| | |
|---|---|
| **Default** | `25` |
| **Surface** | local + embedded (SurrealDB engine only) |

Gap between directory snapshots while `settleSurrealStore` polls a closing
store for changes. Smaller values notice a settled store sooner but poll the
filesystem more often; the round-2 QA fix (below) ties the fast-path floor to
a multiple of this value, so lowering it also lowers how soon a genuinely
idle store can be trusted.

Source: `src/engines/surreal/surrealSettle.ts`

---

### `LORE_SURREAL_SETTLE_MIN_QUIET_MS`

| | |
|---|---|
| **Default** | `150` |
| **Surface** | local + embedded (SurrealDB engine only) |

Minimum wait before a store whose `wal/` is still non-empty (i.e. a real
flush was observed in flight) counts as settled. Does not gate the faster
"unchanged since before polling started" path — see `settleSurrealStore`'s
`FAST_PATH_MIN_ELAPSED_MS` (currently a fixed 60ms floor, not
env-overridable): QA round 2 (2026-09-03) found that path trusting a store
after a single poll (~25-27ms) let a deferred flush landing at t+30ms — still
inside the module's own documented ~10-25ms flush window plus jitter — slip
past undetected. The fast path now requires at least two full poll intervals
AND at least 60ms elapsed from the start of polling before it fires, closing
that gap while still beating this `minQuietMs` floor for a truly idle,
reopened store (measured ~27ms pre-round-2-fix → ~80ms post-fix → 150ms with
this floor alone).

Source: `src/engines/surreal/surrealSettle.ts`

---

## Quick-Reference Table

| Variable | Default | Area |
|---|---|---|
| `LORE_HOME` | `~/.groundfloor` | Core |
| `LORE_PORT` | `3847` | Core |
| `LORE_LOG_LEVEL` | `info` | Core |
| `LORE_WORKSPACE` | _(active workspace)_ | Core |
| `LORE_DEPLOYMENT_MODE` | `local` | Core |
| `LORE_CACHE_DISABLED` | off | Core |
| `LORE_ARCHIVE_DIR` | `<LORE_HOME>/archive` | Core |
| `LORE_BACKUP_KEEP` | `7` | Core |
| `LORE_FRESHNESS_TTL_HOURS` | `24` | Core |
| `LORE_ACCESS_FLUSH_MS` | `60000` | Core |
| `LORE_OCR_LANGUAGES` | `eng` | Core |
| `LORE_WHISPER_BIN` | _(PATH lookup)_ | Core |
| `LORE_EMBEDDING_PROVIDER` | auto | Embedding |
| `LORE_EMBEDDING_BASE_URL` | _(required w/ openai_compat)_ | Embedding |
| `LORE_EMBEDDING_MODEL` | _(required w/ openai_compat)_ | Embedding |
| `LORE_EMBEDDING_DIMENSION` | _(required w/ openai_compat)_ | Embedding |
| `LORE_EMBEDDING_API_KEY` | _(none)_ | Embedding |
| `LORE_EMBEDDER_CHAR_LIMIT` | `500` | Embedding |
| `LORE_OPENAI_API_KEY` | _(env `OPENAI_API_KEY`)_ | Embedding |
| `LORE_OPENAI_BASE_URL` | `https://api.openai.com/v1` | Embedding |
| `LORE_OPENAI_MODEL` | `text-embedding-3-small` | Embedding |
| `LORE_OPENAI_DIM` | `1536` | Embedding |
| `LORE_OLLAMA_HOST` | `http://127.0.0.1:11434` | Embedding |
| `LORE_OLLAMA_EMBED_MODEL` | first available | Embedding |
| `LORE_OLLAMA_EMBED_DIM` | `768` | Embedding |
| `LORE_LOCAL_EMBEDDING_MODEL` | `Xenova/multilingual-e5-small` | Embedding |
| `LORE_LOCAL_EMBEDDING_DIM` | `384` | Embedding |
| `LORE_LOCAL_EMBEDDING_DTYPE` | `q8` | Embedding |
| `LORE_LOCAL_EMBEDDING_DEVICE` | `cpu` | Embedding |
| `LORE_MODELS_OFFLINE` | _(off)_ | Embedding |
| `LORE_CLOUD_URL` | _(none)_ | Sync |
| `LORE_CLOUD_AUTH_TOKEN` | _(none)_ | Sync |
| `DATAPLANE_URL` | `http://localhost:8080` | Sync/Dataplane |
| `DATAPLANE_API_KEY` | _(none)_ | Sync/Dataplane |
| `DATAPLANE_WORKSPACE_ID` | _(`DATAPLANE_TENANT_ID`, else `groundfloor_lore`)_ | Sync/Dataplane |
| `DATAPLANE_CONNECTION` | _(none; engine per-route defaults)_ | Sync/Dataplane |
| `DATAPLANE_TENANT_ID` | `groundfloor_lore` | Sync/Dataplane |
| `DATAPLANE_ORG_ID` | _(required in cloud mode)_ | Sync/Dataplane |
| `LORE_ARCADE_CA_FILE` | _(none)_ | Arcade (off by default) |
| `LORE_ARCADE_MAX_CONNECTIONS` | `16` | Arcade (off by default) |
| `LORE_ARCADE_SECRET_BACKEND` | `sqlite` | Arcade (off by default) |
| `LORE_ARCADE_LEASE_BACKEND` | `sqlite` | Arcade (off by default) |
| `LORE_ARCADE_KMS_PROVIDER` | `local-kek` | Arcade (off by default) |
| `LORE_ARCADE_KMS_KEK_FILE` | _(none)_ | Arcade (off by default) |
| `LORE_ARCADE_KMS_KEK` | _(none)_ | Arcade (off by default) |
| `LORE_MAINTAIN_RETENTION_DAYS` | `90` | Maintenance |
| `LORE_MAINTAIN_CLEANUP_VERSIONS_OLDER_THAN` | `7d` | Maintenance |
| `LORE_MAINTAIN_COMPACT_FRAGMENT_THRESHOLD` | `200` | Maintenance |
| `LORE_MAINTAIN_EPHEMERAL_TTL_DAYS` | `14` | Maintenance |
| `LORE_MAINTAIN_EPHEMERAL_PATTERNS` | `e2e-*,*-smoke,*-test` | Maintenance |
| `LORE_MAINTAIN_PROTECT_TAGS` | `pinned,protected` | Maintenance |
| `LORE_MAINTAIN_NODE_ACTION` | `archive` | Maintenance |
| `LORE_MAINTAIN_COLD_SIGNAL` | `retrieval` | Maintenance |
| `LORE_MAINTAIN_COMPACTION` | `true` | Maintenance |
| `LORE_MAINTAIN_VERSION_CLEANUP` | `true` | Maintenance |
| `LORE_MAINTAIN_NODE_RETENTION` | `true` | Maintenance |
| `LORE_MAINTAIN_EPHEMERAL_EXPIRY` | `true` | Maintenance |
| `LORE_COMPACT_INTERVAL_MS` | `86400000` (24 h) | Maintenance |
| `LORE_COMPACT_SCHEDULE_DISABLED` | off | Maintenance |
| `LORE_VERSION_PRUNE_ENABLED` | off (history kept forever) | Maintenance |
| `LORE_VERSION_RETENTION_DAYS` | unset (pruning off); explicit value enables pruning; 2557 (7 y) when enabled without it | Maintenance |
| `LORE_VERSION_PRUNE_INTERVAL_MS` | `86400000` (24 h) | Maintenance |
| `LORE_VERSION_PRUNE_SCHEDULE_DISABLED` | off | Maintenance |
| `LORE_MCP_AUTH_TOKEN` | _(none)_ | Security |
| `LORE_RATE_LIMIT_CAP` | `5000` / `1000` | Security |
| `LORE_RATE_LIMIT_REFILL` | `500`/s / `100`/s | Security |
| `LORE_SWEEP_DELETE_ORPHANS` | off | Security |
| `LORE_AUDIT_EXPORTER` | `file` | Security |
| `LORE_OUTBOX_BACKEND` | `sqlite` | Outbox |
| `LORE_OUTBOX_LAG_THRESHOLD_SECONDS` | `30` | Outbox |
| `LORE_OUTBOX_DEPTH_THRESHOLD` | `10000` | Outbox |
| `LORE_OUTBOX_SELFHEAL_INTERVAL_MS` | `60000` | Outbox |
| `LORE_OUTBOX_SELFHEAL_GRACE_MS` | `5000` | Outbox |
| `LORE_OUTBOX_SELFHEAL_BATCH` | `256` | Outbox |
| `LORE_OUTBOX_PRUNE_REPLICATED_MS` | `604800000` (7 days) | Outbox |
| `LORE_OUTBOX_POLL_MS` | `250` | Outbox |
| `LORE_OUTBOX_BUSY_MS` | `10` | Outbox |
| `LORE_OUTBOX_MAX_ATTEMPTS` | `5` | Outbox |
| `LORE_OUTBOX_RETRY_BASE_MS` | `500` | Outbox |
| `LORE_OUTBOX_CONSOLIDATION_CAP` | `1024` | Outbox |
| `LORE_REPLICATOR_CONSOLIDATION_MAX` | `256` | Outbox |
| `LORE_LOAD_MAX_BYTES` | `10737418240` (10 GiB) | Load |
| `LORE_LOAD_MAX_CONCURRENT_PER_WORKSPACE` | `3` | Load |
| `LORE_LOAD_TEMP_RETENTION_HOURS_COMPLETE` | `24` | Load |
| `LORE_LOAD_TEMP_RETENTION_HOURS_FAILED` | `168` | Load |
| `LORE_STREAM_MAX_BYTES` | `1073741824` (1 GiB) | Streaming |
| `LORE_STREAM_MAX_LINE_BYTES` | `1048576` (1 MiB) | Streaming |
| `LORE_STREAM_MAX_CONCURRENT_PER_WORKSPACE` | `3` | Streaming |
| `LORE_STREAM_CONSUMER` | built-in | Streaming |
| `LORE_LANCE_BATCH_ROWS` | `5000` | Load/LanceDB |
| `LORE_RECALL_RANKING` | enabled | Recall |
| `LORE_RECALL_CANDIDATE_FLOOR` | `0` (opt-in `50`) | Recall |
| `LORE_RECALL_LEXICAL_BASE` | `rrf` (opt-in `anchored`) | Recall |
| `LORE_SUPERSESSION_ENFORCE` | off | Write/Supersession |
| `LORE_VERSION_SKIP_TYPES` | unset (no types skipped) | Write/Versioning |
| `LORE_RECALL_STAGE_TIMING` | off | Recall |
| `LORE_RECALL_RECENCY_HALF_LIFE_DAYS` | `30` | Recall |
| `LORE_RECALL_FANOUT_WS_CAP` | `50` | Recall |
| `LORE_RECALL_FANOUT_CONCURRENCY` | `8` | Recall |
| `LORE_RECALL_ABSTAIN` | unset (off) | Recall |
| `LORE_RECALL_RELEVANCE_FLOOR` | `2.0` | Recall |
| `LORE_RECALL_ABSTAIN_TERM_COVERAGE` | unset (off) | Recall |
| `LORE_RECALL_TERM_COVERAGE_MIN` | `0.1` | Recall |
| `LORE_RECALL_PIECE_VECTORS` | unset (off) | Recall |
| `LORE_RECALL_PIECE_FANOUT` | `8` | Recall |
| `LORE_RECALL_RERANK` | OFF (3.24 Part B; was ON under D8d) | Recall |
| `LORE_RECALL_RERANK_MODEL` | `Xenova/ms-marco-MiniLM-L-6-v2` | Recall |
| `LORE_RECALL_RERANK_K` | `10` | Recall |
| `LORE_RECALL_RERANK_MARGIN` | `1.0` | Recall |
| `LORE_RECALL_RERANK_TIMEOUT_MS` | `10000` | Recall |
| `LORE_RECALL_RERANK_DTYPE` | `q8` | Recall |
| `LORE_RECALL_RERANK_IDLE_UNLOAD_MS` | `300000` | Recall |
| `LORE_RECALL_RERANK_MAX_CONCURRENT` | `2` | Recall |
| `LORE_RECALL_RERANK_MAX_CACHED_MODELS` | `3` | Recall |
| `LORE_LANCE_POOL_SIZE` | `16` | DB Internals |
| `LORE_POOL_MAX_WAITERS` | `200` | DB Internals |
| `LORE_POOL_ACQUIRE_TIMEOUT_MS` | `30000` | DB Internals |
| `LORE_SEARCH_SCAN_CAP` | `2000` | Search |
| `LORE_ANALYTICAL_SCAN_CAP` | `200000` | Analytical |
| `LORE_ANALYTICAL_GROUP_LIMIT` | `10000` | Analytical |
| `LORE_TOPOLOGY_SCAN_CAP` | `50000` | Search |
| `LORE_SEARCH_WEIGHT_LABEL` | `4` | Search |
| `LORE_SEARCH_WEIGHT_CONTENT` | `2` | Search |
| `LORE_SEARCH_CONCURRENCY` | cores (2–8) | Search |
| `LORE_SEARCH_QUEUE_MAX` | concurrency×8 | Search |
| `LORE_SEARCH_WORKER` | off | Search |
| `LORE_SEARCH_WORKER_READY_MS` | `60000` | Search |
| `LORE_SEARCH_WORKER_CALL_MS` | `120000` | Search |
| `LORE_SEARCH_WORKER_MAX_RESTARTS` | `5` | Search |
| `LORE_WORKER_BASE_PATH` | _(internal)_ | Search |
| `LORE_WORKER_EMBED_OVERRIDES` | _(internal)_ | Search |
| `LORE_WORKER_PARENT_EMBEDS` | _(internal)_ | Search |
| `LORE_WORKER_EMBED_DIM` | _(internal)_ | Search |
| `LORE_WORKER_EMBED_MODEL` | _(internal)_ | Search |
| `LORE_WORKER_EMBED_DTYPE` | _(internal)_ | Search |
| `LORE_WORKER_STRICT_FINGERPRINT` | _(internal)_ | Search |
| `LORE_WORKER_PIECE_VECTORS` | _(internal)_ | Search |
| `LORE_WORKER_MODEL_SERVER` | _(internal)_ | Search |
| `LORE_IS_SEARCH_WORKER` | _(internal)_ | Search |
| `LORE_SEARCH_WEIGHT_TAGS` | `1` | Search |
| `LORE_LANCE_ADD_COLUMN_SUPPORTED` | `true` | DB Internals |
| `LORE_SQLITE_VECTOR_CACHE_MB` | `64` | DB Internals |
| `LORE_SQLITE_VECTOR_DISABLE_NATIVE` | off | DB Internals |
| `LORE_VECTOR_PROMOTE_ROWS` | `250000` | DB Internals |
| `LORE_SEARCH_CACHE_TTL_MS` | `1500` | DB Internals |
| `LORE_DEFERRED_SCAN_CACHE_TTL_MS` | `60000` | DB Internals |
| `LORE_SEARCH_CACHE_MAX_ENTRIES` | `500` | DB Internals |
| `LORE_COMPACT_GRACE_MS` | `600000` (10 min) | DB Internals |
| `LORE_REGISTRY_IDLE_TTL_MS` | `0` (idle eviction disabled — was `1800000`/30 min pre-3.20.0) | DB Internals |
| `LORE_REGISTRY_SWEEP_MS` | `600000` (10 min) | DB Internals |
| `LORE_MAX_OPEN_WORKSPACES` | `8` | DB Internals |
| `LORE_DATAPLANE_HEALTH_TIMEOUT_MS` | `2000` (2 s) | DB Internals |
| `LORE_CONSISTENCY_SWEEP_MS` | `1800000` (30 min) | DB Internals |
| `LORE_RETENTION_FIRST_FIRE_MS` | `60000` (1 min) | DB Internals |
| `LORE_RETENTION_INTERVAL_MS` | `86400000` (24 h) | DB Internals |
| `LORE_LOG_ROTATION_MS` | `1800000` (30 min) | DB Internals |
| `LORE_BULK_LOADER_DIM` | _(provider dimension)_ | Load/LanceDB |
| `LORE_METRICS` | off | Observability |
| `LORE_OTEL_EXPORTER_OTLP_ENDPOINT` | _(none)_ | Observability |
| `LORE_OTEL_SERVICE_NAME` | `lore` | Observability |
| `LORE_OTEL_SAMPLING` | `ratio:0.05` | Observability |
| `LORE_WATCH_PATHS` | _(none)_ | Ingestion |
| `LORE_WATCH_EXTENSIONS` | all extractable | Ingestion |
| `LORE_WATCH_RECURSIVE` | off | Ingestion |
| `LORE_TOOL_TIER` | `default` | MCP Tools |
| `LORE_TOOL_SHIM` | off | MCP Tools |
| `LORE_TOOL_DISPATCH_LOG` | enabled | MCP Tools |
| `LORE_EMBEDDED_MODEL` | `onnx-community/gemma-3-1b-it-ONNX` | LLM Dispatch |
| `LORE_MODEL_IDLE_UNLOAD_MS` | `180000` (3 min) | LLM Dispatch |
| `LORE_LLM_NUM_CTX` | `32768` | LLM Dispatch |
| `LORE_LLM_MAX_TOKENS` | `1024` | LLM Dispatch |
| `LORE_EMBED_IDLE_UNLOAD_MS` | `0` (never unload) | Embedding |
| `LORE_EMBED_BATCH_MAX` | RAM-adaptive / `1000` | Embedding |
| `LORE_EMBED_MEM_PCT` | `70` | Embedding |
| `LORE_EMBED_MEM_WAIT_MS` | `15000` | Embedding |
| `LORE_EMBED_TICK_MS` | `5000` | Embedding |
| `LORE_REEMBED_CHUNK` | `256` | Embedding |
| `LORE_EVAL_ITERATIONS` | `1` | Dev/Eval |
| `LORE_SURREAL_BACKEND` | `surrealkv` | SurrealDB engine |
| `LORE_SURREAL_DEFINE_INDEXES` | off | SurrealDB engine |
| `LORE_SURREAL_OPEN_TIMEOUT_MS` | `2000` | SurrealDB engine |
| `LORE_SURREAL_OPEN_BUDGET_MS` | `15000` | SurrealDB engine |
| `LORE_SURREAL_COUNT_VIEW` | off | SurrealDB engine |
| `LORE_SURREAL_FTS` | off | SurrealDB engine |
| `LORE_SURREAL_SETTLE_BUDGET_MS` | `2000` | SurrealDB engine |
| `LORE_SURREAL_SETTLE_POLL_MS` | `25` | SurrealDB engine |
| `LORE_SURREAL_SETTLE_MIN_QUIET_MS` | `150` | SurrealDB engine |
