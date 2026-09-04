# Design memo — Migration runner (Phase 4 item 8)

> Captured 2026-05-16. Companion to:
> - `docs/architecture/SCHEMA_CHANGE_SAFETY_MEMO.md` (the principles this implements)
> - `docs/architecture/LORE_LOOM_API_GUIDE.md` (current state)
> Status: MVP scope below was the first slice (captured 2026-05-16).
> Since capture: batched checkpointing (`resume`), automated
> `rollback`, and expand→migrate→contract decomposition have shipped;
> the backend was reworked to be engine-agnostic
> (`SchemaGraphOpsMigrationBackend`) during the prior local graph engine's
> removal effort (updated 2026-08-21; see `docs/KUZU_REMOVAL.md`). The cloud
> backend remains queued.

## What it solves

Today `schema_approve` flips the schema JSON file but does **not**
migrate underlying data. Phase 1 item 3 takes a snapshot of affected
rows *before* the flip so the data is recoverable; Phase 3 item 1
computes affected-row counts *upfront* so the approver knows what
they're approving. **But the data itself is never transformed.**

For `node_type.removed`, that leaves orphaned `LoreNode` rows in the
graph with a `type` field the live schema no longer recognises. For
`field.removed`, it leaves stale fields in every affected node's
`metadata` JSON. Today the consumer code (plugins, ingestion paths,
UI) has to handle "old shape" alongside "new shape" indefinitely —
that's the `dual-shape` MigrationStrategy strategy in name only; the
"migrate" part of the strategy never actually runs.

The migration runner is the missing "migrate" step. A human-approved
migration plan turns those orphans into actually-gone data — atomically
recorded, with a dry-run preview so the human sees what's about to
change before it's applied.

## Vocabulary

- **`MigrationOp`** — one transformation. Mirrors a `SchemaChangeKind`
  but is independent of the schema-authoring proposal lifecycle: a
  plan can be derived from a proposal *or* hand-written by an
  operator (e.g. to clean up an older partial migration).
- **`MigrationPlan`** — ordered list of `MigrationOp[]` + provenance
  (proposedBy, approvedBy, optional sandboxId link).
- **`MigrationBackend`** — substrate adapter. Today:
  `SchemaGraphOpsMigrationBackend`
  (`schemas/migration/schemaGraphOpsBackend.ts`) — engine-agnostic,
  built on the `SchemaGraphOps` port
  (`schemas/substrate/schemaGraphOps.ts`) instead of raw Cypher.
  SurrealDB is the only graph engine — the prior local graph engine was
  fully removed 2026-08-21 (see `docs/KUZU_REMOVAL.md`). `schemas/orchestration/
  wiring.ts` picks the ops instance via `SurrealSchemaGraphOps`; a stub
  class for that engine's raw-Cypher schema ops still exists in
  `schemaGraphOps.ts` as a thin
  wrapper over a generic `GraphReader & GraphWriter`, but it has no
  real caller left — nothing can produce a graph handle exposing the
  raw-Cypher hatch it wraps, since `LocalGraph` is gone and a workspace
  still declaring the legacy graph-engine config value now throws a
  dedicated removal error before reaching this seam at all. It
  replaces the MVP's migration backend for that engine (its source
  file was deleted in that removal effort's Phase 3f; see
  `docs/KUZU_REMOVAL.md`) with the same scope op for op. Future:
  `PostgresMigrationBackend`, `LanceDBMigrationBackend`,
  `DataplaneMigrationBackend`.
- **`MigrationRunner`** — sequencer. Wraps a backend, exposes
  `dryRun(plan)` and `execute(plan)`. MVP: sequential, fail-fast.
- **`DryRunReport` / `ExecuteReport`** — per-op result rows + totals.

## API surface (MVP as shipped at capture — since extended)

Since capture the interface grew: `executeOp` was replaced by
`executeOpBatch(op, cursor, batchSize)`, `rollbackOp` was added, and
the runner gained `resume(planId)`, `rollback(...)`, and optional
checkpoint-store + audit wiring. See `schemas/migration/types.ts`
and `schemas/migration/runner.ts` for the current shapes.

