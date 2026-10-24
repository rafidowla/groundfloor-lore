/**
 * postgresBackupBundle.ts — the on-disk format of a per-workspace logical
 * backup, plus the writer, the verifying reader and the checksum primitives.
 * Pure file/crypto code: no `pg` here, so it can be unit-tested and sniffed
 * without a database.
 *
 * FORMAT (NDJSON, optionally gzip; same family as the arcade bundle):
 *
 *   line 1      {"t":"header", ...}   source workspace, versions, schema fingerprint,
 *                                     per-table columns/types/ids, excluded tables
 *   data lines  [tableIndex, v1, v2…] one row; every value is the column's TEXT form
 *                                     (string, or null for SQL NULL). `workspace_id` is
 *                                     NOT stored per row — it is the header's source id.
 *   last line   {"t":"trailer", ...}  per-table row counts + order-independent content
 *                                     checksums, sha256 of every byte before the trailer,
 *                                     and a manifest hash over the whole trailer
 *
 * Values travel as text so every Postgres type (pgvector included) round-trips
 * through the server's own input/output functions with no client-side
 * interpretation; the export pins the session settings that make that text
 * exact (see BACKUP_SESSION_SETTINGS).
 *
 * VERIFICATION happens BEFORE any restore write: the byte hash, then each
 * table's recomputed row count and checksum against the trailer, then the
 * manifest hash. Any mismatch is {@link BundleHashMismatchError} and the
 * restore has touched nothing.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as zlib from 'node:zlib';
import { once } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import type { ExcludedTable } from './postgresBackupDiscovery.js';

export const BUNDLE_FORMAT = 'lore-pg-workspace-bundle';
export const BUNDLE_FORMAT_VERSION = 1;

export interface BundleTableSpec {
    name: string;
    partitioned: boolean;
    workspaceIdType: string;
    columns: { name: string; type: string; notNull: boolean }[];
    generatedColumns: string[];
    identityColumns: string[];
    references: { column: string; refTable: string; refColumn: string; source: 'foreign_key' | 'comment' }[];
}

export interface BundleHeader {
    t: 'header';
    format: typeof BUNDLE_FORMAT;
    formatVersion: number;
    createdAt: string;
    loreVersion: string;
    pgvectorVersion: string | null;
    serverVersion: string;
    schema: string;
    schemaFingerprint: string;
    sourceWorkspaceId: string;
    tables: BundleTableSpec[];
    excluded: ExcludedTable[];
}

export interface BundleTableStats {
    name: string;
    rowCount: number;
    /** Order-independent content checksum (sum of per-row sha256 mod 2^256, hex). */
    checksum: string;
    /** min/max of each identity column, as decimal strings (bigint-safe). */
    identityRanges: Record<string, { min: string; max: string }>;
}

export interface BundleTrailer {
    t: 'trailer';
    tables: BundleTableStats[];
    bodyBytes: number;
    bodySha256: string;
    manifestHash: string;
}

/** Verification failure: the bundle is not what its trailer says. Maps to `bundle_hash_mismatch`. */
export class BundleHashMismatchError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'BundleHashMismatchError';
    }
}

const MASK_256 = (1n << 256n) - 1n;

/** Order-independent multiset checksum: rows may be visited in any order. */
export class RowChecksum {
    private acc = 0n;
    private n = 0;
    add(line: string): void {
        this.acc = (this.acc + BigInt('0x' + crypto.createHash('sha256').update(line).digest('hex'))) & MASK_256;
        this.n++;
    }
    get count(): number { return this.n; }
    hex(): string { return this.acc.toString(16).padStart(64, '0'); }
}

/** Track min/max of integer text values (bigint-safe). */
export class RangeTracker {
    private min: bigint | null = null;
    private max: bigint | null = null;
    add(text: string | null): void {
        if (text === null) return;
        const v = BigInt(text);
        if (this.min === null || v < this.min) this.min = v;
        if (this.max === null || v > this.max) this.max = v;
    }
    toJSON(): { min: string; max: string } | null {
        return this.min === null || this.max === null ? null : { min: this.min.toString(), max: this.max.toString() };
    }
}

/** The data line for a row: identical on export, bundle verification and restore read-back. */
export function rowLine(tableIndex: number, values: (string | null)[]): string {
    return JSON.stringify([tableIndex, ...values]);
}

