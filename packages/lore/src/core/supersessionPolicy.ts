/**
 * supersessionPolicy.ts — D5 (2026-09-23) write-time supersession
 * enforcement + the write-time `supersedes` edge/field application.
 *
 * Split out of core/nodeService.ts (already at the 800-line arch cap) so the
 * shared chokepoint (`nodeUpsert`) only needs a short call into this module.
 *
 * Two independent pieces:
 *
 *   1. `checkSupersessionPolicy` — the VALIDATION gate. Opt-in per workspace
 *      (`WorkspaceSupersessionPolicy.enforce`, config/workspaces.ts; default
 *      false = today's behaviour unchanged). When enforce is true and the
 *      node's type is `decision`/`convention`/`architecture`:
 *        - the write must carry an explicit `supersedes: string[]` (pass []
 *          to assert "supersedes nothing" on purpose);
 *        - a `SUPERSEDES <id>` prose claim in label/content whose id is not
 *          also listed in `supersedes` is rejected (the prose and the
 *          machine-readable field must agree);
 *        - an unlisted near-duplicate of an existing same-type node is
 *          rejected unless `force: true`.
 *      Every rejection names the offending id(s)/field so the caller can
 *      fix the write and retry — no silent drops.
 *
 *   2. `applyWriteTimeSupersedes` — the EFFECT. Runs inside `nodeUpsert`
 *      whenever a write carries a non-empty `supersedes` list, REGARDLESS of
 *      whether enforcement is on (enforcement only governs whether the list
 *      is *required*; a host can supply it voluntarily any time). For each
 *      listed id it calls `targetGraph.supersedeNode(oldId, newId, reason)`
 *      — the SAME method the existing `supersede_node` MCP tool uses — which
 *      sets `supersededBy`/`supersededAt`/`supersededReason` on the old node
 *      (the field recall.ts already treats as authoritative for hiding /
 *      now, D5 part 3, replacing-with-successor), then writes the
 *      `supersedes` edge exactly as `supersede_node` does. The field
 *      mutation is treated as FATAL to the overall write (if it fails, the
 *      caller asked for a link that didn't happen — better to say so than
 *      silently proceed with a dangling promise); the edge write is
 *      non-fatal/best-effort, mirroring `supersede_node`'s own precedent
 *      exactly (the edge is a queryable trail, `supersededBy` stays the one
 *      authoritative field either way).
 */

import { recordHotWrite } from '../outbox/hotLane.js';
import { withTransactionConflictRetry } from '../engines/transactionConflictRetry.js';
import { redactError } from '../security/logRedact.js';
import { log } from '../logger.js';
import { getWorkspaceSupersessionPolicy, loadWorkspacesIfPresent, type WorkspaceSupersessionPolicy } from '../config/workspaces.js';
import type { OutboxStore } from '../outbox/types.js';

/** Node types D5 enforcement applies to. Everything else (bug_pattern,
 *  pattern, etc.) is unaffected — those types don't carry the "this is the
 *  call now" authority a stale duplicate is dangerous for. */
export const SUPERSESSION_ENFORCED_TYPES: ReadonlySet<string> = new Set(['decision', 'convention', 'architecture']);

export const DEFAULT_SUPERSESSION_DUPLICATE_THRESHOLD = 0.78;

/**
 * Extract ids named in a `SUPERSEDES <id>` prose claim (case-insensitive,
 * whole word). Id charset: `assertSafeLanceId` (engines/verbatimHistory.ts)
 * only rejects non-string/empty/>512 chars/NUL — it does NOT enforce a strict
 * charset — but every real id in this codebase is alnum/dash/underscore/dot/
 * colon/slash with no whitespace (e.g. "baas-body-stream-fix",
 * "DEC-KUZU-REMOVAL-STEP1", "lore:some-id"). The pattern below matches that
 * observed convention: a token starting alnum, continuing with word chars
 * plus `. : / -`, stopping at whitespace/punctuation-that-ends-a-sentence.
 * A deliberately narrower match is the safer failure mode here — missing an
 * exotic id only means the prose check doesn't fire (no false rejection);
 * over-matching risks swallowing trailing sentence punctuation into the id.
 */
