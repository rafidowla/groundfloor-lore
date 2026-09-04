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
| **Values** | `openai_compat` \| `local` \| `xenova` |
| **Surface** | daemon (embedding pipeline) |

Explicitly selects the embedding backend. When unset, the daemon probes for
Ollama and falls back to the local ONNX provider.

- `openai_compat` — remote OpenAI-compatible API; requires
  `LORE_EMBEDDING_BASE_URL`, `LORE_EMBEDDING_MODEL`, and
  `LORE_EMBEDDING_DIMENSION`.
- `local` / `xenova` — in-process ONNX via `@huggingface/transformers`; see
  `LORE_LOCAL_EMBEDDING_MODEL`.

Source: `src/providers/pickEmbeddingProvider.ts`, `src/mcp/services.ts`

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

Source: `src/engines/verbatimSearchWorkerProxy.ts`, `src/mcp/services.ts`

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
`LORE_WORKER_EMBED_MODEL`, and `LORE_IS_SEARCH_WORKER` are **internal** — the
parent sets them on the child when it forks a worker (workspace path, serialized
embedding overrides, whether embedding stays in the parent, the parent
provider's vector dimension/model identity, and the recursion guard). Do not
set them yourself.

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
| **Values** | `q8` (8-bit quantized) \| `fp32` (full precision) |
| **Surface** | daemon (ONNX runtime) |

Quantization of the in-process ONNX embedding model. `q8` is the default —
~4× smaller download and faster inference. Set `fp32` when exact parity with
a full-precision reference embedding is required (e.g. reproducing vectors
generated elsewhere). Changing this against an existing workspace changes the
produced vectors, so re-embed (`lore migrate embedding-model`) if you need the
stored vectors to match.

Source: `src/providers/localEmbeddingProvider.ts`

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

Source: `src/mcp/services.ts`, `src/mcp/server.ts`

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
write, with no built-in ceiling. `pruneVersions()` existed since Feature 8
(2026-05-26) but was never wired to anything, so a long-running local daemon's
version history grew unbounded (found in the wild: 896MB against a healthy
sibling's ~130MB for a comparable node count). These three variables control
the background timer that periodically soft-compacts old rows, hard-deletes
already-compacted rows (nothing reads one — every read path excludes
`compacted=1`), then VACUUMs to actually reclaim the freed pages on disk.

### `LORE_VERSION_RETENTION_DAYS`

| | |
|---|---|
| **Default** | `90` |
| **Surface** | daemon (scheduled version-prune timer) |

Rows older than this many days are pruned, except protected-node rows (any
row whose state JSON contains `"status":"protected"`), which are retained
regardless of age. Non-finite or non-positive values fall back to the default.

Source: `src/mcp/versionPruneScheduler.ts`

---

### `LORE_VERSION_PRUNE_INTERVAL_MS`

| | |
|---|---|
| **Default** | `86400000` (24 hours) |
| **Surface** | daemon (scheduled version-prune timer) |

Cadence in milliseconds between automatic version-prune passes. Non-finite or
non-positive values fall back to the default.

Source: `src/mcp/versionPruneScheduler.ts`

---

### `LORE_VERSION_PRUNE_SCHEDULE_DISABLED`

| | |
|---|---|
| **Default** | off (scheduled pruning enabled) |
| **Values** | `1` to disable |
| **Surface** | daemon (scheduled version-prune timer) |

Opt-out of the scheduled version-prune timer entirely, for an operator who
prunes on their own cadence. Only the exact string `1` disables it.

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
| **Default** | `1800000` (30 minutes) |
| **Surface** | daemon (LocalGraphRegistry) |

Idle-eviction threshold for cached workspace handles. Workspaces that have not
been accessed within this window are closed and their SurrealDB + LanceDB handles
released. Each open workspace consumes ~10–50 MB RSS; lowering this value
reduces steady-state memory on daemons that touch many workspaces.

Source: `src/engines/localGraphRegistry.ts`

---

### `LORE_REGISTRY_SWEEP_MS`

| | |
|---|---|
| **Default** | `600000` (10 minutes) |
| **Surface** | daemon (LocalGraphRegistry) |

Interval between background idle-workspace eviction sweeps. The sweep closes
handles idle longer than `LORE_REGISTRY_IDLE_TTL_MS`. Lower values keep memory
tighter at the cost of more frequent sweep overhead.

Source: `src/engines/localGraphRegistry.ts`

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
view's running count silently drifts low, permanently, with no self-healing.
Reproduced directly: 300 concurrent distinct-id upserts into one group left
the view at 63–64/300 while all 300 nodes were genuinely present. Serial
writes, or writers spread across distinct (project, type) groups, are
unaffected — `test/surreal-feature-matrix-unit.ts` pins that correctness.

Turn it on only if you can guarantee the workspace never receives
concurrent bulk writes into one (project, type) group, or don't rely on
`getStats().nodeCount`/`typeBreakdown` for anything correctness-sensitive:

- It **backfills**, so enabling it on a workspace that already has data is safe.
- It is maintained through inserts, group-key changes and deletes, including
  the engine's edge-then-node delete sequence — under SERIAL writes.
- Unlike `DEFINE INDEX`, it does **not** retain the store's directory lock, so
  the workspace can still be reopened.

Set `LORE_SURREAL_COUNT_VIEW=1` to enable. Set back to unset/`0` to roll
back — the view stays on disk and is simply not read; no migration and no
restart-with-cleanup is required either direction.

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
| `LORE_CLOUD_URL` | _(none)_ | Sync |
| `LORE_CLOUD_AUTH_TOKEN` | _(none)_ | Sync |
| `DATAPLANE_URL` | `http://localhost:8080` | Sync/Dataplane |
| `DATAPLANE_API_KEY` | _(none)_ | Sync/Dataplane |
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
| `LORE_VERSION_RETENTION_DAYS` | `90` | Maintenance |
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
| `LORE_RECALL_STAGE_TIMING` | off | Recall |
| `LORE_RECALL_RECENCY_HALF_LIFE_DAYS` | `30` | Recall |
| `LORE_RECALL_FANOUT_WS_CAP` | `50` | Recall |
| `LORE_RECALL_FANOUT_CONCURRENCY` | `8` | Recall |
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
| `LORE_IS_SEARCH_WORKER` | _(internal)_ | Search |
| `LORE_SEARCH_WEIGHT_TAGS` | `1` | Search |
| `LORE_LANCE_ADD_COLUMN_SUPPORTED` | `true` | DB Internals |
| `LORE_SEARCH_CACHE_TTL_MS` | `1500` | DB Internals |
| `LORE_DEFERRED_SCAN_CACHE_TTL_MS` | `60000` | DB Internals |
| `LORE_SEARCH_CACHE_MAX_ENTRIES` | `500` | DB Internals |
| `LORE_COMPACT_GRACE_MS` | `600000` (10 min) | DB Internals |
| `LORE_REGISTRY_IDLE_TTL_MS` | `1800000` (30 min) | DB Internals |
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
