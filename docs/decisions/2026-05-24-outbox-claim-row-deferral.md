# Decision — Outbox claim-row primitive deferral (R3)

**Date:** 2026-05-24
**Status:** Accepted (consequence of R2 choosing shape (b))
**Closes:** DATAPLANE_INTEGRATION.md §10 R3 / cloud-validation-checkpoint-2026-05-24.md §6 R3

## Context

R3 (audit §6) flagged that a Dataplane Postgres-backed outbox
would need `SELECT … FOR UPDATE SKIP LOCKED` to claim a batch
under concurrent dispatchers. Dataplane's documented surface
(CRUD + `/transaction` + bulk) does not expose row-level locking;
`executeRaw` is deprecated/blocked for tenant API keys.

## Decision

**Defer R3 indefinitely.** Per
`docs/decisions/2026-05-24-cloud-outbox-storage.md` (R2), the
cloud outbox stays SQLite-sidecar (shape (b)). Without a shared
Postgres outbox, the claim-row primitive is no longer needed.

## Conditions that would re-open R3

- Operator revisits R2 and adopts shape (a) (shared Postgres
  outbox).
- Multi-region active-active deployment with a shared queue
  becomes a requirement.
- A future Dataplane release ships row-level claim semantics
  natively (would unblock shape (a) at low cost).

## Working operational workaround

For the SQLite-sidecar shape, the existing single-writer
guarantee (one dispatcher per replica) is sufficient. If
multiple dispatchers per replica ever ship, the SQLite
`UPDATE … SET claimed_by = ? WHERE id IN (SELECT id FROM
outbox_rows WHERE claimed_by IS NULL LIMIT ?)` pattern
(today's behaviour) already gives the same atomic-claim
semantics — Postgres-equivalent locking is not required.

## References

- docs/audits/cloud-validation-checkpoint-2026-05-24.md §6 R3
- docs/decisions/2026-05-24-cloud-outbox-storage.md (R2)
- DATAPLANE_INTEGRATION.md §10
- packages/lore/src/outbox/sqliteStore.ts
