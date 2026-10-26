#!/usr/bin/env tsx
/**
 * workspace-erase-plugin-daemon-e2e.ts - lane f6c wire-up proof, REAL DAEMON over HTTP on an ephemeral port (SQLite, filesystem blob store).
 *
 * The daemon is the real `mcp/server.ts --http` process with ingestion ON. Two workspaces (ing-a, ing-b) each ingest an
 * IDENTICAL text file through POST /api/admin/ingest/enqueue. Then `DELETE /api/workspaces/ing-a?erase=now` and the daemon's
 * own scheduled tick finish the job. Proven: A's uploaded file is gone and the blob step of the receipt says so
 * (`removed.blobs >= 1`, `remaining.blobs === 0`), B's whole folder is byte-identical, and the receipt is `complete`.
 * (The same-name guard has its own unit test.) No Postgres, no Dataplane, no OS keychain (preload), no port other than the ephemeral one.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { cleanup, fetchAuthToken, killDaemon, spawnDaemon, waitForReady, type DaemonHandle } from './helpers/live-daemon.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok   ${name}`); }
    catch (e) { failed++; console.error(`  FAIL ${name}\n       ${((e as Error).stack ?? String(e)).split('\n').slice(0, 6).join('\n       ')}`); }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

/** Every file under `dir` (relative path -> sha256), skipping the SQLite journal files that change while a daemon runs. */
function treeOf(dir: string, skip: RegExp = /\.(sqlite|db)(-wal|-shm|-journal)?$/): Record<string, string> {
    const out: Record<string, string> = {};
    const walk = (d: string): void => {
        for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (!skip.test(e.name)) out[path.relative(dir, p)] = createHash('sha256').update(fs.readFileSync(p)).digest('hex');
        }
    };
    walk(dir);
    return out;
}

