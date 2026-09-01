/**
 * Cooperative cancel for load jobs. HTTP POST /api/load/jobs/<id>/cancel
 * records the id here; the runner polls at row boundaries (same spirit as
 * reconnect.shouldAbort) and must not stamp status=complete.
 */

export class LoadCancelledError extends Error {
    override readonly name = 'LoadCancelledError';
    constructor() {
        super('cancelled');
    }
}

export function isLoadCancelled(err: unknown): boolean {
    return err instanceof LoadCancelledError;
}

export class LoadJobAbortRegistry {
    private readonly ids = new Set<string>();

    requestCancel(jobId: string): void {
        this.ids.add(jobId);
    }

    isCancelled(jobId: string): boolean {
        return this.ids.has(jobId);
    }

    clear(jobId: string): void {
        this.ids.delete(jobId);
    }
}
