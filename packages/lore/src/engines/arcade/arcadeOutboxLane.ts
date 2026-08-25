/**
 * arcadeOutboxLane.ts — the per-request cell-key decorator over the ONE shared
 * daemon SqliteOutboxStore (spike/arcadedb-multitenant, Slice 4).
 *
 * ── DECISION: one store, N logical lanes ─────────────────────────────────────
 * Arcade uses a SINGLE daemon SqliteOutboxStore (constructed in arcadeBoot),
 * keyed per cell in the EXISTING `workspace` column with a canonical cell key
 * `arcade:<tenantId>:<appId>`. Not per-cell files: the store already has
 * per-workspace sequenceIds, cursors, listPendingForWorkspace, and lag
 * machinery keyed by that column.
 *
 * The `:`-delimited, `arcade:`-prefixed key CANNOT collide: tenant/app ids are
 * [a-z0-9]+ (provisioner NAME_RE) and local workspace slugs cannot contain ':'.
 * Keying by BARE appId is FORBIDDEN — two tenants sharing an appId would
 * interleave lanes and misroute replays. cellWorkspace() (= appId) is only safe
 * intra-request because the shim closes over the cell; the outbox is not
 * request-scoped, so it must use the FULL (tenant,app) key.
 *
 * The decorator is per-request (built next to the registry shim). The delegated
 * local routes call record() with `workspace = cellWorkspace = appId`; the
 * decorator overwrites entry.workspace with the cell key on the way through.
 * Every other surface (markStep, cursors, listPending, ...) passes through
 * untouched.
 */

import type { OutboxStore, OutboxEntry } from '../../outbox/types.js';
import type { OutboxLagCache, BackpressureDecision } from '../../outbox/lagCache.js';

/** The canonical, collision-proof outbox lane key for a cell. */
export function arcadeCellKey(tenantId: string, appId: string): string {
  return `arcade:${tenantId}:${appId}`;
}

/** Parse an `arcade:<t>:<a>` lane key back to its parts, or null when the key is
 *  not arcade-shaped (the replicator uses this to fail loud on a foreign row). */
export function parseArcadeCellKey(key: string): { tenantId: string; appId: string } | null {
  const m = /^arcade:([a-z0-9]+):([a-z0-9]+)$/.exec(key);
  if (!m) return null;
  return { tenantId: m[1]!, appId: m[2]! };
}

/**
 * cellOutboxStore — wrap a shared OutboxStore so every entry RECORDED through it
 * lands under the cell's canonical lane key, regardless of the `workspace` the
 * caller set. Reads/cursors/step-updates pass through unchanged.
 *
 * The wrapper is a thin Proxy-free delegate: it re-exposes the full OutboxStore
 * surface, overriding only `record`. Optional methods are forwarded when the
 * underlying store implements them (so a legacy store still satisfies the type).
 */
export function cellOutboxStore(store: OutboxStore, cellKey: string): OutboxStore {
  const wrapped: OutboxStore = {
    record: (entry: OutboxEntry) => store.record({ ...entry, workspace: cellKey }),
    markStep: (id, idx, status, error) => store.markStep(id, idx, status, error),
    markCompleted: (id) => store.markCompleted(id),
    remove: (id) => store.remove(id),
    listUnfinished: () => store.listUnfinished(),
  };
  // batchRecord (bulk write path) must ALSO rewrite the lane key, or a bulk
  // endpoint would bypass the per-request cell keying and interleave lanes.
  if (store.batchRecord) {
    wrapped.batchRecord = (entries) =>
      store.batchRecord!(entries.map((e) => ({ ...e, workspace: cellKey })));
  }
  // Forward the optional replicator/health surface when present.
  if (store.removeIfPending) wrapped.removeIfPending = (id) => store.removeIfPending!(id);
  if (store.listPendingForWorkspace)
    wrapped.listPendingForWorkspace = (ws, limit) => store.listPendingForWorkspace!(ws, limit);
  if (store.listWorkspacesWithPending)
    wrapped.listWorkspacesWithPending = () => store.listWorkspacesWithPending!();
  if (store.markEntryStatus)
    wrapped.markEntryStatus = (id, status, info) => store.markEntryStatus!(id, status, info);
  if (store.readReplicationState)
    wrapped.readReplicationState = (ws) => store.readReplicationState!(ws);
  if (store.writeReplicationState)
    wrapped.writeReplicationState = (ws, state) => store.writeReplicationState!(ws, state);
  return wrapped;
}

/**
 * cellLagCache — wrap the shared OutboxLagCache so a delegated route's
 * `shouldBackpressure(requestedWorkspace)` call (requestedWorkspace =
 * cellWorkspace = appId) resolves against the cell's CANONICAL lane key
 * (`arcade:<tenantId>:<appId>`), where the replicator actually accumulated the
 * lag. Without this the producer would query lag under the bare appId — a key
 * the arcade outbox never writes — and always fail-open (never backpressure).
 *
 * Mirrors cellOutboxStore's per-request keying: the wrapper closes over the
 * bound cell key, so the `ws` argument can never select another cell's lag.
 * Only `shouldBackpressure` is on the hot path (checkOutboxBackpressure reads
 * nothing else); the remaining OutboxLagCache surface is forwarded for type
 * compatibility.
 */
export function cellLagCache(
  cache: Pick<OutboxLagCache, 'shouldBackpressure'>,
  cellKey: string,
): { shouldBackpressure: (ws: string) => BackpressureDecision } {
  return {
    shouldBackpressure: (_ws: string) => cache.shouldBackpressure(cellKey),
  };
}