export function extractProseSupersedeIds(text: string | undefined | null): string[] {
    if (!text) return [];
    const ids = new Set<string>();
    // `:?` also accepts the "Supersedes: <id>" form.
    const re = /\bSUPERSEDES:?\s+([A-Za-z0-9][\w.:/-]*)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        const raw = m[1].replace(/[.:/-]+$/, ''); // strip trailing sentence punctuation
        // Review fix: the keyword is matched case-insensitively, so ordinary
        // prose ("this supersedes the old approach") used to be rejected as a
        // claim on id "the". Only count id-shaped tokens — containing a
        // `-`/`_`/`:` separator or a digit — which every real node id seen in
        // practice has. A bare-word id is missed (fail-open, no false reject).
        if (raw.length > 0 && /[-_:]|\d/.test(raw) && !/^\d+$/.test(raw)) ids.add(raw);
    }
    return Array.from(ids);
}

export type SupersessionCheckCode = 'missing_supersedes_field' | 'prose_supersedes_mismatch' | 'unlisted_near_duplicate';

export type SupersessionCheckResult =
    | { ok: true; supersessionWarning?: string }
    | { ok: false; code: SupersessionCheckCode | 'supersedes_apply_failed'; error: Error };

/**
 * D5 round 4 (#3) — a near-duplicate lookup bound to one workspace, now
 * reusing the ACTUAL top-N/type-family/skip-superseded logic
 * `supersessionCandidates.ts` (GET /api/node/supersession-candidates) uses,
 * instead of the round-1..3 top-1-any-type `search(q, 1)` call. See
 * `resolveSupersessionContext`'s `findDuplicate` closure below for the
 * implementation; this type is just the shape every write path already
 * consumes.
 *
 * Returns `{ hit }` — the single best-scoring hit (or `null`) above the
 * caller's own threshold, already filtered to same-type-family and
 * non-superseded/non-archived — plus an optional `warning`, set when the
 * search itself failed (network/engine error) so the caller fails OPEN
 * (write proceeds) but can still surface that the duplicate check was
 * skipped rather than silently reporting "no duplicate found".
 *
 * KNOWN LIMITATION (documented, not fixed here): this is a vector search
 * against the workspace's verbatim/LanceDB mirror. A node that was written
 * with `skipEmbed: true` (or whose embed is still pending/failed) has no
 * vector row and therefore CANNOT be found as a near-duplicate by this
 * check, in either direction — it won't be surfaced as an existing
 * duplicate, and a later near-duplicate of IT won't be caught either.
 */
export type FindNearDuplicate = (query: {
    /** The writing node's own id — excluded from candidate hits so a node
     *  can never be reported as its own near-duplicate. */
    id: string;
    /** The writing node's type — hits are filtered to the SAME
     *  enforcement-relevant type family (`SUPERSESSION_ENFORCED_TYPES`),
     *  mirroring supersessionCandidates.ts's `allowedTypes` filter. */
    type: string;
    label?: string;
    content?: string;
}) => Promise<{ hit: { id: string; score: number } | null; warning?: string }>;

export interface SupersessionCheckInput {
    type: string;
    id: string;
    label?: string;
    content?: string;
    /** The write's `supersedes` field — undefined means the caller omitted
     *  it entirely (distinct from an explicit empty array). */
    supersedes?: string[];
    force?: boolean;
    policy: WorkspaceSupersessionPolicy;
    findDuplicate?: FindNearDuplicate;
    /**
     * D5 #6 — true when this write is a re-save of an EXISTING node that
     * already carries supersession state (recorded outgoing `supersedes`
     * edges from a prior write on this same id). An edit to such a node
     * that omits `supersedes` (e.g. fixing a typo in `content`, unrelated to
     * supersession) is NOT re-litigating supersession — the field was
     * already declared once, at the write that first created the edges.
     * Forcing every subsequent edit to redeclare it would make the field
     * required forever, not just at creation. Only a genuinely NEW node (or
     * an existing node with no supersession state yet) must declare it.
     * Computed by the caller (`runSupersessionValidation`) via a cheap
     * existence + edge check; defaults to `false` (today's behaviour,
     * unchanged) when the caller can't determine it.
     */
    hasExistingSupersessionState?: boolean;
    /** Targets of this node's already-recorded `supersedes` edges (re-save
     *  only). Counted as listed by the prose and near-dup checks, so a
     *  re-save whose unchanged content still says "SUPERSEDES <id>" for an
     *  id it already supersedes is not refused as a prose mismatch. */
    existingSupersedes?: string[];
}

function actionableError(code: SupersessionCheckCode, message: string): { ok: false; code: SupersessionCheckCode; error: Error } {
    return { ok: false, code, error: new Error(message) };
}

