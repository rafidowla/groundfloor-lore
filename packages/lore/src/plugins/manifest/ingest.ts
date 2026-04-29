/**
 * ingest.ts — Tier 1 declarative ingestion runner.
 *
 * Takes an `IngestSpec` from a validated manifest, reads the file at
 * `spec.file`, parses it (CSV or JSON array), maps each row to a node
 * write, and calls a `writer` callback per row. Returns a structured
 * report of what got ingested, what was skipped, and why.
 *
 * Two design rules:
 *
 *   1. **Pure: takes a writer callback, doesn't reach into the graph
 *      directly.** Tests pass an array-pushing writer; production passes
 *      a writer that calls `graph.upsertNode` (or `store_node` on the
 *      MCP side). This keeps the ingest logic free of substrate
 *      vocabulary.
 *
 *   2. **Bad rows are reported, not fatal.** A malformed row in line 47
 *      of a 100-row CSV does not crash the run — it gets logged, and
 *      the other 99 still ingest. The report tells the caller exactly
 *      which rows failed and why.
 *
 * Idempotency: the caller's writer is expected to be an upsert
 * (existing nodes with the same id are replaced, not duplicated). The
 * spec's `idStrategy` is what makes the same row produce the same id
 * on every run, so re-running an ingest converges to the same graph.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parse as parseCsvSync } from 'csv-parse/sync';

import type {
    IngestSpec,
    IngestIdStrategy,
    IngestFieldMap,
    IngestAuth,
    IngestPagination,
} from '../manifest.js';

/**
 * What the ingest runner asks the writer to upsert. Mirrors the
 * subset of `LoreNode` shape that store_node accepts. Optional fields
 * are simply omitted when the manifest didn't map them.
 */
export interface IngestNodeWrite {
    id: string;
    type: string;
    label: string;
    content: string;
    tags: string[];
    project?: string;
    ecosystem?: string;
    language?: string;
    /** Free-form metadata — currently records the source row number for traceability. */
    metadata: Record<string, unknown>;
}

/** A single row that failed and was skipped. */
export interface IngestRowError {
    /** 1-based row number in the source file (excludes the CSV header). */
    rowNumber: number;
    /** Plain-English reason. */
    reason: string;
}

/** What `runIngest` returns. */
export interface IngestReport {
    /** Resolved absolute path of the source file. */
    sourcePath: string;
    /** Total rows in the source (data rows; CSV header excluded). */
    totalRows: number;
    /** Rows successfully handed to the writer. */
    ingested: number;
    /** Rows skipped due to bad data. */
    skipped: number;
    /** Per-row failure detail. Capped at 100 entries to bound memory; the
     *  total skip count above is authoritative. */
    errors: IngestRowError[];
    /** Wall-clock time the run took, in milliseconds. */
    elapsedMs: number;
}

const MAX_ERRORS_RETAINED = 100;

export type IngestWriter = (node: IngestNodeWrite) => Promise<void> | void;

/**
 * Resolves an opaque credential key (declared in the manifest's
 * `auth.credentialKey`) to a real secret string. Provided by the
 * caller (server.ts) so the ingest runner doesn't have to know about
 * the keychain implementation.
 */
export type CredentialResolver = (credentialKey: string) => Promise<string | null>;

export interface RunIngestOptions {
    /** HTTP-source: caller-supplied vars to fill `{{var}}` URL placeholders. */
    vars?: Record<string, string | number | boolean>;
    /** HTTP-source: how to resolve `auth.credentialKey` to a real secret.
     *  Required when an HTTP spec declares non-`none` auth. */
    credentialResolver?: CredentialResolver;
    /** HTTP-source: max page/request safety cap. Defaults baked in per pagination kind. */
}

/**
 * Run a single `IngestSpec`. `bundleDir` is the manifest's directory,
 * used to resolve relative `spec.file` paths. The writer is invoked
 * once per successfully-mapped row.
 */
export async function runIngest(
    spec: IngestSpec,
    bundleDir: string,
    writer: IngestWriter,
    options: RunIngestOptions = {},
): Promise<IngestReport> {
    const startMs = Date.now();
    let sourcePath: string;
    let rows: Array<Record<string, unknown>>;

    if (spec.source === 'csv' || spec.source === 'json') {
        if (!spec.file) {
            throw new Error(`ingest spec source=${spec.source} requires a \`file\` field`);
        }
        sourcePath = path.isAbsolute(spec.file)
            ? spec.file
            : path.resolve(bundleDir, spec.file);
        const text = await fs.readFile(sourcePath, 'utf8');
        rows = spec.source === 'csv'
            ? parseCsvFile(text, spec.delimiter ?? ',') as Array<Record<string, unknown>>
            : parseJsonFile(text);
    } else {
        // HTTP source — Tier 2.
        if (!spec.url) {
            throw new Error('ingest spec source=http requires a `url` field');
        }
        sourcePath = spec.url;
        rows = await fetchHttpRows(spec, options);
    }

    const errors: IngestRowError[] = [];
    let ingested = 0;
    let skipped = 0;

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        const rowNumber = i + 1;
        try {
            const id = computeId(row, spec.idStrategy);
            const node = mapRowToNode(row, spec, id, rowNumber);
            await writer(node);
            ingested += 1;
        } catch (err) {
            skipped += 1;
            if (errors.length < MAX_ERRORS_RETAINED) {
                errors.push({ rowNumber, reason: (err as Error).message });
            }
        }
    }

    return {
        sourcePath,
        totalRows: rows.length,
        ingested,
        skipped,
        errors,
        elapsedMs: Date.now() - startMs,
    };
}

