/**
 * dataplaneCollections.ts — canonical Dataplane collection names.
 *
 * Shared by DataplaneGraph and its extracted helper modules so the magic
 * strings live in exactly one place (and there is no circular import between
 * the adapter and its helpers).
 */

export const NODE_COLLECTION = 'lore_node';
export const EDGE_COLLECTION = 'lore_edge';
/** Node version history + changesets (cloud parity C item 8; replaces the local versions.sqlite). */
export const VERSION_COLLECTION = 'lore_version';
