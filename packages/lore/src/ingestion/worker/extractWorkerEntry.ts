/**
 * ingestion/worker/extractWorkerEntry.ts - entry point of the forked extractor child. Forked by
 * ExtractWorkerClient; never imported by the host, so its heavy extractor dependencies load only in the child.
 */
import { runExtractWorkerLoop } from './extractWorkerLoop.js';

runExtractWorkerLoop();
