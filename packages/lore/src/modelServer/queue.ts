/**
 * modelServer/queue.ts — per-client round-robin embed queue with
 * query-ahead-of-document-batch priority (D9 §5.7).
 *
 * Only `embed` requests are queued here. `rerank` is NOT queued: it goes
 * straight through `LocalRerankProvider.score()`, which already enforces a
 * machine-wide concurrency cap and throws `RerankBusyError` when it's
 * exhausted (reused as-is — see handlers.ts) — reimplementing a second
 * queue in front of it would just be a slower way to reach the same cap.
 *
 * Why embed needs a real queue and rerank doesn't: embed has no existing
 * process-wide admission control, and this slice must not let one client's
 * `documentBatch` (bulk ingest) monopolize the shared pipeline ahead of
 * another client's `query` (interactive recall) requests. Dispatch is
 * single-concurrency (one embed request's provider call runs at a time) —
 * this is also what makes "never merge two requests into one forward
 * pass" trivially true: each dispatched task owns its own
 * `embedDocumentBatch(texts)` array, scoped to exactly one request, and
 * the next request's array is never appended to a still-running one.
 *
 * Fairness: clients are visited round-robin. Within one scan, every
 * currently-queued `query`-priority task (from any client) is preferred
 * over every `batch`-priority task — so a burst of interactive queries
 * never waits behind an older bulk-ingest backlog, while still processing
 * strictly in per-client FIFO order among tasks of the same priority.
 */

export type EmbedTaskPriority = 'query' | 'batch';

export interface EmbedTask {
    id: string;
    clientId: string;
    priority: EmbedTaskPriority;
    run(): Promise<void>;
}

export class EmbedQueue {
    private readonly queues = new Map<string, EmbedTask[]>();
    private readonly clientOrder: string[] = [];
    private rrIndex = 0;
    private running = false;

    /** Total tasks not yet dispatched, across all clients. */
    depth(): number {
        let n = 0;
        for (const q of this.queues.values()) n += q.length;
        return n;
    }

    /** Not-yet-dispatched tasks queued for one client (for the per-client
     *  queue-depth cap in connection.ts). */
    depthFor(clientId: string): number {
        return this.queues.get(clientId)?.length ?? 0;
    }

    enqueue(task: EmbedTask): void {
        let q = this.queues.get(task.clientId);
        if (!q) {
            q = [];
            this.queues.set(task.clientId, q);
            this.clientOrder.push(task.clientId);
        }
        q.push(task);
        void this.pump();
    }

    /** Remove a not-yet-dispatched task by id (for `cancel`). Returns true
     *  if it was found and removed; false if it had already been dispatched
     *  (or never existed) and must be left to finish on its own. */
    remove(clientId: string, id: string): boolean {
        const q = this.queues.get(clientId);
        if (!q) return false;
        const idx = q.findIndex((t) => t.id === id);
        if (idx === -1) return false;
        q.splice(idx, 1);
        if (q.length === 0) this.dropClient(clientId);
        return true;
    }

    /** Drop every not-yet-dispatched task for a client (on disconnect). A
     *  task already dispatched (mid-`run()`) is unaffected — it finishes
     *  and its result/error is simply not delivered to the closed socket. */
    dropClient(clientId: string): void {
        this.queues.delete(clientId);
        const idx = this.clientOrder.indexOf(clientId);
        if (idx !== -1) {
            this.clientOrder.splice(idx, 1);
            if (this.rrIndex > idx) this.rrIndex--;
            else if (this.rrIndex >= this.clientOrder.length) this.rrIndex = 0;
        }
    }

    private pickNext(): EmbedTask | undefined {
        const n = this.clientOrder.length;
        if (n === 0) return undefined;
        for (const wantPriority of ['query', 'batch'] as const) {
            for (let i = 0; i < n; i++) {
                const idx = (this.rrIndex + i) % this.clientOrder.length;
                const cid = this.clientOrder[idx];
                const q = this.queues.get(cid);
                if (!q || q.length === 0) continue;
                const pos = q.findIndex((t) => t.priority === wantPriority);
                if (pos === -1) continue;
                const [task] = q.splice(pos, 1);
                this.rrIndex = q.length === 0 ? idx : (idx + 1) % this.clientOrder.length;
                if (q.length === 0) this.dropClient(cid);
                return task;
            }
        }
        return undefined;
    }

    private async pump(): Promise<void> {
        if (this.running) return;
        this.running = true;
        try {
            let task: EmbedTask | undefined;
            while ((task = this.pickNext())) {
                try {
                    await task.run();
                } catch {
                    // task.run() is responsible for reporting its own errors
                    // to the client; a throw here must never stop the pump.
                }
            }
        } finally {
            this.running = false;
        }
    }
}
