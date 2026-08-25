// verify.js — read back every row by SINGLE-ID lookup (read-only open),
// compare bytes+sha256 against the expected manifest.
// Reports: mismatches, oversized values, duplicate large-value hashes.
//
// Usage: node verify.js <dbPath> <manifestFile>
const kuzu = require('@kineviz/kuzu-lite');
const crypto = require('crypto');
const fs = require('fs');
const readline = require('readline');

const [dbPath, manifestFile] = process.argv.slice(2);

(async () => {
    const expected = new Map();
    const rl = readline.createInterface({ input: fs.createReadStream(manifestFile), crlfDelay: Infinity });
    for await (const line of rl) {
        if (!line.trim()) continue;
        let r;
        try { r = JSON.parse(line); } catch { continue; } // tolerate truncated tail after kill -9
        if (r.deleted) { expected.set(r.id, r); continue; }
        if (!r.error) expected.set(r.id, r);
    }
    console.log(`manifest: ${expected.size} rows expected`);

    const db = new kuzu.Database(dbPath, 0, true, true, 64 * 1024 * 1024 * 1024); // READ-ONLY
    const conn = new kuzu.Connection(db);
    const stmt = await conn.prepare(`MATCH (n:LoreNode {id: $id}) RETURN n.metadata AS metadata`);

    let checked = 0, ok = 0, missing = 0, mismatch = 0, oversized = 0, resurrected = 0;
    const mismatches = [];
    const bigByHash = new Map(); // sha -> [ids] for values > 8KB
    for (const [id, exp] of expected) {
        const r = await conn.execute(stmt, { id });
        const rows = await r.getAll();
        try { r.close(); } catch {}
        checked++;
        if (exp.deleted) {
            if (rows.length === 0) { ok++; } else { resurrected++; mismatch++; }
            continue;
        }
        if (rows.length === 0) { missing++; continue; }
        const m = rows[0].metadata == null ? '' : String(rows[0].metadata);
        const bytes = Buffer.byteLength(m, 'utf8');
        const sha = crypto.createHash('sha256').update(m, 'utf8').digest('hex');
        if (sha === exp.sha256 && bytes === exp.bytes) { ok++; continue; }
        mismatch++;
        if (bytes > exp.bytes) oversized++;
        if (bytes > 8192) {
            if (!bigByHash.has(sha)) bigByHash.set(sha, []);
            bigByHash.get(sha).push(id);
        }
        if (mismatches.length < 10) {
            mismatches.push({ id, expectedBytes: exp.bytes, gotBytes: bytes, expectedSha: exp.sha256.slice(0, 12), gotSha: sha.slice(0, 12) });
        }
    }
    const dupBig = [...bigByHash.entries()].filter(([, ids]) => ids.length > 1)
        .map(([sha, ids]) => ({ sha: sha.slice(0, 12), count: ids.length, sample: ids.slice(0, 3) }));
    console.log(JSON.stringify({ checked, ok, missing, mismatch, oversized, resurrected, duplicateLargeValueGroups: dupBig.length, dupBig: dupBig.slice(0, 5), sampleMismatches: mismatches }, null, 1));
    process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
