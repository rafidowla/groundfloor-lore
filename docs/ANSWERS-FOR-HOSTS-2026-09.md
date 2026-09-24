# Answers for hosts — September 2026

Answers to the seven questions in `nirman-tapestry/docs/lore-asks/QUESTIONS-FOR-LORE.md`, measured
against Lore 3.19.1 and the 3.20.0 candidate. Machine: darwin-arm64 (macOS 26.5), Node 22.23.2,
`@surrealdb/node` 3.0.3, `@lancedb/lancedb` as pinned in `package.json`. Every number comes from
`docs/PERFORMANCE-MEMORY.md` (section cited), which also gives the command that reproduces it.
Where the honest answer is "measured: no", this document says so.

**The short version.** Your working assumptions were right on Q1–Q3. Closing a store gives back its
vector-store and SQLite memory. It does **not** give back SurrealDB's, and it does not give back the
embedding model's. For those two, process exit is the only complete cure. So idle exit (or a
disposable child process) belongs first in your design, ahead of in-process eviction.

---

## Q1. Does `close()` actually return native memory to the OS?

**Measured: it depends on the substrate. Two of the four return nothing.**

| Substrate | Returns memory on close? | Evidence |
|---|---|---|
| LanceDB vector store | **Yes** | 50 open→write→close cycles, flat: −0.11 MB/cycle, 374 → 277 MB (§10.1). Also flat without forced GC (§8.4). |
| SQLite sidecars | **Yes** | File counts flat across every configuration (§8.2). |
| Search-worker child (`LORE_SEARCH_WORKER=1`) | **Yes** | The child is killed on close. 0 live children, 0 zombies at every sample over 50 cycles (§3, §10.1). |
| SurrealDB graph | **Measured: no** | **+100 MB per open**, R² = 1.000, including a reopen of the same directory. 3 files (WAL + SSTable) stay open per open. Live allocations with 0 % fragmentation, not allocator retention. The leak is in `@surrealdb/node` 3.0.3; Lore's close is correct. Nothing short of process exit returns it (§9). |
| ONNX embedding model | **Measured: no** | Load + 200 embeds: +540–570 MB. After `releaseLocalEmbeddingPipeline()` + GC, RSS does not drop; it rises ~50 MB while the JS heap falls. Reloading afterwards costs ~17 MB more (§10.3, 3 clean runs). |

**What this means for your design:**
- **Per open workspace**, the resident cost is roughly **~100 MB of SurrealDB + ~7 MB of LanceDB**.
  - That is consistent with Atlas's ~145 MB per workspace.
  - The measured LanceDB cost is 6.75 MB per store at the default read-pool size, or 5.73 MB with `role: 'write'` (§10.2).
- **Evicting the graph half in-process is net-negative on this driver.** A store kept open costs ~100 MB once; each evict-and-reopen costs another ~100 MB, without bound.
- **Evicting the vector half is net-positive.** In 3.20.0 it is automatic in the daemon and callable from an embedded host (below).
- **Releasing the embedding model buys nothing in-process.** Idle-unload ships in 3.20.0, but it is off by default for exactly this reason.
- **Your plan stands:** idle exit first, per-store eviction second. The only other route to reclaiming the graph and model memory is to host them in a disposable child process (see "What Lore will do next").

**What 3.20.0 gives you here:**
- `lore._daemon.getVerbatimResolver()` exposes `evictIdle(nowMs, idleMs)`, `closeWorkspace(name)` and `openCount()`. This is your ask 1.
  - A store with queued embed or outbox work is never evicted.
  - A later `getOrOpen` reopens the store transparently.
- The daemon runs its own sweep, set with `LORE_VERBATIM_IDLE_TTL_MS` / `LORE_VERBATIM_SWEEP_MS`. Embedded hosts drive eviction themselves.
- Measured: open vector stores stay flat at 1 over 50 workspace cycles; before, they grew by one per workspace touched (§10.1).
- `VerbatimStore.close()` now closes the LanceDB connection and write table deterministically, rather than waiting for GC.
  - It first waits for in-flight writes. If a write is still stuck after 5 s, it leaves that store's handles open rather than risk a crash.
  - Kill switch: `LORE_VERBATIM_NATIVE_CLOSE=0`.
  - Stress test: 900 close-during-write races, 0 crashes.

## Q2. What does SurrealDB's unclean-shutdown recovery cost in RSS?

**Measured, at small scale: almost nothing.** We opened a store with 3,000 nodes and 5,997 edges
(a ~6 MB WAL) for the first time after a clean close, and again after a `SIGKILL` mid-write.

