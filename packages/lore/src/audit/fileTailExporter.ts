/**
 * fileTailExporter.ts — reference local AuditLogExporter implementation
 * (Sprint B-local). Default exporter when LORE_AUDIT_EXPORTER=file (or
 * unset) in local-mode deployments.
 *
 * What this proves:
 *   - The AuditLogExporter contract is implementable today against the
 *     existing audit.jsonl substrate, without modifying the audit-write
 *     path.
 *   - Concrete SIEM impls (Splunk HEC, Datadog Logs, Elastic) can take
 *     the exact same shape — buffer in memory, ship asynchronously,
 *     never block the hot path.
 *
 * What this is NOT:
 *   - Not a tail of audit.jsonl from disk. We use the in-process
 *     onAuditEvent stream (audit.ts invokes us synchronously AFTER its
 *     own append). Re-reading the file would double-emit on busy
 *     daemons and add disk overhead for zero gain — the data is
 *     already in memory when audit.log() fires.
 *   - Not a network exporter. This impl writes received records to a
 *     local sidecar file (audit-export.jsonl) so operators can
 *     `tail -f` to confirm wiring without standing up a SIEM. Cloud
 *     impls replace this sink with a vendor-specific POST.
 *
 * Buffering strategy:
 *   - Each onAuditEvent() push goes into a memory queue (capped at
 *     1024 entries; oldest are dropped with a single warn line if we
 *     overflow — protects the daemon from unbounded growth if the
 *     downstream sink wedges).
 *   - A 1-second interval drains the queue to disk via async append.
 *   - stop() drains synchronously so graceful shutdown loses nothing.
 *
 * Why this lives in src/audit/ and not security/:
 *   - security/audit.ts owns the WRITE path (durable JSONL).
 *   - src/audit/ owns the EXPORT pipeline (cloud-pluggable observer).
 *   The split keeps the security-critical write path stable while the
 *   exporter pipeline can evolve with vendor churn.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AuditEntry } from '../security/audit.js';
import type { AuditExporterEnv, AuditLogExporter } from './exporter.js';

/** Maximum in-memory queue depth before we start dropping oldest entries. */
const MAX_QUEUE = 1024;

/** Flush cadence — keeps overhead negligible on idle workspaces. */
const FLUSH_INTERVAL_MS = 1_000;

export interface FileTailExporterOptions {
    /**
     * Where to write the sidecar export file. Default:
     *   <dir(auditLogPath)>/audit-export.jsonl
     * Override only in tests.
     */
    sidecarPath?: string;
}

export class FileTailExporter implements AuditLogExporter {
    readonly name = 'file';
    private queue: AuditEntry[] = [];
    private droppedSinceLastWarn = 0;
    private sidecarPath = '';
    private timer: NodeJS.Timeout | null = null;
    private started = false;
    private readonly opts: FileTailExporterOptions;

    constructor(opts: FileTailExporterOptions = {}) {
        this.opts = opts;
    }

    configure(env: AuditExporterEnv): void {
        const overridden = this.opts.sidecarPath;
        if (overridden) {
            this.sidecarPath = overridden;
            return;
        }
        const dir = path.dirname(env.auditLogPath);
        this.sidecarPath = path.join(dir, 'audit-export.jsonl');
    }

    start(): void {
        if (this.started) return;
        this.started = true;
        // Ensure sidecar exists with 0600 perms (matches audit.jsonl).
        try {
            fs.mkdirSync(path.dirname(this.sidecarPath), { recursive: true });
            if (!fs.existsSync(this.sidecarPath)) {
                fs.writeFileSync(this.sidecarPath, '', { mode: 0o600 });
            }
        } catch (err) {
            // Boot-time fs error — log once and continue. Subsequent
            // flushes will keep trying; if disk fills, we drop with a
            // warn rather than crash the daemon.
            console.error(`[audit-export:file] init failed: ${(err as Error).message}`);
        }
        this.timer = setInterval(() => { this.flush().catch(() => { /* swallow */ }); }, FLUSH_INTERVAL_MS);
        // Don't keep the event loop alive solely for the flush timer.
        this.timer.unref?.();
    }

    onAuditEvent(record: AuditEntry): void {
        // Hot-path: must NEVER throw, must NEVER block on I/O.
        if (this.queue.length >= MAX_QUEUE) {
            this.queue.shift();
            this.droppedSinceLastWarn++;
            return;
        }
        this.queue.push(record);
    }

    async stop(): Promise<void> {
        if (!this.started) return;
        this.started = false;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        // Final synchronous-ish drain so graceful shutdown ships all
        // pending entries before exit. `await` here is fine — stop()
        // is called from the daemon shutdown path, not the hot path.
        await this.flush();
    }

    /** Drain the in-memory queue to disk. */
    private async flush(): Promise<void> {
        if (this.queue.length === 0 && this.droppedSinceLastWarn === 0) return;
        const drained = this.queue;
        this.queue = [];
        if (this.droppedSinceLastWarn > 0) {
            console.warn(`[audit-export:file] dropped ${this.droppedSinceLastWarn} entries (queue overflow)`);
            this.droppedSinceLastWarn = 0;
        }
        if (drained.length === 0) return;
        const payload = drained.map((e) => JSON.stringify(e)).join('\n') + '\n';
        try {
            await fs.promises.appendFile(this.sidecarPath, payload, { mode: 0o600 });
        } catch (err) {
            // Sink unavailable — re-queue at head (without exceeding
            // MAX_QUEUE) so the next tick retries. If chronic, the
            // overflow path drops oldest, which is preferable to
            // unbounded memory growth.
            const reinsert = drained.slice(0, Math.max(0, MAX_QUEUE - this.queue.length));
            this.queue = reinsert.concat(this.queue);
            console.warn(`[audit-export:file] flush failed (will retry): ${(err as Error).message}`);
        }
    }

    /** Test-only escape hatch — current sidecar path. */
    getSidecarPath(): string { return this.sidecarPath; }
}
