/**
 * v1Migration.ts — One-time migration from V1.0 SQLite knowledge.db
 * into the V2.x graph — whichever graph engine the target
 * workspace declares (Phase 7a; made engine-agnostic during the legacy graph engine removal work).
 *
 * What this migrates:
 *   - nodes  table → LoreNode
 *   - edges  table → LoreEdge (confidence='extracted', user-asserted)
 *
 * Deduplication policy (what the user asked for):
 *
 *   1. ID conflict (V1 id matches an existing node):
 *      SKIP the V1 row. Live graph wins — the current node is newer
 *      and more canonical.
 *
 *   2. Content hash match, different ID (V1 content identical to a
 *      current node under a different id):
 *      FLAG in the report but still IMPORT under the V1 id. The user
 *      can later `lore delete_node <v1-id>` to collapse.
 *
 *      Why import anyway: the V1 id is the reference in V1's edges.
 *      Skipping breaks the edge graph.
 *
 *   3. Edge conflicts (V1 edge already exists with same
 *      source+target+relation):
 *      SKIP — upsert semantics would duplicate.
 *
 *   4. Edge endpoint missing (V1 edge references a node neither in
 *      the graph nor just-imported):
 *      SKIP + log. Shouldn't happen if V1 was consistent, but surviving
 *      dangling edges is worth a warning.
 *
 * What this does NOT migrate:
 *   - LanceDB vectors. V1 didn't have them. The migration writes nodes
 *     to the graph; embeddings come from the built-in ingest hook
 *     (reconnectOneNode) which fires on upsert. User need not run
 *     reconnect separately.
 *
 * Runtime model:
 *   - Shells out to the `sqlite3` command-line tool for reads. Avoids
 *     adding a native npm dep for a one-shot migration. Every user
 *     who has knowledge.db must have sqlite3 installed (it wrote it).
 *   - Uses graph.upsertNode + graph.addEdge for all writes — same
 *     paths every other ingest goes through. Consistency over
 *     performance; N=61 nodes, this is < 1s.
 */

import { execFileSync } from 'child_process';
import { tagsToArray, tagsToString } from './normalizeTags.js';
import { createHash } from 'node:crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { WorkspaceGraph } from './openWorkspaceGraph.js';
import type { VerbatimStore } from './verbatimStore.js';
import { reconnectOneNode } from './reconnect.js';
import { defaultAutolinkTracker, type PendingAutolinkTracker } from './pendingAutolink.js';

interface V1Node {
    id: string;
    type: string;
    label: string;
    content: string;
    metadata: string;
    tags: string;
    created_at: string;
    updated_at: string;
    project: string;
    ecosystem: string;
}

interface V1Edge {
    source_id: string;
    target_id: string;
    relation: string;
    weight: number;
    metadata: string;
}

export interface MigrationReport {
    dryRun: boolean;
    source: string;
    v1NodesRead: number;
    v1EdgesRead: number;
    nodesImported: number;
    nodesSkippedIdConflict: string[];     // ids
    nodesFlaggedContentDup: Array<{ v1Id: string; existingId: string }>;
    edgesImported: number;
    edgesSkippedAlreadyExists: number;
    edgesSkippedMissingEndpoint: Array<{ from: string; to: string }>;
    archivedTo?: string;
    durationMs: number;
}

export interface MigrationOptions {
    sqlitePath?: string;             // defaults to ~/.groundfloor/knowledge.db
    apply?: boolean;                  // false = dry-run (default)
    archive?: boolean;                // on --apply, move the .db to archive
    /** If present, also re-embed imported nodes via ingest hook. */
    verbatimStore?: VerbatimStore;
    /**
     * The owning Lore instance's autolink registry. Optional because the
     * primary caller is the CLI (`cli/commands/migrate.ts`), which owns the
     * process and closes the graph itself — but supply it from any HOST that
     * has a StorageBundle, so the ingest hooks fired below are covered by the
     * shutdown drain as well as by the inline await.
     *
     * Why both: the inline `await Promise.allSettled(reconnectPromises)` below
     * is the safety property, and it is a LOCAL one — it holds only as long as
     * nobody moves, early-returns past, or refactors it away. Registering each
     * hook makes the same property hold globally (shutdownDrain step 8.5 waits
     * on the tracker before closing substrate handles) and makes it survive
     * that edit. Defaults to `defaultAutolinkTracker` so an unwired caller
     * still registers somewhere rather than nowhere.
     */
    autolinkTracker?: PendingAutolinkTracker;
}

/**
 * contentHash — mirrors the shape used in reconnect.ts for consistent
 * identity across layers. Hashing label+content+tags catches "same
 * knowledge, different id" situations.
 */
function contentHash(n: Pick<V1Node, 'label' | 'content' | 'tags'>): string {
    return createHash('sha1')
        .update(`${n.label}\n${n.content}\n${n.tags}`)
        .digest('hex')
        .slice(0, 16);
}

