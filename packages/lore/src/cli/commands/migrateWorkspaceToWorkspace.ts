/**
 * migrateWorkspaceToWorkspace.ts — `lore migrate workspace-to-workspace`
 *
 * First-class replacement for the ad-hoc one-shot TypeScript scripts
 * Lore operators have been writing whenever they need to rebalance
 * content across workspaces (e.g. workspace-a → workspace-b).
 *
 * Behavior:
 *   - Opens BOTH source and destination workspaces' graph engine
 *     (whichever engine each workspace declares) and VerbatimStore
 *     (LanceDB) directly. The daemon is required to be down.
 *   - Filters source nodes by `--filter-type`, `--filter-tag`, and
 *     `--exclude-id-prefix`.
 *   - Per-node atomic upsert to destination via `WorkspaceGraph.upsertNode`.
 *   - `--on-conflict skip|overwrite|fail` (default: fail) decides what
 *     happens when an id already exists in dest.
 *   - `--include-edges` copies every LoreEdge whose BOTH endpoints are
 *     in the moved set.
 *   - `--include-vectors` re-stores the source's verbatim row for each
 *     moved node id in dest (dedup by id — VerbatimStore.store upserts
 *     by id). Same embedding model on both sides, so the vector
 *     remains correct.
 *   - `--delete-source` removes the migrated nodes (and their vectors,
 *     and any orphaned edges) from source AFTER a successful write. It is
 *     REFUSED when the copy was incomplete (any node/edge write failed,
 *     or edges were skipped as dangling) — deleting then would make the
 *     loss permanent.
 *   - Default `--dry-run`; explicit `--apply` to mutate.
 *
 * Returns the report so tests + smoke can assert on counts.
 */

import type { LoreNode } from '../../providers/types.js';
import { openWorkspaceGraph, type WorkspaceGraph } from '../../engines/openWorkspaceGraph.js';
import { tagsToString } from '../../engines/normalizeTags.js';
import { VerbatimStore } from '../../engines/verbatimStore.js';
import { getWorkspacePath } from '../../config/workspaces.js';
import { loreHome } from '../../config/loreHome.js';
import { isDaemonServingHome, daemonRefuseMessage } from './migrateWorkspaceToWorkspaceShared.js';
import { withTransactionConflictRetry } from '../../engines/transactionConflictRetry.js';

export type OnConflict = 'skip' | 'overwrite' | 'fail';

export interface MigrateOptions {
    from: string;
    to: string;
    filterTypes?: string[];
    filterTag?: { key: string; value: string };
    excludeIdPrefixes?: string[];
    includeEdges?: boolean;
    includeVectors?: boolean;
    deleteSource?: boolean;
    apply?: boolean;
    onConflict?: OnConflict;
    /** Bypass the daemon preflight (tests). */
    force?: boolean;
    /**
     * Pre-opened WorkspaceGraph + VerbatimStore instances. Used by the
     * test suite to avoid a segfault the former native graph engine
     * exhibited when close()d and re-opened multiple times in the same
     * process. When omitted, the CLI path opens fresh instances from
     * workspaces.json + closes them on exit.
     */
    injected?: {
        srcGraph?: WorkspaceGraph;
        dstGraph?: WorkspaceGraph;
        srcVerbatim?: VerbatimStore;
        dstVerbatim?: VerbatimStore;
    };
}

export interface MigrateReport {
    sourceScanned: number;
    filteredOut: number;
    candidates: number;
    conflicts: string[];
    upserted: number;
    skipped: number;
    overwritten: number;
    /** Destination upsertNode calls that threw — NOT present in dest. */
    nodesFailed: number;
    edgesCopied: number;
    edgesSkippedDangling: number;
    /** Destination addEdge calls that threw — NOT present in dest. */
    edgesFailed: number;
    vectorsCopied: number;
    vectorsMissing: number;
    sourceDeleted: number;
    /**
     * True when --delete-source was requested but refused because the
     * copy was incomplete (node/edge write failures, or edges skipped
     * as dangling). Source is untouched in that case.
     */
    sourceDeleteRefused: boolean;
    appliedMode: 'dry-run' | 'apply';
}

