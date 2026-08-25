/**
 * dedupe.ts — Entity deduplication on ingest.
 *
 * The same external entity can be ingested through multiple paths
 * (filesystem connector + email attachment + manual upload all
 * referencing the same customer record; or two CRM connectors syncing
 * the same Account). Without dedupe, each ingest path creates a new
 * LoreNode. With dedupe, all paths converge on the same logical id.
 *
 * Dedupe is configurable per node type because what makes two records
 * "the same thing" varies:
 *   - For Account: matching tax id (when present) OR matching name + dob.
 *   - For Record: matching name + email + created_date.
 *   - For File: same content hash, regardless of path.
 *
 * Substrate-agnostic by design — this module takes a `lookup` and
 * `upsert` function. The caller (LocalGraph or DataplaneGraph) supplies
 * the substrate-specific implementations. The dedupe engine never
 * touches Kùzu or Dataplane directly.
 */

import { createHash } from 'node:crypto';

/** A record about to be ingested. Floor fields plus declared fields. */
export interface IngestRecord {
    /** Logical type name from the workspace schema (e.g. "know.Tenant"). */
    type: string;
    /** Workspace this record belongs to. */
    workspace: string;
    /** Field values. Floor fields like createdBy, ingestedAt are caller-supplied. */
    fields: Record<string, unknown>;
    /** Optional source attribution that becomes provenance later. */
    source?: { connector?: string; sourceId?: string };
}

/**
 * FingerprinterFn — deterministic, substrate-agnostic.
 *
 * Returns the stable fingerprint string for the record. Two records
 * with the same fingerprint are "the same logical entity" per this
 * type's policy. Returning null means "do not dedupe this record"
 * (each call always creates a new node).
 */
export type FingerprinterFn = (record: IngestRecord) => string | null;

/**
 * MergePolicy — what to do when an incoming record matches an existing
 * one by fingerprint.
 *
 *   - 'newest-wins' (default): incoming values overwrite existing.
 *   - 'oldest-wins': existing values stay; incoming is dropped.
 *   - 'first-non-null': for each field, keep whichever has a value;
 *     when both have values, existing wins.
 *   - 'append': accumulate into arrays. Designed for `tags`-shaped
 *     fields. Other types behave as 'newest-wins'.
 */
export type MergePolicy = 'newest-wins' | 'oldest-wins' | 'first-non-null' | 'append';

export const DEFAULT_MERGE_POLICY: MergePolicy = 'newest-wins';

/**
 * LookupFn — given (workspace, type, fingerprint), return the existing
 * record's id and current fields if present, or null if not present.
 */
export type LookupFn = (
    workspace: string,
    type: string,
    fingerprint: string,
) => Promise<{ id: string; fields: Record<string, unknown> } | null>;

/**
 * UpsertFn — write the merged record. The caller supplies the id (new
 * for create, existing for merge) and the resolved field values.
 */
export type UpsertFn = (input: {
    id: string;
    workspace: string;
    type: string;
    fingerprint: string | null;
    fields: Record<string, unknown>;
    operation: 'create' | 'merge';
}) => Promise<void>;

export interface DedupeResult {
    id: string;
    action: 'created' | 'merged' | 'unchanged';
    /** Fields that the merge changed; empty when action !== 'merged'. */
    mergedFields: string[];
    /** The fingerprint computed for this record. Useful for audit/log. */
    fingerprint: string | null;
}

/**
 * Default fingerprinters that are useful out of the box.
 */
export const Fingerprinters = {
    /**
     * Content-hash on a Buffer-typed `content` field. Useful for File
     * ingestion: same bytes → same fingerprint regardless of path.
     */
    contentHash(record: IngestRecord): string | null {
        const v = record.fields['content'];
        if (!Buffer.isBuffer(v)) return null;
        return 'sha256:' + createHash('sha256').update(v).digest('hex');
    },
    /**
     * Compose a fingerprint from a list of business-key fields.
     * Returns null if any required key is missing — disables dedupe
     * rather than collapsing distinct entities together.
     */
    fromKeys(...keys: string[]): FingerprinterFn {
        return (record: IngestRecord) => {
            const parts: string[] = [];
            for (const k of keys) {
                const v = record.fields[k];
                if (v === undefined || v === null || v === '') return null;
                parts.push(`${k}=${String(v)}`);
            }
            return 'keys:' + createHash('sha256').update(parts.join('|')).digest('hex');
        };
    },
    /**
     * Use the connector's sourceId directly. Most useful when the source
     * system has a stable id and we trust it not to repeat across syncs.
     */
    bySourceId(record: IngestRecord): string | null {
        if (!record.source?.sourceId) return null;
        return 'src:' + record.source.sourceId;
    },
};

