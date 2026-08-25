/**
 * surrealGraphWrites.ts — write-side operations for SurrealGraph.
 *
 * Node writes, edge writes, supersession, and the maintenance prunes. Mirrors
 * the split LocalGraph uses across graphEdges.ts + nodeLifecycle.ts, kept in
 * one file here because the SurrealQL forms are a fraction of the Cypher.
 *
 * Two invariants carried over from the Kùzu engine, both load-bearing:
 *   - **Field-for-field storage parity.** The stored document uses LocalGraph's
 *     exact column names AND its exact empty-value conventions (`''` for an
 *     absent language / supersession, `false` for flags, `0` for ttl_ms), so
 *     the SHARED `rowToLoreNode` mapper produces an identical LoreNode from
 *     either engine. Storing `null` instead of `''` here would read back as a
 *     different node.
 *   - **No silent write loss.** `addEdge` fails loudly when an endpoint is
 *     missing rather than writing nothing and reporting success (NW-BULK).
 *
 * Every value is bound (`$var` / RecordId object). No string interpolation.
 */

import type { RecordId } from 'surrealdb';

import type { LoreEdge, LoreNode } from '../../providers/types.js';
import { LoreGraphError } from '../loreGraphError.js';
import { surrealError } from './surrealError.js';
import { tagsToArray } from '../normalizeTags.js';
import type { SurrealQuery } from './surrealGraphReads.js';
import { EDGE_TABLE, ridToId, toNodeRid } from './surrealRecordId.js';
import { withTransactionConflictRetry } from '../transactionConflictRetry.js';

/** The node document as stored. Keys match LocalGraph's Kùzu columns 1:1. */
type NodeDocument = Record<string, unknown>;

/**
 * Columns the Kùzu schema declares with a `DEFAULT 0` and that
 * LocalGraph.upsertNode never writes — outcome feedback, owned by
 * `record_outcome`. They are seeded ONCE at insert so `rowToLoreNode` reads
 * `0` rather than `undefined`, which is what LocalGraph returns for a node
 * that has recorded no outcomes.
 *
 * The ArcadeDB engine does exactly the same for exactly this reason
 * (`engines/arcade/arcadeSchema.ts`: "Arcade's upsertNode seeds them to 0 so
 * rowToLoreNode reads 0 (not undefined) → byte parity with the local
 * canonical node shape").
 */
const OUTCOME_COUNTER_SEED = {
    success_count: 0,
    failure_count: 0,
    partial_count: 0,
    confirmation_score: 0,
} as const;

/**
 * toNodeDocument — a LoreNode write payload in stored form.
 *
 * `createdAt`/`updatedAt` are supplied by the caller (upsert decides whether
 * createdAt is preserved or minted), everything else is defaulted exactly as
 * LocalGraph's Kùzu columns default, EXCEPT when `existing` is supplied: then
 * every server-managed/lifecycle field falls back to the STORED value before
 * the schema default, so a caller (store_node / POST /api/node) that omits
 * these fields on an ordinary edit does not reset them.
 *
 * 2026-08-17 (functional-correctness 4.2, fresh sibling of the
 * upsertLifecycle.ts fix on the Kùzu side, landed the same day): before this
 * fix, EVERY field below except `type`/`label`/`content`/`tags`/`project`/
 * `ecosystem`/`metadata` was unconditionally reset to its schema default on
 * every partial update — an archived node came back active, its scopes were
 * dropped, `validFrom`/`validUntil` were wiped, etc. SurrealGraph has been
 * the DEFAULT graph engine since 2026-08-11; the earlier Kùzu-only fix never
 * covered it.
 *
 * 2026-08-17 (functional-correctness 4.3) — `supersededBy`/`supersededAt`/
 * `supersededReason` are now real document keys (they previously weren't
 * written by this function at all, so a caller explicitly providing them —
 * `lore migrate engine` restoring a source node's supersession — had no
 * effect). `supersedeNode`/`unsupersedeNode` still own the NORMAL path for
 * setting/clearing these via their own targeted MERGE; an ordinary
 * upsertNode call never supplies them, so `existing` preserves whatever
 * those set, same as every other field here.
 */
