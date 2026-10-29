/**
 * partitionKey.ts - the engine-neutral `partitionKey` contract (Phase 0, lane L3).
 *
 * A node may carry an optional, caller-chosen `partitionKey` (a shard/placement
 * hint for later phases). Rules, identical on every engine:
 *
 *   - Omitted (`undefined`) means "no opinion": a new node stores `''`, an
 *     existing node keeps whatever it has. `''` is the unkeyed default.
 *   - '' -> 'x' is allowed once (a key can be assigned to an unkeyed node).
 *   - A non-empty key never changes afterwards. An upsert that would change it
 *     (to another value, or back to `''`) is refused with
 *     {@link PartitionKeyImmutableError} (`PARTITION_KEY_IMMUTABLE`); the caller
 *     deletes and re-inserts the node to move it.
 *   - Edges inherit their source node's key at insert; verbatim rows inherit
 *     their node's key. Existing edges/verbatim rows are NOT re-keyed when a
 *     node later goes '' -> 'x' (documented limitation; Phase 3 owns re-keying).
 *
 * The key is not used by recall in this phase; it is stored and read back.
 */

export const PARTITION_KEY_MAX_LENGTH = 128;

/** Typed refusal: an upsert tried to change an existing node's non-empty partition key. */
export class PartitionKeyImmutableError extends Error {
    readonly code = 'PARTITION_KEY_IMMUTABLE';
    constructor(
        public readonly nodeId: string,
        public readonly currentKey: string,
        public readonly requestedKey: string,
    ) {
        super(
            `PARTITION_KEY_IMMUTABLE: node '${nodeId}' already has partitionKey '${currentKey}' and cannot be changed to `
            + `'${requestedKey}'; delete the node and insert it again to move it`,
        );
        this.name = 'PartitionKeyImmutableError';
    }
}

export function isPartitionKeyImmutable(err: unknown): err is PartitionKeyImmutableError {
    return err instanceof PartitionKeyImmutableError
        || (typeof err === 'object' && err !== null
            && (err as { code?: unknown }).code === 'PARTITION_KEY_IMMUTABLE'
            && (err as { name?: unknown }).name === 'PartitionKeyImmutableError');
}

/** `ok:false` carries a message naming the rule that failed. */
export function validatePartitionKey(value: unknown): { ok: true } | { ok: false; error: string } {
    if (typeof value !== 'string') return { ok: false, error: 'partitionKey must be a string' };
    if (value.length > PARTITION_KEY_MAX_LENGTH) {
        return { ok: false, error: `partitionKey must be at most ${PARTITION_KEY_MAX_LENGTH} characters (got ${value.length})` };
    }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)) {
        return { ok: false, error: 'partitionKey must not contain control characters' };
    }
    return { ok: true };
}

/**
 * The key a write will leave stored, and whether it is refused: `requested`
 * (undefined = keep) against the `prior` stored value ('' / undefined = unkeyed).
 */
export function resolvePartitionKey(
    nodeId: string,
    requested: string | undefined,
    prior: string | undefined,
): string {
    const current = prior ?? '';
    if (requested === undefined) return current;
    if (current !== '' && requested !== current) throw new PartitionKeyImmutableError(nodeId, current, requested);
    return requested;
}

/** L3: surface the stored key as `partitionKey` only when non-empty (an unkeyed row's shape is unchanged); drop the raw column. */
export function withPartitionKeyProperty(row: Record<string, unknown>): Record<string, unknown> {
    const { partition_key: pk, ...rest } = row;
    return typeof pk === 'string' && pk.length > 0 ? { ...rest, partitionKey: pk } : rest;
}
