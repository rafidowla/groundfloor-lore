/**
 * authoring.ts — Schema authoring workflow (V3.0 Phase A1).
 *
 * Workflow per `lore-mem-know-soft-split-2026-05-07` decision B:
 * AI proposes → sandbox → human approves → live.
 *
 * Lifecycle:
 *
 *   propose(change) → SandboxId
 *      Stores the proposed change as a draft. Live schema is unchanged.
 *
 *   listProposals() → SandboxEntry[]
 *      All open proposals awaiting review.
 *
 *   getProposal(sandboxId) → SandboxEntry
 *      Read a single proposal (used by the curator UI).
 *
 *   approve(sandboxId, approver) → AppliedChange
 *      Validates the merged schema, writes new schema to .lore/schema.json,
 *      records a SchemaChangeAuditEntry, removes from sandbox.
 *
 *   reject(sandboxId, reviewer, reason) → void
 *      Move the proposal to the rejection log; do not touch live schema.
 *
 *   rollback(versionTag) → void
 *      Snapshot-based revert. Each approve() captures the prior schema
 *      under .lore/schema-history/<iso>.json. Rollback selects one and
 *      writes it back to schema.json + records the rollback in audit.
 *
 * Storage layout under workspace `.lore/`:
 *   schema.json                 — live schema (LoreSchemaV2)
 *   schema-sandbox/             — pending proposals as JSON files
 *   schema-history/             — point-in-time snapshots
 *   schema-rejected.jsonl       — rejection log (audit trail)
 *
 * Substrate-agnostic: this module touches disk only. Daemon callers wire
 * the SchemaLoader cache invalidation around approve()/rollback().
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import {
    SCHEMA_FORMAT_VERSION,
    validateSchema,
    type LoreSchemaV2,
    type NodeTypeSpec,
    type EdgeTypeSpec,
    type PermissionSchema,
    type ScopeSchema,
} from './types.js';
import {
    SchemaChangeAuditLogger,
    type SchemaChangeKind,
    type MigrationStrategy,
} from '../security/schemaChangeAudit.js';
import { assertHumanForDestructive, DESTRUCTIVE_CHANGE_KINDS } from './destructive.js';
import { NODE_FLOOR_FIELDS, EDGE_FLOOR_FIELDS } from './types.js';
import {
    noopSnapshotter,
    type DataSnapshotter,
    type SnapshotResult,
} from './dataSnapshot.js';
import { computeBlastRadius, type BlastRadius } from './blastRadius.js';
import type { SchemaGraphOps } from './substrate/schemaGraphOps.js';

/**
 * SchemaProposal — what the AI (or a human author) submits.
 *
 * Each proposal carries one or more discrete changes plus the resulting
 * full schema (so the approver sees the merged state, not just diffs).
 *
 * `changes` records each individual mutation so the audit log captures
 * the granular history. `migration` tells the approver what each change
 * costs (lazy = additive, dual-shape = breaking).
 */
export interface ProposedChange {
    kind: SchemaChangeKind;
    target: string;
    /** Human-readable explanation. */
    rationale?: string;
    migration: MigrationStrategy;
    /** Optional snapshots — `before` is empty for additive changes. */
    before?: unknown;
    after?: unknown;
}

export interface SchemaProposal {
    /** The full merged schema as it would be after approval. */
    nextSchema: LoreSchemaV2;
    /** Discrete changes captured for audit. */
    changes: ProposedChange[];
    proposedBy: string;
    /** Free-form note shown to the approver. */
    note?: string;
}

/**
 * Floor-field protection (2026-05-17 fix). The seven NODE_FLOOR_FIELDS
 * and five EDGE_FLOOR_FIELDS are required on every node/edge regardless
 * of workspace schema; removing one would corrupt the substrate. Block
 * at proposal time so reviewers don't even see them in the queue.
 */
