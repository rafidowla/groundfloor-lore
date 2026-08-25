/**
 * arcadeAppVectorStore.ts — EXPERIMENTAL SPIKE CODE (spike/arcadedb-multitenant).
 *
 * DESIGN B vector adapter: verbatim upsert + semantic recall inside a shared
 * per-CUSTOMER database, with an immutable `boundAppId` applied as a MANDATORY
 * app_id filter on EVERY op — including recall, so a query can never surface a
 * sibling app's rows. Parallel class to the proven ArcadeVectorStore (untouched);
 * copies its SQL + score-mapping patterns and adds the app_id predicate.
 *
 * ── TWO IMMUTABLE BINDINGS ──────────────────────────────────────────────────
 *   1. `tenantDb`   — customer DB (cross-customer wall, ArcadeDB-enforced).
 *   2. `boundAppId` — app id (cross-app wall, this adapter's discipline).
 * Both `private readonly`, set once. No method takes a db/app param.
 *
 * ── app_id PREDICATE PER OP ─────────────────────────────────────────────────
 *   - store:  SET app_id = :boundApp ... UPSERT WHERE app_id = :boundApp AND id = :id
 *   - count:  WHERE app_id = :boundApp
 *   - delete: WHERE app_id = :boundApp AND id = :id  (composite index means an
 *             unscoped delete could still match a sibling app's id — so the
 *             predicate is load-bearing here, M10).
 *   - search: THE SECURITY-CRITICAL ONE. ArcadeDB 26.7.1 has NO usable
 *             property-predicate pushdown for vector.neighbors (the `filter`
 *             arg is a pre-resolved RID allowlist, not an app_id predicate —
 *             re-verified live this session). So recall over-fetches
 *             k = max(40, limit*4) HNSW neighbors and applies the app_id filter
 *             CLIENT-SIDE as a MANDATORY AND predicate BEFORE limit. Foreign-app
 *             rows are dropped even when the raw HNSW neighborhood is dominated
 *             by sibling-app near-duplicates (the semantic-magnet case, M5); the
 *             cost is a possible shortfall (returned < limit) which the test
 *             records as evidence.
 */

import type {
  EmbeddingProvider,
  VerbatimDocument,
  VerbatimSearchResult,
} from '../../providers/types.js';
import { LocalEmbeddingProvider } from '../../providers/localEmbeddingProvider.js';
import { ArcadeHttp } from './arcadeHttp.js';

const VERBATIM_TYPE = 'LoreVerbatim';

let sharedEmbedder: LocalEmbeddingProvider | null = null;
function getSharedEmbedder(): LocalEmbeddingProvider {
  if (!sharedEmbedder) sharedEmbedder = new LocalEmbeddingProvider();
  return sharedEmbedder;
}

/** Result of a recall, plus over-fetch telemetry for the semantic-magnet evidence. */
export interface AppRecallDiagnostics {
  /** k requested from HNSW. */
  overfetchK: number;
  /** raw neighbors returned by HNSW before the app_id filter. */
  rawNeighbors: number;
  /** how many raw neighbors carried a FOREIGN app_id (dropped by the filter). */
  foreignDropped: number;
  /** whether the filtered result still reached `limit`. */
  reachedLimit: boolean;
}

export class ArcadeAppVectorStore {
  private readonly tenantDb: string;
  private readonly boundAppId: string;
  private readonly http: ArcadeHttp;
  private readonly embedder: EmbeddingProvider;
  private schemaReady = false;
  /** Telemetry from the most recent search() — read by the semantic-magnet test. */
  public lastRecallDiagnostics: AppRecallDiagnostics | null = null;

  constructor(opts: {
    tenantDb: string;
    boundAppId: string;
    http: ArcadeHttp;
    embedder?: EmbeddingProvider;
  }) {
    this.tenantDb = opts.tenantDb;
    this.boundAppId = opts.boundAppId;
    this.http = opts.http;
    this.embedder = opts.embedder ?? getSharedEmbedder();
  }

  async initialize(): Promise<void> {
    await this.embedder.initialize();
    if (this.schemaReady) return;
    await this.http.command(this.tenantDb, `CREATE VERTEX TYPE ${VERBATIM_TYPE} IF NOT EXISTS`);
    const props: Array<[string, string]> = [
      ['id', 'STRING'],
      ['app_id', 'STRING'],
      ['text', 'STRING'],
      ['type', 'STRING'],
      ['label', 'STRING'],
      ['tags', 'STRING'],
      ['project', 'STRING'],
      ['embedding', 'ARRAY_OF_FLOATS'],
    ];
    for (const [name, kind] of props) {
      await this.http.command(
        this.tenantDb,
        `CREATE PROPERTY ${VERBATIM_TYPE}.${name} IF NOT EXISTS ${kind}`,
      );
    }
    // Composite unique index — same-id-in-sibling-app must be distinct rows.
    await this.http.command(
      this.tenantDb,
      `CREATE INDEX IF NOT EXISTS ON ${VERBATIM_TYPE} (app_id, id) UNIQUE`,
    );
    await this.http.command(
      this.tenantDb,
      `CREATE INDEX IF NOT EXISTS ON ${VERBATIM_TYPE} (embedding) LSM_VECTOR METADATA ` +
        `{"dimensions": ${this.embedder.dimension}, "similarity": "cosine", ` +
        `"maxConnections": 16, "beamWidth": 100}`,
    );
    this.schemaReady = true;
  }

