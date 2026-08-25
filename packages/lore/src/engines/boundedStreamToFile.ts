/**
 * boundedStreamToFile.ts — stream an arbitrary-length Readable to a file on
 * disk, enforcing a byte cap DURING the write.
 *
 * Every HTTP route today reads its body via `readBoundedBody` (mcp/http/
 * helpers.ts): safely bounded at MAX_BODY_BYTES (10MB, shared by every
 * route), but the body still ends up as ONE in-memory string/buffer once
 * complete. That's fine at 10MB; it is not something to raise arbitrarily
 * just to accept bigger files, because every route on the server shares
 * that cap and a bigger cap means bigger in-memory buffers under concurrent
 * load, server-wide, not just for the one route that wants bigger files.
 *
 * This module is the missing safety primitive underneath real large-file
 * (>10MB) upload support: it never holds more than one in-flight chunk in
 * memory, streaming everything else straight to disk, and aborts + deletes
 * the partial file the instant the cap is crossed — so a route can safely
 * accept files far larger than 10MB with a cap independent of every other
 * route's JSON-body limit.
 *
 * NOT done here (separate, later increment): actual multipart/form-data
 * parsing and wiring this into /api/import's HTTP route. This module only
 * solves "how do we accept an arbitrarily large stream without the
 * daemon's memory scaling with file size" — see import.ts's header for the
 * still-open multipart-parser decision.
 */
import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import type { Readable } from 'node:stream';

export class StreamTooLargeError extends Error {
    constructor(public readonly maxBytes: number) {
        super(`stream exceeded ${maxBytes} bytes`);
        this.name = 'StreamTooLargeError';
    }
}

export interface BoundedStreamResult {
    path: string;
    bytesWritten: number;
}

/**
 * Pipes `source` into a file at `destPath`, aborting and deleting the
 * partial file the moment more than `maxBytes` have been written. Only ever
 * holds one in-flight chunk in memory — never the whole stream.
 */
export async function boundedStreamToFile(
    source: Readable,
    destPath: string,
    maxBytes: number,
): Promise<BoundedStreamResult> {
    return new Promise((resolve, reject) => {
        let bytesWritten = 0;
        let settled = false;
        const dest = createWriteStream(destPath);

        const cleanupAndReject = (err: Error): void => {
            if (settled) return;
            settled = true;
            source.removeAllListeners();
            source.destroy();
            dest.destroy();
            unlink(destPath)
                .catch(() => { /* best-effort cleanup — nothing more useful to do if this fails */ })
                .finally(() => reject(err));
        };

        source.on('error', cleanupAndReject);
        dest.on('error', cleanupAndReject);

        source.on('data', (chunk: Buffer) => {
            if (settled) return;
            bytesWritten += chunk.length;
            if (bytesWritten > maxBytes) {
                cleanupAndReject(new StreamTooLargeError(maxBytes));
                return;
            }
            // Backpressure: pause the source while the write buffer drains,
            // so a fast source can't outrun a slow disk and balloon memory.
            if (!dest.write(chunk)) {
                source.pause();
                dest.once('drain', () => source.resume());
            }
        });

        source.on('end', () => {
            if (settled) return;
            settled = true;
            dest.end(() => resolve({ path: destPath, bytesWritten }));
        });
    });
}