function passesFilters(node: LoreNode, opts: MigrateOptions): boolean {
    if (opts.filterTypes && opts.filterTypes.length > 0) {
        if (!opts.filterTypes.includes(node.type)) return false;
    }
    if (opts.filterTag) {
        const { key, value } = opts.filterTag;
        const tags = (node.tags ?? []).map((t) => t.toLowerCase().trim());
        // Tags are flat strings; honor "value-only" matches (most
        // common) and "key=value" semantic tags by checking for the
        // literal "key=value" or just "value" in the comma list.
        const needle = key && value ? `${key}=${value}` : value;
        if (!tags.includes(needle.toLowerCase()) && !tags.includes(value.toLowerCase())) {
            return false;
        }
    }
    if (opts.excludeIdPrefixes && opts.excludeIdPrefixes.length > 0) {
        for (const p of opts.excludeIdPrefixes) {
            if (node.id.startsWith(p)) return false;
        }
    }
    return true;
}

export async function migrateWorkspaceToWorkspace(opts: MigrateOptions): Promise<MigrateReport> {
    if (!opts.from || !opts.to) {
        throw new Error('migrateWorkspaceToWorkspace: --from and --to are required');
    }
    if (opts.from === opts.to) {
        throw new Error('--from and --to must differ');
    }
    if (!opts.force) {
        // Round E2, 2026-09-03 — isDaemonUp() alone refused whenever ANY
        // process answered 200 on the port, never checking it served THIS
        // home; isDaemonServingHome() only reports true when the daemon's
        // own Bearer-authenticated /api/health confirms it.
        if ((await isDaemonServingHome(loreHome())).servesHome) {
            console.error(daemonRefuseMessage('lore migrate workspace-to-workspace'));
            process.exit(1);
        }
    }

    const apply = !!opts.apply;
    const onConflict: OnConflict = opts.onConflict ?? 'fail';

    const fromPath = getWorkspacePath(opts.from);
    const toPath = getWorkspacePath(opts.to);

    // Both sides now open whichever engine the workspace declares —
    // openWorkspaceGraph resolves that per-path, so a Surreal-backed source
    // or destination works instead of the old path-shaped refusal that
    // rejected anything but the former local engine. (The refusal existed
    // because step 4's edge copy used to be raw Cypher; it no longer is —
    // see the comment there for what replaced it.)
    const ownsSrcGraph = !opts.injected?.srcGraph;
    const ownsDstGraph = !opts.injected?.dstGraph;
    const srcGraph = opts.injected?.srcGraph ?? openWorkspaceGraph(fromPath, { workspaceId: opts.from });
    const dstGraph = opts.injected?.dstGraph ?? openWorkspaceGraph(toPath, { workspaceId: opts.to });
    if (ownsSrcGraph) await srcGraph.initialize();
    if (ownsDstGraph) await dstGraph.initialize();

    const ownsSrcVerb = !opts.injected?.srcVerbatim;
    const ownsDstVerb = !opts.injected?.dstVerbatim;
    const srcVerb = opts.includeVectors
        ? (opts.injected?.srcVerbatim ?? new VerbatimStore(fromPath))
        : null;
    const dstVerb = opts.includeVectors
        ? (opts.injected?.dstVerbatim ?? new VerbatimStore(toPath))
        : null;
    if (srcVerb && ownsSrcVerb) await srcVerb.initialize();
    if (dstVerb && ownsDstVerb) await dstVerb.initialize();

    const report: MigrateReport = {
        sourceScanned: 0,
        filteredOut: 0,
        candidates: 0,
        conflicts: [],
        upserted: 0,
        skipped: 0,
        overwritten: 0,
        nodesFailed: 0,
        edgesCopied: 0,
        edgesSkippedDangling: 0,
        edgesFailed: 0,
        vectorsCopied: 0,
        vectorsMissing: 0,
        sourceDeleted: 0,
        sourceDeleteRefused: false,
        appliedMode: apply ? 'apply' : 'dry-run',
    };

    // ── 1. Scan + filter ─────────────────────────────────────────
    const allNodes = await srcGraph.listNodes(undefined, undefined, '*', '*', undefined, { unbounded: true });
    report.sourceScanned = allNodes.length;
    const moved: LoreNode[] = [];
    for (const node of allNodes) {
        if (!passesFilters(node, opts)) {
            report.filteredOut += 1;
            continue;
        }
        moved.push(node);
    }
    report.candidates = moved.length;

    // ── 2. Conflict detection ───────────────────────────────────
    const conflictIds: string[] = [];
    for (const node of moved) {
        const existing = await dstGraph.getNode(node.id);
        if (existing) conflictIds.push(node.id);
    }
    report.conflicts = conflictIds;

    if (onConflict === 'fail' && conflictIds.length > 0) {
        if (ownsSrcGraph) await srcGraph.close().catch(() => undefined);
        if (ownsDstGraph) await dstGraph.close().catch(() => undefined);
        throw new Error(
            `migrate aborted: ${conflictIds.length} id(s) already exist in "${opts.to}". ` +
            `Use --on-conflict skip or --on-conflict overwrite (or change ids). ` +
            `Sample: ${conflictIds.slice(0, 5).join(', ')}`,
        );
    }

    // ── 3. Per-node atomic upsert ────────────────────────────────
    const movedIds = new Set<string>();
    for (const node of moved) {
        const collide = conflictIds.includes(node.id);
        if (collide && onConflict === 'skip') {
            report.skipped += 1;
            continue;
        }
        if (apply) {
            try {
                await withTransactionConflictRetry(() => dstGraph.upsertNode({
                    id: node.id,
                    type: node.type,
                    label: node.label,
                    content: node.content ?? '',
                    tags: node.tags ?? '',
                    project: opts.to,
                    ecosystem: node.ecosystem ?? '',
                    metadata: node.metadata ?? '{}',
                    language: node.language ?? null,
                    ephemeral: node.ephemeral ?? false,
                    ttl_ms: node.ttl_ms ?? null,
                }));
            } catch (err) {
                // Atomic per-node: a failed upsert leaves the dest
                // untouched for that id. Surface the error but keep
                // going so a single bad row doesn't strand the rest.
                console.error(`  upsert ${node.id} failed: ${(err as Error).message}`);
                report.nodesFailed += 1;
                continue;
            }
        }
        if (collide && onConflict === 'overwrite') report.overwritten += 1;
        else report.upserted += 1;
        movedIds.add(node.id);
    }

    // ── 4. Edges (optional) ──────────────────────────────────────
    if (opts.includeEdges && moved.length > 0) {
        // The single-local-engine-only path this replaced ran ONE Cypher
        // statement per 500-id chunk of `movedIds`:
        //   MATCH (a:LoreNode)-[e:LoreEdge]->(b:LoreNode)
        //   WHERE a.id IN [chunk] AND b.id IN [chunk]
        //   RETURN a.id, b.id, e.relation, e.confidence, e.confidenceScore
        // — a directed a->b edge; both endpoints had to be IN the SAME
        // 500-id chunk (chunking existed only to stay under that engine's
        // parameter-bind limit, not to change the query's meaning).
        //
        // `queryEdges` takes a single `source`/`target` filter, not an id
        // array, so the portable replacement below issues one query per
        // moved id (filtered on `source`) instead of one query per 500 ids
        // (filtered on both ends): |movedIds| round trips against
        // ceil(|movedIds|/500). That trade is acceptable here — step 2
        // above already pays one `dstGraph.getNode` round trip per moved
        // node, `migrate workspace-to-workspace` is an operator-invoked,
        // one-shot batch command (not a hot path), and the per-id loop is
        // actually MORE correct for a >500-node move: the old query could
        // only see an edge whose endpoints fell inside the SAME chunk,
        // silently missing an edge between chunk i and chunk j (i != j);
        // the loop below checks every moved id's outgoing edges against the
        // FULL moved set, not a 500-wide window of it.
        //
        // Directionality + de-dup, matched to the original: `source: id`
        // walks a->b only (never a separate b->a lookup, same as the
        // Cypher's single `-[e]->` arrow). Each edge has exactly one
        // sourceId, so visiting every id in `movedIds` exactly once and
        // paging that id's edges to completion (offset loop, stop once a
        // page comes back short of a full page) yields every qualifying
        // edge exactly once — no duplicates, no truncation on a
        // high-fan-out node. The `!movedIds.has(e.targetId)` check below is
        // what the Cypher's `b.id IN [...]` did server-side; queryEdges only
        // filters on `source`, so the target side is now checked here.
        const EDGE_PAGE = 500;
        for (const sourceId of movedIds) {
            for (let offset = 0; ; offset += EDGE_PAGE) {
                const page = await srcGraph.queryEdges({ source: sourceId, limit: EDGE_PAGE, offset });
                for (const e of page) {
                    if (!movedIds.has(e.targetId)) {
                        report.edgesSkippedDangling += 1;
                        continue;
                    }
                    if (apply) {
                        try {
                            await withTransactionConflictRetry(() => dstGraph.addEdge({
                                sourceId: e.sourceId,
                                targetId: e.targetId,
                                relation: e.relation || 'related_to',
                                confidence: e.confidence ?? 'extracted',
                                confidenceScore: typeof e.confidenceScore === 'number' ? e.confidenceScore : 1.0,
                            }));
                        } catch (err) {
                            // addEdge is idempotent on both engines — a
                            // pre-existing (source,target,relation) triple is
                            // a silent no-op, not a thrown error. A throw here
                            // is therefore a GENUINE write failure: the edge
                            // is not present in dest, so it must NOT be
                            // counted as copied. (The old empty catch plus an
                            // unconditional edgesCopied below let
                            // --delete-source destroy the only remaining copy
                            // of the edge while the report claimed success.)
                            // Record the failure and keep going so one bad
                            // edge doesn't strand the rest of the batch; the
                            // delete-source gate in step 6 refuses to make
                            // the loss permanent.
                            console.error(
                                `  edge copy ${e.sourceId} -> ${e.targetId} (${e.relation || 'related_to'}) failed: ${(err as Error).message}`,
                            );
                            report.edgesFailed += 1;
                            continue;
                        }
                    }
                    report.edgesCopied += 1;
                }
                if (page.length < EDGE_PAGE) break;
            }
        }
    }

    // ── 5. Vectors (optional) ────────────────────────────────────
    if (opts.includeVectors && srcVerb && dstVerb) {
        for (const node of moved) {
            if (!movedIds.has(node.id)) continue;
            const vbId = `lore:${node.id}`;
            const row = await srcVerb.getById(vbId);
            if (!row || !row.text) {
                report.vectorsMissing += 1;
                continue;
            }
            if (apply) {
                try {
                    await dstVerb.store({
                        id: vbId,
                        text: row.text,
                        metadata: {
                            type: node.type,
                            label: node.label,
                            tags: tagsToString(node.tags),
                            project: opts.to,
                            ecosystem: node.ecosystem ?? '',
                            updatedAt: node.updatedAt,
                        },
                    });
                } catch (err) {
                    console.error(`  vector copy ${node.id} failed: ${(err as Error).message}`);
                    continue;
                }
            }
            report.vectorsCopied += 1;
        }
    }

    // ── 6. Delete source (optional) ──────────────────────────────
    if (opts.deleteSource && apply) {
        // Safety gate: deleting the source after an INCOMPLETE copy turns
        // a partial migration into permanent data loss — the failed nodes,
        // failed edges, and edges skipped as dangling (their other endpoint
        // was filtered out or conflict-skipped) exist ONLY in the source.
        // Refuse the delete; the operator fixes the failures and re-runs.
        if (report.nodesFailed > 0 || report.edgesFailed > 0 || report.edgesSkippedDangling > 0) {
            report.sourceDeleteRefused = true;
            console.error(
                `  REFUSING --delete-source: the copy was incomplete ` +
                `(${report.nodesFailed} node write(s) failed, ${report.edgesFailed} edge write(s) failed, ` +
                `${report.edgesSkippedDangling} edge(s) skipped as dangling). ` +
                `Source left intact — resolve the failures and re-run.`,
            );
        } else {
            for (const id of movedIds) {
                try {
                    const deleted = await withTransactionConflictRetry(() => srcGraph.deleteNode(id));
                    if (deleted) report.sourceDeleted += 1;
                    if (deleted && srcVerb) {
                        try { await srcVerb.delete(`lore:${id}`); } catch { /* best-effort */ }
                    }
                } catch (err) {
                    console.error(`  source delete ${id} failed: ${(err as Error).message}`);
                }
            }
        }
    } else if (opts.deleteSource && !apply) {
        // dry-run reports the count that WOULD be deleted.
        report.sourceDeleted = movedIds.size;
    }

    if (ownsSrcGraph) await srcGraph.close().catch(() => undefined);
    if (ownsDstGraph) await dstGraph.close().catch(() => undefined);
    return report;
}

