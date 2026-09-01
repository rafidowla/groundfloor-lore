# Lore Core — roadmap + next implementation plan (follow this)

**Audience:** a coding model that should not invent architecture.  
**Repo:** `groundfloor-lore/` only. Do not edit Atlas, Kindling, lore-app, or plugins.  
**Goal:** finish in-scope database work. Lore stays useful for a normal HTTP/SDK app with no agent, and stays the governed store agents operate.

**Corrected 2026-08-30, three passes.** Pass 1 cross-checked the roadmap and this plan against live source (CHANGELOG, ROADMAP.md, actual code) and fixed the schema-safety scope item, WP1.2's file-size collision, and WP3's incorrect "load-job cancel already exists" claim. Pass 2 caught two mistakes pass 1 introduced itself (a wrong `DEC-SURREAL-SCAN-FIX` note in WP5 — that decision exists in `DECISIONS.md`, restored and corrected) and closed a gap pass 1 missed: WP3's rollback rule didn't explicitly cover a cancel landing mid-embed, the actual outage scenario this WP exists to prevent (fixed there, plus its split into 3a/3b). Pass 3 fixed three places where pass 2's prose correction didn't make it into the copyable code/text next to it (WP1's `runTransaction?` still had the `?`, the PR-sequence list still showed one un-split WP3 line, WP5's "Done when" still said "hydrate-column patch") and added two design points pass 2 missed entirely: cancel of a **pre-existing** id must restore its prior version, not hard-delete it (hard-delete is only correct for ids created in this same call — see WP3's rollback rule), and chunked embedding with a "write the finished prefix, roll back the rest" path doesn't exist in the code today and has to be built as part of 3a, not assumed. Every `> **Corrected**` callout below is live guidance, not history — read them as part of the instructions, not as a changelog.

Locked product rules (do not reopen):

- No raw SQL at the public API. Closed JSON grammar only. Translate to parameterized SQL inside adapters.
- No auth product, blob store, functions, chat UI, plugin system, or live-push/realtime.
- Do not implement a Postgres/Dataplane table adapter in this cycle. Local SQLite only. Leave a typed hook so cloud can match later.
- Do not add UI in this repo.

Authority for table work: `docs/post_v2_plan.md` Q1.10 then Q1.11 (locked 2026-08-26).  
Authority for Stop: Atlas `docs/ROADMAP.md` item “Lore cooperative cancellation” (2026-08-30).  
If this file and those two disagree, **those two win** — stop and ask.

---

## Scope (do next / later / drop)

A database, not a chat product. A regular app should store rows, documents, and links — search, count, change them — with no agent in the picture. An agent uses that same store, plus: change a decision without erasing history, and change the shape of the data only with approval. If an item only helps one side of that, it's too narrow or belongs in another product.

### Do next (in scope)

| Work | Who it serves | Status |
|---|---|---|
| All-or-nothing table writes (WP1) | Regular apps first; agents get the same safety on related-row writes | Not started — this plan, WP1 |
| Richer table questions — boolean filters, 2–3 hop joins (WP2) | Regular apps query like a normal DB; agents ask structured questions, no raw SQL | Not started — this plan, WP2 |
| Stop button for work that won't finish — saves, bulk loads, search-memory writes (WP3) | Any client that times out. Atlas already walks away; Lore must actually stop | Not started — this plan, WP3 |
| Build search indexes on write, not only on restart (WP4) | Same store for apps and agents; hygiene, not a speed miracle | Not started — this plan, WP4 |
| Find where lookups actually spend time, then fix that stage (WP5) | Everyone who reads; measure before guessing | Done 2026-08-30 — hydrate is not the cost; stop (see WP5) |
| Bulk ingest log noise — conflict retries logged as ERROR (WP6) | Anyone reading logs during a large load; false alarm, not data loss | Small — this plan, WP6. Its own tiny PR; do not fold it into WP3 just because both touch bulk ingest |

> **Corrected:** the original roadmap draft carried a 6th "do next" item — "finish schema-change safety on the current graph engine (backup before a destructive change, then migrate)." **This already shipped** in v3.16.0 (2026-08-22, per CHANGELOG): the schema-safety subsystem is fully engine-agnostic and no longer refuses to run against a SurrealDB-backed workspace. Verified in source — `assertKuzuGraphSubstrate` only survives in stale comments. It's moved to "Already done" below. WP0 exists specifically to have you re-verify this on the live tree before you build anything else, rather than take this correction on faith.

### Later — or trim the ambition

| Item | How to keep it in scope |
|---|---|
| Cloud / hosted tables (Postgres behind the same API) | Same product, bigger machine. After local table work, not a second database product |
| Turn prose into structured rows (extraction) | Ingest helper into tables/graph only. Do not turn Lore into "it figures out your files" — that's the app's job |
| Simpler read verbs (lookup / find / count / trace) | Helps both a curl-using app and an agent. Do not reshape APIs in a launch crunch |
| High-frequency sensor ingest / live push | Parked. Note: one existing client is an IoT vendor, so this stays on the long-range radar rather than fully closed — no active demand pulling it forward now |

### Do not put back on the Lore Core list

| Leave in other products | Why |
|---|---|
| Plugin system, plugin wizard, in-engine "workspace templates" | Removed from Core (v3.11.0). Vocabulary belongs in the app that uses Lore |
| Chat canvas, charts in the engine, "semantic zoom" globe UI | UI product, not a database. Lives in the Lore app if at all |
| Raw SQL at the public API, login/auth product, file/blob store, serverless functions | Already ruled out. Other platform pieces cover those |
| Loom / Digital Employee as a Lore feature | A consumer of Lore, not part of Lore. Lore must work with no agent product installed |
| Auto-discover new entity types inside the database ("MA2") | That's an application brain. Agentic DBA means: evolve schema under your rules, with history and human gates — not invent the business model |

### Already done (do not re-litigate)

Typed tables with counts/sums. Dangerous schema changes in embedded mode now refuse honestly instead of hanging. REST and agent writes attach the same links. Cross-workspace recall leak closed. **Schema-change safety is fully engine-agnostic on SurrealDB** (v3.16.0) — backup-before-destructive-change and migration both run through the live port; WP0 below has you confirm this on the current tree before touching anything else. The one piece of schema-safety still open is the full embedded destructive-confirm path, deferred post-launch — not part of this plan.

### Agentic DBA means this — not that

Yes: governed schema change, expand then migrate then contract, two-person confirm on destructive change, history when a fact is replaced. No: Lore as the digital employee, auto-inventing your industry model, or a chat UI in the engine. Apps (Atlas, and any ordinary backend) are the operators; Lore is the store they operate.

**Sources:** `docs/post_v2_plan.md` (26 Aug 2026), `BACKLOG-launch-readiness-2026-08-19.md` (repo root), `CHANGELOG.md`, this repo's `CLAUDE.md` Core boundary, `groundfloor-atlas/docs/ROADMAP.md` Stop-button item (30 Aug 2026, not the repo-root `ROADMAP.md` — that copy has no such item).

---

## How to work

1. One work package (WP) at a time. Merge or hand off only when that WP’s **Done when** is true.
2. Copy existing test style: `test/*.ts` with `tsx`, `passed`/`failed` counters, `process.exit`. Wire a new file into `package.json` as `test:unit:<name>` **and** into the parent `test` / `test:unit:*` aggregate that already includes similar tests (grep `package.json` for the sibling script).
3. After each WP: `npx tsc --noEmit` (from repo root, same as CI) plus the WP’s unit script plus `npm run test:arch`.
4. Do not change `Filter` leaf operators (`eq`, `contains`, …) except to add nested boolean keys. Do not rename existing REST paths.
5. New env knobs must be added to `packages/lore/src/security/envScrub.ts` allowlist (test: `test/env-scrub-allowlist-unit.ts`).
6. New MCP tools follow `packages/lore/src/mcp/tools/collections.ts` (zod input, `mcpToolError`, workspace gate via `assertMcpScope` / existing collection gate).
7. REST handlers share the same `handle*` functions as MCP. Never fork behavior.

---

## WP0 — Verify; do not rebuild schema-safety

**Why first:** launch notes still say “move blastRadius / dataSnapshot / migration onto the port.” **That work is already in the tree.** Re-implementing it will fight live code.

**Read only (then report facts in the PR, do not “fix” unless a test fails):**

| Claim | Check |
|---|---|
| Schema ops port exists | `packages/lore/src/schemas/substrate/schemaGraphOps.ts` |
| Surreal implementation | `packages/lore/src/engines/surreal/surrealSchemaGraphOps.ts` |
| Boot selects the port | `packages/lore/src/mcp/bootSteps.ts` `buildGraphReaders` |
| Migration uses the port | `packages/lore/src/schemas/migration/schemaGraphOpsBackend.ts` |
| Live exact-value tests | `test/surreal-schema-graph-ops-unit.ts` (`npm run test:unit:surreal-schema-ops`) |

**If those tests pass:** schema-safety WP is **done**. Do not touch it except comments that still say “Kùzu-only refuse.” Optional tiny follow-up (same PR only if you are already in those files): replace leftover “assertKuzuGraphSubstrate” comments with “GraphSubstrateUnsupportedError when neither hatch exists.”

**Do not** snapshot `ITableStorage` collections here (`dataSnapshot.ts` already says tables are out of scope). That is a later WP after Q1.10.

**Done when:** `npm run test:unit:surreal-schema-ops` is green and the PR description states “schema port already live; no rebuild.”

---

## WP1 — All-or-nothing table writes (Q1.10)

Ship first. Smaller than Q1.11. Proves the “JSON in, parameterized SQL out, contract test” pattern.

### 1.1 Contract (types only)

**File:** `packages/lore/src/contracts/tables.ts`

Add (names can match this; do not invent a second shape):

```ts
export type TableOp =
  | { op: 'insert'; collection: string; row: Row }
  | { op: 'update'; collection: string; filter: Filter; patch: Partial<Row> }
  | { op: 'delete'; collection: string; filter: Filter }
  | { op: 'upsert'; collection: string; row: Row }; // upsert = insert, or update-by-pk if pk exists

export type TableOpResult =
  | { op: 'insert' | 'upsert'; collection: string; key: unknown }
  | { op: 'update' | 'delete'; collection: string; count: number };

export interface ITableStorage {
  // existing methods stay
  runTransaction(ops: TableOp[]): Promise<TableOpResult[]>;
}
```

> **Corrected — drop the “optional or required” hedge.** Make `runTransaction` a **required** method on `ITableStorage`, full stop — an optional `?` lets an implementer silently skip it and pass compile. `FakeTableStorage` is duplicated across **three** test files (`test/collections-tools-unit.ts`, `test/collections-routes-unit.ts`, `test/rest-adversarial-unit.ts`) — update all three when you add the method, or two of them will fail to compile and the third will silently no-op.

Required method that SQLite implements (in-memory `FakeTableStorage`: apply ops; on throw, restore cloned maps). Dataplane collection stubs: throw `code: 'transaction_not_implemented'` with a stable message. Do not silently no-op.

**Cap:** `ops.length > 100` throws before opening a SQLite transaction. Constant `MAX_TABLE_TX_OPS = 100` next to the method. 1000 is the bulk-insert row cap (`collections.ts` F-T09); transactions are *operations*, so 100 is the lock-time cap. Do not reuse 1000.

**Upsert rule:** pk column from schema; if `getByKey` hits, `update` that pk; else `insert`. Empty update filter is already refused — upsert must always scope by pk.

### 1.2 SQLite implementation

**File:** `packages/lore/src/engines/sqliteTableStorage.ts`

> **Corrected — check this before writing code.** This file is already 805 lines and sits in `.file-size-baseline.json` as pre-existing debt at exactly that line count. `test:arch` fails any baselined file that grows past its recorded size — adding `runTransaction` plus extracted `insertSync`/`updateSync`/`deleteSync` helpers directly here **will** push it over and fail CI. Split first: move the new transaction method and its sync helpers into a new file, e.g. `packages/lore/src/engines/sqliteTableTransaction.ts`, and have `SqliteTableStorage` delegate to it (same pattern the plan already uses for `collectionsTransaction.ts` in 1.3 — don't add the handler body to the big file). After the split, run `npm run test:file-sizes:update` only if you *reduced* `sqliteTableStorage.ts` below its baseline; do not bump the baseline number to make a growing file pass.

Copy the `insertBatch` pattern (`this.db.transaction((batch) => { ... })`). Inside the transaction callback, **call the existing insert/update/delete implementations’ SQL**, not a second copy of SQL. Nested `this.db.transaction` in better-sqlite3 becomes a SAVEPOINT — avoid calling `insertBatch` (already a transaction) from inside `runTransaction`. Use the inner loop of insert/update/delete (extract private sync helpers if needed: `insertSync`, `updateSync`, `deleteSync`) so one outer `db.transaction` wraps everything.

On any throw: do not catch-and-commit. Let the transaction abort. Re-throw with `failedOpIndex` on the Error if easy (`(err as any).failedOpIndex = i`).

SQLite is synchronous in this class (`async` methods wrap sync). Keep that.

### 1.3 REST + MCP (same handler)

**Files:**

- New handler module (file-size: collections.ts is already large): `packages/lore/src/mcp/tools/collectionsTransaction.ts`
  - `handleTransaction(storage, body)` validates ops, cap, workspace (copy gate from `handleInsert`).
- MCP: register `collection_transaction` next to other collection tools in `packages/lore/src/mcp/tools/collections.ts` `register…` function (keep registration in collections.ts so one register function; put handler body in the new file).
  > **Corrected — watch the line count here.** `collections.ts` is at ~770 lines against the 800 hard cap, and WP2 will later add a second registration (`collection_join_query`) to the same function. One tool registration is normally small, but between the two WPs this file is likely to cross 800. If adding this registration pushes it over, register `collection_transaction` (and later `collection_join_query`) from the new handler module instead and import the register call into `collections.ts`'s `register…` function as a one-line delegate — don't let the file grow past cap to keep registrations "all in one place."
- REST: **`POST /v1/transaction` must be matched before** `POST /v1/{collection}`.

In `packages/lore/src/mcp/http/routes/collections.ts`:

- Today `V1_PREFIX = '/v1/'` and collection name is the first segment.
- Add at the **top** of `tryCollectionsRoutes`, after auth/workspace bind, something equivalent to:

```ts
if (method === 'POST' && (pathname === '/v1/transaction' || pathname === '/v1/transaction/')) {
  // read body, handleTransaction, writeJson
  return true;
}
```

If you put this after the `{collection}` insert route, **`transaction` will be treated as a collection name.** That is a bug. Write a regression test: `POST /v1/transaction` with a valid body must not 404 as unknown table `transaction`.

Body:

```json
{ "operations": [ { "op": "insert", "collection": "orders", "row": { "id": "1" } } ] }
```

Success `200`: `{ "results": [ ... ] }`  
Failure `400`/`409`: nothing applied. Message names `failed_op_index` and reason. After failure, `GET`/`query` those collections must match pre-call state.

### 1.4 Tests (write these first if you want; they must exist before merge)

| File | What |
|---|---|
| `test/sqlite-table-storage-unit.ts` | Add cases: 3 ops commit; op 2 throws → counts unchanged; cap 101 throws with **zero** writes |
| `test/collections-tools-unit.ts` | `handleTransaction` on FakeTableStorage |
| `test/collections-routes-unit.ts` | `POST /v1/transaction` routing; `{collection}` still works |
| New `test/table-transaction-contract-unit.ts` | Same 3 cases against **real** `SqliteTableStorage` tmpdir (this is the suite a future Postgres adapter must also pass — comment that at the top) |

**Done when:** those tests green, `tsc` clean, `test:arch` green, no raw SQL in the JSON body.

---

## WP2 — Richer filters and joins (Q1.11)

Do **after** WP1.

### 2.1 Nested boolean filters

**Problem:** `Filter` in `packages/lore/src/engines/collectionStorage.ts` is flat AND only. Index signature `[op: string]` exists — do **not** stuff `and`/`or`/`not` into that bag as `Record<string, unknown>` (it would break `eq`).

**Add a new type** in the same file:

```ts
export type FilterNode =
  | Filter
  | { and: FilterNode[] }
  | { or: FilterNode[] }
  | { not: FilterNode };
```

Keep `query(table, filter?: Filter, …)` working. Add overloads or widen `query`/`update`/`delete`/`count`/`join` to `FilterNode`. Leaf `Filter` remains valid `FilterNode`.

**Translator:** `packages/lore/src/engines/whereClause.ts`

- Recurse `and`/`or`/`not` into parenthesized SQL: `(… AND …)`, `(… OR …)`, `NOT (…)`.
- Leaves still use `assertIdent` + bound `?` values. **Never** concatenate user strings into SQL.
- Cap nesting depth at **8**. Deeper → throw `filter_too_nested`.
- Empty `and: []` / `or: []` → throw (do not match all rows).
- Update `buildSqliteWhere` (used by `sqliteTableStorage.buildWhereClause`). Cypher `buildCypherWhere` is leftover for dead Kùzu paths — if still compiled, either leave leaf-only or add the same tree; do not spend a sprint on Cypher unless `tsc` requires it.

**Zod:** `filterZ` needs a recursive (lazy `z.union`) variant for the nested tree. `packages/lore/src/mcp/tools/collections.ts` is already ~770 lines against the 800 hard cap — do **not** grow it with the new recursive schema. Put the new schema (e.g. `filterNodeZ`) in a new module (`packages/lore/src/mcp/tools/collectionsFilterSchema.ts` or similar) and import it into `collections.ts`, the same file-size discipline the plan already applies to the transaction handler in 1.3. REST uses the same parser as MCP if there is one; if REST trusts JSON, still run it through the same validate function.

**Tests:** in `test/sqlite-table-storage-unit.ts` seed 6 rows; a 3-level `or`/`and`/`not` tree must equal the row ids of the equivalent handwritten WHERE (assert the id set). Add an injection case: `{ eq: { "id); DROP TABLE": "x" } }` still throws `invalid identifier` (existing SP-05). Nested `{ or: [{ eq: { "id); DROP": "x" } }] }` must also throw.

### 2.2 Multi-hop joins

**Today:** `ITableStorage.join(left, { table, on: { left, right } })` is **inner, one hop**. `capabilities().join === true` on SQLite.

**Extend `JoinSpec`** (keep old fields working):

```ts
export interface JoinHop {
  collection: string;
  on: { from: string; to: string }; // unprefixed column names — see correction below
  type: 'inner' | 'left';
}
export interface JoinQuery {
  from: string;
  join: JoinHop[]; // 1..4 hops
  where?: FilterNode;
  opts?: FindOptions;
}
```

> **Corrected — `from`/`to` must be plain column names, not `table.column`.** `assertIdent` in `whereClause.ts` matches `/^[a-zA-Z_][a-zA-Z0-9_]*$/` — a dot fails it. The existing `JoinSpec` (`contracts/tables.ts`) already uses short unprefixed names (`on: { left, right }`) for exactly this reason; `JoinHop.on` should follow the same convention, not the "table.column" idea in the comment above. Resolve which side of an ambiguous column belongs to which hop from `join[].collection` order, not from a dot in the identifier.

Simplest API that a small model will not mess up:

- Keep `join(leftTable, spec, filter, opts)` for **one** inner hop (existing tests in `sqlite-table-storage-unit.ts` must stay green).
- Add `joinMany(query: JoinQuery): Promise<Row[]>`.
- Cap `join.length` at **4**. `capabilities()` add `maxJoinHops: 4` (or document the cap in the throw). Adapters that cannot join still omit/throw.

SQL: `FROM t0 alias0 INNER/LEFT JOIN t1 alias1 ON …`. Aliases `j0`, `j1`, … Identifier-validate every table and column. Prefixed result keys like today: `"orders.id"`.

**REST:** `POST /v1/query` (not `/v1/{collection}/query`) with body `{ from, join, where, limit }` — same “register before collection catch-all” rule as `/v1/transaction`.  
**MCP:** `collection_join_query`.

If `/v1/query` collides with something in `dispatcher.ts`, grep pathname `/v1/query` first. If taken, use `POST /v1/join` instead and say so in the PR.

**Tests:** orders → customers → addresses, inner and left; hop 5 throws; existing single `join()` test unchanged.

**Done when:** Q1.11 acceptance in `post_v2_plan.md` holds on SQLite; no raw SQL in API; `test:arch` green.

---

## WP3 — Stop button (cooperative cancel)

Hardest WP. Do not mix with WP1/WP2. Atlas already caps abandoned jobs; this is **Lore** stopping work.

> **Corrected — split this into two sub-WPs.** This WP was written as one PR covering two different surfaces: the library-level `shouldAbort` callback on `bulkIngest` (3a), and a new HTTP cancel endpoint + runner wiring for load jobs (3b, see the load-job note below — that route doesn't exist yet, it's not a skip). Same theme, different code paths, different test files. Ship them as **separate PRs (3a then 3b)** — a single PR covering both invites shipping one and marking the whole WP done.

### Safety properties (fail the PR if any is violated)

1. **Never interrupt a native LanceDB write that has already started** (`bulkAddPrebuiltRows` / `bulkUpsertPrebuiltRows`). Check abort **before** calling it; if already inside, let it finish.
2. **Never report success for a graph row with no search vector** when the caller asked for `embed: 'sync'` (bulkIngest default). Atlas retry treats “id exists in graph” as done and will skip embedding. **This applies to every id left un-embedded when cancel lands — not only ids cancelled before embedding started.** Graph writes for the whole batch (step 1b) complete before any chunk is embedded, so a cancel signal received during chunk 2 of 3 still means every id in chunks 2+ already has a graph row and no vector. Property 2 covers those exactly the same as an id cancelled before embedding began at all — see the rollback rule below and test 3.
3. **Do not destroy or reset the process-wide embedding session** on cancel. Stop feeding it new chunks. Current in-flight `embedDocumentBatch` may finish; then return cancelled. Other workspaces keep using the same model.
4. **Never stamp a success cursor or mark a job complete on an aborted run** — the same rule `reconnect.ts`'s `shouldAbort` already follows (poll at page boundaries; aborted ⇒ do not write success cursors, see `test/r3-sweep-abort-cursor-unit.ts`). A cancelled `bulkIngest` call must not report itself as the batch's completion, and a cancelled load job must not advance past `'running'` into `'complete'`.

### Where to add abort (and nowhere else in v1)

**Primary path (3a):** `packages/lore/src/mcp/bulkIngest.ts` `runBulkIngest`.

Add to `BulkIngestOpts`:

```ts
shouldAbort?: () => boolean;
```

Poll `shouldAbort` at:

- start of `mapLimit` worker iteration (graph upserts)
- between embed chunks
- immediately before `writePrebuiltRowsPerWorkspace`

> **Corrected — `embedBatchSize` does NOT already split the batch, and there is no per-chunk write path today.** Checked in `bulkIngest.ts`: when `embedBatchSize` is unset (the default), the whole batch goes through **one** `embedDocumentBatch` call, chunks get `.flat()`-ed back together, and everything is written in **one** `writePrebuiltRowsPerWorkspace` call at the end. "Abort between chunks, chunk 1's vectors survive" is not possible against that code as it stands — two things must actually be built here, not assumed to exist:
> 1. **Force a chunk size when `shouldAbort` is provided** (e.g. 32), even if the caller didn't set `embedBatchSize`. Without this there is nothing to poll between.
> 2. **Add a "write finished prefix, then stop" path**: when abort lands mid-embed, write vectors for chunks that already finished embedding, and do **not** call `writePrebuiltRowsPerWorkspace` with the unfinished remainder — apply the rollback rule (below) to every id in the chunks that didn't finish. This path does not exist in the code today; building it is part of 3a, not a poll-and-reuse job.

**Rollback rule — applies at every point cancel can land, not only "before any embedding started":**

- **Ids created by this call** that end up with a graph row and no vector — whether cancel landed before step 1b's writes reached them, after step 1b but before embedding started, or mid-embed (in an unfinished chunk) — **hard-delete that graph node** using the same delete path as `delete_node` (`packages/lore/src/mcp/tools/memory/deleteNode.ts`: hard graph delete + verbatim tombstone). `delete_node` is a hard delete of the graph row, not a soft flag — correct here too, because retry must not see the id at all. Do not invent a third lifecycle.
- **Ids that already existed before this call** are different — **do not hard-delete them.** `bulkIngest`'s Step 1a already loads `previousStates` via `getNode` before Step 1b overwrites anything (when `deps.versionStore` is wired; if it isn't, this WP needs to fetch prior state unconditionally before the graph write, or the restore path has nothing to restore). If step 1b overwrote a pre-existing node and cancel then hit before that node got a new vector, **restore `previousState`** instead of deleting — a hard-delete here would erase a note that was fine before this call, just because a later re-save happened to time out. This is the difference between "this row never should have existed" (delete) and "this row's last good version got clobbered by an interrupted write" (restore).
- Result slots for every rolled-back id, whichever branch: `{ ok: false, id, error: 'cancelled' }` (stable string; tests match it).

If abort before any graph write: no rollback needed; all `cancelled`.

**Do not** try to abort ONNX mid-tensor.

**HTTP/MCP surface (minimal, still part of 3a):**

- Library: `shouldAbort` on `bulkIngest` / `createLore().bulkIngest` (grep `runBulkIngest` call sites in `packages/lore/src/index.ts` and `mcp/server.ts`).
- HTTP: if bulk write already has a route (`mcp/http/routes/bulkWrite.ts`), add optional header `X-Lore-Job-Id` later; **v1 is abort callback only**.

**Load jobs (3b — separate PR from 3a):**

> **Corrected — verify before you trust the doc.** `docs/architecture/bulk-loader.md` describes `POST /api/load/jobs/<id>/cancel` as shipped in v3.5.0. It is not: `packages/lore/src/mcp/http/routes/load.ts` registers only `POST /api/load`, `GET /api/load/jobs`, and `GET /api/load/jobs/<id>` — there is no cancel route in the code today. `packages/lore/src/storage/loadJobsRunner.ts` has zero references to cancellation; `'cancelled'` exists only as an unused status value in `loadJobsStore.ts`. **Do not skip this on the doc's say-so.** Treat it the same way WP0 treats the schema-safety claim: grep the live route table and the runner yourself first. If it's still missing when you get here, implementing the cancel route + wiring `shouldAbort` from it into `loadJobsRunner.ts` **is part of this WP (as 3b)**, not a "do not reimplement" skip. Same rollback rule and property 4 apply here: a cancelled load job must not leave graph-only rows behind, and must not advance to `'complete'`. Update `docs/architecture/bulk-loader.md` in the same PR once the route is real, so the next person doesn't repeat this mistake.

**Copy abort style from:** `packages/lore/src/engines/reconnect.ts` `shouldAbort` (poll at page boundaries; aborted ⇒ do not write success cursors). Read `test/r3-sweep-abort-cursor-unit.ts` for “abort must not stamp success.”

### Tests (required)

New `test/bulk-ingest-cancel-unit.ts`. Seed each scenario with a mix of brand-new ids and ids that already existed (with a prior healthy version) before the call, so the created-vs-existing rollback split actually gets exercised:

1. Abort before step 1b → zero graph nodes written, all `cancelled`.
2. Abort after graph, before embed → **new** ids **absent** (hard-deleted, `getNode` returns null); **pre-existing** ids restored to their `previousState` (`getNode` returns the old version, not the half-updated one); all results `cancelled`; a second bulkIngest of the new ids **does** embed on retry.
3. Abort signal mid-embed (this requires the forced-chunk-size + finished-chunks-only-write behavior from the correction above — with a small forced chunk size, e.g. 2 finished chunks of 3): finished chunks' vectors exist and stay; every id in the unfinished chunk(s) is rolled back per the same rule as test 2 (new → hard-deleted, pre-existing → restored); those result slots are `cancelled`; no `session.dispose`.
4. Fake LanceDB that hangs inside `bulkAddPrebuiltRows`: abort during hang must **not** leave a half-committed mock if you cannot simulate native; skip hang test rather than fake a mid-write kill.
5. A cancelled run does not advance any success cursor / job-complete marker (property 4).
6. A pre-existing id whose update was cancelled and restored is **not** treated as `cancelled`-then-silently-fine by a caller re-reading it — its content must equal what `getNode` returned before this call ran, not a partial write.

Also: existing bulk ingest tests still pass.

**Done when (3a):** properties 1–4 have tests, including test 3's finished-chunk rollback and the created-vs-existing restore split from tests 2/3/6; `test/bulk-ingest-cancel-unit.ts` green.  
**Done when (3b, separate PR):** the load-job cancel route exists, is wired into `loadJobsRunner.ts`, applies the same rollback + property 4, and `docs/architecture/bulk-loader.md` matches reality. Atlas-side code is unchanged in both.

---

## WP4 — Build search indexes on the write path

**Bug:** `BACKLOG-launch-readiness-2026-08-19.md` item 11. `bulkAddPrebuiltRows` does not call `ensureVectorIndex` / `ensureFtsIndex`. Those run on store open / maintenance. A write-then-query same session can run unindexed.

**Files:** `packages/lore/src/engines/verbatimBatch.ts` (`bulkAddPrebuiltRows`, `bulkUpsertPrebuiltRows`), wrappers in `verbatimStore.ts`.

**Behavior:**

- After a successful bulk add/upsert, if `countRows() >= minRows` (default **256**, same as `ensureVectorIndex`), schedule a **debounced** ensure (do not await index build on every 10-row flush). Debounce ~2s, coalesce. `void ensure…().catch` is OK if errors stay non-fatal like today.
- Do **not** build below 256 rows (existing skip).
- Do **not** expect this to fix latency (backlog says it does not). It is correctness/hygiene so later FTS/IVF is present.

**Test:** extend `test/lancedb-ivf-flat-vector-index-unit.ts` or `test/index-integrity-heal-unit.ts`: insert ≥256 rows via `bulkAddPrebuiltRows` only (no `ensureVectorIndex` in the test), wait for debounce (use injectable clock/`setTimeout` stub or `minRows: 50` + `debounceMs: 0` test seam on the batch ctx). Assert `listIndices` contains IvfFlat.

**Done when:** that test is green; open-path ensure still works (no double-build crash).

---

## WP5 — Measure retrieval time (then maybe one fix)

**Do not optimize first.** Item 12 in the launch backlog.

1. Add a **debug-only** timing breakdown behind env `LORE_RECALL_STAGE_TIMING=1` (allowlist it). Stages: embed query, vector search, keyword/FTS, hydrate graph rows, filter. Log one JSON line per recall. **Default off.**
2. Run `npm run measure:latency` (`scripts/latency-spotcheck.mjs`) once with the flag; paste numbers in the PR.
3. Only if hydrate dominates: change that path to select `id, type, label` (+ snippet) for summary recall, not `SELECT *`. Cite `DECISIONS.md` 2026-08-05 (`DEC-SURREAL-SCAN-FIX`) — it's a real, written decision (also cited in `CHANGELOG.md` and `BACKLOG-launch-readiness-2026-08-19.md`), not a comment tag in `src/`; read it before touching this path.
   > **Corrected twice — an earlier pass here wrongly said this tag didn't exist; it does.** That decision already found the win is in the `ORDER BY` sort, not the column projection (`ordered: false` took SurrealDB from 359.7ms to 121.0ms; ORDER-only, no narrower `SELECT`). Also: a narrow read primitive **already exists** — `listNodeSummaries` (`packages/lore/src/engines/surrealGraph.ts` / `surreal/surrealGraphDirected.ts`) returns `id`/`type`/`label` today. Do not build a second "select fewer columns" feature. If the WP5 measurement shows the recall hydrate stage (`graph.getNodesByIds` in `packages/lore/src/recall/retrieve.ts`) is the actual cost, the fix is either applying the same `ordered: false` insight there, or routing that stage through `listNodeSummaries` for summary recall — not inventing a new narrow-select path. **No other “optimizations.”**

**Done when:** timings exist in a PR comment; then either (a) `graph.getNodesByIds`'s hydrate stage routes through `listNodeSummaries` or picks up the same `ordered: false` fix from `DEC-SURREAL-SCAN-FIX`, with a test — **not** a new narrow-`SELECT` path, that already exists — or (b) an explicit “hydrate is not the cost; stop here” if the measurement says otherwise.

### WP5 measurement (2026-08-30) — hydrate is not the cost; stop here

Ran on this tree, Node 22.18.0, embedded, 1000-node corpus, 20 queries:

```
LORE_RECALL_STAGE_TIMING=1 LORE_LOG_LEVEL=info npm run measure:latency -- 1000 20
```

Headline (script `shapes`):

| shape | p50 | p95 | mean |
|---|---|---|---|
| agent default (max 10, summary) | 21 ms | 25 ms | 17 ms |
| deep window (max 150, full) | 57 ms | 82 ms | 59 ms |
| keyword only (max 10) | 8 ms | 13 ms | 8 ms |
| semantic only (max 10) | 12 ms | 14 ms | 12 ms |

Stage breakdown from `recall_stage_timing` lines (typical hybrid agent-default call): **fts ~16–22 ms**, **vector ~10–14 ms**, **embed ~8–10 ms**, **hydrate ~1.2–2.4 ms**, filter ~0. Deep window (150 hits) raises hydrate to ~13–17 ms (one spike 36 ms) but vector and FTS stay larger (~23–36 ms each). Hydrate is not the dominant stage on either shape.

`getNodesByIds` already fetches by record id (`SELECT * FROM $ids`) with no `ORDER BY`, so `DEC-SURREAL-SCAN-FIX`'s `ordered: false` lever does not apply to this path. Do **not** route hydrate through `listNodeSummaries` and do **not** invent a new narrow `SELECT`. Stop.

---

## WP6 — Bulk ingest log noise (small)

Item 13: conflicts logged as ERROR then retry succeeds.

**Find** the log site (grep `ERROR` / `log.error` near bulk ingest / graph upsert conflict / `transactionConflictRetry`). Downgrade retries to `warn` or `debug`; `error` only on **final** failure.

**Test:** if there is an existing conflict-retry test, assert log level; otherwise a unit test on the retry helper.

**Done when:** a 50k-style retry no longer looks like data loss in logs (assert by code, not by running 50k).

---

## Explicitly out of this plan

| Item | Why |
|---|---|
| Postgres / Dataplane `ITableStorage` | Cloud activation; needs Q1.1. Contract tests in WP1 are the hook. |
| `POST /v1/transaction` ReBAC `rebac_write` from DATAPLANE_INTEGRATION.md | Cloud authz. Do not add ReBAC ops to the local JSON grammar in WP1. |
| Extraction “prose → schema” | App/ingest product, not Core DBA. |
| Intent verbs lookup/find/count API reshape | Post-launch; no API rename now. |
| Plugins, A2UI, Loom, chat cancel button in lore-app | Wrong repo / out of Core. |
| Killing ONNX mid-forward / killing Lance mid-commit | Forbidden by WP3. |
| Raising Atlas timeouts instead of Lore cancel | Atlas already has a cap. Do not “fix” Atlas in this repo. |

---

## Suggested PR sequence (one PR per WP, except WP3)

```
WP0  docs-only note in CHANGELOG “schema-safety already on Surreal” (optional)
WP1  feat: collection transaction
WP2  feat: nested filter + joinMany
WP3a feat: bulkIngest cooperative cancel (library shouldAbort)
WP3b feat: load-job cooperative cancel (HTTP route + runner wiring)
WP4  fix: debounce ensure*Index after bulk vector write
WP5  chore: recall stage timing (+ listNodeSummaries / ordered:false on hydrate, if warranted)
WP6  chore: conflict retry log level
```

Do not combine WP3 with WP1.

---

## Quick file map

| Area | Files |
|---|---|
| Table contract | `packages/lore/src/contracts/tables.ts` |
| SQLite tables | `packages/lore/src/engines/sqliteTableStorage.ts` |
| Filter SQL | `packages/lore/src/engines/whereClause.ts`, `collectionStorage.ts` |
| MCP collections | `packages/lore/src/mcp/tools/collections.ts`, `collectionsQuery.ts`, **new** `collectionsTransaction.ts` |
| REST collections | `packages/lore/src/mcp/http/routes/collections.ts`, dispatcher already calls `tryCollectionsRoutes` |
| Bulk ingest | `packages/lore/src/mcp/bulkIngest.ts` |
| Load jobs | `packages/lore/src/storage/loadJobsRunner.ts`, `loadJobsStore.ts` |
| Vectors / index | `packages/lore/src/engines/verbatimBatch.ts`, `verbatimStore.ts` |
| Reconnect abort sample | `packages/lore/src/engines/reconnect.ts` |
| Env allowlist | `packages/lore/src/security/envScrub.ts` |
| Schema ops (read-only WP0) | `schemas/substrate/schemaGraphOps.ts`, `engines/surreal/surrealSchemaGraphOps.ts` |

---

## If you get stuck

- Injection / identifier: `assertIdent` in `whereClause.ts`; tests `test/sp05-injection-unit.ts`.
- Workspace isolation: every new route must `bindRouteTarget` like existing `/v1/` collection handlers.
- File size: if a file is huge, split like `collectionsQuery.ts` — do not add 400 lines to `collections.ts`.
- `FakeTableStorage` appears in **multiple** test files. Grep `class FakeTableStorage` and update **all** of them when `ITableStorage` grows.