function assertNoFloorFieldRemoval(changes: ProposedChange[]): void {
    const nodeFloor: ReadonlySet<string> = new Set(NODE_FLOOR_FIELDS);
    const edgeFloor: ReadonlySet<string> = new Set(EDGE_FLOOR_FIELDS);
    for (const c of changes) {
        if (c.kind !== 'field.removed') continue;
        // target is "<TypeName>.<fieldName>"; we don't know whether the
        // type is a node or an edge without consulting the schema, so
        // reject if EITHER set contains the field name. False positives
        // here would only occur if a workspace defined a field named
        // (e.g.) "id" that is NOT the floor id — which the schema floor
        // already forbids.
        const dot = c.target.lastIndexOf('.');
        if (dot < 0) continue;
        const fieldName = c.target.slice(dot + 1);
        if (nodeFloor.has(fieldName) || edgeFloor.has(fieldName)) {
            throw new Error(
                `[schema-authoring] floor field '${fieldName}' is immutable and cannot be removed ` +
                `(target: ${c.target}). NODE_FLOOR_FIELDS=${NODE_FLOOR_FIELDS.join(',')}; ` +
                `EDGE_FLOOR_FIELDS=${EDGE_FLOOR_FIELDS.join(',')}.`,
            );
        }
    }
}

export interface SandboxEntry {
    sandboxId: string;
    proposal: SchemaProposal;
    proposedAt: string;
    /** Hash of the next schema for de-dup detection. */
    nextSchemaHash: string;
    /**
     * Phase 3 item 1 — affected-row count per change, computed at
     * propose-time against the live graph. Optional because legacy
     * sandbox files predate this field and because tests may
     * construct stores without a graph reader. When present, the
     * REST / MCP proposal listings surface it to the approver.
     */
    blastRadius?: BlastRadius;
}

export interface ApprovalReceipt {
    sandboxId: string;
    approvedBy: string;
    approvedAt: string;
    schemaVersion: number;
    changes: ProposedChange[];
    /**
     * Phase 1 item 3 — per-destructive-change data snapshots taken
     * BEFORE the schema flip. Empty array if the proposal contains
     * no destructive changes or the snapshotter is the no-op.
     */
    dataSnapshots: SnapshotResult[];
}

export interface RejectionRecord {
    sandboxId: string;
    rejectedBy: string;
    rejectedAt: string;
    reason: string;
    proposalSnapshot: SchemaProposal;
}

export class SchemaAuthoringStore {
    private readonly loreDir: string;
    private readonly schemaPath: string;
    private readonly sandboxDir: string;
    private readonly historyDir: string;
    private readonly dataSnapshotsDir: string;
    /** Audit C2 (L-002) — approved (kind,target) op set keyed by sandboxId,
     *  so the migration executor can reject ops that were never approved. */
    private readonly approvedOpsDir: string;
    private readonly rejectedPath: string;
    private readonly audit: SchemaChangeAuditLogger;
    private readonly snapshotter: DataSnapshotter;
    private readonly graphReader: SchemaGraphOps | undefined;

    constructor(
        workspaceDir: string,
        audit?: SchemaChangeAuditLogger,
        snapshotter?: DataSnapshotter,
        graphReader?: SchemaGraphOps,
    ) {
        this.loreDir = path.join(workspaceDir, '.lore');
        this.schemaPath = path.join(this.loreDir, 'schema.json');
        this.sandboxDir = path.join(this.loreDir, 'schema-sandbox');
        this.historyDir = path.join(this.loreDir, 'schema-history');
        this.dataSnapshotsDir = path.join(this.loreDir, 'data-snapshots');
        this.approvedOpsDir = path.join(this.loreDir, 'schema-approved-ops');
        this.rejectedPath = path.join(this.loreDir, 'schema-rejected.jsonl');
        fs.mkdirSync(this.sandboxDir, { recursive: true });
        fs.mkdirSync(this.historyDir, { recursive: true });
        fs.mkdirSync(this.approvedOpsDir, { recursive: true });
        this.audit = audit ?? new SchemaChangeAuditLogger(this.loreDir);
        // Default opts out of data snapshotting — preserves the
        // pre-Phase-1 behavior for callers (and tests) that don't
        // wire a snapshotter. Production wires LocalGraphSnapshotter
        // in services.ts.
        this.snapshotter = snapshotter ?? noopSnapshotter;
        // Phase 3 item 1 — optional graph reader for blast-radius
        // computation at propose-time. Tests + cloud-mode boots that
        // don't need it pass undefined and the SandboxEntry simply
        // omits the blastRadius field.
        this.graphReader = graphReader;
    }

