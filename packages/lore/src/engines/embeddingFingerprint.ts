/**
 * embeddingFingerprint.ts — Q2.2 follow-up to slice 7.
 *
 * Persists a small JSON file that records WHICH embedding model produced
 * the vectors currently in `lore_verbatim`. The fingerprint lives
 * alongside the LanceDB store at:
 *
 *   <basePath>/.lore/lancedb/embedding_model.json
 *
 *   {
 *     "modelId":   "Xenova/all-MiniLM-L6-v2",
 *     "dimension": 384,
 *     "writtenAt": "2026-04-25T12:00:00.000Z",
 *     "version":   1
 *   }
 *
 * Why a sidecar file (vs. a row in LanceDB):
 *   - LanceDB tables are sharded across multiple files; the fingerprint
 *     needs to survive a `dropTable + create` cycle (which is exactly
 *     what the migration does).
 *   - It must be readable BEFORE we open LanceDB, so a startup check
 *     can warn loudly if the configured model doesn't match what the
 *     vectors were embedded with.
 *
 * Slice-7 commit deferred this work explicitly: "A future slice will
 * add migration tooling (drop+rebuild lore_verbatim, modelId
 * fingerprint check) to make flipping the default safe." That's this
 * module + `migrateEmbeddingModel.ts`.
 *
 * Compatibility:
 *   - First read on a pre-fingerprint store returns `null`. Callers
 *     treat that as "legacy MiniLM 384-d" — the only embedder that
 *     existed before slice 6a/7.
 *   - `assertCompatible` is intentionally non-fatal by default
 *     (`strict: false`): it logs to stderr but does not throw, so an
 *     existing daemon doesn't refuse to start after a config flip.
 *     Operators run `lore migrate embedding-model` to resolve.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Filename under <basePath>/.lore/lancedb/. */
const FINGERPRINT_FILENAME = 'embedding_model.json';

/** Schema version — bump when the JSON shape changes incompatibly. */
const FINGERPRINT_VERSION = 1;

/** Default values when no fingerprint exists yet (pre-migration legacy store). */
const LEGACY_DEFAULT_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const LEGACY_DEFAULT_DIMENSION = 384;

export interface EmbeddingFingerprint {
    modelId: string;
    dimension: number;
    writtenAt: string;
    /** Schema version; lets us add fields without breaking older daemons. */
    version: number;
}

function fingerprintPath(basePath: string): string {
    return path.join(basePath, '.lore', 'lancedb', FINGERPRINT_FILENAME);
}

/**
 * Read the on-disk fingerprint. Returns `null` if the file doesn't
 * exist (legacy pre-fingerprint store). Throws on a corrupt file —
 * a half-written JSON is a data-integrity issue, not a normal "no
 * fingerprint yet" case.
 */
export function readFingerprint(basePath: string): EmbeddingFingerprint | null {
    const fp = fingerprintPath(basePath);
    if (!fs.existsSync(fp)) return null;
    const raw = fs.readFileSync(fp, 'utf-8');
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        throw new Error(
            `[embeddingFingerprint] Corrupt fingerprint at ${fp}: ${(err as Error).message}. ` +
            `Delete the file to force legacy defaults, or restore from backup.`
        );
    }
    if (
        !parsed ||
        typeof parsed !== 'object' ||
        typeof (parsed as Record<string, unknown>).modelId !== 'string' ||
        typeof (parsed as Record<string, unknown>).dimension !== 'number' ||
        typeof (parsed as Record<string, unknown>).writtenAt !== 'string'
    ) {
        throw new Error(`[embeddingFingerprint] Malformed fingerprint at ${fp}: missing required fields.`);
    }
    const obj = parsed as Record<string, unknown>;
    return {
        modelId: obj['modelId'] as string,
        dimension: obj['dimension'] as number,
        writtenAt: obj['writtenAt'] as string,
        version: typeof obj['version'] === 'number' ? (obj['version'] as number) : FINGERPRINT_VERSION,
    };
}

/**
 * Read the fingerprint OR return the legacy defaults if missing. Use
 * this anywhere the caller wants "what's actually in the table right
 * now" rather than "did anyone write a fingerprint yet".
 */
export function readFingerprintOrLegacy(basePath: string): EmbeddingFingerprint {
    return readFingerprint(basePath) ?? {
        modelId: LEGACY_DEFAULT_MODEL_ID,
        dimension: LEGACY_DEFAULT_DIMENSION,
        writtenAt: '1970-01-01T00:00:00.000Z',
        version: FINGERPRINT_VERSION,
    };
}

/** Atomically write the fingerprint. Creates the parent directory if missing. */
export function writeFingerprint(
    basePath: string,
    opts: { modelId: string; dimension: number },
): EmbeddingFingerprint {
    const fp = fingerprintPath(basePath);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    const payload: EmbeddingFingerprint = {
        modelId: opts.modelId,
        dimension: opts.dimension,
        writtenAt: new Date().toISOString(),
        version: FINGERPRINT_VERSION,
    };
    // Atomic write: stage to a tmp file and rename. Avoids a half-written
    // JSON if the daemon is killed mid-write (LanceDB shares the dir).
    const tmp = `${fp}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, fp);
    return payload;
}

/**
 * Compatibility check. The "expected" side comes from the runtime
 * EmbeddingProvider (modelId + dimension); the "actual" side is read
 * from disk. Mismatch returns a structured result rather than throwing
 * so callers can decide between warn-and-continue (daemon boot) and
 * abort (the migration tool itself).
 */
export interface CompatibilityResult {
    matches: boolean;
    actual: EmbeddingFingerprint;
    expectedModelId: string;
    expectedDimension: number;
    /** Human-readable explanation; empty string when matches=true. */
    message: string;
}

export function checkCompatibility(
    basePath: string,
    expected: { modelId: string; dimension: number },
): CompatibilityResult {
    const actual = readFingerprintOrLegacy(basePath);
    const sameModel = actual.modelId === expected.modelId;
    const sameDim = actual.dimension === expected.dimension;
    if (sameModel && sameDim) {
        return { matches: true, actual, expectedModelId: expected.modelId, expectedDimension: expected.dimension, message: '' };
    }
    const lines: string[] = [];
    lines.push(`Embedding model fingerprint mismatch on ${basePath}:`);
    lines.push(`  on-disk: model="${actual.modelId}", dim=${actual.dimension}, writtenAt=${actual.writtenAt}`);
    lines.push(`  configured: model="${expected.modelId}", dim=${expected.dimension}`);
    if (!sameDim) {
        lines.push(`  Vector dimension differs — LanceDB will reject any write. Run:`);
        lines.push(`    lore migrate embedding-model --to "${expected.modelId}" --dim ${expected.dimension} --apply`);
    } else {
        lines.push(`  Same dimension, different model — vectors live in different spaces.`);
        lines.push(`  Retrieval quality is silently degraded until you re-embed:`);
        lines.push(`    lore migrate embedding-model --to "${expected.modelId}" --apply`);
    }
    return {
        matches: false,
        actual,
        expectedModelId: expected.modelId,
        expectedDimension: expected.dimension,
        message: lines.join('\n'),
    };
}

/**
 * Test-only: clear the fingerprint file. Not exported via index.ts;
 * imported directly by unit tests that need a clean fixture.
 */
export function _deleteFingerprintForTests(basePath: string): void {
    const fp = fingerprintPath(basePath);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
}

/** Re-exported so callers can show the path in messages without rebuilding it. */
export function getFingerprintPath(basePath: string): string {
    return fingerprintPath(basePath);
}
