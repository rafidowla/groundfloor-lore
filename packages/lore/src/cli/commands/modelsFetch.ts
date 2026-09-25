/**
 * modelsFetch.ts — `lore models fetch-rerank` (D8b, Lore 3.23; hardened D8d
 * — see $SP/SECURITY-D8.md F3/F4/F5).
 *
 * The ONLY code path in the whole rerank feature allowed to pass
 * `local_files_only:false` to Transformers.js — see
 * providers/localRerankProvider.ts's file header for the offline-enforcement
 * contract this deliberately breaks, on purpose, exactly once, on an
 * operator's explicit request. Every other rerank code path (the retrieve()
 * hot path via `rerankStage.ts` / `localRerankProvider.ts`) always passes
 * `local_files_only:true` and fails open if the model isn't already cached
 * here.
 *
 * Downloads the tokenizer + sequence-classification model for the
 * configured (or given) cross-encoder id into the same `<loreHome>/models`
 * cache `cli/commands/models.ts` (prune) and `localRerankProvider.ts`
 * (scoring) both read from — `cache_dir: loreHomePath('models')`, layout
 * `<cache_dir>/<modelId>/...`, identical to the scoring path so a fetch
 * here is immediately usable by a real `rerank:true` call afterward.
 *
 * D8d hardening (F4/F5): downloads into a `.staging-<rand>` dir first, and
 * for the DEFAULT model+dtype (`q8`) verifies every downloaded file's
 * sha256 against `rerankManifest.ts`'s pinned manifest before the download
 * is trusted. Only on success is the staging dir atomically renamed into
 * place and a `.complete` marker written — `rerankModelCached()` (D8d)
 * requires that marker, so a partial/failed/unverified download is never
 * mistaken for "ready to use". Directories are created `0700`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import { loreHomePath } from '../../config/loreHome.js';
import { DEFAULT_RERANK_MODEL, DEFAULT_RERANK_DTYPE } from '../../recall/rerankConfig.js';
import type { RerankDtype } from '../../providers/localRerankProvider.js';
import { validateRerankModelId } from '../../providers/rerankModelId.js';
import { DEFAULT_RERANK_REVISION, DEFAULT_RERANK_MANIFEST } from '../../providers/rerankManifest.js';

const VALID_DTYPES: readonly RerankDtype[] = ['fp32', 'fp16', 'q8', 'q4'];

/** N13 (3.23 final review): `--revision` is used verbatim as a Hugging Face
 *  `from_pretrained` `revision` option AND, in `flattenRevisionDir` below,
 *  as a raw path segment joined onto `stagedModelDir` — an unvalidated value
 *  like `../../..` or an absolute path would let an operator-supplied
 *  `--revision` walk outside the staging directory. Real git revisions
 *  (branch names, tags, full/short commit shas) are always plain
 *  `[A-Za-z0-9._-]`; reject anything else, including a bare `..` anywhere in
 *  the string even if the rest of the charset check would pass it (e.g.
 *  `a..b` — harmless as a path segment on its own, but rejected anyway to
 *  keep this a simple, conservative allowlist rather than a path-semantics
 *  parser). Length capped at 64 — comfortably longer than any real branch/
 *  tag/sha, short enough to rule out abuse. */
const VALID_REVISION_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** Exported for direct unit testing (test/n13-modelsfetch-revision-unit.ts) —
 *  the CLI entry point itself calls `process.exit()` on a bad revision, which
 *  isn't something a unit test can assert against directly. */
export function validateRevision(revision: string): boolean {
    return VALID_REVISION_RE.test(revision) && !revision.includes('..');
}

