// repro-raw.js — raw kuzu-lite replica of LocalGraph.bulkUpsertNodes.
// Prepares exist/set/create statements ONCE, then loops thousands of nodes,
// mimicking an Atlas code import (folders, then files, then symbols).
// Writes an expected-manifest JSONL: {id, bytes, sha256} of what was written.
//
// Usage: node repro-raw.js <dbPath> <totalNodes> <manifestFile> [metaMinBytes] [metaMaxBytes]
const kuzu = require('@kineviz/kuzu-lite');
const crypto = require('crypto');
const fs = require('fs');

const [dbPath, totalStr, manifestFile, minStr, maxStr] = process.argv.slice(2);
const TOTAL = parseInt(totalStr, 10);
const META_MIN = parseInt(minStr || '200', 10);
const META_MAX = parseInt(maxStr || '1024', 10);

function makeMeta(i, kind) {
    // distinct small JSON per node, sized like real code-intel metadata
    const targetLen = META_MIN + (i % (META_MAX - META_MIN));
    const base = { path: `src/mod${i % 50}/file${i}.ts`, kind, seq: i, repo: 'repro-repo', pad: '' };
    let s = JSON.stringify(base);
    while (s.length < targetLen) {
        base.pad += 'x';
        s = JSON.stringify(base);
    }
    return s;
}

(async () => {
    fs.mkdirSync(require('path').dirname(dbPath), { recursive: true });
    const db = new kuzu.Database(dbPath, 0, true, false, 64 * 1024 * 1024 * 1024);
    const conn = new kuzu.Connection(db);

    await conn.query(`CREATE NODE TABLE IF NOT EXISTS LoreNode (
        id STRING, type STRING, label STRING, content STRING, tags STRING[],
        project STRING, ecosystem STRING, metadata STRING, createdAt STRING,
        updatedAt STRING, syncedAt STRING, security_scopes STRING[],
        legalHold BOOLEAN DEFAULT FALSE, language STRING DEFAULT '',
        supersededBy STRING DEFAULT '', supersededAt STRING DEFAULT '',
        supersededReason STRING DEFAULT '', ephemeral BOOLEAN DEFAULT FALSE,
        ttl_ms INT64 DEFAULT 0, stale BOOLEAN DEFAULT FALSE,
        status STRING DEFAULT 'active', classification STRING DEFAULT 'tactical',
        anchor_stale BOOLEAN DEFAULT FALSE, anchor_stale_since STRING DEFAULT '',
        PRIMARY KEY (id))`);

    // --- exact replica of bulkUpsertNodes statements ---
    const existStmt = await conn.prepare(`MATCH (n:LoreNode {id: $id}) RETURN n.createdAt AS createdAt`);
    const setStmt = await conn.prepare(
        `MATCH (n:LoreNode {id: $id})
         SET n.type = $type, n.label = $label, n.content = $content, n.tags = $tags,
             n.project = $project, n.ecosystem = $ecosystem, n.metadata = $metadata,
             n.updatedAt = $updatedAt, n.syncedAt = $syncedAt, n.security_scopes = $security_scopes,
             n.language = $language, n.ephemeral = $ephemeral, n.ttl_ms = $ttl_ms,
             n.stale = $stale, n.status = $status, n.classification = $classification,
             n.anchor_stale = $anchor_stale, n.anchor_stale_since = $anchor_stale_since`);
    const createStmt = await conn.prepare(
        `CREATE (n:LoreNode {id: $id, type: $type, label: $label, content: $content, tags: $tags,
            project: $project, ecosystem: $ecosystem, metadata: $metadata, createdAt: $createdAt,
            updatedAt: $updatedAt, syncedAt: $syncedAt, security_scopes: $security_scopes,
            language: $language, ephemeral: $ephemeral, ttl_ms: $ttl_ms, stale: $stale,
            status: $status, classification: $classification,
            anchor_stale: $anchor_stale, anchor_stale_since: $anchor_stale_since})`);

    const manifest = fs.createWriteStream(manifestFile);
    const now = new Date().toISOString();
    const t0 = Date.now();

    for (let i = 0; i < TOTAL; i++) {
        // import order: folders (5%), then files (20%), then symbols (75%)
        let id, kind;
        if (i < TOTAL * 0.05) { kind = 'folder'; id = `code-folder:repro-repo/src/dir${i}`; }
        else if (i < TOTAL * 0.25) { kind = 'file'; id = `code-file:repro-repo/src/mod${i % 50}/file${i}.ts`; }
        else { kind = 'symbol'; id = `code-symbol:repro-repo/src/mod${i % 50}/file${i % 1000}.ts:sym${i}:function`; }

        const metadata = makeMeta(i, kind);
        const params = {
            id, type: kind === 'folder' ? 'code-folder' : kind === 'file' ? 'code-file' : 'code-symbol',
            label: id, content: '', tags: ['code', kind], project: 'repro', ecosystem: '',
            metadata, createdAt: now, updatedAt: now, syncedAt: '', security_scopes: [],
            language: 'typescript', ephemeral: false, ttl_ms: 0, stale: false,
            status: 'active', classification: 'tactical', anchor_stale: false, anchor_stale_since: '',
        };

        // per-row error isolation, same as bulkUpsertNodes
        try {
            const r = await conn.execute(existStmt, { id });
            const rows = await r.getAll();
            try { r.close(); } catch {}
            if (rows.length > 0) {
                const w = await conn.execute(setStmt, { ...params });
                try { w.close(); } catch {}
            } else {
                const w = await conn.execute(createStmt, { ...params });
                try { w.close(); } catch {}
            }
            const sha = crypto.createHash('sha256').update(metadata, 'utf8').digest('hex');
            manifest.write(JSON.stringify({ id, bytes: Buffer.byteLength(metadata, 'utf8'), sha256: sha }) + '\n');
        } catch (e) {
            manifest.write(JSON.stringify({ id, error: e.message }) + '\n');
        }
        if (i % 2000 === 0) console.log(`wrote ${i}/${TOTAL} (${Date.now() - t0}ms)`);
    }
    manifest.end();
    await new Promise((res) => manifest.on('finish', res));
    console.log(`DONE wrote ${TOTAL} nodes in ${Date.now() - t0}ms`);
    // skip db.close() — known kuzu-lite 0.11.3 segfault; WAL checkpoint on
    // next open is part of what we're testing anyway.
    process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
