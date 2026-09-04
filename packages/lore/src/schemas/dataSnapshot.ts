/**
 * dataSnapshot.ts — Phase 1 item 3: capture affected data BEFORE the
 * schema flip when a destructive change is approved.
 *
 * Why this exists:
 *   `SchemaAuthoringStore.approve()` historically snapshots only the
 *   prior SCHEMA file, not the underlying data. For destructive
 *   changes (drop a node type, remove a field, change a column
 *   type, etc.) the data exists at the moment of approval but may
 *   become unrecoverable once the new schema goes live and the
 *   migration window closes. This module captures a JSONL backup of
 *   the affected rows / edges before the schema is overwritten,
 *   stored alongside the schema-history snapshots under
 *   `<workspace>/.lore/data-snapshots/`.
 *
 *   Failure mode is "fail closed": if the snapshot cannot be taken,
 *   `approve()` aborts (does NOT flip the schema). The operator can
 *   re-approve once the substrate is reachable. This is the
 *   safety property the design memo is built on
 *   (docs/architecture/SCHEMA_CHANGE_SAFETY_MEMO.md).
 *
 * Scope (Phase 1 MVP):
 *   Today the local graph stores node-type and edge-relation as
 *   *values* on the universal `LoreNode` / `LoreEdge` tables (not as
 *   separate node tables per type). So the snapshot for almost every
 *   destructive change kind reduces to "dump every LoreNode with
 *   `type = X`" or "dump every LoreEdge with `relation = R`". The
 *   single GraphReader.queryRows() escape hatch is enough.
 *
 *   Application-defined tables (per ITableStorage in contracts/tables.ts)
 *   are a separate substrate and out of scope for this snapshotter.
 *   A follow-up `TableSnapshotter` can layer on top once the
 *   table-CRUD surface lands (Phase 2).
 *
 * On-disk layout:
 *   <workspace>/.lore/data-snapshots/
 *     <iso>_<sandbox-id>_<change-kind>_<change-target>.jsonl
 *
 *   Slashes and dots in the change target are replaced with `__` so
 *   the filename stays portable. JSONL is one row per line; rows are
 *   the raw graph projection of the matching LoreNode / LoreEdge plus
 *   `_snapshotMetadata` describing the originating change.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ProposedChange } from './authoring.js';
import type { SchemaGraphOps } from './substrate/schemaGraphOps.js';

/* ------------------------------------------------------------------ */
/*  Public surface                                                    */
/* ------------------------------------------------------------------ */

/**
 * `LocalGraphSnapshotter` reads through the same engine-agnostic
 * `SchemaGraphOps` port `blastRadius.ts` and the migration backend use —
 * see `schemas/substrate/schemaGraphOps.ts`. No separate escape-hatch type
 * needed here.
 */

/** What a single snapshot call wrote to disk. */
export interface SnapshotResult {
    /** Absolute path to the .jsonl file written. */
    file: string;
    /** Number of rows captured. May be 0 (still a valid snapshot). */
    rowCount: number;
    /** File size in bytes. */
    bytes: number;
    /** "applied" if rows were enumerated, "skipped" if the change
     *  kind has no data to snapshot (e.g. permission edits). */
    status: 'applied' | 'skipped';
    /** Human-readable note (one line). */
    note?: string;
}

export interface SnapshotOpts {
    sandboxId: string;
    /** Absolute path to the per-workspace data-snapshots directory. */
    snapshotsDir: string;
    /** ISO timestamp used as the snapshot file's prefix. Caller picks
     *  this so a multi-change approval shares one timestamp. */
    isoTimestamp: string;
}

export interface DataSnapshotter {
    snapshotForChange(
        change: ProposedChange,
        opts: SnapshotOpts,
    ): Promise<SnapshotResult>;
}

/**
 * No-op snapshotter — useful for tests and for opt-out (an operator
 * who explicitly wants the old behavior). Returns a `skipped` result
 * with a note explaining no snapshot was taken.
 */
export const noopSnapshotter: DataSnapshotter = {
    async snapshotForChange(change) {
        return {
            file: '',
            rowCount: 0,
            bytes: 0,
            status: 'skipped',
            note: `noop snapshotter — no data preserved for ${change.kind}(${change.target})`,
        };
    },
};

/* ------------------------------------------------------------------ */
/*  LocalGraph-backed implementation                                  */
/* ------------------------------------------------------------------ */

