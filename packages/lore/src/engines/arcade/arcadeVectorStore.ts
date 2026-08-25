/**
 * arcadeVectorStore.ts — EXPERIMENTAL SPIKE CODE (spike/arcadedb-multitenant).
 *
 * Tenant-scoped ArcadeDB vector adapter. Implements verbatim upsert + semantic
 * recall behind the Lore VectorProvider shape. Embedding happens IN-PROCESS via
 * LocalEmbeddingProvider (exactly like DataplaneVectorStore); the resulting
 * vector is stored INSIDE the tenant database on a `LoreVerbatim` vertex, so
 * vector isolation rides the SAME database wall as graph isolation — there is
 * no shared collection with a tenant column.
 *
 * ── ISOLATION MODEL ────────────────────────────────────────────────────────
 * Same structural guarantee as ArcadeGraphStore: `tenantDb` is `private
 * readonly`, no method accepts a db/tenant argument, every HTTP call routes to
 * `this.tenantDb`, and every caller value is bound via ArcadeDB `params`. A
 * tenant_alpha adapter cannot read, write, or delete tenant_beta vectors.
 *
 * ── VECTOR PATH: native HNSW (LSM_VECTOR) ──────────────────────────────────
 * Confirmed working on ArcadeDB v26.8.1-SNAPSHOT. We store `embedding` as a
 * float array property, build an HNSW index with LSM_VECTOR, and query with
 * `vector.neighbors("LoreVerbatim[embedding]", <vec>, k, {efSearch, filter})`.
 * Score mapping: ArcadeDB returns cosine `distance` (0 = identical). We map
 * score = 1 - distance, clamped to [0,1], descending — per the VectorProvider
 * contract. Brute-force cosine fallback was NOT needed on this version.
 */

import type {
  EmbeddingProvider,
  VerbatimDocument,
  VerbatimSearchResult,
} from '../../providers/types.js';
import { LocalEmbeddingProvider } from '../../providers/localEmbeddingProvider.js';
import { makeBm25Envelope } from '../verbatimBm25Result.js';
import type { Bm25Envelope } from '../verbatimBm25Result.js';
import { ArcadeHttp } from './arcadeHttp.js';
import { computeContentHash } from '../contentHash.js';
import { applyActorScopeFilter, normalizeScopes } from '../../security/scopeFilter.js';
import { verbatimSchemaDdl, VERBATIM_TYPE } from './arcadeSchema.js';

/** Candidate over-fetch cap for the client-ranked bm25 lexical path. */
const BM25_SCAN_CAP = 500;

/**
 * Module-singleton embedder — the HF pipeline is ~120MB; load once and share
 * across all tenant vector stores (mirrors DataplaneVectorStore's default).
 * Each tenant store still stores/searches inside ITS OWN db; only the CPU-side
 * embedding model is shared (it holds no tenant data).
 */
let sharedEmbedder: LocalEmbeddingProvider | null = null;
function getSharedEmbedder(): LocalEmbeddingProvider {
  if (!sharedEmbedder) sharedEmbedder = new LocalEmbeddingProvider();
  return sharedEmbedder;
}

export class ArcadeVectorStore {
  /** IMMUTABLE tenant database name — the isolation boundary. */
  private readonly tenantDb: string;
  private readonly http: ArcadeHttp;
  private readonly embedder: EmbeddingProvider;
  private schemaReady = false;

  constructor(opts: {
    tenantDb: string;
    http: ArcadeHttp;
    embedder?: EmbeddingProvider;
  }) {
    this.tenantDb = opts.tenantDb;
    this.http = opts.http;
    this.embedder = opts.embedder ?? getSharedEmbedder();
  }

  async initialize(): Promise<void> {
    await this.embedder.initialize();
    if (this.schemaReady) return;
    // DDL sourced from arcadeSchema.ts (verbatimSchemaDdl) — the SAME statements
    // the daemon-operator provisioner runs, so adapter-lazy-init (this path,
    // used by tests/spikes constructing the adapter directly) and
    // pre-provisioning never drift. Includes the LoreVerbatim scalar props, the
    // embedding ARRAY_OF_FLOATS column, and the native HNSW (LSM_VECTOR) index
    // sized to the provider's dimension. All IF NOT EXISTS → replay-safe.
    for (const stmt of verbatimSchemaDdl(this.embedder.dimension)) {
      await this.http.command(this.tenantDb, stmt);
    }
    this.schemaReady = true;
  }

