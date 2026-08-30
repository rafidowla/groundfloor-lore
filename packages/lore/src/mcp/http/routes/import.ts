/**
 * import.ts — bulk data ingest (MX1, 2026-05-15).
 *
 *   POST /api/import      — upload a file + mapping descriptor, write rows
 *                           as LoreNodes through the standard upsertNode
 *                           path. Replaces the prior "stop daemon, run
 *                           custom Python, restart" workflow that blocked
 *                           every real-customer onboarding.
 *
 * Design notes:
 *
 *   v0 ships CSV only (this file). Excel / SQLite / JSON parsers land in
 *   MX6 / MX8 — they parse their format into the same in-memory row[]
 *   shape this module consumes, so the validation + write loop stays
 *   one code path.
 *
 *   The endpoint accepts the file as base64 inside a JSON body — no
 *   multipart parser dependency. Fine for files up to ~10 MB which
 *   covers virtually every real CSV. Larger files will want streaming
 *   multipart (busboy or hono); not in v0.
 *
 *   Writes go to the shared `LoreNode` table with the caller-supplied
 *   node type and metadata. Core stays schema-agnostic — the route
 *   never names domain-specific tables; the shared-table path covers
 *   virtually every real-world import.
 *
 *   See docs/architecture/data_import_plan.md in the app repo for the
 *   product-level context, decisions, and per-format roadmap.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { parse as parseCsvSync } from 'csv-parse/sync';
import type { GroundfloorClient } from 'groundfloor-ts-sdk';
import type { StorageBundle } from '../../services.js';
import { LocalGraphRegistry, WorkspaceNotFoundError } from '../../../engines/localGraphRegistry.js';
import { writeImportTable, type ImportTableResult } from './importTable.js';
import { tagsToArray } from '../../../engines/normalizeTags.js';
import { assertZipWithinBudget } from '../../../engines/extractors/zipGuard.js';
import { gateRoute } from '../../../security/routeGate.js';
import { writePermissionDenied } from '../../../security/rebacGate.js';
import { bindRouteTarget } from '../../../security/routeWorkspaceBinding.js';
import { buildVerbatimText } from '../../../engines/verbatimSchema.js';
import { readBoundedBody, isPayloadTooLarge, writeOversizeError, writeWorkspaceRequired, extractWorkspace, writeJson, writeError } from '../helpers.js';
import { assertSafeLanceId } from '../../../engines/verbatimHistory.js';
import { redactError } from '../../../security/logRedact.js';
import type { LoreGraphHandle } from '../../../storage/loreStorageClient.js';
import { withTransactionConflictRetry } from '../../../engines/transactionConflictRetry.js';

// Widened for the Kùzu removal: naming the two CONCRETE classes silently
// excluded SurrealGraph (see engines/htmlExport.ts). Need more than the
// shared handle? Feature-detect and refuse — do not re-narrow to a class.
type LoreGraph = LoreGraphHandle;

export interface ImportDeps {
    store: StorageBundle;
    detectedScope: { workspace: string; ecosystem: string };
    deploymentMode: 'local' | 'cloud';
    dataplane: GroundfloorClient | null;
    /** L-016 — multi-workspace registry. When wired, the import write is
     *  routed to the requested workspace's graph (instead of the boot-bound
     *  singleton) and the token write-scope gate runs. Optional so cloud /
     *  test boots without a registry fall back to the boot-bound graph. */
    graphRegistry?: LocalGraphRegistry;
    /** Architecture gap #2 integration — when wired, every successful
     *  import row is enqueued for async embedding (instead of skipping
     *  the embed entirely as the legacy path does). Optional so tests
     *  + callers that don't care about semantic searchability can
     *  pass undefined. */
    embedQueue?: { enqueue: (nodeId: string, text: string, workspace?: string) => void };
}