/**
 * Validate one write against its workspace's supersession policy. Pure
 * (aside from the injected `findDuplicate` callback) — no I/O of its own.
 * Returns `{ok:true}` immediately when `policy.enforce` is false or the
 * node's type isn't in `SUPERSESSION_ENFORCED_TYPES`.
 */
export async function checkSupersessionPolicy(input: SupersessionCheckInput): Promise<SupersessionCheckResult> {
    if (!input.policy.enforce) return { ok: true };
    if (!SUPERSESSION_ENFORCED_TYPES.has(input.type)) return { ok: true };

    // 1. The field is required (an explicit [] asserts "supersedes nothing")
    //    — UNLESS this is a re-save of an existing node whose supersession
    //    state was already declared at creation (D5 #6); see
    //    `hasExistingSupersessionState`'s doc comment above.
    if (input.supersedes === undefined && !input.hasExistingSupersessionState) {
        return actionableError(
            'missing_supersedes_field',
            `node '${input.id}' (type '${input.type}') requires an explicit \`supersedes: string[]\` field under this workspace's supersession policy — pass [] if this write deliberately supersedes nothing.`,
        );
    }

    // 2. Prose "SUPERSEDES <id>" claims must be listed.
    const proseIds = [...extractProseSupersedeIds(input.label), ...extractProseSupersedeIds(input.content)];
    const listed = new Set([...(input.supersedes ?? []), ...(input.existingSupersedes ?? [])]);
    const unlistedProse = Array.from(new Set(proseIds)).filter((pid) => !listed.has(pid));
    if (unlistedProse.length > 0) {
        return actionableError(
            'prose_supersedes_mismatch',
            `node '${input.id}' content/label claims "SUPERSEDES ${unlistedProse.join(', ')}" but the \`supersedes\` field does not list ${unlistedProse.length === 1 ? 'it' : 'them'} — add ${unlistedProse.length === 1 ? 'that id' : 'those ids'} to \`supersedes\`, or remove the prose claim.`,
        );
    }

    // 3. An unlisted near-duplicate is refused unless force:true.
    let supersessionWarning: string | undefined;
    if (!input.force && input.findDuplicate) {
        const threshold = input.policy.duplicateThreshold ?? DEFAULT_SUPERSESSION_DUPLICATE_THRESHOLD;
        let hit: { id: string; score: number } | null = null;
        try {
            const result = await input.findDuplicate({ id: input.id, type: input.type, label: input.label, content: input.content });
            hit = result.hit;
            supersessionWarning = result.warning;
        } catch {
            hit = null; // best-effort — a search failure never blocks the write
        }
        if (hit && hit.id !== input.id && hit.score >= threshold && !listed.has(hit.id)) {
            return actionableError(
                'unlisted_near_duplicate',
                `node '${input.id}' looks like a near-duplicate of existing node '${hit.id}' (similarity ${hit.score.toFixed(2)} >= threshold ${threshold}) — add '${hit.id}' to \`supersedes\` if this write replaces it, or pass \`force: true\` if it doesn't.`,
            );
        }
    }

    return { ok: true, ...(supersessionWarning ? { supersessionWarning } : {}) };
}

/** The minimal graph surface `applyWriteTimeSupersedes` needs. Both
 *  LocalGraph and DataplaneGraph already implement this (it's exactly what
 *  the existing `supersede_node` MCP tool calls). */
export interface SupersessionWriteGraph {
    supersedeNode(oldId: string, newId: string, reason?: string): Promise<{ ok: boolean; reason?: string }>;
    addEdge(edge: { sourceId: string; targetId: string; relation: string; confidence?: string; confidenceScore?: number }): Promise<unknown>;
}