/**
 * LocalGraphSnapshotter — translates a destructive `ProposedChange`
 * into a Cypher read against the LoreNode / LoreEdge universal
 * tables, then writes the result as JSONL.
 *
 * Permission and `workspace.*` change kinds don't have a row-level
 * data shape to capture; they're recorded as `skipped` snapshots
 * with a note so the audit trail is complete.
 */
export class LocalGraphSnapshotter implements DataSnapshotter {
    constructor(private readonly graph: SchemaGraphOps) {}

    async snapshotForChange(
        change: ProposedChange,
        opts: SnapshotOpts,
    ): Promise<SnapshotResult> {
        const target = String(change.target);
        const fileName = makeSnapshotFileName(opts.isoTimestamp, opts.sandboxId, change.kind, target);
        const filePath = path.join(opts.snapshotsDir, fileName);

        switch (change.kind) {
            case 'node_type.removed':
            case 'node_type.renamed':
            case 'node_type.kind_changed':
            case 'field.removed':
            case 'field.type_changed':
            case 'field.sensitivity_flipped': {
                // For node-type-scoped changes, target is either
                // "<NodeType>" (node_type.*) or "<NodeType>.<field>"
                // (field.*). Node types in this codebase are
                // dotted (e.g. "know.Tenant"), so a naive split-on-
                // first-dot would chop a field off the type name.
                // Strip exactly the last segment for field.* kinds;
                // leave node_type.* targets intact.
                const isFieldChange = change.kind.startsWith('field.');
                const nodeType = isFieldChange
                    ? target.replace(/\.[^.]+$/, '')
                    : target;
                const rows = await this.graph.listNodesByType(nodeType);
                return writeJsonl(filePath, change, rows, opts);
            }

            case 'edge_type.removed': {
                // target = relation name on LoreEdge.
                const rows = await this.graph.listEdgesByRelation(target);
                return writeJsonl(filePath, change, rows, opts);
            }

            case 'permission.changed':
            case 'permission.removed': {
                // No data shape to dump — write an empty .jsonl so
                // the audit trail records the attempt; carries a
                // `_snapshotMetadata` line at the top for context.
                return writeJsonl(filePath, change, [], opts, {
                    status: 'skipped',
                    note: 'permission change has no row-level data shape; live data is unaffected by this snapshot',
                });
            }

            default: {
                // Additive / unknown destructive — this snapshotter
                // shouldn't be called for additive kinds (the caller
                // filters first), but be defensive.
                return writeJsonl(filePath, change, [], opts, {
                    status: 'skipped',
                    note: `change kind ${change.kind} is not snapshotted by LocalGraphSnapshotter`,
                });
            }
        }
    }
}

/* ------------------------------------------------------------------ */
/*  helpers                                                            */
/* ------------------------------------------------------------------ */

function makeSnapshotFileName(
    isoTimestamp: string,
    sandboxId: string,
    kind: string,
    target: string,
): string {
    const safeTs = isoTimestamp.replace(/[:.]/g, '-');
    const safeTarget = target.replace(/[/\\.]/g, '__');
    const safeKind = kind.replace(/\./g, '_');
    return `${safeTs}_${sandboxId}_${safeKind}_${safeTarget}.jsonl`;
}

function writeJsonl(
    filePath: string,
    change: ProposedChange,
    rows: Array<Record<string, unknown>>,
    opts: SnapshotOpts,
    overrides: { status?: SnapshotResult['status']; note?: string } = {},
): SnapshotResult {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const header = JSON.stringify({
        _snapshotMetadata: {
            sandboxId: opts.sandboxId,
            changeKind: change.kind,
            changeTarget: change.target,
            migration: change.migration,
            capturedAt: opts.isoTimestamp,
            rowCount: rows.length,
        },
    });
    const body = rows.map(r => JSON.stringify(r)).join('\n');
    const contents = body.length > 0 ? `${header}\n${body}\n` : `${header}\n`;
    // Atomic write so a crash mid-write doesn't leave a half-file.
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, contents, { encoding: 'utf-8' });
    fs.renameSync(tmp, filePath);
    return {
        file: filePath,
        rowCount: rows.length,
        bytes: Buffer.byteLength(contents, 'utf-8'),
        status: overrides.status ?? 'applied',
        note: overrides.note,
    };
}
