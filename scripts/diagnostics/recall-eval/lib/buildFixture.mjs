/**
 * buildFixture.mjs — builds (or reuses a cached) synthetic Lore workspace
 * for the recall-eval harness.
 *
 * Fixture identity is (engine pair, code-row count, embedder mode,
 * piece-vectors on/off — D7c, 3.23). A build is cached under a scratch
 * directory keyed by those four so repeat runs with the same shape are
 * fast. Never copies any real workspace — every fixture is generated fresh
 * from lib/corpus.mjs into a fresh data dir.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

import { buildCorpus, WORKSPACE, ECOSYSTEM, FIXTURE_SEED } from './corpus.mjs';
import { FakeEmbeddingProvider } from './fakeEmbeddingProvider.mjs';
import { checkLocalEmbedderCached } from './embedCacheCheck.mjs';

const CORPUS_VERSION = 'v1'; // bump if anchors.mjs/corpus.mjs content changes shape

export function fixtureCacheKey({ graphEngine, vectorEngine, codeRowCount, embedder, pieceVectors = false }) {
    // D7c (3.23) — pieceVectors is a fixture-shape input, not just a query-time
    // toggle: when it's on, every bulkIngest() below runs against a store whose
    // pieceVectorsIntent is true, so each row's piece rows (title + windows) are
    // built incrementally as part of the write path (verbatimStore.ts's store()/
    // bulk paths call pieceIndex.upsertForRows()) -- an "off" fixture has no piece
    // table/sidecar at all. Folding it into the cache key means `--piece-vectors
    // on` a `--piece-vectors off` run for the same (engine, rows, embedder) never
    // silently reuse each other's build (see DESIGN-3.23.md §7.1).
    const raw = `${FIXTURE_SEED}|${CORPUS_VERSION}|${graphEngine}|${vectorEngine}|${codeRowCount}|${embedder}|pv${pieceVectors ? 1 : 0}`;
    return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

function scratchRoot() {
    // Prefer the session scratchpad when present (per harness convention),
    // else a plain mkdtemp under the OS tmp dir.
    const envRoot = process.env.RECALL_EVAL_SCRATCH;
    if (envRoot) {
        fs.mkdirSync(envRoot, { recursive: true });
        return envRoot;
    }
    return fs.mkdtempSync(path.join(os.tmpdir(), 'recall-eval-'));
}

/**
 * Ensures a built fixture exists on disk for the given shape and returns its
 * dataDir (does NOT open a Lore instance — caller does that so it controls
 * lifecycle/dispose). `force` rebuilds even if a cache dir is present.
 */
