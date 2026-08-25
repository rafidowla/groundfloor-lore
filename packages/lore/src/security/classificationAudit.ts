/**
 * classificationAudit.ts — append-only audit log of every classification
 * decision made during ingest.
 *
 * A classification decision is the routing answer at ingest time:
 *   "this incoming record was routed to <kind> as <node-type>, by <rule>,
 *    with confidence <score>, into workspace <ws>."
 *
 * Why a separate log:
 *   - Compliance: regulated industries need to prove every piece of data
 *     was classified deterministically (or with a clear AI confidence
 *     trail).
 *   - Debugging: when the AI mis-classifies, the audit log shows which
 *     rule fired or which low-confidence guess landed in the exception
 *     queue.
 *   - Performance: JSONL append is cheap and fast. We don't put audit
 *     entries in the graph itself (would bloat the graph and slow
 *     traversal).
 *
 * Format: newline-delimited JSON (`.lore/classification.jsonl`). Each
 * line is one ClassificationAuditEntry. The file grows forever — a
 * rotation policy lives outside this module (V3.0+).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { NodeKind } from '../schemas/types.js';

/**
 * One classification decision.
 *
 * `decidedBy` carries who made the decision:
 *   - 'rule:<rule-name>' — deterministic rule fired
 *   - 'schema:<connector>:<record-type>' — schema-driven mapping
 *   - 'ai:<model>' — AI classifier with confidence below auto-apply
 *     threshold landed in exception queue (or above and auto-applied)
 *   - 'human:<subject-id>' — manual classification through admin app
 *
 * `outcome` is the routing result:
 *   - 'routed' — went to the named target store + node type
 *   - 'queued-exception' — confidence below threshold; landed in queue
 *   - 'dropped' — explicit policy drop (e.g., dedupe collision)
 */
export interface ClassificationAuditEntry {
    /** ISO-8601 timestamp. */
    at: string;
    /** Workspace this classification belongs to. */
    workspace: string;
    /** Stable fingerprint of the input record (for de-dupe and replay). */
    inputFingerprint: string;
    /** sourceId from the connector that produced this record. */
    sourceId?: string;
    /** Connector that produced the input (if any). */
    connector?: string;
    /** Who/what classified. See jsdoc for the prefix vocabulary. */
    decidedBy: string;
    /** Confidence score (0..1). Required when decidedBy starts with 'ai:'. */
    confidence?: number;
    outcome: 'routed' | 'queued-exception' | 'dropped';
    /** Target node kind when outcome === 'routed'. */
    kind?: NodeKind;
    /** Target node type name when outcome === 'routed'. */
    nodeType?: string;
    /** Free-form reason. Human-readable. */
    reason?: string;
}

/**
 * Read-only filter for `list`. All fields AND together; missing fields
 * mean "no filter on this dimension."
 */
export interface ClassificationAuditFilter {
    sinceIso?: string;
    untilIso?: string;
    workspace?: string;
    decidedByPrefix?: string;
    outcome?: ClassificationAuditEntry['outcome'];
    limit?: number;
}

/**
 * Append-only writer + reader for classification audit.
 *
 * Construction is cheap; safe to instantiate per request. Writes are
 * synchronous-flushed (`{flag:'a'}`); concurrent writers are serialized
 * by the OS append semantics on regular files.
 */
export class ClassificationAuditLogger {
    private readonly filePath: string;

    /**
     * @param baseDir Workspace `.lore/` directory or any directory that
     *   should host the audit file.
     * @param filename Defaults to `classification.jsonl`. Customizable
     *   for tests.
     */
    constructor(baseDir: string, filename: string = 'classification.jsonl') {
        fs.mkdirSync(baseDir, { recursive: true });
        this.filePath = path.join(baseDir, filename);
    }

    /** Path to the underlying JSONL file. */
    get path(): string {
        return this.filePath;
    }

    /** Append one entry. Validates `decidedBy`/`confidence` invariants. */
    append(entry: ClassificationAuditEntry): void {
        validateEntry(entry);
        const line = JSON.stringify(entry) + '\n';
        fs.appendFileSync(this.filePath, line, { encoding: 'utf-8' });
    }

    /**
     * Stream all entries since (optionally) a timestamp, applying
     * filters. Reads the whole file linearly — fine for files up to a
     * few hundred MB; rotation/index lives outside this module.
     */
    list(filter: ClassificationAuditFilter = {}): ClassificationAuditEntry[] {
        if (!fs.existsSync(this.filePath)) return [];
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const out: ClassificationAuditEntry[] = [];
        const limit = filter.limit ?? Infinity;
        for (const rawLine of raw.split('\n')) {
            if (!rawLine.trim()) continue;
            let entry: ClassificationAuditEntry;
            try { entry = JSON.parse(rawLine) as ClassificationAuditEntry; } catch { continue; }
            if (!matchFilter(entry, filter)) continue;
            out.push(entry);
            if (out.length >= limit) break;
        }
        return out;
    }

    /** Total number of entries in the log. Useful for dashboards. */
    count(): number {
        if (!fs.existsSync(this.filePath)) return 0;
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        let n = 0;
        for (const line of raw.split('\n')) if (line.trim()) n++;
        return n;
    }
}

function validateEntry(entry: ClassificationAuditEntry): void {
    if (!entry.at) throw new Error('classification audit entry missing `at`');
    if (!entry.workspace) throw new Error('classification audit entry missing `workspace`');
    if (!entry.inputFingerprint) throw new Error('classification audit entry missing `inputFingerprint`');
    if (!entry.decidedBy) throw new Error('classification audit entry missing `decidedBy`');
    if (entry.decidedBy.startsWith('ai:') && typeof entry.confidence !== 'number') {
        throw new Error("AI-decided classification must include numeric `confidence`");
    }
    if (entry.outcome === 'routed' && (!entry.kind || !entry.nodeType)) {
        throw new Error("`routed` outcome requires `kind` and `nodeType`");
    }
}

function matchFilter(
    entry: ClassificationAuditEntry,
    filter: ClassificationAuditFilter,
): boolean {
    if (filter.sinceIso && entry.at < filter.sinceIso) return false;
    if (filter.untilIso && entry.at > filter.untilIso) return false;
    if (filter.workspace && entry.workspace !== filter.workspace) return false;
    if (filter.outcome && entry.outcome !== filter.outcome) return false;
    if (filter.decidedByPrefix && !entry.decidedBy.startsWith(filter.decidedByPrefix)) return false;
    return true;
}
