/**
 * rerank-model-fixture.ts — Test-only: put the real default rerank model
 * (`DEFAULT_RERANK_MODEL` / `DEFAULT_RERANK_DTYPE`) into a temp LORE_HOME's
 * `models/` cache, so a test can exercise real rerank inference.
 *
 * Two sources, in order:
 *   1. `LORE_TEST_RERANK_MODEL_DIR` — a local directory holding the model's
 *      files (i.e. the `<cache>/Xenova/ms-marco-MiniLM-L-6-v2` directory of a
 *      previous `lore models fetch-rerank`). Copied (copy-on-write where the
 *      filesystem supports it; the source is never modified), then marked
 *      `.complete`. Offline and fast — use it for repeated local runs.
 *   2. Otherwise `lore models fetch-rerank` into the temp home — the same
 *      manifest-verified path `test/model-server-rerank-parity-unit.ts` uses.
 *      Needs network on first use.
 *
 * Never skips: a missing directory or a failed fetch fails the test loudly.
 * Never touches the real `~/.groundfloor` — fetching there would turn rerank
 * on for every local host on the machine.
 *
 * Import in tests:
 *   import { installRerankModel } from './helpers/rerank-model-fixture.js';
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_RERANK_MODEL } from '../../packages/lore/src/recall/rerankConfig.js';

export const RERANK_MODEL_DIR_ENV = 'LORE_TEST_RERANK_MODEL_DIR';

/** Installs the default rerank model into `<loreHome>/models` and returns
 *  that cache dir. */
export async function installRerankModel(loreHome: string): Promise<string> {
    const cacheDir = path.join(loreHome, 'models');
    const src = process.env[RERANK_MODEL_DIR_ENV];
    if (src) {
        if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
            throw new Error(`${RERANK_MODEL_DIR_ENV}=${src} is not a directory — point it at a fetched <cache>/${DEFAULT_RERANK_MODEL} dir, or unset it to fetch`);
        }
        const dest = path.join(cacheDir, ...DEFAULT_RERANK_MODEL.split('/'));
        fs.mkdirSync(dest, { recursive: true });
        fs.cpSync(src, dest, { recursive: true });
        fs.writeFileSync(path.join(dest, '.complete'), '');
        return cacheDir;
    }
    // fetchRerankCommand resolves its target through LORE_HOME.
    const prev = process.env.LORE_HOME;
    process.env.LORE_HOME = loreHome;
    try {
        const { fetchRerankCommand } = await import('../../packages/lore/src/cli/commands/modelsFetch.js');
        await fetchRerankCommand([]);
    } finally {
        if (prev === undefined) delete process.env.LORE_HOME;
        else process.env.LORE_HOME = prev;
    }
    return cacheDir;
}