/**
 * Apply a write's `supersedes` list: for each listed id, soft-supersede it
 * (sets supersededBy/At/Reason — the field recall already treats as
 * authoritative) then write the `supersedes` edge, identical effect to
 * calling the `supersede_node` tool once per id. Called from `nodeUpsert`
 * right after the new node's own write succeeds.
 *
 * D5 round 4 (#4) — this used to STOP at the first failing id, leaving the
 * write "all-or-nothing" only in the sense that it aborted early — a
 * 3-id list where id #2 failed left #1 applied and #3 never attempted, and
 * the caller only ever saw the error for #2. `validateSupersedesIds` (below)
 * is the actual all-or-nothing guarantee: it runs BEFORE any write and
 * refuses the whole write if any id is unknown/archived/would-cycle, so by
 * the time this function runs every id has already been validated. This
 * function itself now ALWAYS attempts every id (never stops early) so that
 * a failure here — which should be rare, since validation already ran, but
 * can still happen (a concurrent delete/archive between validation and this
 * call, a transient graph error) — is reported as a complete, itemized
 * `applied` vs `unapplied` partition rather than a single opaque message
 * naming only the first failure.
 *
 * Field-mutation failure for an id is recorded as unapplied (not thrown
 * immediately) so the loop can continue to the remaining ids. Edge-write
 * failure stays non-fatal, matching `supersede_node`'s own precedent (log +
 * continue; supersededBy is the authoritative field, the edge is a
 * secondary queryable trail) — an id whose field mutation succeeded but
 * whose edge write failed still counts as `applied`.
 */
export async function applyWriteTimeSupersedes(params: {
    targetGraph: SupersessionWriteGraph;
    supersedes: string[];
    newId: string;
    workspace: string;
    initiator: string;
    outboxStore?: OutboxStore;
    logPrefix: string;
}): Promise<
    | { ok: true }
    | { ok: false; code: 'supersedes_partial'; applied: string[]; unapplied: Array<{ id: string; reason: string }>; error: Error }
> {
    const { targetGraph, supersedes, newId, workspace, initiator, outboxStore, logPrefix } = params;
    const applied: string[] = [];
    const unapplied: Array<{ id: string; reason: string }> = [];
    for (const oldId of supersedes) {
        if (oldId === newId) continue; // a node cannot supersede itself
        let result: { ok: boolean; reason?: string };
        try {
            result = await targetGraph.supersedeNode(oldId, newId, 'supersedes (write-time enforcement, D5)');
        } catch (err) {
            result = { ok: false, reason: redactError(err) };
        }
        if (!result.ok) {
            unapplied.push({ id: oldId, reason: result.reason ?? 'unknown reason' });
            continue; // D5 round 4 (#4): keep going — attempt every remaining id.
        }
        applied.push(oldId);
        const edge = {
            sourceId: newId,
            targetId: oldId,
            relation: 'supersedes',
            confidence: 'extracted' as const,
            confidenceScore: 1.0,
        };
        try {
            if (outboxStore) {
                await recordHotWrite(outboxStore, {
                    workspace,
                    operationKind: 'edge.upsert',
                    payload: edge,
                    initiator,
                    operation: 'edge.upsert',
                });
            }
            await withTransactionConflictRetry(() => targetGraph.addEdge(edge));
        } catch (edgeErr) {
            log.warn(`${logPrefix} write-time supersedes: edge ${newId}->${oldId} failed (non-fatal; supersededBy is authoritative): ${redactError(edgeErr)}`);
        }
    }
    if (unapplied.length > 0) {
        return {
            ok: false,
            code: 'supersedes_partial',
            applied,
            unapplied,
            error: new Error(
                `node '${newId}' partially applied its \`supersedes\` list — applied: [${applied.join(', ') || 'none'}], ` +
                `unapplied: [${unapplied.map((u) => `${u.id} (${u.reason})`).join(', ')}]. The new node '${newId}' itself was ` +
                `written successfully; only the supersede effect on the unapplied id(s) did not happen — retry \`supersede_node\` for those id(s) directly.`,
            ),
        };
    }
    return { ok: true };
}

/**
 * D5 round 4 (#4) — the all-or-nothing PRE-write guarantee: validate every
 * id in a write's `supersedes` list BEFORE any write happens (new node
 * write, field mutation, or edge write). Generalizes the existence-only
 * pre-check bulkWrite.ts/import.ts already did per-item into the one shared
 * chokepoint every write path (single-write AND bulk) now calls.
 *
 * Three checks, in order, each refusing the WHOLE write (nothing written)
 * on any failure — a write with 3 ids where #2 is bad must not partially
 * apply #1 and #3:
 *   1. Existence — every id must resolve via `targetGraph.getNode`.
 *   2. Not archived — `status === 'archived'` is refused (an archived node
 *      is not a live target to supersede).
 *   3. No cycle (incl. transitive) — walks the WRITING node's own current
 *      `supersededBy` chain (bounded depth) and refuses if the target id
 *      appears in it. Concrete case this catches: A supersedes B
 *      (B.supersededBy = A); a later write attempts "B supersedes A" — B's
 *      own chain already contains A, so this is refused as a cycle instead
 *      of silently creating a 2-node loop.
 */
