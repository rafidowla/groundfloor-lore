/**
 * mock-dataplane.ts — In-memory mock of the Groundfloor Dataplane engine's HTTP API.
 *
 * Purpose:
 *   Lore's cloud adapters (DataplaneGraph / DataplaneVectorStore /
 *   DataplaneCollectionStorage) speak to `groundfloor-ts-sdk`, which speaks HTTP
 *   to the Rust engine. This mock reproduces the engine's *observable* behaviour
 *   closely enough that a cross-workspace isolation bug cannot hide behind a
 *   permissive fake. RULE: never more permissive than the engine (design D7).
 *
 * Fidelity (pinned by test/mock-dataplane-fidelity-unit.ts):
 *   1. Workspace from the credential. `startMockDataplane({ apiKeys })` maps a
 *      bearer token to a Dataplane workspace; missing/unknown bearer -> 401 once
 *      apiKeys is given. Without apiKeys any key maps to `defaultWorkspace`.
 *      `X-Tenant-Id` is IGNORED (the engine ignores it). Tenant-first URLs
 *      (`/v1/{tenant}/{coll}/...`) are 404 — routes are collection-first only.
 *   2. Filters use the engine grammar (serde externally tagged): "all",
 *      {field:{field,operator,value}}, {and:[..]}, {or:[..]}, {not:..},
 *      {id_eq:".."}; values are tagged ({string}|{integer}|{float}|{boolean}|
 *      {array}|"null"). Flat maps / suffix keys / unknown ops / untagged values
 *      -> 400 INVALID_REQUEST. Evaluation mirrors `Filter::matches`: contains =
 *      case-insensitive substring, a missing field matches only `ne`/`nin`/
 *      `exists:false`, `in`/`nin` take arrays. That is the SQL-connector (full
 *      push-down) semantics and is used by `query`. The update-by-query /
 *      delete-by-query / count routes ALWAYS use the engine's in-memory
 *      `Filter::matches` (src/core/types.rs): starts_with / ends_with / regex /
 *      exists / nin are always false, `contains` is string-only, a missing field
 *      matches only `ne`, ordering compares same-type scalars only. The `query`
 *      route additionally supports `options.queryFilterMode: 'sqlite'` — only
 *      `id_eq` is pushed down, every other filter returns all rows (the SQLite
 *      connector), so Lore's client-side predicates are what keeps results right.
 *      In that mode the mock ALSO ignores `sort` and `offset` and reports
 *      `total_count = page length`, `has_more = false` (sqlite.rs:186-245: the
 *      connector runs `SELECT id, data FROM t [WHERE id=?] LIMIT n` and nothing else).
 *      `id_eq` is extracted at the top level or inside an `and` (sqlite.rs:96-108).
 *      count / delete-by-query read at most `options.byQueryWindow` rows (the engine's
 *      `connector.query(limit 100_000)`): in 'sqlite' mode the first N rows of the UNFILTERED
 *      table (or an exact `id_eq` lookup), in 'full' mode the first N MATCHING rows; the
 *      in-memory filter is applied on top. delete-by-query rejects filter `all` (HTTP 200
 *      envelope, ERR_VALIDATION; count does not), deletes row by row and SKIPS a row whose
 *      delete fails (`options.failRowDelete`) while still answering 200 with the lower count.
 *   3. `id` is the primary key. A duplicate primary key or declared unique index
 *      is HTTP 500 `ERR_QUERY` "Query execution failed. Check server logs for
 *      details." — NOT 409: handlers.rs `create_record` (:2594) maps every
 *      connector Err to 500 and core/error.rs `into_api_error` (:107-131)
 *      suppresses the raw DB message, so there is no structured duplicate code
 *      (the SQLite connector would silently REPLACE instead, sqlite.rs:269).
 *      Undeclared fields are accepted (gf_extra). A schema re-POST creates
 *      nothing new and 500s `ERR_SCHEMA` when ANY field (not only an indexed
 *      one) or index names a column the existing table lacks — Postgres
 *      `create_collection` runs `COMMENT ON COLUMN` for every declared field in
 *      one transaction (postgres.rs:1020ff), so the whole re-push rolls back. A
 *      successful POST /v1/schema is 201 (handlers.rs:2063). GET /v1/schema/:c
 *      lists the declared fields; unknown collection -> HTTP 200 with
 *      `{success:false,error:{code:'ERR_NOT_FOUND'}}` (handlers.rs:1892). Primary
 *      keys are immutable (update with a different id -> 400).
 *   3b. Audit fields (handlers.rs:2499-2532, on unless GF_AUDIT_FIELDS_ENABLED=false):
 *      create fills created_at/updated_at/created_by/updated_by ONLY when the
 *      caller did not supply them; update-by-query (:3851/:3882) and update
 *      ALWAYS overwrite `updated_at` (server time, RFC 3339 with `+00:00`) and
 *      `updated_by`, discarding a caller-supplied value.
 *   3c. `POST /:c/bulk` ignores any caller `id`: each record becomes
 *      `Record{id: String::new()}` (handlers.rs:3587ff) and the connector assigns
 *      its own id (sqlite.rs:258 `Uuid::new_v4()`); the response is
 *      `{inserted, ids, total_requested}`. There is no record-count cap and no
 *      all-or-nothing transaction on SQLite (per-row INSERT): a failure part-way
 *      leaves the earlier rows written. Single `POST /:c` DOES honour a top-level
 *      `id` (`CreateRequest.id`).
 *   4. Vector search: limit capped at 100; `metadata_filter` is honoured with
 *      connector-specific semantics chosen by `options.vectorFilterMode`
 *      ('qdrant' default: string Fields at top level or in ONE `and`, every
 *      operator treated as eq, the rest dropped; 'none-zilliz': only a single
 *      top-level Field; 'ignore': Arango — no filtering at all). The score key is
 *      chosen by `options.scoreKey`.
 *   5. Keyword `/search {query, fields, limit}`: no filter (a `filter` key is
 *      ignored exactly like the engine), limit <= 500, empty query -> 400, Okapi BM25
 *      `_score` when `options.ftsMode` is 'ranked' (default), none for 'substring'. The BM25
 *      corpus statistics (N, df, avgdl) span every row on the connector, across Dataplane
 *      workspaces and collections, like Arango's single `AppDocumentsSearch` view
 *      (arangodb.rs:1529-1590) — the score is NOT tenant-local.
 *   7. Graph traverse takes NO filter, returns vertices annotated with `_depth`,
 *      BFS within the same Dataplane workspace only. The Arango connector returns
 *      each vertex as its bare `_key` mapped to `id` (verified against
 *      connectors/arangodb.rs `document_to_record`); `options.traverseVertexShape`
 *      ('bare' default | 'prefixed' = `lore_node/<key>` | 'key' = `_key` only, no
 *      `id`) exercises adapters' normalisation of shapes that have not been
 *      observed live.
 *   8. Collection-first everywhere (`/v1/:c/query|count|bulk|update-by-query|
 *      delete-by-query|:id|vector/search|search|graph/*`). Shapes: insert/query
 *      raw; count/update/delete/graph/search wrapped in `ApiResponse`; GET
 *      `/:c/:id` is the `ApiResponse` envelope `{success:true,data:{id,...}}` and
 *      a missing record is HTTP 200 `{success:false,error:{code:'ERR_NOT_FOUND',
 *      message:'Record not found'}}` (handlers.rs:2698 `get_record` returns
 *      `Json<ApiResponse<RecordResponse>>`, never a 404 status); other errors use
 *      the engine's `{success:false, error:{code,message}}`.
 *   6. `POST /v1/transaction` (handlers.rs:5438 `transaction_handler`; postgres.rs:1444
 *      `batch_write_atomic` + :1480 `execute_batch_ops_in_pg_tx`; dsl/types.rs:296-345;
 *      dsl/validator.rs:80-101). Body `{operations:[{op:'create'|'update'|'delete'|
 *      'bulk_create'|'rebac_write', collection, fields|filter|records, as?}], atomic?}`.
 *      - 1..100 ops, <= 1000 bulk records, aliases `[a-z_][a-z0-9_]*` and unique:
 *        a parse failure is 400 INVALID_REQUEST, a validator failure 400 LIMIT_EXCEEDED,
 *        `atomic:false` 501 UNSUPPORTED_OP. All ops commit or none do (rows are
 *        restored on any failure); a failing op answers 409 OP_FAILED with the
 *        message `op N: <kind> <collection> failed: ...` (the handler maps a message
 *        containing "op " + "failed:" to 409).
 *      - `create` / `bulk_create` HONOUR a non-empty string `fields.id` (postgres.rs:
 *        insert_single_in_pg_tx), otherwise assign one; NO audit-field fill; a
 *        duplicate primary key / unique index is 409 OP_FAILED (not the 500 of the
 *        single-record route).
 *      - `update` / `delete` filter with the SQL push-down semantics (`where_sql`, the
 *        same evaluator as `/query`), NOT the strict in-memory matcher of
 *        update-by-query / delete-by-query / count. `modified` = `matched` = rows hit.
 *      - A top-level string field value shaped `$alias.id` is an alias reference
 *        (postgres.rs:1739 `try_resolve_alias_ref_pg`): resolved to the id an earlier
 *        op created, and an UNDECLARED alias fails the whole transaction with a
 *        validation error. Lore row text is user-controlled, so the Lore client must
 *        not send such a value in a transaction (see engines/dataplaneTransaction.ts).
 *      - `Idempotency-Key` (header, used when non-empty and <= 128 chars): the response
 *        is cached per (workspace, key) and REPLAYED for the same key — INCLUDING an
 *        error response (handlers.rs:5461-5500 consults the store before parsing, the
 *        outer boundary caches whatever the closure returned). A retry after a failure
 *        therefore needs a NEW key. (The engine's 409 IN_FLIGHT for concurrent
 *        duplicates is not modelled: the mock executes one request at a time.)
 *      - `options.transactions === false` models an engine / connector without the
 *        route as a plain 404 ERR_NOT_FOUND. `'fallthrough'` models an older engine that
 *        routes `POST /v1/transaction` to the single-record create of a collection named
 *        "transaction": HTTP 201 and the created record, NO `committed` field (review C #4).
 *      - The 409 IN_FLIGHT for a concurrent duplicate key (handlers.rs idempotency store)
 *        is modelled through `holdInFlight(workspace, key)`: the route answers 409
 *        `IN_FLIGHT` "request with this Idempotency-Key is still in flight", not cached.
 *   9. Per-route connector resolution (review C #1; handlers.rs `get_or_create_connection`
 *      :265-277). The engine picks a connector PER REQUEST: an explicit non-empty name
 *      (request body `connection` for POST/PUT/DELETE bodies, `?connection=` for GET and
 *      `/v1/transaction`), else the DEFAULT_CONNECTOR env (`options.defaultConnector`,
 *      default null = unset), else the route's own default: sqlite for CRUD / query /
 *      count / bulk / by-query / schema / get / vector / graph-edge, postgresql for keyword
 *      `/search` (:5384) and `/v1/transaction` (:5782), surrealdb for graph traverse (:2898).
 *      Every connector has its OWN data (a table created through sqlite is not visible to
 *      postgresql), so a client that sends no `connection` on every route splits its data
 *      across stores. A connector not in `options.connectors` is 503 ERR_CONNECTOR_NOT_FOUND.
 *      `/v1/transaction` on a connector without atomic multi-collection writes (anything
 *      but postgresql / arangodb) is 501 UNSUPPORTED_CONNECTOR, answered after validation
 *      and before any op runs; an op on a collection the connector lacks fails the whole
 *      transaction (409 OP_FAILED, relation does not exist). An op failure message is
 *      engine-shaped: "Query error: op N: <kind> <coll> failed: Query error: insert in tx
 *      rejected: db error: ERROR: duplicate key value violates unique constraint ...".
 *
 * Documented mock-only convenience (permissive): traversed vertices carry a
 * `relation` field copied from the discovering edge's properties; the real
 * connector returns edge properties differently. Lore's relation post-filter
 * depends on it until Slice B.
 *
 * Inspection helpers on the returned handle: `snapshot()` (legacy shape used by
 * e2e-q2-2), `rows(workspace, collection, connector?)` (THROWS when the collection holds
 * data under more than one connector and none is named: that is a split-brain), `requests` (every request seen, with
 * parsed body) and mutable `options`.
 */

