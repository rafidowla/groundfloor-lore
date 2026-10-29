/**
 * postgresFieldIndexName.ts - names of the D10 per-field partial indexes on lore_entity_value.
 *
 * Old name: `lore_ev_<fieldId>_u|_i` - keyed by the field id alone, built over the value column alone.
 * New name: `lore_ev_<hash>_<fieldId>_u|_i`, keyed `(workspace_id, <value column>)`, where <hash> is a short stable
 * hash of the workspace's PERMANENT id. Putting the workspace in the key (and the name) makes the index
 * workspace-led, so it survives a workspace moving to another database or shard and cannot be mistaken for another
 * workspace's index of the same field id after a restore shifts identity values.
 *
 * The hash is sha256(workspace_id as UTF-8), first {@link FIELD_INDEX_HASH_LEN} hex characters. Contract-step SQL
 * (postgresWorkspaceSk.ts) recomputes it as `left(encode(sha256(convert_to(ws,'UTF8')),'hex'), N)`; keep both in step.
 */
import { createHash } from 'node:crypto';

export const FIELD_INDEX_HASH_LEN = 8;

/** Short stable hash of a workspace's permanent id. */
export function fieldIndexHash(workspaceId: string): string {
    return createHash('sha256').update(workspaceId, 'utf8').digest('hex').slice(0, FIELD_INDEX_HASH_LEN);
}

/** `lore_ev_<hash>_<fieldId>_u` (unique) or `_i` (plain). */
export function fieldIndexName(workspaceId: string, fieldId: number, kind: 'u' | 'i'): string {
    return `lore_ev_${fieldIndexHash(workspaceId)}_${fieldId}_${kind}`;
}

/** Pre-Phase-0 name, kept only for the contract step and for recognising old rows. */
export function legacyFieldIndexName(fieldId: number, kind: 'u' | 'i'): string {
    return `lore_ev_${fieldId}_${kind}`;
}

/** Field id out of either name shape (a unique-violation constraint name), or null. */
export function fieldIdOfIndexName(name: string, kind: 'u' | 'i' = 'u'): number | null {
    const m = new RegExp(`^lore_ev_(?:[0-9a-f]{${FIELD_INDEX_HASH_LEN}}_)?(\\d+)_${kind}$`).exec(name);
    return m ? Number(m[1]) : null;
}