/** Structural shape validateSupersedesIds needs from a read-back node — deliberately a
 *  subset of LoreNode (not `Record<string, unknown>`) so any real getNode()
 *  implementation (which returns LoreNode, a closed interface without an index
 *  signature) satisfies this param type without a cast at every call site. */
type SupersedesCheckNode = { status?: string | null; supersededBy?: string | null };

export async function validateSupersedesIds(params: {
    id: string;
    supersedes: string[] | undefined;
    targetGraph?: { getNode?(id: string): Promise<SupersedesCheckNode | null | undefined> };
}): Promise<SupersessionCheckResult> {
    const { id, supersedes, targetGraph } = params;
    if (!supersedes || supersedes.length === 0) return { ok: true };
    const getNode = targetGraph?.getNode?.bind(targetGraph);
    if (!getNode) return { ok: true }; // no read-back available — nothing to validate against (fail open, unchanged pre-round-4 posture)

    const uniqueIds = Array.from(new Set(supersedes)).filter((sid) => sid !== id);
    const missing: string[] = [];
    const archived: string[] = [];
    for (const sid of uniqueIds) {
        const node = await getNode(sid);
        if (!node) { missing.push(sid); continue; }
        if (node.status === 'archived') archived.push(sid);
    }
    if (missing.length > 0) {
        return {
            ok: false,
            code: 'supersedes_apply_failed',
            error: new Error(`node '${id}' lists \`supersedes\` id(s) ${missing.map((m) => `'${m}'`).join(', ')} that do not exist in this workspace — nothing was written. Fix or remove ${missing.length === 1 ? 'that id' : 'those ids'} and retry.`),
        };
    }
    if (archived.length > 0) {
        return {
            ok: false,
            code: 'supersedes_apply_failed',
            error: new Error(`node '${id}' lists \`supersedes\` id(s) ${archived.map((m) => `'${m}'`).join(', ')} that ${archived.length === 1 ? 'is' : 'are'} archived — nothing was written. An archived node cannot be a supersede target.`),
        };
    }
    const MAX_CYCLE_DEPTH = 50; // matches other bounded-chain walks in this codebase; a real supersession chain is never this deep
    for (const targetId of uniqueIds) {
        let current: string | null | undefined = id;
        const seen = new Set<string>();
        for (let hop = 0; hop < MAX_CYCLE_DEPTH; hop++) {
            if (!current || seen.has(current)) break;
            seen.add(current);
            const node = await getNode(current);
            const next = node?.supersededBy;
            if (!next) break;
            if (next === targetId) {
                return {
                    ok: false,
                    code: 'supersedes_apply_failed',
                    error: new Error(`node '${id}' cannot supersede '${targetId}' — '${targetId}' is already (directly or transitively) the successor of '${id}' in the supersession chain; applying this write would create a cycle. Nothing was written.`),
                };
            }
            current = next;
        }
    }
    return { ok: true };
}

/**
 * Thin call-throughs used by `nodeService.ts` so the shared write chokepoint
 * only needs one line per step (keeps it under the 800-line arch cap).
 */

/** Step 0d's whole body: resolve the write's type/label/content out of the
 *  loosely-typed `nodeData` and run the policy gate. No-op (`{ok:true}`)
 *  when no policy is wired or enforcement is off. */
