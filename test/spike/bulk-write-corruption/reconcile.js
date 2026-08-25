// reconcile.js — for every anomaly vs the manifest, check whether the DB value
// equals one of the deterministic per-pass metas (P1/P2/P3). If yes, the
// anomaly is an error-after-commit artifact, not corruption.
const kuzu = require('@kineviz/kuzu-lite');
const crypto = require('crypto'), fs = require('fs'), readline = require('readline');

function makeMeta(i, kind, passTag) {
    if (i % 50 === 7) return null;
    if (i % 20 === 3) return '{}';
    const targetLen = 200 + (i % 800);
    const base = { path: `src/mod${i % 50}/file${i}.ts`, kind, seq: i, repo: 'repro-repo', pass: passTag, pad: '' };
    let s = JSON.stringify(base);
    while (s.length < targetLen) { base.pad += 'y'; s = JSON.stringify(base); }
    return s;
}
function idxOf(id) { const m = id.match(/sym(\d+):function$|file(\d+)\.ts$|dir(\d+)$/); return parseInt(m[1] || m[2] || m[3], 10); }
function kindOf(id) { return id.startsWith('code-folder') ? 'folder' : id.startsWith('code-file') ? 'file' : 'symbol'; }

(async () => {
    const expected = new Map();
    const rl = readline.createInterface({ input: fs.createReadStream('/tmp/lore-bulk-repro/run4/manifest.jsonl'), crlfDelay: Infinity });
    for await (const line of rl) {
        if (!line.trim()) continue;
        let r; try { r = JSON.parse(line); } catch { continue; }
        if (!r.error) expected.set(r.id, r);
    }
    const db = new kuzu.Database('/tmp/lore-bulk-repro/run4/.lore/graph', 0, true, true, 64 * 1024 * 1024 * 1024);
    const conn = new kuzu.Connection(db);
    const stmt = await conn.prepare('MATCH (n:LoreNode {id: $id}) RETURN n.metadata AS metadata');
    let explained = 0, unexplained = 0, anomalies = 0;
    const unexplainedIds = [];
    for (const [id, exp] of expected) {
        const r = await conn.execute(stmt, { id });
        const rows = await r.getAll(); try { r.close(); } catch {}
        const present = rows.length > 0;
        const m = present && rows[0].metadata != null ? String(rows[0].metadata) : '';
        const sha = crypto.createHash('sha256').update(m, 'utf8').digest('hex');
        if (exp.deleted && !present) continue;
        if (!exp.deleted && present && sha === exp.sha256) continue;
        anomalies++;
        const i = idxOf(id), kind = kindOf(id);
        let matchedPass = null;
        for (const p of ['P1', 'P2', 'P3']) {
            const pm = makeMeta(i, kind, p);
            const ps = crypto.createHash('sha256').update(pm == null ? '' : pm, 'utf8').digest('hex');
            if (ps === sha) { matchedPass = p; break; }
        }
        if (matchedPass) explained++;
        else { unexplained++; if (unexplainedIds.length < 8) unexplainedIds.push({ id, expDeleted: !!exp.deleted, present, gotSha: sha.slice(0, 12), gotBytes: Buffer.byteLength(m) }); }
    }
    console.log(JSON.stringify({ anomalies, explainedByDeterministicMeta: explained, unexplained, unexplainedIds }, null, 1));
    process.exit(0);
})();
