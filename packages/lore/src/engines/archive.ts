/**
 * archive.ts — Tier A local content eviction (Phase 5 / C11).
 *
 * The three-pillar storage strategy:
 *   1. Observe  (C3.5 StorageInspector)           ← shipped
 *   2. Bound    (C5.5 QuotaManager)               ← shipped
 *   3. Offload  ← THIS FILE (Tier A)
 *
 * Tier A (local): bulky raw content moves to a separate on-disk
 * archive directory. The graph node remains with a `sourceRef`
 * pointing at the archive location; retrieval-on-demand.
 *
 *   Before eviction:
 *     Verbatim: id="lore:family-photo-2024-07-04" text="Summer beach..."
 *   After eviction:
 *     Verbatim: id="lore:family-photo-2024-07-04" text="(evicted: 2.3 MB @ archive:photos/...)"
 *     Archive: /Volumes/ExternalSSD/lore-archive/photos/family-photo-2024-07-04.bin
 *
 * This frees the hot-path storage (LanceDB + Kùzu) of the bulk while
 * keeping the graph searchable (embeddings stay) and navigable (metadata
 * stays). On "show me that photo", the UI resolves sourceRef to the
 * archive, reads the bytes, renders.
 *
 * Tier B (Lore Cloud) and Tier C (full cloud workspace) are later; they
 * implement the same IArchiveSink interface so the eviction logic is
 * transport-agnostic.
 *
 * Scope in Phase 5 / C11:
 *   - IArchiveSink interface + LocalFileSink implementation.
 *   - `sourceRef` type shape + helper encoders.
 *   - Manual eviction API (core code can call archive.evict(nodeId)).
 *
 * NOT in C11 scope:
 *   - Automatic eviction triggered by retention sweep (that's the
 *     retention-runtime landing in a future release).
 *   - UI for browsing / restoring archived content.
 *   - Tier B / Tier C implementations.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'node:crypto';
import { loreHome, loreHomePath } from '../config/loreHome.js';

/**
 * sourceRef — opaque pointer to archived content.
 *
 *   scheme:  'archive' | 'cloud' | 'url'
 *   path:    location within the scheme
 *   bytes:   original size (for UI display)
 *   sha256:  integrity — archive restore verifies the bytes match
 *
 * Encoded as URL-style for logs / node content:
 *   archive://local/photos/2024/07/family-beach-xyz.bin?bytes=2300000&sha256=abc...
 */
export interface SourceRef {
    scheme: 'archive' | 'cloud' | 'url';
    path: string;
    bytes: number;
    sha256: string;
}

export function encodeSourceRef(ref: SourceRef): string {
    const params = new URLSearchParams({ bytes: String(ref.bytes), sha256: ref.sha256 });
    return `${ref.scheme}://local/${ref.path}?${params.toString()}`;
}

export function decodeSourceRef(s: string): SourceRef | null {
    try {
        const u = new URL(s);
        const scheme = u.protocol.replace(':', '') as SourceRef['scheme'];
        if (scheme !== 'archive' && scheme !== 'cloud' && scheme !== 'url') return null;
        const bytes = parseInt(u.searchParams.get('bytes') ?? '0', 10);
        const sha256 = u.searchParams.get('sha256') ?? '';
        // URL strips the leading slash, and the host becomes the first
        // path segment (e.g. "local"). Drop that to get the archive path.
        const pathname = u.pathname.replace(/^\//, '');
        return { scheme, path: pathname, bytes, sha256 };
    } catch {
        return null;
    }
}

/**
 * IArchiveSink — pluggable destination for evicted content. Core ships
 * LocalFileSink; future Lore-Cloud sink implements the same interface.
 */
export interface IArchiveSink {
    /** Human-readable name of the sink (for logs + UI). */
    readonly name: string;
    /** Where does it store content? Absolute filesystem path for local; URL for cloud. */
    readonly location: string;
    /** Is the sink reachable/writable right now? */
    isReady(): Promise<boolean>;
    /** Write content + return a SourceRef. Caller keeps the ref in the node. */
    put(nodeId: string, content: Buffer): Promise<SourceRef>;
    /** Read content back given a SourceRef. Throws if missing/corrupt. */
    get(ref: SourceRef): Promise<Buffer>;
}

/**
 * LocalFileSink — writes evicted content to a directory on disk.
 *
 * Default location: ~/.groundfloor/archive/ (on the same disk).
 * Users with external drives can set LORE_ARCHIVE_DIR to a mounted
 * volume so the archive grows independently of Lore's hot path.
 *
 * Directory layout:
 *   <root>/
 *     ab/cd/ef123...bin     ← 3-level fanout by sha256 prefix
 *
 * Integrity: content is stored as raw bytes; hash recomputed on read
 * and compared to the SourceRef's sha256.
 */
export class LocalFileSink implements IArchiveSink {
    readonly name = 'local-file';
    readonly location: string;

    constructor(root?: string) {
        this.location = root
            ?? process.env['LORE_ARCHIVE_DIR']
            ?? loreHomePath('archive');
    }

    async isReady(): Promise<boolean> {
        try {
            fs.mkdirSync(this.location, { recursive: true, mode: 0o700 });
            // Touch a probe file to verify writability without leaving garbage.
            const probe = path.join(this.location, '.lore-probe');
            fs.writeFileSync(probe, '', { mode: 0o600 });
            fs.unlinkSync(probe);
            return true;
        } catch {
            return false;
        }
    }

    async put(nodeId: string, content: Buffer): Promise<SourceRef> {
        const sha256 = createHash('sha256').update(content).digest('hex');
        const prefix = sha256.slice(0, 2);
        const mid = sha256.slice(2, 4);
        const dir = path.join(this.location, prefix, mid);
        const filename = `${sha256}.bin`;
        const relPath = path.join(prefix, mid, filename);
        const absPath = path.join(this.location, relPath);

        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        // If the file already exists (content-addressed — same content
        // from another node would hit the same path), skip the write.
        if (!fs.existsSync(absPath)) {
            fs.writeFileSync(absPath, content, { mode: 0o600 });
        }

        return {
            scheme: 'archive',
            path: relPath.replace(/\\/g, '/'),
            bytes: content.byteLength,
            sha256,
        };
    }

    async get(ref: SourceRef): Promise<Buffer> {
        if (ref.scheme !== 'archive') {
            throw new Error(`LocalFileSink can't read ${ref.scheme}:// refs`);
        }
        const absPath = path.join(this.location, ref.path);
        const content = fs.readFileSync(absPath);
        const actualSha = createHash('sha256').update(content).digest('hex');
        if (actualSha !== ref.sha256) {
            throw new Error(`Archive integrity violation: expected ${ref.sha256}, got ${actualSha}`);
        }
        return content;
    }
}