export async function runSupersessionValidation(params: {
    supersessionPolicy: WorkspaceSupersessionPolicy | undefined;
    findSupersessionDuplicate: FindNearDuplicate | undefined;
    nodeData: Record<string, unknown>;
    id: string;
    supersedes: string[] | undefined;
    force: boolean;
    /** D5 round 4 (#4) — every listed `supersedes` id is validated (exists,
     *  not archived, no cycle) BEFORE the write, regardless of enforcement,
     *  via `validateSupersedesIds`. A typo'd/unknown/archived/cycle-forming
     *  id is refused with nothing written instead of failing in step 3.5
     *  after the new node is already committed (which also skipped
     *  WAL/version/autolink). */
    targetGraph?: {
        getNode?(id: string): Promise<SupersedesCheckNode | null | undefined>;
        /** D5 #6 — optional; used ONLY to detect pre-existing `supersedes`
         *  edges on a re-save (see `hasExistingSupersessionState`). Absent
         *  (or a getNode-only test double) simply skips that detection and
         *  keeps today's behaviour — the field stays required. */
        queryEdges?(q: { source?: string; target?: string; relation?: string; limit: number; offset: number }): Promise<Array<{ sourceId: string; targetId: string; relation: string }>>;
    };
}): Promise<SupersessionCheckResult> {
    const preCheck = await validateSupersedesIds({ id: params.id, supersedes: params.supersedes, targetGraph: params.targetGraph });
    if (!preCheck.ok) return preCheck;
    if (!params.supersessionPolicy?.enforce) return { ok: true };
    const { nodeData } = params;

    // D5 #6 — only worth the extra lookup when the write actually omitted
    // `supersedes` (the one case the missing-field check can wrongly fire
    // on) AND both optional graph verbs are available. Existence check
    // first (an id that doesn't exist yet is a brand-new node — field stays
    // required); then a bounded edge read (targets also count as listed) for
    // outgoing `supersedes` edges recorded on a PRIOR write to this id.
    // Any failure fails CLOSED (state stays `false`, field stays required)
    // — this is a convenience relaxation, not a security gate, so the safe
    // default on uncertainty is "ask again", not "skip the check".
    let hasExistingSupersessionState = false;
    let existingSupersedes: string[] = [];
    if (params.supersedes === undefined && params.targetGraph?.getNode && params.targetGraph.queryEdges) {
        try {
            const existing = await params.targetGraph.getNode(params.id);
            if (existing) {
                const edges = await params.targetGraph.queryEdges({ source: params.id, relation: 'supersedes', limit: 100, offset: 0 });
                hasExistingSupersessionState = edges.length > 0;
                existingSupersedes = edges.map((e) => e.targetId);
            }
        } catch {
            hasExistingSupersessionState = false;
            existingSupersedes = [];
        }
    }

    return checkSupersessionPolicy({
        type: String(nodeData.type ?? ''),
        id: params.id,
        label: typeof nodeData.label === 'string' ? nodeData.label : undefined,
        content: typeof nodeData.content === 'string' ? nodeData.content : undefined,
        supersedes: params.supersedes,
        force: params.force,
        policy: params.supersessionPolicy,
        findDuplicate: params.findSupersessionDuplicate,
        hasExistingSupersessionState,
        existingSupersedes,
    });
}

/** Step 3.5's whole body: apply `supersedes` (if non-empty) via the graph,
 *  guarding that the target graph actually implements the optional methods.
 *  No-op when the list is empty/absent. */
export async function runSupersessionApply(params: {
    targetGraph: Partial<SupersessionWriteGraph>;
    supersedes: string[] | undefined;
    newId: string;
    workspace: string;
    initiator: string;
    outboxStore?: OutboxStore;
    logPrefix: string;
}): Promise<
    | { ok: true }
    | { ok: false; code: 'supersedes_apply_failed'; error: Error }
    | { ok: false; code: 'supersedes_partial'; applied: string[]; unapplied: Array<{ id: string; reason: string }>; error: Error }
> {
    const { supersedes, targetGraph } = params;
    if (!supersedes || supersedes.length === 0) return { ok: true };
    if (typeof targetGraph.supersedeNode !== 'function' || typeof targetGraph.addEdge !== 'function') {
        return { ok: false, code: 'supersedes_apply_failed', error: new Error('targetGraph does not support supersedeNode/addEdge — cannot apply the supersedes list') };
    }
    return applyWriteTimeSupersedes({ ...params, targetGraph: targetGraph as SupersessionWriteGraph, supersedes });
}

/**
 * Round-2 review fix (HIGH #1): the (policy, findDuplicate) resolution used
 * to be copy-pasted near-verbatim in storeNode.ts (MCP) and postNode.ts
 * (REST) — and every OTHER write path (embedded lib:nodeUpsert/
 * nodeUpsertBatch, bulkIngest, changeset upsert, REST bulkWrite/import)
 * simply never called it, so D5 enforcement silently didn't apply there.
 * This is now the ONE place that resolution happens; every write path below
 * calls it instead of re-deriving the policy/finder inline.
 *
 * Mirrors supersessionCandidates.ts's own resolution order: active/boot
 * graph → boot storageClient's verbatim search; a non-active workspace with
 * a resolver wired → that workspace's own LanceDB; otherwise the near-dup
 * check is skipped (the missing-field/prose checks still run — only the
 * near-duplicate leg needs a search backend).
 */