import http from 'node:http';
import { AddressInfo } from 'node:net';

type Rec = Record<string, unknown>;

/* ─── Public types ───────────────────────────────────────────── */

export interface MockDataplaneOptions {
    /** bearer token -> Dataplane workspace id. When set, missing/unknown bearer -> 401. */
    apiKeys?: Record<string, string>;
    /** Workspace used when `apiKeys` is not given (any bearer, or none). */
    defaultWorkspace?: string;
    /** Vector `metadata_filter` push-down semantics (see header). */
    vectorFilterMode?: 'qdrant' | 'ignore' | 'none-zilliz';
    /** Which key carries the similarity in vector results. */
    scoreKey?: 'score' | 'distance' | '_distance' | '_score' | 'none';
    /** Keyword search ranking: 'ranked' adds `_score`, 'substring' does not. */
    ftsMode?: 'ranked' | 'substring';
    /** `query` filter push-down: 'full' (SQL connectors, default) | 'sqlite' (only `id_eq` is applied). */
    queryFilterMode?: 'full' | 'sqlite';
    /** Rows count / delete-by-query examine (engine: `limit: 100_000`); see header. Default 100000. */
    byQueryWindow?: number;
    /** Fault injection: delete-by-query's per-row delete fails for rows this returns true for (the engine skips them). Default none. */
    failRowDelete?: (row: Rec) => boolean;
    /** Shape of traversed vertices' id (see header item 7). */
    traverseVertexShape?: 'bare' | 'prefixed' | 'key';
    /** `POST /v1/transaction` present (default true). false -> 404, like an engine/connector without it; 'fallthrough' -> old engine routing it to single-record create (see header). */
    transactions?: boolean | 'fallthrough';
    /** The engine's DEFAULT_CONNECTOR env. null/unset = not configured (the engine's per-route defaults apply). */
    defaultConnector?: string | null;
    /** Connectors configured in the engine's registry (default sqlite, postgresql, arangodb, surrealdb). */
    connectors?: string[];
}

export interface RecordedRequest {
    method: string;
    path: string;
    workspace: string | null;
    body: Rec;
    /** The `Idempotency-Key` request header, when sent. */
    idempotencyKey?: string;
    /** The `connection` the client sent (body field or `?connection=`), when sent. */
    connection?: string;
    /** The connector the engine resolved for this request (explicit, DEFAULT_CONNECTOR, or the route default). */
    connector?: string;
}

export interface MockDataplane {
    url: string;
    close: () => Promise<void>;
    /** Legacy shape (e2e-q2-2): one bucket per Dataplane workspace. */
    snapshot: () => { tenants: Array<{ tenantId: string; collections: Array<{ name: string; count: number }> }> };
    /** Deep copy of the raw stored rows of (workspace, collection[, connector]); throws when several connectors hold the collection and none is named. */
    rows: (workspace: string, collection: string, connector?: string) => Rec[];
    /** Declared fields of (workspace, collection[, connector]), or null when the collection does not exist. */
    declaredFields: (workspace: string, collection: string, connector?: string) => string[] | null;
    /** Connectors that hold `collection` in `workspace` (empty when none). */
    connectorsWith: (workspace: string, collection: string) => string[];
    /** Make `/v1/transaction` answer 409 IN_FLIGHT for (workspace, idempotency key) until released. Returns the release function. */
    holdInFlight: (workspace: string, key: string) => () => void;
    /** Every request the mock has served (health included), oldest first. */
    requests: RecordedRequest[];
    /** Mutable behaviour switches (take effect on the next request). */
    options: Required<Pick<MockDataplaneOptions, 'vectorFilterMode' | 'scoreKey' | 'ftsMode' | 'queryFilterMode' | 'byQueryWindow' | 'failRowDelete' | 'traverseVertexShape' | 'transactions' | 'defaultConnector' | 'connectors'>>;
}

/* ─── Engine filter grammar ──────────────────────────────────── */

export class InvalidFilterError extends Error {}

type Node =
    | { k: 'all' }
    | { k: 'field'; field: string; op: string; value: unknown }
    | { k: 'and'; items: Node[] }
    | { k: 'or'; items: Node[] }
    | { k: 'not'; item: Node }
    | { k: 'id_eq'; id: string };

const OPS = new Set([
    'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'nin',
    'contains', 'starts_with', 'ends_with', 'exists', 'regex',
]);