  /**
   * store — embed the text in-process, then UPSERT the LoreVerbatim vertex by
   * id inside THIS tenant db. Vector + metadata all bound via `params`.
   *
   * contentHash short-circuit (mirrors VerbatimStore.store): when the
   * incoming contentHash (explicit or computed from doc.text) equals the
   * hash already stored for this id, skip re-embedding and reuse the
   * existing embedding — the same "unchanged re-store is a no-op re-embed"
   * optimization LanceDB's VerbatimStore applies, so a re-connect / re-sync
   * sweep against an ArcadeDB-backed tenant doesn't churn CPU on unchanged text.
   */
  async store(doc: VerbatimDocument): Promise<void> {
    await this.initialize();
    const effectiveHash = doc.metadata?.contentHash || computeContentHash(doc.text);

    const existing = await this.http.query(
      this.tenantDb,
      `SELECT contentHash, embedding FROM ${VERBATIM_TYPE} WHERE id = :id LIMIT 1`,
      { id: doc.id },
    );
    const existingRow = existing.result?.[0] as
      | { contentHash?: string; embedding?: number[] }
      | undefined;

    let embedding: number[];
    if (existingRow?.contentHash === effectiveHash && effectiveHash && existingRow.embedding) {
      // Unchanged text under the same id — reuse the stored vector rather
      // than re-embedding (skip-on-match, same contract as VerbatimStore).
      embedding = existingRow.embedding;
    } else {
      embedding = await this.embedder.embedDocument(doc.text);
    }

    // Stored comma-joined (same on-the-wire shape as DataplaneVectorStore's
    // cloud connector — see security_scopes comment there and
    // scopeFilter.ts's normalizeScopes, which already handles this format).
    const scopes = Array.isArray(doc.metadata?.security_scopes)
      ? (doc.metadata!.security_scopes as string[])
      : [];
    const params = {
      id: doc.id,
      text: doc.text,
      type: doc.metadata?.type ?? '',
      label: doc.metadata?.label ?? '',
      tags: doc.metadata?.tags ?? '',
      project: doc.metadata?.project ?? '',
      ecosystem: doc.metadata?.ecosystem ?? '',
      updatedAt: doc.metadata?.updatedAt ?? new Date().toISOString(),
      security_scopes: scopes.join(','),
      contentHash: effectiveHash,
      embedding,
    };
    await this.http.command(
      this.tenantDb,
      `UPDATE ${VERBATIM_TYPE} SET id = :id, text = :text, type = :type, ` +
        `label = :label, tags = :tags, project = :project, ecosystem = :ecosystem, ` +
        `updatedAt = :updatedAt, security_scopes = :security_scopes, ` +
        `contentHash = :contentHash, embedding = :embedding ` +
        `UPSERT WHERE id = :id`,
      params,
    );
  }

  /**
   * embedModelId / embedDim — the identity of THIS store's embedder. The
   * migration import compares these against the export bundle's manifest to
   * decide CARRY (byte-identical vectors, zero model cost) vs RE-EMBED. Exposed
   * so arcadeMigrate.ts does not reach into private embedder internals.
   */
  async embedModelId(): Promise<string> {
    await this.initialize();
    return this.embedder.modelId;
  }
  async embedDim(): Promise<number> {
    await this.initialize();
    return this.embedder.dimension;
  }