function usage(): string {
    return [
        'Usage: lore models fetch-rerank [--model <id>] [--dtype fp32|fp16|q8|q4] [--revision <rev>]',
        '',
        `  Downloads the local cross-encoder re-rank model (default: ${DEFAULT_RERANK_MODEL},`,
        `  dtype ${DEFAULT_RERANK_DTYPE}, pinned to revision ${DEFAULT_RERANK_REVISION})`,
        '  into the Lore model cache. This is the ONLY supported way to fetch it — the',
        '  retrieve() rerank stage never downloads on its own (local_files_only:true',
        "  always); without running this command first, rerank:true silently no-ops",
        "  with reason:'model_absent'.",
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

function fmtBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function listFilesWithSizes(dir: string): Array<{ relPath: string; sizeBytes: number }> {
    const out: Array<{ relPath: string; sizeBytes: number }> = [];
    const walk = (p: string, rel: string): void => {
        let st: fs.Stats;
        try { st = fs.lstatSync(p); } catch { return; }
        if (st.isSymbolicLink()) return; // never follow — F5
        if (st.isFile()) { out.push({ relPath: rel, sizeBytes: st.size }); return; }
        if (st.isDirectory()) {
            for (const name of fs.readdirSync(p)) walk(path.join(p, name), rel ? `${rel}/${name}` : name);
        }
    };
    walk(dir, '');
    return out;
}

function sha256File(p: string): string {
    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(p));
    return hash.digest('hex');
}

/** Verify every manifested file under `modelDir` matches its pinned sha256.
 *  Returns the first mismatching/missing relPath, or `null` if everything
 *  in the manifest matched (extra, non-manifested files are ignored). */
function verifyAgainstManifest(modelDir: string, manifest: Readonly<Record<string, string>>): string | null {
    for (const [relPath, expected] of Object.entries(manifest)) {
        const p = path.join(modelDir, relPath);
        let st: fs.Stats;
        try { st = fs.lstatSync(p); } catch { return relPath; }
        if (!st.isFile()) return relPath; // missing or a symlink — reject either way
        const actual = sha256File(p);
        if (actual !== expected) return relPath;
    }
    return null;
}

function rmQuiet(p: string): void {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best-effort cleanup only */ }
}

/** When `from_pretrained` is called with a `revision`, `@huggingface/transformers`
 *  writes files to `<cache_dir>/<modelId>/<revision>/...` instead of the flat
 *  `<cache_dir>/<modelId>/...` layout it uses with no revision pinned — the same
 *  flat layout `localRerankProvider.ts` (the runtime scoring path, which never
 *  passes `revision`) always reads from. Left uncorrected, `verifyAgainstManifest`
 *  looks in the flat dir, finds nothing, and reports a false integrity failure
 *  even when the download is byte-for-byte correct (confirmed by hand 2026-09-25:
 *  staged content under the nested `<revision>/` dir hashed identical to the
 *  pinned manifest). Since every default-model fetch now always pins a revision,
 *  this ran unconditionally and broke every default fetch until fixed here.
 *  Flattens the nested dir into `stagedModelDir` in place before verify/install. */
function flattenRevisionDir(stagedModelDir: string, revision: string | undefined): void {
    if (!revision) return; // no pin -> transformers.js already wrote the flat layout
    const nested = path.join(stagedModelDir, revision);
    let st: fs.Stats;
    try { st = fs.lstatSync(nested); } catch { return; } // nothing nested; already flat
    if (!st.isDirectory() || st.isSymbolicLink()) return; // unexpected shape — let verify report it
    for (const name of fs.readdirSync(nested)) {
        fs.renameSync(path.join(nested, name), path.join(stagedModelDir, name));
    }
    rmQuiet(nested);
}

