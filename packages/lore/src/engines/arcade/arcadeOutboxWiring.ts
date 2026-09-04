/**
 * arcadeOutboxWiring.ts — the CONSUMER side of the arcade outbox: an
 * OutboxReplicator whose DispatcherSubstrates fan out to per-cell RAW ArcadeDB
 * adapters (spike/arcadedb-multitenant, Slice 4).
 *
 * Do NOT extend outbox/wiring.ts — that file is local-substrate-shaped (graph engine +
 * LanceDB + sync engine). This is the arcade-shaped analogue.
 *
 * ── RESOLUTION ───────────────────────────────────────────────────────────────
 * The outbox `workspace` column carries the canonical cell key
 * `arcade:<tenantId>:<appId>` (arcadeOutboxLane.arcadeCellKey). resolve() parses
 * it and builds/reuses RAW ArcadeGraphStore/ArcadeVectorStore from the
 * provisioner registry (getTenantApp + readSecretAsync) — NEVER via a tenant
 * token: replay must survive token rotation/revocation/expiry, and the per-db
 * service user is the same 403-walled reach. A local-shaped (non-arcade-keyed)
 * row in an arcade daemon is a BUG → fail loud (the row goes failed/dead, never
 * applied anywhere).
 *
 * ── ISOLATION (carried from outbox/wiring.ts R2#2) ───────────────────────────
 * A resolve failure (cell transiently missing / disabled) leaves the row
 * PENDING — never falls back to any other cell.
 *
 * ── EMBED-AT-REPLAY ──────────────────────────────────────────────────────────
 * upsertVerbatim → ArcadeVectorStore.store() embeds inline (same
 * durability-over-latency trade as local queued mode; recall visibility becomes
 * async — tests drive replicator.tickOnce()). embed.batch / sync.vector.mirror
 * are NOT produced in arcade (ArcadeVectorStore embeds inline), so they stay
 * UNWIRED.
 */

import type { OutboxStore } from '../../outbox/types.js';
import type { DispatcherSubstrates } from '../../outbox/dispatcher.js';
import type { OutboxLagCache } from '../../outbox/lagCache.js';
import { OutboxReplicator, wireReplicator } from '../../outbox/replicator.js';
import type { EmbeddingProvider } from '../../providers/types.js';
import type { LoreNode, LoreEdge } from '../../providers/types.js';
import { ArcadeHttp } from './arcadeHttp.js';
import { ArcadeGraphStore } from './arcadeGraphStore.js';
import { ArcadeVectorStore } from './arcadeVectorStore.js';
import { getTenantApp, readSecretAsync, ARCADE_BASE_URL } from './arcadeProvisioner.js';
import { parseArcadeCellKey } from './arcadeOutboxLane.js';

interface CellAdapters {
  graph: ArcadeGraphStore;
  vector: ArcadeVectorStore;
}

/** A resolve failure that MUST leave the row pending (transient cell absence),
 *  as opposed to a fail-loud programmer error (foreign key). */
class CellResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CellResolveError';
  }
}

export interface ArcadeReplicatorHandle {
  readonly replicator: OutboxReplicator;
  /** Evict a cell's cached adapters — called by the same disable/destroy hooks
   *  that evict the cell pool, so a rotated/torn-down cell doesn't keep a stale
   *  service-account connection. */
  evictCell(tenantId: string, appId: string): void;
  start(): void;
  stop(): Promise<void>;
}

/**
 * wireArcadeReplicator — construct the arcade outbox replicator over the ONE
 * shared daemon store. The adapter cache is a small LRU keyed by cell.
 */
