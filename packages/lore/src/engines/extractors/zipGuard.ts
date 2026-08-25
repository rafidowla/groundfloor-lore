/**
 * zipGuard.ts — decompression-bomb defense for the zip-based extractors
 * (pptx, epub, xlsx/ods).
 *
 * audit 2026-06-18 (HIGH, malicious-content DoS) — the OOXML/EPUB extractors
 * inflated attacker-controlled archive entries into memory with NO size cap, so
 * a small "zip bomb" (a few KB that declares/inflates to many GB) OOM-crashed
 * the daemon. JSZip reads the central directory lazily, so each entry's DECLARED
 * uncompressed size is known before we decompress — check it against a per-entry
 * and per-archive budget and refuse a bomb up front, cheaply.
 *
 * This is the standard, proportionate mitigation: it stops the common zip bomb
 * (which declares its large size in the directory).
 *
 * F-E01 (2026-06-27, medium, unsafe-uploads) — the declared-size check alone is
 * bypassed by a "lying" zip whose central-directory header under-reports a small
 * size but inflates huge at read time. We now ALSO cap the ACTUAL decompressed
 * bytes so a header that lies about its size can no longer slip a bomb past the
 * preflight.
 *
 * D2-sync-2 (residual of F-E01) — the original F-E01 fix called
 * `entry.async('nodebuffer')`, which FULLY decompresses an entry into memory
 * BEFORE the post-inflate byte check could run. A single lying-header entry
 * (declares a small/absent uncompressedSize so the declared-size preflight
 * passes, then inflates to many GB) was therefore fully materialized and OOM'd
 * the daemon before the cap was ever consulted. `ZipByteBudget.readString()`
 * now STREAMS the entry via JSZip's `nodeStream('nodebuffer')`, accumulating
 * chunks while enforcing the per-entry ceiling AND the running archive total on
 * every chunk; it destroys the stream and throws the instant a ceiling is
 * crossed, so a lying-header entry never fully materializes in memory.
 */

/** Max declared uncompressed size for a single entry. */
export const MAX_ENTRY_BYTES = 100 * 1024 * 1024; // 100 MB
/** Max declared uncompressed size summed across all entries in one archive. */
export const MAX_TOTAL_BYTES = 300 * 1024 * 1024; // 300 MB

interface ZipLike {
    files: Record<string, { dir?: boolean; _data?: { uncompressedSize?: number } }>;
}

/**
 * Minimal shape of a JSZip entry object we read from. D2-sync-2: we stream via
 * `nodeStream` so a lying-header entry never fully materializes; `async` is kept
 * only as a typed fallback for environments where `nodeStream` is unavailable.
 */
interface ZipEntryLike {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async(type: string): Promise<any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nodeStream?(type: 'nodebuffer'): any;
}

/**
 * Throw if a JSZip archive's declared uncompressed sizes breach the budget.
 * Call right after `JSZip.loadAsync(...)`, before any `.async(...)` decompress.
 */
export function assertZipWithinBudget(
    zip: ZipLike,
    label = 'archive',
    entryCap = MAX_ENTRY_BYTES,
    totalCap = MAX_TOTAL_BYTES,
): void {
    let total = 0;
    for (const name of Object.keys(zip.files)) {
        const f = zip.files[name];
        if (!f || f.dir) continue;
        const declared = Number(f._data?.uncompressedSize ?? 0);
        if (declared > entryCap) {
            throw new Error(`${label}: entry '${name}' declares ${declared} bytes uncompressed (> ${entryCap} cap) — refusing to decompress (possible zip bomb)`);
        }
        total += declared;
        if (total > totalCap) {
            throw new Error(`${label}: total declared decompressed size exceeds ${totalCap} bytes — refusing to decompress (possible zip bomb)`);
        }
    }
}

/**
 * F-E01 — tracks REAL decompressed bytes across an archive's entry reads.
 *
 * The declared-size preflight (`assertZipWithinBudget`) trusts header values; a
 * lying header bypasses it. A `ZipByteBudget` keeps a running total of the
 * ACTUAL bytes inflated and aborts when the per-entry or per-archive cap is
 * breached. Construct one per archive, then read every entry through it instead
 * of calling `entry.async(...)` directly.
 */