function decodeValue(v: unknown): unknown {
    if (v === 'null') return null;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
        const keys = Object.keys(v as Rec);
        if (keys.length === 1) {
            const k = keys[0]!;
            const inner = (v as Rec)[k];
            if (k === 'string' && typeof inner === 'string') return inner;
            if (k === 'integer' && typeof inner === 'number' && Number.isInteger(inner)) return inner;
            if (k === 'float' && typeof inner === 'number') return inner;
            if (k === 'boolean' && typeof inner === 'boolean') return inner;
            if (k === 'array' && Array.isArray(inner)) return inner.map(decodeValue);
        }
    }
    throw new InvalidFilterError(`untagged or unknown filter value: ${JSON.stringify(v)}`);
}

export function parseEngineFilter(f: unknown): Node {
    if (f === 'all') return { k: 'all' };
    if (!f || typeof f !== 'object' || Array.isArray(f)) {
        throw new InvalidFilterError(`filter must be "all" or a tagged object, got ${JSON.stringify(f)}`);
    }
    const keys = Object.keys(f as Rec);
    if (keys.length !== 1) {
        throw new InvalidFilterError(`filter object must have exactly one tag, got [${keys.join(',')}] (flat filter maps are not accepted)`);
    }
    const tag = keys[0]!;
    const inner = (f as Rec)[tag];
    switch (tag) {
        case 'field': {
            const c = inner as Rec;
            if (!c || typeof c !== 'object' || typeof c['field'] !== 'string' || typeof c['operator'] !== 'string' || !('value' in c)) {
                throw new InvalidFilterError('field clause needs {field, operator, value}');
            }
            if (!OPS.has(c['operator'] as string)) throw new InvalidFilterError(`unknown operator '${String(c['operator'])}'`);
            const value = decodeValue(c['value']);
            const op = c['operator'] as string;
            if ((op === 'in' || op === 'nin') && !Array.isArray(value)) throw new InvalidFilterError(`${op} needs an array value`);
            return { k: 'field', field: c['field'] as string, op, value };
        }
        case 'and':
        case 'or': {
            if (!Array.isArray(inner)) throw new InvalidFilterError(`${tag} needs an array`);
            return { k: tag, items: inner.map(parseEngineFilter) } as Node;
        }
        case 'not':
            return { k: 'not', item: parseEngineFilter(inner) };
        case 'id_eq':
            if (typeof inner !== 'string') throw new InvalidFilterError('id_eq needs a string');
            return { k: 'id_eq', id: inner };
        default:
            throw new InvalidFilterError(`unknown filter tag '${tag}' (flat / suffix-key filters are not accepted)`);
    }
}

const present = (v: unknown): boolean => v !== undefined && v !== null;
const sameScalar = (a: unknown, b: unknown): boolean =>
    typeof a === typeof b && a === b;

function cmpOrdered(a: unknown, b: unknown): number | null {
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
    return null;
}

function fieldMatches(rec: Rec, field: string, op: string, want: unknown): boolean {
    const have = rec[field];
    if (op === 'exists') return want === false ? !present(have) : present(have);
    if (!present(have)) {
        if (op === 'eq' || op === 'in') return want === null && op === 'eq';
        return op === 'ne' || op === 'nin';
    }
    switch (op) {
        case 'eq': return want !== null && sameScalar(have, want);
        case 'ne': return !(want !== null && sameScalar(have, want));
        case 'gt': { const c = cmpOrdered(have, want); return c !== null && c > 0; }
        case 'gte': { const c = cmpOrdered(have, want); return c !== null && c >= 0; }
        case 'lt': { const c = cmpOrdered(have, want); return c !== null && c < 0; }
        case 'lte': { const c = cmpOrdered(have, want); return c !== null && c <= 0; }
        case 'in': return (want as unknown[]).some((w) => sameScalar(have, w));
        case 'nin': return !(want as unknown[]).some((w) => sameScalar(have, w));
        case 'contains': {
            const needle = String(want).toLowerCase();
            if (Array.isArray(have)) return have.some((h) => String(h).toLowerCase() === needle);
            return String(have).toLowerCase().includes(needle);
        }
        case 'starts_with': return String(have).toLowerCase().startsWith(String(want).toLowerCase());
        case 'ends_with': return String(have).toLowerCase().endsWith(String(want).toLowerCase());
        case 'regex': try { return new RegExp(String(want)).test(String(have)); } catch { return false; }
        default: return false;
    }
}

/**
 * The engine's in-memory `Filter::matches` (src/core/types.rs). Used by the
 * update-by-query / delete-by-query / count routes regardless of connector:
 * starts_with / ends_with / regex / exists / nin are always false, `contains` is
 * string-only (case-insensitive), a missing field matches only `ne`, ordering is
 * defined for same-type scalars only. The physical `id` is NOT a field: connectors
 * put it in `record.id` and keep it out of `record.fields` (postgres.rs row_to_record,
 * arangodb.rs document_to_record, sqlite.rs:227), so a field clause on `id` behaves
 * as a missing field. Only `id_eq` matches the physical id on these routes.
 */
function fieldMatchesStrict(rec: Rec, field: string, op: string, want: unknown): boolean {
    const have = field === 'id' ? undefined : rec[field];
    if (!present(have)) return op === 'ne';
    switch (op) {
        case 'eq': return want !== null && sameScalar(have, want);
        case 'ne': return !(want !== null && sameScalar(have, want));
        case 'gt': { const c = typeof have === typeof want ? cmpOrdered(have, want) : null; return c !== null && c > 0; }
        case 'gte': { const c = typeof have === typeof want ? cmpOrdered(have, want) : null; return c !== null && c >= 0; }
        case 'lt': { const c = typeof have === typeof want ? cmpOrdered(have, want) : null; return c !== null && c < 0; }
        case 'lte': { const c = typeof have === typeof want ? cmpOrdered(have, want) : null; return c !== null && c <= 0; }
        case 'contains':
            return typeof have === 'string' && typeof want === 'string' && have.toLowerCase().includes(want.toLowerCase());
        case 'in': return Array.isArray(want) && want.some((w) => sameScalar(have, w));
        default: return false; // starts_with, ends_with, regex, exists, nin
    }
}

export function evalEngineFilter(rec: Rec, n: Node, strict = false): boolean {
    switch (n.k) {
        case 'all': return true;
        case 'id_eq': return rec['id'] === n.id;
        case 'field': return strict ? fieldMatchesStrict(rec, n.field, n.op, n.value) : fieldMatches(rec, n.field, n.op, n.value);
        case 'and': return n.items.every((i) => evalEngineFilter(rec, i, strict));
        case 'or': return n.items.some((i) => evalEngineFilter(rec, i, strict));
        case 'not': return !evalEngineFilter(rec, n.item, strict);
    }
}

/** sqlite.rs `extract_id_from_filter`: the id of a top-level `id_eq`, or of the first `id_eq` inside a top-level `and`. */
function sqliteIdOf(n: Node): string | null {
    if (n.k === 'id_eq') return n.id;
    if (n.k === 'and') {
        for (const i of n.items) if (i.k === 'id_eq') return i.id;
    }
    return null;
}

/** SQLite connector push-down: only an id filter (top level or inside `and`) is applied on `query`; any other filter returns every row. */
function sqlitePushdown(rec: Rec, n: Node): boolean {
    const id = sqliteIdOf(n);
    return id === null ? true : rec['id'] === id;
}

/** Qdrant push-down: string Field clauses at top level or inside ONE `and`; all ops become eq; rest dropped. */
function qdrantEqPairs(n: Node): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    const take = (c: Node) => {
        if (c.k === 'field' && typeof c.value === 'string') out.push([c.field, c.value]);
    };
    if (n.k === 'and') n.items.forEach(take);
    else take(n);
    return out;
}

/* ─── Storage ────────────────────────────────────────────────── */

interface IndexDecl { name: string; fields: string[]; unique: boolean }

interface Coll {
    declared: Set<string>;
    indexes: IndexDecl[];
    rows: Rec[];
    /** Auto-created by a read/insert on an undeclared collection (the mock's leniency), not by POST /v1/schema. */
    bare?: boolean;
}

/** A collection a strict connector would know: created through the schema route, or already holding rows. */
const existsIn = (c: Coll | undefined): c is Coll => !!c && (!c.bare || c.rows.length > 0);

interface StoredEdge { fromId: string; toId: string; edgeCollection: string; properties?: Rec }