  /**
   * storePrebuilt — Slice-4 migration CARRY path. UPSERT verbatim rows writing
   * the embedding DIRECTLY (no re-embed), by id, chunked. Mirrors
   * VerbatimStore.bulkUpsertPrebuiltRows: the caller has already validated that
   * every row's embedding matches this store's provisioned HNSW dim (a mismatch
   * would corrupt the LSM_VECTOR index — arcadeMigrate.ts refuses with 409
   * embedding_model_mismatch before calling here). The vector column is a plain
   * ARRAY_OF_FLOATS UPSERT, so this is a param-bound write, not a model call.
   */
  async storePrebuilt(
    rows: Array<{
      id: string;
      text: string;
      metadata?: VerbatimDocument['metadata'];
      contentHash?: string;
      embedding: number[];
    }>,
  ): Promise<void> {
    await this.initialize();
    const dim = this.embedder.dimension;
    for (const doc of rows) {
      if (!Array.isArray(doc.embedding) || doc.embedding.length !== dim) {
        // Fail loud — a dim-mismatched vector would corrupt the index. The
        // caller is contracted to have filtered these out; this is belt.
        throw new Error(
          `[ArcadeVectorStore.storePrebuilt] embedding dim ${doc.embedding?.length} != provisioned ${dim} for id ${doc.id}`,
        );
      }
      const effectiveHash = doc.contentHash || computeContentHash(doc.text);
      const scopes = Array.isArray(doc.metadata?.security_scopes)
        ? (doc.metadata!.security_scopes as string[])
        : [];
      const params = {
        id: doc.id,
        text: doc.text,
        type: doc.metadata?.type ?? '',
        label: doc.metadata?.label ?? '',
        tags: doc.metadata?.tags ?? '',
        project: doc.metadata?.project ?? '',
        ecosystem: doc.metadata?.ecosystem ?? '',
        updatedAt: doc.metadata?.updatedAt ?? new Date().toISOString(),
        security_scopes: scopes.join(','),
        contentHash: effectiveHash,
        embedding: doc.embedding,
      };
      await this.http.command(
        this.tenantDb,
        `UPDATE ${VERBATIM_TYPE} SET id = :id, text = :text, type = :type, ` +
          `label = :label, tags = :tags, project = :project, ecosystem = :ecosystem, ` +
          `updatedAt = :updatedAt, security_scopes = :security_scopes, ` +
          `contentHash = :contentHash, embedding = :embedding ` +
          `UPSERT WHERE id = :id`,
        params,
      );
    }
  }

