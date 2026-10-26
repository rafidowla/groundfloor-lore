# Ingestion coordinator (slice 1)

Status: slice 1 implemented on branch `feat/ingestion-coordinator` (worktree `wt-ingest-coord`), unreleased.
Code: `packages/lore/src/ingestion/`. Tests: `test/ingestion-{core,adapters,coordinator}-unit.ts`.

## Decision (Rafi, 2026-10-23)

Extraction is not the database's job. Lore stores, indexes, links and coordinates. Separate processors turn
files into text (contract A) and text into structured fields (contract B). Each processor has a local
(sovereign) engine as the default; hosted engines are opt-in per workspace. One embedding model for everything.

## Contracts

- A, `extract.v1`: `ExtractRequest` (file bytes or a signed file URL, mime type, hints) -> `ExtractResult`
  (`chunks[]` of text with optional `page` / `timestampSec`, `format`, processor id + engine version).
- B, `structure.v1`, shaped like Structuring V2: `StructureRequest` (text, schema/hints, `itemPath`) ->
  `StructureResult` with `content` plus `annotations.items[]` (per item `source_page`, `source_quote`,
  `quote_verified`, `confidence {score, level, reasons}`, `needs_review`) and `rejected[]`.
- Both carry a version string; `contractMajor()` rejects a major mismatch. A processor returns
  `ProcessorOutcome<R>` or throws `ProcessorError {retryable}`.
- `ProcessorInfo {id, kind, locality: local|hosted, version}` is what policy checks and provenance record.

## Jobs

- `ingest_sources`: one row per (workspace, sha256). Bytes live in an `IBlobStore` (`FsBlobStore`); the row
  holds a reference. Re-uploading identical bytes returns the same source.
- `ingest_jobs`: deterministic job id = f(workspace, source, stage, processor, params), so enqueue is idempotent.
  States: `queued -> running -> awaiting_callback | succeeded | queued (retry) | dead_letter`.
  Backoff 5 s base, 15 min cap; `maxAttempts` default 5; `requeueDeadLetter` is an operator action.
- A structure job is chained after extract success (`parentJobId`), taking the extracted text as input.
- `reapStale(maxAge)` re-queues `awaiting_callback` jobs whose processor never called back.
- `ingest_pending`: structured results that could not be written (no table storage, or additive evolution
  impossible). Recorded, never dropped or force-fit.
- `ingest_deliveries (job_id, delivery_id)`: replay guard for callbacks.

## Workspace policy

`local-only` (default) | `hosted-allowed`. Enforced three times: when selecting a processor / at enqueue
(throws `PolicyViolationError`, nothing is recorded), at dispatch (job fails permanently, no request leaves
the process), and at callback (403, permanent failure, results discarded). Flipping a workspace back to
`local-only` therefore stops in-flight hosted work. A local structurer that declares locality `local` must use
a loopback URL unless `allowNonLoopback` is set, so "local" cannot silently mean a remote host.

## Processors

- `LocalExtractProcessor`: wraps Lore's in-process extractors (`buildDefaultRegistry().extract`); output is
  equivalent to current behaviour (tested). Extractors are still in-process; moving them is slice 2.
- `AiApiExtractProcessor` (hosted): async submit with `callback_url` + per-job bearer; result arrives by callback.
- `StructuringV2Processor` (hosted): async submit; Standard Webhooks signed callback. The request field that
  carries the text is configurable because it is not documented.
- `LocalStructureProcessor`: any OpenAI-compatible `/chat/completions` base URL (config only), JSON output,
  every item flagged `needs_review` because a local model cannot verify its own quotes.
- Registry: `selectExtract` prefers local; hosted only if policy allows and no local processor supports the mime.
- Outbound HTTP: origin allowlist from config (SSRF), `redirect: 'manual'` (redirects are refused), timeout,
  capped response size, 4xx permanent / 5xx + 429 retryable.

## Callback endpoint

`POST /api/ingest/callback/<jobId>`, served by `createCallbackServer(coordinator)` / `routeCallback(...)`.

