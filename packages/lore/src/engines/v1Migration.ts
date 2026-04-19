/**
 * v1Migration.ts — One-time migration from V1.0 SQLite knowledge.db
 * into the V2.x Kùzu graph (Phase 7a).
 *
 * What this migrates:
 *   - nodes  table → Kùzu LoreNode
 *   - edges  table → Kùzu LoreEdge (confidence='extracted', user-asserted)
 *
 * Deduplication policy (what the user asked for):
 *
 *   1. ID conflict (V1 id matches an existing Kùzu node):
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
 *   3. Edge conflicts (V1 edge already exists in Kùzu with same
 *      source+target+relation):
 *      SKIP — upsert semantics would duplicate.
 *
 *   4. Edge endpoint missing (V1 edge references a node neither in
 *      Kùzu nor just-imported):
 *      SKIP + log. Shouldn't happen if V1 was consistent, but surviving
 *      dangling edges is worth a warning.
 *
 * What this does NOT migrate:
 *   - LanceDB vectors. V1 didn't have them. The migration writes nodes
 *     to Kùzu; embeddings come from the built-in ingest hook
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

import { execSync } from 'child_process';
import { createHash } from 'node:crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { LocalGraph } from './localGraph.js';
import type { VerbatimStore } from './verbatimStore.js';
import { reconnectOneNode } from './reconnect.js';
import type { PluginRegistry } from '../plugins/registry.js';

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
    pluginRegistry?: PluginRegistry;
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

function readV1Rows<T>(sqlitePath: string, query: string): T[] {
    // `sqlite3 -json` outputs newline-separated objects — actually a
    // single JSON array in modern versions. Handle either by trying
    // array-first, falling back to line-split.
    const raw = execSync(
        `sqlite3 -json ${JSON.stringify(sqlitePath)} ${JSON.stringify(query)}`,
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
    graph: LocalGraph,
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

    // Build dedup index of EXISTING Kùzu content hashes for content-match detection.
    // We only call listNodes() ONCE — cheap at this scale.
    const existingNodes = await graph.listNodes();
    const existingIdSet = new Set(existingNodes.map((n) => n.id));
    const existingHashToId = new Map<string, string>();
    for (const n of existingNodes) {
        existingHashToId.set(
            contentHash({ label: n.label, content: n.content, tags: n.tags }),
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

    // Actually import
    if (apply) {
        for (const v1n of toImport) {
            await graph.upsertNode({
                id: v1n.id,
                type: v1n.type,
                label: v1n.label,
                content: v1n.content,
                tags: v1n.tags,
                project: v1n.project,
                ecosystem: v1n.ecosystem,
                metadata: v1n.metadata ?? '{}',
            });
            report.nodesImported++;

            // Fire the ingest hook so LanceDB gets the embedding and
            // reconnect lays semantic edges. This is the SAME path
            // every other node upsert goes through — no migration-
            // specific code path to maintain.
            if (opts.verbatimStore && opts.pluginRegistry) {
                void reconnectOneNode(graph, opts.verbatimStore, opts.pluginRegistry, {
                    id: v1n.id,
                    label: v1n.label,
                    content: v1n.content,
                    tags: v1n.tags,
                    type: v1n.type,
                    project: v1n.project,
                    ecosystem: v1n.ecosystem,
                }).catch(() => { /* ingest hook is best-effort */ });
            }
        }
    } else {
        report.nodesImported = toImport.length; // what WOULD be imported
    }

    // Index nodes that exist AFTER the import for edge-endpoint checks.
    // In dry-run, this is "what would exist"; in apply, "what exists now".
    const postImportIdSet = new Set([
        ...existingIdSet,
        ...toImport.map((n) => n.id),
    ]);

    // Edge dedup: canonical key = `${source}|${target}|${relation}`.
    // Query existing edges once.
    const existingEdges = await new Promise<Set<string>>((resolve) => {
        try {
            const ctx = graph.createPluginGraphContext();
            ctx.queryRows(
                `MATCH (a:LoreNode)-[e:LoreEdge]->(b:LoreNode)
                 RETURN a.id AS src, b.id AS tgt, e.relation AS rel`,
            ).then((rows) => {
                resolve(new Set(rows.map((r) => `${r.src}|${r.tgt}|${r.rel}`)));
            }).catch(() => resolve(new Set()));
        } catch { resolve(new Set()); }
    });

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
