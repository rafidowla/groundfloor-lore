# Design memo — Schema change safety for Lore (Agentic DBA)

> Author: working notes captured 2026-05-15.
> Status: design intent, not yet implemented. To be reviewed before any
> further work on schema authoring or autonomous-agent schema control.
> Companion to: `LORE_LOOM_API_GUIDE.md` (current state, gaps).

## The problem in one paragraph

Lore today lets a caller propose any schema change — including
destructive ones (drop field, drop table, change a column's type,
rename a node type) — and a single human with `administer` permission
can approve it with one call. When approved, Lore flips the schema
file. **It does not migrate any existing data.** That responsibility
is offloaded to whoever wrote the code that reads the affected type,
labelled politely in the audit log as `MigrationStrategy: dual-shape`.

In an agentic world where an LLM can be the proposer and a busy human
can be the approver, that combination is a foot-cannon. One day it
will be a 50-million-row workspace and someone will say "yeah looks
fine" and click approve, and a field will be gone. That's the day
we'll wish we'd built the guardrails described below.

## Principles

1. **Destructive operations must be structurally impossible in one
   step.** Not "discouraged" — *impossible* via the API surface.
2. **Decompose every breaking change into expand → migrate →
   contract.** This is the 30-year industry standard (Stripe, Google,
   Meta, every well-run Postgres shop). Each phase is a separate
   approval with time and verification between them.
3. **Trust the diff, not the proposer.** Lore should compute blast
   radius from the proposal itself, not believe the proposer's
   self-classification (`lazy` vs `dual-shape`).
4. **Agents propose additive only. Humans propose destructive.**
   Different verb, different gate. An agent can *help* with
   destructive change (draft migration plan, summarize readership)
   but cannot *initiate* or *approve* one.
5. **Cooling-off > confidence.** The right answer to "is this safe to
   drop?" is rarely "yes immediately." It is "yes, in 30 days, after
   we verify no one read it."

## Expand → Migrate → Contract, plain English

The standard playbook for safe schema change:

- **Expand.** Add the new thing *alongside* the old. New column, new
  table, new node type. Always additive. Old code keeps working
  because nothing it depends on went away.
- **Migrate.** Copy / transform the data into the new shape *in the
  background*. Both shapes coexist. Readers can use either. This is
  where you discover whether the change actually works on real data,
  at real volume, without breaking anyone.
- **Contract.** Only after the migrate phase shows zero reads against
  the old shape for a "soak period" measured in days, drop the old
  thing.

Example: renaming `email` to `primary_email` is **not** one operation.
It is:
1. Expand: add `primary_email` next to `email`. (Day 0, agent can
   propose, one-click approve.)
2. Migrate: backfill `primary_email = email` for existing rows; new
   writes target both. Readers prefer `primary_email`, fall back to
   `email`. (Day 1–7, human-initiated, mandatory dry-run report.)
3. Contract: 30 days after migrate completes, with a verification
   report showing zero reads against `email`, drop the old field.
   (Day 37, requires *two* `administer` users to approve.)

## Tier structure (the proposed enforcement)

| Tier | What it covers | Who can propose | Who approves | Required extras |
|---|---|---|---|---|
| **0 — Additive** | New field (nullable), new table, new node type, new edge type, new permission, new index | Agent or human | One `administer` user | Single audit entry |
| **1 — Soft deprecation** | Mark a field/table as deprecated. Still readable, writes get a warning logged. | Agent or human | One `administer` user | Auto-schedules a contract review for tier-3 in N days (default 30) |
| **2 — Migration** | Background transform of existing data into a new shape. Both old + new shapes coexist during the window. | **Human only** | One `administer` user | Mandatory dry-run report: row count, time estimate, disk delta, rollback plan. Resumable. Abortable. |
| **3 — Contract / destructive** | Drop a field, drop a table, change a column's type, rename anything | **Human only** | **Two different `administer` users** (second-party HITL) | Verification report showing zero reads against the old shape during the soak window. Scheduled, not immediate. |

The agent lives at tiers 0 and 1. Tiers 2 and 3 require a human in the
driver's seat. The agent can *help* (write the migration plan, draft
the dry-run query, summarize the readership) — it cannot initiate or
approve.

## What Lore needs to compute, automatically

Today the proposer self-labels `MigrationStrategy`. That label should
become advisory at best. Lore should compute, from the proposal diff
+ live data + readership graph:

1. **Affected row count.** "This change touches ~47M rows in
   `customers`."
