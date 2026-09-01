#!/usr/bin/env tsx
/**
 * actor-binding-unit.ts — L-030: the actor-identity binding is now WIRED into
 * the HTTP request path.
 *
 * Before the fix, compileClerkValidator().bind() and readOperatorIdentity()
 * existed but NOTHING on the request path invoked them, so getCurrentActor()
 * always returned null in production and row-level scope filtering was a no-op.
 *
 * This drives the new wiring end-to-end at the chokepoint:
 *   makeActorResolver(...) → runHttpGates(resolveActor) → withActorIfAny(...)
 * and asserts getCurrentActor()/getCurrentActorScopes() are populated inside the
 * bound downstream chain (mirroring how the principal is bound). It also pins the
 * operator-identity fallback and the fail-closed-on-invalid-JWT behavior.
 *
 * We mint a self-signed RS256 JWT + serve a matching JWKS (same fixture shape as
 * clerk-auth-unit.ts) so the full jose validate path runs without an external
 * issuer.
 */

import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

import { compileClerkValidator } from '../packages/lore/src/security/clerkAuth.js';
import {
    runHttpGates,
    withActorIfAny,
    makeActorResolver,
} from '../packages/lore/src/mcp/http/middleware.js';
import { getCurrentActor, getCurrentActorScopes } from '../packages/lore/src/security/actorContext.js';
import { writeOperatorIdentity } from '../packages/lore/src/security/operatorIdentity.js';

const TEST_KID = 'test-kid';
const AUDIENCE = 'lore';
const PORT = 54330;

interface Fixture {
    issuer: string;
    sign: (claims: Record<string, unknown>) => Promise<string>;
    cleanup: () => Promise<void>;
}