// ────────────────────────────────────────────────────────────────────────
// Parsers
// ────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────
// HTTP source — Tier 2 declarative API ingest
// ────────────────────────────────────────────────────────────────────────

const DEFAULT_PAGE_MAX = 10;
const DEFAULT_CURSOR_MAX = 10;
const DEFAULT_PAGE_SIZE = 100;

async function fetchHttpRows(
    spec: IngestSpec,
    options: RunIngestOptions,
): Promise<Array<Record<string, unknown>>> {
    if (!spec.url) throw new Error('http source requires url');
    const baseUrl = interpolateVars(spec.url, options.vars ?? {});
    const headers = await buildAuthHeaders(spec.auth ?? { kind: 'none' }, options.credentialResolver);
    for (const [k, v] of Object.entries(spec.headers ?? {})) headers[k] = v;
    const method = spec.method ?? 'GET';
    const responsePath = spec.responsePath ?? '';

    const pagination: IngestPagination = spec.pagination ?? { kind: 'none' };
    const allRows: Array<Record<string, unknown>> = [];

    if (pagination.kind === 'none') {
        const body = await fetchOnce(baseUrl, method, headers);
        allRows.push(...extractRows(body, responsePath));
        return allRows;
    }

    if (pagination.kind === 'page') {
        const max = pagination.maxPages ?? DEFAULT_PAGE_MAX;
        const pageSize = pagination.pageSize ?? DEFAULT_PAGE_SIZE;
        for (let page = 1; page <= max; page++) {
            const url = new URL(baseUrl);
            url.searchParams.set(pagination.pageParam, String(page));
            if (pagination.sizeParam) url.searchParams.set(pagination.sizeParam, String(pageSize));
            const body = await fetchOnce(url.toString(), method, headers);
            const rows = extractRows(body, responsePath);
            if (rows.length === 0) break;
            allRows.push(...rows);
            if (rows.length < pageSize) break; // partial page = end of results
        }
        return allRows;
    }

    // cursor
    const max = pagination.maxRequests ?? DEFAULT_CURSOR_MAX;
    let cursor: string | null = null;
    for (let i = 0; i < max; i++) {
        const url = new URL(baseUrl);
        if (cursor) url.searchParams.set(pagination.cursorParam, cursor);
        const body = await fetchOnce(url.toString(), method, headers);
        const rows = extractRows(body, responsePath);
        allRows.push(...rows);
        const nextCursor = readPath(body, pagination.cursorPathInResponse);
        if (typeof nextCursor !== 'string' || nextCursor.length === 0) break;
        if (nextCursor === cursor) break; // guard against API bug returning same cursor
        cursor = nextCursor;
    }
    return allRows;
}

async function fetchOnce(url: string, method: 'GET' | 'POST', headers: Record<string, string>): Promise<unknown> {
    const r = await fetch(url, { method, headers });
    if (!r.ok) {
        const text = await r.text().catch(() => '');
        throw new Error(`HTTP ${r.status} ${r.statusText} from ${url}: ${text.slice(0, 200)}`);
    }
    const ct = r.headers.get('content-type') ?? '';
    if (ct.includes('json')) return await r.json();
    // Best-effort: try JSON parse, fall back to raw text.
    const text = await r.text();
    try { return JSON.parse(text); } catch { return text; }
}

async function buildAuthHeaders(
    auth: IngestAuth,
    resolver: CredentialResolver | undefined,
): Promise<Record<string, string>> {
    const headers: Record<string, string> = {};
    if (auth.kind === 'none') return headers;
    if (!resolver) {
        throw new Error(`ingest spec declares auth.kind=${auth.kind} but no credentialResolver was provided`);
    }
    const secret = await resolver(auth.credentialKey);
    if (!secret) {
        throw new Error(`credential "${auth.credentialKey}" not found in keychain (declared by auth.kind=${auth.kind})`);
    }
    if (auth.kind === 'bearer') {
        headers['Authorization'] = `Bearer ${secret}`;
    } else if (auth.kind === 'header') {
        headers[auth.headerName] = secret;
    } else if (auth.kind === 'basic') {
        // Stored as `<user>:<pass>`; encode base64.
        headers['Authorization'] = `Basic ${Buffer.from(secret, 'utf8').toString('base64')}`;
    }
    return headers;
}