/** Hash of the trailer content (everything except `manifestHash` itself). */
export function computeManifestHash(trailer: Omit<BundleTrailer, 'manifestHash'>): string {
    return crypto.createHash('sha256').update(JSON.stringify([trailer.tables, trailer.bodyBytes, trailer.bodySha256])).digest('hex');
}

// ── writer ─────────────────────────────────────────────────────────────

export class BundleWriter {
    private readonly hash = crypto.createHash('sha256');
    private bytes = 0;
    private readonly file: fs.WriteStream;
    private readonly sink: Writable;
    private failure: Error | undefined;

    constructor(readonly path: string, gzip: boolean) {
        this.file = fs.createWriteStream(path, { flags: 'wx' });
        this.file.on('error', (e) => { this.failure = e; });
        if (gzip) {
            const gz = zlib.createGzip();
            gz.on('error', (e) => { this.failure = e; });
            gz.pipe(this.file);
            this.sink = gz;
        } else {
            this.sink = this.file;
        }
    }

    /** Write one body line (counted + hashed). */
    async line(text: string): Promise<void> {
        const buf = Buffer.from(text + '\n', 'utf8');
        this.hash.update(buf);
        this.bytes += buf.length;
        await this.emit(buf);
    }

    get bodyBytes(): number { return this.bytes; }
    bodySha256(): string { return this.hash.copy().digest('hex'); }

    /** Write the trailer (NOT part of the body hash) and close the file. */
    async finish(stats: BundleTableStats[]): Promise<BundleTrailer> {
        const base = { tables: stats, bodyBytes: this.bytes, bodySha256: this.bodySha256() };
        const trailer: BundleTrailer = { t: 'trailer', ...base, manifestHash: computeManifestHash({ t: 'trailer', ...base }) };
        await this.emit(Buffer.from(JSON.stringify(trailer) + '\n', 'utf8'));
        this.sink.end();
        await once(this.file, 'close');
        if (this.failure) throw this.failure;
        return trailer;
    }

    /** Abort: close the stream and let the caller delete the partial file. */
    async abort(): Promise<void> {
        this.sink.destroy();
        this.file.destroy();
    }

    private async emit(buf: Buffer): Promise<void> {
        if (this.failure) throw this.failure;
        if (!this.sink.write(buf)) await once(this.sink, 'drain');
        if (this.failure) throw this.failure;
    }
}

// ── reader ─────────────────────────────────────────────────────────────

function openBundleStream(path: string): Readable {
    const fd = fs.openSync(path, 'r');
    const magic = Buffer.alloc(2);
    fs.readSync(fd, magic, 0, 2, 0);
    fs.closeSync(fd);
    const raw = fs.createReadStream(path);
    if (magic[0] === 0x1f && magic[1] === 0x8b) {
        const gunzip = zlib.createGunzip();
        raw.on('error', (e) => gunzip.destroy(e));
        return raw.pipe(gunzip);
    }
    return raw;
}

/** Yield each line's text and its raw bytes (so the body hash is over true bytes, not re-encoded text). */
export async function* bundleLines(path: string): AsyncGenerator<{ text: string; raw: Buffer }> {
    let carry: Buffer = Buffer.alloc(0);
    for await (const chunk of openBundleStream(path) as AsyncIterable<Buffer>) {
        carry = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
        let start = 0;
        let nl: number;
        while ((nl = carry.indexOf(0x0a, start)) !== -1) {
            const raw = carry.subarray(start, nl + 1);
            yield { text: raw.subarray(0, raw.length - 1).toString('utf8'), raw };
            start = nl + 1;
        }
        carry = carry.subarray(start);
    }
    if (carry.length > 0) yield { text: carry.toString('utf8'), raw: carry };
}

export interface VerifiedBundle {
    header: BundleHeader;
    trailer: BundleTrailer;
}

function parseHeader(text: string): BundleHeader {
    let h: unknown;
    try { h = JSON.parse(text); } catch { throw new BundleHashMismatchError('bundle header is not valid JSON'); }
    const hdr = h as Partial<BundleHeader>;
    if (hdr.t !== 'header' || hdr.format !== BUNDLE_FORMAT) throw new BundleHashMismatchError(`not a ${BUNDLE_FORMAT} file`);
    if (hdr.formatVersion !== BUNDLE_FORMAT_VERSION) {
        throw new BundleHashMismatchError(`unsupported bundle formatVersion ${String(hdr.formatVersion)} (this build reads ${BUNDLE_FORMAT_VERSION})`);
    }
    return hdr as BundleHeader;
}

