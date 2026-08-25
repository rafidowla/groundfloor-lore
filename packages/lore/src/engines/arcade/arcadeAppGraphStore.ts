/**
 * arcadeAppGraphStore.ts — EXPERIMENTAL SPIKE CODE (spike/arcadedb-multitenant).
 *
 * DESIGN B graph adapter: ONE ArcadeDB database per CUSTOMER (tenant_alpha,
 * tenant_beta) shared by that customer's apps, with a per-row `app_id` STRING
 * column carrying the SOFTWARE wall between apps. This is a PARALLEL class to
 * the proven ArcadeGraphStore (which stays untouched) — it copies the same SQL
 * patterns and adds the `app_id = :boundApp` predicate to EVERY statement.
 *
 * ── TWO IMMUTABLE BINDINGS (the whole security story) ───────────────────────
 *   1. `tenantDb`   — the customer database (isolation wall vs OTHER customers;
 *                     ArcadeDB-enforced, exactly like Design A's per-DB wall).
 *   2. `boundAppId` — this app's id (the wall vs SIBLING apps of the SAME
 *                     customer; enforced ONLY by this adapter's SQL discipline).
 * BOTH are `private readonly`, set ONCE in the constructor. NO method accepts a
 * db or app parameter — `boundAppId` comes ONLY from the token map, NEVER from
 * a payload. There is no setter, so a token-alpha-app1 client can never be
 * re-pointed at app2.
 *
 * ── THE app_id PREDICATE, PER OP TYPE (what the adversarial test attacks) ────
 * Every SQL string that names LoreNode/LoreVerbatim carries `app_id = :boundApp`
 * bound via params (M12's static check enforces this literally):
 *   - getNode:  WHERE app_id = :boundApp AND id = :id
 *   - upsert:   SET app_id = :boundApp ... UPSERT WHERE app_id = :boundApp AND id = :id
 *               (composite (app_id,id) unique index makes same-id-in-sibling-app
 *                writes physically distinct rows — required for M2).
 *   - count:    WHERE app_id = :boundApp
 *   - addEdge:  endpoint SELECTs are WHERE app_id = :boundApp AND id = :x, so a
 *               sibling-app node id resolves to an EMPTY set and CREATE EDGE
 *               throws — the edge-cross probe (M3) fails cleanly.
 *   - traverse: after each bothE()->inV()/outV() expand, the neighbor VERTEX
 *               rows are RE-FILTERED by `app_id = :boundApp AND id <> :id`. This
 *               is what defeats a root-planted cross-app edge (M3 B-variant):
 *               even a real edge to an app2 vertex yields zero app1-visible
 *               neighbors because the app2 vertex is filtered out post-expand.
 *
 * `boundAppId` NEVER touches the URL/db path — it is always a bound param, so
 * an injection-shaped app value ("alpha_app2' OR '1'='1") stays opaque data.
 */

import type {
  GraphStats,
  LoreEdge,
  LoreNode,
  TraversalResult,
} from '../../providers/types.js';
import { ArcadeHttp } from './arcadeHttp.js';

const NODE_TYPE = 'LoreNode';
const EDGE_TYPE = 'LoreEdge';
const TRAVERSE_NODE_CAP = 500;

type NodeRow = Record<string, unknown>;

export class ArcadeAppGraphStore {
  /** IMMUTABLE customer database — the cross-CUSTOMER wall (ArcadeDB-enforced). */
  private readonly tenantDb: string;
  /** IMMUTABLE app id — the cross-APP wall (this adapter's SQL discipline). */
  private readonly boundAppId: string;
  private readonly http: ArcadeHttp;
  private schemaReady = false;

  constructor(opts: { tenantDb: string; boundAppId: string; http: ArcadeHttp }) {
    this.tenantDb = opts.tenantDb;
    this.boundAppId = opts.boundAppId;
    this.http = opts.http;
  }

