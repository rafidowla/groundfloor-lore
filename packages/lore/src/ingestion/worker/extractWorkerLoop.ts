/**
 * ingestion/worker/extractWorkerLoop.ts - the message loop that runs inside the forked extractor child.
 *
 * The first message is `init` (vision + caps); the child answers `ready`. Each `extract` message is answered with
 * exactly one `result` or `error` carrying the same id. The child extracts one file at a time (the parent
 * serialises). If the parent goes away the IPC channel closes and the child exits, so it can never be orphaned.
 * `handler` is injectable so tests can run a fixture child that crashes or hangs on demand; production uses extractCore.
 */
import { OpenAiVisionEngine } from '../processors/localVision.js';
import type { ChildToParent, ParentToChild, WireExtractRequest, WorkerInit } from './extractWorkerProtocol.js';
import { classifyError, extractCore, makeCoreDeps, type ExtractCoreDeps } from './extractWorkerCore.js';

export type ChildHandler = (deps: ExtractCoreDeps, bytes: Buffer, req: WireExtractRequest) => ReturnType<typeof extractCore>;

const defaultHandler: ChildHandler = (deps, bytes, req) => extractCore(deps, bytes, req.mimeType);

export function runExtractWorkerLoop(handler: ChildHandler = defaultHandler): void {
    if (typeof process.send !== 'function') throw new Error('extract worker must be started with an IPC channel');
    let deps: ExtractCoreDeps | null = null;
    let recycleRssMb = 0;
    const send = (m: ChildToParent, cb?: () => void) => { process.send!(m, undefined, undefined, () => cb?.()); };

    const init = (m: WorkerInit) => {
        try {
            const vision = m.vision ? new OpenAiVisionEngine({ baseUrl: m.vision.baseUrl, model: m.vision.model, ...(m.vision.timeoutMs ? { timeoutMs: m.vision.timeoutMs } : {}) }) : null;
            deps = makeCoreDeps({ vision, visionMaxPages: m.vision?.maxPages ?? 25, maxFileBytes: m.maxFileBytes });
            recycleRssMb = m.recycleRssMb;
            send({ type: 'ready' });
        } catch (e) { send({ type: 'init-error', message: (e as Error).message }, () => process.exit(1)); }
    };

    const extract = async (m: WireExtractRequest) => {
        if (!deps) { send({ type: 'error', id: m.id, error: { message: 'worker not initialised', retryable: true } }); return; }
        let reply: ChildToParent;
        try { reply = { type: 'result', id: m.id, content: await handler(deps, Buffer.from(m.bytes), m) }; }
        catch (e) { reply = { type: 'error', id: m.id, error: classifyError(e) }; }
        const recycle = recycleRssMb > 0 && process.memoryUsage().rss > recycleRssMb * 1024 * 1024;
        send(reply, recycle ? () => process.exit(0) : undefined);
    };

    process.on('message', (m: ParentToChild) => {
        if (!m || typeof m !== 'object') return;
        if (m.type === 'init') init(m);
        else if (m.type === 'extract') void extract(m);
        else if (m.type === 'shutdown') process.exit(0);
    });
    process.on('disconnect', () => process.exit(0));
}
