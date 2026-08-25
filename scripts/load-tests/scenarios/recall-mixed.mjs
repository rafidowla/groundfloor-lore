/**
 * scenarios/recall-mixed.mjs — Sprint C4 recall ranking workload.
 *
 * Hits POST /api/recall with a rotating pool of queries. Exercises
 * Sprint R ranking + embedding cache. Per-query latency recorded.
 */
import { performance } from 'node:perf_hooks';

const QUERIES = [
    'authentication',
    'recall ranking',
    'workspace quota',
    'embedding backend',
    'outbox replicator',
    'streaming ingest',
    'migration plan',
    'retention policy',
];

export default async function recallMixed(opts) {
    const { base, bearer, workspace, N, recorder } = opts;
    for (let i = 0; i < N; i++) {
        const q = QUERIES[i % QUERIES.length];
        const t0 = performance.now();
        try {
            const r = await fetch(`${base}/api/recall`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${bearer}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ workspace, topic: q, limit: 10 }),
            });
            const latency = performance.now() - t0;
            if (!r.ok) recorder.error(new Error(`HTTP ${r.status}`));
            else recorder.observe(latency);
        } catch (err) {
            recorder.error(err);
        }
    }
}
