/**
 * rebac.ts — ReBAC L1 (relation edges) over SQLite.
 *
 * Encodes lore-rebac-two-layer-2026-05-07: five platform-locked relation
 * edge types — owner, editor, viewer, member, parent — stored as tuples in a
 * single SQLite table (`lore_rebac_edge`), separate from the semantic graph.
 *
 * ReBAC edges are kept apart from LoreEdge (not multiplexed onto it) because:
 *   - Audit and permission-check code paths are operationally distinct from
 *     semantic / knowledge edges.
 *   - The table can later be cut over to SpiceDB in cloud mode without
 *     touching the semantic edge surface.
 *   - Permission queries are hot-path; a dedicated table = simpler indexing.
 *   - They outlived the graph engine they were born in, which is the point:
 *     nothing about a permission tuple was ever graph-shaped.
 *
 * This file owns L1 only: grant / revoke / has / list. The L2 evaluator
 * (PermissionSchema → action checks) lives in `rebacEvaluator.ts` (T1c).
 */

import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import {
    REBAC_RELATION_EDGE_NAMES,
    type LoreSchemaV2,
} from '../schemas/types.js';

/** Five platform-locked ReBAC relation names. */
export type RebacRelation = 'owner' | 'editor' | 'viewer' | 'member' | 'parent';

const REBAC_RELATION_SET = new Set<string>(REBAC_RELATION_EDGE_NAMES);

export function isRebacRelation(name: string): name is RebacRelation {
    return REBAC_RELATION_SET.has(name);
}

/**
 * One row in LoreRebacEdge. All ReBAC edges are subject→resource; both
 * stored as LoreNode primary keys. The `relation` column carries the
 * relation name (one of REBAC_RELATION_EDGE_NAMES).
 *
 * `grantedBy` is the subject id of whoever (user or system) granted the
 * relation — recorded for audit. `expiresAt` is reserved for time-bound
 * grants; empty string means "no expiry."
 */
export interface RebacGrantInput {
    subject: string;
    relation: RebacRelation;
    resource: string;
    grantedBy: string;
    expiresAt?: string;
}

export interface RebacEdge {
    subject: string;
    relation: RebacRelation;
    resource: string;
    grantedAt: string;
    grantedBy: string;
    expiresAt: string;
}

/**
 * Raised when `grant()` could not produce the edge it was asked for.
 *
 * A named type rather than a bare `Error` so a caller can distinguish "the
 * grant is impossible here" from any other failure — and specifically so it is
 * never confused with `grant()`'s `false`, which means "the edge already
 * existed, idempotent no-op". Overloading `false` would make a FAILED grant
 * indistinguishable from a SUCCESSFUL one at the call site, which is the exact
 * ambiguity this class exists to prevent.
 */
export class RebacGrantFailedError extends Error {
    public readonly code = 'rebac_grant_failed' as const;
    public readonly subject: string;
    public readonly relation: string;
    public readonly resource: string;
    constructor(message: string, ctx: { subject: string; relation: string; resource: string }) {
        super(message);
        this.name = 'RebacGrantFailedError';
        this.subject = ctx.subject;
        this.relation = ctx.relation;
        this.resource = ctx.resource;
    }
}

const NOW = (): string => new Date().toISOString();

function assertRelation(name: string): asserts name is RebacRelation {
    if (!isRebacRelation(name)) {
        throw new Error(
            `[rebac] '${name}' is not a ReBAC relation. ` +
            `Allowed: ${REBAC_RELATION_EDGE_NAMES.join(', ')}.`,
        );
    }
}

/**
 * RebacStore — relation tuples in SQLite, endpoint validation delegated.
 *
 * ── WHY THIS IS NO LONGER A KÙZU DAO ────────────────────────────────────────
 *
 * ReBAC edges were a Kùzu `REL TABLE` anchored to `LoreNode` endpoints. That
 * anchoring is what made the subsystem engine-bound, and DEC-SURREAL-REBAC
 * recorded the consequence: on a workspace whose graph is NOT Kùzu, the Kùzu
 * `LoreNode` table is present and EMPTY, so every grant matched nothing. The
 * decision at the time was "leave it on Kùzu, nothing calls it" — a position
 * that only held while Kùzu existed. It does not survive Kùzu removal, so this
 * revisits it deliberately, which is exactly what arch rule D-023 exists to
 * force.
 *
 * ── WHAT CHANGED, AND WHY IT IS AN IMPROVEMENT RATHER THAN A TRANSLATION ────
 *
 * The tuples themselves were never graph-shaped: `(subject, relation,
 * resource)` with four scalar properties, queried only by exact endpoints. They
 * are rows, and they are now rows.
 *
 * The part that WAS graph-shaped — "do both endpoints exist as real nodes?" —
 * is not deleted, it is INJECTED. `nodeExists` is supplied by the caller and
 * backed by whatever graph the workspace actually runs. So the check that used
 * to work only on Kùzu now works on every engine, and the empty-LoreNode hole
 * DEC-SURREAL-REBAC documented is closed rather than inherited.
 *
 * A store with no probe is REFUSED at construction rather than defaulting to
 * "assume the endpoints exist". Silently skipping endpoint validation in an
 * authorization store is the same class of bug the `RebacGrantFailedError`
 * pre-flight was written to prevent: a grant that reports success and grants
 * nothing.
 *
 * Construction is cheap; reuse one instance per workspace.
 */

