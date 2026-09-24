# Lore 3.20.0 — response to `../nirman-tapestry/docs/lore-asks/`

This note answers every ask nirman-tapestry filed in
`../nirman-tapestry/docs/lore-asks/` (read-only — nothing in that repo was
changed to write this note) against what actually shipped in Lore 3.20.0.
One line per ask: **SHIPPED** or **DEFERRED**, the API name, and why.

For the seven measurement questions in
`../nirman-tapestry/docs/lore-asks/QUESTIONS-FOR-LORE.md` (Q1-Q7), the full
answer set — with numbers, evidence, and reproduction commands — is in
`docs/ANSWERS-FOR-HOSTS-2026-09.md`, not repeated here. This file is
ask-status only.

## Ranked asks (`docs/lore-asks/README.md`'s table)

| # | Ask file | Status | API | Why |
|---|---|---|---|---|
| 1 | `LORE-ASK-VERBATIM-IDLE-EVICTION.md` | **SHIPPED** | `WorkspaceVerbatimResolver.evictIdle(nowMs, idleMs)` / `.closeWorkspace(name)` / `.openCount()`, reached via `lore._daemon.getVerbatimResolver()`; `LORE_VERBATIM_IDLE_TTL_MS` / `LORE_VERBATIM_SWEEP_MS` | Exactly the ask: a workspace's LanceDB handles are now released when it goes quiet. A store with queued embed/outbox work is never evicted; a later access reopens transparently. Measured flat at `openCount`=1 across 50 workspace cycles where it previously grew unbounded (`docs/PERFORMANCE-MEMORY.md` §10.1). Note for an embedded host specifically: the daemon's own background sweep only runs for a process that owns it (`ownsProcess: true`) — an embedded host must call `evictIdle` itself on its own cadence. This is architectural, not a gap in this release. |
| 2 | `LORE-ASK-STORAGE-CLIENT-INJECTION.md` | **DEFERRED** | `CreateLoreOptions.storageClient` / `storageFactory` (not added) | Larger and riskier than the rest of this sprint's scope; not needed for the memory work to start. `docs/ANSWERS-FOR-HOSTS-2026-09.md` Q3 (no reachable SurrealDB memory knob exists) makes this ask's "lite storage profile" the main remaining in-process route to a small graph store — still the right long-term direction, just not this release. |
| 3 | `LORE-ASK-VECTOR-STORE-ROLE.md` | **SHIPPED** | `CreateLoreOptions.vectorStoreRole?: VerbatimStoreRole \| ((basePath: string) => VerbatimStoreRole)`, type `VerbatimStoreRole` now re-exported from the package root | A write-only open (`role: 'write'`) holds 2 native handles instead of 18 (no read pool); `search()` on a write-only store falls back to the write handle instead of throwing. Measured: `handleCount()` confirms 18 vs. 2 exactly (§10.2). |
| 4 | `LORE-ASK-VECTOR-STORE-FACTORY.md` | **DEFERRED** | Injectable `vectorStoreFactory` / pooled search worker (not added) | Same reasoning as ask 2 — this ask's own README entry flags it as the largest of the eight ("five `instanceof VerbatimStore` narrowings must be relaxed"); deferred rather than rushed into this sprint. |
| 5 | `LORE-ASK-SEARCH-WORKER-POLICY.md` | **SHIPPED** | `CreateLoreOptions.searchWorkerPolicy?: (basePath: string) => boolean` | Consulted before the global `LORE_SEARCH_WORKER` env gate, so small/large stores can be split without a process-wide flag. A policy function that throws falls back to the env gate rather than failing the store open. |
| 6 | `LORE-ASK-EMBED-IDLE-UNLOAD.md` | **SHIPPED, off by default** | `LORE_EMBED_IDLE_UNLOAD_MS` (default `0` = never unload), `releaseLocalEmbeddingPipeline()` | Ships exactly as asked, but read the caveat: `docs/ANSWERS-FOR-HOSTS-2026-09.md` Q1 measured that releasing frees the JS-side cache/heap but returns **approximately zero RSS** (§10.3 — RSS rose slightly across every measured release, across 3 clean runs). It is off by default for exactly this reason — shipped for cache-correctness value (a reload provably starts clean), not as a memory win. |
| 7 | `LORE-ASK-ONNX-SESSION-OPTIONS.md` | **DEFERRED** | `sessionOptions` pass-through into `pipeline()` (not added) | The ask itself was filed as explicitly speculative pending verification. `docs/ANSWERS-FOR-HOSTS-2026-09.md` Q7 confirms the conduit exists in the shipped transformers.js version (`session_options` does forward to `InferenceSession.create`), but whether turning off the CPU arena actually shrinks retained memory was not measured this sprint — worth one measurement before nirman-tapestry decides whether to keep or withdraw this ask, per its own stated condition. |
| 8 | `LORE-ASK-CANCELLATION-SIGNAL.md` | **DEFERRED** | `signal?: AbortSignal` on `bulkIngest` / `nodeUpsertBatch` (not added) | Concerns peak-ingest cancellation, not the steady-state memory footprint this sprint targeted. `BulkIngestOpts.shouldAbort` (the existing predicate-based mechanism this ask's own README correction identified) is unchanged and still the way to cancel a running `bulkIngest`. |

## Ask filed outside the ranked table

| Ask file | Status | API | Why |
|---|---|---|---|
| `LORE-ASK-VECTOR-CLOSE-AWAIT.md` | **SHIPPED** | `VerbatimStore.close()` (no signature change — the fix is internal) | This is the ask that answers `QUESTIONS-FOR-LORE.md` Q1 most directly: `close()` previously drained the 16-handle read pool but only *dereferenced* the write `Table` and the `Connection` (0.7 MB of ~145 MB actually returned, per the ask's own Atlas measurement). 3.20.0 calls `.close()` on both remaining handles — synchronous, idempotent, individually try/caught so one failure can't strand the other — exactly matching the ask's proposed patch, plus a write-drain (waits up to 5 s for an in-flight write before closing) the ask's acceptance criteria implied but did not spell out as a race guard. Kill switch `LORE_VERBATIM_NATIVE_CLOSE=0` reverts to the pre-fix dereference-only behaviour. Stress-tested at 900 close-during-write races, 0 crashes. **This is the one default-on behaviour change in 3.20.0** — every other new option in this release defaults to 3.19.1 behaviour. |

## Shipped but not filed as an ask

`CreateLoreOptions.embeddingProvider` (host-injected `EmbeddingProvider`,
with a strict fingerprint refusal via the new
`EmbeddingFingerprintMismatchError` when an injected provider's model
id/dtype fingerprint doesn't match an existing store's) shipped this sprint
from a separate brief, not from a filed `lore-asks/` file. Noted here only
because it changes what "no local ONNX model load" costs for a host that
wants it: measured 527 MB vs. 1,047 MB RSS for the same workload not
loading vs. loading the local model (§10.4). Not relevant to adopt unless
nirman-tapestry's daemon plans to supply its own embedding provider.

## Bottom line for nirman-tapestry's design

- **Q1's headline finding stands even after the fix above**: closing a
  LanceDB-backed store now returns its memory; closing a SurrealDB-backed
  one still does not, and cannot from inside Lore (§9). Your working
  assumption — idle exit / process boundary first, in-process eviction
  second — was correct, and 3.20.0 does not change that conclusion for the
  graph half.
- **Two-process LanceDB (Q4)**: safe for data integrity, not safe for read
  freshness — a long-lived reader in another process never sees a
  concurrent writer's new commits without reopening (§12.4). This confirms
  your "one process owns a given store's vector handles at a time"
  assumption; a "write-only in one process, reopen-on-signal in the other"
  split is the pattern this release's measurements support, not a live
  shared-read view.
- **ABI (Q5)**: confirmed Node-API, not ABI-locked — the same
  `@surrealdb/node` binary ran on both Node 20.20.2 and 22.23.2. Lore's own
  `scripts/ensure-surreal-native.mjs:20-23` comment that claimed otherwise
  was wrong and is corrected in 3.20.0. `better-sqlite3` is the actually
  ABI-specific native dependency across Lore's own native deps (Q5/Q6 detail
  which Node majors have published prebuilts).

See `docs/ANSWERS-FOR-HOSTS-2026-09.md` for the full measured answer to
every one of Q1-Q7, with reproduction commands, and
`docs/PERFORMANCE-MEMORY.md` §9-§12 for the underlying raw measurements.
