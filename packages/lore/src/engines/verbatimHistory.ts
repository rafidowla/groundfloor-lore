/**
 * verbatimHistory.ts — read-only verbatim queries for VerbatimStore.
 *
 * Extracted from verbatimStore.ts (god-class split). These three queries are
 * pure passive reads of the LanceDB table — they do NOT trigger initialize(),
 * do NOT touch the search-cache epoch, and do NOT reassign the table handle.
 * That isolation is exactly what makes them a SAFE seam: the write / delete /
 * search mutation cluster (which reassigns the table handle + bumps the search
 * epoch + uses the read pool) is deliberately left in the class until a
 * visibility-contract redesign.
 *
 * VerbatimStore keeps thin delegators that pass (table, initialized); behavior
 * is identical — including the "return empty/null and swallow errors when not
 * yet initialized" contract callers rely on.
 */

import * as lancedb from '@lancedb/lancedb';

/**
 * SECURITY (SP-05): escape LIKE-pattern metacharacters in a user-supplied
 * prefix so they're matched literally rather than acting as wildcards.
 * Escapes backslash first (so we don't double-escape the escapes we add),
 * then `%` and `_`. Callers MUST append `ESCAPE '\'` to the LIKE clause.
 * Without this, a prefix like `%` or `_` matches every id — turning a
 * targeted `listIds('lore:')` reap into a workspace-wide scan, and leaking
 * an id-enumeration surface (`%secret%`).
 */
