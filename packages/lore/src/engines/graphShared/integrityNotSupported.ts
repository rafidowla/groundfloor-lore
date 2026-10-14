/**
 * integrityNotSupported.ts — the explicit "this engine has no such failure mode" answer for the
 * optional integrity capability (`GraphProvider.integrityScan` / `integrityRemove`). Never a silent
 * success: the repair route relays `status: 'not_supported'` and the reason to the operator.
 */
export function notSupportedIntegrity(reason: string): { supported: false; status: 'not_supported'; reason: string } {
    return { supported: false, status: 'not_supported', reason };
}

/** SQLite: node lookups and rows live in one table behind one primary key, so no row can be
 *  invisible to the id lookup. There is no separate index to diverge from the storage. */
export const SQLITE_INTEGRITY_REASON =
    'SQLite stores nodes in one table keyed by id; a row cannot exist without its index entry, so there is nothing to repair';

/** Dataplane: the cloud store owns its own index and exposes no record-level scan or by-record-id
 *  delete through the SDK. Supporting this would need a Dataplane admin endpoint that lists records
 *  absent from the id lookup and deletes them by internal record id. */
export const dataplaneIntegrityReason =
    'Dataplane owns its record index and exposes no record-level scan or delete-by-record-id; a repair would need a Dataplane admin endpoint';
