/**
 * ingestionFileRead.ts — TOCTOU-safe bounded file read for the ingestion routes
 * (ingestion.ts). Split out of ingestion.ts (file-size cap); no behaviour change.
 */

import fs from 'node:fs';
import { PathAllowlistError, MAX_INGESTION_BYTES } from '../../../security/pathAllowlist.js';

// F-LOW-E06 — TOCTOU-safe read. assertPathAllowed() stats the file for the
// size cap, but the file can change/grow between that check and the actual
// read. Open the path ONCE (fd), fstat the same fd, re-check the cap against
// the bytes we're about to read, then read via that fd — so the size we
// validate is the size we read. Closes the stat-then-read window.
export function readAllowedFileSync(resolvedPath: string): Buffer {
    const fd = fs.openSync(resolvedPath, 'r');
    try {
        const st = fs.fstatSync(fd);
        if (!st.isFile()) {
            throw new PathAllowlistError(`Not a regular file: ${resolvedPath}`, 'not-a-file');
        }
        if (st.size > MAX_INGESTION_BYTES) {
            throw new PathAllowlistError(
                `File exceeds ${MAX_INGESTION_BYTES}-byte ingestion cap: ${resolvedPath}`,
                'too-large',
            );
        }
        const buf = Buffer.allocUnsafe(st.size);
        let read = 0;
        while (read < st.size) {
            const n = fs.readSync(fd, buf, read, st.size - read, read);
            if (n === 0) break; // truncated mid-read; return what we got
            read += n;
        }
        return read === st.size ? buf : buf.subarray(0, read);
    } finally {
        fs.closeSync(fd);
    }
}