    /**
     * Submit a new proposal. Returns the sandbox id.
     *
     * Async because Phase 3 item 1 computes blast radius (affected-
     * row counts per change) against the live graph at propose-time
     * — that's an I/O round trip. Blast radius is best-effort: if no
     * graph reader is wired, or the read throws, the proposal still
     * persists; the `blastRadius` field on the SandboxEntry is just
     * absent or carries `null` per-change counts with a `note`.
     */
    async propose(proposal: SchemaProposal): Promise<SandboxEntry> {
        validateProposal(proposal);
        // Phase 1 safety guard — destructive change kinds require a
        // human proposer. See packages/lore/src/schemas/destructive.ts
        // and docs/architecture/SCHEMA_CHANGE_SAFETY_MEMO.md.
        assertHumanForDestructive(proposal);
        // 2026-05-17 fix — floor-field protection at proposal time.
        // NODE_FLOOR_FIELDS and EDGE_FLOOR_FIELDS are immutable per the
        // safety memo; removing one would corrupt every node/edge in
        // the workspace. validateSchema may catch this at approve time
        // but the earlier we reject, the less wasted reviewer attention.
        assertNoFloorFieldRemoval(proposal.changes);
        const validation = validateSchema(proposal.nextSchema);
        if (!validation.valid) {
            throw new Error(
                `[schema-authoring] proposal's nextSchema is invalid: ${validation.errors.join('; ')}`,
            );
        }
        const sandboxId = randomUUID();
        const proposedAt = new Date().toISOString();
        const nextSchemaHash = hashSchema(proposal.nextSchema);

        // Phase 3 item 1 — best-effort blast radius. Failures are
        // recorded in-band by computeBlastRadius itself; an absent
        // graph reader simply omits the field.
        let blastRadius: BlastRadius | undefined;
        if (this.graphReader) {
            try {
                blastRadius = await computeBlastRadius(proposal.changes, this.graphReader);
            } catch {
                // computeBlastRadius shouldn't throw — but be defensive.
                blastRadius = undefined;
            }
        }

        const entry: SandboxEntry = {
            sandboxId, proposal, proposedAt, nextSchemaHash,
            ...(blastRadius ? { blastRadius } : {}),
        };
        fs.writeFileSync(
            path.join(this.sandboxDir, `${sandboxId}.json`),
            JSON.stringify(entry, null, 2),
            { encoding: 'utf-8' },
        );
        return entry;
    }

    listProposals(): SandboxEntry[] {
        if (!fs.existsSync(this.sandboxDir)) return [];
        const out: SandboxEntry[] = [];
        for (const file of fs.readdirSync(this.sandboxDir)) {
            if (!file.endsWith('.json')) continue;
            try {
                const raw = fs.readFileSync(path.join(this.sandboxDir, file), 'utf-8');
                out.push(JSON.parse(raw) as SandboxEntry);
            } catch { /* skip malformed */ }
        }
        return out.sort((a, b) => a.proposedAt.localeCompare(b.proposedAt));
    }

    getProposal(sandboxId: string): SandboxEntry | null {
        // B2 (audit 2026-06-18) — validate sandboxId is a bare id before it
        // touches path.join, mirroring getApprovedOps/rollback below. An
        // unsanitized id allowed '../' traversal: getProposal would read, and
        // approve()/reject() (which call getProposal then fs.unlinkSync the
        // same path) would delete, arbitrary .json files. The route layer
        // (proposals.ts) was also ungated (B1), so a read-only token reached
        // here. Returning null on a bad id is the same not-found contract.
        if (!/^[A-Za-z0-9_-]+$/.test(sandboxId)) return null;
        const p = path.join(this.sandboxDir, `${sandboxId}.json`);
        if (!fs.existsSync(p)) return null;
        try { return JSON.parse(fs.readFileSync(p, 'utf-8')) as SandboxEntry; }
        catch { return null; }
    }

