/**
 * writePropositions.ts — stores extracted propositions (extractPropositions.ts)
 * as their own searchable Lore nodes.
 *
 * ADDITIVE ONLY: this never touches or replaces the turn-level
 * `conversation_turn` nodes ingest.ts already writes — a proposition node
 * sits ALONGSIDE its source turn, tagged with `source_node_id` for
 * traceability. Search now has two chances to find a fact: the raw turn
 * (whole-turn embedding, can be diluted by surrounding off-topic content —
 * see extractPropositions.ts's header) and the proposition (a clean,
 * standalone embedding of just that one fact). Neither can regress the
 * other; this is pure upside on retrieval recall, at the cost of more nodes
 * to search over.
 *
 * Node id scheme: `<questionId>::<sessionId>::<turnIndex>::prop<n>` — reuses
 * the SAME disambiguated sessionId ingest.ts's buildNodeId uses (see
 * disambiguateSessionIds), so a turn with a duplicate session_id in its own
 * haystack doesn't collide here either.
 */

import type { LoreInstance } from '../../../packages/lore/src/index.js';
import type { BulkIngestNodeArgs } from '../../../packages/lore/src/mcp/bulkIngest.js';
import type { Proposition } from './extractPropositions.js';
import { buildNodeId } from './ingest.js';

export function buildPropositionNodeId(questionId: string, sessionId: string, turnIndex: number, propIndex: number): string {
    return `${questionId}::${sessionId}::${turnIndex}::prop${propIndex}`;
}

/**
 * Same `[<session_date>] ` label prefix ingest.ts puts on every turn node,
 * for the same reason and in the same format: lore.recall()'s typed
 * RecallNode only surfaces {id,type,label,content,tags,project,source,
 * language}, so a custom `session_date` nodeData field does NOT round-trip
 * back to the answering step — a date that isn't in the label is invisible
 * to the answering model (README.md, "dates don't survive lore.recall()
 * unless you put them in the label"). Propositions were exempt from that
 * fix, which meant every proposition that outranked its own source turn
 * silently stripped the date off the context Lore handed the model, making
 * temporal-reasoning questions ("how many days between…") unanswerable from
 * the retrieved text — the Mosaic recall win turning into an answering
 * regression.
 *
 * `content` deliberately stays the pure proposition text: the label is the
 * date carrier and the search preview, the content is the fact.
 */
export function buildPropositionLabel(sessionDate: string | null, text: string): string {
    const preview = text.slice(0, 80).replace(/\s+/g, ' ');
    return sessionDate ? `[${sessionDate}] ${preview}` : preview;
}

/**
 * Writes one session's propositions as Lore nodes. Idempotent by construction
 * — the node id is deterministic (question+session+turn+position), so
 * re-running against the same session's same extraction output upserts the
 * same rows rather than duplicating them (unlike countable_events, which
 * hashes on description text — proposition text is comparatively stable
 * since it's a direct rewrite of a fixed source turn, not a free-form LLM
 * summary of a whole session).
 */
export async function writePropositions(
    lore: LoreInstance,
    questionId: string,
    nodeSessionId: string,
    sessionDate: string | null,
    propositions: Proposition[],
    opts: { autolink?: boolean } = {},
): Promise<{ written: number }> {
    if (propositions.length === 0) return { written: 0 };

    // Multiple propositions can share a source turn — number them in order
    // of appearance within that turn so ids stay deterministic and unique.
    const seenPerTurn = new Map<number, number>();
    const nodes: BulkIngestNodeArgs[] = propositions.map((prop) => {
        const propIndex = seenPerTurn.get(prop.sourceTurnIndex) ?? 0;
        seenPerTurn.set(prop.sourceTurnIndex, propIndex + 1);
        const nodeId = buildPropositionNodeId(questionId, nodeSessionId, prop.sourceTurnIndex, propIndex);
        // Same node id ingest.ts's own turn-level node for this turn uses —
        // deterministic, so no lookup/array-passing needed.
        const sourceNodeId = buildNodeId(questionId, nodeSessionId, prop.sourceTurnIndex);
        return {
            id: nodeId,
            workspace: 'longmemeval',
            ecosystem: questionId,
            nodeData: {
                id: nodeId,
                ecosystem: questionId,
                type: 'proposition',
                label: buildPropositionLabel(sessionDate, prop.text),
                content: prop.text,
                tags: ['proposition', `session:${nodeSessionId}`],
                session_id: nodeSessionId,
                session_date: sessionDate,
                turn_index: prop.sourceTurnIndex,
                source_node_id: sourceNodeId,
            },
        };
    });

    const result = await lore.bulkIngest(nodes, { autolink: opts.autolink ?? false, embed: 'sync' });
    if (!result.ok) {
        const failed = result.results.filter((r) => !r.ok);
        throw new Error(
            `writePropositions: bulkIngest reported failures for ${questionId}: ${failed.length}/${result.count} failed. ` +
                `First error: ${JSON.stringify(failed[0])}`,
        );
    }
    return { written: nodes.length };
}
