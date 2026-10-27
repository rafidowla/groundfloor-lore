/**
 * ingestion/blobStore.ts — where source file bytes live between enqueue and
 * processing. The job row only holds an opaque ref; processors never see it.
 * Files are content-addressed per workspace and written 0600.
 *
 * Implementations: {@link FsBlobStore} (single host, here) and
 * GroundfloorBlobStore (groundfloorBlobStore.ts, shared across nodes). The host
 * picks one with LORE_INGEST_BLOB_STORE (see blobStoreFactory.ts).
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface IBlobStore {
    put(workspace: string, sha256: string, bytes: Buffer): Promise<string>;
    /** Throws {@link BlobNotFoundError} when the blob no longer exists (e.g. removed by blob retention). */
    get(ref: string): Promise<Buffer>;
    /** True when the blob behind `ref` exists. Lets enqueue reuse a stored blob instead of uploading it again. */
    has?(ref: string): Promise<boolean>;
    /** Remove a blob. Resolves false when it was already gone. Optional: a store without it cannot take part in blob retention. */
    delete?(ref: string): Promise<boolean>;
    /**
     * Pure syntax check: is `ref` shaped like a ref THIS store hands out? A ref that is not can name no blob the store
     * holds, so a caller (workspace erase) may treat it as "nothing to delete" instead of a failure. Must not do I/O and
     * must not throw. Optional: without it a caller cannot tell a malformed ref from an I/O fault and must treat any throw as a failure.
     */
    isValidRef?(ref: string): boolean;
}

/** The bytes behind a ref are gone (purged by retention or removed out of band). Never retryable by itself: re-upload the file. */
export class BlobNotFoundError extends Error {
    constructor(message = 'blob not found') { super(message); this.name = 'BlobNotFoundError'; }
}

export function sha256Hex(b: Buffer): string { return createHash('sha256').update(b).digest('hex'); }

/** A ref this store produced: `<16 hex>/<64 hex sha256>`. Nothing else is ever turned into a path. */
const FS_REF = /^[0-9a-f]{16}\/[0-9a-f]{64}$/;

export class FsBlobStore implements IBlobStore {
    private readonly root: string;
    constructor(root: string) { this.root = path.resolve(root); }

    async put(workspace: string, sha256: string, bytes: Buffer): Promise<string> {
        if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('bad sha256');
        if (sha256Hex(bytes) !== sha256) throw new Error('blob bytes do not match the given sha256');
        const wsDir = createHash('sha256').update(workspace).digest('hex').slice(0, 16);
        const dir = path.join(this.root, wsDir);
        await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
        const file = path.join(dir, sha256);
        if (!fs.existsSync(file)) {
            const tmp = `${file}.${process.pid}.tmp`;
            await fs.promises.writeFile(tmp, bytes, { mode: 0o600 });
            await fs.promises.rename(tmp, file);
        }
        return path.join(wsDir, sha256);
    }

    /** True only for `<16 hex>/<64 hex>`: traversal (`../x`), absolute paths and anything else this store never produced are malformed. */
    isValidRef(ref: string): boolean {
        return typeof ref === 'string' && FS_REF.test(ref.split(path.sep).join('/'));
    }

    /** Resolve a ref to a path inside the root, or throw. A tampered job row must not become an arbitrary file read or delete. */
    private resolve(ref: string): string {
        const norm = ref.split(path.sep).join('/');
        if (!this.isValidRef(ref)) throw new Error('blob ref is not a valid blob reference');
        const full = path.resolve(this.root, norm);
        if (full !== this.root && !full.startsWith(this.root + path.sep)) throw new Error('blob ref escapes root');
        return full;
    }

    async get(ref: string): Promise<Buffer> {
        try { return await fs.promises.readFile(this.resolve(ref)); }
        catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new BlobNotFoundError(); throw e; }
    }

    async has(ref: string): Promise<boolean> {
        try { await fs.promises.access(this.resolve(ref)); return true; }
        catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
    }

    async delete(ref: string): Promise<boolean> {
        try { await fs.promises.unlink(this.resolve(ref)); return true; }
        catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
    }
}