export interface ResolveSupersessionContextParams {
    workspace: string;
    targetGraph: unknown;
    homeDir?: string;
    /** The boot/active graph handle — compared by reference to `targetGraph`
     *  to decide which verbatim store backs the near-dup search. */
    bootGraph: unknown;
    /** Boot storage client's verbatim search, used when `targetGraph` IS the
     *  boot graph (the common case: active workspace, or no registry). */
    storageClient?: { verbatimSearch(q: string, n: number): Promise<Array<{ id: string; score: number }>> };
    /** Resolves a NON-active workspace's own verbatim store, when wired. */
    workspaceVerbatimResolver?: { getOrOpen(ws: string): Promise<{ search(q: string, n: number): Promise<Array<{ id: string; score: number }>> }> };
    /**
     * Round 2 (#2, host switch) — the fallback enforce value used both when
     * `getWorkspaceSupersessionPolicy` finds no explicit per-workspace entry
     * AND when the workspace is unknown to the registry entirely (fail-open
     * case below). Computed once per host via `resolveHostSupersessionDefault`
     * and threaded down through each write path's deps. Absent = `false`
     * (today's default, unchanged).
     */
    hostDefaultEnforce?: boolean;
}

/**
 * Round 2 (#2) — `LORE_SUPERSESSION_ENFORCE` env var, read fresh each call
 * (not cached) so tests can flip it per-case. Truthy: '1' or 'true'
 * (case-insensitive). Anything else, including unset, is `undefined` (not
 * "false") so `resolveHostSupersessionDefault` can tell "explicitly off" apart
 * from "not set" — though today the only consumer treats both the same way.
 */
export function envSupersessionEnforceDefault(): boolean | undefined {
    const raw = process.env['LORE_SUPERSESSION_ENFORCE'];
    if (raw === undefined) return undefined;
    return raw === '1' || raw.toLowerCase() === 'true';
}

/**
 * Round 2 (#2) — precedence for the HOST-level default (below the
 * per-workspace setting, which always wins when present):
 * `createLore({supersessionEnforce})` option > `LORE_SUPERSESSION_ENFORCE`
 * env var > `undefined` (callers then treat that as `false`).
 */
export function resolveHostSupersessionDefault(createLoreOption?: boolean): boolean | undefined {
    if (createLoreOption !== undefined) return createLoreOption;
    return envSupersessionEnforceDefault();
}