/**
 * Which of `ids` exist as real graph nodes. Returns the subset that does.
 *
 * A set rather than a boolean pair so a self-grant (subject === resource)
 * resolves correctly, and so the implementation can answer in one round trip.
 */
export type NodeExistsProbe = (ids: string[]) => Promise<Set<string>>;

const REBAC_TABLE = 'lore_rebac_edge';

export class RebacStore {
    private readonly db: DatabaseType;
    private readonly nodeExists: NodeExistsProbe;

    /**
     * @param dbPath     SQLite file, or ':memory:'.
     * @param nodeExists Endpoint probe backed by the workspace's graph.
     */
    constructor(dbPath: string, nodeExists: NodeExistsProbe) {
        if (typeof nodeExists !== 'function') {
            throw new Error(
                '[rebac] RebacStore requires a nodeExists probe. Without it, grant() cannot '
                + 'tell a real endpoint from a missing one and would create edges that no '
                + 'permission check can ever match.',
            );
        }
        this.db = new Database(dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');
        this.nodeExists = nodeExists;
    }

    close(): void {
        if (this.db.open) this.db.close();
    }

    /**
     * Idempotent DDL. Safe across reboots.
     *
     * The primary key is `(subject, relation, resource)` — the identity of a
     * grant. On Kùzu this uniqueness was maintained by `grant()` checking
     * `has()` first, which is a race; here the schema enforces it, so a
     * duplicate cannot be created even by two concurrent granters.
     */
    async ensureSchema(): Promise<void> {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS ${REBAC_TABLE} (
                subject   TEXT NOT NULL,
                relation  TEXT NOT NULL,
                resource  TEXT NOT NULL,
                grantedAt TEXT NOT NULL,
                grantedBy TEXT NOT NULL,
                expiresAt TEXT NOT NULL DEFAULT '',
                PRIMARY KEY (subject, relation, resource)
            );
            CREATE INDEX IF NOT EXISTS ${REBAC_TABLE}_resource ON ${REBAC_TABLE}(resource, relation);
            CREATE INDEX IF NOT EXISTS ${REBAC_TABLE}_subject  ON ${REBAC_TABLE}(subject, relation);
        `);
    }

    /**
     * Grant a relation. Idempotent: an existing (subject, relation, resource)
     * is a no-op returning false. Returns true when a new edge was created.
     *
     * THROWS `RebacGrantFailedError` when the grant could not be produced.
     * Both original checks are kept, for their original reasons:
     *
     *   1. Pre-flight endpoint probe, so the error names WHICH endpoint is
     *      missing instead of sending the reader hunting.
     *   2. Post-write existence check, which is the authoritative one — it
     *      catches every cause of failure, not only the predicted one.
     *
     * (2) is cheap here and was load-bearing on Kùzu, where `MATCH … CREATE`
     * with an absent endpoint bound nothing, created nothing, raised nothing,
     * and returned success. A silent false success in an authorization
     * function is the worst shape of bug available in this file.
     */
    async grant(input: RebacGrantInput): Promise<boolean> {
        assertRelation(input.relation);
        if (await this.has(input.subject, input.relation, input.resource)) {
            return false;
        }

        // (1) Pre-flight: name the missing endpoint rather than failing blind.
        const present = await this.nodeExists([input.subject, input.resource]);
        const missing: string[] = [];
        if (!present.has(input.subject)) missing.push(`subject '${input.subject}'`);
        if (!present.has(input.resource)) missing.push(`resource '${input.resource}'`);
        if (missing.length > 0) {
            throw new RebacGrantFailedError(
                `rebac grant failed: ${missing.join(' and ')} not found as a graph node. `
                + 'The grant would create an edge no permission check could ever match.',
                { subject: input.subject, relation: input.relation, resource: input.resource },
            );
        }

        const grantedAt = NOW();
        this.db.prepare(
            `INSERT OR REPLACE INTO ${REBAC_TABLE}
                (subject, relation, resource, grantedAt, grantedBy, expiresAt)
             VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
            input.subject, input.relation, input.resource,
            grantedAt, input.grantedBy, input.expiresAt ?? '',
        );

        // (2) Authoritative. Uses the expiry-INSENSITIVE probe on purpose:
        // `has()` hides expired edges, so verifying with it would throw on a
        // caller who legitimately grants an already-past `expiresAt` — the
        // write succeeded, the grant is just already dead.
        if (!this.edgeExists(input.subject, input.relation, input.resource)) {
            throw new RebacGrantFailedError(
                'rebac grant failed: the edge does not exist after INSERT. The statement '
                + 'reported no error but produced no row — treat this as a substrate fault, '
                + 'not a permissions decision.',
                { subject: input.subject, relation: input.relation, resource: input.resource },
            );
        }
        return true;
    }