class ApiError extends Error {
    constructor(public status: number, public code: string, message: string) {
        super(message);
    }
}

const invalid = (m: string) => new ApiError(400, 'INVALID_REQUEST', m);

/**
 * The engine's answer to ANY connector failure on create/bulk/update: HTTP 500
 * with the raw database message suppressed (core/error.rs:107-131
 * `into_api_error`). A duplicate primary key / unique violation is
 * indistinguishable from any other query failure.
 */
const engineQueryError = () =>
    new ApiError(500, 'ERR_QUERY', 'Query execution failed. Check server logs for details.');

/** chrono `Utc::now().to_rfc3339()`: nanosecond digits and a `+00:00` offset (never `Z`). */
const rfc3339Now = (): string => `${new Date().toISOString().slice(0, -1)}000000+00:00`;

/* ─── HTTP helpers ───────────────────────────────────────────── */

async function readJson(req: http.IncomingMessage): Promise<Rec> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            if (!raw) return resolve({});
            try {
                resolve(JSON.parse(raw) as Rec);
            } catch {
                reject(invalid('malformed JSON body'));
            }
        });
        req.on('error', reject);
    });
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}

const ok = <T>(data: T) => ({ success: true, data, error: null });

/* ─── Route table ────────────────────────────────────────────── */

interface Ctx {
    method: string;
    parts: string[];
    body: Rec;
    ws: string;
    query: URLSearchParams;
    headers: http.IncomingHttpHeaders;
}
interface Reply { status: number; body: unknown }
interface Route {
    method: string;
    /** Path template after /v1; `:x` binds a segment. */
    pattern: string[];
    handle: (ctx: Ctx, p: Record<string, string>) => Reply;
    /** Connector the engine falls back to when neither the request nor DEFAULT_CONNECTOR names one (default 'sqlite'). */
    connDefault?: string;
    /** Answer the connector-registry check inside the handler (the transaction route caches its errors). */
    deferConnCheck?: boolean;
}