    /**
     * Approve a proposal.
     *
     * Order of operations (load-bearing):
     *   1. Validate approver + sandbox.
     *   2. Phase 1 item 3 — for every destructive change in the
     *      proposal, snapshot affected data to .lore/data-snapshots/
     *      via the wired DataSnapshotter. **If any snapshot throws,
     *      abort the entire approval** — live schema stays untouched.
     *      This is the safety property the design memo
     *      (docs/architecture/SCHEMA_CHANGE_SAFETY_MEMO.md) is built on.
     *   3. Snapshot the current schema to .lore/schema-history/.
     *   4. Atomically write the new live schema.
     *   5. Append audit entries.
     *   6. Remove the sandbox file.
     */
    async approve(sandboxId: string, approver: string, note?: string): Promise<ApprovalReceipt> {
        if (!approver) throw new Error('approve() requires an approver id');
        // B2 — defense-in-depth: reject a traversal id explicitly (getProposal
        // would also return null, but approve() builds its own path.join for
        // the approved-ops record + the sandbox unlink, so guard at the top).
        if (!/^[A-Za-z0-9_-]+$/.test(sandboxId)) throw new Error(`invalid sandboxId '${sandboxId}'`);
        const entry = this.getProposal(sandboxId);
        if (!entry) throw new Error(`sandbox '${sandboxId}' not found`);

        const approvedAt = new Date().toISOString();

        // (2) Per-destructive-change data snapshots. Captured BEFORE
        // the schema flip so the data exists when we read it. If
        // anything throws, the live schema is not touched and the
        // operator can re-attempt approval after resolving the
        // underlying snapshot failure (e.g. substrate unreachable).
        const dataSnapshots: SnapshotResult[] = [];
        const destructiveChanges = entry.proposal.changes.filter(
            c => DESTRUCTIVE_CHANGE_KINDS.has(c.kind),
        );
        if (destructiveChanges.length > 0) {
            fs.mkdirSync(this.dataSnapshotsDir, { recursive: true });
            for (const change of destructiveChanges) {
                try {
                    const r = await this.snapshotter.snapshotForChange(change, {
                        sandboxId,
                        snapshotsDir: this.dataSnapshotsDir,
                        isoTimestamp: approvedAt,
                    });
                    dataSnapshots.push(r);
                } catch (err) {
                    throw new Error(
                        `[schema-authoring] aborting approval — data snapshot failed for ` +
                        `${change.kind}(${change.target}): ${(err as Error).message}. ` +
                        `Live schema unchanged. Re-attempt approval after resolving the ` +
                        `snapshot failure (e.g. confirm the graph is reachable).`,
                    );
                }
            }
        }

        // (3) Snapshot current SCHEMA (might be a default if schema.json absent).
        const currentSchema = this.readLiveSchema();
        const snapshotName = `${approvedAt.replace(/[:.]/g, '-')}_${sandboxId}.json`;
        fs.writeFileSync(
            path.join(this.historyDir, snapshotName),
            JSON.stringify(currentSchema ?? {}, null, 2),
            { encoding: 'utf-8' },
        );

        // (4) Write new schema atomically (write-rename).
        const tmp = `${this.schemaPath}.tmp.${randomUUID()}`;
        fs.writeFileSync(tmp, JSON.stringify(entry.proposal.nextSchema, null, 2), { encoding: 'utf-8' });
        fs.renameSync(tmp, this.schemaPath);

        // (4b) Audit C2 (L-002) — persist the canonical approved operation
        // set keyed by sandboxId. POST /api/schema/migrations/execute reads
        // this back and refuses any op (kind,target) that was not approved,
        // closing approve-benign-then-execute-arbitrary. Stored in the same
        // {kind,target} vocabulary MigrationOp uses (the destructive change
        // kinds share their string values with MigrationOpKind). Written
        // atomically; a failure here does NOT roll back the schema flip
        // (the flip already committed) but leaves the sandbox unexecutable
        // until re-approved — fail-closed, the safe direction.
        const approvedOps = entry.proposal.changes.map(c => ({ kind: c.kind, target: c.target }));
        const opsRecordPath = path.join(this.approvedOpsDir, `${sandboxId}.json`);
        const opsTmp = `${opsRecordPath}.tmp.${randomUUID()}`;
        // F-M05 (approve/execute TOCTOU) — bind an integrity tag over the
        // canonical approved-ops list (+ sandboxId) so the execute/resume/
        // rollback correlation can detect tampering/substitution of this
        // record between approve-time and execute-time. The approved-ops file
        // is plain JSON on disk; without this tag a privileged-disk attacker
        // (or a stale/substituted file) could swap the approved (kind,target)
        // set after a benign approval and have execute correlate against the
        // forged set. getApprovedOps() recomputes this hash on read and
        // returns null (fail-closed → execute 404s) if it does not match.
        //
        // RESIDUAL (follow-up): this is an integrity *hash*, not a *signature* —
        // it detects accidental/naive tampering and substitution-with-wrong-
        // hash, but an attacker who can write the file can also recompute the
        // hash. Full MAC/signing (keyed HMAC over the record with a daemon
        // secret, or Ed25519) is the complete close and is left as follow-up;
        // the minimal hash binding is shipped here per F-M05's "at minimum
        // store the hash and verify it at execute time".
        const integrity = computeApprovedOpsIntegrity(sandboxId, approvedOps);
        fs.writeFileSync(
            opsTmp,
            JSON.stringify({ sandboxId, approvedBy: approver, approvedAt, ops: approvedOps, integrity }, null, 2),
            { encoding: 'utf-8' },
        );
        fs.renameSync(opsTmp, opsRecordPath);

        // Record per-change audit entries.
        for (const change of entry.proposal.changes) {
            this.audit.append({
                at: approvedAt,
                workspace: deriveWorkspaceFromDir(this.loreDir),
                schemaVersionAfter: entry.proposal.nextSchema.version,
                kind: change.kind,
                target: change.target,
                proposedBy: entry.proposal.proposedBy,
                approvedBy: approver,
                migration: change.migration,
                before: change.before,
                after: change.after,
                note: note ?? entry.proposal.note,
            });
        }

        // Remove from sandbox.
        fs.unlinkSync(path.join(this.sandboxDir, `${sandboxId}.json`));

        return {
            sandboxId,
            approvedBy: approver,
            approvedAt,
            schemaVersion: entry.proposal.nextSchema.version,
            changes: entry.proposal.changes,
            dataSnapshots,
        };
    }