    /**
     * Does this exact edge exist, IGNORING expiry?
     *
     * Distinct from `has()`, which is the permission question and must exclude
     * expired grants. This is the write-verification question: did the write
     * land? An expired edge is a real edge.
     */
    private edgeExists(subject: string, relation: RebacRelation, resource: string): boolean {
        const row = this.db.prepare(
            `SELECT 1 AS c FROM ${REBAC_TABLE}
              WHERE subject = ? AND relation = ? AND resource = ?`,
        ).get(subject, relation, resource);
        return row !== undefined;
    }

    /**
     * Drop every tuple. Test-support only — there is no product operation that
     * revokes all grants at once, and there should not be one.
     */
    async clearAll(): Promise<void> {
        this.db.prepare(`DELETE FROM ${REBAC_TABLE}`).run();
    }

    /** Revoke a relation. True if an edge was removed; no-op if absent. */
    async revoke(subject: string, relation: RebacRelation, resource: string): Promise<boolean> {
        assertRelation(relation);
        if (!(await this.has(subject, relation, resource))) {
            return false;
        }
        const res = this.db.prepare(
            `DELETE FROM ${REBAC_TABLE} WHERE subject = ? AND relation = ? AND resource = ?`,
        ).run(subject, relation, resource);
        return res.changes > 0;
    }

    /** Direct relation check (no inheritance). True iff the exact edge exists. */
    async has(subject: string, relation: RebacRelation, resource: string): Promise<boolean> {
        assertRelation(relation);
        // RA2-reaudit2 — enforce time-bound grants: exclude expired edges
        // (expiresAt='' means no expiry). ISO-8601 UTC compares lexicographically.
        const row = this.db.prepare(
            `SELECT 1 AS c FROM ${REBAC_TABLE}
              WHERE subject = ? AND relation = ? AND resource = ?
                AND (expiresAt = '' OR expiresAt > ?)`,
        ).get(subject, relation, resource, NOW());
        return row !== undefined;
    }

    /**
     * Effective relation check — direct edge, group inheritance, or ancestor
     * inheritance via the `parent` chain.
     *
     * Kept as a bounded iterative walk rather than a recursive CTE. The Kùzu
     * version cited its engine's inability to filter intermediate edges by
     * relation, which no longer applies — but the second reason still does and
     * is the better one: `maxDepth` caps the walk so a cycle or pathological
     * chain cannot stall a permission check. A recursive CTE would need its own
     * cycle guard to match, for no gain at these sizes.
     *
     * Walks performed:
     *   1. Direct: subject --relation--> resource
     *   2. Group: subject --member--> group --relation--> resource
     *   3. Inherit: walk parent edges upward from resource; at each step check
     *      the subject directly OR through any group it belongs to.
     */
    async hasEffective(
        subject: string,
        relation: RebacRelation,
        resource: string,
        maxDepth: number = 8,
    ): Promise<boolean> {
        assertRelation(relation);

        // 1) Direct edge.
        if (await this.has(subject, relation, resource)) return true;

        // Resolve subject's group memberships once — used in (2) and (3).
        const groupIds = this.listGroupsSubjectIsMemberOf(subject);

        // 2) Group → resource directly.
        for (const g of groupIds) {
            if (await this.has(g, relation, resource)) return true;
        }

        // 3) Walk parent ancestors. BFS bounded by maxDepth.
        const seen = new Set<string>([resource]);
        let frontier: string[] = [resource];
        for (let depth = 0; depth < Math.max(1, Math.floor(maxDepth)); depth++) {
            const parents = this.listParentsOf(frontier);
            const next: string[] = [];
            for (const p of parents) {
                if (seen.has(p)) continue;
                seen.add(p);
                next.push(p);
                if (await this.has(subject, relation, p)) return true;
                for (const g of groupIds) {
                    if (await this.has(g, relation, p)) return true;
                }
            }
            if (next.length === 0) break;
            frontier = next;
        }
        return false;
    }