- Schemes: `lore-hmac` (HMAC-SHA256 over `jobId.timestamp.rawBody`, key derived per job from a master secret of
  at least 32 bytes), `standard-webhooks` (shared secret, `webhook-id/timestamp/signature`), `bearer`
  (per-job token derived from the master secret).
- Raw wire bytes are verified before any parsing. Constant-time compare. Timestamp must be within the replay
  window (default 300 s, both directions). Unknown job, missing scheme, and bad credentials all return the same
  401. Job binding: per-job key/token for `lore-hmac` and `bearer`; for `standard-webhooks` (shared secret)
  binding is the URL job id plus a check that the body `requestID` equals it, so a message for job A cannot
  complete job B.
- Bodies: 8 MB wire cap (413), optional gzip with a 64 MB decoded cap, bad JSON 400 (permanent failure).
  Terminal job -> 200 `duplicate_ignored`. Processor-reported error -> 200 `failure_recorded` (retry or dead-letter).
- Not mounted in the main HTTP dispatcher on purpose: its gate chain (localhost Host check, Lore bearer,
  cloud workspace header) cannot admit an external processor. Hosting decision needed: dedicated port, or a
  narrowly scoped gate exemption for this one path. Weakening the gauntlet was rejected.

## Results

- Text: chunks go through `LoreInstance.nodeUpsert` (via `loreMemoryPort`, `asyncEmbed: true`), type
  `document_chunk`, deterministic node id from (job, index), so they flow into embedding and autolinking.
  `metadata.ingestion` holds sourceId, file name, jobId, page/timestamp, processor id/locality/version.
- Structured: `writeStructuredFields` -> table `ingest_<name>` through `ITableStorage` (additive evolution only),
  one row per item, provenance columns `_source_id _source_file _source_page _source_quote _processor
  _processor_version _job_id _confidence_level _needs_review` and `_field_confidence`. Job rows are
  delete-then-insert, so a retried write or a duplicate callback cannot double rows. Schema choice is mechanical
  here; the Agentic DBA owns it in slice 2.

## Postgres lane

Built (`engines/postgres/postgresIngestionStore.ts`, schema in `postgresIngestionSchema.ts`, selection in
`ingestion/storeFactory.ts`):

