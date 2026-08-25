/**
 * format.ts — Human-readable rendering of a MaintainReport.
 *
 * Shared by the CLI (stdout) and the MCP tool (text summary), so the two
 * surfaces never drift. Returns a plain multi-line string.
 */

import type { MaintainPolicy } from './policy.js';
import type { MaintainReport } from './maintain.js';

export function fmtBytes(n: number): string {
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

export function formatMaintainReport(report: MaintainReport, policy: MaintainPolicy): string {
    const L: string[] = [];
    const mode = report.dryRun ? 'DRY-RUN (no writes)' : 'APPLY';
    L.push(`lore maintain — ${mode}${report.scopeLabel ? ` — ${report.scopeLabel}` : ''}`);
    if (report.writeActive) {
        L.push(report.dryRun
            ? '  note: a write session is active; a live run would skip destructive ops unless --online.'
            : '  warning: a write session is active.');
    }
    L.push('');

    // LanceDB
    L.push('LanceDB:');
    if (report.dryRun) {
        L.push(`  eligible old versions: ${report.lancedb.eligibleOldVersions}`);
        L.push(`  reclaimable (upper bound): ${fmtBytes(report.lancedb.reclaimableBytesEstimate)}`);
    } else {
        for (const t of report.lancedb.tables) {
            const err = t.error ? ` [ERROR: ${t.error}]` : '';
            L.push(`  ${t.name}: ${fmtBytes(t.beforeBytes)} → ${fmtBytes(t.afterBytes)} (reclaimed ${fmtBytes(t.bytesReclaimed)}, ${t.versionsRemoved} versions, ${t.fragmentsRemoved} fragments)${err}`);
        }
        L.push(`  total reclaimed: ${fmtBytes(report.lancedb.totalBytesReclaimed)}, versions removed: ${report.lancedb.totalVersionsRemoved}`);
    }

    // Nodes
    L.push('');
    L.push('Node retention:');
    L.push(`  inspected ${report.nodes.inspected}, protected ${report.nodes.protectedSkipped}, recent ${report.nodes.recentSkipped}, candidates ${report.nodes.candidates}`);
    if (!report.dryRun) {
        L.push(`  archived ${report.nodes.archived}, deleted ${report.nodes.deleted} (action: ${policy.nodeRetentionAction})`);
    }

    // Workspaces
    L.push('');
    L.push('Ephemeral workspaces:');
    L.push(`  inspected ${report.workspaces.inspected}, too-young ${report.workspaces.tooYoung}, ${report.dryRun ? 'would expire' : 'expired'} ${report.workspaces.expired.length}`);
    if (report.workspaces.expired.length > 0) {
        L.push(`  ${report.dryRun ? 'candidates' : 'removed'}: ${report.workspaces.expired.join(', ')}`);
    }
    if (!report.dryRun && report.workspaces.bytesFreed > 0) {
        L.push(`  freed: ${fmtBytes(report.workspaces.bytesFreed)}`);
    }

    // Errors / op status
    const errs = report.operations.flatMap((o) => o.errors.map((e) => `${o.operation}: ${e}`));
    if (errs.length > 0) {
        L.push('');
        L.push(`Errors (${errs.length}):`);
        for (const e of errs.slice(0, 20)) L.push(`  - ${e}`);
    }
    const skipped = report.operations.filter((o) => o.skippedReason);
    if (skipped.length > 0) {
        L.push('');
        L.push(`Skipped: ${skipped.map((o) => `${o.operation}(${o.skippedReason})`).join(', ')}`);
    }

    L.push('');
    L.push(`Duration: ${report.durationMs}ms`);
    return L.join('\n');
}