/** What the caller (wizard / SDK / MCP tool) submits. */
export interface ImportRequest {
    /**
     * Source-file format. CSV v0; XLSX (MX6); JSON / JSONL (MX8 part 1).
     * SQLite is the remaining MX8 piece.
     */
    format: 'csv' | 'xlsx' | 'json' | 'jsonl';
    /** Original filename — purely for audit / response context. */
    filename: string;
    /**
     * The file contents, base64-encoded. v0 caps at ~10 MB decoded
     * (rejected with 413 otherwise) to keep the JSON-body design
     * honest until multipart streaming lands.
     */
    data: string;
    /** How rows map onto LoreNode fields. */
    mapping: ImportMapping;
    /**
     * Conflict policy when a row's id matches an existing node:
     *   - 'upsert'  : update existing fields, default
     *   - 'append'  : skip rows whose id already exists; new rows get
     *                 a synthesised unique id if no idColumn is set
     *   - 'replace' : delete every node of `entityType` before write
     *                 (use sparingly; not yet wired — reserved)
     */
    mode?: 'upsert' | 'append' | 'replace';
}

export interface ImportMapping {
    /**
     * The LoreNode.type to assign each imported row. The caller
     * supplies this; the endpoint stays schema-agnostic and trusts the
     * caller rather than validating against a fixed type vocabulary.
     */
    entityType: string;
    /**
     * Optional column whose value becomes LoreNode.id. If absent, ids
     * are synthesised as `${entityType}:${uuid}` per row — fine for
     * append-only one-shot imports, breaks idempotent upsert.
     */
    idColumn?: string;
    /**
     * CSV-column → LoreNode-field. Reserved targets: 'id', 'label',
     * 'content', 'tags', 'project'. Anything else lands under
     * `metadata.<target>`. Targets prefixed `extensions.` go into the
     * user-extension namespace (MX3, separate sibling table — wired
     * in a follow-up; for now they're stored under
     * `metadata.extensions.<key>` as a forward-compatible shape).
     */
    fields: Record<string, string>;
    /** Whether to write a 'project' tag onto every row. Default: detected scope's project. */
    project?: string;
}

export interface ImportRowError {
    /** 1-indexed source-file row (header is row 1, first data row is row 2). */
    row: number;
    /** Column the validator complained about, when relevant. */
    column?: string;
    message: string;
}

export interface ImportResponse {
    imported: number;
    skipped: number;
    errored: number;
    totalRows: number;
    errors: ImportRowError[];
    /** First 5 imported node ids, for the wizard's success preview. */
    sampleIds: string[];
    /**
     * Present when the import ALSO wrote the source's real rows into a
     * queryable Collections table (Bucket A — see
     * engines/tabularImport.ts). Additive: absent for imports that skipped
     * the table write (empty file) or had no table storage (cloud stub).
     */
    table?: ImportTableResult;
    /** Present when a table write was attempted but failed (e.g. a
     *  reconcile conflict). The graph import is unaffected. */
    tableError?: string;
}

const MAX_DECODED_BYTES = 10 * 1024 * 1024; // 10 MB v0 cap
const MAX_ERROR_REPORT = 100; // bound the response payload

const RESERVED_TARGETS = new Set(['id', 'label', 'content', 'tags', 'project']);

// L-015 — prototype-pollution guard for the attacker-controlled dotted
// field-mapping target (mapping.fields[csvCol] = target). A target of
// `__proto__.x` / `constructor.prototype.x` would walk `cursor` onto
// Object.prototype and write a key onto the global prototype, polluting
// every object in the process. Reject any path segment that names one of
// these reserved keys before traversing.
const FORBIDDEN_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

