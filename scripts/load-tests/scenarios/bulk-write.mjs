/**
 * scenarios/bulk-write.mjs — Sprint C4 bulk-write load scenario.
 *
 * Posts batches of N nodes via POST /api/nodes/bulk, opts.N times.
 * Per-batch latency is recorded. Uses Sprint Z bulk path.
 */
import { performance } from 'node:perf_hooks';

export default async function bulkWrite(opts) {
    const { base, bearer, workspace, N, recorder } = opts;
    const BATCH = Number(opts['batch'] ?? 100);

    for (let i = 0; i < N; i++) {
        const nodes = Array.from({ length: BATCH }, (_, j) => ({
            id: `lt-bulk-${Date.now()}-${i}-${j}`,
            type: 'decision',
            label: `load-test bulk row ${i}/${j}`,
            content: 'load-test payload — '.repeat(20),
            tags: ['load-test', 'bulk-write'],
        }));
        const t0 = performance.now();
        try {
            const r = await fetch(`${base}/api/nodes/bulk`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${bearer}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ workspace, nodes }),
            });
            const latency = performance.now() - t0;
            if (!r.ok) {
                recorder.error(new Error(`HTTP ${r.status}`));
            } else {
                recorder.observe(latency);
            }
        } catch (err) {
            recorder.error(err);
        }
    }
}
