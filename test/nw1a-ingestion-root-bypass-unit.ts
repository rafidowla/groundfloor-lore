#!/usr/bin/env tsx
/**
 * nw1a-ingestion-root-bypass-unit.ts — pins the NW-1a fix:
 *
 *  Before NW-1a: `saveExtraIngestionRoots()` (reachable from the
 *  authenticated HTTP PATCH /api/connectors/filesystem/paths) validated
 *  each root only as "absolute string, no NUL". An admin-authenticated
 *  request body of {"roots":["/"]} or {"roots":["/etc"]} silently widened
 *  the ingestion allowlist; `loadExtraIngestionRoots()` then read the
 *  values back unfiltered and fed them into `defaultAllowedRoots()`, so
 *  `assertPathAllowed()` would accept any file under that root. Net
 *  effect: one-step local-file exfil via `read_document_for_ingestion`.
 *
 *  NW-1a applies `isWatchRootSafe()` at BOTH the write side (admin route
 *  + saveExtraIngestionRoots) and the read side (loadExtraIngestionRoots),
 *  matching the LORE_WATCH_PATHS behavior SW-15 established.
 *
 *  Adversarial inputs covered:
 *    • POST `/`              → 400, ingestion.json NOT created/modified
 *    • POST `/etc`           → 400, ingestion.json NOT created/modified
 *    • POST `../../../etc`   → 400 (rejected as non-absolute)
 *    • POST `<under-home>`   → 200, persisted
 *    • Hand-edited `roots: ["/"]` in ingestion.json → filtered at read.
 *    • saveExtraIngestionRoots() throws on a system root.
 *
 *  MUST fail on base (swarm/integration-2) and pass on swarm/NW-1a.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { tryAdminRoutes } from '../packages/lore/src/mcp/http/routes/admin.js';
import {
    loadExtraIngestionRoots,
    saveExtraIngestionRoots,
} from '../packages/lore/src/security/pathAllowlist.js';

/* ─── helpers ────────────────────────────────────────────────────── */

function fakeReq(method: string, body: string): IncomingMessage {
    const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
    const req = {
        method,
        on(event: string, h: (...args: unknown[]) => void) {
            (handlers[event] ||= []).push(h);
            if (event === 'end') {
                setImmediate(() => {
                    (handlers['data'] ?? []).forEach((h2) => h2(Buffer.from(body)));
                    (handlers['end'] ?? []).forEach((h2) => h2());
                });
            }
            return this;
        },
    };
    return req as unknown as IncomingMessage;
}

type CapturedRes = ServerResponse & { _status: number; _body: string; _done: Promise<void> };
function fakeRes(): CapturedRes {
    let resolveDone!: () => void;
    const doneP = new Promise<void>((r) => { resolveDone = r; });
    const r = {
        _status: 0, _body: '', _done: doneP,
        writeHead(status: number) { (this as { _status: number })._status = status; return this; },
        end(body?: string) { (this as { _body: string })._body = body ?? ''; resolveDone(); },
    };
    return r as unknown as CapturedRes;
}

function adminDeps(): Parameters<typeof tryAdminRoutes>[4] {
    return {
        deploymentMode: 'local',
        dataplane: null,
        pluginRegistry: {} as never,
        consentManager: {} as never,
        retentionSweeper: {} as never,
        archiveSink: {} as never,
        mcpClientRuntime: {} as never,
        connectorRegistry: {} as never,
        auditLog: { log: () => undefined } as never,
    } as never;
}

let passed = 0, failed = 0;
const test = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

/* ─── test bed: sandboxed LORE_HOME so we don't touch real ingestion.json */

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-nw1a-'));
const prevHome = process.env['LORE_HOME'];
process.env['LORE_HOME'] = tmpHome;
const cfgPath = path.join(tmpHome, 'ingestion.json');
function clearCfg(): void {
    try { fs.unlinkSync(cfgPath); } catch { /* */ }
}

console.log('NW-1a — ingestion allow-root bypass (admin PATCH + load/save guard)');

