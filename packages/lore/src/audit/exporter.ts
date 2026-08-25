/**
 * exporter.ts — AuditLogExporter interface (Sprint B-local).
 *
 * Why this exists:
 *   Enterprise customers (22B + bank) require their security teams to
 *   ingest Lore's audit signal into their SIEM (Splunk HEC, Datadog
 *   Logs, Elastic, Sumo, etc.). The audit DATA already exists
 *   (~/.groundfloor/audit.jsonl — see security/audit.ts). What was
 *   missing was the cloud-pluggable EXPORT shape — a stable interface
 *   that concrete SIEM impls can drop into without touching the audit
 *   write path.
 *
 * Design contract (Sprint B-local principle):
 *   - The audit-write path stays untouched. audit.jsonl remains the
 *     source of truth; the exporter is purely ADDITIVE — it observes
 *     successful audit writes and streams them out.
 *   - Failures in an exporter MUST NOT fail the audit write or the
 *     underlying tool call. Exporters self-handle retries, buffering,
 *     and back-pressure.
 *   - Cloud impls (Splunk HEC POST, Datadog logs intake, etc.) plug
 *     in by implementing this interface and registering via env
 *     `LORE_AUDIT_EXPORTER=<name>`. Concrete SIEM impls are DEFERRED
 *     to cloud activation per spec — this sprint ships the interface
 *     + the local file-tailer reference impl only.
 *
 * Env shape:
 *   LORE_AUDIT_EXPORTER = file  | splunk | datadog | none
 *                          ↑       ↑        ↑         ↑
 *                       (default  (deferred — interface drop-in
 *                        local)    cloud)             only
 *
 *   When set to a value other than `file` or `none`, daemon boot logs
 *   a warning and falls back to `file` until the named impl is wired.
 *   This keeps the operator's "I configured Splunk" attempt from
 *   silently dropping audit signal.
 *
 * Why a single interface (not per-SIEM bespoke wires):
 *   - SIEM vendors love churn. Splunk HEC syntax changes; Datadog
 *     rotates intake URLs; Elastic ships a new bulk API every release.
 *     Decoupling the audit-write path from the wire format means the
 *     daemon stays unchanged when a customer upgrades their SIEM.
 *   - Cloud-validation checkpoint (Task #13) will probe each concrete
 *     impl in isolation; today we only assert the interface compiles
 *     and the file-tailer reference impl emits lines.
 */

import type { AuditEntry } from '../security/audit.js';

/**
 * Environment a cloud impl needs to wire itself up: endpoint URL,
 * credentials, namespace, etc. Concrete shape is impl-specific and
 * read from process.env / a secrets manager at start() time.
 *
 * The exporter is given a snapshot of process.env (not a live ref)
 * to make the contract trivially mockable in tests and to surface
 * any rotation as "explicit restart required" instead of "your
 * exporter silently picked up a new key three hours ago".
 */
export interface AuditExporterEnv {
    /** Snapshot of process.env at boot. */
    env: Readonly<Record<string, string | undefined>>;
    /** Absolute path to audit.jsonl — file-tailer needs this; others
     *  may ignore. */
    auditLogPath: string;
}

/**
 * Cloud-pluggable export contract.
 *
 * Lifecycle: configure(env) → start() → many onAuditEvent(record) →
 * stop(). Each method may be async; concrete impls choose their own
 * buffering / batching strategy.
 *
 * Implementations MUST:
 *   - Return quickly from onAuditEvent — never block the audit write
 *     path on a network round trip. Buffer + flush off the hot path.
 *   - Tolerate `stop()` being called without `start()` (idempotent).
 *   - Never throw from onAuditEvent under any condition — internal
 *     errors must be swallowed + logged to stderr at most once per
 *     minute to avoid log-spam attacks via malformed audit rows.
 */
export interface AuditLogExporter {
    /**
     * Stable name — appears in startup log line so operators can
     * confirm which exporter took effect from env.
     */
    readonly name: string;

    /**
     * Receive runtime configuration. Called once before start().
     * Implementations may parse env keys eagerly; failures here are
     * boot-time errors and SHOULD fall back to the file-tailer impl.
     */
    configure(env: AuditExporterEnv): Promise<void> | void;

    /**
     * Begin streaming. Called after configure() at daemon boot.
     * Idempotent — calling twice is a no-op.
     */
    start(): Promise<void> | void;

    /**
     * Observe one audit entry. Called from the audit write path
     * AFTER the JSONL append has completed (additive observer
     * pattern — see security/audit.ts).
     *
     * MUST be non-throwing and non-blocking. Implementations are
     * expected to buffer in memory and flush on a separate timer.
     */
    onAuditEvent(record: AuditEntry): void;

    /**
     * Flush pending events + release resources. Called during daemon
     * graceful shutdown. Idempotent.
     */
    stop(): Promise<void> | void;
}

/**
 * Env key — operators set this to choose an exporter at daemon boot.
 *
 * Values:
 *   - `file`     → reference file-tailer (default for local mode)
 *   - `splunk`   → DEFERRED — interface drop-in only
 *   - `datadog`  → DEFERRED — interface drop-in only
 *   - `elastic`  → DEFERRED — interface drop-in only
 *   - `none`     → no exporter; audit.jsonl is the only sink
 */
export const AUDIT_EXPORTER_ENV_KEY = 'LORE_AUDIT_EXPORTER';

export type AuditExporterChoice = 'file' | 'splunk' | 'datadog' | 'elastic' | 'none';

export function parseExporterChoice(raw: string | undefined): AuditExporterChoice {
    const v = (raw ?? 'file').trim().toLowerCase();
    if (v === 'file' || v === 'splunk' || v === 'datadog' || v === 'elastic' || v === 'none') {
        return v;
    }
    // Unknown values fall back to file rather than silently dropping
    // signal. Boot-time log line surfaces the substitution.
    return 'file';
}

/**
 * No-op exporter — used when LORE_AUDIT_EXPORTER=none. Still keeps
 * the interface contract so callers don't need to branch on null.
 *
 * Why a real class instead of `null`: services.ts calls
 * exporter.onAuditEvent inside the audit-write path; threading a
 * nullable through every audit site adds noise + branch overhead.
 * A no-op object keeps the call site uniform.
 */
export class NoopExporter implements AuditLogExporter {
    readonly name = 'noop';
    configure(): void { /* no-op */ }
    start(): void { /* no-op */ }
    onAuditEvent(): void { /* no-op */ }
    stop(): void { /* no-op */ }
}