  // ── schema init (once per customer DB) ───────────────────────────────────
  // Idempotent: safe to call even though the appgrid helpers pre-provision the
  // Design B schema (app_id property + COMPOSITE (app_id,id) unique index).
  async initialize(): Promise<void> {
    if (this.schemaReady) return;
    await this.http.command(this.tenantDb, `CREATE VERTEX TYPE ${NODE_TYPE} IF NOT EXISTS`);
    const props: Array<[string, string]> = [
      ['id', 'STRING'],
      ['app_id', 'STRING'],
      ['type', 'STRING'],
      ['label', 'STRING'],
      ['content', 'STRING'],
      ['tags', 'STRING'],
      ['project', 'STRING'],
      ['ecosystem', 'STRING'],
      ['metadata', 'STRING'],
      ['createdAt', 'STRING'],
      ['updatedAt', 'STRING'],
    ];
    for (const [name, kind] of props) {
      await this.http.command(
        this.tenantDb,
        `CREATE PROPERTY ${NODE_TYPE}.${name} IF NOT EXISTS ${kind}`,
      );
    }
    // COMPOSITE unique index — a unique index on id alone would make the M2
    // write-collision probe physically impossible AND be a cross-app channel.
    await this.http.command(
      this.tenantDb,
      `CREATE INDEX IF NOT EXISTS ON ${NODE_TYPE} (app_id, id) UNIQUE`,
    );
    await this.http.command(this.tenantDb, `CREATE EDGE TYPE ${EDGE_TYPE} IF NOT EXISTS`);
    await this.http.command(
      this.tenantDb,
      `CREATE PROPERTY ${EDGE_TYPE}.relation IF NOT EXISTS STRING`,
    );
    await this.http.command(
      this.tenantDb,
      `CREATE PROPERTY ${EDGE_TYPE}.confidence IF NOT EXISTS STRING`,
    );
    await this.http.command(
      this.tenantDb,
      `CREATE PROPERTY ${EDGE_TYPE}.confidenceScore IF NOT EXISTS DOUBLE`,
    );
    this.schemaReady = true;
  }

  // ── crown-jewel ops (every one carries app_id = :boundApp) ───────────────

  async upsertNode(
    node: Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>,
  ): Promise<LoreNode> {
    await this.initialize();
    const now = new Date().toISOString();
    const existing = await this.getNode(node.id);
    const createdAt = existing?.createdAt ?? now;
    const params = {
      boundApp: this.boundAppId,
      id: node.id,
      type: node.type ?? '',
      label: node.label ?? '',
      content: node.content ?? '',
      tags: JSON.stringify(node.tags ?? []),
      project: node.project ?? '',
      ecosystem: node.ecosystem ?? '',
      metadata: node.metadata ?? '',
      createdAt,
      updatedAt: now,
    };
    // UPSERT keyed on the COMPOSITE (app_id, id): matches only this app's row.
    await this.http.command(
      this.tenantDb,
      `UPDATE ${NODE_TYPE} SET app_id = :boundApp, id = :id, type = :type, ` +
        `label = :label, content = :content, tags = :tags, project = :project, ` +
        `ecosystem = :ecosystem, metadata = :metadata, ` +
        `createdAt = :createdAt, updatedAt = :updatedAt ` +
        `UPSERT WHERE app_id = :boundApp AND id = :id`,
      params,
    );
    const stored = await this.getNode(node.id);
    if (!stored) {
      throw new Error(`[ArcadeAppGraphStore] upsertNode failed to persist ${node.id}`);
    }
    return stored;
  }

  async getNode(id: string): Promise<LoreNode | null> {
    await this.initialize();
    const res = await this.http.query(
      this.tenantDb,
      `SELECT id, type, label, content, tags, project, ecosystem, metadata, ` +
        `createdAt, updatedAt FROM ${NODE_TYPE} ` +
        `WHERE app_id = :boundApp AND id = :id LIMIT 1`,
      { boundApp: this.boundAppId, id },
    );
    const row = res.result?.[0] as NodeRow | undefined;
    return row ? this.rowToNode(row) : null;
  }