2. **Affected reader count.** "12 plugins, 4 saved queries, and the
   admin app's `/customers/list` route reference the field
   `customers.email`."
3. **Reversibility cost.** "Dropping this field is irreversible
   without restoring from a snapshot. Last snapshot: 6 hours ago."
4. **Estimated migration cost.** "Backfill would take ~4 hours at
   current write throughput."
5. **Substrate constraint flag.** "This engine does not support online
   column-type change; this would require offline rebuild of
   `customers` (~12 hours of downtime)." *(Original example named Kùzu
   specifically — historical; Kùzu was fully removed 2026-08-21. The
   general point — some local engines can't do online DDL and need this
   flag — still holds; see the historical note under "Per-substrate
   reality" below.)*

The proposal then routes to the correct tier based on what Lore
computed, not what the proposer claimed. An agent that mis-classifies
(or lies about) a change as "lazy" gets caught by the system, not by
the human reading the request.

## Per-substrate reality

> **Historical note (2026-08-21):** Kùzu was fully removed as a graph
> engine — the local stack now runs SurrealDB only, see
> `docs/KUZU_REMOVAL.md`. The Kùzu-specific comparisons in the table and
> bullets below (written 2026-05-15, when Kùzu was still a live
> per-workspace option) are kept as the original migration-strategy
> reasoning record, not as a description of a currently-selectable
> engine. SurrealDB's own online-DDL story is a separate, current topic
> — see `docs/PERFORMANCE_NOTES.md` and `SurrealFeatures.indexes` /
> `LORE_SURREAL_DEFINE_INDEXES` in `engines/surreal/surrealConnection.ts`.

The cloud Dataplane stack is **multi-substrate**: ArangoDB for the
graph, Zilliz / Qdrant for vector, Postgres for relational. The
local stack is SurrealDB (graph — the only graph engine, Kùzu was
fully removed 2026-08-21, see `docs/KUZU_REMOVAL.md`) and LanceDB
(vector). The schema-change story is **not symmetric** across these:

| Substrate | Strength | Weakness |
|---|---|---|
| Postgres (cloud relational) | Online DDL is well-understood. Adding nullable columns is cheap. Backfill via batched updates is routine. Rollback via pg_dump or PITR. | Long-running ALTER on huge tables can still take real lock time; needs care. |
| ArangoDB (cloud graph) | Schema-flexible by design. Adding new edge collections is cheap. | Cross-collection consistency on schema change requires app-level coordination. |
| Zilliz / Qdrant (cloud vector) | Adding payload fields is cheap. Index dimension changes are expensive. | Re-embedding to a new model dimension is effectively a full rebuild. |
| Kùzu (REMOVED 2026-08-21 — row kept for historical comparison only, not a selectable engine) | Fast embedded operation. | Weak online-DDL story — column-type change on a node table = "snapshot, transform offline, swap." Single-writer constraint forces serialized migration. |
| LanceDB (local vector) | Embedded, fast, no daemon. | Similar re-embedding story to Zilliz/Qdrant. |

Implications:
- The **migration runner needs substrate-aware backends.** A "backfill
  column" in Postgres is `UPDATE ... WHERE id BETWEEN ... AND ...`
  batched. The same in Kùzu is "export, transform, drop, recreate,
  import." These are not the same code path.
- **Some changes that are safe in cloud are unsafe locally.** A
  column type change on a 1M-row Kùzu table is a non-event in
  Postgres but a multi-minute lock on Kùzu. Lore should detect this
  and downgrade the tier accordingly (or refuse, with a clear
  explanation).
- **Cloud destructive ops need PITR coordination.** "Drop column"
  should automatically take or reference a recent snapshot before
  proceeding.

## What this costs us (the honest trade-offs)

- **Schema gets cluttered.** Old deprecated fields linger 30+ days
  before contract. That's annoying. It is much less annoying than
  losing data.
- **Agent demos become less spectacular.** "Watch the agent rename
  the table!" is the wrong demo, because the right answer is "watch
  it propose phase 1 of a 30-day rename, which is the responsible
  thing." Worth it.
- **We have to build a migration runner.** This is the single
  biggest engineering investment to make the Agentic DBA story
  honest. Required: dry-run preview, batched execution with
  checkpointing, progress reporting, abort + rollback, substrate-
  specific backends.
- **Two-human approval slows down tier-3.** That is the point. It is
  not friction to be optimized away.
- **Reversibility computation is hard.** Knowing the cost of "undo
  this change" requires snapshot age, downstream readership, and the
  underlying engine's capabilities. Worth getting right.

## Concrete next steps (suggested order)