1. `PostgresIngestionStore` implements `IIngestionStore`. Tables `lore_ingest_sources|jobs|pending|deliveries`
   (prefixed so they cannot collide with a user's `ingest_<profile>` structured tables), JSONB for `params`,
   `result`, `payload`, TIMESTAMPTZ for times, `workspace_id` on every table and in every statement. A store is
   bound to one workspace (the port methods carry no workspace); a write naming another workspace throws.
2. Atomic `claimDue`: one statement, a MATERIALIZED CTE `SELECT ... FOR UPDATE SKIP LOCKED LIMIT n` joined into
   the `UPDATE ... RETURNING *`. A plain `job_id IN (subquery LIMIT n)` was tried first and over-claimed under the
   planner's nested-loop plan; do not "simplify" back to it.
3. Unique constraints: `job_id` (PK), `(workspace_id, sha256)`, `(job_id, delivery_id)`, `pending.job_id`.
   Idempotent writes use untargeted `ON CONFLICT DO NOTHING` (a targeted one misses the second unique index and
   raises under concurrency) plus read-back.
4. `markSucceeded` applies to non-terminal rows only; `recordFailure` locks the row (`FOR UPDATE`) and ignores
   terminal jobs. `recordDelivery` and `recordPending` refuse a job that is not in the bound workspace.
5. Schema goes through the shared pool and `runSchemaBootstrap` (advisory-locked, idempotent). No new pool.
6. `createIngestionStore` picks the store from `resolveWorkspaceGraphEngine`; a postgres workspace with
   `LORE_PG_URL` unset throws (no SQLite fallback).
7. Retention: `purgeOldDeliveries(now, { retentionDays, limit })` on both stores deletes `deliveries` rows older
   than `LORE_INGEST_DELIVERY_RETENTION_DAYS` (default 30) in batches of at most 5000. The daemon's ingestion host
   calls it on a timer (`LORE_INGEST_PURGE_INTERVAL_MS`); a different embedding host calls it itself.

Still needed for the full Postgres lane:

- An `ITableStorage` for Postgres reachable through `TablePort.forWorkspace` (`createTable`, `evolveSchema`
  additive, `insertBatch`, `delete(filter)`, `query`). Until it exists the coordinator records structured results
  as pending, which is the intended degraded mode.
- Retention for blobs of terminal sources, and a shared `IBlobStore` (object store) for multi-node cloud;
  `FsBlobStore` is single-host.

## Not done / follow-ups

- Callback listener: decided and built. Hosted callbacks arrive on a SEPARATE listener (own port, 127.0.0.1 by
  default, signed job reports only, per-IP rate and concurrency caps, header/request timeouts), never on the main
  dispatcher, whose gate chain is unchanged. It opens only when configured AND a hosted processor is configured.
  A processor still needs a reachable public URL (`LORE_INGEST_CALLBACK_PUBLIC_URL`, i.e. `callbackBaseUrl`).
  See `docs/CONFIGURATION.md` section 11a.
- Memory writer is tested through a fake `nodeUpsert`, not a real `LoreInstance` (needs the embedding model).
- A write failure after a callback re-queues the job; a hosted processor may then be re-submitted (cost, not
  correctness; ids are deterministic so nothing duplicates).
- Extractors stay in-process (slice 2: worker process). Agentic DBA schema choice (slice 2). Media embeddings out.
- Scheduler and boot wiring are done for the daemon (`src/ingestion/ingestionHost.ts`, boot step
  `src/mcp/ingestionBoot.ts`): `runDue`, `reapStale`, `reclaimStuck` and `purgeOldDeliveries` run on unref'd,
  non-overlapping timers; stuck `running` jobs are reclaimed at boot and periodically (lease + heartbeat, atomic,
  multi-process safe; at-least-once). HTTP daemon mode only.
- No hosted EXTRACTOR is registered by the daemon (`AiApiExtractProcessor` needs a `fileUrlFor` the daemon does not
  have); only the hosted structurer drives the callback listener.
- `completeExtract` is not atomic: `markSucceeded` and creation of the chained structure job are separate calls.
- Blobs live on local disk (`<workspace>/ingestion-blobs`) even for Postgres workspaces: single-host until a shared
  object store exists. With no Postgres `ITableStorage`, structured results are recorded as pending.
- Not wired to a CLI/REST/MCP surface.

### Open items: blob retention and Groundfloor blob store (lane d5, 2026-10-24)

- Retention is a sweep on the existing purge tick, OFF unless `LORE_INGEST_BLOB_RETENTION_DAYS` is set. It claims
  eligible sources atomically (marks `blob_purged_at`), deletes the blob, and releases the mark if the delete fails.
  There is no `cancelled` job state, so "terminal" means succeeded, failed or dead_letter. `dead_letter` can be
  requeued by an operator, so a purged dead-lettered job fails permanently with "upload the file again" until the
  file is re-uploaded.
- A re-upload creates no new job (job ids are deterministic), so a re-uploaded, already-finished source becomes
  eligible again at the next sweep once its old completion time is past the window. Restoring is for re-running or
  re-reading, not a new retention clock.
- In-process enqueue and sweep are serialised by a mutex. Across processes sharing one database there is a narrow
  window where a sweep can delete a blob an enqueue just reused; the affected job then fails permanently with a
  clear re-upload message. No cross-process lock was added.
- Groundfloor Files API contract was taken from the installed `gf` CLI 0.2.5 source, not the live service, and the
  real endpoint was never called. Unverified: server-side size limit, token type and lifetime (builder vs M2M),
  finalize semantics, whether `name` accepts arbitrary strings (Lore sends `lore-ingest-<workspace hash>-<sha>`).
  Presigned URL hostnames are not pinned against DNS rebinding (IP literals are checked).
- `put` on the Groundfloor store is not idempotent (each call makes a new object), so the coordinator reuses a
  source's existing blob reference when `has` is true.