function escapeLanceLike(s: string): string {
    return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * SECURITY (SP-05): escape a single-quoted LanceDB/SQL string literal by
 * doubling embedded single quotes. Shared by VerbatimStore.search() and
 * bm25Search() so the metadata-filter VALUE path can't break out of the
 * literal. Mirrors the inline escaping already used in physicalDelete /
 * snapshotForRev. Lives here next to escapeLanceLike so all of the
 * verbatim .where()-builder escaping helpers sit in one module (and to
 * keep verbatimStore.ts under the file-size cap).
 */
export function escapeSqlLiteral(value: string): string {
    return value.replace(/'/g, "''");
}

/**
 * The internally-generated revision-snapshot suffix shape:
 * `<canonicalId>#rev<ISO-8601 millis timestamp>` — built with
 * `new Date().toISOString()` at every snapshot site (snapshotForRev,
 * storeBatch, tombstone in verbatimStore.ts).
 *
 * Audit 5.6 (2026-08-17): the old predicate was a bare
 * `id.includes('#rev')` SUBSTRING test, so any id merely CONTAINING '#rev'
 * (e.g. the URL fragment in `https://docs.example.com/api#revisions`,
 * reachable via the node write path's more permissive assertSafeLanceId)
 * was silently classified as an internal history row — invisible to
 * search()/bm25Search(), untombstonable, dropped from workspace export, and
 * permanently flagged as a missing embedding by the consistency sweep.
 * Anchor to the real suffix shape at the END of the id instead.
 */
const HISTORY_SUFFIX_RE = /#rev\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** True iff `id` carries the internally-generated revision-snapshot suffix. */
export function isRevisionHistoryId(id: string): boolean {
    return HISTORY_SUFFIX_RE.test(id);
}

/**
 * SQL LIKE equivalent of HISTORY_SUFFIX_RE for LanceDB .where() filters.
 * `_` is the LIKE single-char wildcard; the literal `#rev`, separators and
 * trailing `Z` pin the shape, and because the pattern ends in `Z` (no
 * trailing `%`) the suffix must sit at the END of the id. Use as
 * `id NOT LIKE '${HISTORY_ID_LIKE_PATTERN}'`. No ESCAPE clause needed —
 * the pattern contains no backslash escapes.
 */
export const HISTORY_ID_LIKE_PATTERN = '%#rev____-__-__T__:__:__.___Z';

/**
 * SECURITY (SP-05): allowlist of metadata columns a caller may filter on
 * in search()/bm25Search(). A filter key is interpolated directly into the
 * LanceDB WHERE clause, so an unvalidated key (e.g. `id = 1 OR 1=1 --`)
 * would inject predicate fragments. Restricting keys to the known scalar
 * metadata columns + escaping values closes that hole. `vector` and the
 * List-typed `security_scopes` are intentionally excluded — not scalar-
 * equality filterable here.
 */
export const VERBATIM_FILTERABLE_COLUMNS: ReadonlySet<string> = new Set([
    'id', 'type', 'label', 'tags', 'project', 'ecosystem', 'updatedAt', 'contentHash',
]);

/**
 * SECURITY: node-id validation before interpolation into LanceDB where()
 * predicates. The injection control for these predicates is NOT an alphabet
 * allowlist — it is the escaping at every interpolation site (single-quote
 * doubling on every value; escapeLanceLike + ESCAPE '\' on every LIKE
 * value). LanceDB 0.27.2's filter API takes raw SQL strings only (no bound
 * parameters), and the vendor's own escaping helper (toSQL in dist/util.js)
 * quote-doubles exactly as this repo does — so escaped string building is
 * the sanctioned pattern, and any printable character (including the
 * `[ ] ( )` in Next.js dynamic-route ids) round-trips safely through it.
 *
 * What remains here are the checks escaping CANNOT cover:
 *   - empty ids (no identity to key a row on; the old alphabet's `+`
 *     quantifier rejected these too — this keeps that boundary)
 *   - non-string ids (type confusion: a numeric/array id would write a graph
 *     node while the verbatim canonical key differs — cross-substrate orphan)
 *   - oversized ids (unbounded predicate-string growth)
 *   - NUL bytes (cannot safely round-trip through the native string boundary)
 * Anything outside those four is a legitimate id and MUST be accepted.
 *
 * The '#rev' revision suffix is constructed INTERNALLY by the system (never
 * provided by callers); callers always supply the canonical id. Each call
 * site carries a "// SECURITY: assertSafeLanceId" comment so future readers
 * know the chain.
 */
const MAX_LANCE_ID_LEN = 512;

/** SHA-256 and similar content hashes: strictly lowercase hex. */
const SAFE_HASH_RE = /^[0-9a-f]+$/;
const MAX_LANCE_HASH_LEN = 128;

/**
 * Throw if `id` cannot be safely stored and round-tripped through LanceDB
 * where() predicates. Call before every WHERE id = '...' or id IN (...)
 * predicate. `site` names the calling function for the error message. Every
 * rejection message NAMES the id (truncated + JSON-escaped so control
 * characters can't smear the log line) so a refused write is attributable.
 */
export function assertSafeLanceId(id: string, site: string): void {
    // R3 #5 — reject non-string ids at the guard. The param is typed `string`,
    // but a runtime non-string (number, array, object) reaching the chokepoint
    // (nodeService.nodeUpsert) slipped through: `(5).length` is undefined so the
    // length check is false, and an alphabet regex coerces 5 to "5" and passes —
    // so a numeric/array id wrote a graph node while the verbatim canonical key
    // (lore:<id>) differed, a cross-substrate split-brain orphan reported
    // ok:true. Fail loud so all three write surfaces inherit the rejection.
    if (typeof id !== 'string') {
        throw new Error(`[LanceFilter:${site}] id rejected (value: ${JSON.stringify(id)}): id must be a string (got ${typeof id})`);
    }
    if (id.length === 0) {
        throw new Error(`[LanceFilter:${site}] id rejected (value: ""): id must be non-empty`);
    }
    if (id.length > MAX_LANCE_ID_LEN) {
        throw new Error(`[LanceFilter:${site}] id rejected (value: ${JSON.stringify(id.slice(0, 120))}…): id too long (${id.length}; max ${MAX_LANCE_ID_LEN})`);
    }
    // NUL is the one byte escaping cannot make safe: it terminates C strings
    // in the native binding, so a NUL-bearing id could silently truncate in
    // the predicate and match a DIFFERENT row. Reject loudly instead.
    if (id.includes('\0')) {
        throw new Error(`[LanceFilter:${site}] id rejected (value: ${JSON.stringify(id.slice(0, 120))}): id contains a NUL byte that cannot safely cross the SQL/native string boundary`);
    }
}

/**
 * 2.5 (2026-08-17) — guard the DIRECT verbatim write surfaces (store_verbatim,
 * POST /api/verbatim). Unlike the node path (which derives `lore:<id>` from a
 * graph node id), these take a caller-chosen row id verbatim, so two overreach
 * risks exist that the node path doesn't have:
 *   1. `lore:<id>` — the node-derived canonical namespace. Writing it here
 *      would overwrite a graph node's canonical vector row with no node audit.
 *   2. `#rev` — the internal revision-history suffix. Writing it here forges a
 *      prior revision (the append-only history branch skips dedupe + tombstone).
 */
export function assertSafeVerbatimId(id: string, site: string): void {
    assertSafeLanceId(id, site);
    if (id.startsWith('lore:')) {
        throw new Error(`[${site}] id rejected: 'lore:' prefix is reserved for node-derived rows — write via store_node`);
    }
    if (id.includes('#rev')) {
        throw new Error(`[${site}] id rejected: '#rev' suffix is reserved for internal revision history`);
    }
}

/**
 * Throw if `hash` is not a valid lowercase hex content-hash. Call before every
 * WHERE contentHash = '...' or contentHash IN (...) predicate.
 */
export function assertSafeLanceHash(hash: string, site: string): void {
    if (hash.length > MAX_LANCE_HASH_LEN) {
        throw new Error(`[LanceFilter:${site}] hash too long (${hash.length}; max ${MAX_LANCE_HASH_LEN})`);
    }
    if (!SAFE_HASH_RE.test(hash)) {
        throw new Error(`[LanceFilter:${site}] hash must be lowercase hex only`);
    }
}

/**
 * getById — stored metadata for a single id without re-embedding. Returns null
 * if the row is absent or the table has not been created yet.
 */
export async function getById(
    table: lancedb.Table | null,
    initialized: boolean,
    id: string,
): Promise<{
    contentHash?: string;
    text?: string;
    type?: string;
    label?: string;
    tags?: string;
    project?: string;
    ecosystem?: string;
    updatedAt?: string;
    security_scopes?: string[];
} | null> {
    assertSafeLanceId(id, 'getById'); // SECURITY: assertSafeLanceId — outside try so validation errors propagate
    try {
        if (!initialized || !table) return null;
        const rows = await table
            .query()
            .where(`id = '${id.replace(/'/g, "''")}'`)
            .limit(1)
            .toArray();
        if (rows.length === 0) return null;
        const r = rows[0] as Record<string, unknown>;
        // 1.M9 (2026-08-17 audit) — return the full metadata column set, not
        // just contentHash/text, so store()'s skip-identical check can tell
        // "same text, changed metadata" apart from "truly identical".
        return {
            contentHash: typeof r.contentHash === 'string' ? r.contentHash : '',
            text: typeof r.text === 'string' ? r.text : '',
            type: typeof r.type === 'string' ? r.type : '',
            label: typeof r.label === 'string' ? r.label : '',
            tags: typeof r.tags === 'string' ? r.tags : '',
            project: typeof r.project === 'string' ? r.project : '',
            ecosystem: typeof r.ecosystem === 'string' ? r.ecosystem : '',
            updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : '',
            security_scopes: Array.isArray(r.security_scopes) ? (r.security_scopes as unknown[]).map(String) : [],
        };
    } catch {
        return null;
    }
}

/**
 * listIds — every stored id, optionally filtered by prefix (LIKE) and/or
 * by the row's `project` column. Returns [] if the table isn't initialized
 * (caller treats as "no records").
 *
 * `opts.project` is the workspace-scoping filter (2026-06-09). When two
 * workspaces alias the same physical lance table (Sprint L5b workspace
 * aliasing: per-workspace separation is via the `project` column, not
 * via separate stores), an unfiltered listIds returns ids belonging to
 * BOTH workspaces, which would let the consistency diagnostic report
 * the other workspace's vectors as orphans. Passing `opts.project`
 * mirrors what the graph side already does (`graph.listNodes(..., workspace)`)
 * so the orphan-detector's set-difference is scope-symmetric.
 */
export async function listIds(
    table: lancedb.Table | null,
    initialized: boolean,
    prefix?: string,
    opts?: { project?: string },
): Promise<string[]> {
    try {
        if (!initialized || !table) return [];
        const q = table.query();
        const clauses: string[] = [];
        if (prefix) {
            // SECURITY (SP-05): escape both the single-quote (literal
            // breakout) AND the LIKE wildcards (% _ \). The trailing `%`
            // is the intended prefix wildcard; the user's own % / _ are
            // escaped + neutralised via the ESCAPE clause.
            const safe = escapeLanceLike(prefix).replace(/'/g, "''");
            clauses.push(`id LIKE '${safe}%' ESCAPE '\\'`);
        }
        if (opts?.project) {
            const safe = opts.project.replace(/'/g, "''");
            clauses.push(`project = '${safe}'`);
        }
        if (clauses.length > 0) q.where(clauses.join(' AND '));
        const rows = await q.select(['id']).toArray();
        return rows.map((r: { id: unknown }) => String(r.id));
    } catch {
        return [];
    }
}

/** Coerce an Arrow / Float32Array / nested-array vector into a plain number[].
 *  Mirrors VerbatimStore.toPlainVector (private there) so the export reader
 *  emits the SAME shape the carry-import path (ArcadeVectorStore.storePrebuilt)
 *  expects. Returns [] for a missing/unreadable vector. */
function toPlainVector(v: unknown): number[] {
    if (!v) return [];
    if (Array.isArray(v)) {
        if (v.length === 1 && Array.isArray((v as unknown[])[0])) {
            return ((v as unknown[])[0] as unknown[]).map((x) => Number(x));
        }
        return v.map((x) => Number(x));
    }
    const arrowLike = v as { toArray?: () => unknown };
    if (typeof arrowLike.toArray === 'function') {
        const inner = arrowLike.toArray();
        if (Array.isArray(inner)) {
            if (inner.length === 1 && Array.isArray(inner[0])) {
                return (inner[0] as unknown[]).map((x) => Number(x));
            }
            return inner.map((x) => Number(x));
        }
        const ta = inner as { length?: number; [k: number]: number };
        if (typeof ta?.length === 'number') {
            const out: number[] = new Array(ta.length);
            for (let i = 0; i < ta.length; i++) out[i] = Number(ta[i]);
            return out;
        }
    }
    const indexed = v as { length?: number; [k: number]: number };
    if (typeof indexed.length === 'number') {
        const out: number[] = new Array(indexed.length);
        for (let i = 0; i < indexed.length; i++) out[i] = Number(indexed[i]);
        return out;
    }
    return [];
}

/** One exported verbatim row: canonical id, text, its raw embedding vector,
 *  and the column-derived metadata bag the carry-import reconstructs from. */
export interface VerbatimExportRow {
    id: string;
    text: string;
    embedding: number[];
    contentHash: string;
    metadata: {
        type?: string;
        label?: string;
        tags?: string;
        project?: string;
        ecosystem?: string;
        updatedAt?: string;
        contentHash?: string;
    };
}

/**
 * listRowsWithVectors — Slice-4 EXPORT read path: every CANONICAL verbatim row
 * (history `#rev` snapshots excluded) with its RAW stored embedding vector, so
 * the migration bundle can CARRY vectors byte-identically into an arcade cell
 * (zero re-embed, identical recall ranking). `#rev` snapshots are export-
 * excluded to match search()'s default (history is a local revision detail,
 * not migrated state).
 *
 * `project` scopes to one workspace's rows when a shared LanceDB table aliases
 * multiple workspaces (Sprint L5b), mirroring listIds(opts.project). In the
 * common one-dir-per-workspace local layout the whole table belongs to the
 * workspace, so the filter is a harmless no-op. Returns [] when the table
 * isn't initialized (caller treats as "no vectors").
 */
export async function listRowsWithVectors(
    table: lancedb.Table | null,
    initialized: boolean,
    opts?: { project?: string },
): Promise<VerbatimExportRow[]> {
    try {
        if (!initialized || !table) return [];
        const q = table.query();
        if (opts?.project) {
            const safe = opts.project.replace(/'/g, "''");
            q.where(`project = '${safe}'`);
        }
        const rows = (await q.toArray()) as Array<Record<string, unknown>>;
        const out: VerbatimExportRow[] = [];
        for (const r of rows) {
            const id = String(r['id'] ?? '');
            // Exclude `#rev` history snapshots — migrate canonical state only.
            if (!id || isRevisionHistoryId(id)) continue;
            const contentHash = r['contentHash'] != null ? String(r['contentHash']) : '';
            out.push({
                id,
                text: r['text'] != null ? String(r['text']) : '',
                embedding: toPlainVector(r['vector']),
                contentHash,
                metadata: {
                    type: r['type'] != null ? String(r['type']) : undefined,
                    label: r['label'] != null ? String(r['label']) : undefined,
                    tags: r['tags'] != null ? String(r['tags']) : undefined,
                    project: r['project'] != null ? String(r['project']) : undefined,
                    ecosystem: r['ecosystem'] != null ? String(r['ecosystem']) : undefined,
                    updatedAt: r['updatedAt'] != null ? String(r['updatedAt']) : undefined,
                    contentHash: contentHash || undefined,
                },
            });
        }
        return out;
    } catch {
        return [];
    }
}

/**
 * getHistory — the canonical row plus every `#rev` snapshot for an id. Sorted
 * newest-first: canonical first if present, then snapshots by their embedded
 * (lex-sortable) timestamp.
 */
export async function getHistory(
    table: lancedb.Table | null,
    initialized: boolean,
    id: string,
): Promise<Array<{ id: string; text: string; updatedAt: string; isTombstone: boolean; isCanonical: boolean }>> {
    assertSafeLanceId(id, 'getHistory'); // SECURITY: assertSafeLanceId — outside try so validation errors propagate
    try {
        if (!initialized || !table) return [];
        // Equality side uses plain single-quote escaping; the LIKE side
        // additionally neutralises wildcards (SP-05) so an id containing
        // `%`/`_` doesn't widen the `#rev` snapshot match.
        const safeEq = id.replace(/'/g, "''");
        const safeLike = escapeLanceLike(id).replace(/'/g, "''");
        const rows = await table
            .query()
            .where(`id = '${safeEq}' OR id LIKE '${safeLike}#rev%' ESCAPE '\\'`)
            .toArray();
        const out = rows.map((raw) => {
            const r = raw as Record<string, unknown>;
            const rid = String(r.id ?? '');
            const text = String(r.text ?? '');
            return {
                id: rid,
                text,
                updatedAt: String(r.updatedAt ?? ''),
                isTombstone: text.startsWith('[TOMBSTONED'),
                isCanonical: rid === id,
            };
        });
        out.sort((a, b) => {
            if (a.isCanonical) return -1;
            if (b.isCanonical) return 1;
            return b.id.localeCompare(a.id);
        });
        return out;
    } catch {
        return [];
    }
}