/**
 * Read + JSON.parse, with the same error-swallowing semantics the old
 * inline `readJsonBody` had: malformed JSON resolves to `{}`. Oversize
 * requests rethrow the payload-too-large marker so the caller can map
 * to HTTP 413.
 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
    const data = await readBoundedBody(req);
    try { return JSON.parse(data); } catch { return {}; }
}

const SUPPORTED_FORMATS = ['csv', 'xlsx', 'json', 'jsonl'] as const;

function isImportRequest(v: unknown): v is ImportRequest {
    if (!v || typeof v !== 'object') return false;
    const r = v as Record<string, unknown>;
    return (typeof r.format === 'string' && (SUPPORTED_FORMATS as readonly string[]).includes(r.format))
        && typeof r.filename === 'string'
        && typeof r.data === 'string'
        && !!r.mapping
        && typeof r.mapping === 'object'
        && typeof (r.mapping as Record<string, unknown>).entityType === 'string'
        && !!(r.mapping as Record<string, unknown>).fields
        && typeof (r.mapping as Record<string, unknown>).fields === 'object';
}

/**
 * Parse a CSV buffer into header + rows. Trusts the file is well-formed
 * UTF-8; v0 doesn't try to detect encodings.
 * Exported for unit tests.
 */
export function parseCsv(buf: Buffer): { headers: string[]; rows: Record<string, string>[] } {
    const records = parseCsvSync(buf, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
    }) as Record<string, string>[];
    const headers = records.length > 0 ? Object.keys(records[0]!) : [];
    return { headers, rows: records };
}

/**
 * Parse an XLSX workbook into header + rows from the first non-empty sheet.
 * Multi-sheet picker is deferred — v0 takes whichever sheet is first.
 *
 * Reuses ExcelJS (already a dep for engines/extractors/xlsx.ts; this is the
 * import-time counterpart). Cells coerce to strings via the same value
 * normalisation rules: RichText → joined text, hyperlinks → display text,
 * Dates → ISO date string, formulas → cached result not the formula string.
 *
 * Exported for unit tests.
 */
export async function parseXlsx(buf: Buffer): Promise<{ headers: string[]; rows: Record<string, string>[] }> {
    // audit 2026-06-25 (HIGH, malicious-content DoS) — the extractor path
    // (engines/extractors/xlsx.ts) zip-bomb-guards before ExcelJS, but this
    // import-time counterpart did not: ExcelJS.load inflates the zip with no
    // size cap, so a small bomb uploaded to /api/import could OOM the daemon.
    // Preflight the declared uncompressed sizes; a non-zip falls through.
    try {
        const jszipMod = (await import('jszip')) as any;
        const JSZip = jszipMod.default ?? jszipMod;
        const zip = await JSZip.loadAsync(buf);
        assertZipWithinBudget(zip, 'xlsx-import');
    } catch (err) {
        if (/zip bomb|refusing to decompress/i.test((err as Error).message)) {
            throw new Error((err as Error).message);
        }
        // Not a parseable zip → let ExcelJS handle/err appropriately.
    }

    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    // ExcelJS's published Buffer type pins to a narrower variant than
    // @types/node's current Buffer<ArrayBufferLike>. Hand it the
    // underlying ArrayBuffer slice instead; ExcelJS accepts that
    // overload natively, no escape hatch needed.
    // Node Buffer's underlying .buffer is always ArrayBuffer (never
    // SharedArrayBuffer), but TS infers the broader ArrayBufferLike
    // union — narrow with an assertion so this matches ExcelJS's overload.
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    await workbook.xlsx.load(ab);

    // Pick the first sheet that has at least one populated row. Empty
    // sheets (sometimes left over from templates) are skipped silently.
    let sheet: import('exceljs').Worksheet | null = null;
    for (const ws of workbook.worksheets) {
        if (ws.rowCount > 0) { sheet = ws; break; }
    }
    if (!sheet) return { headers: [], rows: [] };

    const headerRow = sheet.getRow(1);
    const headers: string[] = [];
    headerRow.eachCell({ includeEmpty: true }, (cell) => {
        headers.push(stringifyCell(cell.value).trim());
    });

    const rows: Record<string, string>[] = [];
    for (let rowIdx = 2; rowIdx <= sheet.rowCount; rowIdx++) {
        const row = sheet.getRow(rowIdx);
        const out: Record<string, string> = {};
        let anyValue = false;
        for (let colIdx = 1; colIdx <= headers.length; colIdx++) {
            const cell = row.getCell(colIdx);
            const v = stringifyCell(cell.value).trim();
            if (v) anyValue = true;
            out[headers[colIdx - 1]!] = v;
        }
        if (anyValue) rows.push(out);
    }

    return { headers, rows };
}