/**
 * DedupeEngine — substrate-agnostic. Caller wires it to whatever
 * storage backend it has by passing lookup + upsert functions.
 *
 * Per-type registration: register a fingerprinter and an optional merge
 * policy. Records of unregistered types fall through to a no-dedupe
 * path (always 'created').
 */
export class DedupeEngine {
    private readonly fingerprinters = new Map<string, FingerprinterFn>();
    private readonly mergePolicies = new Map<string, MergePolicy>();

    constructor(
        private readonly lookup: LookupFn,
        private readonly upsert: UpsertFn,
    ) { }

    register(type: string, fingerprinter: FingerprinterFn, policy: MergePolicy = DEFAULT_MERGE_POLICY): void {
        this.fingerprinters.set(type, fingerprinter);
        this.mergePolicies.set(type, policy);
    }

    async ingest(record: IngestRecord): Promise<DedupeResult> {
        const fingerprinter = this.fingerprinters.get(record.type);
        const fingerprint = fingerprinter ? fingerprinter(record) : null;

        if (!fingerprint) {
            // Type not registered or fingerprinter returned null → always create.
            const id = (record.fields.id as string | undefined) ?? newId(record.type);
            await this.upsert({
                id,
                workspace: record.workspace,
                type: record.type,
                fingerprint: null,
                fields: record.fields,
                operation: 'create',
            });
            return { id, action: 'created', mergedFields: [], fingerprint: null };
        }

        const existing = await this.lookup(record.workspace, record.type, fingerprint);

        if (!existing) {
            const id = (record.fields.id as string | undefined) ?? newId(record.type);
            await this.upsert({
                id,
                workspace: record.workspace,
                type: record.type,
                fingerprint,
                fields: record.fields,
                operation: 'create',
            });
            return { id, action: 'created', mergedFields: [], fingerprint };
        }

        const policy = this.mergePolicies.get(record.type) ?? DEFAULT_MERGE_POLICY;
        const { merged, changedFields } = mergeFields(existing.fields, record.fields, policy);
        if (changedFields.length === 0) {
            return { id: existing.id, action: 'unchanged', mergedFields: [], fingerprint };
        }
        await this.upsert({
            id: existing.id,
            workspace: record.workspace,
            type: record.type,
            fingerprint,
            fields: merged,
            operation: 'merge',
        });
        return { id: existing.id, action: 'merged', mergedFields: changedFields, fingerprint };
    }
}

function newId(type: string): string {
    return `${type}:${createHash('sha256').update(`${type}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 16)}`;
}

/**
 * mergeFields — pure function. Returns the merged result + the names of
 * fields that actually changed. `existing` is the prior state, `incoming`
 * is the new record's fields.
 *
 * Floor fields (id, type, workspace) are never overwritten by merge —
 * the caller decides those at create time.
 */
function mergeFields(
    existing: Record<string, unknown>,
    incoming: Record<string, unknown>,
    policy: MergePolicy,
): { merged: Record<string, unknown>; changedFields: string[] } {
    const PROTECTED = new Set(['id', 'type', 'workspace', 'ingestedAt', 'createdBy']);
    const merged: Record<string, unknown> = { ...existing };
    const changedFields: string[] = [];

    for (const [k, vIn] of Object.entries(incoming)) {
        if (PROTECTED.has(k)) continue;
        const vOut = existing[k];
        let next: unknown;
        switch (policy) {
            case 'oldest-wins':
                next = (vOut === undefined || vOut === null) ? vIn : vOut;
                break;
            case 'first-non-null':
                next = (vOut === undefined || vOut === null || vOut === '') ? vIn : vOut;
                break;
            case 'append':
                if (Array.isArray(vOut) && Array.isArray(vIn)) {
                    const seen = new Set([...vOut.map(String)]);
                    next = [...vOut];
                    for (const x of vIn) if (!seen.has(String(x))) (next as unknown[]).push(x);
                } else {
                    next = vIn;
                }
                break;
            case 'newest-wins':
            default:
                next = vIn;
                break;
        }
        if (!deepEqual(next, vOut)) {
            merged[k] = next;
            changedFields.push(k);
        }
    }
    return { merged, changedFields };
}

function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a === null || b === null) return a === b;
    if (typeof a !== 'object' || typeof b !== 'object') return a === b;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
        return true;
    }
    const ak = Object.keys(a as Record<string, unknown>).sort();
    const bk = Object.keys(b as Record<string, unknown>).sort();
    if (ak.length !== bk.length) return false;
    for (let i = 0; i < ak.length; i++) {
        if (ak[i] !== bk[i]) return false;
        if (!deepEqual((a as Record<string, unknown>)[ak[i]], (b as Record<string, unknown>)[bk[i]])) return false;
    }
    return true;
}

export const __testing__ = { mergeFields };
