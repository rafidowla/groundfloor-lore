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
 * A whole-chunk sqlscript failure loses per-node granularity. 3.34.0 (M3b): it
 * used to be re-run per node IMMEDIATELY, even after a client-side timeout while
 * ArcadeDB could still be executing the original script (two overlapping writers
 * on the same ids). Now a failed script is SETTLED first: the chunk's ids are
 * re-read and each node is classified (see `settleChunk`) - applied -> ok,
 * provably not applied -> re-run alone, anything else -> `outcome_unknown` with
 * NO fallback write. Successful chunks never pay any of this.
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
import { tagsToArray } from '../normalizeTags.js';
import { encodeNodeScopes, resolveNodeScopes } from './arcadeNodeScopes.js';
import { ArcadeHttpError } from './arcadeHttp.js';
import { OutcomeUnknownError, isOutcomeUnknown } from '../graphShared/writeOutcome.js';
import { log } from '../../logger.js';

type NodeInput = Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>;
type UpsertResult = { id: string; ok: boolean; error?: string; currentRevision?: number | null };
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
  'security_scopes',
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

/** Error class for logs, e.g. `ArcadeHttpError(503)`. Never the message (it can carry row content). */
function errorClass(e: unknown): string {
  if (e instanceof ArcadeHttpError) return `ArcadeHttpError(${e.status})`;
  return e instanceof Error ? e.name : typeof e;
}

/** A transport/server failure (ArcadeDB answered an error, timed out, or the socket failed). Anything else is a bug and propagates. */
function isTransportFailure(e: unknown): boolean {
  if (e instanceof ArcadeHttpError) return true;
  const x = e as { message?: unknown; code?: unknown } | null;
  return (typeof x?.message === 'string' && x.message.startsWith('[ArcadeHttp]')) || typeof x?.code === 'string';
}

interface Prior { existed: boolean; revision: number; createdAt: string; scopes: unknown }

async function upsertChunk(
  tenantDb: string,
  http: ArcadeHttp,
  chunk: NodeInput[],
  singleUpsert: SingleUpsert,
): Promise<UpsertResult[]> {
  if (chunk.length === 0) return [];
  const now = new Date().toISOString();

  // Pre-fetch existing createdAts (and security_scopes, so an upsert that omits
  // scopes keeps the prior labels - SQLite parity) for the chunk's ids in one
  // query so an UPSERT of an existing node preserves its original createdAt.
  // The revision is kept too: it is the baseline `settleChunk` compares against.
  const ids = chunk.map((n) => n.id);
  const prior = new Map<string, Prior>();
  try {
    const existing = await http.query(
      tenantDb,
      `SELECT id, createdAt, security_scopes, revision FROM ${NODE_TYPE} WHERE id IN :ids`,
      { ids },
    );
    for (const row of (existing.result ?? []) as Array<Record<string, unknown>>) {
      const rid = String(row['id'] ?? '');
      if (rid) {
        prior.set(rid, {
          existed: true,
          revision: typeof row['revision'] === 'number' ? row['revision'] : 0,
          createdAt: String(row['createdAt'] ?? now),
          scopes: row['security_scopes'],
        });
      }
    }
  } catch (e) {
    if (!isTransportFailure(e)) throw e;
    // A failed READ applied nothing, so writing the chunk node by node is safe;
    // singleUpsert does its own read-modify-write.
    log.warn(`[arcadeBulk] chunk pre-fetch failed (${errorClass(e)}); writing the chunk per node`);
    return perNodeFallback(chunk, singleUpsert);
  }

  const statements: string[] = [];
  const params: Record<string, unknown> = {};
  chunk.forEach((node, idx) => {
    const p = `n${idx}_`;
    // The DATABASE bumps the revision (a new row's NULL reads as 0 -> 1).
    const assignments = SET_FIELDS.map((f) => `${f} = :${p}${f}`).join(', ') + ', revision = ifnull(revision, 0) + 1';
    statements.push(`UPDATE ${NODE_TYPE} SET ${assignments} UPSERT WHERE id = :${p}id;`);
    params[`${p}id`] = node.id;
    params[`${p}type`] = node.type ?? '';
    params[`${p}label`] = node.label ?? '';
    params[`${p}content`] = node.content ?? '';
    params[`${p}tags`] = JSON.stringify(tagsToArray(node.tags));
    params[`${p}project`] = node.project ?? '';
    params[`${p}ecosystem`] = node.ecosystem ?? '';
    params[`${p}metadata`] = node.metadata ?? '';
    params[`${p}createdAt`] = prior.get(node.id)?.createdAt ?? now;
    params[`${p}updatedAt`] = now;
    params[`${p}supersededBy`] = node.supersededBy ?? '';
    params[`${p}supersededAt`] = node.supersededAt ?? '';
    params[`${p}supersededReason`] = node.supersededReason ?? '';
    params[`${p}stale`] = node.stale ?? false;
    params[`${p}staleAt`] = (node as { staleAt?: string }).staleAt ?? '';
    params[`${p}ephemeral`] = node.ephemeral ?? false;
    params[`${p}ttl_ms`] = node.ttl_ms ?? 0;
    params[`${p}security_scopes`] = encodeNodeScopes(resolveNodeScopes(node.security_scopes, prior.get(node.id)?.scopes));
  });

  try {
    await http.commandScript(tenantDb, statements.join('\n'), params);
    return chunk.map((n) => ({ id: n.id, ok: true }));
  } catch (e) {
    if (!isTransportFailure(e)) throw e;
    log.warn(`[arcadeBulk] chunk script failed (${errorClass(e)}); settling ${chunk.length} item(s) by re-read before any re-run`);
    return settleChunk(tenantDb, http, chunk, prior, now, e, singleUpsert);
  }
}

