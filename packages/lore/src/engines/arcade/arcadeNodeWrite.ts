/**
 * arcadeNodeWrite.ts - the SET-clause fragments and bound parameters every
 * ArcadeDB node write shares (plain upsert, keep-revision, conditional, replay,
 * insert-if-absent). Split out of arcadeGraphStore.ts to keep that file under
 * the size cap; no behaviour of its own.
 */

import { tagsToArray } from '../normalizeTags.js';
import type { LoreNode } from '../../providers/types.js';
import { encodeNodeScopes, resolveNodeScopes } from './arcadeNodeScopes.js';

/** The column assignments shared by every node write; the `revision` assignment is appended per mode. */
export const NODE_SET_COLUMNS =
  `id = :id, type = :type, label = :label, ` +
    `content = :content, tags = :tags, project = :project, ` +
    `ecosystem = :ecosystem, metadata = :metadata, ` +
    `createdAt = :createdAt, updatedAt = :updatedAt, ` +
    `supersededBy = :supersededBy, supersededAt = :supersededAt, ` +
    `supersededReason = :supersededReason, stale = :stale, staleAt = :staleAt, ` +
    `ephemeral = :ephemeral, ttl_ms = :ttl_ms, ` +
    `success_count = :success_count, failure_count = :failure_count, ` +
    `partial_count = :partial_count, confirmation_score = :confirmation_score, ` +
    `security_scopes = :security_scopes`;
/** Plain UPSERT / conditional UPDATE: the DATABASE bumps (a new row's NULL reads as 0, so it lands on 1). */
export const NODE_SET_CLAUSE = `${NODE_SET_COLUMNS}, revision = ifnull(revision, 0) + 1`;
/** Counter-only write on an EXISTING row: the revision is not touched. */
export const NODE_KEEP_CLAUSE = NODE_SET_COLUMNS;
/** A fresh row starts at revision 1. */
export const NODE_INSERT_CLAUSE = `${NODE_SET_COLUMNS}, revision = 1`;
/** Outbox replay: the payload's revision is written verbatim (no bump). */
export const NODE_REPLAY_CLAUSE = `${NODE_SET_COLUMNS}, revision = :revision`;

/** Bound parameters of a node write; `existing` supplies the read-modify-write defaults. */
export function nodeWriteParams(
  node: Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>,
  existing: LoreNode | null,
  now: string,
  createdAtOverride?: string,
) {
  const createdAt = existing?.createdAt ?? createdAtOverride ?? now;
  // Lifecycle columns are read-modify-write like LocalGraph.upsertNode: an
  // upsert that omits ephemeral/ttl_ms must NOT clobber a value a prior write
  // set. Preserve the existing row's lifecycle fields when the incoming node
  // doesn't carry them; a plain re-store therefore doesn't reset supersession
  // or the ephemeral flag (parity with LocalGraph's SET-branch semantics).
  return {
    id: node.id,
    type: node.type ?? '',
    label: node.label ?? '',
    content: node.content ?? '',
    tags: JSON.stringify(tagsToArray(node.tags)),
    project: node.project ?? '',
    // WIRE PARITY (slice-3 close): default ecosystem/metadata to the SAME
    // store-time defaults LocalGraph's schema uses (ecosystem DEFAULT '*';
    // metadata read-back defaults to '{}'), so a node posted without these
    // fields round-trips identically on both backends instead of persisting an
    // empty string that rowToLoreNode's `?? '*'` / `?? '{}'` can't rescue.
    ecosystem: node.ecosystem && node.ecosystem.length > 0 ? node.ecosystem : '*',
    metadata: node.metadata && node.metadata.length > 0 ? node.metadata : '{}',
    createdAt,
    updatedAt: now,
    supersededBy: node.supersededBy ?? existing?.supersededBy ?? '',
    supersededAt: node.supersededAt ?? existing?.supersededAt ?? '',
    supersededReason: node.supersededReason ?? existing?.supersededReason ?? '',
    stale: node.stale ?? existing?.stale ?? false,
    staleAt: (node as { staleAt?: string }).staleAt ?? (existing as { staleAt?: string } | null)?.staleAt ?? '',
    ephemeral: node.ephemeral ?? existing?.ephemeral ?? false,
    ttl_ms: node.ttl_ms ?? existing?.ttl_ms ?? 0,
    // Feature-2 outcome counters — read-modify-write preserve (like the
    // lifecycle columns): a plain re-store must not reset counts a prior
    // record_outcome set. Default 0 / 0.0 on first insert (LocalGraph schema
    // default) so a fresh node's full-projection read emits 0, not undefined.
    success_count: node.success_count ?? existing?.success_count ?? 0,
    failure_count: node.failure_count ?? existing?.failure_count ?? 0,
    partial_count: node.partial_count ?? existing?.partial_count ?? 0,
    confirmation_score: node.confirmation_score ?? existing?.confirmation_score ?? 0,
    // Row-level scopes (v4) - SQLite parity: explicit array (incl. []) wins,
    // omitted keeps the prior row's, new node -> [] (public).
    security_scopes: encodeNodeScopes(resolveNodeScopes(node.security_scopes, existing?.security_scopes)),
  };
}