export async function startMockDataplane(opts: MockDataplaneOptions = {}): Promise<MockDataplane> {
    const options = {
        vectorFilterMode: opts.vectorFilterMode ?? 'qdrant',
        scoreKey: opts.scoreKey ?? 'score',
        ftsMode: opts.ftsMode ?? 'ranked',
        queryFilterMode: opts.queryFilterMode ?? 'full',
        byQueryWindow: opts.byQueryWindow ?? 100_000,
        failRowDelete: opts.failRowDelete ?? (() => false),
        traverseVertexShape: opts.traverseVertexShape ?? 'bare',
        transactions: opts.transactions ?? true,
        defaultConnector: opts.defaultConnector ?? null,
        connectors: opts.connectors ?? ['sqlite', 'postgresql', 'arangodb', 'surrealdb'],
    } as MockDataplane['options'];
    const defaultWorkspace = opts.defaultWorkspace ?? 'default-workspace';
    // One data set per (Dataplane workspace, connector): a table created through one connector is
    // invisible to another (review C #1). `curConn` is the connector the dispatcher resolved for the
    // request being handled (handlers are synchronous, so a module-level cursor is safe).
    const workspaces = new Map<string, Map<string, Coll>>();
    const edges = new Map<string, StoredEdge[]>();
    let curConn = 'sqlite';
    const SEP = '\u0001';
    const skey = (ws: string): string => `${ws}${SEP}${curConn}`;
    const inFlight = new Set<string>();
    const requests: RecordedRequest[] = [];
    let idSeq = 0;

    const wsColls = (ws: string): Map<string, Coll> => {
        let t = workspaces.get(skey(ws));
        if (!t) { t = new Map(); workspaces.set(skey(ws), t); }
        return t;
    };
    /** Existing collection, else a bare one (undeclared fields are accepted). */
    const coll = (ws: string, name: string): Coll => {
        const t = wsColls(ws);
        let c = t.get(name);
        if (!c) { c = { declared: new Set(['id']), indexes: [], rows: [], bare: true }; t.set(name, c); }
        return c;
    };

    const clone = (r: Rec[]): Rec[] => JSON.parse(JSON.stringify(r)) as Rec[];
    /** Connectors under which (workspace, collection) exists. */
    const holders = (ws: string, name: string): string[] =>
        [...workspaces.entries()].filter(([k, t]) => k.startsWith(`${ws}${SEP}`) && existsIn(t.get(name))).map(([k]) => k.slice(ws.length + 1));

    const filterOf = (body: Rec, key: string, required: boolean): Node => {
        if (body[key] === undefined || body[key] === null) {
            if (required) throw invalid(`\`${key}\` is required`);
            return { k: 'all' };
        }
        try { return parseEngineFilter(body[key]); } catch (e) {
            throw invalid((e as Error).message);
        }
    };

    /**
     * The rows count / delete-by-query examine: the engine runs `connector.query(limit 100_000)` and then
     * applies `Filter::matches` in memory. sqlite: first N rows of the unfiltered table, or an exact id
     * lookup when `sqliteIdOf` finds one. Otherwise (SQL push-down): first N MATCHING rows.
     */
    const byQueryRows = (rows: Rec[], node: Node): Rec[] => {
        const n = options.byQueryWindow;
        if (options.queryFilterMode === 'sqlite') {
            const id = sqliteIdOf(node);
            return (id === null ? rows : rows.filter((r) => r['id'] === id)).slice(0, n).filter((r) => evalEngineFilter(r, node, true));
        }
        return rows.filter((r) => evalEngineFilter(r, node, true)).slice(0, n);
    };

    const checkUnique = (c: Coll, candidate: Rec, ignore?: Rec): void => {
        // Engine: duplicate PK / unique index -> connector Err -> HTTP 500 ERR_QUERY (see engineQueryError).
        if (c.rows.some((r) => r !== ignore && r['id'] === candidate['id'])) throw engineQueryError();
        for (const ix of c.indexes) {
            if (!ix.unique) continue;
            const key = (r: Rec) => JSON.stringify(ix.fields.map((f) => r[f] ?? null));
            const k = key(candidate);
            if (c.rows.some((r) => r !== ignore && key(r) === k)) throw engineQueryError();
        }
    };

    /** handlers.rs:2499 `audit_on_create_into`: fill the four audit fields the caller did not supply. */
    const auditOnCreate = (row: Rec, ws: string): void => {
        const now = rfc3339Now();
        if (!('created_at' in row)) row['created_at'] = now;
        if (!('updated_at' in row)) row['updated_at'] = now;
        if (!('created_by' in row)) row['created_by'] = ws;
        if (!('updated_by' in row)) row['updated_by'] = ws;
    };

    const insertRow = (c: Coll, body: Rec, ws: string): Rec => {
        const row: Rec = { ...body };
        // The SDK's insert merges `connection` into the payload; the engine reads it as its own
        // CreateRequest field, never as a column.
        delete row['connection'];
        if (typeof row['id'] !== 'string' || row['id'] === '') row['id'] = `rec_${++idSeq}`;
        auditOnCreate(row, ws);
        checkUnique(c, row);
        c.rows.push(row);
        return row;
    };

    const project = (rows: Rec[], body: Rec): Rec[] => {
        // The engine's QueryRequest key is `projection`; `fields` is NOT read on query (it is ignored).
        const proj = (Array.isArray(body['projection']) ? body['projection'] : null) as string[] | null;
        if (!proj || proj.length === 0) return rows;
        return rows.map((r) => {
            const o: Rec = { id: r['id'] };
            for (const f of proj) if (f in r) o[f] = r[f];
            return o;
        });
    };


    /* ─── POST /v1/transaction ─────────────────────────────────── */

    /** Idempotency store (handlers.rs:5461): every response, errors included, replayed per (workspace, key). */
    const txReplay = new Map<string, Reply>();

    const TX_OPS = new Set(['create', 'update', 'delete', 'bulk_create', 'rebac_write']);
    const ALIAS_NAME = /^[a-z_][a-z0-9_]*$/;
    const ALIAS_REF = /^\$([^.]*)\.id$/;

    const txResolve = (fields: Rec, aliases: Map<string, string>, idx: number): Rec => {
        const out: Rec = {};
        for (const [k, v] of Object.entries(fields)) {
            const m = typeof v === 'string' ? ALIAS_REF.exec(v) : null;
            if (m && ALIAS_NAME.test(m[1]!)) {
                const id = aliases.get(m[1]!);
                if (id === undefined) {
                    throw new ApiError(400, 'ERR_VALIDATION', `op ${idx}: field '${k}' references undeclared alias '$${m[1]}.id'`);
                }
                out[k] = id;
            } else out[k] = v;
        }
        return out;
    };

    const runTransaction = (body: Rec, ws: string): Rec => {
        const t0 = Date.now();
        const bad = (m: string) => new ApiError(400, 'INVALID_REQUEST', `Invalid batch-write syntax: ${m}`);
        const ops = body['operations'];
        if (!Array.isArray(ops)) throw bad('missing field `operations`');
        if (body['atomic'] !== undefined && typeof body['atomic'] !== 'boolean') throw bad('`atomic` must be a boolean');
        const isObj = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);
        const filters = new Map<number, Node>();
        ops.forEach((raw, i) => {
            if (!isObj(raw) || typeof raw['op'] !== 'string' || !TX_OPS.has(raw['op'])) throw bad(`operations[${i}]: unknown or missing \`op\``);
            if (typeof raw['collection'] !== 'string' && raw['op'] !== 'rebac_write') throw bad(`operations[${i}]: missing field \`collection\``);
            if ((raw['op'] === 'create' || raw['op'] === 'update') && !isObj(raw['fields'])) throw bad(`operations[${i}]: missing field \`fields\``);
            if (raw['op'] === 'bulk_create' && (!Array.isArray(raw['records']) || !(raw['records'] as unknown[]).every(isObj))) throw bad(`operations[${i}]: missing field \`records\``);
            if (raw['op'] === 'update' || raw['op'] === 'delete') {
                try { filters.set(i, parseEngineFilter(raw['filter'])); } catch (e) { throw bad(`operations[${i}]: ${(e as Error).message}`); }
            }
        });
        const limit = (m: string) => new ApiError(400, 'LIMIT_EXCEEDED', m);
        if (ops.length === 0) throw limit('batch-write requires at least 1 operation');
        if (ops.length > 100) throw limit(`batch-write supports up to 100 operations; got ${ops.length}`);
        let bulkTotal = 0;
        const declared = new Set<string>();
        for (const raw of ops as Rec[]) {
            if (raw['op'] === 'bulk_create') bulkTotal += (raw['records'] as unknown[]).length;
            const a = raw['as'];
            if (a !== undefined && a !== null) {
                if (typeof a !== 'string' || !ALIAS_NAME.test(a)) throw limit(`invalid alias '${String(a)}'`);
                if (declared.has(a)) throw limit(`duplicate alias '${a}'`);
                declared.add(a);
            }
        }
        if (bulkTotal > 1000) throw limit(`batch-write supports up to 1000 bulk_create records; got ${bulkTotal}`);
        if (body['atomic'] === false) throw new ApiError(501, 'UNSUPPORTED_OP', 'Non-atomic batch writes are not implemented in Phase 1');
        // handlers.rs:5782ff: connector resolution comes AFTER parse + validate, BEFORE any op runs.
        if (!options.connectors.includes(curConn)) {
            throw new ApiError(503, 'ERR_CONNECTOR_NOT_FOUND', `Connector '${curConn}' not available in registry`);
        }
        if (curConn !== 'postgresql' && curConn !== 'arangodb') {
            throw new ApiError(501, 'UNSUPPORTED_CONNECTOR', `Connector '${curConn}' does not support atomic multi-collection writes. Supported in Phase 1: arangodb, postgresql.`);
        }

        // Execute against a copy; commit by keeping it, roll back by restoring.
        const t = wsColls(ws);
        const saved = new Map<string, Rec[]>([...t.entries()].map(([n, c]) => [n, c.rows.map((r) => ({ ...r }))]));
        const aliases = new Map<string, string>();
        const results: Rec[] = [];
        // A connector only knows the tables created THROUGH it (postgres.rs insert_single_in_pg_tx:
        // `relation "<c>" does not exist`). The whole transaction fails, nothing commits.
        const needColl = (collName: string, idx: number, kind: string): Coll => {
            const have = t.get(collName);
            if (!existsIn(have)) {
                throw new ApiError(409, 'OP_FAILED', `Query error: op ${idx}: ${kind} ${collName} failed: Query error: ${kind} in tx rejected: db error: ERROR: relation "${collName}" does not exist`);
            }
            return have;
        };
        const insertTx = (collName: string, fields: Rec, idx: number, kind: string): string => {
            const c = needColl(collName, idx, kind);
            const row: Rec = { ...fields };
            if (typeof row['id'] !== 'string' || row['id'] === '') row['id'] = `tx_${++idSeq}`;
            try { checkUnique(c, row); } catch (e) {
                if (e instanceof ApiError) throw new ApiError(409, 'OP_FAILED', `Query error: op ${idx}: ${kind} ${collName} failed: Query error: insert in tx rejected: db error: ERROR: duplicate key value violates unique constraint "${collName}_pkey"`);
                throw e;
            }
            c.rows.push(row);
            return String(row['id']);
        };
        try {
            (ops as Rec[]).forEach((op, idx) => {
                const collName = String(op['collection'] ?? '');
                const alias = typeof op['as'] === 'string' ? op['as'] : undefined;
                switch (op['op']) {
                    case 'create': {
                        const id = insertTx(collName, txResolve(op['fields'] as Rec, aliases, idx), idx, 'create');
                        if (alias) aliases.set(alias, id);
                        results.push({ op_index: idx, collection: collName, id, ...(alias ? { alias } : {}) });
                        break;
                    }
                    case 'bulk_create': {
                        const ids = (op['records'] as Rec[]).map((r) => insertTx(collName, txResolve(r, aliases, idx), idx, 'bulk_create'));
                        if (alias && ids[0] !== undefined) aliases.set(alias, ids[0]);
                        results.push({ op_index: idx, collection: collName, ids, ...(alias ? { alias } : {}) });
                        break;
                    }
                    case 'update': {
                        const c = needColl(collName, idx, 'update');
                        const patch = txResolve(op['fields'] as Rec, aliases, idx);
                        const hits = c.rows.filter((r) => evalEngineFilter(r, filters.get(idx)!));
                        for (const rec of hits) {
                            const next = { ...rec, ...patch };
                            try { checkUnique(c, next, rec); } catch (e) {
                                if (e instanceof ApiError) throw new ApiError(409, 'OP_FAILED', `Query error: op ${idx}: update ${collName} failed: Query error: update in tx rejected: db error: ERROR: duplicate key value violates unique constraint "${collName}_pkey"`);
                                throw e;
                            }
                            Object.assign(rec, patch);
                        }
                        results.push({ op_index: idx, collection: collName, matched: hits.length, modified: hits.length });
                        break;
                    }
                    case 'delete': {
                        const c = needColl(collName, idx, 'delete');
                        const before = c.rows.length;
                        c.rows = c.rows.filter((r) => !evalEngineFilter(r, filters.get(idx)!));
                        results.push({ op_index: idx, collection: collName, deleted: before - c.rows.length });
                        break;
                    }
                    default:
                        // rebac_write targets SpiceDB, which the mock does not model.
                        throw new ApiError(501, 'UNSUPPORTED_OP', 'rebac_write is not modelled by the mock Dataplane');
                }
            });
        } catch (e) {
            for (const [n, rows] of saved) { const c = t.get(n); if (c) c.rows = rows; }
            throw e;
        }
        return { results, committed: true, duration_ms: Date.now() - t0 };
    };

    const routes: Route[] = [
        /* schema */
        {
            method: 'POST', pattern: ['schema'],
            handle: ({ body, ws }) => {
                const name = String(body['name'] ?? '');
                if (!name) throw invalid('`name` is required for POST /v1/schema');
                const fields = Array.isArray(body['fields']) ? (body['fields'] as Rec[]) : [];
                if (fields.length === 0) throw new ApiError(400, 'ERR_VALIDATION', '`fields` is required and must not be empty');
                const indexes = (Array.isArray(body['indexes']) ? body['indexes'] : []) as Rec[];
                const t = wsColls(ws);
                const existing = t.get(name);
                if (!existsIn(existing)) {
                    const c: Coll = {
                        declared: new Set(fields.map((f) => String(f['name']))),
                        indexes: indexes.map((i) => ({ name: String(i['name']), fields: (i['fields'] as string[]) ?? [], unique: i['unique'] === true })),
                        rows: [],
                    };
                    c.declared.add('id');
                    t.set(name, c);
                    return { status: 201, body: ok({ name, fields: [...c.declared] }) };
                }
                // Re-push: `CREATE TABLE IF NOT EXISTS` is a no-op and adds no columns
                // (F8), but Postgres then runs `COMMENT ON COLUMN` for EVERY declared
                // non-id field plus `CREATE INDEX IF NOT EXISTS` for every `indexes[]`
                // entry, in one transaction (postgres.rs:1020ff). Any column the table
                // lacks makes the whole statement fail -> 500 ERR_SCHEMA, nothing changes.
                const missing = new Set<string>();
                for (const f of fields) {
                    const fname = String(f['name']);
                    if (fname !== 'id' && fname !== 'tenant_id' && !existing!.declared.has(fname)) missing.add(fname);
                }
                for (const i of indexes) {
                    for (const f of ((i['fields'] as string[]) ?? [])) if (!existing!.declared.has(f)) missing.add(f);
                }
                if (missing.size > 0) {
                    throw new ApiError(500, 'ERR_SCHEMA', 'A schema operation failed. Check server logs for details.');
                }
                return { status: 201, body: ok({ name, fields: [...existing!.declared] }) };
            },
        },
        {
            method: 'GET', pattern: ['schema'],
            handle: ({ ws }) => ({ status: 200, body: ok({ collections: [...wsColls(ws).keys()] }) }),
        },
        {
            method: 'GET', pattern: ['schema', ':c'],
            handle: ({ ws }, p) => {
                const found = wsColls(ws).get(p['c']!);
                const c = existsIn(found) ? found : undefined;
                // handlers.rs:1892 get_collection_schema: HTTP 200 + error envelope, not a 404.
                if (!c) return { status: 200, body: { success: false, data: null, error: { code: 'ERR_NOT_FOUND', message: `Collection '${p['c']}' not found` } } };
                return { status: 200, body: ok({ name: p['c'], fields: [...c.declared].map((name) => ({ name })) }) };
            },
        },

        /* query / count / bulk / by-query */
        {
            method: 'POST', pattern: [':c', 'query'],
            handle: ({ body, ws }, p) => {
                const node = filterOf(body, 'filter', false);
                const c = coll(ws, p['c']!);
                let matched = c.rows.filter((r) => (options.queryFilterMode === 'sqlite' ? sqlitePushdown(r, node) : evalEngineFilter(r, node)));
                const limit = Math.min(1000, typeof body['limit'] === 'number' ? (body['limit'] as number) : 100);
                if (options.queryFilterMode === 'sqlite') {
                    // sqlite.rs:186-245: no ORDER BY, no OFFSET — `sort` and `offset` are ignored,
                    // the first `limit` rows in storage order come back, and QueryResult::new
                    // reports total_count = page length / has_more = false.
                    const page = matched.slice(0, limit);
                    return { status: 200, body: { records: project(page, body), total_count: page.length, has_more: false } };
                }
                if (body['sort'] !== undefined) {
                    if (!Array.isArray(body['sort'])) throw invalid('`sort` must be an array of {field, direction}');
                    const specs = (body['sort'] as Rec[]).map((s) => {
                        const dir = s['direction'];
                        if (typeof s['field'] !== 'string' || (dir !== 'asc' && dir !== 'desc')) throw invalid('sort entries need {field, direction: asc|desc}');
                        return { field: s['field'] as string, dir: dir as 'asc' | 'desc' };
                    });
                    matched = [...matched].sort((a, b) => {
                        for (const s of specs) {
                            const c2 = cmpOrdered(a[s.field] ?? '', b[s.field] ?? '') ?? 0;
                            if (c2 !== 0) return s.dir === 'asc' ? c2 : -c2;
                        }
                        return 0;
                    });
                }
                const offset = typeof body['offset'] === 'number' ? Math.max(0, body['offset'] as number) : 0;
                const page = matched.slice(offset, offset + limit);
                return { status: 200, body: { records: project(page, body), total_count: matched.length, has_more: matched.length > offset + limit } };
            },
        },
        {
            method: 'POST', pattern: [':c', 'count'],
            handle: ({ body, ws }, p) => {
                const node = filterOf(body, 'filter', false);
                return { status: 200, body: ok({ count: byQueryRows(coll(ws, p['c']!).rows, node).length }) };
            },
        },
        {
            method: 'POST', pattern: [':c', 'bulk'],
            handle: ({ body, ws }, p) => {
                const recs = body['records'];
                if (!Array.isArray(recs) || recs.length === 0) throw invalid('`records` must be a non-empty array');
                const c = coll(ws, p['c']!);
                // Engine: every record becomes Record{id: ""} (handlers.rs:3587ff) so the
                // CALLER's `id` is ignored and the connector assigns its own (sqlite.rs:258
                // Uuid::new_v4()). Per-row insert, no count cap, no all-or-nothing: a failure
                // part-way (here: a unique-index violation) leaves the earlier rows written
                // and answers HTTP 500 ERR_QUERY.
                const ids: string[] = [];
                for (const r of recs as Rec[]) {
                    const row: Rec = { ...r };
                    row['id'] = `bulk_${++idSeq}`;
                    auditOnCreate(row, ws);
                    checkUnique(c, row);
                    c.rows.push(row);
                    ids.push(String(row['id']));
                }
                return { status: 201, body: ok({ inserted: ids.length, ids, total_requested: recs.length }) };
            },
        },
        {
            method: 'PUT', pattern: [':c', 'update-by-query'],
            handle: ({ body, ws }, p) => {
                const node = filterOf(body, 'filter', true);
                const fields = body['fields'];
                if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw invalid('`fields` is required');
                const c = coll(ws, p['c']!);
                const hits = c.rows.filter((r) => evalEngineFilter(r, node, true));
                for (const rec of hits) {
                    if ('id' in (fields as Rec) && (fields as Rec)['id'] !== rec['id']) {
                        throw new ApiError(400, 'ERR_VALIDATION', 'primary key `id` is immutable');
                    }
                }
                // handlers.rs:3882 audit_on_update_into: server time is canonical — a
                // caller-supplied updated_at / updated_by is overwritten.
                const patch: Rec = { ...(fields as Rec), updated_at: rfc3339Now(), updated_by: ws };
                for (const rec of hits) {
                    const next = { ...rec, ...patch };
                    checkUnique(c, next, rec);
                    Object.assign(rec, patch);
                }
                return { status: 200, body: ok({ updated: hits.length }) };
            },
        },
        {
            method: 'DELETE', pattern: [':c', 'delete-by-query'],
            handle: ({ body, ws }, p) => {
                const node = filterOf(body, 'filter', true);
                // handlers.rs:3680 — Filter::All is refused with an ApiResponse::error, which is HTTP 200.
                if (node.k === 'all') {
                    return { status: 200, body: { success: false, data: null, error: { code: 'ERR_VALIDATION', message: 'Filter::All is not allowed on delete-by-query. Use POST /:collection/truncate for intentional full deletes.' } } };
                }
                const c = coll(ws, p['c']!);
                // Per-row delete by id; a failing row is skipped (`Err: skip individual failures`) and not counted.
                const gone = new Set(byQueryRows(c.rows, node).filter((r) => !options.failRowDelete(r)));
                c.rows = c.rows.filter((r) => !gone.has(r));
                return { status: 200, body: ok({ deleted: gone.size }) };
            },
        },

        /* vector */
        {
            method: 'POST', pattern: [':c', 'vector', 'search'],
            handle: ({ body, ws }, p) => {
                const q = Array.isArray(body['vector']) ? (body['vector'] as number[]) : null;
                if (!q || q.length === 0) throw invalid('`vector` is required');
                const limit = Math.min(100, typeof body['limit'] === 'number' ? (body['limit'] as number) : 10);
                let pairs: Array<[string, string]> = [];
                if (body['metadata_filter'] !== undefined && body['metadata_filter'] !== null && options.vectorFilterMode !== 'ignore') {
                    const node = filterOf(body, 'metadata_filter', false);
                    if (options.vectorFilterMode === 'qdrant') pairs = qdrantEqPairs(node);
                    else if (node.k === 'field' && typeof node.value === 'string') pairs = [[node.field, node.value]];
                } else if (body['metadata_filter'] !== undefined && body['metadata_filter'] !== null) {
                    filterOf(body, 'metadata_filter', false); // still validated
                }
                const scored: Array<{ rec: Rec; cos: number }> = [];
                for (const rec of coll(ws, p['c']!).rows) {
                    if (!pairs.every(([f, v]) => rec[f] === v)) continue;
                    const v = rec['vector'];
                    if (!Array.isArray(v)) continue;
                    let dot = 0, a2 = 0, b2 = 0;
                    const n = Math.min(q.length, v.length);
                    for (let i = 0; i < n; i++) {
                        const av = Number(q[i]), bv = Number(v[i]);
                        dot += av * bv; a2 += av * av; b2 += bv * bv;
                    }
                    scored.push({ rec, cos: a2 === 0 || b2 === 0 ? 0 : dot / (Math.sqrt(a2) * Math.sqrt(b2)) });
                }
                scored.sort((x, y) => y.cos - x.cos);
                const top = scored.slice(0, limit).map(({ rec, cos }) => {
                    const out: Rec = { ...rec };
                    switch (options.scoreKey) {
                        case 'score': out['score'] = cos; break;
                        case 'distance': out['distance'] = cos; break; // Zilliz: similarity under a "distance" key
                        case '_distance': out['_distance'] = 1 - cos; break;
                        case '_score': out['_score'] = (1 + cos) / 2; break;
                        case 'none': break;
                    }
                    return out;
                });
                return { status: 200, body: { records: top, total_count: scored.length, has_more: scored.length > limit } };
            },
        },

        /* keyword search — NO filter (F4) */
        {
            method: 'POST', pattern: [':c', 'search'], connDefault: 'postgresql',
            handle: ({ body, ws }, p) => {
                const query = typeof body['query'] === 'string' ? (body['query'] as string) : '';
                if (!query.trim()) throw invalid('`query` is required and must be a non-empty string');
                const fields = Array.isArray(body['fields']) ? (body['fields'] as string[]) : [];
                const limit = Math.min(500, typeof body['limit'] === 'number' ? (body['limit'] as number) : 100);
                const terms = query.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean);
                const hayOf = (rec: Rec): string[] => {
                    const cols = fields.length > 0
                        ? fields
                        : Object.keys(rec).filter((k) => k !== 'id' && k !== 'vector' && typeof rec[k] === 'string');
                    return cols.map((f) => String(rec[f] ?? '').toLowerCase());
                };
                const tfOf = (hay: string[], t: string): number => hay.reduce((n, h) => n + h.split(t).length - 1, 0);
                // Okapi BM25 (k1=1.2, b=0.75) with corpus statistics (N, df, avgdl) taken over
                // EVERY row on this connector — all Dataplane workspaces, all collections — not
                // just the caller's. arangodb.rs:1529-1590: one `AppDocumentsSearch` view; tenant_id
                // and doc_type are SEARCH predicates that gate the hits but do not scope BM25's
                // index statistics. So a row's _score depends on other tenants' data (cross-tenant
                // IDF): the mock must not be kinder than that.
                const stats = { n: 0, len: 0, df: new Map<string, number>() };
                if (options.ftsMode === 'ranked') {
                    for (const [k, colls] of workspaces) {
                        if (!k.endsWith(`${SEP}${curConn}`)) continue;
                        for (const c of colls.values()) for (const rec of c.rows) {
                            const hay = hayOf(rec);
                            const dl = hay.reduce((n, h) => n + h.split(/[^a-z0-9_]+/).filter(Boolean).length, 0);
                            if (dl === 0) continue;
                            stats.n++; stats.len += dl;
                            for (const t of terms) if (tfOf(hay, t) > 0) stats.df.set(t, (stats.df.get(t) ?? 0) + 1);
                        }
                    }
                }
                const avgdl = stats.n > 0 ? stats.len / stats.n : 1;
                const hits: Array<{ rec: Rec; score: number }> = [];
                for (const rec of coll(ws, p['c']!).rows) {
                    const hay = hayOf(rec);
                    if (options.ftsMode === 'substring') {
                        if (hay.some((h) => h.includes(query.toLowerCase()))) hits.push({ rec, score: 0 });
                        continue;
                    }
                    const dl = hay.reduce((n, h) => n + h.split(/[^a-z0-9_]+/).filter(Boolean).length, 0);
                    let score = 0, any = false;
                    for (const t of terms) {
                        const tf = tfOf(hay, t);
                        if (tf === 0) continue;
                        any = true;
                        const df = stats.df.get(t) ?? 1;
                        const idf = Math.log(1 + (stats.n - df + 0.5) / (df + 0.5));
                        score += idf * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * dl / avgdl));
                    }
                    if (any) hits.push({ rec, score });
                }
                if (options.ftsMode === 'ranked') hits.sort((a, b) => b.score - a.score);
                const records = hits.slice(0, limit).map(({ rec, score }) => (options.ftsMode === 'ranked' ? { ...rec, _score: score } : { ...rec }));
                return { status: 200, body: ok({ records, query, collection: p['c'] }) };
            },
        },

        /* graph — traverse takes NO filter (F6) */
        {
            method: 'POST', pattern: [':c', 'graph', 'edge'],
            handle: ({ body, ws }) => {
                const list = edges.get(skey(ws)) ?? [];
                const edge_id = `edge_${list.length + 1}`;
                list.push({
                    fromId: String(body['from_id'] ?? ''),
                    toId: String(body['to_id'] ?? ''),
                    edgeCollection: String(body['edge_collection'] ?? ''),
                    properties: body['properties'] as Rec | undefined,
                });
                edges.set(skey(ws), list);
                return { status: 200, body: ok({ edge_id }) };
            },
        },
        {
            method: 'POST', pattern: [':c', 'graph', 'traverse'], connDefault: 'surrealdb',
            handle: ({ body, ws }, p) => {
                const cols = Array.isArray(body['edge_collections'])
                    ? (body['edge_collections'] as string[])
                    : typeof body['edge_collection'] === 'string' ? [body['edge_collection'] as string] : null;
                if (!cols) {
                    return { status: 200, body: { success: false, data: null, error: { code: 'ERR_MISSING_EDGE_COLLECTION', message: "Either 'edge_collection' (string) or 'edge_collections' (array) is required" } } };
                }
                const dir = String(body['direction'] ?? '').toLowerCase();
                if (!['inbound', 'in', 'outbound', 'out', 'both'].includes(dir)) {
                    return { status: 200, body: { success: false, data: null, error: { code: 'ERR_INVALID_DIRECTION', message: `Invalid direction '${dir}'` } } };
                }
                const bare = (s: string) => s.replace(/^.*\//, '');
                const start = bare(String(body['start_id'] ?? ''));
                const minD = typeof body['min_depth'] === 'number' ? (body['min_depth'] as number) : 1;
                const maxD = typeof body['max_depth'] === 'number' ? (body['max_depth'] as number) : 1;
                const all = (edges.get(skey(ws)) ?? []).filter((e) => cols.includes(e.edgeCollection));
                const nodes = coll(ws, p['c']!).rows;
                const seen = new Set<string>([start]);
                let frontier = [start];
                const records: Rec[] = [];
                for (let depth = 1; depth <= maxD && frontier.length > 0; depth++) {
                    const next: string[] = [];
                    for (const cur of frontier) {
                        for (const e of all) {
                            const f = bare(e.fromId), t = bare(e.toId);
                            let other: string | null = null;
                            if ((dir === 'outbound' || dir === 'out' || dir === 'both') && f === cur) other = t;
                            if (other === null && (dir === 'inbound' || dir === 'in' || dir === 'both') && t === cur) other = f;
                            if (other === null || seen.has(other)) continue;
                            seen.add(other);
                            next.push(other);
                            const node = nodes.find((r) => r['id'] === other);
                            if (node && depth >= minD) {
                                const vertex: Rec = { ...node, relation: (e.properties?.['relation'] ?? '') as string, _depth: depth };
                                if (options.traverseVertexShape === 'prefixed') vertex['id'] = `${p['c']}/${String(node['id'])}`;
                                else if (options.traverseVertexShape === 'key') { vertex['_key'] = vertex['id']; delete vertex['id']; }
                                records.push(vertex);
                            }
                        }
                    }
                    frontier = next;
                }
                return { status: 200, body: ok({ records, total_count: records.length, has_more: false }) };
            },
        },

        /* single-record CRUD */
        {
            method: 'POST', pattern: [':c'],
            handle: ({ body, ws }, p) => ({ status: 201, body: insertRow(coll(ws, p['c']!), body, ws) }),
        },
        {
            method: 'GET', pattern: [':c', ':id'],
            handle: ({ ws }, p) => {
                const rec = coll(ws, p['c']!).rows.find((r) => r['id'] === p['id']);
                // handlers.rs:2698 get_record: always HTTP 200 + ApiResponse envelope; a miss
                // is {success:false, error:{code:'ERR_NOT_FOUND', message:'Record not found'}}.
                if (!rec) return { status: 200, body: { success: false, data: null, error: { code: 'ERR_NOT_FOUND', message: 'Record not found' } } };
                return { status: 200, body: ok({ ...rec }) };
            },
        },
        {
            method: 'POST', pattern: ['transaction'],
            connDefault: 'postgresql', deferConnCheck: true,
            handle: ({ body, ws, headers, method, parts }) => {
                if (options.transactions === 'fallthrough') {
                    // Older engine: no /v1/transaction route; `POST /v1/:c` with c = "transaction" is the
                    // single-record create. 201 + the created record (NO `committed`, no `results`).
                    return { status: 201, body: insertRow(coll(ws, 'transaction'), body, ws) };
                }
                if (!options.transactions) {
                    return { status: 404, body: { success: false, data: null, error: { code: 'ERR_NOT_FOUND', message: `no handler for ${method} /v1/${parts.join('/')}` } } };
                }
                const rawKey = headers['idempotency-key'];
                const idemKey = typeof rawKey === 'string' && rawKey !== '' && rawKey.length <= 128 ? `${ws}\u0000${rawKey}` : null;
                if (idemKey !== null) {
                    const cached = txReplay.get(idemKey);
                    if (cached) return cached;
                    if (inFlight.has(idemKey)) {
                        // Not cached: the in-flight marker is released when the first request finishes.
                        return { status: 409, body: { success: false, data: null, error: { code: 'IN_FLIGHT', message: 'request with this Idempotency-Key is still in flight' } } };
                    }
                }
                let reply: Reply;
                try {
                    reply = { status: 200, body: ok(runTransaction(body, ws)) };
                } catch (e) {
                    if (!(e instanceof ApiError)) throw e;
                    reply = { status: e.status, body: { success: false, data: null, error: { code: e.code, message: e.message } } };
                }
                if (idemKey !== null) txReplay.set(idemKey, reply);
                return reply;
            },
        },
    ];

    const matchRoute = (method: string, parts: string[]): { route: Route; params: Record<string, string> } | null => {
        // Literal patterns win over `:c` so `schema`/`transaction` are not collections.
        const candidates = routes
            .filter((r) => r.method === method && r.pattern.length === parts.length)
            .sort((a, b) => b.pattern.filter((s) => !s.startsWith(':')).length - a.pattern.filter((s) => !s.startsWith(':')).length);
        for (const r of candidates) {
            const params: Record<string, string> = {};
            let good = true;
            for (let i = 0; i < parts.length; i++) {
                const seg = r.pattern[i]!;
                if (seg.startsWith(':')) params[seg.slice(1)] = parts[i]!;
                else if (seg !== parts[i]) { good = false; break; }
            }
            if (good) return { route: r, params };
        }
        return null;
    };

    const server = http.createServer(async (req, res) => {
        try {
            const u = new URL(req.url ?? '/', 'http://mock');
            const method = req.method ?? 'GET';
            const body = method === 'GET' || method === 'HEAD' ? {} : await readJson(req);
            const auth = String(req.headers['authorization'] ?? '');
            const bearer = /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim() ?? '';
            let ws: string | null;
            if (opts.apiKeys) ws = Object.prototype.hasOwnProperty.call(opts.apiKeys, bearer) && bearer ? opts.apiKeys[bearer]! : null;
            else ws = defaultWorkspace;
            const idemHeader = req.headers['idempotency-key'];
            // The SDK carries `connection` in the body (POST/PUT/DELETE bodies) or the query string
            // (GET, transaction) — the engine reads whichever its handler reads, nothing else.
            const sentBody = typeof body['connection'] === 'string' && body['connection'] !== '' ? (body['connection'] as string) : undefined;
            const sentQuery = u.searchParams.get('connection') || undefined;
            const rec: RecordedRequest = {
                method, path: u.pathname, workspace: ws, body,
                ...(typeof idemHeader === 'string' ? { idempotencyKey: idemHeader } : {}),
                ...((sentBody ?? sentQuery) !== undefined ? { connection: (sentBody ?? sentQuery) as string } : {}),
            };
            requests.push(rec);

            if (u.pathname === '/health' && method === 'GET') return send(res, 200, { ok: true });

            if (ws === null) {
                return send(res, 401, { success: false, data: null, error: { code: 'UNAUTHORIZED', message: 'missing or unknown API key' } });
            }
            // The engine ignores X-Tenant-Id on purpose: no header handling here.

            if (!u.pathname.startsWith('/v1/') && u.pathname !== '/v1') {
                return send(res, 404, { success: false, data: null, error: { code: 'ERR_NOT_FOUND', message: `no handler for ${method} ${u.pathname}` } });
            }
            const parts = u.pathname.replace(/^\/v1\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
            const m = matchRoute(method, parts);
            if (!m) {
                return send(res, 404, { success: false, data: null, error: { code: 'ERR_NOT_FOUND', message: `no handler for ${method} ${u.pathname}` } });
            }
            // handlers.rs get_or_create_connection (:265-277): explicit non-empty name, else DEFAULT_CONNECTOR,
            // else the route's own default. GET and /v1/transaction read `?connection=`, the rest the body.
            const readsQuery = method === 'GET' || m.route.deferConnCheck === true;
            const explicit = readsQuery ? sentQuery : sentBody;
            curConn = explicit ?? options.defaultConnector ?? m.route.connDefault ?? 'sqlite';
            rec.connector = curConn;
            if (!m.route.deferConnCheck && !options.connectors.includes(curConn)) {
                return send(res, 503, { success: false, data: null, error: { code: 'ERR_CONNECTOR_NOT_FOUND', message: `Connector '${curConn}' not available in registry` } });
            }
            const reply = m.route.handle({ method, parts, body, ws, query: u.searchParams, headers: req.headers }, m.params);
            return send(res, reply.status, reply.body);
        } catch (err) {
            if (err instanceof ApiError) {
                return send(res, err.status, { success: false, data: null, error: { code: err.code, message: err.message } });
            }
            return send(res, 500, { success: false, data: null, error: { code: 'ERR_INTERNAL', message: (err as Error).message } });
        }
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as AddressInfo;

    return {
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
        snapshot: () => {
            // Legacy shape: one bucket per Dataplane workspace (connectors merged by collection name).
            const byWs = new Map<string, Map<string, number>>();
            for (const [k, colls] of workspaces) {
                const ws = k.split(SEP)[0]!;
                const m = byWs.get(ws) ?? new Map<string, number>();
                for (const [name, c] of colls) m.set(name, (m.get(name) ?? 0) + c.rows.length);
                byWs.set(ws, m);
            }
            return { tenants: [...byWs.entries()].map(([tenantId, m]) => ({ tenantId, collections: [...m.entries()].map(([name, count]) => ({ name, count })) })) };
        },
        rows: (workspace, collection, connector) => {
            const found = holders(workspace, collection);
            if (connector !== undefined) return clone(workspaces.get(`${workspace}${SEP}${connector}`)?.get(collection)?.rows ?? []);
            if (found.length > 1) throw new Error(`mock-dataplane: ${collection} holds data under several connectors (${found.join(', ')}) - split-brain; name one`);
            return clone(found.length === 1 ? workspaces.get(`${workspace}${SEP}${found[0]}`)!.get(collection)!.rows : []);
        },
        declaredFields: (workspace, collection, connector) => {
            const found = connector !== undefined ? [connector] : holders(workspace, collection);
            if (found.length > 1) throw new Error(`mock-dataplane: ${collection} exists under several connectors (${found.join(', ')}) - split-brain; name one`);
            const c = found.length === 1 ? workspaces.get(`${workspace}${SEP}${found[0]}`)?.get(collection) : undefined;
            return c ? [...c.declared] : null;
        },
        connectorsWith: (workspace, collection) => holders(workspace, collection),
        holdInFlight: (workspace, key) => {
            const k = `${workspace}\u0000${key}`;
            inFlight.add(k);
            return () => { inFlight.delete(k); };
        },
        requests,
        options,
    };
}
