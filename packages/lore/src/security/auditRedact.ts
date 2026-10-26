/**
 * auditRedact.ts — blank-out of a deleted workspace's audit entries, and the verifier rules that keep the hash chain
 * provable afterwards (workspace-delete erase, Rafi 2026-10-25: a deleted workspace's audit content may hold sensitive
 * client data, so it must not be kept).
 *
 * What a blanked line looks like (see {@link stubLine}):
 *   KEPT      timestamp, toolName (the action), result (the outcome), durationMs, prevHash, anchorHash (genesis only)
 *   BLANKED   actor -> {id:'redacted',roles:[]}, args -> {}, resultDetail, approvalId (dropped)
 *   ADDED     redacted: { at, by:'workspace-erase', workspaceId, runId, origHash }
 *
 * The chain is NOT recomputed. Every line's `prevHash` is the sha256 of the previous line's ORIGINAL bytes, and the
 * blanked line's bytes changed, so its own hash can no longer be recomputed from the file. Instead the stub records
 * `origHash` (what the line hashed to before) and the next line's `prevHash` still has to equal it. Because anyone
 * who can write the file could otherwise claim "this was blanked" for a line they tampered with, a blanked line is
 * accepted only when (a) it is in the exact canonical stub form, and (b) a LATER marker entry (`audit.redacted`) of the
 * same run vouches for it: the marker carries the count and a digest over every `origHash:retainedDigest` pair of that
 * run, where the retained digest binds the kept fields. Altering a kept field, forging a stub, or dropping the marker
 * therefore fails verification. Unblanked lines verify exactly as before.
 *
 * Limits (honest): this is tamper-evidence, like the rest of the chain. A same-uid attacker can still append a forged
 * marker; the digest stops them from changing kept fields silently, and the forged marker is itself a visible entry.
 * The marker names the permanent workspace id only - never the workspace name, which can itself be client-identifying.
 */

import * as crypto from 'crypto';
import type { AuditEntry } from './audit.js';

/** Tool name of the marker entry that records a blank-out run. */
export const REDACT_MARKER_TOOL = 'audit.redacted';

/** Provenance block on a blanked line. */
export interface RedactBlock {
    at: string;
    by: 'workspace-erase';
    workspaceId: string;
    runId: string;
    /** sha256 of the line's ORIGINAL serialized bytes (+ '\n') - what the next line's prevHash must equal. */
    origHash: string;
}
export type RedactedEntry = AuditEntry & { redacted: RedactBlock };

const sha256 = (s: string): string => crypto.createHash('sha256').update(s, 'utf-8').digest('hex');

const isHex64 = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);

/** True when the entry carries a well-formed blank-out block. */
export function isRedactedEntry(e: Partial<AuditEntry> | null | undefined): e is RedactedEntry {
    const r = e?.redacted as Partial<RedactBlock> | undefined;
    return !!r && typeof r === 'object' && r.by === 'workspace-erase' && typeof r.at === 'string' && typeof r.workspaceId === 'string'
        && typeof r.runId === 'string' && r.runId !== '' && isHex64(r.origHash);
}

/** Digest of the fields a blanked line KEEPS, so the marker can vouch for them. */
export function retainedDigest(e: Pick<AuditEntry, 'timestamp' | 'toolName' | 'result' | 'durationMs' | 'prevHash' | 'anchorHash'>): string {
    return sha256(JSON.stringify([e.timestamp, e.toolName, e.result, e.durationMs ?? null, e.prevHash ?? null, e.anchorHash ?? null]));
}

/** The exact stub object for an entry (fixed key order). `kept` supplies the retained fields. */
function stubObject(kept: AuditEntry, block: RedactBlock): AuditEntry {
    return {
        timestamp: kept.timestamp,
        actor: { id: 'redacted', roles: [] },
        toolName: kept.toolName,
        args: {},
        result: kept.result,
        durationMs: kept.durationMs,
        prevHash: kept.prevHash ?? null,
        ...(kept.anchorHash ? { anchorHash: kept.anchorHash } : {}),
        redacted: block,
    };
}

/** Serialized stub line (with trailing newline) for an original entry + the hash of its original line. */
export function stubLine(orig: AuditEntry, origLine: string, meta: { at: string; workspaceId: string; runId: string }): string {
    const block: RedactBlock = { at: meta.at, by: 'workspace-erase', workspaceId: meta.workspaceId, runId: meta.runId, origHash: sha256(origLine + '\n') };
    return JSON.stringify(stubObject(orig, block)) + '\n';
}

/** `origHash:retainedDigest` - one run-digest input per blanked line. */
export function redactionPair(e: RedactedEntry): string {
    return `${e.redacted.origHash}:${retainedDigest(e)}`;
}

/** Digest over a run's pairs (order independent). */
export function runDigest(pairs: readonly string[]): string {
    return sha256([...pairs].sort().join('\n'));
}

/** The chain hash of a serialized line: a blanked line contributes its recorded original hash. */
export function chainHashOfLine(line: string): string {
    if (line.includes('"redacted"')) {
        try {
            const e = JSON.parse(line) as AuditEntry;
            if (isRedactedEntry(e)) return e.redacted.origHash;
        } catch { /* fall through: hash the bytes as-is */ }
    }
    return sha256(line + '\n');
}

/** True when the line is byte-for-byte the canonical stub of its own kept fields (nothing extra smuggled in). */
function isCanonicalStub(line: string, e: RedactedEntry): boolean {
    return line === JSON.stringify(stubObject(e, e.redacted));
}

/** Build the marker entry's args for a run. */
export function markerArgs(run: { runId: string; workspaceId: string; pairs: readonly string[]; recovered?: boolean }): Record<string, unknown> {
    return {
        runId: run.runId, workspaceId: run.workspaceId, count: run.pairs.length, digest: runDigest(run.pairs),
        ...(run.recovered ? { recovered: true } : {}),
    };
}

