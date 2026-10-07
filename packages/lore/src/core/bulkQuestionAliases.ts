/**
 * bulkQuestionAliases.ts — 3.21 step 3(h) round 2 (Opus review). Extends
 * `POST /api/nodes/bulk`'s per-item `questions[]` support (alias-searchable
 * verbatim rows, exactly like the single-write path) to the chunked-lock +
 * batched-embed bulk pipeline.
 *
 * `nodeService.ts`'s nodeUpsert() runs the tombstone-then-record alias
 * fan-out (nodeServiceVerbatim.ts's tombstoneQuestionAliases /
 * recordQuestionAliases) as ONE step of its own single-node write. The bulk
 * pipeline (bulkWrite.ts's handleBulkNodes) is a genuinely different write
 * shape — one substrate call per CHUNK (bulkUpsertNodes), not one call per
 * node — so it cannot just "call nodeUpsert() per item" without giving up
 * the whole reason that pipeline exists (chunked locking, batched embeds).
 * This module reuses the EXACT SAME alias primitives (same outbox kinds,
 * same id shape, same caps/limits from questionAliases.ts) as a small
 * per-item step bulkWrite.ts calls once a node's graph write has already
 * succeeded — same alias semantics and durability as the single-write path,
 * without duplicating tombstoneQuestionAliases/recordQuestionAliases.
 */

import { tombstoneQuestionAliases, recordQuestionAliases } from './nodeServiceVerbatim.js';
import type { OutboxStore } from '../outbox/types.js';
import type { LoreNode } from '../providers/types.js';

export interface BulkAliasNodeShape {
    id: string;
    type: string;
    project: string;
    ecosystem: string;
    security_scopes?: string[];
}

/**
 * Apply a bulk item's alias fan-out AFTER its graph write has succeeded.
 * No-op when `outboxStore` is absent (matches item (d)'s "aliases are
 * gated on hooks.outboxStore" precedent — best-effort, never blocks) or
 * when `questions` is `undefined` (the caller's THIS write never mentioned
 * `questions` — must not sweep/touch pre-existing aliases, same gate
 * nodeService.ts's own fan-out uses).
 *
 * Scopes: alias rows must carry the SAME `security_scopes` as the node holds after
 * the write, or a scoped node's phrasings would be searchable by anyone. The caller
 * passes `node.security_scopes` when it knows them, else `resolveStoredScopes` (read
 * only when there are questions to record); a resolver answer of `undefined` means
 * the scopes could not be determined, and the aliases are NOT written (fail closed,
 * the old aliases are left untouched) rather than recorded as public.
 *
 * `updatedAt` on the synthesized node is approximate (`new Date()` at call
 * time, not the row's real DB-assigned timestamp) — the alias row's
 * `metadata.updatedAt` is a freshness hint for direct-hit readers, not
 * something correctness depends on (retrieve()'s alias→parent mapping never
 * reads it; only a caller that landed on the alias row's OWN metadata
 * would see it, and it is off by at most the duration of this request).
 */
export async function applyBulkQuestionAliases(input: {
    outboxStore: OutboxStore | undefined;
    workspace: string;
    initiator: string;
    logPrefix: string;
    node: BulkAliasNodeShape;
    questions: string[] | undefined;
    /** Reads the node's stored scopes after the write; used only when `node.security_scopes` is absent. */
    resolveStoredScopes?: () => Promise<string[] | undefined>;
}): Promise<void> {
    const { outboxStore, workspace, initiator, logPrefix, node, questions, resolveStoredScopes } = input;
    if (!outboxStore || questions === undefined) return;
    let scopes = node.security_scopes;
    if (scopes === undefined && questions.length > 0 && resolveStoredScopes) {
        scopes = await resolveStoredScopes();
        if (scopes === undefined) throw new Error(`stored security_scopes of '${node.id}' could not be determined; question aliases not written`);
    }
    await tombstoneQuestionAliases({ id: node.id, workspace, initiator, logPrefix, outboxStore });
    if (questions.length > 0) {
        const nodeForAlias = {
            id: node.id,
            type: node.type,
            project: node.project,
            ecosystem: node.ecosystem,
            security_scopes: scopes ?? [],
            updatedAt: new Date().toISOString(),
        } as unknown as LoreNode;
        await recordQuestionAliases({ id: node.id, workspace, initiator, logPrefix, node: nodeForAlias, questions, outboxStore });
    }
}