    /** Subject's direct `member` group ids. */
    private listGroupsSubjectIsMemberOf(subject: string): string[] {
        // RA2-reaudit2 — expired memberships don't grant inheritance.
        const rows = this.db.prepare(
            `SELECT DISTINCT resource AS gid FROM ${REBAC_TABLE}
              WHERE subject = ? AND relation = 'member'
                AND (expiresAt = '' OR expiresAt > ?)`,
        ).all(subject, NOW()) as Array<{ gid: string }>;
        return rows.map((r) => r.gid);
    }

    /**
     * Parents of a set of ids — one BFS step up the parent chain.
     *
     * ONE query for the whole frontier. The Kùzu version issued one query per
     * id because "Kùzu lacks a clean `id IN $list` parameter shape across
     * versions"; SQLite has one, so that fan-out is gone.
     */
    private listParentsOf(ids: string[]): string[] {
        if (ids.length === 0) return [];
        const holes = ids.map(() => '?').join(',');
        // RA2-reaudit2 — expired parent edges don't inherit.
        const rows = this.db.prepare(
            `SELECT DISTINCT resource AS pid FROM ${REBAC_TABLE}
              WHERE subject IN (${holes}) AND relation = 'parent'
                AND (expiresAt = '' OR expiresAt > ?)`,
        ).all(...ids, NOW()) as Array<{ pid: string }>;
        return rows.map((r) => r.pid);
    }

    /** All relations a subject has on a given resource (direct only). */
    async listSubjectRelations(subject: string, resource: string): Promise<RebacRelation[]> {
        // RA2-reaudit2 — don't list expired grants as effective.
        const rows = this.db.prepare(
            `SELECT DISTINCT relation FROM ${REBAC_TABLE}
              WHERE subject = ? AND resource = ?
                AND (expiresAt = '' OR expiresAt > ?)`,
        ).all(subject, resource, NOW()) as Array<{ relation: string }>;
        return rows.map((r) => r.relation).filter(isRebacRelation);
    }

    /**
     * Every (subject, relation) pair touching a resource directly. Used by
     * resource-detail views and audit dumps, which must show expired grants —
     * so this is deliberately not expiry-filtered.
     */
    async listResourceGrants(resource: string): Promise<RebacEdge[]> {
        const rows = this.db.prepare(
            `SELECT subject, relation, grantedAt, grantedBy, expiresAt
               FROM ${REBAC_TABLE} WHERE resource = ?`,
        ).all(resource) as Array<Record<string, string>>;
        return rows
            .filter((r) => isRebacRelation(r.relation as string))
            .map((r) => ({
                subject: String(r.subject),
                relation: r.relation as RebacRelation,
                resource,
                grantedAt: String(r.grantedAt ?? ''),
                grantedBy: String(r.grantedBy ?? ''),
                expiresAt: String(r.expiresAt ?? ''),
            }));
    }

    /** Resources a subject has any direct relation on. */
    async listSubjectGrants(subject: string): Promise<RebacEdge[]> {
        const rows = this.db.prepare(
            `SELECT resource, relation, grantedAt, grantedBy, expiresAt
               FROM ${REBAC_TABLE} WHERE subject = ?`,
        ).all(subject) as Array<Record<string, string>>;
        return rows
            .filter((r) => isRebacRelation(r.relation as string))
            .map((r) => ({
                subject,
                relation: r.relation as RebacRelation,
                resource: String(r.resource),
                grantedAt: String(r.grantedAt ?? ''),
                grantedBy: String(r.grantedBy ?? ''),
                expiresAt: String(r.expiresAt ?? ''),
            }));
    }
}

/**
 * Schema-aware advisory — confirm that a workspace's PermissionSchema
 * never references a relation that isn't either a ReBAC L1 relation or
 * a custom edge type declared by the workspace.
 *
 * Returns the list of unknown relations encountered, empty if all good.
 * Validation also runs in `validateSchema()` (schemas/types.ts); this
 * helper is for runtime callers that load a schema dynamically.
 */
export function findUnknownPermissionRelations(
    schema: LoreSchemaV2,
): { resourceType: string; action: string; unknown: string[] }[] {
    const known = new Set<string>([
        ...REBAC_RELATION_EDGE_NAMES,
        ...schema.edgeTypes.map(e => e.name),
    ]);
    const out: { resourceType: string; action: string; unknown: string[] }[] = [];
    if (!schema.permissions) return out;
    for (const [resourceType, actions] of Object.entries(schema.permissions)) {
        for (const [action, expr] of Object.entries(actions)) {
            const terms = expr.split('|').map(t => t.trim()).filter(Boolean);
            const unknown = terms.filter(t => !known.has(t));
            if (unknown.length > 0) out.push({ resourceType, action, unknown });
        }
    }
    return out;
}