export function toNodeDocument(
    node: Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>,
    createdAt: string,
    updatedAt: string,
    existing?: NodeDocument,
): NodeDocument {
    const prior = existing ?? {};
    const priorStr = (key: string): string | undefined =>
        typeof prior[key] === 'string' ? (prior[key] as string) : undefined;
    const priorBool = (key: string): boolean | undefined =>
        typeof prior[key] === 'boolean' ? (prior[key] as boolean) : undefined;
    const priorNum = (key: string): number | undefined =>
        typeof prior[key] === 'number' ? (prior[key] as number) : undefined;
    const priorScopes = (): string[] | undefined =>
        Array.isArray(prior['security_scopes']) ? (prior['security_scopes'] as string[]) : undefined;
    return {
        type: node.type,
        label: node.label,
        // Typed as required (`LoreNode.content: string`), but real callers at
        // the HTTP/MCP boundary can omit it — search()'s
        // `string::lowercase(content)` throws on a NONE column the moment
        // any node in the workspace has one, taking down search for the
        // whole workspace. Defended here the same way restoreNode already
        // does (surrealSchemaGraphOps.ts) rather than trusting the type.
        content: node.content ?? priorStr('content') ?? '',
        tags: tagsToArray(node.tags),
        project: node.project,
        ecosystem: node.ecosystem,
        metadata: node.metadata,
        createdAt,
        updatedAt,
        // LocalGraph writes '' (not null) and rowToLoreNode maps '' → null.
        syncedAt: '',
        security_scopes: node.security_scopes ?? priorScopes() ?? [],
        language: node.language ?? priorStr('language') ?? '',
        ephemeral: node.ephemeral ?? priorBool('ephemeral') ?? false,
        ttl_ms: node.ttl_ms ?? priorNum('ttl_ms') ?? 0,
        stale: node.stale ?? priorBool('stale') ?? false,
        status: node.status ?? (priorStr('status') as LoreNode['status'] | undefined) ?? 'active',
        classification: node.classification ?? (priorStr('classification') as LoreNode['classification'] | undefined) ?? 'tactical',
        anchor_stale: node.anchor_stale ?? priorBool('anchor_stale') ?? false,
        anchor_stale_since: node.anchor_stale_since ?? priorStr('anchor_stale_since') ?? '',
        // Bi-temporal valid-time window (storage primitive). '' (not null)
        // mirrors LocalGraph's Kùzu STRING DEFAULT '' convention, so the
        // SHARED rowToLoreNode mapper's ''-means-null coercion applies
        // identically on both engines. Caller-supplied only — never set here
        // — but PRESERVED on omit like every other field (previously reset
        // to '' on every plain re-store; see supersedeNode's own comment
        // about why it deliberately does NOT touch an app-set validUntil).
        validFrom: node.validFrom ?? priorStr('validFrom') ?? '',
        validUntil: node.validUntil ?? priorStr('validUntil') ?? '',
        // 2026-08-17 (4.3) — see function doc comment above.
        supersededBy: node.supersededBy ?? priorStr('supersededBy') ?? '',
        supersededAt: node.supersededAt ?? priorStr('supersededAt') ?? '',
        supersededReason: node.supersededReason ?? priorStr('supersededReason') ?? '',
    };
}

/**
 * upsertNode — create or update by id, preserving `createdAt` on update.
 *
 * `UPSERT $rid MERGE $doc` is a single round-trip that needs no read-decide-
 * write, so the TOCTOU race LocalGraph serializes against with `nodeWriteChain`
 * (NW-1d) cannot arise from the create-vs-update branch itself. The prior
 * `createdAt` still has to be read to preserve it — that read is the only
 * window, and it is narrowed by doing it immediately before the merge on the
 * same connection. SurrealGraph layers its own per-id serialization on top for
 * the same reason LocalGraph does.
 *
 * MERGE (not CONTENT) so fields this engine does not manage — anything a
 * future writer adds to the document — survive an update instead of being
 * silently dropped.
 *
 * 2026-08-17 (4.2/4.3) — the existence probe now reads the FULL row (not
 * just `createdAt`) on an update, so `toNodeDocument` can preserve every
 * lifecycle/metadata field the caller omits instead of resetting it to the
 * schema default. One extra round-trip field, same single extra read the
 * createdAt-only probe already did.
 *
 * The outcome counters are merged in ONLY on the insert path. That mirrors
 * LocalGraph exactly: its Kùzu columns carry `DEFAULT 0`, and neither its SET
 * nor its CREATE branch lists them, so a stored value is never clobbered by an
 * ordinary upsert. (This also faithfully reproduces a KNOWN open gap —
 * `record_outcome` mirrors counters onto the node via `upsertNode`, and that
 * write is dropped on Kùzu today. Diverging here would silently change
 * behaviour when a workspace switches engines; fixing it belongs on BOTH
 * engines at once, not in this one.)
 */
