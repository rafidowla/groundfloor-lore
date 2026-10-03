/**
 * modelsFetchEmbedding.ts — `lore models fetch-embedding` (D9, Lore 3.24).
 *
 * The embedding-side sibling of `modelsFetch.ts`'s `fetch-rerank`: the only
 * code path allowed to pass `local_files_only:false` for the embedding
 * model. Unlike rerank (which fails open and silently no-ops until fetched),
 * `localEmbeddingProvider.ts` resolves and downloads the model itself on
 * first use via `providers/modelCache.ts`'s `resolveEmbedModelDir()` — so
 * running this command ahead of time is a warm-cache convenience, never a
 * prerequisite the way `fetch-rerank` is.
 *
 * Deliberately thin: staging/verify/install/marker mechanics and the actual
 * network call (`defaultDownloadModel`) all live in `providers/modelCache.ts`
 * and are reused here rather than duplicated, so this file only owns CLI
 * argument parsing and console output.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import { loreHomePath } from '../../config/loreHome.js';
import { DEFAULT_LOCAL_MODEL_ID, type ModelDtype } from '../../providers/localEmbeddingProvider.js';
import { validateRerankModelId as validateEmbedModelId } from '../../providers/rerankModelId.js';
import { validateRevision, VALID_REVISION_SOURCE } from './modelsFetch.js';
import {
    DEFAULT_EMBED_MANIFEST,
    DEFAULT_EMBED_MANIFEST_DTYPE,
    DEFAULT_EMBED_MODEL_ID,
    DEFAULT_EMBED_REVISION,
} from '../../providers/embedManifest.js';
import {
    defaultDownloadModel,
    flattenRevisionDir,
    fmtBytes,
    listFilesWithSizes,
    modelsOfflineFromEnv,
    rmQuiet,
    verifyAgainstManifest,
} from '../../providers/modelCache.js';

const VALID_DTYPES: readonly ModelDtype[] = ['fp32', 'fp16', 'q8', 'q4'];

function usage(): string {
    return [
        'Usage: lore models fetch-embedding [--model <id>] [--dtype fp32|fp16|q8|q4] [--revision <rev>]',
        '',
        `  Downloads the local embedding model (default: ${DEFAULT_EMBED_MODEL_ID},`,
        `  dtype ${DEFAULT_EMBED_MANIFEST_DTYPE}, pinned to revision ${DEFAULT_EMBED_REVISION})`,
        '  into the shared Lore model cache ahead of time. This is a warm-cache',
        '  convenience, not a prerequisite — embedQuery/embedDocument resolve and',
        '  download the model themselves on first use via the same shared cache',
        '  (providers/modelCache.ts), trying a local legacy transformers.js cache',
        '  before ever touching the network.',
        '',
        '  For the DEFAULT model+dtype, every downloaded file is verified against a',
        '  pinned sha256 manifest before it is trusted — a mismatch aborts the fetch',
        '  with nothing written into the cache. A non-default --model/--dtype has no',
        '  manifest coverage (integrity is only guaranteed for the default); pass',
        '  --revision to pin it to a specific commit anyway (recommended).',
        '',
        '  Requires network access. Re-running is safe (idempotent) — an already-',
        '  verified model is simply re-downloaded and re-verified.',
    ].join('\n');
}

/** `lore models fetch-embedding [--model <id>] [--dtype fp32|fp16|q8|q4] [--revision <rev>]` */
export async function fetchEmbeddingCommand(args: string[]): Promise<void> {
    if (args.includes('--help') || args.includes('-h')) {
        console.log(usage());
        return;
    }

    const modelIdx = args.indexOf('--model');
    const modelId = modelIdx !== -1 && modelIdx + 1 < args.length ? args[modelIdx + 1]! : DEFAULT_LOCAL_MODEL_ID;
    if (!validateEmbedModelId(modelId)) {
        console.error(`fetch-embedding: --model "${modelId}" is not a valid model id (expected "org/name", no "..", "--", "\\" or ":").`);
        process.exit(1);
    }

    const dtypeIdx = args.indexOf('--dtype');
    const dtypeRaw = dtypeIdx !== -1 && dtypeIdx + 1 < args.length ? args[dtypeIdx + 1]! : DEFAULT_EMBED_MANIFEST_DTYPE;
    if (!VALID_DTYPES.includes(dtypeRaw as ModelDtype)) {
        console.error(`fetch-embedding: --dtype must be one of ${VALID_DTYPES.join(', ')} (got "${dtypeRaw}")`);
        console.error(usage());
        process.exit(1);
    }
    const dtype = dtypeRaw as ModelDtype;

    const isDefault = modelId === DEFAULT_EMBED_MODEL_ID && dtype === DEFAULT_EMBED_MANIFEST_DTYPE;
    const revisionIdx = args.indexOf('--revision');
    const revision = revisionIdx !== -1 && revisionIdx + 1 < args.length
        ? args[revisionIdx + 1]!
        : (isDefault ? DEFAULT_EMBED_REVISION : undefined);
    if (revision !== undefined && !validateRevision(revision)) {
        console.error(`fetch-embedding: --revision "${revision}" is not a valid revision (expected a branch/tag/commit-sha-shaped string, ${VALID_REVISION_SOURCE}, no "..").`);
        process.exit(1);
    }

    const cacheDir = loreHomePath('models');
    fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(cacheDir, 0o700); } catch { /* best-effort on pre-existing dirs */ }

    const stagingRoot = path.join(cacheDir, `.staging-${crypto.randomBytes(6).toString('hex')}`);
    fs.mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });

    console.log('');
    console.log('Fetching local embedding model (online — local_files_only:false)');
    if (modelsOfflineFromEnv()) console.log('  NOTE: LORE_MODELS_OFFLINE is set; it only blocks implicit downloads — this explicit fetch still downloads.');
    console.log(`  Model:     ${modelId}`);
    console.log(`  Dtype:     ${dtype}`);
    console.log(`  Revision:  ${revision ?? 'main (unpinned — pass --revision to pin)'}`);
    console.log(`  Cache:     ${cacheDir}`);
    if (!isDefault) {
        console.log('  NOTE: non-default model/dtype — no sha256 manifest coverage; integrity');
        console.log('        is only guaranteed for the default model at the default dtype.');
    }
    console.log('');

    const startedAt = Date.now();
    try {
        console.log('  Downloading tokenizer + model weights...');
        await defaultDownloadModel({ modelId, dtype, stagingDir: stagingRoot, revision });
    } catch (err) {
        console.error('');
        console.error(`fetch-embedding: failed to download "${modelId}" (dtype ${dtype}): ${err instanceof Error ? err.message : String(err)}`);
        rmQuiet(stagingRoot);
        process.exit(1);
    }

    const stagedModelDir = path.join(stagingRoot, modelId);
    flattenRevisionDir(stagedModelDir, revision);

    if (isDefault) {
        const mismatch = verifyAgainstManifest(stagedModelDir, DEFAULT_EMBED_MANIFEST);
        if (mismatch) {
            console.error('');
            console.error(`fetch-embedding: integrity check FAILED for "${mismatch}" — downloaded content does not match the pinned manifest.`);
            console.error('Nothing was written to the model cache. This can mean the pinned revision');
            console.error('moved, the download was corrupted, or the upstream repo was compromised —');
            console.error('do not retry blindly; verify out-of-band before re-running.');
            rmQuiet(stagingRoot);
            process.exit(1);
        }
        console.log('  Integrity check passed (sha256 matches pinned manifest for all 4 files).');
    }

    // Atomic-ish placement, identical discipline to fetch-rerank: `.complete`
    // is written only AFTER the rename, so a reader can never observe it
    // next to a half-renamed tree.
    const finalModelDir = path.join(cacheDir, modelId);
    const orgDir = path.dirname(finalModelDir);
    fs.mkdirSync(orgDir, { recursive: true, mode: 0o700 });
    const priorBackup = fs.existsSync(finalModelDir) ? `${finalModelDir}.prev-${crypto.randomBytes(4).toString('hex')}` : undefined;
    if (priorBackup) fs.renameSync(finalModelDir, priorBackup);
    try {
        fs.renameSync(stagedModelDir, finalModelDir);
    } catch (err) {
        if (priorBackup) { try { fs.renameSync(priorBackup, finalModelDir); } catch { /* best-effort rollback */ } }
        rmQuiet(stagingRoot);
        console.error(`fetch-embedding: failed to install downloaded model: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    }
    if (priorBackup) rmQuiet(priorBackup);
    try { fs.chmodSync(finalModelDir, 0o700); } catch { /* best-effort */ }
    rmQuiet(stagingRoot);

    const marker = {
        modelId,
        dtype,
        revision: revision ?? null,
        verifiedManifest: isDefault,
        source: 'download',
        fetchedAt: new Date().toISOString(),
        fetchedBy: `lore models fetch-embedding (${os.hostname()})`,
    };
    fs.writeFileSync(path.join(finalModelDir, '.complete'), JSON.stringify(marker, null, 2) + '\n', { mode: 0o600 });

    const elapsedMs = Date.now() - startedAt;
    const files = listFilesWithSizes(finalModelDir).filter((f) => f.relPath !== '.complete').sort((a, b) => a.relPath.localeCompare(b.relPath));
    const totalBytes = files.reduce((a, b) => a + b.sizeBytes, 0);

    console.log('');
    console.log(`Done in ${(elapsedMs / 1000).toFixed(1)}s. ${files.length} file(s), ${fmtBytes(totalBytes)} total:`);
    for (const f of files) {
        console.log(`  ${f.relPath.padEnd(40)} ${fmtBytes(f.sizeBytes)}`);
    }
    console.log('');
    console.log(`Ready. Set LORE_LOCAL_EMBEDDING_MODEL="${modelId}" (and LORE_LOCAL_EMBEDDING_DTYPE="${dtype}" if not the default) to use it.`);
}
