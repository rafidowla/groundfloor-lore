/**
 * arcadeRequestContext.ts — the per-request bound-cell slot for the ArcadeDB
 * tenant DATA plane (Cloud Slice 3).
 * (branch: spike/arcadedb-multitenant)
 *
 * MIRRORS src/security/routeWorkspaceBinding.ts's BindingSlot pattern, adapted
 * to db-per-app cells. Where the local dispatcher installs a
 * RouteWorkspaceBinding { target, lane } AsyncLocalStorage slot so every
 * workspace-addressed substrate open is confined to a validated target, the
 * arcade dispatcher additionally installs a CELL slot so the per-request deps
 * (StorageBundle / registry shim / verbatim-resolver shim) resolve the tenant's
 * ONE ArcadeDB cell — and only that cell — for the request's lifetime.
 *
 * INVARIANT (fail-closed, no active-cell fallback):
 *   - runWithArcadeCell(cell, fn) installs the slot for the duration of fn.
 *   - getArcadeCell() returns the slot's cell, or null when no slot is
 *     installed (a direct-call / non-arcade context).
 *   - requireArcadeCell() is the DATA-ROUTE accessor: an empty slot on a data
 *     route is a hard programmer error (the dispatcher must bind BEFORE the
 *     handler), so it THROWS rather than defaulting — there is NO active-cell
 *     fallback anywhere. This is the belt to routeWorkspaceBinding's braces:
 *     even if a route forgot to resolve a workspace, the cell it would reach is
 *     still fixed by the Bearer, never by a payload field.
 *
 * The cell is the frozen BoundArcadeCell from arcadeAuthResolver.ts: a token
 * resolves to EXACTLY ONE cell (fixed at issue time), so a filled slot names
 * exactly one tenant database. No request field can widen or re-point it.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { BoundArcadeCell } from './arcadeAuthResolver.js';

/** The canonical workspace string for a cell = its appId (one cell == one
 *  workspace, fixed at issue time). Local route gates compare a request's
 *  workspace param against this; a mismatch 403s exactly as local. */
export function cellWorkspace(cell: BoundArcadeCell): string {
  return cell.principal.appId;
}

interface CellSlot {
  cell: BoundArcadeCell;
}

const storage = new AsyncLocalStorage<CellSlot>();

/** Run `fn` with the bound cell installed in the request's cell slot. */
export function runWithArcadeCell<T>(cell: BoundArcadeCell, fn: () => T): T {
  return storage.run({ cell }, fn);
}

/** The current request's bound cell, or null when no slot is installed. */
export function getArcadeCell(): BoundArcadeCell | null {
  return storage.getStore()?.cell ?? null;
}

/**
 * requireArcadeCell — the DATA-ROUTE accessor. An empty slot here is NOT a
 * default-to-active situation (there is no active cell in arcade mode): it is a
 * dispatcher bug (the cell must be resolved and bound before any data handler
 * runs). Fail closed with a hard error so a mis-wired route can never silently
 * touch the wrong tenant.
 */
export function requireArcadeCell(): BoundArcadeCell {
  const cell = storage.getStore()?.cell;
  if (!cell) {
    throw new Error(
      '[arcadeRequestContext] no bound cell on a data route — the arcade ' +
        'dispatcher must resolve the Bearer to a cell and runWithArcadeCell() ' +
        'BEFORE the handler runs (fail-closed: there is no active-cell fallback).',
    );
  }
  return cell;
}