export class ZipByteBudget {
    private total = 0;
    constructor(
        private readonly label = 'archive',
        private readonly entryCap = MAX_ENTRY_BYTES,
        private readonly totalCap = MAX_TOTAL_BYTES,
    ) {}

    /**
     * Inflate one entry as a string, enforcing the real-byte budget. Throws a
     * "possible zip bomb" error if the actual decompressed size exceeds a cap —
     * this catches archives that LIE about their declared (header) size.
     *
     * D2-sync-2: STREAMS the entry rather than buffering it whole. Each inflated
     * chunk is checked against the per-entry ceiling and the running archive
     * total BEFORE it is retained; the moment a ceiling is crossed the stream is
     * destroyed and we throw, so a lying-header entry can never fully
     * materialize in memory (the prior `entry.async('nodebuffer')` decompressed
     * the whole entry before any check could run — that was the OOM hole).
     */
    async readString(entry: ZipEntryLike, name = 'entry'): Promise<string> {
        // Streaming path (JSZip nodeStream): bounded materialization.
        if (typeof entry.nodeStream === 'function') {
            return this.readStringStreamed(entry, name);
        }
        // D2-sync-2 fallback: nodeStream unavailable. Buffer whole, then check.
        // (Best-effort only — prefer the streaming path above.)
        const buf: Buffer = await entry.async('nodebuffer');
        const actual = buf.byteLength;
        if (actual > this.entryCap) {
            throw new Error(`${this.label}: entry '${name}' inflated to ${actual} actual bytes (> ${this.entryCap} cap) — refusing (possible zip bomb / lying header)`);
        }
        this.total += actual;
        if (this.total > this.totalCap) {
            throw new Error(`${this.label}: total actual decompressed size exceeds ${this.totalCap} bytes — refusing (possible zip bomb / lying header)`);
        }
        return buf.toString('utf8');
    }

    /** D2-sync-2: stream one entry, enforcing both caps on every inflated chunk. */
    private readStringStreamed(entry: ZipEntryLike, name: string): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const stream: any = entry.nodeStream!('nodebuffer');
            const chunks: Buffer[] = [];
            let entryBytes = 0;
            let settled = false;

            const fail = (err: Error): void => {
                if (settled) return;
                settled = true;
                // Abort decompression so no further bytes are inflated.
                try { stream.destroy?.(); } catch { /* ignore */ }
                reject(err);
            };

            stream.on('data', (chunk: Buffer) => {
                if (settled) return;
                const len = chunk.byteLength;
                entryBytes += len;
                if (entryBytes > this.entryCap) {
                    fail(new Error(`${this.label}: entry '${name}' inflated past ${this.entryCap} actual bytes (> cap) — refusing (possible zip bomb / lying header)`));
                    return;
                }
                this.total += len;
                if (this.total > this.totalCap) {
                    fail(new Error(`${this.label}: total actual decompressed size exceeds ${this.totalCap} bytes — refusing (possible zip bomb / lying header)`));
                    return;
                }
                chunks.push(chunk);
            });
            stream.on('error', (err: Error) => fail(err));
            stream.on('end', () => {
                if (settled) return;
                settled = true;
                resolve(Buffer.concat(chunks).toString('utf8'));
            });
        });
    }
}

/**
 * 4.1 (2026-08-17) — enforce the REAL inflated-byte budget across every entry
 * of an archive, for extractors (docx/xlsx) that hand the raw zip to a
 * third-party inflater (mammoth/sheetjs) instead of reading entries through
 * `ZipByteBudget` themselves. `assertZipWithinBudget` trusts declared sizes,
 * which a lying header bypasses; streaming each entry here catches a lying
 * header BEFORE the third-party inflater materializes the bomb.
 */
export async function assertZipRealBytesWithinBudget(zip: ZipLike, label = 'archive'): Promise<void> {
    const budget = new ZipByteBudget(label);
    for (const [name, entry] of Object.entries(zip.files)) {
        if ((entry as { dir?: boolean }).dir) continue;
        await budget.readString(entry as ZipEntryLike, name);
    }
}
