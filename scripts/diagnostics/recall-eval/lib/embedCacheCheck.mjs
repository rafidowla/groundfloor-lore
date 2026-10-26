/**
 * embedCacheCheck.mjs — check whether Lore's default local ONNX embedding
 * model (Xenova/multilingual-e5-small) is already cached on this machine,
 * WITHOUT triggering a download. @huggingface/transformers (the JS runtime
 * Lore's LocalEmbeddingProvider uses) caches under
 * <transformers-package-dir>/.cache/Xenova/<model>/ by default.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const MODEL_ID = 'Xenova/multilingual-e5-small';

export function findTransformersCacheDir() {
    const require = createRequire(import.meta.url);
    // NOTE: @huggingface/transformers declares an "exports" map that does
    // NOT list "./package.json" as a subpath, so
    // require.resolve('@huggingface/transformers/package.json') throws
    // ERR_PACKAGE_PATH_NOT_EXPORTED (Node enforces exports maps strictly,
    // blocking arbitrary subpaths including package.json itself). Resolve
    // the package's actual entry point instead and walk up to the package
    // root by locating the nearest package.json on disk.
    let entryPath;
    try {
        entryPath = require.resolve('@huggingface/transformers');
    } catch {
        return null;
    }
    let dir = path.dirname(entryPath);
    for (let i = 0; i < 8; i++) {
        if (fs.existsSync(path.join(dir, 'package.json'))) {
            try {
                const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
                if (pkg.name === '@huggingface/transformers') {
                    return path.join(dir, '.cache', MODEL_ID);
                }
            } catch {
                // not the right package.json (or unreadable) — keep walking up
            }
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

/**
 * Lore's own provider loads the model from `$LORE_HOME/models/<id>` (with a
 * `.complete` marker) when LORE_HOME is set -- this is where a run with an
 * isolated LORE_HOME (copied model, offline) finds it. Read-only check.
 */
export function findLoreHomeModelDir() {
    const home = process.env.LORE_HOME;
    if (!home) return null;
    const dir = path.join(home, 'models', MODEL_ID);
    return fs.existsSync(path.join(dir, '.complete')) ? dir : null;
}

/** Returns { cached: boolean, dir: string|null, files: string[] } without downloading anything. */
export function checkLocalEmbedderCached() {
    const loreHomeDir = findLoreHomeModelDir();
    if (loreHomeDir) {
        const files = fs.readdirSync(loreHomeDir, { recursive: true }).filter((f) => typeof f === 'string');
        if (files.some((f) => f.includes('tokenizer.json')) && files.some((f) => f.endsWith('.onnx'))) {
            return { cached: true, dir: loreHomeDir, files };
        }
    }
    const dir = findTransformersCacheDir();
    if (!dir || !fs.existsSync(dir)) return { cached: false, dir, files: [] };
    const files = fs.readdirSync(dir, { recursive: true }).filter((f) => typeof f === 'string');
    // Require at minimum a tokenizer + a quantized onnx weight file present.
    const hasTokenizer = files.some((f) => f.includes('tokenizer.json'));
    const hasOnnx = files.some((f) => f.endsWith('.onnx'));
    return { cached: hasTokenizer && hasOnnx, dir, files };
}