function extractRows(body: unknown, responsePath: string): Array<Record<string, unknown>> {
    const target = responsePath ? readPath(body, responsePath) : body;
    if (Array.isArray(target)) {
        return target.filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object' && !Array.isArray(r));
    }
    if (target !== null && typeof target === 'object') {
        // A single object → treat as a one-row result.
        return [target as Record<string, unknown>];
    }
    return [];
}

function readPath(obj: unknown, dotPath: string): unknown {
    let cur: unknown = obj;
    for (const part of dotPath.split('.').filter(Boolean)) {
        if (cur === null || typeof cur !== 'object') return undefined;
        cur = (cur as Record<string, unknown>)[part];
    }
    return cur;
}

function interpolateVars(template: string, vars: Record<string, string | number | boolean>): string {
    return template.replace(/\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g, (_, name: string) => {
        if (!(name in vars)) {
            throw new Error(`url placeholder {{${name}}} not provided in vars`);
        }
        return encodeURIComponent(String(vars[name]));
    });
}

// ────────────────────────────────────────────────────────────────────────
// Tier 1 file parsers
// ────────────────────────────────────────────────────────────────────────

function parseCsvFile(text: string, delimiter: string): Array<Record<string, string>> {
    const rows = parseCsvSync(text, {
        columns: true,         // first row → header keys
        skip_empty_lines: true,
        delimiter,
        trim: true,
    }) as Array<Record<string, string>>;
    return rows;
}

function parseJsonFile(text: string): Array<Record<string, unknown>> {
    const v = JSON.parse(text);
    if (!Array.isArray(v)) {
        throw new Error('JSON ingest source must be an array of row objects at the top level');
    }
    for (let i = 0; i < v.length; i++) {
        if (v[i] === null || typeof v[i] !== 'object' || Array.isArray(v[i])) {
            throw new Error(`JSON ingest source row ${i + 1} is not an object`);
        }
    }
    return v as Array<Record<string, unknown>>;
}

// ────────────────────────────────────────────────────────────────────────
// Row → node mapping
// ────────────────────────────────────────────────────────────────────────

function computeId(row: Record<string, unknown>, strategy: IngestIdStrategy): string {
    if (strategy.kind === 'column') {
        const v = row[strategy.column];
        if (v === undefined || v === null || v === '') {
            throw new Error(`idStrategy.column "${strategy.column}" is missing or empty`);
        }
        return String(v);
    }
    // hash
    const parts: string[] = [];
    for (const col of strategy.columns) {
        const v = row[col];
        if (v === undefined || v === null) {
            throw new Error(`idStrategy.columns: missing column "${col}"`);
        }
        parts.push(String(v));
    }
    const hash = createHash(strategy.algo ?? 'sha1');
    hash.update(parts.join('\x1f'));  // unit-separator avoids ambiguity
    return hash.digest('hex');
}

function mapRowToNode(
    row: Record<string, unknown>,
    spec: IngestSpec,
    id: string,
    rowNumber: number,
): IngestNodeWrite {
    const fields = spec.fields;
    const label = readStringField(row, fields.label, 'label');
    const content = readStringField(row, fields.content, 'content', /* allowEmpty */ true);

    const node: IngestNodeWrite = {
        id,
        type: spec.mapTo,
        label,
        content,
        tags: readTags(row, fields, spec),
        metadata: { source_row: rowNumber, ingest_id: spec.id ?? null },
    };

    const project = readOptionalString(row, fields.project);
    if (project !== undefined) node.project = project;

    const ecosystem = readOptionalString(row, fields.ecosystem);
    if (ecosystem !== undefined) node.ecosystem = ecosystem;

    const language = readOptionalString(row, fields.language);
    if (language !== undefined) node.language = language;

    return node;
}

function readStringField(
    row: Record<string, unknown>,
    column: string | undefined,
    targetField: string,
    allowEmpty = false,
): string {
    if (column === undefined) {
        // Field unmapped: fall back to empty string. label is required by the
        // store; if the manifest didn't map it, throw.
        if (!allowEmpty && targetField === 'label') {
            throw new Error(`fields.label is required in the manifest and was not mapped`);
        }
        return '';
    }
    const v = row[column];
    if (v === undefined || v === null) {
        if (allowEmpty) return '';
        throw new Error(`column "${column}" is missing for field "${targetField}"`);
    }
    return String(v);
}

function readOptionalString(
    row: Record<string, unknown>,
    column: string | undefined,
): string | undefined {
    if (column === undefined) return undefined;
    const v = row[column];
    if (v === undefined || v === null || v === '') return undefined;
    return String(v);
}

function readTags(
    row: Record<string, unknown>,
    fields: IngestFieldMap,
    spec: IngestSpec,
): string[] {
    if (fields.tags === undefined) return [];
    const v = row[fields.tags];
    if (v === undefined || v === null || v === '') return [];
    if (Array.isArray(v)) {
        return v.map((x) => String(x).trim()).filter((s) => s.length > 0);
    }
    const delim = spec.tagDelimiter ?? ',';
    return String(v).split(delim).map((s) => s.trim()).filter((s) => s.length > 0);
}