  /**
   * addEdge — endpoint resolution is app_id-scoped, so a sibling-app (or
   * foreign-customer) node id resolves to an EMPTY FROM/TO set and CREATE EDGE
   * throws. A preflight getNode (also app_id-scoped) gives the clean
   * "target not found" the edge-cross probe (M3) expects.
   */
  async addEdge(edge: LoreEdge): Promise<void> {
    await this.initialize();
    const src = await this.getNode(edge.sourceId);
    const tgt = await this.getNode(edge.targetId);
    if (!src) {
      throw new Error(`[ArcadeAppGraphStore] addEdge: source not found: ${edge.sourceId}`);
    }
    if (!tgt) {
      throw new Error(`[ArcadeAppGraphStore] addEdge: target not found: ${edge.targetId}`);
    }
    await this.http.command(
      this.tenantDb,
      `CREATE EDGE ${EDGE_TYPE} ` +
        `FROM (SELECT FROM ${NODE_TYPE} WHERE app_id = :boundApp AND id = :src) ` +
        `TO (SELECT FROM ${NODE_TYPE} WHERE app_id = :boundApp AND id = :tgt) ` +
        `SET relation = :rel, confidence = :conf, confidenceScore = :score`,
      {
        boundApp: this.boundAppId,
        src: edge.sourceId,
        tgt: edge.targetId,
        rel: edge.relation,
        conf: edge.confidence ?? 'extracted',
        score: edge.confidenceScore ?? 1.0,
      },
    );
  }

  async addBidirectionalEdge(edge: LoreEdge): Promise<void> {
    await this.addEdge(edge);
    await this.addEdge({ ...edge, sourceId: edge.targetId, targetId: edge.sourceId });
  }

  /**
   * traverse — same iterative BFS + bothE()/inV()/outV() fix as the proven
   * adapter, PLUS an app_id re-filter on every expanded neighbor vertex. The
   * re-filter is the wall that defeats a real, root-planted cross-app edge:
   * the foreign-app vertex is expanded by the graph engine but discarded
   * before it can enter the frontier or the result.
   */
  async traverse(
    nodeId: string,
    maxDepth = 2,
    relation?: string,
  ): Promise<TraversalResult[]> {
    await this.initialize();
    const visited = new Set<string>([nodeId]);
    const out: TraversalResult[] = [];
    let frontier: string[] = [nodeId];

    for (let depth = 1; depth <= maxDepth; depth++) {
      const next: string[] = [];
      for (const fromId of frontier) {
        const rows = relation
          ? await this.neighborsByRelation(fromId, relation)
          : await this.neighborsAny(fromId);
        for (const row of rows) {
          const nbId = String(row['id'] ?? '');
          if (!nbId || visited.has(nbId)) continue;
          visited.add(nbId);
          out.push({ node: this.rowToNode(row), depth, relation: relation ?? '' });
          next.push(nbId);
          if (out.length >= TRAVERSE_NODE_CAP) return out;
        }
      }
      frontier = next;
      if (frontier.length === 0) break;
    }
    return out;
  }

  /**
   * All 1-hop neighbors, any relation, RE-FILTERED to app_id = :boundApp. The
   * outer WHERE runs after expand(both(...)) yields the neighbor vertex rows,
   * so a cross-app neighbor vertex is dropped here.
   */
  private async neighborsAny(fromId: string): Promise<NodeRow[]> {
    const res = await this.http.query(
      this.tenantDb,
      `SELECT FROM (SELECT expand(both('${EDGE_TYPE}')) FROM ${NODE_TYPE} ` +
        `WHERE app_id = :boundApp AND id = :id) WHERE app_id = :boundApp AND id <> :id`,
      { boundApp: this.boundAppId, id: fromId },
    );
    return (res.result ?? []) as NodeRow[];
  }