  /**
   * search — embed the query in-process, run native HNSW similarity within THIS
   * tenant db, apply metadata filter (project/type/ecosystem/tags) as an AND
   * predicate BEFORE limit, enforce actorScopes, return score in [0,1] descending.
   *
   * ArcadeDB `vector.neighbors(...)` returns rows shaped { vertex, distance }.
   * CONTRACT-DEVIATION (T3 — vector.neighbors has no property-predicate
   * pushdown on this version): we over-fetch (limit * 4, min 40) so the
   * client-side metadata AND-filter + actorScopes filter still yields up to
   * `limit` rows after both are applied, then slice. This is the documented
   * trap workaround, not an optimization choice.
   *
   * `opts.includeHistory` is accepted for signature completeness but is
   * INERT until the Phase-6 supersession columns exist on LoreVerbatim —
   * CONTRACT-DEVIATION, documented per the plan (no history-aware reads yet).
   */
  async search(
    query: string,
    limit = 10,
    filter?: Partial<VerbatimDocument['metadata']>,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    opts?: { includeHistory?: boolean },
    actorScopes?: ReadonlyArray<string>,
  ): Promise<VerbatimSearchResult[]> {
    await this.initialize();
    const qvec = await this.embedder.embedQuery(query);
    // CONTRACT-DEVIATION (T3): over-fetch since vector.neighbors can't push
    // the metadata/scope predicates down into the HNSW query itself.
    const k = Math.max(40, limit * 4);
    // vector.neighbors is the documented native HNSW query on this version.
    const res = await this.http.query(
      this.tenantDb,
      `SELECT vector.neighbors("${VERBATIM_TYPE}[embedding]", :vec, :k) AS neighbors`,
      { vec: qvec, k },
    );
    const wrapper = (res.result ?? [])[0] as
      | { neighbors?: Array<Record<string, unknown>> }
      | undefined;
    const neighbors = wrapper?.neighbors ?? [];

    type Candidate = VerbatimSearchResult & { metadata: VerbatimSearchResult['metadata'] };
    const candidates: Candidate[] = [];
    for (const n of neighbors) {
      // neighbor row: { vertex: <record>, distance: <number> }
      const vertex = (n['vertex'] ?? n) as Record<string, unknown>;
      const distance = Number(n['distance'] ?? 1);
      // CONTRACT: metadata filter is an AND predicate applied BEFORE limit.
      // ArcadeDB's vector.neighbors filter arg is version-sensitive, so the
      // adapter applies the (exact-match) filter client-side. // CONTRACT-DEVIATION (T3)
      if (filter) {
        let ok = true;
        for (const [key, val] of Object.entries(filter)) {
          if (val === undefined || val === null || val === '') continue;
          if (key === 'security_scopes' || key === 'contentHash') continue; // handled separately / not a filter axis
          if (String(vertex[key] ?? '') !== String(val)) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
      }
      // cosine distance in [0,2] → similarity score in [0,1].
      const score = Math.max(0, Math.min(1, 1 - distance));
      candidates.push({
        id: String(vertex['id'] ?? ''),
        score,
        text: String(vertex['text'] ?? ''),
        metadata: {
          type: String(vertex['type'] ?? ''),
          label: String(vertex['label'] ?? ''),
          tags: String(vertex['tags'] ?? ''),
          project: String(vertex['project'] ?? ''),
          ecosystem: String(vertex['ecosystem'] ?? ''),
          updatedAt: String(vertex['updatedAt'] ?? ''),
          security_scopes: normalizeScopes(vertex['security_scopes']),
        },
      });
    }
    // vector.neighbors returns ascending distance => descending score already,
    // but sort defensively to guarantee the contract.
    candidates.sort((a, b) => b.score - a.score);
    // Row-level security_scopes enforcement (same policy as VerbatimStore /
    // DataplaneVectorStore): empty scopes on a row = public; non-empty
    // requires overlap with actorScopes; undefined actorScopes = no filtering
    // (daemon-internal / local-mode callers).
    const scoped = applyActorScopeFilter(candidates, actorScopes);
    return scoped.slice(0, limit);
  }

  async count(): Promise<number> {
    await this.initialize();
    const res = await this.http.query(
      this.tenantDb,
      `SELECT count(*) AS n FROM ${VERBATIM_TYPE}`,
    );
    const row = res.result?.[0] as { n?: number } | undefined;
    return Number(row?.n ?? 0);
  }

  /**
   * bm25Search — client-ranked lexical (keyword) search over the verbatim
   * store. Same signature + result shape as VerbatimStore.bm25Search, so
   * LoreStorageClient.verbatimBm25Search's runtime feature-detect finds it and
   * the CloudModeNotImplementedError path disappears for arcade cells.
   *
   * ArcadeDB 26.7.1 has no server-side FTS/BM25 we can rely on for this schema,
   * so this is documented as CLIENT-RANKED: (1) a bounded candidate SELECT with
   * an any-term LIKE prefilter over text/label/tags (capped at BM25_SCAN_CAP,
   * with a scanCapHit-style truncation signal in the log), then (2) an
   * in-process lexical score (per-term hit counts across text/label/tags,
   * normalized to [0,1]) with the same metadata AND-filter + actorScopes
   * enforcement the semantic path applies. Plain SELECT WHERE — no
   * expand()/both(), so traps T1/T2 don't apply.
   *
   * `ranked` on the returned envelope is always `true`: this path never
   * degrades to a uniform/unranked substring dump the way VerbatimStore's
   * LIKE fallback does — every returned hit already carries a real
   * per-term-hit-count score.
   */
  async bm25Search(
    query: string,
    limit = 10,
    filter?: Partial<VerbatimDocument['metadata']>,
    actorScopes?: ReadonlyArray<string>,
  ): Promise<Bm25Envelope<VerbatimSearchResult>> {
    await this.initialize();
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .map((t) => t.trim())
      .filter(Boolean);
    if (terms.length === 0) return makeBm25Envelope([], true);

    // (1) bounded any-term candidate prefilter. One LIKE branch per term over
    // text/label/tags, ORed; params bound (never interpolated).
    const params: Record<string, unknown> = {};
    const branches: string[] = [];
    terms.forEach((t, i) => {
      params[`t${i}`] = `%${t}%`;
      // `text` MUST be backtick-quoted: ArcadeDB 26.7.1's parser treats the bare
      // identifier `text` as the TEXT type keyword and rejects `text.toLowerCase()`
      // with "Unknown function name 'text.toLowerCase'". Backticks make it a plain
      // property reference. Confirmed live. (label/tags are not reserved.)
      branches.push(
        '`text`.toLowerCase() LIKE :t' + i +
          ` OR label.toLowerCase() LIKE :t${i} OR tags.toLowerCase() LIKE :t${i}`,
      );
    });
    const res = await this.http.query(
      this.tenantDb,
      'SELECT id, `text`, type, label, tags, project, ecosystem, updatedAt, security_scopes ' +
        `FROM ${VERBATIM_TYPE} WHERE (${branches.join(' OR ')}) LIMIT ${BM25_SCAN_CAP + 1}`,
      params,
    );
    const rows = (res.result ?? []) as Array<Record<string, unknown>>;
    if (rows.length > BM25_SCAN_CAP) {
      console.error(
        `[ArcadeVectorStore] bm25Search: candidate scan hit the ${BM25_SCAN_CAP}-row cap ` +
          `(query "${query}") — results are ranked over a truncated window (client-ranked, no server FTS).`,
      );
    }

    // (2) in-process lexical scoring + metadata AND-filter.
    const candidates: VerbatimSearchResult[] = [];
    for (const row of rows.slice(0, BM25_SCAN_CAP)) {
      if (filter) {
        let ok = true;
        for (const [key, val] of Object.entries(filter)) {
          if (val === undefined || val === null || val === '') continue;
          if (key === 'security_scopes' || key === 'contentHash') continue;
          if (String(row[key] ?? '') !== String(val)) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
      }
      const hay = (
        String(row['text'] ?? '') +
        ' ' +
        String(row['label'] ?? '') +
        ' ' +
        String(row['tags'] ?? '')
      ).toLowerCase();
      let hits = 0;
      for (const t of terms) if (hay.includes(t)) hits++;
      if (hits === 0) continue;
      candidates.push({
        id: String(row['id'] ?? ''),
        score: hits / terms.length,
        text: String(row['text'] ?? ''),
        metadata: {
          type: String(row['type'] ?? ''),
          label: String(row['label'] ?? ''),
          tags: String(row['tags'] ?? ''),
          project: String(row['project'] ?? ''),
          ecosystem: String(row['ecosystem'] ?? ''),
          updatedAt: String(row['updatedAt'] ?? ''),
          security_scopes: normalizeScopes(row['security_scopes']),
        },
      });
    }
    candidates.sort((a, b) => b.score - a.score);
    const scoped = applyActorScopeFilter(candidates, actorScopes);
    return makeBm25Envelope(scoped.slice(0, limit), true);
  }

  /**
   * getById — stored text + contentHash for a single canonical id, WITHOUT
   * re-embedding (parity with verbatimHistory.getById, which GET
   * /api/verbatim/get calls through store.loreVerbatim). Returns null if the
   * row is absent. Plain parameterized SELECT WHERE — no vector.neighbors /
   * expand(), so none of the three ArcadeDB SQL traps apply. `text` is
   * backtick-quoted (ArcadeDB 26.7.1 parses the bare `text` identifier as the
   * TEXT type keyword — same guard as bm25Search).
   */
  async getById(id: string): Promise<{ contentHash?: string; text?: string } | null> {
    await this.initialize();
    const res = await this.http.query(
      this.tenantDb,
      `SELECT contentHash, \`text\` FROM ${VERBATIM_TYPE} WHERE id = :id LIMIT 1`,
      { id },
    );
    const row = res.result?.[0] as { contentHash?: string; text?: string } | undefined;
    if (!row) return null;
    return { contentHash: row.contentHash ?? '', text: row.text ?? '' };
  }

  /** delete — parameterized delete-by-id inside THIS tenant db. */
  async delete(id: string): Promise<void> {
    await this.initialize();
    await this.http.command(
      this.tenantDb,
      `DELETE FROM ${VERBATIM_TYPE} WHERE id = :id`,
      { id },
    );
  }

  /**
   * dumpAll — slice-5 logical BACKUP export: every verbatim row incl. its
   * embedding vector, so a restore can CARRY byte-identical vectors. Root/
   * service-authed operator path only (arcadeBackup route). Plain parameterless
   * SELECT WHERE-less projection — no vector.neighbors/expand, so no SQL trap.
   * `text` is backtick-quoted (26.7.1 parses bare `text` as the TEXT keyword).
   */
  async dumpAll(): Promise<
    Array<{ id: string; text: string; metadata?: Record<string, unknown>; contentHash?: string; embedding?: number[] }>
  > {
    await this.initialize();
    const res = await this.http.query(
      this.tenantDb,
      `SELECT id, \`text\`, type, label, tags, project, ecosystem, updatedAt, ` +
        `security_scopes, contentHash, embedding FROM ${VERBATIM_TYPE}`,
    );
    const rows = (res.result ?? []) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r['id'] ?? ''),
      text: String(r['text'] ?? ''),
      metadata: {
        type: r['type'] ?? '',
        label: r['label'] ?? '',
        tags: r['tags'] ?? '',
        project: r['project'] ?? '',
        ecosystem: r['ecosystem'] ?? '',
        updatedAt: r['updatedAt'] ?? '',
        security_scopes:
          typeof r['security_scopes'] === 'string' && (r['security_scopes'] as string).length > 0
            ? (r['security_scopes'] as string).split(',')
            : [],
      },
      contentHash: r['contentHash'] ? String(r['contentHash']) : undefined,
      embedding: Array.isArray(r['embedding']) ? (r['embedding'] as number[]) : undefined,
    }));
  }

  async close(): Promise<void> {
    // no per-instance connection to release; embedder is a shared singleton.
  }
}
