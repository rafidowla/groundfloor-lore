/**
 * rerankModelId.ts — D8d (Lore 3.23 security hardening): shared model-id
 * validation + realpath containment for the local cross-encoder re-rank
 * feature. See $SP/SECURITY-D8.md F3.
 *
 * `validateRerankModelId` is the single source of truth for "is this a
 * plausible HF-style `org/name` id" — used at every entry point that
 * accepts an operator-supplied model id: `rerankConfig.ts` (env + workspace
 * read), `setWorkspaceRecallRerank` (write), `modelsFetch.ts` (--model),
 * `localRerankProvider.ts` (defense-in-depth before ever touching the
 * filesystem or transformers).
 *
 * `resolveModelDirSafe` is the containment check: even a syntactically
 * valid id must resolve to a real, non-symlinked directory that stays
 * under `cacheDir` after `fs.realpathSync` — this is what stops a
 * validated-but-crafted id (or a symlink planted inside the cache dir)
 * from escaping `<loreHome>/models`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * HF-style `org/name` repo id. Deliberately stricter than upstream's own
 * `REPO_ID_REGEX` (see hub/constants.js): requires exactly one `/`,
 * alphanumeric-start segments, no `..`, no `--`, no leading `/`, no
 * backslash, no colon (rules out `C:\...` / UNC-style escapes on a host
 * that might run this on a non-POSIX fs).
 */
const MODEL_ID_RE = /^[A-Za-z0-9][\w.-]{0,95}\/[A-Za-z0-9][\w.-]{0,95}$/;

export function validateRerankModelId(id: unknown): id is string {
    if (typeof id !== 'string' || id.length === 0) return false;
    if (!MODEL_ID_RE.test(id)) return false;
    if (id.includes('..') || id.includes('--')) return false;
    if (id.includes('\\') || id.includes(':')) return false;
    return true;
}

/**
 * Validate `modelId` and resolve `<cacheDir>/<modelId>` as an absolute,
 * realpath-checked directory that must still live under `realpath(cacheDir)`.
 * Returns `undefined` on any failure (invalid id, cacheDir or modelDir
 * doesn't exist yet, or the resolved path escapes cacheDir) — callers treat
 * that as "not cached" / "not usable", never as a thrown error, since this
 * runs on the retrieve() hot path and must fail open.
 */
export function resolveModelDirSafe(cacheDir: string, modelId: string): string | undefined {
    if (!validateRerankModelId(modelId)) return undefined;
    const joined = path.join(cacheDir, modelId);
    let realCacheDir: string;
    let realModelDir: string;
    try {
        realCacheDir = fs.realpathSync(cacheDir);
        realModelDir = fs.realpathSync(joined);
    } catch {
        return undefined;
    }
    const prefix = realCacheDir.endsWith(path.sep) ? realCacheDir : realCacheDir + path.sep;
    if (realModelDir !== realCacheDir && !realModelDir.startsWith(prefix)) return undefined;
    return realModelDir;
}