try {

/* ─── (1) PATCH `/` is rejected with 4xx and persists nothing ────── */
await test('PATCH {roots:["/"]} → 4xx, ingestion.json unchanged', async () => {
    clearCfg();
    const res = fakeRes();
    await tryAdminRoutes(
        fakeReq('PATCH', JSON.stringify({ roots: ['/'] })),
        res, '/api/connectors/filesystem/paths',
        '/api/connectors/filesystem/paths', adminDeps(),
    );
    await res._done;
    assert.ok(res._status >= 400 && res._status < 500,
        `expected 4xx, got ${res._status} body=${res._body}`);
    assert.equal(fs.existsSync(cfgPath), false,
        'a rejected PATCH must NOT create/modify ingestion.json');
});

/* ─── (2) PATCH `/etc` rejected, persists nothing ────────────────── */
await test('PATCH {roots:["/etc"]} → 4xx, ingestion.json unchanged', async () => {
    clearCfg();
    const res = fakeRes();
    await tryAdminRoutes(
        fakeReq('PATCH', JSON.stringify({ roots: ['/etc'] })),
        res, '/api/connectors/filesystem/paths',
        '/api/connectors/filesystem/paths', adminDeps(),
    );
    await res._done;
    assert.ok(res._status >= 400 && res._status < 500,
        `expected 4xx, got ${res._status} body=${res._body}`);
    assert.equal(fs.existsSync(cfgPath), false);
});

/* ─── (3) PATCH `../../../etc` rejected (non-absolute) ──────────── */
await test('PATCH {roots:["../../../etc"]} → 4xx, ingestion.json unchanged', async () => {
    clearCfg();
    const res = fakeRes();
    await tryAdminRoutes(
        fakeReq('PATCH', JSON.stringify({ roots: ['../../../etc'] })),
        res, '/api/connectors/filesystem/paths',
        '/api/connectors/filesystem/paths', adminDeps(),
    );
    await res._done;
    assert.ok(res._status >= 400 && res._status < 500,
        `expected 4xx, got ${res._status} body=${res._body}`);
    assert.equal(fs.existsSync(cfgPath), false);
});

/* ─── (4) PATCH for a partially-bad batch is fully rejected ──── */
await test('PATCH {roots:[<under-home>, "/"]} → 4xx, partial write refused', async () => {
    clearCfg();
    const home = os.homedir();
    const ok = path.join(home, 'lore-nw1a-ok');
    const res = fakeRes();
    await tryAdminRoutes(
        fakeReq('PATCH', JSON.stringify({ roots: [ok, '/'] })),
        res, '/api/connectors/filesystem/paths',
        '/api/connectors/filesystem/paths', adminDeps(),
    );
    await res._done;
    assert.ok(res._status >= 400 && res._status < 500,
        `expected 4xx, got ${res._status} body=${res._body}`);
    // Must NOT have written the "good" entry — atomic batch reject.
    assert.equal(fs.existsSync(cfgPath), false,
        'partial batch must not persist any entries');
});

/* ─── (5) Legitimate under-home root still succeeds (200 + persisted) */
await test('PATCH {roots:[<under-home>]} → 200, persisted', async () => {
    clearCfg();
    const home = os.homedir();
    const ok = path.join(home, 'lore-nw1a-keep');
    const res = fakeRes();
    await tryAdminRoutes(
        fakeReq('PATCH', JSON.stringify({ roots: [ok] })),
        res, '/api/connectors/filesystem/paths',
        '/api/connectors/filesystem/paths', adminDeps(),
    );
    await res._done;
    assert.equal(res._status, 200, `expected 200, got ${res._status} body=${res._body}`);
    const persisted = loadExtraIngestionRoots(tmpHome);
    assert.deepEqual(persisted, [ok]);
});

/* ─── (6) saveExtraIngestionRoots() throws on a system root ─────── */
await test('saveExtraIngestionRoots(["/"]) throws (write-side guard)', () => {
    clearCfg();
    assert.throws(
        () => saveExtraIngestionRoots(tmpHome, ['/']),
        /not a safe ingestion root|safe ingestion/i,
    );
    assert.equal(fs.existsSync(cfgPath), false,
        'an exception thrown by saveExtraIngestionRoots must leave no file behind');
});

await test('saveExtraIngestionRoots(["/etc"]) throws', () => {
    clearCfg();
    assert.throws(() => saveExtraIngestionRoots(tmpHome, ['/etc']), /safe ingestion/i);
});

/* ─── (7) loadExtraIngestionRoots() filters hand-edited unsafe entries */
await test('loadExtraIngestionRoots filters out hand-edited system roots', () => {
    clearCfg();
    // Write a hand-edited file with a mix of safe and unsafe entries —
    // simulating a pre-NW-1a install (write-side guard absent at the
    // time) or a user that bypassed the admin API by editing the file.
    const home = os.homedir();
    const keep = path.join(home, 'lore-nw1a-keep-load');
    fs.writeFileSync(cfgPath, JSON.stringify({
        roots: ['/', '/etc', '/var/log', keep],
    }));
    const loaded = loadExtraIngestionRoots(tmpHome);
    assert.deepEqual(loaded, [keep],
        `read-side filter must drop unsafe entries; got ${JSON.stringify(loaded)}`);
});

} finally {
    if (prevHome === undefined) delete process.env['LORE_HOME'];
    else process.env['LORE_HOME'] = prevHome;
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* */ }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