This is the implementation order I'd recommend if/when work resumes
on Phase A:

1. **Block tier-3 in the API.** Make `schema_propose` reject any
   destructive change kind unless `actor.kind === 'human'`. Cheap
   guardrail; closes the agent-driven foot-cannon immediately.
2. **Compute blast radius on every proposal.** Even before tiering
   is fully enforced, surface row count + reader count + reversibility
   in the `schema_list_proposals` and `schema_get_proposal` responses
   so the approver sees what they're approving.
3. **Implement the expand/migrate/contract decomposition.** When a
   human submits "rename X to Y," return a three-phase plan instead of
   executing it. Each phase becomes its own proposal id.
4. **Build the migration runner.** Postgres backend first (lowest
   risk, biggest payoff). Kùzu second, with snapshot-and-rebuild
   semantics *(moot — Kùzu was fully removed 2026-08-21; this ordering
   is historical)*. Vector substrates last (re-embedding is the
   highest-cost case).
   *(Landed for the local graph engine since this memo was written:
   schema migration now runs through `SchemaGraphOpsMigrationBackend`,
   built on the `SchemaGraphOps` port (`schemas/substrate/schemaGraphOps.ts`).
   It was originally engine-agnostic by design — `buildGraphReaders()`
   (`mcp/bootSteps.ts`) picks `KuzuSchemaGraphOps` when the boot graph
   exposes the raw-Cypher `getGraphContext()` hatch, `SurrealSchemaGraphOps`
   when it exposes `getSchemaGraphOps()` directly. Since Kùzu's removal
   2026-08-21, no workspace can boot with a Kùzu graph
   (`graphEngineSelector.ts` throws `KuzuEngineRemovedError` for
   `graphEngine: 'kuzu'`), so in practice this always resolves to
   `SurrealSchemaGraphOps` today — **but `KuzuSchemaGraphOps` itself is
   still present in the codebase, not yet deleted**; it's dead code
   reachable only if some future graph handle re-exposes
   `getGraphContext()`, not a currently-live dispatch target. Flagged as
   a residual-cleanup candidate, not yet actioned.)*
5. **Wire up the second-party HITL queue** for tier-3. This already
   exists in design (per `AUTH_AND_SYNC_DESIGN.md`); it just needs to
   be the mandatory route for destructive ops.
6. **Add `/api/schema/*` REST mirror** so the admin app, no-code
   tools, and shell scripts can drive the propose/approve/rollback/
   migration flow without an MCP client.
7. **Surface the dependency graph** — when Lore can answer "which
   plugins, queries, views read field `X.y`?" from the live system,
   the verification report at tier-3 becomes trustworthy instead of a
   guess.

## What this memo is NOT proposing

- **Not** removing the existing `schema_*` MCP tools. They keep
  working. The change is layered on top: enforcement gates + auto-
  decomposition + computed blast radius.
- **Not** banning humans from doing destructive things directly.
  Humans with `administer` + `confirm: true` + second-party approval
  can drop a field. The tier structure makes the path *visible and
  deliberate*, not impossible.
- **Not** a multi-quarter rewrite. Step 1 (block tier-3 for agents)
  is a one-PR change that closes 80% of the immediate risk.

## Open questions for review

1. **Default soak period.** I suggested 30 days for tier-3 contract.
   Real number depends on workspace cadence — solo workspaces might
   want 7 days; org workspaces might want 90.
2. **What counts as a "human" actor?** The Clerk JWT validator is
   built but not activated. Until cloud auth is on, "human" is a
   policy fiction enforced by the local bearer token. Need to settle
   this before tier-3 means anything strict.
3. **Per-workspace policy override?** Should an admin be able to
   relax tier-3 for a personal workspace ("I'm the only user, let me
   drop fields with one click")? Probably yes, with a one-time
   acknowledgement.
4. **Snapshot before destructive op — automatic or required?**
   Automatic is safer; required (with explicit snapshot id reference)
   is more honest. Lean: automatic with the option to reference an
   external snapshot.
5. **What about plugin-managed schemas?** Plugins ship vocab. When a
   plugin uninstalls, its schema collections may have data in them.
   Same expand/migrate/contract should apply, gated by plugin
   uninstall flow.

---

*End of memo. Companion docs: `LORE_LOOM_API_GUIDE.md` (current
state), `groundfloor-lore/docs/AUTH_AND_SYNC_DESIGN.md` (HITL tiers),
`groundfloor-lore/docs/DEPLOYMENT_MODEL.md` (local-first model).*