export async function upsertNode(
    query: SurrealQuery,
    node: Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>,
): Promise<LoreNode> {
    const rid = toNodeRid(node.id, 'upsertNode');
    const now = new Date().toISOString();
    try {
        const existing = await query('SELECT * FROM $rid', { rid });
        const isInsert = existing.length === 0;
        const priorRow = isInsert ? undefined : (existing[0] as NodeDocument);
        const createdAt = !isInsert && typeof priorRow!['createdAt'] === 'string'
            ? (priorRow!['createdAt'] as string)
            : now;
        const doc = isInsert
            ? { ...OUTCOME_COUNTER_SEED, ...toNodeDocument(node, createdAt, now) }
            : toNodeDocument(node, createdAt, now, priorRow);
        await query('UPSERT $rid MERGE $doc', { rid, doc });
        return {
            ...node,
            // Return the SAME normalized tags that were written (R2 #5).
            tags: tagsToArray(node.tags),
            createdAt,
            updatedAt: now,
            syncedAt: null,
        };
    } catch (error) {
        throw surrealError(`Failed to upsert node '${node.id}'`, 'upsertNode', error);
    }
}

/**
 * incidentEdgeIds — the record ids of every edge touching `rid`, via the graph
 * projection (adjacency), not a predicate over the edge table.
 *
 * `WHERE in = $rid OR out = $rid` reads the whole edge table on every call:
 * 14.791 ms/op on an 8 000-edge store versus 0.183 ms/op here, growing with
 * the corpus. Deleting a node is not a rare admin op — `pruneEphemeralNodes`
 * calls it in a loop — so the scan form makes a routine sweep quadratic.
 */
async function incidentEdgeIds(query: SurrealQuery, rid: RecordId<string>): Promise<unknown[]> {
    const rows = await query(`SELECT ->${EDGE_TABLE} AS outgoing, <-${EDGE_TABLE} AS incoming FROM $rid`, { rid });
    const out: unknown[] = [];
    for (const row of rows) {
        for (const key of ['outgoing', 'incoming'] as const) {
            const list = row[key];
            if (Array.isArray(list)) out.push(...list);
        }
    }
    return out;
}

/**
 * deleteNode — remove a node and every edge touching it.
 *
 * Edges first, then the node: the reverse order would leave dangling
 * relations if the second statement failed. Returns false when the node did
 * not exist (LocalGraph's contract), which is why the delete is preceded by an
 * existence check rather than inferred from an empty RETURN.
 */
export async function deleteNode(query: SurrealQuery, id: string): Promise<boolean> {
    const rid = toNodeRid(id, 'deleteNode');
    try {
        // Round-7 (2026-08-18) — same conflict-retry class as the six
        // composite verbs wrapped in 86bb3b7. deleteNode is a composite
        // (select node → select incident edges → DELETE edges → DELETE
        // node); under concurrent DISTINCT-key deletes running alongside
        // other graph writes, SurrealDB's optimistic-concurrency conflict
        // surfaced to delete_node / DELETE /api/node callers as a 500
        // (live-observed: 10-17 of 24 rejected). The WHOLE sequence
        // retries as a unit (raw error seen pre-surrealError-wrap, so
        // isTransactionConflictError matches); re-running the existence
        // check on retry is harmless — a node deleted by a concurrent
        // winner just makes the retry return false, which is correct.
        return await withTransactionConflictRetry(async () => {
            const existing = await query('SELECT id FROM $rid', { rid });
            if (existing.length === 0) return false;
            const edgeIds = await incidentEdgeIds(query, rid);
            if (edgeIds.length > 0) await query('DELETE $edgeIds', { edgeIds });
            await query('DELETE $rid', { rid });
            return true;
        });
    } catch (error) {
        throw surrealError(`Failed to delete node '${id}'`, 'deleteNode', error);
    }
}

