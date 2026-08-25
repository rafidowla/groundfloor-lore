/**
 * bulkRecall.ts — POST /api/recall/bulk (the `topics` batch read).
 *
 * One concern: fan a list of topics out over ONE resolved workspace graph and
 * return ids/labels/tags per topic. Extracted from `bulkWrite.ts`, which is
 * over the 800-line cap (CLAUDE.md file-size budget) and is otherwise entirely
 * about WRITES — this was the single read handler wedged into it.
 *
 * Ecosystem scope: the search here hardcoded `'*'` for BOTH project and
 * ecosystem, so on a workspace serving several isolated tenants by ecosystem
 * it returned every tenant's ids and labels. It now takes a PER-REQUEST scope
 * (per-topic `ecosystem`, else the request-level one, else `'*'`, which is the
 * previous behaviour for every caller that omits it) rather than the
 * boot-global `detectedScope` — which this route's deps do not carry, and
 * which could not separate two tenants served by one daemon anyway.
 *
 * `project` deliberately stays `'*'`: it is a caller-owned node field that is
 * not guaranteed to equal the workspace name (retrieve.ts:314-321), and the
 * workspace boundary is already enforced by `resolveGraph`.
 *
 * License: original work for groundfloor-lore.
 */

import type { ServerResponse } from 'node:http';
import { ecosystemMatches } from '../../../core/ecosystemMatch.js';
import { writeJson, writeError } from '../helpers.js';
import { bindRouteTarget } from '../../../security/routeWorkspaceBinding.js';
import { resolveGraph, writeWorkspaceNotFound, type BulkWriteDeps } from './bulkWrite.js';

const RECALL_TOPIC_CAP = 100;

interface RecallInput {
    topic?: unknown;
    max?: unknown;
    workspace?: unknown;
    /** Per-topic ecosystem scope; falls back to the request-level one, then
     *  '*' (search-everything, the pre-existing behaviour). */
    ecosystem?: unknown;
}

export async function handleBulkRecall(
    res: ServerResponse,
    parsed: { topics?: unknown; workspace?: unknown; ecosystem?: unknown },
    deps: BulkWriteDeps,
): Promise<boolean> {
    if (!Array.isArray(parsed.topics)) {
        writeError(res, 400, 'bad_request', '`topics` must be an array');
        return true;
    }
    if (parsed.topics.length === 0) {
        writeError(res, 400, 'bad_request', '`topics` must be non-empty');
        return true;
    }
    if (parsed.topics.length > RECALL_TOPIC_CAP) {
        writeError(res, 400, 'bad_request', `at most ${RECALL_TOPIC_CAP} topics per call (got ${parsed.topics.length})`);
        return true;
    }
    const requestedWorkspace = typeof parsed.workspace === 'string' ? parsed.workspace : undefined;
    if (bindRouteTarget(res, { requested: requestedWorkspace, intent: 'read' }) === null) return true;
    const target = await resolveGraph(deps, requestedWorkspace);
    if ('error' in target) { writeWorkspaceNotFound(res, target); return true; }
    // Sprint 14 + Sprint 16 — `search` is substrate-agnostic (both
    // LocalGraph and DataplaneGraph implement it natively). This is
    // the "Option B" case from the Sprint 14 spec: lift the call to
    // the shared interface rather than guarding for LocalGraph. The
    // earlier 501 fallback was over-conservative.

    const results: Array<{ topic: string; ok: boolean; hits?: unknown[]; error?: string; scan_cap_hit?: boolean }> = [];
    for (const raw of parsed.topics as RecallInput[]) {
        if (!raw || typeof raw !== 'object' || typeof raw.topic !== 'string') {
            results.push({ topic: String((raw as { topic?: unknown })?.topic ?? ''), ok: false, error: 'topic must be a string' });
            continue;
        }
        const limit = typeof raw.max === 'number' ? Math.min(Math.max(Math.trunc(raw.max), 1), 100) : 8;
        try {
            const bulkSignals = { scanCapHit: false };
            // Ecosystem scope: this route hardcoded '*', so a workspace serving
            // several tenants returned every tenant's ids/labels/tags. PER-
            // REQUEST (per-topic, then request-level, then '*' = unchanged for
            // omitting callers) rather than the boot-global detectedScope,
            // which cannot separate two tenants on one daemon. project stays
            // '*' — retrieve.ts:314-321.
            const topicEcosystem = typeof raw.ecosystem === 'string' && raw.ecosystem.length > 0
                ? raw.ecosystem
                : (typeof parsed.ecosystem === 'string' && parsed.ecosystem.length > 0 ? parsed.ecosystem : '*');
            const rawHits = await target.search(raw.topic, limit, '*', topicEcosystem, false, bulkSignals);
            // Post-filtered on the authoritative graph value: the pushdown is
            // an optimisation, not the boundary.
            const hits = topicEcosystem === '*'
                ? rawHits
                : rawHits.filter((h) => ecosystemMatches((h as { ecosystem?: string }).ecosystem, topicEcosystem));
            results.push({
                topic: raw.topic,
                ok: true,
                ...(bulkSignals.scanCapHit ? { scan_cap_hit: true } : {}),
                hits: hits.map((h) => ({ id: h.id, type: h.type, label: h.label, project: h.project, tags: h.tags })),
            });
        } catch (err) {
            results.push({ topic: raw.topic, ok: false, error: (err as Error).message });
        }
    }
    writeJson(res, 200, { ok: true, count: parsed.topics.length, results });
    return true;
}