```ts
type MigrationOpKind = 'node_type.removed' | 'field.removed';

interface MigrationOp {
    kind: MigrationOpKind;
    target: string;        // e.g. 'know.Tenant' or 'know.Tenant.email'
}

interface MigrationPlan {
    ops: MigrationOp[];
    proposedBy: string;    // 'human:rafi' | 'ai:claude' | 'system:installer'
    approvedBy: string;    // operator running the migration
    sandboxId?: string;    // link to the schema-authoring proposal (optional)
    note?: string;
}

interface DryRunOpResult {
    op: MigrationOp;
    affectedRowCount: number;
    sampleRows?: unknown[];   // first N rows for preview (default N=3)
    note?: string;
}

interface DryRunReport {
    ops: DryRunOpResult[];
    totalAffected: number;
    computedAt: string;
}

interface ExecuteOpResult {
    op: MigrationOp;
    deleted: number;       // rows removed
    modified: number;      // rows whose metadata changed
    error?: string;        // present iff this op failed
}

interface ExecuteReport {
    ops: ExecuteOpResult[];
    totalDeleted: number;
    totalModified: number;
    succeeded: boolean;     // false if any op had error
    startedAt: string;
    finishedAt: string;
}

interface MigrationBackend {
    dryRunOp(op: MigrationOp, sampleN?: number): Promise<Omit<DryRunOpResult, 'op'>>;
    executeOp(op: MigrationOp): Promise<Omit<ExecuteOpResult, 'op' | 'error'>>;
}

class MigrationRunner {
    constructor(backend: MigrationBackend);
    async dryRun(plan: MigrationPlan, sampleN?: number): Promise<DryRunReport>;
    async execute(plan: MigrationPlan): Promise<ExecuteReport>;
}
```

## Per-op semantics

Ops are expressed through the engine-agnostic `SchemaGraphOps`
port; each engine answers them natively. The Cypher below is the
query shape the now-unreachable stub class for the prior local graph
engine's schema ops carried forward verbatim from its original
migration-backend implementation before that engine was removed (see
`docs/KUZU_REMOVAL.md`), kept here as the reference for the semantics —
the live path is `SurrealSchemaGraphOps`
(`engines/surreal/surrealSchemaGraphOps.ts`), which implements the
same semantics in SurrealQL.

### `node_type.removed` (target = `know.Tenant`)

Data shape today: `LoreNode` rows with `type = 'know.Tenant'` exist
in the graph; the live schema no longer lists this type.

**Dry-run**: `MATCH (n:LoreNode) WHERE n.type = $type RETURN n LIMIT
$sampleN` plus a `count(n)`. Reports affected count + first N rows.

**Execute**: `MATCH (n:LoreNode) WHERE n.type = $type DETACH DELETE n`.
Returns `{deleted: N, modified: 0}`. DETACH so any incoming/outgoing
edges go with the node — leaving dangling edges is worse than the
absent rows. (Tier-3 safety: callers are expected to have approved
a snapshot first via Phase 1 item 3 — the data is recoverable from
`.lore/data-snapshots/`.)

### `field.removed` (target = `know.Tenant.email`)

Data shape today: every `LoreNode` of type `know.Tenant` has the
`email` key inside its `metadata` JSON blob; the live schema no
longer lists this field.

**Dry-run**: enumerate rows of the parent type, parse `metadata`,
count rows whose `metadata` contains the affected field; sample N
rows of the form `{id, metadataKeys[]}`. Doesn't change anything.

**Execute**: for each affected row, parse `metadata`, delete the key,
re-serialise, `SET n.metadata = $newJson`. Returns `{deleted: 0,
modified: N}`. Still per-row writes, but now paged by id cursor in
batches with a checkpoint persisted after each batch — batched
execution shipped since capture.

## Explicit non-goals for MVP

- **Cloud backend.** `PostgresMigrationBackend` lands when
  `DataplaneTableStorage` does (separate slice).
- **Vector substrate.** Re-embedding on field removal is a heavier
  story — defer.
- **Batched checkpointing.** Shipped since capture. `execute(plan,
  opts?)` loops `executeOpBatch` per op in batches (default 1000
  rows) and persists a checkpoint to
  `.lore/migrations/in-flight.json` after every batch;
  `resume(planId)` picks up an in-flight plan — completed ops are
  skipped, the in-progress op continues from its saved cursor. A
  per-workspace lock serialises `execute`/`resume`/`rollback` so
  concurrent runs can't clobber the checkpoint.
- **Automated rollback.** Shipped since capture.
  `MigrationRunner.rollback(plan, executeReport, dataSnapshotsDir)`
  reverses the ops from the Phase 1 item 3 snapshots — re-inserts
  deleted nodes/edges, re-splices stripped or retyped field values —
  and is itself crash-resumable via a rollback checkpoint.
- **The other 7 destructive kinds** (`node_type.renamed`,
  `node_type.kind_changed`, `field.type_changed`,
  `field.sensitivity_flipped`, `edge_type.removed`,
  `permission.changed`, `permission.removed`). Shipped since
  capture: `SchemaGraphOpsMigrationBackend` implements all nine
  destructive kinds op for op. Five transform rows
  (`node_type.removed`, `node_type.renamed`, `field.removed`,
  `field.type_changed`, `edge_type.removed`); the other four are
  schema-only changes the backend executes as successful no-ops so
  fail-fast doesn't skip subsequent ops. The Runner / Plan / Op
  shapes didn't change.