| | Peak RSS on first open |
|---|---|
| After a clean close | 134.1 MB |
| After a `SIGKILL` mid-write | 141.9 MB |
| Difference | **+7.8 MB** (about 1.3× the WAL) |

The ~1000×-WAL blow-up in `SURREALDB_PHASE6.md` belonged to the removed graph engine. It does not
happen on SurrealDB (§4).

**Not measured:** WALs larger than ~6 MB. A 12,000-node run timed out during the write phase.
Run `scripts/measure-surreal-unclean-open.mjs` at your real store sizes before you ship aggressive
idle exit. At the size we could measure, an unclean exit is not dangerous.

## Q3. Does `@surrealdb/node@3.0.3` accept any memory parameter at all?

**Partly. The addon reads memory-related environment variables. The two most plausible ones do not
change the per-open cost we measured.**

- **What exists:**
  - Lore passes no connect options. The addon has no option object for memory.
  - The native binary does read process-wide `SURREAL_*` environment variables (found by string scan), including:
    - `SURREAL_SURREALKV_BLOCK_CACHE_CAPACITY`
    - `SURREAL_ROCKSDB_BLOCK_CACHE_SIZE`, `SURREAL_ROCKSDB_WRITE_BUFFER_SIZE`, `SURREAL_ROCKSDB_MAX_OPEN_FILES`
    - `SURREAL_DATASTORE_CACHE_SIZE`, `SURREAL_TRANSACTION_CACHE_SIZE`, `SURREAL_HNSW_CACHE_SIZE`
- **Measured:**

| Setting | Leak per open |
|---|---|
| Default | ~100 MB (surrealkv) |
| `SURREAL_SURREALKV_BLOCK_CACHE_CAPACITY` = 8 MiB | 97.9 MB (no change) |
| `SURREAL_SURREALKV_BLOCK_CACHE_CAPACITY` = 32 MiB | 97.7 MB (no change) |
| `SURREAL_ROCKSDB_WRITE_BUFFER_SIZE` = 8 MiB | 64.7 MB, the rocksdb default (no change) |

  The other variables are **not measured**.
- **So your assumption holds in practice:** there is no knob that caps a store's graph memory, and
  §3.10 item 3 cannot be reached by configuration.
  - The routes are the lite storage profile (your ask 2, deferred below), or hosting SurrealDB in a child process.
  - We have drafted an upstream report for SurrealDB with a minimal repro. Its filing is pending the owner.

## Q4. Is two-process LanceDB read/write on one directory safe?

**Measured: safe for data integrity. Not safe for read freshness.** A long-lived reader in
another process does not see new commits until it reopens (§12).

Setup: separate Node processes on one `VerbatimStore` directory, 2 minutes of continuous traffic in
each scenario.

| Scenario | Result |
|---|---|
| One writer + one reader, table already exists when the reader opens (§12.4) | Writer: 9,480 / 9,480 writes succeeded; 0 errors, 0 torn rows. **The reader's `count()` stayed frozen at 165 for all 2,147 samples. A row written after the reader opened was never found by `getById`.** A fresh handle opened at the end saw the rows and the target immediately. Final count 9,480 = acknowledged. |
| Two concurrent writers (§12.2) | 11,345 / 11,345 succeeded; final count exact. The 2-minute run had 0 conflicts. A 4-second smoke run hit 2 *non-fatal* index-build commit conflicts (the index build is skipped that cycle; rows are unaffected). |
| Reader opened on an **empty** directory before the writer created the table (§12.1) | The reader never discovers the table and returns 0 / empty for its whole life. |

**Why it happens:** `VerbatimStore` reads `count()` and `getById()` through a table handle
opened once at `initialize()`, and never refreshes that handle with `checkoutLatest()`. The pooled
search handles do refresh. Within one process this is invisible, because the writer is the same
handle.

**What this means for you:**
- Your assumption that one process owns a given store's vector handles at a time is the right one to build on.
- A "parent writes, pooled worker reads" split works for integrity, but the reading process must reopen, or be told to reopen, to see new writes. As it stands, it is not a live view.
- That makes asks 3 and 4 fit together as "write-only in one process, reopen-on-signal in the other". Asking Lore to add a refresh-on-read option would be a small, reasonable follow-up.

## Q5. Are `@surrealdb/node`'s prebuilt binaries Node-API or ABI-locked?

**Node-API. The Node 22 pin does not come from SurrealDB.**

- The darwin-arm64 binary exports `napi_register_module_v1`.
- The same file loaded and completed a real `surrealkv://` write and read on **Node 20.20.2** (ABI 115) and **Node 22.23.2** (ABI 127).
- Lore's `scripts/ensure-surreal-native.mjs:20-23` comment is wrong about this addon. It is corrected in 3.20.0.
- Across Lore's native dependencies:

| Dependency | Kind | Tied to one Node version? |
|---|---|---|
| `@lancedb/lancedb` | Node-API (exports `napi_register_module_v1`) | No |
| `onnxruntime-node` | Ships in a `napi-v6` directory | No |
| `better-sqlite3` | Classic addon (exports `node_register_module_v127`) | **Yes** |

- So the binding constraint is `better-sqlite3`. The `engines.node: ">=22 <23"` pin remains Lore's support policy; SurrealDB does not require it.

## Q6. Which Node majors have published `better-sqlite3@12.10.0` prebuilts?

**Node 22, 24, 25 and 26. Not Node 20 or Node 23**, even though the package's `engines` field
declares both.

- Source: the v12.10.0 GitHub release assets (131 files).
- ABIs covered: 127 (Node 22), 137 (Node 24), 141 (Node 25), 147 (Node 26).
- Each is published for darwin arm64/x64, linux x64/arm64/arm, linuxmusl x64/arm64/arm, and win32 x64/arm64.

**So:**
- On Node 22, which Lore pins, every mainstream platform gets a prebuilt and never needs `node-gyp`.
- A compile fallback happens only on Node 20 or 23, or on an unlisted platform (e.g. FreeBSD). Your installer check only needs to catch those.

## Q7. Does transformers.js v4 forward `session_options` to onnxruntime-node?

**Yes, in the version Lore ships (`@huggingface/transformers` 4.2.0).**

- The path, in `dist/transformers.node.mjs`:
  1. `pipeline(task, model, { session_options })` passes it to `from_pretrained`.
  2. `getSession` copies it: `const session_options = { ...options.session_options }` (~l. 22403).
  3. `createInferenceSession` spreads it into `InferenceSession.create(..., { logSeverityLevel, ...session_options })` (~l. 11649-11656).
- **So ask 7's conduit premise is correct.** Lore does not pass `session_options` today; `loadPipeline` sets only `device` and `dtype`.
- **Whether turning the CPU arena off shrinks retained memory is not measured.** Q1 shows a release keeps essentially all of the model's memory, which makes the arena a plausible contributor. Ask 7 stays deferred but is worth one measurement before you withdraw it.

---

## Where your asks stand in 3.20.0

| # | Ask | 3.20.0 |
|---|---|---|
| 1 | Idle eviction for `WorkspaceVerbatimResolver` | **Shipped.** `evictIdle` / `closeWorkspace` / `openCount`, `getVerbatimResolver()` on `_daemon`, daemon sweep, pending-work guard. |
| 3 | `role: 'read' \| 'write' \| 'both'` | **Shipped.** `CreateLoreOptions.vectorStoreRole` (value or `(basePath) => role`). Write-only stores hold 2 native handles instead of 18; searching one falls back to the write handle rather than failing. |
| 5 | Per-store `searchWorkerPolicy(basePath)` | **Shipped.** Consulted before `LORE_SEARCH_WORKER`. A policy that throws falls back to the env gate. |
| 6 | Idle-unload for the embedding pipeline | **Shipped, off by default** (`LORE_EMBED_IDLE_UNLOAD_MS`, `releaseLocalEmbeddingPipeline()`). As Q1 shows, it frees the cache entry but not the memory. |
| — | Injected embedding provider (from this sprint's brief) | **Shipped.** `CreateLoreOptions.embeddingProvider`. A child store with an injected provider never loads the model: 527 MB vs 1,047 MB (§10.4). With an injected provider, a mismatch of model, dimension or dtype against an existing store is refused before any write. |
| 2 | `storageClient` / `storageFactory` injection, lite profile | **Deferred.** Larger and riskier; not needed for the memory work to start. Q3 now makes it the main in-process route to a small graph. |
| 4 | Injectable `vectorStoreFactory` / pooled worker | **Deferred.** Same reason. |
| 7 | ONNX `sessionOptions` pass-through | **Deferred.** Speculative. Q7 confirms the conduit exists; the payoff is unmeasured. |
| 8 | `AbortSignal` on `bulkIngest` / `nodeUpsertBatch` | **Deferred.** Concerns peak ingest, not steady state. |

## What Lore will do next (proposed, pending the owner)

- Host SurrealDB, and optionally the embedding model, in a disposable child process, the same way search already can be. This is the only in-process-host route to "zero resident when idle".
- File the SurrealDB upstream report.
- Decide whether the graph registry should keep evicting by default, given Q1.