  async store(doc: VerbatimDocument): Promise<void> {
    await this.initialize();
    const embedding = await this.embedder.embedDocument(doc.text);
    const params = {
      boundApp: this.boundAppId,
      id: doc.id,
      text: doc.text,
      type: doc.metadata?.type ?? '',
      label: doc.metadata?.label ?? '',
      tags: doc.metadata?.tags ?? '',
      project: doc.metadata?.project ?? '',
      embedding,
    };
    await this.http.command(
      this.tenantDb,
      `UPDATE ${VERBATIM_TYPE} SET app_id = :boundApp, id = :id, text = :text, ` +
        `type = :type, label = :label, tags = :tags, project = :project, ` +
        `embedding = :embedding UPSERT WHERE app_id = :boundApp AND id = :id`,
      params,
    );
  }

  /**
   * search — native HNSW similarity, then a MANDATORY client-side app_id filter
   * BEFORE any caller metadata filter and BEFORE limit. Records over-fetch
   * telemetry so the semantic-magnet test can prove foreign-app rows were
   * present in the raw neighborhood and dropped.
   */
  async search(
    query: string,
    limit = 10,
    filter?: Partial<VerbatimDocument['metadata']>,
  ): Promise<VerbatimSearchResult[]> {
    await this.initialize();
    const qvec = await this.embedder.embedQuery(query);
    const k = Math.max(40, limit * 4);
    const res = await this.http.query(
      this.tenantDb,
      `SELECT vector.neighbors("${VERBATIM_TYPE}[embedding]", :vec, :k) AS neighbors`,
      { vec: qvec, k },
    );
    const wrapper = (res.result ?? [])[0] as
      | { neighbors?: Array<Record<string, unknown>> }
      | undefined;
    const neighbors = wrapper?.neighbors ?? [];

    let foreignDropped = 0;
    const out: VerbatimSearchResult[] = [];
    for (const n of neighbors) {
      const vertex = (n['vertex'] ?? n) as Record<string, unknown>;
      const distance = Number(n['distance'] ?? 1);

      // MANDATORY app_id wall — applied to EVERY neighbor, first, unconditional.
      if (String(vertex['app_id'] ?? '') !== this.boundAppId) {
        foreignDropped++;
        continue;
      }

      // Optional caller metadata filter (exact-match AND), same as proven adapter.
      if (filter) {
        let ok = true;
        for (const [key, val] of Object.entries(filter)) {
          if (val === undefined || val === null || val === '') continue;
          if (key !== 'type' && key !== 'project') continue;
          if (String(vertex[key] ?? '') !== String(val)) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
      }

      const score = Math.max(0, Math.min(1, 1 - distance));
      out.push({
        id: String(vertex['id'] ?? ''),
        score,
        text: String(vertex['text'] ?? ''),
        metadata: {
          type: String(vertex['type'] ?? ''),
          label: String(vertex['label'] ?? ''),
          tags: String(vertex['tags'] ?? ''),
          project: String(vertex['project'] ?? ''),
        },
      });
      if (out.length >= limit) break;
    }
    out.sort((a, b) => b.score - a.score);
    const sliced = out.slice(0, limit);
    this.lastRecallDiagnostics = {
      overfetchK: k,
      rawNeighbors: neighbors.length,
      foreignDropped,
      reachedLimit: sliced.length >= limit,
    };
    return sliced;
  }

  async count(): Promise<number> {
    await this.initialize();
    const res = await this.http.query(
      this.tenantDb,
      `SELECT count(*) AS n FROM ${VERBATIM_TYPE} WHERE app_id = :boundApp`,
      { boundApp: this.boundAppId },
    );
    const row = res.result?.[0] as { n?: number } | undefined;
    return Number(row?.n ?? 0);
  }

  /**
   * delete — app_id-scoped. Load-bearing: with the composite (app_id,id) index,
   * an unscoped `WHERE id = :id` would match a sibling app's row too, so the
   * app_id predicate is what confines the delete to this app (M10).
   */
  async delete(id: string): Promise<void> {
    await this.initialize();
    await this.http.command(
      this.tenantDb,
      `DELETE FROM ${VERBATIM_TYPE} WHERE app_id = :boundApp AND id = :id`,
      { boundApp: this.boundAppId, id },
    );
  }

  async close(): Promise<void> {
    // no per-instance connection; embedder is a shared singleton.
  }
}