/**
 * Parse a JSON or JSONL buffer into header + rows.
 *
 * Accepts two shapes:
 *   - JSON array: `[{...}, {...}]` — top-level array of plain objects.
 *   - JSONL:      one JSON object per line, blank lines ignored.
 *
 * Headers are the union of keys across all rows (sorted for stability).
 * Nested objects/arrays inside a row's value are JSON.stringify'd so the
 * downstream string-pipeline doesn't have to special-case them. The
 * mapping UI can still route those cells into metadata fields; the
 * caller decides whether to post-process.
 *
 * Exported for unit tests.
 */
export function parseJson(buf: Buffer, format: 'json' | 'jsonl'): { headers: string[]; rows: Record<string, string>[] } {
    const text = buf.toString('utf-8').trim();
    if (text.length === 0) return { headers: [], rows: [] };

    let records: Record<string, unknown>[] = [];
    if (format === 'jsonl') {
        for (const line of text.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const parsed = JSON.parse(trimmed);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                records.push(parsed as Record<string, unknown>);
            } else {
                throw new Error(`JSONL line is not an object: ${trimmed.slice(0, 60)}`);
            }
        }
    } else {
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed)) {
            throw new Error('JSON import expects a top-level array of objects.');
        }
        records = parsed.filter((v): v is Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v));
    }

    const headerSet = new Set<string>();
    for (const r of records) {
        for (const k of Object.keys(r)) headerSet.add(k);
    }
    const headers = [...headerSet].sort();

    const rows: Record<string, string>[] = records.map(r => {
        const out: Record<string, string> = {};
        for (const h of headers) {
            const v = r[h];
            if (v === null || v === undefined) {
                out[h] = '';
            } else if (typeof v === 'object') {
                // Nested objects/arrays get stringified — the user can map
                // them into metadata fields and process downstream.
                out[h] = JSON.stringify(v);
            } else {
                out[h] = String(v);
            }
        }
        return out;
    });

    return { headers, rows };
}

function stringifyCell(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') {
        if ('richText' in (value as object)) {
            return (value as { richText: Array<{ text: string }> }).richText
                .map(r => r.text).join('');
        }
        if (value instanceof Date) {
            return value.toISOString().slice(0, 10);
        }
        // Formula cell: { formula, result }. We want the cached result.
        if ('result' in (value as object)) {
            return stringifyCell((value as { result: unknown }).result);
        }
        if ('text' in (value as object)) {
            return String((value as { text: unknown }).text);
        }
        return String(value);
    }
    return String(value);
}

/**
 * Build a LoreNode payload from a single CSV row + the mapping. Returns
 * null + an error reason when the row can't be mapped (missing required
 * id, etc).
 * Exported for unit tests.
 */