/**
 * settleChunk - after a failed chunk script (a client-side timeout leaves the outcome open: ArcadeDB
 * may still be running it), decide each item from the CURRENT rows, never blindly re-run:
 *   applied            updatedAt is this script's timestamp and revision is prior + 1  -> ok
 *   provably not       absent and absent before, or still at its prior revision with an
 *                      older updatedAt                                                   -> re-run alone
 *   anything else      moved by someone else, vanished, or the re-read itself failed  -> outcome_unknown,
 *                      NO write (the caller keeps its outbox row; slice 1 contract)
 */
async function settleChunk(
  tenantDb: string,
  http: ArcadeHttp,
  chunk: NodeInput[],
  prior: Map<string, Prior>,
  stamp: string,
  cause: unknown,
  singleUpsert: SingleUpsert,
): Promise<UpsertResult[]> {
  const unknown = (id: string, rev: number | null | undefined): UpsertResult => ({
    id,
    ok: false,
    error: new OutcomeUnknownError(id, rev, cause).message,
    ...(rev !== undefined ? { currentRevision: rev } : {}),
  });
  const current = new Map<string, { revision: number; updatedAt: string }>();
  try {
    const res = await http.query(
      tenantDb,
      `SELECT id, revision, updatedAt FROM ${NODE_TYPE} WHERE id IN :ids`,
      { ids: chunk.map((n) => n.id) },
    );
    for (const row of (res.result ?? []) as Array<Record<string, unknown>>) {
      const id = String(row['id'] ?? '');
      if (id) current.set(id, { revision: typeof row['revision'] === 'number' ? row['revision'] : 0, updatedAt: String(row['updatedAt'] ?? '') });
    }
  } catch (readErr) {
    if (!isTransportFailure(readErr)) throw readErr;
    log.warn(`[arcadeBulk] settle re-read failed (${errorClass(readErr)}); ${chunk.length} item(s) outcome_unknown`);
    return chunk.map((n) => unknown(n.id, undefined));
  }
  const out: UpsertResult[] = [];
  for (const node of chunk) {
    const before = prior.get(node.id);
    const baseline = before?.revision ?? 0;
    const now = current.get(node.id);
    if (now && now.updatedAt === stamp && now.revision === baseline + 1) {
      out.push({ id: node.id, ok: true });
    } else if ((!before && !now) || (before && now && now.revision === baseline && now.updatedAt !== stamp)) {
      // eslint-disable-next-line no-await-in-loop
      out.push(...(await perNodeFallback([node], singleUpsert)));
    } else {
      out.push(unknown(node.id, now ? now.revision : null));
    }
  }
  return out;
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
      const cur = isOutcomeUnknown(e) ? (e as OutcomeUnknownError).currentRevision : undefined;
      out.push({ id: node.id, ok: false, error: (e as Error).message, ...(cur !== undefined ? { currentRevision: cur } : {}) });
    }
  }
  return out;
}
