# Decision — Cloud-mode outbox storage strategy (R2)

**Date:** 2026-05-24
**Status:** Accepted (default; operator may revisit before cloud activation)
**Closes:** DATAPLANE_INTEGRATION.md §10 R2 / cloud-validation-checkpoint-2026-05-24.md §6 R2

## Context

When cloud activation (Task #12) starts, the outbox queue's storage
backend has two viable shapes:

- **(a) Dataplane-fronted Postgres.** Outbox rows live in a
  Lore-owned collection backed by Dataplane's Postgres connector.
  Single source of truth; every Lore daemon replica reads/writes
  the same queue. Requires R3 (a documented "claim row" primitive
  with `FOR UPDATE SKIP LOCKED` semantics) before it works under
  concurrent dispatchers.
- **(b) Local SQLite sidecar.** Outbox stays in
  `outbox.sqlite` on the daemon's host (today's shape). Each
  replica owns its own queue; dispatcher flushes outbox rows to
  Dataplane via `/transaction`. Requires no Dataplane spec
  changes; matches today's local-first model.

## Decision

**Adopt (b) — local SQLite sidecar — as the default for cloud
activation v1.** Operator may revisit before cutover if scale
demands the shared-queue model.

## Rationale

1. **Preserves the local-first model.** Lore's current
   architecture (commit `c1864fb` and lineage) is
   local-first-with-cloud-provision. Shape (b) keeps the runtime
   contract identical: each daemon writes its outbox locally,
   then flushes. Shape (a) would change the contract — every
   write now requires Dataplane availability before the row is
   durable.
2. **Removes R3 as a Dataplane blocker.** With (b), no claim-row
   primitive is needed; the local SQLite already provides
   `SELECT … LIMIT … ORDER BY id` with the single-writer
   guarantee Sprint O established.
3. **Simpler crash-recovery story.** O5 / O6 invariants (crash
   mid-fanout → resume → no duplicates) survive unchanged.
   Shape (a) would require Dataplane to deliver equivalent
   semantics through its row-locking surface.
4. **Cheaper migration.** Shape (b) cloud cutover is a no-op for
   the outbox layer; only the *consumers* downstream of the
   dispatcher change substrate (Kùzu → Dataplane Graph,
   LanceDB → Dataplane Vector). Shape (a) would require a
   per-tenant outbox migration before any other cloud work.
5. **Path to (a) stays open.** If future scale requires the
   shared-queue model, the `OutboxStore` interface
   (`packages/lore/src/outbox/store.ts`) already abstracts the
   backend. Swap `SqliteOutboxStore` → `DataplaneOutboxStore`
   in one place; downstream code untouched.

## Consequences

- **Cloud activation v1 ships with per-replica outbox.** Multi-
  replica deployments run one dispatcher per replica; no shared
  claim semantics required.
- **R3 is downgraded from must-fix to deferred.** If/when shape
  (a) is reconsidered, R3 becomes blocking again. Tracked in
  DATAPLANE_INTEGRATION.md.
- **HA implications.** Each replica's outbox is bound to its
  host disk. Disaster-recovery now relies on (i) periodic
  Dataplane sync flushing every replica's outbox forward, plus
  (ii) the C2 backup CLI snapshotting the daemon's local
  state. Documented in the operator runbook.

## Alternatives considered

- **(a) immediately.** Rejected for v1: requires Dataplane spec
  change (R3) and a per-tenant migration before any cutover.
- **Hybrid.** Local SQLite for hot path + periodic flush of
  metadata to Dataplane. Rejected as over-engineered for v1.

## References

- DATAPLANE_INTEGRATION.md §10 (locked 2026-05-10)
- docs/audits/cloud-validation-checkpoint-2026-05-24.md §6 R2/R3
- packages/lore/src/outbox/sqliteStore.ts (today's impl)
- packages/lore/src/outbox/store.ts (pluggable interface)