- **Expand → migrate → contract decomposition** (Phase 4 item 9).
  Shipped since capture: `POST /api/schema/migrations/decompose`
  (`schemas/decomposition.ts`) returns the three-phase plan —
  phases 1 and 3 hit `schema_propose/approve` as before; phase 2
  hits this runner — and the orchestrator
  (`schemas/orchestration/`) walks active plans through their
  phases.
- **Second-party HITL for tier-3** (Phase 4 item 10). Runner just
  takes a `MigrationPlan` — the auth/approval question is upstream.
  The route layer now enforces part of it: `execute`/`resume`/
  `rollback` require the human-operator principal, and every
  destructive op must correlate against the approved proposal's ops
  (`schemas/migration/opCorrelation.ts`, F-A1/F-A2 + F-M02).

## API surface — REST/MCP

REST routes (`routes/schema/migrations.ts`) — the two MVP routes
plus five shipped since:

```
POST   /api/schema/migrations/dry-run     body = MigrationPlan
POST   /api/schema/migrations/execute     body = MigrationPlan
GET    /api/schema/migrations/in-flight   current checkpoint state
POST   /api/schema/migrations/resume      continue an in-flight plan
DELETE /api/schema/migrations/in-flight   clear the checkpoint
POST   /api/schema/migrations/decompose   expand→migrate→contract plan
POST   /api/schema/migrations/rollback    reverse an executed plan
```

All gated by the existing `/api/*` Bearer requirement; the
destructive verbs additionally require the human-operator
principal. Still no MCP tools — the natural caller is the admin app
via REST.

## Safety properties (load-bearing)

1. **`dryRun` makes no writes.** Every backend op must be implemented
   with the `SchemaGraphOps` port's read-only primitives, whichever
   engine the workspace runs.
2. **`execute` fails fast.** First op with an error stops the run;
   later ops are skipped. `ExecuteReport.succeeded = false` and the
   failed op's `error` field is populated. (Partial application is
   honest: ops that completed before the failure are real.)
3. **No silent recovery.** If the snapshot (Phase 1 item 3) for the
   corresponding `schema_approve` doesn't exist on disk, future
   versions of the runner should refuse to execute destructive ops.
   Largely shipped since capture: the execute/resume/rollback routes
   refuse a plan whose `sandboxId` doesn't correspond to an approved
   proposal (so a pre-execution snapshot exists for rollback) and
   correlate every destructive op against the approved-ops set
   (F-M02) — though a literal snapshot-file-presence check in the
   runner remains unimplemented.
4. **Substrate isolation.** Ops are expressed through the
   engine-agnostic `SchemaGraphOps` port, not as engine-specific
   Cypher, so an op only ever reaches an engine that implements the
   port natively (SurrealDB, the only graph engine today).
   `MigrationBackend` remains the choke point for future substrates.

## How this composes with prior phases

- **Phase 1 item 1** (destructive guard) — applies to the schema
  proposal upstream of the migration plan. By the time a plan exists,
  the proposal has already been approved by a human.
- **Phase 1 item 3** (auto-snapshot) — runs at `schema_approve` time,
  before the schema flips. By the time the migration runner executes,
  the snapshot exists at `.lore/data-snapshots/`. The runner doesn't
  re-snapshot.
- **Phase 3 item 1** (blast radius) — propose-time advisory count.
  The dry-run report this session ships is the *execution-time*
  count: more authoritative because the migration runner can also
  return sample rows and per-op breakdowns.

## Open questions for the post-MVP slice

1. **Concurrency.** The runner still executes inside the daemon
   process (no separate worker); a per-workspace lock serialises
   `execute`/`resume`/`rollback` against each other. Future: queue
   runner as its own worker process? Or lean on engine-level
   transactionality where it exists (SurrealDB's transaction support,
   if a future revision leans on it more directly)?
2. **Idempotency.** A repeated `execute(plan)` with `node_type.removed`
   today deletes nothing the second time (no rows match). For
   `field.removed`, second execution is also a no-op (no metadata
   has the key). So MVP is accidentally idempotent. The batched
   runner shipped the real strategy this memo called for: the
   checkpoint records per-op completion flags and a batch cursor,
   and `resume` skips completed ops instead of re-running them.
3. **Audit linkage.** Resolved since capture: when the audit logger
   is wired, every successfully applied op appends a best-effort
   `migration.applied` entry to the schema-change audit log
   (`schema-changes.jsonl`) — an audit failure never fails the
   migration.