    /** Reject a proposal. Appends to schema-rejected.jsonl, removes sandbox file. */
    reject(sandboxId: string, reviewer: string, reason: string): RejectionRecord {
        if (!reviewer) throw new Error('reject() requires a reviewer id');
        if (!reason) throw new Error('reject() requires a reason');
        // B2 — defense-in-depth: reject a traversal id before the unlinkSync.
        if (!/^[A-Za-z0-9_-]+$/.test(sandboxId)) throw new Error(`invalid sandboxId '${sandboxId}'`);
        const entry = this.getProposal(sandboxId);
        if (!entry) throw new Error(`sandbox '${sandboxId}' not found`);
        const record: RejectionRecord = {
            sandboxId,
            rejectedBy: reviewer,
            rejectedAt: new Date().toISOString(),
            reason,
            proposalSnapshot: entry.proposal,
        };
        fs.appendFileSync(this.rejectedPath, JSON.stringify(record) + '\n', { encoding: 'utf-8' });
        fs.unlinkSync(path.join(this.sandboxDir, `${sandboxId}.json`));
        return record;
    }

    /** Snapshot history file names (relative). */
    listHistory(): string[] {
        if (!fs.existsSync(this.historyDir)) return [];
        return fs.readdirSync(this.historyDir).filter(f => f.endsWith('.json')).sort();
    }