/**
 * verifyBundle — read the whole file once and prove it is intact: byte hash,
 * per-table row counts and checksums, manifest hash. Throws
 * {@link BundleHashMismatchError} on any difference. Touches no database.
 */
export async function verifyBundle(path: string): Promise<VerifiedBundle> {
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    let header: BundleHeader | undefined;
    let trailer: BundleTrailer | undefined;
    const sums: RowChecksum[] = [];
    try {
        for await (const { text, raw } of bundleLines(path)) {
            if (trailer) throw new BundleHashMismatchError('data found after the trailer');
            if (!header) {
                header = parseHeader(text);
                header.tables.forEach(() => sums.push(new RowChecksum()));
                hash.update(raw);
                bytes += raw.length;
                continue;
            }
            if (text.startsWith('{"t":"trailer"')) {
                try { trailer = JSON.parse(text) as BundleTrailer; } catch { throw new BundleHashMismatchError('bundle trailer is not valid JSON'); }
                continue;
            }
            hash.update(raw);
            bytes += raw.length;
            const idx = parseRowTableIndex(text);
            const sum = sums[idx];
            if (!sum) throw new BundleHashMismatchError(`row references unknown table index ${idx}`);
            sum.add(text);
        }
    } catch (err) {
        if (err instanceof BundleHashMismatchError) throw err;
        throw new BundleHashMismatchError(`bundle unreadable: ${(err as Error).message}`);
    }
    if (!header) throw new BundleHashMismatchError('bundle is empty');
    if (!trailer) throw new BundleHashMismatchError('bundle has no trailer (truncated?)');
    if (bytes !== trailer.bodyBytes) throw new BundleHashMismatchError(`body is ${bytes} bytes, trailer says ${trailer.bodyBytes}`);
    if (hash.digest('hex') !== trailer.bodySha256) throw new BundleHashMismatchError('body sha256 does not match the trailer');
    const { manifestHash, ...rest } = trailer;
    if (computeManifestHash(rest) !== manifestHash) throw new BundleHashMismatchError('manifest_hash does not match the trailer');
    if (trailer.tables.length !== header.tables.length) throw new BundleHashMismatchError('trailer table list differs from the header');
    trailer.tables.forEach((stats, i) => {
        const sum = sums[i]!;
        if (stats.name !== header!.tables[i]!.name) throw new BundleHashMismatchError(`trailer table ${i} is ${stats.name}, header says ${header!.tables[i]!.name}`);
        if (sum.count !== stats.rowCount) throw new BundleHashMismatchError(`table ${stats.name}: ${sum.count} rows in the body, trailer says ${stats.rowCount}`);
        if (sum.hex() !== stats.checksum) throw new BundleHashMismatchError(`table ${stats.name}: content checksum does not match the trailer`);
    });
    return { header, trailer };
}

/** Table index of a data line without a full parse of large vector rows: `[<idx>,…`. */
function parseRowTableIndex(text: string): number {
    const m = /^\[(\d+),/.exec(text);
    if (!m) throw new BundleHashMismatchError('malformed data line');
    return Number(m[1]);
}

/** Stream the data rows of a (already verified) bundle: `{table, values}` in file order. */
export async function* bundleRows(path: string): AsyncGenerator<{ table: number; values: (string | null)[] }> {
    let first = true;
    for await (const { text } of bundleLines(path)) {
        if (first) { first = false; continue; }
        if (text.startsWith('{"t":"trailer"')) return;
        const arr = JSON.parse(text) as [number, ...(string | null)[]];
        yield { table: arr[0], values: arr.slice(1) as (string | null)[] };
    }
}

/**
 * peekBundleHeader — read just the header, without verifying the body.
 * Returns null when the file is not a Lore workspace bundle (e.g. a SQLite
 * `.tar.gz` archive), so callers can route by content, not by file name.
 */
export async function peekBundleHeader(path: string): Promise<BundleHeader | null> {
    try {
        const stream = openBundleStream(path);
        let carry = '';
        for await (const chunk of stream as AsyncIterable<Buffer>) {
            carry += chunk.toString('latin1');
            if (!carry.startsWith('{"t":"header"') && carry.length >= 14) { stream.destroy(); return null; }
            const nl = carry.indexOf('\n');
            if (nl !== -1) {
                stream.destroy();
                return parseHeader(Buffer.from(carry.slice(0, nl), 'latin1').toString('utf8'));
            }
            if (carry.length > 64 * 1024 * 1024) { stream.destroy(); return null; }
        }
    } catch {
        return null;
    }
    return null;
}
