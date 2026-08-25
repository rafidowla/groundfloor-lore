/**
 * scenarios/hot-write.mjs — Sprint C4 single-write sustained scenario.
 *
 * POST /api/node N times sequentially per worker. Exercises the
 * hot-lane outbox + quota path.
 */
import { performance } from 'node:perf_hooks';

export default async function hotWrite(opts) {
    const { base, bearer, workspace, N, recorder } = opts;

    for (let i = 0; i < N; i++) {
        const id = `lt-hot-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`;
        const body = JSON.stringify({
            workspace,
            id,
            type: 'decision',
            label: `hot-write load row ${i}`,
            content: 'sustained hot-write load — single endpoint',
            tags: ['load-test', 'hot-write'],
        });
        const t0 = performance.now();
        try {
            const r = await fetch(`${base}/api/node`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${bearer}`,
                    'Content-Type': 'application/json',
                },
                body,
            });
            const latency = performance.now() - t0;
            if (!r.ok) recorder.error(new Error(`HTTP ${r.status}`));
            else recorder.observe(latency);
        } catch (err) {
            recorder.error(err);
        }
    }
}
