/**
 * dataplaneCollections.ts — canonical Dataplane collection names.
 *
 * Shared by DataplaneGraph and its extracted helper modules so the magic
 * strings live in exactly one place (and there is no circular import between
 * the adapter and its helpers).
 */

export const NODE_COLLECTION = 'lore_node';
export const EDGE_COLLECTION = 'lore_edge';
