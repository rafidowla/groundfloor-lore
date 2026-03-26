#!/usr/bin/env node
/**
 * migrate-sqlite-to-kuzu.mjs — One-time migration script.
 *
 * Purpose:
 *   Reads all nodes and edges from the legacy SQLite knowledge.db
 *   and writes them into the new Kùzu graph at .lore/graph/.
 *
 * Usage:
 *   node tools/lore/scripts/migrate-sqlite-to-kuzu.mjs
 *
 * Prerequisites:
 *   - ~/.groundfloor/knowledge.db must exist (source)
 *   - @kineviz/kuzu-lite must be installed in tools/lore/
 *
 * Side Effects:
 *   - Creates .lore/graph/ in the current repo root
 *   - Writes all nodes and edges to Kùzu
 *
 * Determinism: Idempotent — nodes are created with CREATE IF NOT EXISTS pattern,
 *   edges are additive (duplicates may occur if run twice).
 */

import { execSync } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';

// Resolve paths
const sqlitePath = path.join(os.homedir(), '.groundfloor', 'knowledge.db');

// Find repo root (walk up looking for .git)
let repoRoot = process.cwd();
let dir = repoRoot;
while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) { repoRoot = dir; break; }
    dir = path.dirname(dir);
}

console.log(`📦 Source: ${sqlitePath}`);
console.log(`📂 Target: ${path.join(repoRoot, '.lore', 'graph')}`);

// ─── Read SQLite data ────────────────────────────────────────────────────────

if (!fs.existsSync(sqlitePath)) {
    console.error('❌ SQLite database not found at', sqlitePath);
    process.exit(1);
}

const nodesJson = execSync(`sqlite3 -json "${sqlitePath}" "SELECT * FROM nodes;"`, { encoding: 'utf-8' });
const edgesJson = execSync(`sqlite3 -json "${sqlitePath}" "SELECT * FROM edges;"`, { encoding: 'utf-8' });

const nodes = JSON.parse(nodesJson);
const edges = JSON.parse(edgesJson);

console.log(`✅ Read ${nodes.length} nodes and ${edges.length} edges from SQLite`);

// ─── Initialize Kùzu ─────────────────────────────────────────────────────────

const kuzuModule = await import('@kineviz/kuzu-lite');
const { Database, Connection } = kuzuModule.default || kuzuModule;

const loreDir = path.join(repoRoot, '.lore');
fs.mkdirSync(loreDir, { recursive: true });
const graphPath = path.join(loreDir, 'graph');

const db = new Database(graphPath);
const conn = new Connection(db);

// Create schema
await conn.query(`
    CREATE NODE TABLE IF NOT EXISTS LoreNode (
        id STRING, type STRING, label STRING, content STRING, tags STRING,
        project STRING, ecosystem STRING, metadata STRING,
        createdAt STRING, updatedAt STRING, syncedAt STRING,
        PRIMARY KEY (id)
    )
`);
await conn.query(`
    CREATE REL TABLE IF NOT EXISTS LoreEdge (
        FROM LoreNode TO LoreNode,
        relation STRING
    )
`);
console.log('✅ Kùzu schema ready');

// ─── Migrate Nodes ───────────────────────────────────────────────────────────

const stmtInsert = await conn.prepare(`
    CREATE (n:LoreNode {
        id: $id, type: $type, label: $label, content: $content,
        tags: $tags, project: $project, ecosystem: $ecosystem,
        metadata: $metadata, createdAt: $createdAt,
        updatedAt: $updatedAt, syncedAt: $syncedAt
    })
`);

let nodeCount = 0;
let nodeSkipped = 0;

for (const node of nodes) {
    try {
        // Check if node already exists
        const checkResult = await conn.query(`MATCH (n:LoreNode {id: '${escape(node.id)}'}) RETURN n.id`);
        const existing = await checkResult.getAll();
        if (existing.length > 0) {
            nodeSkipped++;
            continue;
        }

        await conn.execute(stmtInsert, {
            id: node.id,
            type: node.type,
            label: node.label,
            content: node.content || '',
            tags: node.tags || '',
            project: node.project || '*',
            ecosystem: node.ecosystem || '*',
            metadata: node.metadata || '{}',
            createdAt: node.created_at || new Date().toISOString(),
            updatedAt: node.updated_at || new Date().toISOString(),
            syncedAt: '',
        });
        nodeCount++;
    } catch (err) {
        console.error(`⚠️  Node '${node.id}': ${err.message}`);
    }
}

console.log(`✅ Migrated ${nodeCount} nodes (${nodeSkipped} already existed)`);

// ─── Migrate Edges ───────────────────────────────────────────────────────────

const stmtEdge = await conn.prepare(`
    MATCH (a:LoreNode {id: $sourceId}), (b:LoreNode {id: $targetId})
    CREATE (a)-[:LoreEdge {relation: $relation}]->(b)
`);

let edgeCount = 0;
let edgeFailed = 0;

for (const edge of edges) {
    try {
        await conn.execute(stmtEdge, {
            sourceId: edge.source_id,
            targetId: edge.target_id,
            relation: edge.relation,
        });
        edgeCount++;
    } catch (err) {
        edgeFailed++;
    }
}

console.log(`✅ Migrated ${edgeCount} edges (${edgeFailed} failed — missing nodes)`);

// ─── Verify ──────────────────────────────────────────────────────────────────

const countResult = await conn.query('MATCH (n:LoreNode) RETURN count(n) AS cnt');
const countRows = await countResult.getAll();
const totalNodes = countRows[0]?.['cnt'] ?? 0;

const edgeCountResult = await conn.query('MATCH ()-[e:LoreEdge]->() RETURN count(e) AS cnt');
const edgeCountRows = await edgeCountResult.getAll();
const totalEdges = edgeCountRows[0]?.['cnt'] ?? 0;

console.log('');
console.log('═══════════════════════════════════════════════════════════');
console.log(`  Migration complete!`);
console.log(`  Kùzu graph: ${totalNodes} nodes, ${totalEdges} edges`);
console.log(`  Path: ${graphPath}`);
console.log('═══════════════════════════════════════════════════════════');

await conn.close();
await db.close();

/**
 * escape — Escape single quotes for inline Cypher.
 */
function escape(value) {
    return value.replace(/'/g, "\\'");
}
