#!/usr/bin/env tsx
/**
 * embed-idle-unload-child.ts — child process for
 * test/embed-pipeline-idle-unload-unit.ts.
 *
 * `LORE_EMBED_IDLE_UNLOAD_MS` is read ONCE at module-eval time in
 * localEmbeddingProvider.ts (a plain module-scoped `const`), so a single
 * process can only ever observe one value for it. Each scenario below
 * therefore runs in its own freshly spawned child with the env var set
 * before this file (and therefore the provider module) is ever imported —
 * mirroring the existing subprocess pattern in
 * test/embedded-abandoned-dispose-exit-unit.ts / test/helpers/embedded-teardown-child.ts.
 *
 * Argv: <scenario>, where scenario is one of:
 *   - 'unload-and-reload'   — embed, confirm cache=1, wait past the idle
 *                             window, confirm cache=0, embed again and
 *                             confirm the reloaded pipeline produces the
 *                             SAME vector as before release.
 *   - 'inflight-guard'      — start a large batch embed and CONCURRENTLY
 *                             poll the cache; assert it never drops to 0
 *                             while the batch is still running, and that
 *                             the batch itself completes successfully.
 *   - 'default-never-unload'— no env var set; embed, wait past what would
 *                             be a very short idle window on the OTHER
 *                             scenarios, confirm the cache is STILL warm
 *                             (today's behavior, unchanged).
 *   - 'explicit-release'    — call releaseLocalEmbeddingPipeline() directly
 *                             (no sweeper involved) and confirm it reports
 *                             released=true and the cache drops to 0, then
 *                             confirm a reload still works.
 *
 * Reports ONE JSON line to stdout: `RESULT: {...}`. The parent parses that
 * line; everything else on stdout/stderr is diagnostic only.
 */

const scenario = process.argv[2];
const VALID = ['unload-and-reload', 'inflight-guard', 'default-never-unload', 'explicit-release'];
if (!scenario || !VALID.includes(scenario)) {
    console.error(`usage: embed-idle-unload-child.ts <${VALID.join('|')}>`);
    throw new Error('bad arguments');
}

const {
    LocalEmbeddingProvider,
    releaseLocalEmbeddingPipeline,
    _pipelineCacheSizeForTests,
} = await import('../../packages/lore/src/providers/localEmbeddingProvider.js');

function sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => { setTimeout(resolve, ms); });
}

function report(result: Record<string, unknown>): void {
    console.log(`RESULT: ${JSON.stringify(result)}`);
}

const SAMPLE_TEXT = 'the quick brown fox jumps over the lazy dog, repeatedly, for embedding purposes';

if (scenario === 'unload-and-reload') {
    const provider = new LocalEmbeddingProvider();
    const vecBefore = await provider.embedDocument(SAMPLE_TEXT);
    const cacheAfterEmbed = _pipelineCacheSizeForTests();

    // LORE_EMBED_IDLE_UNLOAD_MS is set by the parent before spawn (small,
    // e.g. 1000ms). Wait comfortably past it — the sweeper's own check
    // interval scales down for small windows (see localEmbeddingProvider.ts),
    // so this margin covers at least a couple of sweep ticks.
    await sleep(2500);
    const cacheAfterWait = _pipelineCacheSizeForTests();

    const vecAfter = await provider.embedDocument(SAMPLE_TEXT);
    const cacheAfterReload = _pipelineCacheSizeForTests();

    report({
        cacheAfterEmbed,
        cacheAfterWait,
        cacheAfterReload,
        vecLenBefore: vecBefore.length,
        vecLenAfter: vecAfter.length,
        maxAbsDiff: Math.max(...vecBefore.map((v, i) => Math.abs(v - vecAfter[i]))),
    });
} else if (scenario === 'inflight-guard') {
    const provider = new LocalEmbeddingProvider();
    // Warm the pipeline first so the batch below is pure inference time,
    // not cold-load time, and so we have a stable cache entry to poll.
    await provider.embedDocument('warm up');

    // A biggish batch so the forward passes (EMBED_FORWARD_BATCH=32 chunks
    // per ONNX call) take long enough to overlap several sweep ticks even
    // at the small idle window the parent configures.
    const texts = Array.from({ length: 120 }, (_, i) => `inflight guard sample document number ${i}`);
    let sawZeroWhileRunning = false;
    let batchDone = false;
    const poller = (async () => {
        while (!batchDone) {
            if (_pipelineCacheSizeForTests() === 0) sawZeroWhileRunning = true;
            await sleep(50);
        }
    })();
    const vectors = await provider.embedDocumentBatch(texts);
    batchDone = true;
    await poller;

    report({
        sawZeroWhileRunning,
        vectorCount: vectors.length,
        allSameLength: vectors.every((v) => v.length === vectors[0].length),
        cacheAfterBatch: _pipelineCacheSizeForTests(),
    });
} else if (scenario === 'default-never-unload') {
    const provider = new LocalEmbeddingProvider();
    await provider.embedDocument(SAMPLE_TEXT);
    const cacheAfterEmbed = _pipelineCacheSizeForTests();
    // Wait longer than the tiny windows the other scenarios use, to prove
    // the default (no env var => 0 => sweeper never arms) really never
    // unloads rather than just "hasn't gotten around to it yet".
    await sleep(3000);
    const cacheAfterWait = _pipelineCacheSizeForTests();
    report({ cacheAfterEmbed, cacheAfterWait });
} else if (scenario === 'explicit-release') {
    const provider = new LocalEmbeddingProvider();
    const vecBefore = await provider.embedDocument(SAMPLE_TEXT);
    const cacheAfterEmbed = _pipelineCacheSizeForTests();
    const released = releaseLocalEmbeddingPipeline();
    const cacheAfterRelease = _pipelineCacheSizeForTests();
    const vecAfter = await provider.embedDocument(SAMPLE_TEXT);
    const cacheAfterReload = _pipelineCacheSizeForTests();
    report({
        cacheAfterEmbed,
        released,
        cacheAfterRelease,
        cacheAfterReload,
        maxAbsDiff: Math.max(...vecBefore.map((v, i) => Math.abs(v - vecAfter[i]))),
    });
}