export async function ensureFixture(opts) {
    const {
        graphEngine = 'sqlite',
        vectorEngine = 'sqlite',
        codeRowCount = 10000,
        embedder = 'real', // 'real' | 'fake'
        pieceVectors = false, // D7c — see fixtureCacheKey's doc
        cacheRoot,
        force = false,
        log = () => {},
    } = opts;

    if (embedder === 'real') {
        const check = checkLocalEmbedderCached();
        if (!check.cached) {
            throw Object.assign(
                new Error(`Local embedder model not cached at ${check.dir ?? '(transformers package not found)'} — refusing to download. Re-run with --embedder fake, or pre-cache the model.`),
                { code: 'embedder_not_cached', cacheDir: check.dir },
            );
        }
    }

    const root = cacheRoot ?? scratchRoot();
    const key = fixtureCacheKey({ graphEngine, vectorEngine, codeRowCount, embedder, pieceVectors });
    const dataDir = path.join(root, `fixture-${key}`);
    const markerPath = path.join(dataDir, '.fixture-complete.json');

    if (!force && fs.existsSync(markerPath)) {
        const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
        log(`[fixture] reusing cached build at ${dataDir} (built ${marker.builtAt})`);
        return { dataDir, reused: true, counts: marker.counts, graphEngine, vectorEngine, embedder, codeRowCount, pieceVectors };
    }

    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.mkdirSync(dataDir, { recursive: true });

    const t0 = Date.now();
    const prevGraphEnv = process.env.LORE_DEFAULT_GRAPH_ENGINE;
    const prevVectorEnv = process.env.LORE_DEFAULT_VECTOR_ENGINE;
    process.env.LORE_DEFAULT_GRAPH_ENGINE = graphEngine;
    process.env.LORE_DEFAULT_VECTOR_ENGINE = vectorEngine;

    try {
        const { createLore } = await import('../../../../packages/lore/src/index.js');
        const createOpts = { deploymentMode: 'embedded', dataDir, ownsProcess: false };
        if (embedder === 'fake') createOpts.embeddingProvider = new FakeEmbeddingProvider();
        // D7c — this dataDir is never workspace-registered (raw path, no name),
        // so openWorkspaceVerbatim's funnel takes the `hostDefault === true`
        // branch straight off this option (resolveHostPieceVectorsDefault(
        // createOpts.pieceVectors) with no per-workspace override to consult).
        // Every bulkIngest() call below then runs against a store whose
        // pieceVectorsIntent is already true, so piece rows are built
        // incrementally on the write path -- no separate migration step needed
        // for a fresh fixture build.
        if (pieceVectors) createOpts.pieceVectors = true;
        const lore = await createLore(createOpts);

        const corpus = buildCorpus({ codeRowCount });
        log(`[fixture] corpus built: ${JSON.stringify(corpus.counts)}`);

        const allNodes = [
            ...corpus.knowledgeNodes.map((n) => toBulkArg(n, corpus)),
            ...corpus.notes.map((n) => toBulkArg(n, corpus)),
        ];
        // Knowledge + notes first, synchronously embedded, so recall quality
        // is not affected by write ordering.
        const kResult = await lore.bulkIngest(allNodes, { embed: 'sync', autolink: false });
        const kFailed = kResult.results.filter((r) => !r.ok);
        if (kFailed.length) log(`[fixture] WARNING: ${kFailed.length} knowledge/note writes failed: ${JSON.stringify(kFailed.slice(0, 3))}`);

        // Code rows in chunks (large count) — still sync-embedded so the
        // fixture is fully queryable when this returns.
        const CHUNK = 2000;
        for (let i = 0; i < corpus.codeRows.length; i += CHUNK) {
            const chunk = corpus.codeRows.slice(i, i + CHUNK).map((n) => toBulkArg(n, corpus));
            const r = await lore.bulkIngest(chunk, { embed: 'sync', autolink: false });
            const failed = r.results.filter((x) => !x.ok);
            if (failed.length) log(`[fixture] WARNING: ${failed.length} code-row writes failed in chunk starting ${i}`);
            if (i % (CHUNK * 5) === 0) log(`[fixture] code rows ingested: ${Math.min(i + CHUNK, corpus.codeRows.length)}/${corpus.codeRows.length}`);
        }

        // Hub-node edges (D4 context) via the graph handle.
        const registry = lore._daemon.getGraphRegistry?.();
        const graph = registry ? await registry.getGraphHandle(corpus.workspace) : undefined;
        let edgesWritten = 0;
        if (graph?.addEdge) {
            for (const edge of corpus.edges) {
                try {
                    await graph.addEdge(edge);
                    edgesWritten++;
                } catch (e) {
                    log(`[fixture] WARNING: edge write failed ${edge.sourceId}->${edge.targetId}: ${e.message}`);
                }
            }
        } else {
            log('[fixture] WARNING: no graph handle available — hub edges NOT written (D4 context will be absent from this fixture)');
        }

        await lore.dispose('fixture-build-complete');

        const counts = { ...corpus.counts, edgesWritten };
        fs.writeFileSync(markerPath, JSON.stringify({
            builtAt: new Date().toISOString(),
            durationMs: Date.now() - t0,
            graphEngine, vectorEngine, embedder, codeRowCount, pieceVectors,
            counts,
        }, null, 2));
        log(`[fixture] build complete in ${Date.now() - t0}ms — ${JSON.stringify(counts)}`);

        return { dataDir, reused: false, counts, graphEngine, vectorEngine, embedder, codeRowCount, pieceVectors, durationMs: Date.now() - t0 };
    } finally {
        if (prevGraphEnv === undefined) delete process.env.LORE_DEFAULT_GRAPH_ENGINE; else process.env.LORE_DEFAULT_GRAPH_ENGINE = prevGraphEnv;
        if (prevVectorEnv === undefined) delete process.env.LORE_DEFAULT_VECTOR_ENGINE; else process.env.LORE_DEFAULT_VECTOR_ENGINE = prevVectorEnv;
    }
}

function toBulkArg(node, corpus) {
    const { id, ...rest } = node;
    return {
        id,
        workspace: corpus.workspace,
        ecosystem: corpus.ecosystem,
        nodeData: { id, ...rest },
    };
}

export { WORKSPACE, ECOSYSTEM };
