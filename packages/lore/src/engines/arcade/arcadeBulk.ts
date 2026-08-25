/**
 * arcadeBulk.ts — batched single-round-trip bulkUpsertNodes for the ArcadeDB
 * db-per-app adapter (branch: spike/arcadedb-multitenant, slice 2).
 *
 * The facade (LoreStorageClient.bulkUpsertNodes) feature-detects a
 * `bulkUpsertNodes` method on the graph handle and calls it instead of looping
 * `upsertNode` N times. This implements that method so an arcade cell gets the
 * same ≤ceil(N/chunk) round-trip batching LocalGraph gets from its single
 * prepared-statement loop — verified live on 26.7.1: `language:"sqlscript"`
 * runs N numbered-param UPSERT statements in ONE HTTP command.
 *
 * PER-NODE RESULT CONTRACT: returns `{id, ok, error}[]` (GraphProvider contract).
 * A whole-chunk sqlscript failure loses per-node granularity, so on chunk
 * failure we FALL BACK to per-node upsert for just that chunk — every node
 * still gets its own ok/error. Successful chunks never pay that cost.
 *
 * createdAt preservation: an UPSERT sets every listed column on BOTH insert and
 * update, so a naïve batch would reset createdAt on existing rows. We pre-fetch
 * the chunk's existing createdAts in ONE query and bind the correct value per
 * node (existing row → its stored createdAt; new row → now) — parity with
 * LocalGraph.bulkUpsertNodes, which keeps createdAt on its SET branch. Lifecycle
 * columns (supersededBy/…, stale, ephemeral, ttl_ms) are carried from the input
 * node with schema-default fallbacks.
 *
 * TRAP POSTURE: plain UPSERT statements on the LoreNode vertex table — no
 * expand()/both(), so traps T1/T2 don't apply.
 */

import type { LoreNode } from '../../providers/types.js';
import type { ArcadeHttp } from './arcadeHttp.js';
import { NODE_TYPE } from './arcadeSchema.js';

type NodeInput = Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>;
type UpsertResult = { id: string; ok: boolean; error?: string };
type SingleUpsert = (node: NodeInput) => Promise<LoreNode>;

/** Statements per sqlscript round-trip. ~50 keeps each command bounded. */
const CHUNK_SIZE = 50;

/** The columns a single node's UPSERT sets, in statement order. */
const SET_FIELDS = [
  'id',
  'type',
  'label',
  'content',
  'tags',
  'project',
  'ecosystem',
  'metadata',
  'createdAt',
  'updatedAt',
  'supersededBy',
  'supersededAt',
  'supersededReason',
  'stale',
  'staleAt',
  'ephemeral',
  'ttl_ms',
] as const;

export async function bulkUpsertNodes(
  tenantDb: string,
  http: ArcadeHttp,
  batch: NodeInput[],
  singleUpsert: SingleUpsert,
): Promise<UpsertResult[]> {
  const results: UpsertResult[] = [];
  for (let i = 0; i < batch.length; i += CHUNK_SIZE) {
    const chunk = batch.slice(i, i + CHUNK_SIZE);
    // eslint-disable-next-line no-await-in-loop
    const chunkResults = await upsertChunk(tenantDb, http, chunk, singleUpsert);
    results.push(...chunkResults);
  }
  return results;
}

async function upsertChunk(
  tenantDb: string,
  http: ArcadeHttp,
  chunk: NodeInput[],
  singleUpsert: SingleUpsert,
): Promise<UpsertResult[]> {
  if (chunk.length === 0) return [];
  const now = new Date().toISOString();

  // Pre-fetch existing createdAts for the chunk's ids in one query so an
  // UPSERT of an existing node preserves its original createdAt.
  const ids = chunk.map((n) => n.id);
  const createdAtById = new Map<string, string>();
  try {
    const existing = await http.query(
      tenantDb,
      `SELECT id, createdAt FROM ${NODE_TYPE} WHERE id IN :ids`,
      { ids },
    );
    for (const row of (existing.result ?? []) as Array<Record<string, unknown>>) {
      const rid = String(row['id'] ?? '');
      if (rid) createdAtById.set(rid, String(row['createdAt'] ?? now));
    }
  } catch {
    // If the pre-fetch fails, fall through to the per-node fallback below,
    // which does its own read-modify-write via singleUpsert.
    return perNodeFallback(chunk, singleUpsert);
  }

  const statements: string[] = [];
  const params: Record<string, unknown> = {};
  chunk.forEach((node, idx) => {
    const p = `n${idx}_`;
    const assignments = SET_FIELDS.map((f) => `${f} = :${p}${f}`).join(', ');
    statements.push(`UPDATE ${NODE_TYPE} SET ${assignments} UPSERT WHERE id = :${p}id;`);
    params[`${p}id`] = node.id;
    params[`${p}type`] = node.type ?? '';
    params[`${p}label`] = node.label ?? '';
    params[`${p}content`] = node.content ?? '';
    params[`${p}tags`] = JSON.stringify(node.tags ?? []);
    params[`${p}project`] = node.project ?? '';
    params[`${p}ecosystem`] = node.ecosystem ?? '';
    params[`${p}metadata`] = node.metadata ?? '';
    params[`${p}createdAt`] = createdAtById.get(node.id) ?? now;
    params[`${p}updatedAt`] = now;
    params[`${p}supersededBy`] = node.supersededBy ?? '';
    params[`${p}supersededAt`] = node.supersededAt ?? '';
    params[`${p}supersededReason`] = node.supersededReason ?? '';
    params[`${p}stale`] = node.stale ?? false;
    params[`${p}staleAt`] = (node as { staleAt?: string }).staleAt ?? '';
    params[`${p}ephemeral`] = node.ephemeral ?? false;
    params[`${p}ttl_ms`] = node.ttl_ms ?? 0;
  });

  try {
    await http.commandScript(tenantDb, statements.join('\n'), params);
    return chunk.map((n) => ({ id: n.id, ok: true }));
  } catch {
    // Whole-chunk failure loses per-node granularity — retry the chunk one
    // node at a time so each node gets its own {ok,error} (contract).
    return perNodeFallback(chunk, singleUpsert);
  }
}

async function perNodeFallback(
  chunk: NodeInput[],
  singleUpsert: SingleUpsert,
): Promise<UpsertResult[]> {
  const out: UpsertResult[] = [];
  for (const node of chunk) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await singleUpsert(node);
      out.push({ id: node.id, ok: true });
    } catch (e) {
      out.push({ id: node.id, ok: false, error: (e as Error).message });
    }
  }
  return out;
}
