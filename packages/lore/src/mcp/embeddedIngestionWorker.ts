/**
 * mcp/embeddedIngestionWorker.ts - validation for the `extractWorker` and `vision` options of `createLore({ ingestion })`.
 * Split out of embeddedIngestion.ts to keep that file small. Pure: option -> config fields, throws RangeError.
 */
import { DEFAULT_EXTRACT, EXTRACT_BOUNDS, type IngestHostConfig } from '../ingestion/hostConfig.js';
import type { EmbeddedIngestionOptions } from './embeddedIngestionTypes.js';

function bad(name: string, why: string): never { throw new RangeError(`createLore({ ingestion }): ${name} ${why}`); }

function bounded(name: string, v: unknown, b: readonly [number, number]): number {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < b[0] || v > b[1]) bad(name, `must be an integer in [${b[0]}, ${b[1]}]`);
    return v as number;
}

/** Apply `extractWorker` / `vision` onto an already env-resolved config. Options win over env. */
export function applyExtractOptions(c: IngestHostConfig, o: EmbeddedIngestionOptions): void {
    const w = o.extractWorker;
    if (w !== undefined) {
        if (w === false) c.extract = { ...c.extract, mode: 'in-process', url: null };
        else {
            const opts = w === true ? {} : w;
            if (typeof opts !== 'object' || opts === null) bad('extractWorker', 'must be a boolean or an options object');
            const next = { ...c.extract };
            if (opts.url !== undefined) {
                if (typeof opts.url !== 'string' || opts.url.trim() === '') bad('extractWorker.url', 'must be a non-empty string');
                next.mode = 'url';
                next.url = opts.url.trim();
            } else { next.mode = 'child'; next.url = null; }
            if (opts.timeoutMs !== undefined) next.timeoutMs = bounded('extractWorker.timeoutMs', opts.timeoutMs, EXTRACT_BOUNDS.timeoutMs);
            if (opts.maxFileBytes !== undefined) next.maxFileBytes = bounded('extractWorker.maxFileBytes', opts.maxFileBytes, EXTRACT_BOUNDS.maxFileBytes);
            if (opts.maxMemoryMb !== undefined) next.maxMemoryMb = bounded('extractWorker.maxMemoryMb', opts.maxMemoryMb, EXTRACT_BOUNDS.maxMemoryMb);
            c.extract = next;
        }
    }
    const v = o.vision;
    if (v !== undefined) {
        if (v === false) c.vision = null;
        else {
            if (typeof v?.url !== 'string' || typeof v?.model !== 'string' || !v.url || !v.model) bad('vision', 'needs a url and a model');
            c.vision = {
                url: v.url, model: v.model,
                maxPages: v.maxPages === undefined ? DEFAULT_EXTRACT.visionMaxPages : bounded('vision.maxPages', v.maxPages, EXTRACT_BOUNDS.visionMaxPages),
                timeoutMs: v.timeoutMs === undefined ? DEFAULT_EXTRACT.visionTimeoutMs : bounded('vision.timeoutMs', v.timeoutMs, EXTRACT_BOUNDS.visionTimeoutMs),
            };
        }
    }
}