export function resolveSupersessionContext(params: ResolveSupersessionContextParams): {
    policy: WorkspaceSupersessionPolicy;
    findDuplicate: FindNearDuplicate | undefined;
} {
    const { workspace, targetGraph, homeDir, bootGraph, storageClient, workspaceVerbatimResolver, hostDefaultEnforce } = params;
    // D5 round 2 (HIGH #1 fix regression, 2026-09-23) — getWorkspaceSupersessionPolicy
    // THROWS "Unknown workspace" when `workspace` has no entry in the resolved
    // home's workspaces.json (e.g. a graph handle opened directly against a
    // temp dir in a lower-level test, or any caller that writes via a raw
    // graph/verbatim pair without going through the workspace registry).
    // Before this fix that exception propagated out of every write path that
    // now calls this helper, turning an unrelated/unregistered workspace into
    // a hard write failure instead of "policy absent = enforce:false" (this
    // module's own documented default, config/workspaces.ts ~108). Fail open
    // here, consistent with the near-duplicate search's fail-open behaviour
    // below and with `WorkspaceVocabPolicy`'s same absent-is-permissive shape.
    //
    // D5 re-review (2026-09-23) — this runs on EVERY write, enforcement on or
    // off, so it must be read-only: `getWorkspaceSupersessionPolicy` goes
    // through `loadWorkspaces()`, which BOOTSTRAP-WRITES a workspaces.json
    // (and mkdirs the home) when none exists — for callers with no
    // `homeDir` (cloud / registry-less deps) that is the process-wide
    // `loreHome()`. Probe with `loadWorkspacesIfPresent` first: no control
    // file or no entry => host default, no side effect. The catch is kept
    // only for a corrupt/unreadable control file, and now logs instead of
    // swallowing silently.
    let policy: WorkspaceSupersessionPolicy = { enforce: hostDefaultEnforce === true };
    try {
        const file = loadWorkspacesIfPresent(homeDir);
        if (file && file.workspaces.some((w) => w.name === workspace)) {
            policy = getWorkspaceSupersessionPolicy(workspace, homeDir, hostDefaultEnforce);
        }
    } catch (err) {
        log.warn(`[supersession] workspace policy unreadable for "${workspace}" — using host default (enforce=${policy.enforce}): ${redactError(err)}`);
    }
    // D5 round 4 (#3) — top-N/type-family search, reusing the actual logic
    // `supersessionCandidates.ts` (GET /api/node/supersession-candidates)
    // applies when it pairs candidates up, instead of round 1-3's
    // `search(q, 1)` top-1-any-type call. NEAR_DUP_SEARCH_N mirrors that
    // route's per-node hit count (5). Hits are filtered to
    // SUPERSESSION_ENFORCED_TYPES (the same "family" the candidates route's
    // default `types=decision,architecture,convention,bug_pattern` treats as
    // one group for pairing purposes) and to nodes that are neither
    // superseded (`supersededAt`) nor archived (`status`) — a stale/retired
    // node is never a reason to reject a new write as a "duplicate". The
    // FIRST filtered hit is returned (hits arrive score-sorted, so this is
    // the top-scoring match within the family that survives the filter).
    const NEAR_DUP_SEARCH_N = 5;
    const getCandidateNode = (targetGraph as { getNode?(id: string): Promise<Record<string, unknown> | null | undefined> } | null)?.getNode?.bind(targetGraph);
    const findDuplicate: FindNearDuplicate | undefined = policy.enforce
        ? async (query) => {
              const q = (query.label ?? '').trim() || (query.content ?? '').slice(0, 200);
              if (!q) return { hit: null };
              let search: ((qq: string, n: number) => Promise<Array<{ id: string; score: number }>>) | null = null;
              if (targetGraph === bootGraph && storageClient) {
                  search = (qq, n) => storageClient.verbatimSearch(qq, n);
              } else if (workspaceVerbatimResolver) {
                  try {
                      const store = await workspaceVerbatimResolver.getOrOpen(workspace);
                      search = (qq, n) => store.search(qq, n);
                  } catch {
                      search = null;
                  }
              }
              // No search backend resolvable at all — this is the documented
              // "nodes without a per-workspace verbatim store" limitation, not
              // a search FAILURE, so no warning (matches pre-round-4 posture:
              // silently skip, no candidate pairs).
              if (!search) return { hit: null };
              let hits: Array<{ id: string; score: number }>;
              try {
                  hits = await search(q, NEAR_DUP_SEARCH_N);
              } catch (searchErr) {
                  // KNOWN LIMITATION (documented on FindNearDuplicate above): a
                  // search ENGINE error (as opposed to "no backend wired")
                  // fails the write open but is surfaced to the caller as a
                  // `supersessionWarning` on the write result, so the gap is
                  // visible instead of silently indistinguishable from "no
                  // duplicate found".
                  return { hit: null, warning: `near-duplicate check skipped — search failed: ${redactError(searchErr)}` };
              }
              for (const raw of hits) {
                  const hitId = raw.id.startsWith('lore:') ? raw.id.slice(5) : raw.id;
                  if (hitId === query.id) continue; // never propose a node as its own duplicate
                  if (getCandidateNode) {
                      let candidate: Record<string, unknown> | null | undefined;
                      try {
                          candidate = await getCandidateNode(hitId);
                      } catch {
                          candidate = undefined; // read-back failure — treat like "no type info", fall through to accepting the hit below
                      }
                      if (candidate) {
                          const candidateType = String(candidate['type'] ?? '');
                          if (!SUPERSESSION_ENFORCED_TYPES.has(candidateType)) continue; // not the same type family
                          if (candidate['supersededAt']) continue; // already superseded — not a live duplicate
                          if (candidate['status'] === 'archived') continue; // archived — not a live duplicate
                      }
                      // candidate === null: the hit id no longer resolves to a
                      // live node (deleted/never a graph row, e.g. a stray
                      // verbatim row) — KNOWN LIMITATION: without a graph row
                      // to type-check, we can't confirm family/lifecycle, so
                      // (matching this function's pre-round-4 fail-open
                      // posture for missing metadata) it is still surfaced as
                      // a candidate rather than silently dropped.
                  }
                  return { hit: { id: hitId, score: raw.score } };
              }
              return { hit: null };
          }
        : undefined;
    return { policy, findDuplicate };
}

export { getWorkspaceSupersessionPolicy };
export type { WorkspaceSupersessionPolicy };