/**
 * addEdge — create a directed relation, idempotent per (source, target,
 * relation) triple.
 *
 * The existence guard is L-014's: the hot-write path records an outbox row AND
 * applies the direct write, and the replicator later replays the same row, so
 * a blind RELATE would produce two rows for one logical edge.
 *
 * Missing endpoints fail LOUDLY (NW-BULK). SurrealDB's RELATE would happily
 * create the relation with a dangling side, which is worse than Kùzu's silent
 * zero-row CREATE — so the endpoint check is mandatory here, not defensive.
 *
 * BOTH checks are id/adjacency-bounded rather than table scans. The obvious
 * spellings (`WHERE id IN $rids`, `WHERE in = $a AND out = $b AND relation =
 * $r`) each read an entire table per call — measured at 20k nodes / 20k edges:
 * 19.986 ms and 30.388 ms per edge, versus 0.149 ms and 0.178 ms here. Since
 * both grow with the corpus and `addEdge` is called once per edge during a
 * load, the scan forms make bulk ingest QUADRATIC: a 50 000-node load did not
 * finish in 50 minutes with them, and completes in minutes without.
 */
export async function addEdge(query: SurrealQuery, edge: LoreEdge): Promise<void> {
    const source = toNodeRid(edge.sourceId, 'addEdge');
    const target = toNodeRid(edge.targetId, 'addEdge');
    const confidence = edge.confidence ?? 'extracted';
    const confidenceScore = edge.confidenceScore ?? 1.0;
    try {
        // Direct record fetch. (`SELECT id FROM $rids` would be narrower but
        // SurrealDB 3.0.2 rejects a PROJECTION over a bound record ARRAY with
        // "Specify a database to use" — a planner bug; `SELECT *` is fine.)
        const endpoints = await query('SELECT * FROM $rids', { rids: [source, target] });
        const present = new Set(endpoints.filter((row) => row['id'] != null).map((row) => ridToId(row['id'])));
        if (!present.has(edge.sourceId) || !present.has(edge.targetId)) {
            const which = [
                present.has(edge.sourceId) ? null : `source '${edge.sourceId}'`,
                present.has(edge.targetId) ? null : `target '${edge.targetId}'`,
            ].filter(Boolean).join(' and ');
            throw new LoreGraphError(
                `edge_endpoint_missing: ${which} not found — the node must be written `
                + '(and committed) before its edges',
                'addEdge',
            );
        }

        // Dedup against the SOURCE's outgoing adjacency only — O(out-degree),
        // not O(edges). Same scope as Kùzu's MATCH pattern guard.
        // Audit cluster 5 (2026-08-17): store_edge is documented as an UPSERT.
        // An existing (source, target, relation) triple is UPDATED with the new
        // confidence/confidenceScore instead of silently keeping the old values
        // while the tool echoes the new ones back as if stored.
        const outgoing = await query(
            `SELECT ->${EDGE_TABLE}.{ eid: id, other: out, relation: relation } AS edges FROM $source`,
            { source },
        );
        for (const row of outgoing) {
            const list = row['edges'];
            if (!Array.isArray(list)) continue;
            for (const entry of list) {
                const e = entry as { eid?: unknown; other?: unknown; relation?: unknown };
                if (ridToId(e.other) === edge.targetId && e.relation === edge.relation) {
                    if (e.eid != null) {
                        await query('UPDATE $eid MERGE $doc', {
                            eid: e.eid,
                            doc: { confidence, confidenceScore },
                        });
                    }
                    return;
                }
            }
        }

        await query('RELATE $source->' + EDGE_TABLE + '->$target CONTENT $doc', {
            source,
            target,
            doc: { relation: edge.relation, confidence, confidenceScore },
        });
    } catch (error) {
        if (error instanceof LoreGraphError) throw error;
        throw surrealError(`Failed to add edge ${edge.sourceId} → ${edge.targetId}`, 'addEdge', error);
    }
}