/* ─── CLI argv glue ────────────────────────────────────────────── */

function readFlag(args: string[], name: string): string | undefined {
    const idx = args.indexOf(name);
    if (idx === -1 || idx === args.length - 1) return undefined;
    return args[idx + 1];
}

function parseTagFlag(raw: string | undefined): { key: string; value: string } | undefined {
    if (!raw) return undefined;
    const eq = raw.indexOf('=');
    if (eq === -1) return { key: '', value: raw };
    return { key: raw.slice(0, eq), value: raw.slice(eq + 1) };
}

export async function migrateWorkspaceToWorkspaceCli(args: string[]): Promise<void> {
    if (args[0] === '--help' || args[0] === '-h' || args.length === 0) {
        console.log('Usage: lore migrate workspace-to-workspace [flags]');
        console.log('');
        console.log('Required:');
        console.log('  --from <name>');
        console.log('  --to   <name>');
        console.log('');
        console.log('Filters (all optional):');
        console.log('  --filter-type <csv>           e.g. decision,note,architecture');
        console.log('  --filter-tag <key=value>      e.g. owner=rafi or just `value`');
        console.log('  --exclude-id-prefix <csv>     e.g. loom-dispatch-,agent-run-');
        console.log('');
        console.log('Scope:');
        console.log('  --include-edges               Copy edges where both endpoints moved.');
        console.log('  --include-vectors             Copy lancedb verbatim rows for moved ids.');
        console.log('  --delete-source               Remove moved nodes/vectors from source (refused if any');
        console.log('                                node/edge copy failed or edges were skipped as dangling).');
        console.log('');
        console.log('Mode:');
        console.log('  --dry-run                     (default) Report counts; no writes.');
        console.log('  --apply                       Actually mutate.');
        console.log('  --on-conflict skip|overwrite|fail   (default: fail)');
        console.log('  --force                       Bypass daemon preflight (tests only).');
        return;
    }
    const from = readFlag(args, '--from');
    const to = readFlag(args, '--to');
    if (!from || !to) {
        console.error('migrate workspace-to-workspace: --from and --to are required.');
        process.exit(1);
    }
    const filterTypes = (readFlag(args, '--filter-type') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const filterTag = parseTagFlag(readFlag(args, '--filter-tag'));
    const excludeIdPrefixes = (readFlag(args, '--exclude-id-prefix') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const includeEdges = args.includes('--include-edges');
    const includeVectors = args.includes('--include-vectors');
    const deleteSource = args.includes('--delete-source');
    const apply = args.includes('--apply');
    const force = args.includes('--force');
    const onConflictRaw = readFlag(args, '--on-conflict') ?? 'fail';
    if (onConflictRaw !== 'skip' && onConflictRaw !== 'overwrite' && onConflictRaw !== 'fail') {
        console.error(`--on-conflict must be skip|overwrite|fail (got "${onConflictRaw}")`);
        process.exit(1);
    }

    const report = await migrateWorkspaceToWorkspace({
        from: from!,
        to: to!,
        filterTypes: filterTypes.length > 0 ? filterTypes : undefined,
        filterTag,
        excludeIdPrefixes: excludeIdPrefixes.length > 0 ? excludeIdPrefixes : undefined,
        includeEdges,
        includeVectors,
        deleteSource,
        apply,
        onConflict: onConflictRaw,
        force,
    });

    console.log('');
    console.log(`workspace-to-workspace migration: ${from} → ${to} (${report.appliedMode})`);
    console.log(`  source scanned:    ${report.sourceScanned}`);
    console.log(`  filtered out:      ${report.filteredOut}`);
    console.log(`  candidates:        ${report.candidates}`);
    console.log(`  conflicts in dest: ${report.conflicts.length}`);
    console.log(`  upserted:          ${report.upserted}${report.appliedMode === 'dry-run' ? ' (would)' : ''}`);
    console.log(`  overwritten:       ${report.overwritten}`);
    console.log(`  skipped:           ${report.skipped}`);
    console.log(`  failed:            ${report.nodesFailed}`);
    if (includeEdges) {
        console.log(`  edges copied:      ${report.edgesCopied}${report.appliedMode === 'dry-run' ? ' (would)' : ''}`);
        console.log(`  edges skipped:     ${report.edgesSkippedDangling}  (other endpoint not in the moved set)`);
        console.log(`  edges failed:      ${report.edgesFailed}`);
    }
    if (includeVectors) {
        console.log(`  vectors copied:    ${report.vectorsCopied}${report.appliedMode === 'dry-run' ? ' (would)' : ''}`);
        console.log(`  vectors missing:   ${report.vectorsMissing}`);
    }
    if (deleteSource) {
        console.log(`  source deleted:    ${report.sourceDeleted}${report.appliedMode === 'dry-run' ? ' (would)' : ''}${report.sourceDeleteRefused ? ' — REFUSED, source left intact' : ''}`);
    }

    // A migration with failed writes (or a refused --delete-source) did
    // NOT do what the operator asked; say so loudly and exit non-zero,
    // same convention as the argument/conflict failures above.
    if (report.nodesFailed > 0 || report.edgesFailed > 0 || report.sourceDeleteRefused) {
        console.error('');
        console.error(
            `MIGRATION INCOMPLETE: ${report.nodesFailed} node write(s) failed, ` +
            `${report.edgesFailed} edge write(s) failed` +
            (report.sourceDeleteRefused ? '; --delete-source was refused (source left intact)' : '') +
            '.',
        );
        process.exit(1);
    }
}
