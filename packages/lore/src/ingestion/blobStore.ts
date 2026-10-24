/**
 * ingestion/blobStore.ts — where source file bytes live between enqueue and
 * processing. The job row only holds an opaque ref; processors never see it.
 * Files are content-addressed per workspace and written 0600.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface IBlobStore {
    put(workspace: string, sha256: string, bytes: Buffer): Promise<string>;
    get(ref: string): Promise<Buffer>;
}

export function sha256Hex(b: Buffer): string { return createHash('sha256').update(b).digest('hex'); }

export class FsBlobStore implements IBlobStore {
    private readonly root: string;
    constructor(root: string) { this.root = path.resolve(root); }

    async put(workspace: string, sha256: string, bytes: Buffer): Promise<string> {
        if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('bad sha256');
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

    async get(ref: string): Promise<Buffer> {
        const full = path.resolve(this.root, ref);
        // Refuse refs that escape the root (a tampered job row must not become an arbitrary file read).
        if (full !== this.root && !full.startsWith(this.root + path.sep)) throw new Error('blob ref escapes root');
        return fs.promises.readFile(full);
    }
}