/**
 * deleteEdge — remove every edge matching the directed triple. Returns the
 * count removed (0 when nothing matched).
 *
 * Resolves the matching edge records through the SOURCE's outgoing adjacency
 * and deletes them by id, for the same reason `addEdge` dedups that way:
 * `DELETE edge WHERE in = … AND out = … AND relation = …` reads the entire
 * edge table (30 ms/op at 20k edges, growing) where this is O(out-degree).
 */
export async function deleteEdge(
    query: SurrealQuery,
    sourceId: string,
    targetId: string,
    relation: string,
): Promise<number> {
    try {
        const source = toNodeRid(sourceId, 'deleteEdge');
        const rows = await query(
            `SELECT ->${EDGE_TABLE}.{ edgeId: id, other: out, relation: relation } AS edges FROM $source`,
            { source },
        );
        const matched: unknown[] = [];
        for (const row of rows) {
            const list = row['edges'];
            if (!Array.isArray(list)) continue;
            for (const entry of list) {
                const e = entry as { edgeId?: unknown; other?: unknown; relation?: unknown };
                if (ridToId(e.other) === targetId && e.relation === relation) matched.push(e.edgeId);
            }
        }
        if (matched.length === 0) return 0;
        await query('DELETE $edgeIds', { edgeIds: matched });
        return matched.length;
    } catch (error) {
        throw surrealError(`Failed to delete edge ${sourceId} -[${relation}]-> ${targetId}`, 'deleteEdge', error);
    }
}

/**
 * pruneInferredLoreEdges — delete every edge whose relation starts with the
 * given prefix (e.g. `semantic_neighbor`). Only touches inferred edges;
 * human-asserted relations are left alone.
 */
export async function pruneInferredLoreEdges(query: SurrealQuery, relationPrefix: string): Promise<number> {
    try {
        // 1.1 residual — conflict-retry wrap (composite write verb).
        const removed = await withTransactionConflictRetry(() => query(
            `DELETE ${EDGE_TABLE} WHERE string::starts_with(relation, $prefix) RETURN BEFORE`,
            { prefix: relationPrefix },
        ));
        return removed.length;
    } catch (error) {
        throw surrealError(`Failed to prune inferred edges with prefix '${relationPrefix}'`, 'pruneInferredLoreEdges', error);
    }
}

/**
 * supersedeNode — mark `oldId` as superseded by `newId`. Node and edges stay;
 * recall filters it out. Same three return reasons as LocalGraph so callers
 * (and the Phase-2 parity harness) can't tell the engines apart.
 */
export async function supersedeNode(
    query: SurrealQuery,
    getNode: (id: string) => Promise<LoreNode | null>,
    oldId: string,
    newId: string,
    reason?: string,
): Promise<{ ok: boolean; reason?: string }> {
    if (oldId === newId) return { ok: false, reason: 'self' };
    const oldNode = await getNode(oldId);
    if (!oldNode) return { ok: false, reason: 'old-not-found' };
    const newNode = await getNode(newId);
    if (!newNode) return { ok: false, reason: 'new-not-found' };
    // 2026-08-17 (functional-correctness, cluster 4 medium) — refuse a
    // supersession that would CLOSE A CYCLE. Mirrors LocalGraph's identical
    // guard (engines/nodeLifecycle.ts) so the two engines can't tell apart —
    // see that function's comment for the full rationale.
    {
        const MAX_CHAIN_HOPS = 1000;
        let cursor: string | null | undefined = newNode.supersededBy;
        const visited = new Set<string>();
        let hops = 0;
        while (cursor && hops < MAX_CHAIN_HOPS) {
            if (cursor === oldId) return { ok: false, reason: 'cycle' };
            if (visited.has(cursor)) break;
            visited.add(cursor);
            const next = await getNode(cursor);
            cursor = next?.supersededBy;
            hops++;
        }
    }
    try {
        const supersededAt = new Date().toISOString();
        const doc: Record<string, unknown> = {
            supersededBy: newId,
            supersededAt,
            supersededReason: reason ?? '',
        };
        // Bi-temporal link: supersession is the app explicitly saying "this
        // is obsolete now" — stamp the same instant as the valid-time
        // window's end so the two mechanisms agree instead of validUntil
        // silently staying unset forever. Built as a conditional key (not an
        // `undefined` value in the MERGE doc) so a node that already has its
        // own validUntil is never touched — an app that set its own end date
        // up front knows better than "now".
        if (!oldNode.validUntil) doc.validUntil = supersededAt;
        // 1.1 residual (2026-08-18) — the composite lifecycle verbs were
        // excluded from the conflict-retry sweep as "engine methods, not raw
        // upsertNode/addEdge", but they hit the same SurrealDB optimistic-
        // concurrency conflict under concurrent distinct-key load (the
        // per-key nodeWriteChain mutex in SurrealGraph only serializes
        // SAME-key writes). Retried here at the statement, so every caller
        // (MCP tool, HTTP route, CLI, facade) inherits it.
        await withTransactionConflictRetry(() => query('UPDATE $rid MERGE $doc', { rid: toNodeRid(oldId, 'supersedeNode'), doc }));
        return { ok: true };
    } catch (error) {
        throw surrealError(`Failed to supersede node '${oldId}' with '${newId}'`, 'supersedeNode', error);
    }
}

