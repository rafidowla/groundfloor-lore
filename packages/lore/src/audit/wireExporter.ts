/**
 * wireExporter.ts — boot helper that selects + starts the configured
 * AuditLogExporter and attaches it to the AuditLog (Sprint B-local).
 *
 * Why this is its own file:
 *   - server.ts is already past the soft cap; adding the boot-time
 *     selection logic inline pushed it over the new-violation
 *     guardrail. Pulling the side-effecting wiring out keeps the
 *     audit-export pipeline testable in isolation and keeps server.ts
 *     focused on long-lived deps rather than env-driven branching.
 *   - Concrete SIEM impls (Splunk/Datadog/Elastic) land here later as
 *     additional cases inside selectExporter() — no further server.ts
 *     edits needed.
 */

import type { AuditLog } from '../security/audit.js';
import {
    AUDIT_EXPORTER_ENV_KEY,
    NoopExporter,
    parseExporterChoice,
    type AuditLogExporter,
    type AuditExporterChoice,
} from './exporter.js';
import { FileTailExporter } from './fileTailExporter.js';

/**
 * Select an exporter impl per the env value. Unknown / not-yet-wired
 * cloud values fall back to the file-tailer with a one-time warn line.
 */
export function selectExporter(env: Readonly<Record<string, string | undefined>>): {
    exporter: AuditLogExporter;
    chosen: AuditExporterChoice;
    fellBack: boolean;
} {
    const chosen = parseExporterChoice(env[AUDIT_EXPORTER_ENV_KEY]);
    if (chosen === 'none') {
        return { exporter: new NoopExporter(), chosen, fellBack: false };
    }
    if (chosen === 'file') {
        return { exporter: new FileTailExporter(), chosen, fellBack: false };
    }
    // splunk / datadog / elastic — interface drop-in only this release.
    return { exporter: new FileTailExporter(), chosen, fellBack: true };
}

/**
 * One-shot boot wiring: select → configure → start → attach. Called
 * from server.ts after the AuditLog instance exists. Never throws;
 * all failures are logged and the daemon proceeds without an
 * exporter (audit.jsonl remains the source of truth).
 */
export function wireAuditExporterOnBoot(auditLog: AuditLog): void {
    try {
        const { exporter, chosen, fellBack } = selectExporter(process.env);
        if (fellBack) {
            console.warn(`[audit-export] '${chosen}' impl not yet wired (interface-only this release); using file exporter`);
        }
        const env = { env: process.env as Readonly<Record<string, string | undefined>>, auditLogPath: auditLog.getPath() };
        Promise.resolve(exporter.configure(env))
            .then(() => exporter.start())
            .then(() => { auditLog.attachExporter(exporter); console.log(`[audit-export] exporter '${exporter.name}' started`); })
            .catch((err) => { console.error(`[audit-export] failed to start '${exporter.name}': ${(err as Error).message}`); });
    } catch (err) {
        console.error(`[audit-export] wiring failed: ${(err as Error).message}`);
    }
}