    /**
     * Audit C2 (L-002) — the approved (kind,target) operation set for a
     * sandbox, or null when the sandbox was never approved (or was approved
     * before approved-ops recording shipped — fail-closed: execute then
     * refuses with 404 rather than trusting an unverifiable plan). The
     * migration executor compares plan.ops against this set so a benign
     * approval can't authorize arbitrary destructive ops.
     */
    getApprovedOps(sandboxId: string): { sandboxId: string; approvedBy: string; approvedAt: string; ops: Array<{ kind: string; target: string }>; integrity?: string } | null {
        // Validate the sandboxId is a bare id (UUID-shaped) before it touches
        // the filesystem — a caller-supplied `../`-style id must not let
        // path.join escape approvedOpsDir to read an arbitrary .json file.
        if (!/^[A-Za-z0-9_-]+$/.test(sandboxId)) return null;
        const p = path.join(this.approvedOpsDir, `${sandboxId}.json`);
        if (!fs.existsSync(p)) return null;
        try {
            const rec = JSON.parse(fs.readFileSync(p, 'utf-8')) as {
                sandboxId: string; approvedBy: string; approvedAt: string;
                ops: Array<{ kind: string; target: string }>;
                integrity?: string;
            };
            // F-M05 — verify the approved-ops record has not been tampered with
            // or substituted since approval. Records written by approve() carry
            // an integrity tag over (sandboxId, canonical ops); recompute it and
            // fail closed (return null → execute/resume/rollback respond 404
            // unknown_sandbox) on any mismatch or on a missing tag (a record
            // that predates this binding, or was hand-crafted to omit it, is
            // unverifiable and must not be trusted). Also bind the embedded
            // sandboxId to the requested one so a record cannot be swapped under
            // a different id's filename. See RESIDUAL note in approve().
            if (typeof rec.integrity !== 'string') return null;
            if (rec.sandboxId !== sandboxId) return null;
            const expected = computeApprovedOpsIntegrity(rec.sandboxId, rec.ops ?? []);
            if (rec.integrity !== expected) return null;
            return rec;
        } catch { return null; }
    }

    /**
     * Roll back to a prior snapshot. The current schema becomes part of
     * history (so rollback is itself reversible). Audit gets a single
     * entry per change kind that the rollback flips. Coarse: we record
     * one `schema.rolled-back` style entry under workspace.* family
     * because per-field diff is expensive and rollback is rare.
     */
    rollback(historyFileName: string, actor: string): void {
        if (!actor) throw new Error('rollback() requires an actor id');
        // L-020 — reject path-traversal in the caller-supplied snapshot name
        // before it touches path.join. Mirrors getApprovedOps's guard; the
        // charset permits '.', '_', '-' so legitimate snapshot names like
        // '<iso-with-dashes>_<sandboxId>.json' still pass, while '/', '\\',
        // and '..%2f'-decoded separators are rejected.
        if (!/^[0-9A-Za-z._-]+$/.test(historyFileName)) {
            throw new Error('invalid history snapshot name');
        }
        const file = path.join(this.historyDir, historyFileName);
        if (!fs.existsSync(file)) throw new Error(`history snapshot not found: ${historyFileName}`);
        const target = JSON.parse(fs.readFileSync(file, 'utf-8')) as LoreSchemaV2;
        const validation = validateSchema(target);
        if (!validation.valid) {
            throw new Error(
                `[schema-authoring] history snapshot is invalid: ${validation.errors.join('; ')}`,
            );
        }
        // Snapshot current first so rollback is itself reversible.
        const current = this.readLiveSchema();
        const snapshotName = `${new Date().toISOString().replace(/[:.]/g, '-')}_pre-rollback.json`;
        fs.writeFileSync(
            path.join(this.historyDir, snapshotName),
            JSON.stringify(current ?? {}, null, 2),
            { encoding: 'utf-8' },
        );
        // Write target as live.
        fs.writeFileSync(this.schemaPath, JSON.stringify(target, null, 2), { encoding: 'utf-8' });
        // Audit (coarse — one entry; not per-field).
        this.audit.append({
            at: new Date().toISOString(),
            workspace: deriveWorkspaceFromDir(this.loreDir),
            schemaVersionAfter: target.version,
            kind: 'workspace.system_prompt_changed',
            target: `rollback:${historyFileName}`,
            proposedBy: actor,
            approvedBy: actor,
            migration: 'not-applicable',
            note: `rolled back to ${historyFileName}`,
        });
    }

