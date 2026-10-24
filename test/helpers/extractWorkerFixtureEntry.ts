/**
 * test/helpers/extractWorkerFixtureEntry.ts - a forked extractor child that misbehaves on demand, for
 * ingestion-extract-worker-unit.ts. The first bytes of the file choose the behaviour; anything else is a normal extraction.
 *
 *   CRASH                    exit hard (like a native add-on abort)
 *   CRASHONCE:<marker path>  crash the first time (creates the marker), extract normally afterwards
 *   HANG                     never answer
 *   HANGONCE:<marker path>   hang the first time, extract normally afterwards
 */
import * as fs from 'node:fs';
import { runExtractWorkerLoop } from '../../packages/lore/src/ingestion/worker/extractWorkerLoop.js';
import { extractCore } from '../../packages/lore/src/ingestion/worker/extractWorkerCore.js';

function once(marker: string): boolean {
    if (fs.existsSync(marker)) return false;
    fs.writeFileSync(marker, '1');
    return true;
}

runExtractWorkerLoop(async (deps, bytes, req) => {
    const head = bytes.subarray(0, 200).toString('latin1');
    if (head.startsWith('CRASHONCE:') && once(head.slice('CRASHONCE:'.length).split('\n')[0]!.trim())) process.exit(137);
    if (head.startsWith('CRASH') && !head.startsWith('CRASHONCE:')) process.exit(137);
    if (head.startsWith('HANGONCE:') && once(head.slice('HANGONCE:'.length).split('\n')[0]!.trim())) return new Promise(() => undefined);
    if (head.startsWith('HANG') && !head.startsWith('HANGONCE:')) return new Promise(() => undefined);
    return extractCore(deps, bytes, req.mimeType);
});
