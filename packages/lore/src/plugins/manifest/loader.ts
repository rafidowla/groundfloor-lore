/**
 * loader.ts — Read a plugin manifest from disk and return a validated value.
 *
 * Wraps three concerns the daemon's plugin loader (and any CLI / wizard
 * tooling) should never re-implement:
 *   1. File IO with structured errors (not found vs. unreadable vs. wrong UTF-8).
 *   2. Format auto-detection by extension (`.yaml` / `.yml` / `.json`).
 *   3. Parsing into a raw value, then handing off to `validateManifest`.
 *
 * Why YAML is supported alongside JSON: the spec accepts both. YAML is
 * the human-authored shape (the wizard writes YAML, plugin authors read
 * YAML), JSON is the tooling shape (the Tauri shell loader speaks JSON
 * today). One loader covers both so callers don't have to.
 *
 * Pure I/O lives in this file. Pure validation lives in `./validator.ts`.
 * Pure error types live in `./errors.ts`. The split is so each piece is
 * unit-testable on its own.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as yaml from 'yaml';

import type { ValidatedManifest } from '../manifest.js';
import { ManifestLoadError, ManifestValidationError, type ManifestValidationIssue } from './errors.js';
import { validateManifest } from './validator.js';

export type ManifestFormat = 'yaml' | 'json';

/**
 * Load + validate a manifest from a file path. Returns the typed
 * `ValidatedManifest`; throws `ManifestLoadError` on IO/parse problems
 * and `ManifestValidationError` on structural problems.
 *
 * The optional `warnings` out-array, if provided, receives any
 * non-fatal validation issues (e.g. unknown forward-compat fields).
 */
export async function loadManifest(
    filePath: string,
    warnings?: ManifestValidationIssue[],
): Promise<ValidatedManifest> {
    const absPath = path.resolve(filePath);
    const format = detectFormat(absPath);

    let raw: Buffer;
    try {
        raw = await fs.readFile(absPath);
    } catch (err) {
        const msg = (err as NodeJS.ErrnoException).code === 'ENOENT'
            ? 'not-found'
            : 'not-readable';
        throw new ManifestLoadError(msg, absPath, (err as Error).message);
    }

    let text: string;
    try {
        text = raw.toString('utf8');
        // toString never throws; use TextDecoder for the strict check.
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const _decoded = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    } catch {
        throw new ManifestLoadError('invalid-utf8', absPath);
    }

    let parsed: unknown;
    try {
        parsed = parseManifest(text, format);
    } catch (err) {
        throw new ManifestLoadError('parse-error', absPath, (err as Error).message);
    }

    return validateManifest(parsed, warnings);
}

/**
 * Pure parser — no IO, no validation. Useful for tests, in-memory
 * authoring, and the wizard's draft-preview path. Throws on malformed
 * input; caller wraps with their own context.
 */
export function parseManifest(text: string, format: ManifestFormat): unknown {
    if (format === 'json') {
        return JSON.parse(text);
    }
    return yaml.parse(text);
}

/**
 * Detect format from extension. Conservative: only the three documented
 * extensions are accepted. Anything else throws — we don't want to
 * silently mis-parse a `.txt` file as JSON.
 */
export function detectFormat(filePath: string): ManifestFormat {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.json') return 'json';
    if (ext === '.yaml' || ext === '.yml') return 'yaml';
    throw new ManifestLoadError(
        'unsupported-extension',
        filePath,
        `extension "${ext || '(none)'}" is not one of .yaml, .yml, .json`,
    );
}

/**
 * Convenience: try `<dir>/plugin.yaml`, then `.yml`, then `.json`. The
 * spec says either is acceptable; this helper picks the one that exists
 * so callers can pass a bundle directory rather than a file path.
 *
 * Returns the resolved file path along with the loaded manifest.
 */
export async function loadManifestFromBundle(
    bundleDir: string,
    warnings?: ManifestValidationIssue[],
): Promise<{ manifest: ValidatedManifest; filePath: string }> {
    const candidates = ['plugin.yaml', 'plugin.yml', 'plugin.json'];
    const errors: string[] = [];
    for (const name of candidates) {
        const filePath = path.join(bundleDir, name);
        try {
            await fs.access(filePath);
            const manifest = await loadManifest(filePath, warnings);
            return { manifest, filePath };
        } catch (err) {
            if (err instanceof ManifestLoadError && err.cause === 'not-found') {
                continue; // try next candidate
            }
            // Real failure (parse / validation / IO) — surface it.
            throw err;
        }
    }
    throw new ManifestLoadError(
        'not-found',
        bundleDir,
        `no manifest file found (looked for: ${candidates.join(', ')})`,
    );
}
