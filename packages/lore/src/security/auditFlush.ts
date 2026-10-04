/**
 * auditFlush.ts — process-wide registry of live AuditLog instances plus a
 * bounded "flush them all" used by every shutdown path (3.27.1).
 *
 * Why: AuditLog.appendEntry chains fs.promises.appendFile onto an internal
 * writeChain and deliberately never awaits it (a tool call must never block on
 * audit). flush() existed but NO teardown awaited it, so a burst of audited
 * writes followed immediately by dispose()/SIGTERM lost the queued tail (the
 * rows were appended to a data dir the host had already removed → ENOENT, or
 * the process simply exited first). The audit file is a hash chain, so a lost
 * tail is also a verifier-visible truncation.
 *
 * Why a registry instead of a dep on buildShutdownDrain: mcp/server.ts is
 * FROZEN and builds the daemon's drain deps inline; the AuditLog constructor
 * is the one place that already runs in every boot path (daemon, embedded,
 * arcade), so registering there reaches all of them with no server.ts edit
 * and also covers multiple instances per process (per home / workspace).
 *
 * Instances are held by WeakRef so a test or host that churns through
 * AuditLogs never leaks them through this registry.
 */

/** Upper bound on how long shutdown waits for queued audit appends. A wedged
 *  filesystem (hung NFS, stalled disk) must never hang dispose()/SIGTERM — on
 *  timeout we warn once and carry on, accepting the lost tail over a hang. */
export const AUDIT_FLUSH_TIMEOUT_MS = 5_000;

interface Flushable { flush(): Promise<void> }

const live = new Set<WeakRef<Flushable>>();

/** Called from the AuditLog constructor. */
export function registerAuditLog(log: Flushable): void {
    live.add(new WeakRef(log));
}

/**
 * Await every live AuditLog's write chain, bounded by `timeoutMs`. Never
 * throws and never rejects. Returns true when everything flushed in time.
 */
export async function flushAllAuditLogs(timeoutMs: number = AUDIT_FLUSH_TIMEOUT_MS): Promise<boolean> {
    const pending: Promise<void>[] = [];
    for (const ref of live) {
        const log = ref.deref();
        if (!log) { live.delete(ref); continue; }
        pending.push(log.flush().catch(() => { /* appendEntry already logged the failure */ }));
    }
    if (pending.length === 0) return true;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        // Deliberately NOT unref'd: with a hung append nothing else holds the
        // loop open, and an unref'd bound would let the process exit mid-await
        // instead of timing out. Cleared in finally, so it never outlives the call.
    });
    try {
        const ok = await Promise.race([Promise.all(pending).then(() => true as const), timedOut]);
        if (!ok) console.warn(`[audit] flush did not complete within ${timeoutMs}ms at shutdown; queued audit rows may be lost`);
        return ok;
    } finally {
        if (timer) clearTimeout(timer);
    }
}