/** `lore models fetch-rerank [--model <id>] [--dtype fp32|fp16|q8|q4] [--revision <rev>]` */
export async function fetchRerankCommand(args: string[]): Promise<void> {
    if (args.includes('--help') || args.includes('-h')) {
        console.log(usage());
        return;
    }

    const modelIdx = args.indexOf('--model');
    const modelId = modelIdx !== -1 && modelIdx + 1 < args.length ? args[modelIdx + 1]! : DEFAULT_RERANK_MODEL;
    if (!validateRerankModelId(modelId)) {
        console.error(`fetch-rerank: --model "${modelId}" is not a valid model id (expected "org/name", no "..", "--", "\\" or ":").`);
        process.exit(1);
    }

    const dtypeIdx = args.indexOf('--dtype');
    const dtypeRaw = dtypeIdx !== -1 && dtypeIdx + 1 < args.length ? args[dtypeIdx + 1]! : DEFAULT_RERANK_DTYPE;
    if (!VALID_DTYPES.includes(dtypeRaw as RerankDtype)) {
        console.error(`fetch-rerank: --dtype must be one of ${VALID_DTYPES.join(', ')} (got "${dtypeRaw}")`);
        console.error(usage());
        process.exit(1);
    }
    const dtype = dtypeRaw as RerankDtype;

    const isDefault = modelId === DEFAULT_RERANK_MODEL && dtype === DEFAULT_RERANK_DTYPE;
    const revisionIdx = args.indexOf('--revision');
    const revision = revisionIdx !== -1 && revisionIdx + 1 < args.length
        ? args[revisionIdx + 1]!
        : (isDefault ? DEFAULT_RERANK_REVISION : undefined);
    if (revision !== undefined && !validateRevision(revision)) {
        console.error(`fetch-rerank: --revision "${revision}" is not a valid revision (expected a branch/tag/commit-sha-shaped string, ${VALID_REVISION_RE.source}, no "..").`);
        process.exit(1);
    }

    const cacheDir = loreHomePath('models');
    fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(cacheDir, 0o700); } catch { /* best-effort on pre-existing dirs */ }

    const stagingRoot = path.join(cacheDir, `.staging-${crypto.randomBytes(6).toString('hex')}`);
    fs.mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });

    console.log('');
    console.log('Fetching local rerank model (online — local_files_only:false)');
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
        // Dynamic import, exactly like localRerankProvider.ts — importing
        // this whole CLI command must not pull in @huggingface/transformers
        // for callers who never invoke fetch-rerank.
        const transformers = await import('@huggingface/transformers');
        const { AutoTokenizer, AutoModelForSequenceClassification } = transformers as unknown as {
            AutoTokenizer: { from_pretrained(id: string, opts: Record<string, unknown>): Promise<unknown> };
            AutoModelForSequenceClassification: { from_pretrained(id: string, opts: Record<string, unknown>): Promise<{ dispose?: () => void }> };
        };

        const fromPretrainedOpts: Record<string, unknown> = { cache_dir: stagingRoot, local_files_only: false };
        if (revision) fromPretrainedOpts['revision'] = revision;

        console.log('  Downloading tokenizer...');
        await AutoTokenizer.from_pretrained(modelId, fromPretrainedOpts);

        console.log('  Downloading model weights...');
        const model = await AutoModelForSequenceClassification.from_pretrained(modelId, {
            ...fromPretrainedOpts,
            dtype,
            device: 'cpu',
        });
        try { model.dispose?.(); } catch { /* best-effort dispose only */ }
    } catch (err) {
        console.error('');
        console.error(`fetch-rerank: failed to download "${modelId}" (dtype ${dtype}): ${err instanceof Error ? err.message : String(err)}`);
        rmQuiet(stagingRoot);
        process.exit(1);
    }

    const stagedModelDir = path.join(stagingRoot, modelId);
    flattenRevisionDir(stagedModelDir, revision);

    if (isDefault) {
        const mismatch = verifyAgainstManifest(stagedModelDir, DEFAULT_RERANK_MANIFEST);
        if (mismatch) {
            console.error('');
            console.error(`fetch-rerank: integrity check FAILED for "${mismatch}" — downloaded content does not match the pinned manifest.`);
            console.error('Nothing was written to the model cache. This can mean the pinned revision');
            console.error('moved, the download was corrupted, or the upstream repo was compromised —');
            console.error('do not retry blindly; verify out-of-band before re-running.');
            rmQuiet(stagingRoot);
            process.exit(1);
        }
        console.log('  Integrity check passed (sha256 matches pinned manifest for all 4 files).');
    }

    // Atomic-ish placement (F5): swap out any prior directory for this
    // (modelId, and implicitly dtype — different dtypes share a modelId dir
    // but distinct onnx files) id, then rename the verified staging dir into
    // place. `.complete` is written only AFTER the rename, so a reader can
    // never observe a `.complete` marker next to a half-renamed tree.
    const finalModelDir = path.join(cacheDir, modelId);
    const orgDir = path.dirname(finalModelDir);
    fs.mkdirSync(orgDir, { recursive: true, mode: 0o700 });
    const priorBackup = fs.existsSync(finalModelDir) ? `${finalModelDir}.prev-${crypto.randomBytes(4).toString('hex')}` : undefined;
    if (priorBackup) fs.renameSync(finalModelDir, priorBackup);
    try {
        fs.renameSync(stagedModelDir, finalModelDir);
    } catch (err) {
        // Roll back so a failed swap never leaves the model missing.
        if (priorBackup) { try { fs.renameSync(priorBackup, finalModelDir); } catch { /* best-effort rollback */ } }
        rmQuiet(stagingRoot);
        console.error(`fetch-rerank: failed to install downloaded model: ${err instanceof Error ? err.message : String(err)}`);
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
        fetchedAt: new Date().toISOString(),
        fetchedBy: `lore models fetch-rerank (${os.hostname()})`,
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
    console.log(`Ready. Set LORE_RECALL_RERANK_MODEL="${modelId}" (and LORE_RECALL_RERANK_DTYPE="${dtype}" if not the default)`);
    console.log('or "lore workspaces set-rerank <name> on --model ' + modelId + '" to use it.');
}