  /**
   * Relation-filtered 1-hop neighbors. Filters on the EDGE row (bothE) for the
   * relation — see the proven adapter's CONTRACT-DEVIATION note for why both()'s
   * vertex projection can't carry `.relation` — then expands to inV()/outV()
   * and RE-FILTERS the resulting neighbor vertices by app_id. inV()/outV() are
   * merged client-side because UNION/UNION ALL throws on this version.
   *
   * EXTRA WRAP QUIRK (26.7.1, discovered in this spike): applying
   * `WHERE app_id = :boundApp` directly on top of `SELECT expand(inV()/outV())
   * FROM (...)` silently returns ZERO rows even when the underlying vertex
   * rows visibly carry a matching app_id — the same family of bug the R1
   * silent-wrong-results trap describes for both()'s vertex projection, just
   * one nesting level deeper (post-expand-of-an-expand). The fix confirmed
   * live: wrap the expand(inV()/outV()) query in one more `SELECT FROM (...)`
   * layer BEFORE the app_id/id<> filter is applied — this is required, not
   * cosmetic; without it every relation-filtered traverse silently returns
   * nothing (a false-negative filter, exactly the danger R1 warns about).
   */
  private async neighborsByRelation(fromId: string, relation: string): Promise<NodeRow[]> {
    const params = { boundApp: this.boundAppId, id: fromId, rel: relation };
    const [inRes, outRes] = await Promise.all([
      this.http.query(
        this.tenantDb,
        `SELECT FROM (SELECT expand(inV()) FROM (SELECT FROM (SELECT expand(bothE('${EDGE_TYPE}')) ` +
          `FROM ${NODE_TYPE} WHERE app_id = :boundApp AND id = :id) WHERE relation = :rel)) ` +
          `WHERE app_id = :boundApp AND id <> :id`,
        params,
      ),
      this.http.query(
        this.tenantDb,
        `SELECT FROM (SELECT expand(outV()) FROM (SELECT FROM (SELECT expand(bothE('${EDGE_TYPE}')) ` +
          `FROM ${NODE_TYPE} WHERE app_id = :boundApp AND id = :id) WHERE relation = :rel)) ` +
          `WHERE app_id = :boundApp AND id <> :id`,
        params,
      ),
    ]);
    return [...((inRes.result ?? []) as NodeRow[]), ...((outRes.result ?? []) as NodeRow[])];
  }

  async nodeCount(): Promise<number> {
    await this.initialize();
    const res = await this.http.query(
      this.tenantDb,
      `SELECT count(*) AS n FROM ${NODE_TYPE} WHERE app_id = :boundApp`,
      { boundApp: this.boundAppId },
    );
    const row = res.result?.[0] as { n?: number } | undefined;
    return Number(row?.n ?? 0);
  }

  private rowToNode(row: NodeRow): LoreNode {
    let tags: string[] = [];
    const rawTags = row['tags'];
    if (Array.isArray(rawTags)) {
      tags = rawTags.map(String);
    } else if (typeof rawTags === 'string' && rawTags.length > 0) {
      try {
        const parsed = JSON.parse(rawTags);
        tags = Array.isArray(parsed) ? parsed.map(String) : [];
      } catch {
        tags = [];
      }
    }
    return {
      id: String(row['id'] ?? ''),
      type: String(row['type'] ?? ''),
      label: String(row['label'] ?? ''),
      content: String(row['content'] ?? ''),
      tags,
      project: String(row['project'] ?? ''),
      ecosystem: String(row['ecosystem'] ?? ''),
      metadata: String(row['metadata'] ?? ''),
      createdAt: String(row['createdAt'] ?? ''),
      updatedAt: String(row['updatedAt'] ?? ''),
      syncedAt: null,
    };
  }

  // ── not-in-spike stubs (parallel to the proven adapter) ──────────────────
  async getNodesByIds(ids: string[]): Promise<Map<string, LoreNode>> {
    const map = new Map<string, LoreNode>();
    for (const id of ids) {
      const n = await this.getNode(id);
      if (n) map.set(id, n);
    }
    return map;
  }
  async getStats(): Promise<GraphStats> {
    return { nodeCount: await this.nodeCount(), edgeCount: 0, typeBreakdown: {} };
  }
}