export function wireArcadeReplicator(input: {
  store: OutboxStore;
  lagCache?: OutboxLagCache;
  /** Shared embedder so every cell's vector store doesn't reload the ~120MB
   *  model (test/perf hook). */
  embedder?: EmbeddingProvider;
  baseUrl?: string;
  log?: (msg: string) => void;
  maxCachedCells?: number;
}): ArcadeReplicatorHandle {
  const baseUrl = input.baseUrl ?? ARCADE_BASE_URL;
  const maxCells = input.maxCachedCells ?? 64;
  const cache = new Map<string, CellAdapters>();

  function cacheKey(t: string, a: string): string {
    return `${t}::${a}`;
  }

  async function resolveCell(workspaceKey?: string): Promise<CellAdapters> {
    if (!workspaceKey) {
      // A row with no workspace key in an arcade daemon is a hard bug — fail
      // loud (the row will go failed/dead, never applied).
      throw new Error('[arcadeOutboxWiring] outbox row has no workspace key');
    }
    const parsed = parseArcadeCellKey(workspaceKey);
    if (!parsed) {
      // Foreign / local-shaped key — fail LOUD, never resolve to some cell.
      throw new Error(
        `[arcadeOutboxWiring] non-arcade-keyed outbox row "${workspaceKey}" in an arcade daemon (bug)`,
      );
    }
    const { tenantId, appId } = parsed;
    const key = cacheKey(tenantId, appId);
    const hit = cache.get(key);
    if (hit) {
      // LRU touch.
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }
    const cell = getTenantApp({ customerId: tenantId, appId });
    if (!cell || cell.status !== 'active') {
      // Transient absence (cell missing/disabled) — leave the row PENDING.
      throw new CellResolveError(
        `cell (${tenantId}, ${appId}) is not active; leaving row pending`,
      );
    }
    const secret = await readSecretAsync({ customerId: tenantId, appId });
    if (!secret) {
      throw new CellResolveError(`no secret for cell (${tenantId}, ${appId}); leaving row pending`);
    }
    const http = new ArcadeHttp({ user: cell.db_user, pass: secret }, baseUrl);
    const adapters: CellAdapters = {
      graph: new ArcadeGraphStore({ tenantDb: cell.db, http }),
      vector: new ArcadeVectorStore({ tenantDb: cell.db, http, embedder: input.embedder }),
    };
    cache.set(key, adapters);
    // Evict LRU tail.
    while (cache.size > maxCells) {
      const oldest = cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    return adapters;
  }

  const substrates: DispatcherSubstrates = {
    upsertNode: async (payload, workspace) => {
      const { graph } = await resolveCell(workspace);
      await graph.upsertNode(payload as unknown as LoreNode);
    },
    addEdge: async (payload, workspace) => {
      const { graph } = await resolveCell(workspace);
      await graph.addEdge(payload as unknown as LoreEdge);
    },
    deleteNode: async (id, workspace) => {
      const { graph } = await resolveCell(workspace);
      await graph.deleteNode(id);
    },
    // 2026-09-03 (X-markstale audit fix) — arcade-lane replay of a
    // `node.mark_stale` chunk row (outbox/types.ts). Mirrors deleteNode
    // above: no node-write-lock in this lane (arcade has no
    // core/nodeWriteLock.ts equivalent wired here — same as every other
    // handler in this file), resolve the cell, apply the substrate update.
    markStale: async (ids, workspace) => {
      const { graph } = await resolveCell(workspace);
      await graph.markStaleByIds(ids);
    },
    deleteEdge: async (payload, workspace) => {
      const { graph } = await resolveCell(workspace);
      await graph.deleteEdge(payload.sourceId, payload.targetId, payload.relation);
    },
    upsertVerbatim: async (payload, workspace) => {
      const id = String(payload['id'] ?? '');
      const text = String(payload['text'] ?? '');
      const metadata = (payload['metadata'] as Record<string, unknown>) ?? {};
      if (!id) return;
      const { vector } = await resolveCell(workspace);
      await vector.store({ id, text, metadata: metadata as never });
    },
    // QA A2 round-2 finding 3 (2026-09-03) — every node-delete path
    // unconditionally records a `verbatim.tombstone` outbox row (see
    // nodes-delete.ts / deleteNode.ts / lifecycle.ts / changesetWrite.ts),
    // but ArcadeVectorStore has no soft-tombstone concept (its synchronous
    // delete path already falls back to hard `delete()` — see those same
    // callers' `canTombstone` branch). Before this, the row had NOTHING to
    // dispatch to here — the dispatcher threw UnwiredOperationKindError on
    // first attempt and the row dead-lettered PERMANENTLY (unbounded
    // dead-letter growth, one row per arcade delete). Map the dispatch to
    // ArcadeVectorStore's actual delete semantics: a hard delete is the
    // honest terminal state for this substrate, it is idempotent (deleting
    // an already-absent id is a no-op DELETE), and getVerbatim below then
    // reports the row absent — the SAME "verified" shape verifyApplied
    // already accepts for a real tombstone (outbox/dispatcher.ts).
    tombstoneVerbatim: async (id, _reason, workspace) => {
      const { vector } = await resolveCell(workspace);
      await vector.delete(id);
    },
    // Verifier hooks (self-heal sweep). hasEdge uses a plain param-bound MATCH
    // count via getEdges — no both()/expand() traps.
    hasNode: async (id, workspace) => {
      const { graph } = await resolveCell(workspace);
      return (await graph.getNode(id)) !== null;
    },
    hasEdge: async (payload, workspace) => {
      const { graph } = await resolveCell(workspace);
      const edges = await graph.getEdges(payload.sourceId);
      return edges.some(
        (e) => e.targetId === payload.targetId && e.relation === payload.relation,
      );
    },
    hasVerbatim: async (id, workspace) => {
      const { vector } = await resolveCell(workspace);
      return (await vector.getById(id)) !== null;
    },
    // 2026-09-03 (A2 round-2 finding 3 fix) — content witness for verbatim
    // self-heal AND the verbatim.tombstone verifier (outbox/dispatcher.ts
    // verifyApplied): a row this store's tombstoneVerbatim hard-deleted
    // reports absent here, which verifyApplied treats as "verified" for a
    // tombstone kind — the same convergence shape as the local substrate's
    // soft tombstone.
    getVerbatim: async (id, workspace) => {
      const { vector } = await resolveCell(workspace);
      return vector.getById(id);
    },
    // embed.batch / sync.vector.mirror: NOT produced in arcade — leave unwired.
  };

  const replicator = wireReplicator({
    store: input.store,
    substrates,
    lagCache: input.lagCache,
    log: input.log,
  });

  return {
    replicator,
    evictCell(tenantId, appId) {
      cache.delete(cacheKey(tenantId, appId));
    },
    start() {
      replicator.start();
    },
    async stop() {
      await replicator.stop();
    },
  };
}

export { CellResolveError };
