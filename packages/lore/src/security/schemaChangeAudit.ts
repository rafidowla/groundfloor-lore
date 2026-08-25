/**
 * schemaChangeAudit.ts — append-only audit log of every schema change
 * applied to a workspace.
 *
 * Why a separate log from classification audit:
 *   - Different lifecycle (schema changes are rare and structural;
 *     classification decisions fire per ingest record).
 *   - Different consumers (admin app's "schema history" tab vs the
 *     compliance dashboard's "classification accuracy" tab).
 *   - Different retention (schema log is small and forever; classification
 *     log is large and rotates).
 *
 * Format: newline-delimited JSON at `<workspace>/.lore/schema-changes.jsonl`.
 *
 * What gets logged:
 *   - Node type added / removed / renamed / kind-changed
 *   - Field added / removed / type-changed / sensitivity-flipped
 *   - Edge type added / removed
 *   - Permission expression added / changed / removed
 *   - Migration strategy chosen for the change (lazy | dual-shape)
 *   - Approver identity for changes that went through review
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export type SchemaChangeKind =
    | 'node_type.added'
    | 'node_type.removed'
    | 'node_type.renamed'
    | 'node_type.kind_changed'
    | 'field.added'
    | 'field.removed'
    | 'field.type_changed'
    | 'field.sensitivity_flipped'
    | 'edge_type.added'
    | 'edge_type.removed'
    | 'permission.added'
    | 'permission.changed'
    | 'permission.removed'
    | 'workspace.system_prompt_changed'
    | 'workspace.domain_changed'
    /** Phase 4 item: audit linkage. Emitted by MigrationRunner after a
     *  successful op so the schema-change timeline shows BOTH the
     *  schema mutation AND the data migration that followed. `target`
     *  carries `<originalKind>:<originalTarget>` and `note` carries
     *  the planId + per-op counts so a reader can join it back to the
     *  ExecuteReport. */
    | 'migration.applied';

export type MigrationStrategy = 'lazy' | 'dual-shape' | 'not-applicable';

/**
 * One schema-change entry.
 *
 *   `proposedBy` and `approvedBy` distinguish the two-step authoring
 *   flow: AI proposes, human approves. For purely-deterministic changes
 *   (e.g., a manifest install) `proposedBy` and `approvedBy` may be the
 *   same — convention: prefix with the actor type ('ai:', 'human:',
 *   'system:').
 */
export interface SchemaChangeAuditEntry {
    at: string;                    // ISO-8601
    workspace: string;
    /** Schema format version after this change applied. */
    schemaVersionAfter: number;
    kind: SchemaChangeKind;
    target: string;                // type/field/permission identifier
    proposedBy: string;
    approvedBy: string;
    /** Free-form note from the proposer or approver. Optional. */
    note?: string;
    /** before/after snapshots — JSON-serializable. */
    before?: unknown;
    after?: unknown;
    /** Migration strategy chosen for this change. */
    migration: MigrationStrategy;
}

export interface SchemaChangeAuditFilter {
    sinceIso?: string;
    untilIso?: string;
    workspace?: string;
    kind?: SchemaChangeKind;
    targetPrefix?: string;
    limit?: number;
}

export class SchemaChangeAuditLogger {
    private readonly filePath: string;

    constructor(baseDir: string, filename: string = 'schema-changes.jsonl') {
        fs.mkdirSync(baseDir, { recursive: true });
        this.filePath = path.join(baseDir, filename);
    }

    get path(): string { return this.filePath; }

    append(entry: SchemaChangeAuditEntry): void {
        validateEntry(entry);
        fs.appendFileSync(this.filePath, JSON.stringify(entry) + '\n', { encoding: 'utf-8' });
    }

    list(filter: SchemaChangeAuditFilter = {}): SchemaChangeAuditEntry[] {
        if (!fs.existsSync(this.filePath)) return [];
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const out: SchemaChangeAuditEntry[] = [];
        const limit = filter.limit ?? Infinity;
        for (const rawLine of raw.split('\n')) {
            if (!rawLine.trim()) continue;
            let entry: SchemaChangeAuditEntry;
            try { entry = JSON.parse(rawLine) as SchemaChangeAuditEntry; } catch { continue; }
            if (!matchFilter(entry, filter)) continue;
            out.push(entry);
            if (out.length >= limit) break;
        }
        return out;
    }

    count(): number {
        if (!fs.existsSync(this.filePath)) return 0;
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        let n = 0;
        for (const line of raw.split('\n')) if (line.trim()) n++;
        return n;
    }
}

const KNOWN_KINDS: Set<SchemaChangeKind> = new Set<SchemaChangeKind>([
    'node_type.added', 'node_type.removed', 'node_type.renamed', 'node_type.kind_changed',
    'field.added', 'field.removed', 'field.type_changed', 'field.sensitivity_flipped',
    'edge_type.added', 'edge_type.removed',
    'permission.added', 'permission.changed', 'permission.removed',
    'workspace.system_prompt_changed', 'workspace.domain_changed',
    'migration.applied',
]);

function validateEntry(entry: SchemaChangeAuditEntry): void {
    if (!entry.at) throw new Error('schema-change entry missing `at`');
    if (!entry.workspace) throw new Error('schema-change entry missing `workspace`');
    if (!entry.kind) throw new Error('schema-change entry missing `kind`');
    if (!KNOWN_KINDS.has(entry.kind)) {
        throw new Error(`unknown schema-change kind '${entry.kind}'`);
    }
    if (!entry.target) throw new Error('schema-change entry missing `target`');
    if (!entry.proposedBy) throw new Error('schema-change entry missing `proposedBy`');
    if (!entry.approvedBy) throw new Error('schema-change entry missing `approvedBy`');
    if (!entry.migration) throw new Error('schema-change entry missing `migration`');
    if (entry.migration !== 'lazy' && entry.migration !== 'dual-shape' && entry.migration !== 'not-applicable') {
        throw new Error(`invalid migration strategy '${entry.migration}'`);
    }
    if (typeof entry.schemaVersionAfter !== 'number') {
        throw new Error('schema-change entry missing numeric `schemaVersionAfter`');
    }
}

function matchFilter(
    entry: SchemaChangeAuditEntry,
    filter: SchemaChangeAuditFilter,
): boolean {
    if (filter.sinceIso && entry.at < filter.sinceIso) return false;
    if (filter.untilIso && entry.at > filter.untilIso) return false;
    if (filter.workspace && entry.workspace !== filter.workspace) return false;
    if (filter.kind && entry.kind !== filter.kind) return false;
    if (filter.targetPrefix && !entry.target.startsWith(filter.targetPrefix)) return false;
    return true;
}