/**
 * unsupersedeNode — clear the three supersession fields back to `''`.
 *
 * 2026-08-17 (functional-correctness, cluster 4 medium) — `validUntil` is
 * cleared ONLY when it equals the node's OWN `supersededAt` — i.e. only when
 * it is (almost certainly) the value `supersedeNode` itself auto-stamped
 * (see that function's comment: it sets `validUntil = supersededAt`, and
 * ONLY when the node had no validUntil of its own). An app that had already
 * set its own `validUntil` before the node was superseded is untouched by
 * `supersedeNode` (same guard) and must stay untouched here too — clearing
 * it unconditionally, as before, destroyed an app-set valid-time window that
 * `supersedeNode` deliberately preserved. `test/temporal-valid-time-unit.ts`
 * covers the auto-stamped case (validUntil === supersededAt → cleared).
 */
export async function unsupersedeNode(
    query: SurrealQuery,
    getNode: (id: string) => Promise<LoreNode | null>,
    id: string,
): Promise<boolean> {
    const node = await getNode(id);
    if (!node) return false;
    try {
        const doc: Record<string, unknown> = {
            supersededBy: '',
            supersededAt: '',
            supersededReason: '',
        };
        if (node.validUntil && node.validUntil === node.supersededAt) {
            doc.validUntil = '';
        }
        // 1.1 residual — same conflict-retry wrap as supersedeNode.
        await withTransactionConflictRetry(() => query('UPDATE $rid MERGE $doc', {
            rid: toNodeRid(id, 'unsupersedeNode'),
            doc,
        }));
        return true;
    } catch (error) {
        throw surrealError(`Failed to un-supersede node '${id}'`, 'unsupersedeNode', error);
    }
}

/**
 * markStaleByTags — set `stale = true` on every node carrying ANY of the tags.
 *
 * Exact membership against the stored array, case-insensitive by the
 * lowercase-on-store policy (so the input is folded here too). Substring
 * matching was dropped repo-wide with Pass 2.
 */
export async function markStaleByTags(query: SurrealQuery, tags: string[]): Promise<number> {
    const normalized = tags.map((t) => t.trim().toLowerCase()).filter(Boolean);
    if (normalized.length === 0) return 0;
    try {
        // ONE statement — LocalGraph loops per id only because Kùzu rejects a
        // list parameter in `WHERE n.id IN $ids` on the prepare path.
        // 1.1 residual — conflict-retry wrap (composite write verb).
        const updated = await withTransactionConflictRetry(() => query(
            'UPDATE node SET stale = true WHERE tags ANYINSIDE $tags RETURN id',
            { tags: normalized },
        ));
        return updated.length;
    } catch (error) {
        throw surrealError(`Failed to mark nodes stale by tags [${tags.join(', ')}]`, 'markStaleByTags', error);
    }
}
