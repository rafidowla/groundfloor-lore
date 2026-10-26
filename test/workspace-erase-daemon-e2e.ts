#!/usr/bin/env tsx
/**
 * workspace-erase-daemon-e2e.ts — lane f6b wire-up proof, REAL DAEMON over HTTP (ephemeral port, isolated HOME).
 *
 * The daemon is the real `mcp/server.ts --http` process. The scheduled erase is done by the tick that process
 * started itself. Seams (preload): keychain off, fast tick, fake clock via a file. Flow:
 * write data (3 workspaces, two sharing content) -> DELETE (response `erase` field; folder hidden; unreachable;
 * bound / read-only tokens refused) -> same name reusable and empty -> restore refused while the name is taken
 * (CLI) -> erase the new one (?erase=now) -> restore the old one (CLI, same id, data back over HTTP) -> DELETE
 * again -> clock +8 days -> daemon tick erases -> receipt complete (log + CLI) -> neighbours identical throughout.
 * No real Dataplane, no OS keychain, no port other than the ephemeral one.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
const DAY = 86_400_000;

let h: DaemonHandle | null = null;
try {
    h = await spawnDaemon({ nodeArgs: ['--import', path.join(REPO, 'test/helpers/workspace-erase-preload.ts')] });
    if (!(await waitForReady(h.port, 60_000))) throw new Error(`daemon never became ready\n${h.log.text.slice(-3000)}`);
    h.token = await fetchAuthToken(h.port, h.home);
    const base = `http://127.0.0.1:${h.port}`;
    const lh = path.join(h.home, '.groundfloor');
    const hdr = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}`, Origin: base });
    const req = (t: string, method: string, p: string, body?: unknown): Promise<Response> =>
        fetch(`${base}${p}`, { method, headers: { ...hdr(t), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const json = async (r: Response): Promise<any> => { try { return await r.json(); } catch { return null; } }; // eslint-disable-line @typescript-eslint/no-explicit-any
    const registry = (): { workspaces: Array<{ name: string; path: string; id?: string }> } => JSON.parse(fs.readFileSync(path.join(lh, 'workspaces.json'), 'utf8'));
    const entry = (n: string): { name: string; path: string; id?: string } | undefined => registry().workspaces.find((w) => w.name === n);
    const logLines = (): Array<Record<string, any>> => { // eslint-disable-line @typescript-eslint/no-explicit-any
        const f = path.join(lh, 'workspace-deletions.jsonl');
        return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } }) : [];
    };
    const setClockOffset = (ms: number): void => fs.writeFileSync(path.join(h!.home, 'f6b-clock-offset-ms'), String(ms));
    const cli = (...args: string[]): { code: number | null; out: string } => {
        const r = spawnSync(process.execPath, ['--import', 'tsx', path.join(REPO, 'packages/lore/src/cli/index.ts'), ...args], { cwd: REPO, encoding: 'utf8', timeout: 90_000,
            env: { PATH: process.env['PATH'], HOME: h!.home, TMPDIR: process.env['TMPDIR'] ?? '/tmp', LORE_MODEL_SERVER: '0' } });
        return { code: r.status, out: `${r.stdout}${r.stderr}` };
    };
    // The daemon's fast test tick holds the erase lock for a moment every second; the CLI then reports busy
    // ("try again in a minute"). Retry like a user would, so the check does not depend on that timing.
    const cliRetryBusy = async (...args: string[]): Promise<{ code: number | null; out: string }> => {
        let r = cli(...args);
        for (let i = 0; i < 20 && r.code !== 0 && /try again in a minute/.test(r.out); i++) { await sleep(250); r = cli(...args); }
        return r;
    };

    process.env['LORE_HOME'] = lh; // so issueToken writes into the daemon's own token registry (as wave4 does)
    const { issueToken } = await import('../packages/lore/src/auth/tokens.js');
    for (const n of ['doomed', 'doomed-2', 'sharer']) assert.ok([200, 201].includes((await req(h.token, 'POST', '/api/workspaces', { name: n })).status), `create ${n}`);
    const tok = (ws: string, scopes: Array<'read' | 'write'> = ['read', 'write']): string => issueToken({ workspace: ws, label: `f6b-${ws}`, scopes }).token;
    const tD = tok('doomed'), tN = tok('doomed-2'), tS = tok('sharer'), tNro = tok('doomed-2', ['read']);
    const SHARED = 'identical content shared by two workspaces';
    const put = async (t: string, ws: string, id: string, content: string): Promise<void> => {
        const r = await req(t, 'POST', '/api/node', { id, type: 'note', label: id, content, tags: 'f6b', workspace: ws });
        assert.ok([200, 201].includes(r.status), `write ${ws}/${id}: ${r.status}`);
    };
    const readNode = async (t: string, ws: string, id: string): Promise<{ status: number; body: any }> => { const r = await req(t, 'GET', `/api/node?id=${id}&workspace=${ws}`); return { status: r.status, body: await json(r) }; }; // eslint-disable-line @typescript-eslint/no-explicit-any
    await put(tD, 'doomed', 'n-doomed', 'only in doomed'); await put(tD, 'doomed', 'n-shared', SHARED);
    await put(tN, 'doomed-2', 'n-nb', 'neighbour data'); await put(tN, 'doomed-2', 'n-shared', SHARED);
    await put(tS, 'sharer', 'n-shared', SHARED);
    const neighbours = async (): Promise<string> => JSON.stringify([await readNode(tN, 'doomed-2', 'n-nb'), await readNode(tN, 'doomed-2', 'n-shared'), await readNode(tS, 'sharer', 'n-shared')]);
    const nbBefore = await neighbours();
    const nbDirs = ['doomed-2', 'sharer'].map((n) => entry(n)!.path);
    const doomedEntry = entry('doomed')!; const ID1 = doomedEntry.id!;
    assert.ok(ID1, 'stored permanent id'); assert.equal((await readNode(tD, 'doomed', 'n-doomed')).status, 200);

    await check('refused deletes change nothing: bad ?erase value (400), read-only and workspace-bound tokens (4xx)', async () => {
        assert.equal((await req(h!.token, 'DELETE', '/api/workspaces/doomed?erase=later')).status, 400);
        for (const [t, ws] of [[tNro, 'doomed-2'], [tN, 'doomed-2'], [tD, 'doomed']] as const) {
            const r = await req(t, 'DELETE', `/api/workspaces/${ws}?erase=now`);
            assert.ok(r.status >= 400 && r.status < 500, `${ws} delete by a non-operator token must be refused (got ${r.status})`);
        }
        assert.ok(entry('doomed') && entry('doomed-2') && fs.existsSync(doomedEntry.path));
        assert.ok(!fs.existsSync(path.join(lh, 'workspace-deletions.jsonl')) || logLines().length === 0, 'no deletion record for a refused delete');
        assert.equal(await neighbours(), nbBefore);
    });

    await check('DELETE hides at once: response carries the additive erase field; folder held; workspace unreachable', async () => {
        let r = await req(h!.token, 'DELETE', '/api/workspaces/doomed');
        for (let i = 0; r.status === 400 && i < 20; i++) { await sleep(500); r = await req(h!.token, 'DELETE', '/api/workspaces/doomed'); } // embed work may still be draining
        const body = await json(r);
        assert.equal(r.status, 200, JSON.stringify(body));
        assert.ok(Array.isArray(body.workspaces), 'existing response shape kept');
        assert.equal(body.erase.status, 'scheduled'); assert.equal(body.erase.windowDays, 7);
        assert.equal(body.erase.restoreCommand, `lore workspaces restore ${ID1}`);
        assert.match(body.erase.notReached, /backups/);
        assert.ok(Date.parse(body.erase.eraseAfter) > Date.now() + 6 * DAY);
        assert.ok(!entry('doomed')); assert.ok(!fs.existsSync(doomedEntry.path));
        assert.ok(fs.existsSync(path.join(lh, 'workspaces', `.erase-hold-${ID1}`)));
        const list = await json(await req(h!.token, 'GET', '/api/workspaces'));
        assert.ok(!JSON.stringify(list).includes('"doomed"'), 'not listed any more');
        assert.ok((await readNode(tD, 'doomed', 'n-doomed')).status !== 200, 'old data is unreachable');
        assert.ok(!fs.existsSync(doomedEntry.path), 'the failed read must not recreate the folder');
        const rec = logLines().find((l) => l['event'] === 'deleted' && l['id'] === ID1)!;
        assert.ok(rec['eraseAfter'] && rec['holdingPath'], 'additive record fields');
        assert.equal(await neighbours(), nbBefore);
    });

    await check('same name is reusable and EMPTY; restore (CLI) refuses while the name is taken and suggests --as', async () => {
        assert.ok([200, 201].includes((await req(h!.token, 'POST', '/api/workspaces', { name: 'doomed' })).status));
        const t2 = tok('doomed');
        assert.notEqual(entry('doomed')!.id, ID1);
        assert.equal((await readNode(t2, 'doomed', 'n-doomed')).status === 200 && (await readNode(t2, 'doomed', 'n-doomed')).body?.node?.id === 'n-doomed', false, 'no old data in the new workspace');
        const r = await cliRetryBusy('workspaces', 'restore', ID1);
        assert.notEqual(r.code, 0); assert.match(r.out, /--as/);
        assert.ok(fs.existsSync(path.join(lh, 'workspaces', `.erase-hold-${ID1}`)), 'a refused restore leaves the held folder alone');
    });

    await check('?erase=now removes ONLY the new same-named workspace; the held old one and the neighbours stay', async () => {
        const ID2 = entry('doomed')!.id!;
        let r = await req(h!.token, 'DELETE', '/api/workspaces/doomed?erase=now');
        for (let i = 0; r.status === 400 && i < 20; i++) { await sleep(500); r = await req(h!.token, 'DELETE', '/api/workspaces/doomed?erase=now'); }
        const body = await json(r);
        assert.equal(r.status, 200, JSON.stringify(body)); assert.equal(body.erase.status, 'erased'); assert.equal(body.erase.restoreCommand, null);
        assert.ok(!entry('doomed'));
        assert.ok(fs.existsSync(path.join(lh, 'workspaces', `.erase-hold-${ID1}`)));
        const erased = logLines().filter((l) => l['event'] === 'erased');
        assert.equal(erased.length, 1); assert.equal(erased[0]!['status'], 'complete'); assert.notEqual(erased[0]!['id'], ID1);
        assert.equal(await neighbours(), nbBefore);
        // The request's own audit entry is written after the blank-out ran: it must name the permanent id, not the name.
        const auditFile = path.join(lh, 'audit.jsonl');
        const find = (): Record<string, any> | undefined => fs.readFileSync(auditFile, 'utf8').split('\n').filter(Boolean) // eslint-disable-line @typescript-eslint/no-explicit-any
            .map((l) => { try { return JSON.parse(l); } catch { return {}; } })
            .find((e) => e['toolName'] === 'workspaces.delete' && e['args']?.['erase'] === 'now' && e['result'] === 'success');
        let ent = find();
        for (let i = 0; !ent && i < 20; i++) { await sleep(250); ent = find(); }
        assert.ok(ent, 'erase=now request audited');
        assert.deepEqual(ent['args'], { workspaceId: ID2, erase: 'now', eraseStatus: 'erased' });
    });

    await check('restore (CLI): same id, data back over HTTP', async () => {
        const r = await cliRetryBusy('workspaces', 'restore', ID1);
        assert.equal(r.code, 0, r.out);
        assert.equal(entry('doomed')?.id, ID1);
        assert.ok(!fs.existsSync(path.join(lh, 'workspaces', `.erase-hold-${ID1}`)));
        let n = await readNode(tD, 'doomed', 'n-doomed');
        for (let i = 0; n.status !== 200 && i < 10; i++) { await sleep(500); n = await readNode(tD, 'doomed', 'n-doomed'); }
        assert.equal(n.status, 200, `restored data must be readable without a daemon restart: ${JSON.stringify(n)}`);
        assert.equal((await readNode(tD, 'doomed', 'n-shared')).status, 200);
        assert.equal(await neighbours(), nbBefore);
    });

    await check('DELETE again; inside the window nothing is erased; +8 days the DAEMON tick erases it; receipt complete; folder gone', async () => {
        let r = await req(h!.token, 'DELETE', '/api/workspaces/doomed');
        for (let i = 0; r.status === 400 && i < 20; i++) { await sleep(500); r = await req(h!.token, 'DELETE', '/api/workspaces/doomed'); }
        assert.equal(r.status, 200); assert.equal((await json(r)).erase.status, 'scheduled');
        await sleep(3500); // several daemon ticks inside the window
        const hold = path.join(lh, 'workspaces', `.erase-hold-${ID1}`);
        assert.ok(fs.existsSync(hold));
        assert.ok(!logLines().some((l) => l['event'] === 'erased' && l['id'] === ID1), 'nothing erased inside the window');
        setClockOffset(8 * DAY);
        const end = Date.now() + 30_000;
        while (Date.now() < end && !logLines().some((l) => l['event'] === 'erased' && l['id'] === ID1)) await sleep(300);
        const receipt = logLines().find((l) => l['event'] === 'erased' && l['id'] === ID1);
        assert.ok(receipt, `daemon tick never erased it\n${h!.log.text.slice(-1500)}`);
        assert.equal(receipt['status'], 'complete');
        assert.ok((receipt['stores'] as Array<{ store: string; status: string }>).some((s) => s.store === 'local-dir' && s.status === 'complete'));
        assert.ok(!fs.existsSync(hold), 'folder gone'); assert.ok(!fs.existsSync(doomedEntry.path));
        assert.equal(logLines().filter((l) => l['event'] === 'erased' && l['id'] === ID1).length, 1, 'erased exactly once');
        const listed = cli('workspaces', 'deleted', '--json');
        assert.equal(listed.code, 0, listed.out);
        const rows = JSON.parse(listed.out.slice(listed.out.indexOf('{'))).deleted as Array<{ id: string; state: string }>;
        assert.equal(rows.find((x) => x.id === ID1)?.state, 'erased');
        const again = await cliRetryBusy('workspaces', 'restore', ID1); assert.notEqual(again.code, 0, 'an erased workspace cannot be restored');
    });

    await check('neighbours (similar name, shared content) identical and still on disk after the whole flow', async () => {
        assert.equal(await neighbours(), nbBefore);
        for (const d of nbDirs) assert.ok(fs.existsSync(d), d);
        assert.ok(entry('doomed-2') && entry('sharer'));
    });
} finally {
    if (h) { await killDaemon(h, 'SIGTERM', 8000); cleanup(h); }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