let h: DaemonHandle | null = null;
try {
    h = await spawnDaemon({
        nodeArgs: ['--import', path.join(REPO, 'test/helpers/workspace-erase-preload.ts')],
        env: { LORE_MODEL_SERVER: '0', LORE_INGEST_ENABLED: '1', LORE_INGEST_WORKSPACES: 'ing-a,ing-b', LORE_INGEST_BLOB_STORE: 'fs' },
    });
    if (!(await waitForReady(h.port, 60_000))) throw new Error(`daemon never became ready\n${h.log.text.slice(-3000)}`);
    h.token = await fetchAuthToken(h.port, h.home);
    const base = `http://127.0.0.1:${h.port}`;
    const lh = path.join(h.home, '.groundfloor');
    const req = (method: string, p: string, body?: unknown): Promise<Response> =>
        fetch(`${base}${p}`, { method, headers: { Authorization: `Bearer ${h!.token}`, Origin: base, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const json = async (r: Response): Promise<any> => { try { return await r.json(); } catch { return null; } }; // eslint-disable-line @typescript-eslint/no-explicit-any
    const registry = (): { workspaces: Array<{ name: string; path: string; id?: string }> } => JSON.parse(fs.readFileSync(path.join(lh, 'workspaces.json'), 'utf8'));
    const entry = (n: string): { name: string; path: string; id?: string } | undefined => registry().workspaces.find((w) => w.name === n);
    const logLines = (): Array<Record<string, any>> => { // eslint-disable-line @typescript-eslint/no-explicit-any
        const f = path.join(lh, 'workspace-deletions.jsonl');
        return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } }) : [];
    };

    for (const n of ['ing-a', 'ing-b']) assert.ok([200, 201].includes((await req('POST', '/api/workspaces', { name: n })).status), `create ${n}`);
    const A = entry('ing-a')!, B = entry('ing-b')!;
    const idA = A.id!; assert.ok(idA);
    const TEXT = Buffer.from('Unit 4B rent 2400.\n\nUnit 5A rent 2650.\n').toString('base64'); // identical bytes in both workspaces

    const enqueue = async (ws: string): Promise<string> => {
        let last = '';
        for (let i = 0; i < 40; i++) { // the ingestion host starts a moment after the HTTP listener
            const r = await req('POST', '/api/admin/ingest/enqueue', { workspace: ws, fileName: 'rent.txt', mimeType: 'text/plain', contentBase64: TEXT });
            const b = await json(r);
            if (r.status === 202 || r.status === 200) return b.jobId as string;
            last = `${r.status} ${JSON.stringify(b)}`; await sleep(500);
        }
        throw new Error(`enqueue into ${ws} never accepted: ${last}\n${h!.log.text.slice(-1500)}`);
    };
    const blobsDir = (e: { path: string }): string => path.join(e.path, 'ingestion-blobs');

    await check('the same file is uploaded into both workspaces; each has its own stored copy on disk', async () => {
        await enqueue('ing-a'); await enqueue('ing-b');
        const ta = treeOf(blobsDir(A)), tb = treeOf(blobsDir(B));
        assert.ok(Object.keys(ta).length >= 1, 'A stored the upload');
        assert.ok(Object.keys(tb).length >= 1, 'B stored the upload');
        assert.deepEqual(Object.values(ta).sort(), Object.values(tb).sort(), 'identical bytes in both');
        assert.ok(fs.existsSync(path.join(A.path, 'ingestion.sqlite')) && fs.existsSync(path.join(B.path, 'ingestion.sqlite')));
    });

    const bBefore = treeOf(B.path);
    const aFilesBefore = Object.keys(treeOf(blobsDir(A))).length;

    await check('DELETE ing-a ?erase=now: erased; the daemon receipt is complete and its upload step removed the file', async () => {
        const r = await req('DELETE', '/api/workspaces/ing-a?erase=now');
        const body = await json(r);
        assert.equal(r.status, 200, JSON.stringify(body)); assert.equal(body.erase.status, 'erased');
        assert.ok(!entry('ing-a'));
        const end = Date.now() + 30_000;
        while (Date.now() < end && !logLines().some((l) => l['event'] === 'erased' && l['id'] === idA)) await sleep(300);
        const receipt = logLines().find((l) => l['event'] === 'erased' && l['id'] === idA);
        assert.ok(receipt, `no erased receipt\n${h!.log.text.slice(-1500)}`);
        assert.equal(receipt['status'], 'complete', JSON.stringify(receipt['stores']));
        const stores = receipt['stores'] as Array<{ store: string; status: string; removed: Record<string, number>; remaining: Record<string, number> }>;
        const blob = stores.find((s) => s.store === 'blobs-fs');
        assert.ok(blob, `blob step missing: ${JSON.stringify(stores)}`);
        assert.equal(blob.status, 'complete'); assert.ok((blob.removed['blobs'] ?? 0) >= aFilesBefore, JSON.stringify(blob)); assert.equal(blob.remaining['blobs'], 0);
        assert.equal(stores.find((s) => s.store === 'postgres')?.status, 'not-applicable');
        assert.equal(stores.find((s) => s.store === 'local-dir')?.status, 'complete');
        assert.equal(logLines().filter((l) => l['event'] === 'erased' && l['id'] === idA).length, 1, 'erased exactly once');
    });

    await check("A's uploaded file and folder are gone from disk", () => {
        assert.ok(!fs.existsSync(A.path), 'A folder gone');
        assert.ok(!fs.existsSync(path.join(lh, 'workspaces', `.erase-hold-${idA}`)), 'A holding folder gone');
    });

    await check("B is untouched: still registered, every file under its folder byte-identical, upload still on disk", async () => {
        await sleep(2500); // a few more daemon ticks
        assert.ok(entry('ing-b'));
        assert.deepEqual(treeOf(B.path), bBefore);
        assert.ok(Object.keys(treeOf(blobsDir(B))).length >= 1);
        assert.equal(logLines().filter((l) => l['event'] === 'erased').length, 1, 'only A was ever erased');
    });
} finally {
    if (h) { await killDaemon(h, 'SIGTERM', 8000); cleanup(h); }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
