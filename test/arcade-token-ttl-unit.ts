#!/usr/bin/env tsx
/**
 * test/arcade-token-ttl-unit.ts — G11 + T1, CONTAINER-FREE.
 *
 * G11: `ttlSeconds` on arcade token issue/rotate must be an integer in
 *      [60s, 365d] or absent (default 30d). 0 / negative / NaN / float / string /
 *      null / too large → 400 `invalid_request` and NOTHING issued/rotated.
 *      issueToken itself throws on 0 so no caller can mint a non-expiring token.
 * T1:  POST /api/arcade/tokens/revoke accepts { customerId, appId,
 *      tokenHashPrefix } with rotate's rules (cell-scoped, >=8 chars, ambiguous
 *      refused); full-token revoke is unchanged.
 *
 * Touches only a throwaway LORE_HOME registry SQLite — no daemon, no ArcadeDB.
 * Run: npx tsx test/arcade-token-ttl-unit.ts
 */
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import Database from 'better-sqlite3';
import type { IncomingMessage, ServerResponse } from 'node:http';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arcade-ttl-'));
process.env['LORE_HOME'] = tmp;
const REG = path.join(tmp, 'arcade-provisioning.sqlite');

const { runArcadeRegistryMigrations } = await import('../packages/lore/src/engines/arcade/arcadeRegistryMigrations.js');
const auth = await import('../packages/lore/src/engines/arcade/arcadeAuthResolver.js');
const { rotateToken } = await import('../packages/lore/src/engines/arcade/arcadeTokenLifecycle.js');
const { closeRegistryDb } = await import('../packages/lore/src/engines/arcade/arcadeProvisioner.js');
const { tryArcadeAdminRoutes } = await import('../packages/lore/src/mcp/http/routes/arcadeAdmin.js');
const { issueToken, hashToken, resolvePrincipal, closeTokenDb, InvalidTokenTtlError,
    DEFAULT_TOKEN_TTL_SECONDS, MIN_TOKEN_TTL_SECONDS, MAX_TOKEN_TTL_SECONDS } = auth;

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, detail?: string): void {
    if (cond) { pass++; console.log(`  [PASS] ${label}`); }
    else { fail++; console.error(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`); }
}

function seedCell(db: Database.Database, tenant: string, app: string): void {
    db.prepare(
        `INSERT INTO tenant_apps (tenant_id, app_id, db, db_user, db_pass, secret_ref, status, created_at, schema_version)
         VALUES (?, ?, ?, ?, 'pw', ?, 'active', ?, 1)`,
    ).run(tenant, app, `tenant_${tenant}_${app}`, `${tenant}_${app}_svc`, `arcade-svc:${tenant}:${app}`, new Date().toISOString());
}
{
    const db = new Database(REG);
    db.pragma('journal_mode = WAL');
    runArcadeRegistryMigrations(db);
    seedCell(db, 'acme', 'dev');
    seedCell(db, 'acme', 'other');
    seedCell(db, 'beta', 'dev');
    db.close();
}

function countTokens(): number {
    const db = new Database(REG, { readonly: true });
    const n = (db.prepare('SELECT COUNT(*) AS n FROM arcade_tokens').get() as { n: number }).n;
    db.close();
    return n;
}

// ── fake HTTP plumbing (same shape as write-scopes-maintenance-unit) ─────────
function fakeReq(method: string, body = ''): IncomingMessage {
    let consumed = false;
    return {
        method,
        on(event: string, cb: (chunk?: Buffer) => void) {
            if (event === 'data' && !consumed) { consumed = true; if (body) cb(Buffer.from(body, 'utf8')); }
            if (event === 'end') setImmediate(() => cb());
            return this;
        },
    } as unknown as IncomingMessage;
}
type Res = ServerResponse & { _status: number; _body: string };
function fakeRes(): Res {
    return {
        _status: 0, _body: '',
        writeHead(s: number) { (this as { _status: number })._status = s; return this; },
        end(b?: string) { (this as { _body: string })._body = b ?? ''; },
    } as unknown as Res;
}
const evictedCells: string[] = [];
const deps = {
    auditLog: { log: () => undefined },
    evictCell: (t: string, a: string) => { evictedCells.push(`${t}/${a}`); },
} as never;

async function post(pathname: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = fakeRes();
    await tryArcadeAdminRoutes(fakeReq('POST', JSON.stringify(body)), res, pathname, pathname, deps);
    return { status: res._status, json: res._body ? JSON.parse(res._body) : {} };
}
const ISSUE = '/api/arcade/apps/acme/dev/tokens';
const ROTATE = '/api/arcade/apps/acme/dev/tokens/rotate';
const REVOKE = '/api/arcade/tokens/revoke';
const near = (iso: string | null, secs: number): boolean =>
    !!iso && Math.abs(Date.parse(iso) - (Date.now() + secs * 1000)) < 5000;

async function main(): Promise<void> {
    // ── 1. issueToken (library) ──────────────────────────────────────────────
    console.log('issueToken (library)');
    const before = countTokens();
    for (const bad of [0, -5, NaN, Infinity, 1.5, 59, MAX_TOKEN_TTL_SECONDS + 1, '60' as unknown as number, null as unknown as number]) {
        let err: unknown;
        try { issueToken({ tenantId: 'acme', appId: 'dev', scopes: ['read'], ttlSeconds: bad }, { registryDbPath: REG }); } catch (e) { err = e; }
        check(`issueToken ttlSeconds=${Number.isNaN(bad) ? "NaN" : JSON.stringify(bad)} throws InvalidTokenTtlError`, err instanceof InvalidTokenTtlError);
    }
    check('issueToken rejects without inserting any row', countTokens() === before);
    const dflt = issueToken({ tenantId: 'acme', appId: 'dev', scopes: ['read'] }, { registryDbPath: REG });
    check('issueToken absent ttl → default 30d', near(dflt.expiresAt, DEFAULT_TOKEN_TTL_SECONDS));
    const min = issueToken({ tenantId: 'acme', appId: 'dev', scopes: ['read'], ttlSeconds: MIN_TOKEN_TTL_SECONDS }, { registryDbPath: REG });
    check('issueToken ttl=60 accepted, expiry ~now+60s', near(min.expiresAt, 60));
    const max = issueToken({ tenantId: 'acme', appId: 'dev', scopes: ['read'], ttlSeconds: MAX_TOKEN_TTL_SECONDS }, { registryDbPath: REG });
    check('issueToken ttl=max accepted (365d)', near(max.expiresAt, MAX_TOKEN_TTL_SECONDS) && MAX_TOKEN_TTL_SECONDS === 365 * 86400);
    check('issued token never has null expiry', dflt.expiresAt !== null && min.expiresAt !== null && max.expiresAt !== null);

    // ── 2. issue route ──────────────────────────────────────────────────────
    console.log('issue route');
    const n0 = countTokens();
    for (const bad of [-5, 0, 1.5, '60', null, MAX_TOKEN_TTL_SECONDS + 1, 59]) {
        const r = await post(ISSUE, { scopes: ['read'], ttlSeconds: bad });
        check(`issue ttlSeconds=${JSON.stringify(bad)} → 400 invalid_request`, r.status === 400 && r.json['code'] === 'invalid_request', JSON.stringify(r));
    }
    // NaN cannot ride JSON (becomes null) — covered above by null + library NaN.
    check('issue rejections minted nothing', countTokens() === n0);
    const ok60 = await post(ISSUE, { scopes: ['read'], ttlSeconds: 60 });
    check('issue ttlSeconds=60 → 201 with ~60s expiry', ok60.status === 201 && near(ok60.json['expiresAt'] as string, 60), JSON.stringify(ok60));
    const okDef = await post(ISSUE, { scopes: ['read'] });
    check('issue ttlSeconds absent → 201 with ~30d expiry', okDef.status === 201 && near(okDef.json['expiresAt'] as string, DEFAULT_TOKEN_TTL_SECONDS));
    check('issue minted exactly the two valid tokens', countTokens() === n0 + 2);

    // ── 3. rotate ───────────────────────────────────────────────────────────
    console.log('rotate');
    const mk = (ttl?: number) => issueToken({ tenantId: 'acme', appId: 'dev', scopes: ['read', 'write'], label: 'r', ttlSeconds: ttl }, { registryDbPath: REG });
    const prefixOf = (t: string) => hashToken(t).slice(0, 8);
    const rotA = mk();
    const n1 = countTokens();
    for (const bad of [0, -1, 1.5, '3600', MAX_TOKEN_TTL_SECONDS + 1]) {
        const r = await post(ROTATE, { tokenHashPrefix: prefixOf(rotA.token), ttlSeconds: bad });
        check(`rotate ttlSeconds=${JSON.stringify(bad)} → 400`, r.status === 400 && r.json['code'] === 'invalid_request');
    }
    check('rotate rejections created no token', countTokens() === n1);
    check('rotate rejections left old token live', (() => { try { resolvePrincipal(rotA.token, { registryDbPath: REG }); return true; } catch { return false; } })());
    let threw = false;
    try { rotateToken({ byToken: rotA.token }, { ttlSeconds: 0 }, { registryDbPath: REG }); } catch (e) { threw = e instanceof InvalidTokenTtlError; }
    check('rotateToken(library) ttlSeconds=0 throws (no non-expiring rotation)', threw);
    const rotOk = await post(ROTATE, { tokenHashPrefix: prefixOf(rotA.token), ttlSeconds: 3600 });
    check('rotate with ttlSeconds=3600 → 201, expiry ~1h', rotOk.status === 201 && near(rotOk.json['expiresAt'] as string, 3600), JSON.stringify(rotOk));
    const rotB = mk(60); // short-lived old token: a rotation does NOT inherit its TTL
    const rotDef = await post(ROTATE, { tokenHashPrefix: prefixOf(rotB.token) });
    check('rotate without ttlSeconds → 201, default 30d (not the old token\'s TTL)', rotDef.status === 201 && near(rotDef.json['expiresAt'] as string, DEFAULT_TOKEN_TTL_SECONDS));

    // ── 4. revoke by prefix (T1) ────────────────────────────────────────────
    console.log('revoke by prefix');
    const live = (t: string): boolean => { try { resolvePrincipal(t, { registryDbPath: REG }); return true; } catch { return false; } };
    const rv = mk();
    const short = await post(REVOKE, { customerId: 'acme', appId: 'dev', tokenHashPrefix: prefixOf(rv.token).slice(0, 7) });
    check('revoke prefix too short → 400', short.status === 400 && live(rv.token));
    const noCell = await post(REVOKE, { tokenHashPrefix: prefixOf(rv.token) });
    check('revoke prefix without customerId/appId → 400', noCell.status === 400 && live(rv.token));
    const otherApp = await post(REVOKE, { customerId: 'acme', appId: 'other', tokenHashPrefix: prefixOf(rv.token) });
    check('revoke prefix in the wrong app → 404, token untouched', otherApp.status === 404 && live(rv.token));
    const otherTenant = await post(REVOKE, { customerId: 'beta', appId: 'dev', tokenHashPrefix: prefixOf(rv.token) });
    check('revoke prefix in the wrong tenant → 404, token untouched', otherTenant.status === 404 && live(rv.token));
    const unknown = await post(REVOKE, { customerId: 'acme', appId: 'dev', tokenHashPrefix: 'deadbeef' });
    check('revoke unknown prefix → 404', unknown.status === 404);
    evictedCells.length = 0;
    const okRev = await post(REVOKE, { customerId: 'acme', appId: 'dev', tokenHashPrefix: prefixOf(rv.token) });
    check('revoke by prefix → 200 revoked:true', okRev.status === 200 && okRev.json['revoked'] === true, JSON.stringify(okRev));
    check('revoke by prefix kills the token', !live(rv.token));
    check('revoke by prefix evicts the cell\'s pooled facades', evictedCells.includes('acme/dev'));
    const again = await post(REVOKE, { customerId: 'acme', appId: 'dev', tokenHashPrefix: prefixOf(rv.token) });
    check('revoke by prefix is idempotent → 200 revoked:false', again.status === 200 && again.json['revoked'] === false);

    // ambiguous: force two rows in one cell to share an 8-char prefix
    {
        const db = new Database(REG);
        db.prepare(
            `INSERT INTO arcade_tokens (token_hash, tenant_id, app_id, scopes, created_at, revoked_at, expires_at, label)
             VALUES (?, 'acme', 'dev', '["read"]', ?, NULL, NULL, NULL)`,
        ).run('abcdef01' + 'a'.repeat(56), new Date().toISOString());
        db.prepare(
            `INSERT INTO arcade_tokens (token_hash, tenant_id, app_id, scopes, created_at, revoked_at, expires_at, label)
             VALUES (?, 'acme', 'dev', '["read"]', ?, NULL, NULL, NULL)`,
        ).run('abcdef01' + 'b'.repeat(56), new Date().toISOString());
        db.close();
    }
    const amb = await post(REVOKE, { customerId: 'acme', appId: 'dev', tokenHashPrefix: 'abcdef01' });
    check('revoke ambiguous prefix refused (404), nothing revoked', amb.status === 404 && (() => {
        const db = new Database(REG, { readonly: true });
        const n = (db.prepare(`SELECT COUNT(*) AS n FROM arcade_tokens WHERE token_hash LIKE 'abcdef01%' AND revoked_at IS NULL`).get() as { n: number }).n;
        db.close();
        return n === 2;
    })());

    // full-token revoke unchanged
    const full = mk();
    const fr = await post(REVOKE, { token: full.token });
    check('full-token revoke still works', fr.status === 200 && fr.json['revoked'] === true && !live(full.token));
    const none = await post(REVOKE, {});
    check('revoke with neither token nor prefix → 400', none.status === 400);
}

try {
    await main();
} finally {
    closeTokenDb();
    closeRegistryDb();
    fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