export function readV1Rows<T>(sqlitePath: string, query: string): T[] {
    // `sqlite3 -json` outputs newline-separated objects — actually a
    // single JSON array in modern versions. Handle either by trying
    // array-first, falling back to line-split.
    //
    // audit 2026-06-25 (MEDIUM, command injection) — was execSync with a
    // shell-interpolated command string. JSON.stringify quotes the path but
    // does NOT neutralize $()/backtick inside double quotes, so a v1 DB path
    // like `x$(touch evil).db` (operator-supplied CLI arg) executed an embedded
    // command. execFileSync runs the binary directly with an argv array — no
    // shell parses the path/query, so metacharacters are inert.
    const raw = execFileSync(
        'sqlite3',
        ['-json', sqlitePath, query],
        { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 },
    ).trim();
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed as T[] : [parsed as T];
    } catch {
        // Fallback: newline-delimited JSON
        return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line) as T);
    }
}

export async function migrateV1Sqlite(
    graph: WorkspaceGraph,
    opts: MigrationOptions = {},
): Promise<MigrationReport> {
    const startMs = Date.now();
    const sqlitePath = opts.sqlitePath ?? path.join(process.env.HOME ?? '', '.groundfloor', 'knowledge.db');
    const apply = opts.apply ?? false;

    const report: MigrationReport = {
        dryRun: !apply,
        source: sqlitePath,
        v1NodesRead: 0,
        v1EdgesRead: 0,
        nodesImported: 0,
        nodesSkippedIdConflict: [],
        nodesFlaggedContentDup: [],
        edgesImported: 0,
        edgesSkippedAlreadyExists: 0,
        edgesSkippedMissingEndpoint: [],
        durationMs: 0,
    };

    if (!fs.existsSync(sqlitePath)) {
        throw new Error(`No V1 SQLite database at ${sqlitePath}`);
    }

    // Read V1 data
    const v1Nodes = readV1Rows<V1Node>(sqlitePath,
        'SELECT id, type, label, content, metadata, tags, created_at, updated_at, project, ecosystem FROM nodes');
    const v1Edges = readV1Rows<V1Edge>(sqlitePath,
        'SELECT source_id, target_id, relation, weight, metadata FROM edges');
    report.v1NodesRead = v1Nodes.length;
    report.v1EdgesRead = v1Edges.length;

    await graph.initialize();

    // Build dedup index of EXISTING content hashes for content-match detection.
    // We only call listNodes() ONCE — cheap at this scale.
    const existingNodes = await graph.listNodes(undefined, undefined, '*', '*', undefined, { unbounded: true });
    const existingIdSet = new Set(existingNodes.map((n) => n.id));
    const existingHashToId = new Map<string, string>();
    for (const n of existingNodes) {
        existingHashToId.set(
            contentHash({ label: n.label, content: n.content, tags: tagsToString(n.tags) }),
            n.id,
        );
    }

    const toImport: V1Node[] = [];
    for (const v1n of v1Nodes) {
        if (existingIdSet.has(v1n.id)) {
            report.nodesSkippedIdConflict.push(v1n.id);
            continue;
        }
        const hash = contentHash(v1n);
        const dupId = existingHashToId.get(hash);
        if (dupId) {
            report.nodesFlaggedContentDup.push({ v1Id: v1n.id, existingId: dupId });
        }
        toImport.push(v1n);
    }

    // Track the ingest-hook promises so we can await them before this function
    // returns. They touch BOTH substrates (LanceDB + graph), and the CLI caller
    // (cli/commands/migrate.ts) calls `graph.close()` right after this resolves.
    // Leaving them as untracked fire-and-forget caused a use-after-close race:
    // semantic edges silently dropped, reconnect writes thrown against a closed
    // connection (swallowed). They also race the existingEdges query + edge
    // import below. allSettled (not all) preserves best-effort semantics.
    const reconnectPromises: Array<Promise<unknown>> = [];
    // ...and register them on the owning instance's autolink tracker as well.
    // The local array above is what makes this migration safe TODAY, but it is
    // a coincidence of control flow, not an enforced invariant: an early
    // return, a thrown edge-import error, or someone moving the await would
    // silently restore the use-after-close race with nothing to catch it. The
    // tracker turns it into a property of the SYSTEM — shutdownDrain step 8.5
    // waits on it before any substrate handle closes — so both halves have to
    // be removed before the race comes back. `seal()` is also honoured: once
    // shutdown has begun there is nothing useful a new best-effort reconnect
    // can do, so the migration keeps importing nodes and simply skips the
    // edge-inference hook, exactly as nodeUpsert does.
    const autolinkTracker = opts.autolinkTracker ?? defaultAutolinkTracker;

    // Actually import
    if (apply) {
        for (const v1n of toImport) {
            await graph.upsertNode({
                id: v1n.id,
                type: v1n.type,
                label: v1n.label,
                content: v1n.content,
                tags: tagsToArray(v1n.tags),
                project: v1n.project,
                ecosystem: v1n.ecosystem,
                metadata: v1n.metadata ?? '{}',
            });
            report.nodesImported++;

            // Fire the ingest hook so LanceDB gets the embedding and
            // reconnect lays semantic edges. This is the SAME path
            // every other node upsert goes through — no migration-
            // specific code path to maintain.
            if (opts.verbatimStore && !autolinkTracker.isSealed()) {
                const hook = reconnectOneNode(graph, opts.verbatimStore, {
                    id: v1n.id,
                    label: v1n.label,
                    content: v1n.content,
                    tags: tagsToArray(v1n.tags),
                    type: v1n.type,
                    project: v1n.project,
                    ecosystem: v1n.ecosystem,
                }).catch(() => { /* ingest hook is best-effort */ });
                autolinkTracker.track(hook);
                reconnectPromises.push(hook);
            }
        }
    } else {
        report.nodesImported = toImport.length; // what WOULD be imported
    }

    // Bound the fire-and-forget ingest hooks: wait for every reconnect write to
    // settle BEFORE the existingEdges query / edge-import loop below read/write
    // the graph, and before this function returns (so the CLI's graph.close()
    // can't race ahead of in-flight reconnect writes). Dry-run never sets
    // verbatimStore, so reconnectPromises is empty and this is a no-op.
    await Promise.allSettled(reconnectPromises);

    // Index nodes that exist AFTER the import for edge-endpoint checks.
    // In dry-run, this is "what would exist"; in apply, "what exists now".
    const postImportIdSet = new Set([
        ...existingIdSet,
        ...toImport.map((n) => n.id),
    ]);

    // Edge dedup: canonical key = `${source}|${target}|${relation}`.
    //
    // Was one atomic single-engine-only Cypher MATCH against the raw graph
    // connection. Can't replace it with "attempt addEdge, treat a thrown
    // duplicate as already-existing" (the migrateWorkspaceToWorkspace.ts idiom)
    // — addEdge is silently idempotent on BOTH engines, not throw-on-duplicate:
    // surrealGraphWrites.ts:204-251 (Surreal) hits its outgoing-adjacency dedup
    // scan and does a bare `return`; the equivalent local-graph path resolved
    // outcome='exists' and fell straight through to bumpWriteEpoch()+return, no
    // throw. Neither engine can signal "that was a no-op" back to the caller,
    // so a catch-based scheme would leave edgesSkippedAlreadyExists permanently
    // 0 — the CLI
    // prints edgesImported and edgesSkippedAlreadyExists as two separate,
    // load-bearing counters, so that distinction has to survive.
    //
    // Instead: the same bulk-Set precheck, sourced from the portable, paginated
    // `queryEdges` walk — the identical idiom migrateEngine.ts's readAllEdges
    // already uses to enumerate a whole workspace's edges engine-agnostically.
    // One atomic scan becomes N read-only paginated ones; nothing else writes
    // to this graph between the scan and the import loop below, so that's safe.
    // Counts and their meaning are byte-identical to before.
    const EDGE_PAGE = 500;
    const existingEdges = new Set<string>();
    for (let offset = 0; ; offset += EDGE_PAGE) {
        const page = await graph.queryEdges({ limit: EDGE_PAGE, offset });
        for (const row of page) existingEdges.add(`${row.sourceId}|${row.targetId}|${row.relation}`);
        if (page.length < EDGE_PAGE) break;
    }

    for (const e of v1Edges) {
        if (!postImportIdSet.has(e.source_id) || !postImportIdSet.has(e.target_id)) {
            report.edgesSkippedMissingEndpoint.push({ from: e.source_id, to: e.target_id });
            continue;
        }
        const key = `${e.source_id}|${e.target_id}|${e.relation}`;
        if (existingEdges.has(key)) {
            report.edgesSkippedAlreadyExists++;
            continue;
        }
        if (apply) {
            await graph.addEdge({
                sourceId: e.source_id,
                targetId: e.target_id,
                relation: e.relation,
                // V1 edges are user-asserted (V1 had no reconnect).
                confidence: 'extracted',
                // V1 edge weight (default 1.0) maps to confidenceScore.
                confidenceScore: e.weight ?? 1.0,
            });
        }
        report.edgesImported++;
    }

    // Archive the source file if requested (and --apply succeeded).
    if (apply && opts.archive) {
        const archiveDir = path.join(process.env.HOME ?? '', '.groundfloor', 'archive');
        fs.mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const dest = path.join(archiveDir, `legacy-v1-knowledge-${stamp}.db`);
        fs.copyFileSync(sqlitePath, dest);
        fs.chmodSync(dest, 0o600);
        fs.unlinkSync(sqlitePath);
        report.archivedTo = dest;
    }

    report.durationMs = Date.now() - startMs;
    return report;
}