/**
 * Verifier helper. Feed it every record line in chain order (archives oldest -> newest, then live):
 *   `hashOf(line, entry)` -> the chain hash to use for the line, or an error string for a bad blanked line;
 *   `finish()` -> an error string when a blanked run has no marker.
 * `strict` (full history) also compares each marker's count + digest with the blanked lines seen; the live-file-only
 * verifier passes `strict:false` because the marker can cover lines that sit in rotated archives it cannot see.
 */
export class RedactionTracker {
    private readonly pending = new Map<string, { workspaceId: string; pairs: string[] }>();
    private readonly seenMarkers = new Set<string>();
    constructor(private readonly strict: boolean) {}

    hashOf(line: string, entry: AuditEntry): { hash: string } | { error: string } {
        if (entry.redacted === undefined) return { hash: sha256(line + '\n') };
        if (!isRedactedEntry(entry)) return { error: 'malformed blank-out block on a record' };
        if (!isCanonicalStub(line, entry)) return { error: 'a blanked record is not in the canonical blanked form (extra or altered content)' };
        if (this.seenMarkers.has(entry.redacted.runId)) return { error: 'a blanked record appears after its own run marker' };
        let run = this.pending.get(entry.redacted.runId);
        if (!run) { run = { workspaceId: entry.redacted.workspaceId, pairs: [] }; this.pending.set(entry.redacted.runId, run); }
        if (run.workspaceId !== entry.redacted.workspaceId) return { error: 'blanked records of one run name different workspaces' };
        run.pairs.push(redactionPair(entry));
        return { hash: entry.redacted.origHash };
    }

    /** Call for every parsed record (after hashOf). Returns an error string when a marker contradicts the blanked lines. */
    note(entry: AuditEntry): string | null {
        if (entry.toolName !== REDACT_MARKER_TOOL) return null;
        const a = entry.args as { runId?: unknown; workspaceId?: unknown; count?: unknown; digest?: unknown } | undefined;
        if (!a || typeof a.runId !== 'string') return 'malformed blank-out marker';
        const run = this.pending.get(a.runId);
        if (this.strict) {
            const pairs = run?.pairs ?? [];
            if (a.count !== pairs.length || a.digest !== runDigest(pairs) || (run && a.workspaceId !== run.workspaceId)) {
                return `blank-out marker for run ${a.runId} does not match the blanked records (marker lists ${String(a.count)}, found ${pairs.length})`;
            }
        }
        this.pending.delete(a.runId);
        this.seenMarkers.add(a.runId);
        return null;
    }

    finish(): string | null {
        if (this.pending.size === 0) return null;
        return `${[...this.pending.values()].reduce((n, r) => n + r.pairs.length, 0)} blanked record(s) have no blank-out marker vouching for them`;
    }
}

// ─── Matching ─────────────────────────────────────────────────────────────

/** A period during which some workspace (this one or another) held the name. null = unknown. */
export interface NameInterval { from: string | null; to: string | null }

export interface MatchTarget {
    /** Permanent workspace id. */
    id: string;
    name: string;
    /** When this workspace was created (null = unknown). */
    createdAt: string | null;
    /** When it was deleted. */
    deletedAt: string;
    /** Periods in which a DIFFERENT workspace held the same name (live: to=null; earlier deletions: their span). */
    others: readonly NameInterval[];
    /** Tolerance after deletion for the delete call's own entry, in ms. */
    graceMs?: number;
}

export type Classification = 'match' | 'ambiguous' | 'none';

const NAME_FIELDS = ['workspace', 'oldName', 'newName'] as const;

/** Names an entry's args attribute it to. `name` counts only on the `workspaces.*` tools, where it is the workspace name. */
function claimedNames(e: AuditEntry): string[] {
    const a = e.args as Record<string, unknown> | undefined;
    if (!a || typeof a !== 'object') return [];
    const out: string[] = [];
    for (const f of NAME_FIELDS) if (typeof a[f] === 'string') out.push(a[f] as string);
    if (e.toolName.startsWith('workspaces.') && typeof a.name === 'string') out.push(a.name);
    return out;
}

const within = (t: number, from: string | null, to: string | null, graceMs = 0): boolean =>
    (from === null || t >= Date.parse(from)) && (to === null || t <= Date.parse(to) + graceMs);

/**
 * Decide whether an entry belongs to the deleted workspace.
 *   match      the permanent id appears in its args, or its name matches inside this workspace's lifetime and no
 *              other workspace could have held that name at that time;
 *   ambiguous  the name matches at a time when another workspace could also have held it (or the time is unreadable);
 *   none       not attributable to this workspace.
 * Already-blanked records, continuation records and blank-out markers are never matches.
 */
export function classifyEntry(e: AuditEntry, t: MatchTarget): Classification {
    // Markers name the workspace id by design and must stay readable (they vouch for the blanked lines).
    if (e.redacted !== undefined || e.kind === 'continuation' || e.toolName === REDACT_MARKER_TOOL) return 'none';
    let argsText = '';
    try { argsText = JSON.stringify(e.args ?? {}); } catch { /* unserializable args cannot carry an id match */ }
    if (t.id.length >= 8 && argsText.includes(t.id)) return 'match';
    if (!claimedNames(e).includes(t.name)) return 'none';
    const ts = Date.parse(e.timestamp);
    if (!Number.isFinite(ts)) return 'ambiguous';
    if (!within(ts, t.createdAt, t.deletedAt, t.graceMs ?? 60_000)) return 'none';
    for (const o of t.others) if (within(ts, o.from, o.to, 0)) return 'ambiguous';
    return 'match';
}
