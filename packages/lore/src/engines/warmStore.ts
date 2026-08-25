/**
 * warmStore.ts — W6a (Sprint W) warm-tier storage.
 *
 * Gzipped JSONL writer/reader at <workspace>/.lore/warm/<id>.jsonl.gz.
 * One file per node. Append-only conceptually (we only ever write the
 * single snapshot of a node when it transitions hot → warm).
 *
 * Why per-node file rather than one shared log:
 *   - Restore (W6b) needs random access by id. Per-file = O(1) read.
 *   - Compression of a single record is still meaningful (~50%) and
 *     the file count tracks node count, not a multiplier.
 *   - Operator can rm a single warm file to evict one node without
 *     rewriting a multi-MB shared log.
 *
 * Scope this slice (W6a): write + read + check existence + delete.
 * No restore-to-hot flow (W6b ships that alongside `lore archive
 * restore`).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { promisify } from 'node:util';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

/**
 * Minimal shape of a warmed node. Matches the LoreNode columns the
 * retention pass has access to without re-fetching from kuzu. Restore
 * in W6b will round-trip these fields back into kuzu via upsertNode.
 */
export interface WarmedNode {
    id: string;
    type: string;
    label: string;
    content: string;
    tags: string;
    metadata: string;
    project: string;
    ecosystem: string;
    /** Original updatedAt at warm-tier transition. Restore preserves it. */
    updatedAt: string;
    /** Timestamp the node was warmed (informational). */
    warmedAt: string;
    /** Verbatim text (concat of label + content + tags) at warm time —
     *  preserved here so a future restore can replay the verbatim
     *  write without recomputing the canonical form. */
    verbatimText?: string;
}

export class WarmStore {
    constructor(private readonly warmDir: string) {}

    /** Resolve filesystem path for a node's warm file. Caller is
     *  responsible for sanitizing `id` (kuzu LoreNode.id is already
     *  validated upstream — letters, digits, dash, colon, dot, slash). */
    private fileFor(id: string): string {
        // Replace path separators in id with `_` to keep one-file-per-id
        // on disk without subdirectories. Lore ids include `:` and `/`
        // (code-symbol:path/file.ts:Symbol:function).
        const safe = id.replace(/[/\\]/g, '_');
        return path.join(this.warmDir, `${safe}.jsonl.gz`);
    }

    async exists(id: string): Promise<boolean> {
        try {
            await fs.promises.access(this.fileFor(id), fs.constants.F_OK);
            return true;
        } catch {
            return false;
        }
    }

    /** Write a node to the warm tier. Atomic: gzip in-memory then
     *  write+rename so a partial-disk error can't leave a half-written
     *  file. Returns the resolved on-disk path. */
    async put(node: WarmedNode): Promise<string> {
        await fs.promises.mkdir(this.warmDir, { recursive: true });
        const target = this.fileFor(node.id);
        const tmp = `${target}.tmp`;
        const payload = await gzip(Buffer.from(`${JSON.stringify(node)}\n`, 'utf8'));
        await fs.promises.writeFile(tmp, payload);
        await fs.promises.rename(tmp, target);
        return target;
    }

    /** Read a warmed node. Returns null if absent. Throws on corrupt
     *  gzip / non-JSON contents — those indicate a disk issue worth
     *  surfacing rather than silently dropping the node. */
    async get(id: string): Promise<WarmedNode | null> {
        const target = this.fileFor(id);
        let raw: Buffer;
        try {
            raw = await fs.promises.readFile(target);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw err;
        }
        const decompressed = await gunzip(raw);
        const line = decompressed.toString('utf8').trim();
        if (!line) return null;
        return JSON.parse(line) as WarmedNode;
    }

    /** Remove a warm file. Returns true if a file was removed, false
     *  if it did not exist. Used by W6b restore (after rehydration)
     *  and by manual operator cleanup. */
    async delete(id: string): Promise<boolean> {
        try {
            await fs.promises.unlink(this.fileFor(id));
            return true;
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
            throw err;
        }
    }

    /** List every warmed-node id under this directory. O(N) directory
     *  scan; the preview CLI uses this for the "warmed" count. */
    async list(): Promise<string[]> {
        try {
            const entries = await fs.promises.readdir(this.warmDir);
            return entries
                .filter((f) => f.endsWith('.jsonl.gz') && !f.endsWith('.tmp'))
                .map((f) => f.slice(0, -'.jsonl.gz'.length).replace(/_/g, ':'));
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
            throw err;
        }
    }
}
