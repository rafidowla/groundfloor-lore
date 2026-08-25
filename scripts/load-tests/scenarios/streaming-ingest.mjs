/**
 * scenarios/streaming-ingest.mjs — Sprint C4 streaming-ingest scenario.
 *
 * Drives the Sprint S warm-lane streaming-ingest endpoint by opening
 * a session, posting N events, then closing. Per-event latency
 * recorded (publish-ack time, NOT end-to-end visibility).
 */
import { performance } from 'node:perf_hooks';

export default async function streamingIngest(opts) {
    const { base, bearer, workspace, N, recorder } = opts;

    // Open session.
    let sessionId;
    try {
        const r = await fetch(`${base}/api/stream/connect`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${bearer}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ workspace }),
        });
        if (!r.ok) {
            recorder.error(new Error(`stream/connect HTTP ${r.status}`));
            return;
        }
        const data = await r.json();
        sessionId = data.sessionId;
    } catch (err) {
        recorder.error(err);
        return;
    }

    for (let i = 0; i < N; i++) {
        const t0 = performance.now();
        try {
            const r = await fetch(`${base}/api/stream/publish`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${bearer}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    sessionId,
                    event: {
                        id: `lt-stream-${Date.now()}-${i}`,
                        type: 'decision',
                        label: `streaming event ${i}`,
                        content: 'streaming ingest load test',
                    },
                }),
            });
            const latency = performance.now() - t0;
            if (!r.ok) recorder.error(new Error(`HTTP ${r.status}`));
            else recorder.observe(latency);
        } catch (err) {
            recorder.error(err);
        }
    }

    try {
        await fetch(`${base}/api/stream/close`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${bearer}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ sessionId }),
        });
    } catch { /* ignore */ }
}