export function buildNode(
    row: Record<string, string>,
    mapping: ImportMapping,
    defaultProject: string,
    rowIdx: number,
): { node: Record<string, unknown> } | { error: ImportRowError } {
    const node: Record<string, unknown> = {
        type: mapping.entityType,
        project: mapping.project ?? defaultProject,
        ecosystem: '*',
        tags: [] as string[],
        metadata: '',
    };
    const metadata: Record<string, unknown> = {};

    // id resolution
    if (mapping.idColumn) {
        const idValue = row[mapping.idColumn];
        if (!idValue || idValue.trim() === '') {
            return { error: { row: rowIdx + 2, column: mapping.idColumn, message: 'idColumn value is empty' } };
        }
        node.id = `${mapping.entityType}:${idValue.trim()}`;
        // SECURITY: user-supplied idValue may contain chars that break LanceDB
        // where() predicates. Synthesised ids (else branch) are always safe-charset.
        try {
            assertSafeLanceId(String(node.id), 'import.buildNode');
        } catch (e) {
            return { error: { row: rowIdx + 2, column: mapping.idColumn, message: (e as Error).message } };
        }
    } else {
        // Synthesised id — append-only safe but defeats upsert.
        node.id = `${mapping.entityType}:${rowIdx}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    }

    // Map fields
    for (const [csvCol, target] of Object.entries(mapping.fields)) {
        const raw = row[csvCol];
        if (raw === undefined) continue; // silently skip unknown columns; caller already validated mapping
        // `id` is governed by `mapping.idColumn` (or synthesised); a field
        // target of `id` would otherwise overwrite the entity-type-prefixed
        // id we set above. The wizard should never emit target='id' — but
        // be defensive in case a hand-written mapping does.
        if (target === 'id') continue;
        if (RESERVED_TARGETS.has(target)) {
            if (target === 'tags') {
                // JSON/JSONL inputs whose `tags` was an array get
                // JSON.stringify'd into a literal like '["a","b"]' by
                // parseJson; without parsing it back, tagsToArray would
                // comma-split it into garbage ['["a"', '"b"]']. Detect
                // the JSON-array shape and recover; CSV-style "a,b"
                // strings fall through to tagsToArray's string branch.
                let v: string | string[] = raw.trim();
                if (typeof v === 'string' && v.startsWith('[')) {
                    try {
                        const parsed: unknown = JSON.parse(v);
                        if (Array.isArray(parsed)) v = parsed as string[];
                    } catch { /* not JSON, keep CSV string */ }
                }
                node.tags = tagsToArray(v);
            } else {
                node[target] = raw.trim();
            }
        } else {
            // Nested path via dotted notation (e.g. extensions.foo).
            const segments = target.split('.');
            // L-015 — refuse a dotted target that uses a prototype-pollution
            // key as any segment. Returns an ImportRowError (same shape as
            // the idColumn-empty branch above) so runImport drops the row +
            // increments skipped rather than mutating Object.prototype.
            if (segments.some((seg) => FORBIDDEN_PATH_SEGMENTS.has(seg))) {
                return { error: { row: rowIdx + 2, column: csvCol, message: `field target '${target}' uses a forbidden key segment` } };
            }
            let cursor: Record<string, unknown> = metadata;
            for (let i = 0; i < segments.length - 1; i++) {
                const seg = segments[i]!;
                if (typeof cursor[seg] !== 'object' || cursor[seg] === null) {
                    cursor[seg] = {};
                }
                cursor = cursor[seg] as Record<string, unknown>;
            }
            cursor[segments[segments.length - 1]!] = raw;
        }
    }

    // LoreNode requires `label`. If the mapping didn't supply one, fall back to id.
    if (!node.label) {
        node.label = String(node.id);
    }

    // metadata is stored as a JSON string on LoreNode.
    if (Object.keys(metadata).length > 0) {
        node.metadata = JSON.stringify(metadata);
    }

    return { node };
}

/**
 * runImport — pure core that turns a decoded ImportRequest into an
 * ImportResponse. The HTTP route and the MCP tool both wrap this so the
 * per-row write loop only lives in one place.
 *
 * Caller is responsible for decoding `data` (base64) and respecting the
 * size cap before invoking; this function takes the already-decoded
 * buffer for cleaner testability.
 */
export async function runImport(
    deps: ImportDeps,
    decoded: Buffer,
    body: ImportRequest,
    /** L-016 — the workspace-resolved write target. Rows are written to
     *  THIS graph, not the boot-bound `deps.store.storageClient`, so an
     *  import declaring workspace=B lands in B's graph. The route resolves
     *  it via graphRegistry.getGraphHandle before calling runImport; the boot
     *  graph is the fallback when no registry is wired. */
    targetGraph: LoreGraph = deps.store.loreGraph,
    /** RA2-reaudit2 — the workspace `targetGraph` belongs to, threaded to the
     *  embed queue so embeddings land in THIS workspace's vector store, not the
     *  boot store. Empty → boot/active (cloud/tests). */
    targetWorkspace: string = '',
): Promise<ImportResponse> {
    const parsed = body.format === 'xlsx'
        ? await parseXlsx(decoded)
        : body.format === 'json' || body.format === 'jsonl'
            ? parseJson(decoded, body.format)
            : parseCsv(decoded);

    // Bail if mapping references columns the file doesn't have. Caller
    // already may have validated, but be defensive.
    const headerSet = new Set(parsed.headers);
    for (const csvCol of Object.keys(body.mapping.fields)) {
        if (!headerSet.has(csvCol)) {
            throw new Error(`mapping references column "${csvCol}" which does not exist in the uploaded file. Headers: ${parsed.headers.join(', ')}`);
        }
    }
    if (body.mapping.idColumn && !headerSet.has(body.mapping.idColumn)) {
        throw new Error(`mapping.idColumn "${body.mapping.idColumn}" does not exist in the uploaded file`);
    }

    const errors: ImportRowError[] = [];
    const sampleIds: string[] = [];
    let imported = 0;
    let skipped = 0;

    // 1.9 (2026-08-17 audit) — the Collections-table write must contain ONLY
    // rows that actually reached the graph (buildNode-rejected and
    // upsert-failed rows were previously written to the table while being
    // counted as errors/skipped), keyed by a STABLE identity so a re-import
    // dedupes instead of doubling every row.
    const tableRows: Array<Record<string, string>> = [];
    const tableRowKeys: string[] = [];
    const recordTableRow = (row: Record<string, string>, nodeId: string): void => {
        // With an idColumn the graph id IS the stable key. Without one the
        // graph side synthesises a random id per import, so key on a content
        // hash of the row (header-ordered) — same file re-imported collides
        // and dedupes, a changed row gets a new key (mirrors graph append).
        const key = body.mapping.idColumn
            ? nodeId
            : `${body.mapping.entityType}:rowhash:${createHash('sha256')
                .update(JSON.stringify(parsed.headers.map((h) => row[h] ?? '')))
                .digest('hex')
                .slice(0, 32)}`;
        tableRows.push(row);
        tableRowKeys.push(key);
    };

    const defaultProject = body.mapping.project ?? deps.detectedScope.workspace;

    for (let i = 0; i < parsed.rows.length; i++) {
        const row = parsed.rows[i]!;
        const built = buildNode(row, body.mapping, defaultProject, i);
        if ('error' in built) {
            errors.push(built.error);
            skipped++;
            continue;
        }

        try {
            if (body.mode === 'append' && typeof built.node.id === 'string') {
                const existing = await targetGraph.getNode(built.node.id);
                if (existing) {
                    skipped++;
                    // 1.9 — the row IS in the graph (from a prior import);
                    // record it for the table write, where the stable key
                    // dedupes it against the prior import's copy.
                    recordTableRow(row, built.node.id);
                    continue;
                }
            }
            const written = await withTransactionConflictRetry(() => targetGraph.upsertNode(
                built.node as Parameters<typeof deps.store.loreGraph.upsertNode>[0],
            ));
            imported++;
            if (sampleIds.length < 5) sampleIds.push(written.id);
            // 1.9 — only rows that actually reached the graph get a table row.
            recordTableRow(row, written.id);

            // Architecture gap #2 — enqueue embedding for async compute
            // when the queue is wired. Synchronous import previously
            // skipped embedding entirely, leaving imported rows
            // invisible to semantic search until backgroundReconnect
            // happened to backfill them. The queue closes that gap
            // without paying embed latency on the import hot path.
            if (deps.embedQueue) {
                const n = built.node as { id: string; label?: string; content?: string; tags?: string };
                // RA2-reaudit2 — pass the target workspace so the embed lands in
                // THIS workspace's vector store, not the boot store.
                deps.embedQueue.enqueue(
                    n.id,
                    buildVerbatimText(n.label ?? '', n.content ?? '', n.tags ?? ''),
                    targetWorkspace || undefined,
                );
            }
        } catch (err) {
            errors.push({
                row: i + 2,
                message: (err as Error).message,
            });
            skipped++;
        }

        if (errors.length >= MAX_ERROR_REPORT) break;
    }

    // ── Bucket A — persist the source's real rows into a queryable table ──
    // Additive to the node-write loop above: also write the file's actual
    // columns/rows into a Collections table shaped like the source, so an
    // exact COUNT/SUM over the imported data is possible (flattened search
    // text cannot guarantee it). 1.9 (2026-08-17 audit): the table now
    // receives ONLY rows that reached the graph (tableRows), keyed by a
    // stable per-row identity, so re-importing the same file dedupes rather
    // than doubling every row. Best-effort — a failure here does not roll
    // back the graph import (existing behavior), but IS surfaced on the
    // response so it is never silent.
    const tableOutcome = await writeImportTable({
        store: deps.store,
        graphRegistry: deps.graphRegistry,
        activeWorkspace: deps.detectedScope.workspace,
        entityType: body.mapping.entityType,
        filename: body.filename,
        headers: parsed.headers,
        rows: tableRows,
        rowKeys: tableRowKeys,
        targetWorkspace: targetWorkspace || defaultProject || deps.detectedScope.workspace,
    });

    return {
        imported,
        skipped,
        errored: errors.length,
        totalRows: parsed.rows.length,
        errors,
        sampleIds,
        ...(tableOutcome.table ? { table: tableOutcome.table } : {}),
        ...(tableOutcome.error ? { tableError: tableOutcome.error } : {}),
    };
}

export interface ImportPreviewResponse {
    headers: string[];
    sampleRows: Record<string, string>[];
    totalRows: number;
}

export async function tryImportRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    _url: string,
    pathname: string,
    deps: ImportDeps,
): Promise<boolean> {
    // POST /api/import/preview — parse the file and return headers +
    // first 20 rows + total count. No graph writes. The wizard calls
    // this after upload to drive its Preview + Map steps without having
    // to parse XLSX client-side. Same auth gate as the write endpoint.
    if (pathname === '/api/import/preview' && req.method === 'POST') {
        const previewGate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
            { permission: 'read' },
        );
        if (!previewGate.allowed) { writePermissionDenied(res, previewGate); return true; }
        let body: unknown;
        try { body = await readJsonBody(req); }
        catch (err) {
            if (isPayloadTooLarge(err)) { writeOversizeError(res); return true; }
            writeError(res, 400, 'invalid_json_body', 'invalid JSON body');
            return true;
        }
        const r = body as Record<string, unknown>;
        if (!r || typeof r.format !== 'string' || !(SUPPORTED_FORMATS as readonly string[]).includes(r.format) || typeof r.data !== 'string') {
            writeError(res, 400, 'invalid_import_preview_body',
                `expected { format: one of ${SUPPORTED_FORMATS.join('|')}, data: base64 }`);
            return true;
        }
        let decoded: Buffer;
        try { decoded = Buffer.from(r.data as string, 'base64'); }
        catch (err) {
            writeError(res, 400, 'decode_failed', `decode failed: ${(err as Error).message}`);
            return true;
        }
        if (decoded.byteLength > MAX_DECODED_BYTES) {
            writeError(res, 413, 'file_too_large', `file exceeds v0 size cap (${MAX_DECODED_BYTES} bytes)`);
            return true;
        }
        try {
            const parsed = r.format === 'xlsx'
                ? await parseXlsx(decoded)
                : r.format === 'json' || r.format === 'jsonl'
                    ? parseJson(decoded, r.format as 'json' | 'jsonl')
                    : parseCsv(decoded);
            const response: ImportPreviewResponse = {
                headers: parsed.headers,
                sampleRows: parsed.rows.slice(0, 20),
                totalRows: parsed.rows.length,
            };
            writeJson(res, 200, response);
        } catch (err) {
            writeError(res, 400, 'parse_failed', `parse failed: ${(err as Error).message}`);
        }
        return true;
    }

    if (pathname !== '/api/import' || req.method !== 'POST') return false;

    const gate = await gateRoute(
        { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
        { permission: 'write' },
    );
    if (!gate.allowed) { writePermissionDenied(res, gate); return true; }

    let body: unknown;
    try {
        body = await readJsonBody(req);
    } catch (err) {
        if (isPayloadTooLarge(err)) { writeOversizeError(res); return true; }
        writeError(res, 400, 'invalid_json_body', 'invalid JSON body');
        return true;
    }

    if (!isImportRequest(body)) {
        writeError(res, 400, 'invalid_import_body',
            'expected ImportRequest shape: { format: "csv", filename, data, mapping: { entityType, fields, [idColumn] } }');
        return true;
    }

    // Sprint L1c — workspace required (writer). Accept top-level
    // `workspace`/`project` OR `mapping.project`. No silent fallback
    // to detectedScope.workspace; callers must declare destination.
    const importWs = extractWorkspace(body as unknown as Record<string, unknown>)
        ?? (typeof body.mapping.project === 'string' && body.mapping.project.length > 0 ? body.mapping.project : undefined);
    if (!importWs) { writeWorkspaceRequired(res); return true; }
    // Force the workspace through to runImport via mapping.project so
    // downstream defaultProject resolution uses the explicit value.
    body.mapping.project = importWs;

    // L-016/D-021 — token-scoped write gate. Mirrors postNode.ts /
    // nodes-delete.ts: an app token bound to workspace A cannot import into
    // workspace B without cross-workspace-write. Null principal = legacy/local
    // bypass.
    if (bindRouteTarget(res, { requested: importWs, intent: 'write' }) === null) return true;

    // L-016 — route the write to the requested workspace's graph instead of
    // the boot-bound singleton. Falls back to the boot graph when no
    // registry is wired (cloud / tests).
    let targetGraph: LoreGraph = deps.store.loreGraph;
    if (deps.graphRegistry) {
        try {
            // getGraphHandle honours the workspace's declared engine — getOrOpen
            // is the Kùzu substrate accessor and would import every node into a
            // Surreal workspace's unused, empty Kùzu graph. Still runs
            // assertWorkspaceOpenAllowed.
            targetGraph = await deps.graphRegistry.getGraphHandle(importWs);
        } catch (err) {
            if (err instanceof WorkspaceNotFoundError) {
                writeError(res, 404, 'workspace_not_found', `workspace "${err.requested}" not found`, {
                    requested: err.requested,
                    known: err.known,
                });
                return true;
            }
            throw err;
        }
    }

    // Decode + size-cap.
    let decoded: Buffer;
    try {
        decoded = Buffer.from(body.data, 'base64');
    } catch (err) {
        writeError(res, 400, 'decode_failed', `failed to decode base64 data: ${(err as Error).message}`);
        return true;
    }
    if (decoded.byteLength > MAX_DECODED_BYTES) {
        writeError(res, 413, 'file_too_large',
            `file exceeds v0 size cap (${MAX_DECODED_BYTES} bytes). Streaming multipart support is a follow-up.`);
        return true;
    }

    // Replace mode (MX1 v0): not yet wired. Stub to 501 so the wizard
    // surfaces clearly rather than silently degrading.
    if (body.mode === 'replace') {
        writeError(res, 501, 'replace_mode_not_supported',
            'mode="replace" is reserved; use upsert + manual cleanup until MX1 v1 ships it');
        return true;
    }

    let response: ImportResponse;
    try {
        response = await runImport(deps, decoded, body, targetGraph, importWs);
    } catch (err) {
        writeError(res, 400, 'import_failed', redactError(err));
        return true;
    }

    writeJson(res, 200, response);
    return true;
}