    private readLiveSchema(): LoreSchemaV2 | null {
        if (!fs.existsSync(this.schemaPath)) return null;
        try { return JSON.parse(fs.readFileSync(this.schemaPath, 'utf-8')) as LoreSchemaV2; }
        catch { return null; }
    }
}

/* ---------- proposal helpers ---------- */

/**
 * Build a proposal from a list of changes applied to a base schema.
 * The helper computes the merged `nextSchema` so callers don't have to
 * track the merged state themselves.
 */
export function buildProposal(input: {
    base: LoreSchemaV2;
    changes: ProposedChange[];
    proposedBy: string;
    note?: string;
    transforms?: {
        addNodeType?: NodeTypeSpec;
        removeNodeType?: string;
        addEdgeType?: EdgeTypeSpec;
        removeEdgeType?: string;
        setPermissions?: PermissionSchema;
        setScopes?: ScopeSchema;
    };
}): SchemaProposal {
    const next: LoreSchemaV2 = JSON.parse(JSON.stringify(input.base));
    next.version = SCHEMA_FORMAT_VERSION;
    const t = input.transforms ?? {};
    if (t.addNodeType) next.nodeTypes.push(t.addNodeType);
    if (t.removeNodeType) {
        next.nodeTypes = next.nodeTypes.filter(n => n.name !== t.removeNodeType);
    }
    if (t.addEdgeType) next.edgeTypes.push(t.addEdgeType);
    if (t.removeEdgeType) {
        next.edgeTypes = next.edgeTypes.filter(e => e.name !== t.removeEdgeType);
    }
    if (t.setPermissions) next.permissions = t.setPermissions;
    if (t.setScopes) next.scopes = t.setScopes;
    return {
        nextSchema: next,
        changes: input.changes,
        proposedBy: input.proposedBy,
        note: input.note,
    };
}

/* ---------- internals ---------- */

function validateProposal(p: SchemaProposal): void {
    if (!p.nextSchema) throw new Error('proposal missing nextSchema');
    if (!Array.isArray(p.changes) || p.changes.length === 0) {
        throw new Error('proposal must list at least one change');
    }
    if (!p.proposedBy) throw new Error('proposal missing proposedBy');
    for (const c of p.changes) {
        if (!c.kind) throw new Error('proposal change missing kind');
        if (!c.target) throw new Error('proposal change missing target');
        if (!c.migration) throw new Error('proposal change missing migration');
    }
}

function hashSchema(s: LoreSchemaV2): string {
    return 'sha256:' + createHash('sha256').update(JSON.stringify(s)).digest('hex').slice(0, 16);
}

/**
 * F-M05 — integrity tag bound to an approved-ops record. Hashes the sandboxId
 * together with a CANONICAL, order-independent serialization of the (kind,
 * target) op set, so the same approved set always yields the same tag and any
 * tamper/substitution of the ops (or the id) changes it. getApprovedOps()
 * recomputes this on read and rejects the record on mismatch (fail-closed).
 *
 * Canonical form: each op reduced to {kind,target}, the list sorted by a
 * derived "kind target" key (so re-ordering the array does not change the
 * tag), then JSON-encoded with sandboxId. Targets are trimmed but otherwise
 * stored verbatim — this hash protects the record as-written; the migration
 * route layer (canonicalSig) handles cosmetic target equivalence at correlation
 * time (F-M06). NOT a keyed MAC — see the RESIDUAL note at approve().
 */
function computeApprovedOpsIntegrity(
    sandboxId: string,
    ops: ReadonlyArray<{ kind: string; target: string }>,
): string {
    const canonicalOps = ops
        .map(o => ({ kind: String(o.kind ?? ''), target: String(o.target ?? '').trim() }))
        .sort((a, b) => `${a.kind} ${a.target}`.localeCompare(`${b.kind} ${b.target}`));
    const payload = JSON.stringify({ sandboxId, ops: canonicalOps });
    return 'sha256:' + createHash('sha256').update(payload).digest('hex');
}

function deriveWorkspaceFromDir(loreDir: string): string {
    // Last segment of the path housing .lore — ad-hoc but adequate for audit.
    const parent = path.dirname(loreDir);
    return path.basename(parent) || 'unknown';
}