async function makeFixture(): Promise<Fixture> {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = await exportJWK(publicKey);
    jwk.kid = TEST_KID;
    jwk.alg = 'RS256';
    jwk.use = 'sig';
    const server = createServer((req, res) => {
        if (req.url === '/.well-known/jwks.json') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ keys: [jwk] }));
            return;
        }
        res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    if (typeof addr !== 'object' || !addr) throw new Error('no addr');
    const issuer = `http://127.0.0.1:${addr.port}`;
    return {
        issuer,
        async sign(claims) {
            const now = Math.floor(Date.now() / 1000);
            return await new SignJWT({ ...claims })
                .setProtectedHeader({ alg: 'RS256', kid: TEST_KID })
                .setIssuer(issuer)
                .setAudience(AUDIENCE)
                .setIssuedAt(now)
                .setExpirationTime(now + 3600)
                .setSubject(typeof claims.sub === 'string' ? claims.sub : 'user_default')
                .sign(privateKey);
        },
        async cleanup() {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

// Minimal mock req/res for runHttpGates. We hit /api/health (public, no Bearer
// requirement for the principal) but still attach the Clerk JWT so the actor
// resolver consumes it. Host matches the configured port so validateRequest
// passes; no Origin header → same-origin/CLI path, allowed.
function mockReq(headers: Record<string, string>): IncomingMessage {
    return {
        method: 'GET',
        url: '/api/health',
        headers: { host: `localhost:${PORT}`, ...headers },
    } as unknown as IncomingMessage;
}
function mockRes(): ServerResponse & { statusCode: number; body: string } {
    const r = {
        statusCode: 0,
        body: '',
        setHeader() { /* noop */ },
        writeHead(code: number) { r.statusCode = code; return r; },
        end(chunk?: string) { r.body = chunk ? String(chunk) : ''; return r; },
    };
    return r as unknown as ServerResponse & { statusCode: number; body: string };
}

const noopRateLimiter = { tryConsume: () => ({ allowed: true, limit: 1, remaining: 1, resetSec: 0, retryAfterSec: 0 }) };

function gateDeps(resolveActor?: (req: IncomingMessage) => Promise<import('../packages/lore/src/security/actorContext.js').ActorContext | null>) {
    return {
        port: PORT,
        dataHome: '/tmp/actor-binding-unit-unused',
        getAuthToken: () => 'x'.repeat(64),
        rateLimiter: noopRateLimiter as never,
        deploymentMode: 'local' as const,
        getBootstrapWorkspace: () => 'dev',
        resolveActor,
    };
}

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

(async () => {
    console.log('actor-binding-unit (L-030)');
    const fx = await makeFixture();

    const clerkResolver = makeActorResolver({
        clerkIssuer: fx.issuer,
        compileClerkValidator: (cfg) => compileClerkValidator({ issuer: cfg.issuer, audience: AUDIENCE, scopesClaim: 'scopes' }),
    });
    assert.ok(clerkResolver, 'makeActorResolver builds a resolver when clerkIssuer is set');

    await test('Clerk JWT on the request → runHttpGates binds the actor downstream', async () => {
        const token = await fx.sign({ sub: 'user_alice', scopes: ['read', 'admin'] });
        const gate = await runHttpGates(mockReq({ authorization: `Bearer ${token}` }), mockRes(), gateDeps(clerkResolver!));
        assert.equal(gate.handled, false, `gate must pass: ${JSON.stringify(gate)}`);
        if (gate.handled) return;
        // The resolved actor is carried out AND bound around the downstream chain.
        assert.ok(gate.actor, 'actor resolved from the JWT');
        let seenActor: string | undefined;
        let seenScopes: ReadonlyArray<string> | undefined;
        withActorIfAny(gate.actor, () => {
            seenActor = getCurrentActor()?.portalUserId;
            seenScopes = getCurrentActorScopes();
        });
        assert.equal(seenActor, 'user_alice', 'getCurrentActor() returns the JWT sub inside the bound chain');
        assert.deepEqual([...(seenScopes ?? [])], ['read', 'admin'], 'getCurrentActorScopes() returns the JWT scopes');
    });

    await test('no JWT + operator.json present → operator identity is the bound actor', async () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-actor-op-'));
        writeOperatorIdentity(
            { portalUserId: 'user_operator', scopes: ['read'], boundAt: new Date().toISOString(), source: 'manual' },
            home,
        );
        // Resolver with the operator fallback (no Clerk issuer → operator only).
        const opResolver = makeActorResolver({
            readOperatorIdentity: () => {
                const id = JSON.parse(fs.readFileSync(path.join(home, 'operator.json'), 'utf8'));
                return { portalUserId: id.portalUserId, scopes: id.scopes };
            },
        });
        assert.ok(opResolver, 'resolver built when operator identity is available');
        const gate = await runHttpGates(mockReq({}), mockRes(), gateDeps(opResolver!));
        assert.equal(gate.handled, false);
        if (gate.handled) return;
        assert.equal(gate.actor?.portalUserId, 'user_operator', 'operator identity bound when no JWT present');
        fs.rmSync(home, { recursive: true, force: true });
    });

    await test('makeActorResolver returns undefined when neither source applies', async () => {
        const none = makeActorResolver({ /* no clerkIssuer, no readOperatorIdentity */ });
        assert.equal(none, undefined, 'no resolver → actor stays null → unchanged local behavior');
    });

    await test('no resolver wired → gate leaves actor null (unchanged behavior)', async () => {
        const gate = await runHttpGates(mockReq({}), mockRes(), gateDeps(undefined));
        assert.equal(gate.handled, false);
        if (gate.handled) return;
        assert.equal(gate.actor, null, 'actor is null when no resolver is injected');
    });

    await test('present-but-invalid Clerk JWT → fail CLOSED with 401, actor not bound', async () => {
        // A JWT-shaped bearer (has dots) that the validator cannot verify → the
        // resolver throws ClerkAuthError → runHttpGates returns handled:true 401.
        const res = mockRes();
        const gate = await runHttpGates(
            mockReq({ authorization: 'Bearer aaa.bbb.ccc' }),
            res,
            gateDeps(clerkResolver!),
        );
        assert.equal(gate.handled, true, 'invalid JWT fails closed (handled)');
        assert.equal(res.statusCode, 401, 'invalid actor token → 401, not anonymous fall-through');
    });

    await fx.cleanup();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
