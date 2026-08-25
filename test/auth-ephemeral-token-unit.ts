/**
 * test/auth-ephemeral-token-unit.ts — Sprint 8 ephemeral perf tokens.
 *
 * Coverage (spec §5):
 *   T1: `lore auth issue --ephemeral` produces a valid token with
 *       expiresAt set ≈ now + TTL.
 *   T2: An ephemeral token works for a write inside its TTL.
 *   T3: Past expiration → `resolveByPlaintext` returns
 *       { kind: 'expired' } so the middleware path emits 401
 *       `token_expired`.
 *   T4: The bootstrap token path (no `expiresAt`, accepted via the
 *       constant-time bootstrap check inside middleware) is unchanged
 *       — i.e. mutating the registry never affects a bearer that
 *       doesn't match the `lore_` regex.
 *   T5: Workspace scoping is enforced — an ephemeral token issued
 *       against workspace A cannot write to workspace B without
 *       cross-workspace-write.
 *   T6: An `--admin` token carries cross-workspace-write and CAN
 *       write to any workspace.
 *   T7: `sweepExpiredTokens()` removes expired entries from the
 *       on-disk registry; active + ephemeral-in-TTL entries survive.
 *
 * Tests exercise auth/tokens.ts + the `lore auth issue` CLI directly.
 * They do NOT spin up the HTTP daemon — the middleware path is
 * already covered by phase6-p3-per-app-workspace-auth-unit.ts; this
 * suite focuses on the new ephemeral surface so it stays
 * deterministic + fast.
 *
 * Run:
 *   LORE_HOME=$(mktemp -d) npx tsx test/auth-ephemeral-token-unit.ts
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';

// SP-15 — self-provision a fresh LORE_HOME when one isn't supplied (or when
// it points at the real ~/.groundfloor) so this suite runs unattended in the
// `npm test` chain. A caller-supplied fresh dir is still honored. This never
// touches the operator's real data home.
let TEST_HOME = process.env['LORE_HOME'];
if (!TEST_HOME || TEST_HOME === path.join(process.env['HOME'] ?? '', '.groundfloor')) {
    TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-auth-eph-'));
    process.env['LORE_HOME'] = TEST_HOME;
}

// Sprint 8 — flag NODE_ENV=test so startTokenSweeper() is a no-op
// (we test sweepExpiredTokens directly to keep tests deterministic).
process.env['NODE_ENV'] = 'test';

function seedWorkspacesJson(home: string, active: string, names: string[]): void {
    const workspaces = names.map((name) => ({
        name,
        path: path.join(home, 'workspaces', name),
        createdAt: '2026-05-23T00:00:00.000Z',
    }));
    fs.mkdirSync(home, { recursive: true });
    for (const w of workspaces) {
        fs.mkdirSync(path.join(w.path, '.lore'), { recursive: true });
    }
    fs.writeFileSync(
        path.join(home, 'workspaces.json'),
        JSON.stringify({ active, workspaces }, null, 2),
    );
}

seedWorkspacesJson(TEST_HOME, 'ws-a', ['ws-a', 'ws-b']);

const tokens = await import('../packages/lore/src/auth/tokens.js');
const principal = await import('../packages/lore/src/auth/principal.js');
const authCli = await import('../packages/lore/src/cli/commands/auth.js');

tokens._resetForTests();

// ── helpers ──────────────────────────────────────────────────────────

/**
 * Capture stdout while running `lore auth issue --json …`. The CLI
 * writes plaintext to console.log only — we shim it so the assertion
 * code can introspect the JSON without forking the process.
 */
async function captureCliJson(args: string[]): Promise<{ stdout: string; stderr: string; exit: number | null }> {
    const realLog = console.log;
    const realErr = console.error;
    const realExit = process.exit;
    let stdout = '';
    let stderr = '';
    let exit: number | null = null;
    console.log = (...a: unknown[]) => { stdout += a.map(String).join(' ') + '\n'; };
    console.error = (...a: unknown[]) => { stderr += a.map(String).join(' ') + '\n'; };
    // process.exit throws so we can capture it without killing the test.
    (process as unknown as { exit: (n?: number) => never }).exit = ((n?: number) => {
        exit = n ?? 0;
        throw new Error(`__cli_exit_${n ?? 0}__`);
    }) as never;
    try {
        await authCli.authCommand(args);
    } catch (err) {
        if (!(err instanceof Error) || !err.message.startsWith('__cli_exit_')) throw err;
    } finally {
        console.log = realLog;
        console.error = realErr;
        (process as unknown as { exit: (n?: number) => never }).exit = realExit as never;
    }
    return { stdout, stderr, exit };
}

// ── tests ─────────────────────────────────────────────────────────────

async function t1_issue_ephemeral_writes_expiresAt(): Promise<void> {
    tokens._resetForTests();
    const result = await captureCliJson([
        'issue',
        '--workspace', 'ws-a',
        '--ephemeral',
        '--ttl', '5m',
        '--json',
    ]);
    assert.equal(result.exit, null, `expected no early exit; stderr=${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.ok(parsed.token.startsWith('lore_ws-a_'), `token prefix wrong: ${parsed.token}`);
    assert.equal(parsed.workspace, 'ws-a');
    assert.equal(parsed.ephemeral, true);
    assert.equal(parsed.admin, false);
    const expiresMs = Date.parse(parsed.expiresAt);
    const ttlMs = 5 * 60 * 1000;
    assert.ok(Math.abs(expiresMs - (Date.now() + ttlMs)) < 5000, `expiresAt drift > 5s: ${parsed.expiresAt}`);
    console.log('  T1 ok');
}

async function t2_token_works_within_ttl(): Promise<void> {
    tokens._resetForTests();
    const result = tokens.issueToken({
        workspace: 'ws-a',
        label: 'within-ttl',
        scopes: ['read', 'write'],
        ttlMs: 60_000,
    });
    const outcome = tokens.resolveByPlaintext(result.token);
    assert.equal(outcome.kind, 'ok', `expected ok; got ${outcome.kind}`);
    if (outcome.kind === 'ok') {
        assert.equal(outcome.record.workspace, 'ws-a');
        assert.equal(outcome.record.scopes.includes('write'), true);
    }
    console.log('  T2 ok');
}

async function t3_token_rejected_after_expiration(): Promise<void> {
    tokens._resetForTests();
    // Issue a token that already expired 1ms ago via direct API
    // (avoids racing real timers).
    const result = tokens.issueToken({
        workspace: 'ws-a',
        label: 'already-expired',
        scopes: ['read', 'write'],
        ttlMs: 1, // expires in 1ms
    });
    await new Promise((r) => setTimeout(r, 20));
    const outcome = tokens.resolveByPlaintext(result.token);
    assert.equal(outcome.kind, 'expired', `expected expired; got ${outcome.kind}`);
    // legacy lookupByPlaintext should also refuse — middleware-safety belt.
    assert.equal(tokens.lookupByPlaintext(result.token), null);
    console.log('  T3 ok');
}

async function t4_bootstrap_token_unchanged(): Promise<void> {
    tokens._resetForTests();
    // A 64-char hex sessionTok lookalike — must NOT match the lore_ regex
    // and must NOT be touched by the registry path. We assert the
    // isPlausibleToken guard rejects it so the bootstrap branch in
    // middleware is what would handle it.
    const bootstrapLookalike = 'a'.repeat(64);
    assert.equal(tokens.isPlausibleToken(bootstrapLookalike), false);
    // And the registry remains empty after issuing a registry token.
    tokens.issueToken({
        workspace: 'ws-a',
        label: 'long-lived',
        scopes: ['read', 'write'],
    });
    // Bootstrap lookalike still rejected at the resolver — proves the
    // registry doesn't bleed into the bootstrap path.
    assert.equal(tokens.resolveByPlaintext(bootstrapLookalike).kind, 'missing');
    console.log('  T4 ok');
}

async function t5_workspace_scoping_enforced(): Promise<void> {
    tokens._resetForTests();
    const tA = tokens.issueToken({
        workspace: 'ws-a',
        label: 'scoped',
        scopes: ['read', 'write'],
        ttlMs: 60_000,
    });
    const outcome = tokens.resolveByPlaintext(tA.token);
    assert.equal(outcome.kind, 'ok');
    if (outcome.kind !== 'ok') return;
    // Build the same Principal the middleware would and assert the gate
    // refuses a cross-workspace write to wsB.
    const p = {
        kind: 'app' as const,
        workspace: outcome.record.workspace,
        scopes: outcome.record.scopes,
        label: outcome.record.prefix,
    };
    const gate = principal.requireWriteToWorkspace(p, 'ws-b');
    assert.equal(gate.ok, false, 'expected workspace-write refusal');
    if (!gate.ok) {
        assert.match(gate.reason ?? '', /cross-workspace-write/);
    }
    // Same gate against wsA = ok.
    const sameWs = principal.requireWriteToWorkspace(p, 'ws-a');
    assert.equal(sameWs.ok, true);
    console.log('  T5 ok');
}

async function t6_admin_token_writes_cross_workspace(): Promise<void> {
    tokens._resetForTests();
    const result = await captureCliJson([
        'issue',
        '--workspace', 'ws-a',
        '--ephemeral',
        '--ttl', '5m',
        '--admin',
        '--json',
    ]);
    assert.equal(result.exit, null, `unexpected exit; stderr=${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.admin, true);
    assert.ok(parsed.scopes.includes('cross-workspace-write'),
        `admin scopes missing cross-workspace-write: ${parsed.scopes.join(',')}`);
    const outcome = tokens.resolveByPlaintext(parsed.token);
    assert.equal(outcome.kind, 'ok');
    if (outcome.kind !== 'ok') return;
    const p = {
        kind: 'app' as const,
        workspace: outcome.record.workspace,
        scopes: outcome.record.scopes,
        label: outcome.record.prefix,
    };
    const gate = principal.requireWriteToWorkspace(p, 'ws-b');
    assert.equal(gate.ok, true, 'admin token must allow cross-workspace write');
    console.log('  T6 ok');
}

async function t7_sweeper_removes_expired_only(): Promise<void> {
    tokens._resetForTests();
    // Three records: one active long-lived, one ephemeral in TTL, one
    // already expired.
    tokens.issueToken({ workspace: 'ws-a', label: 'long-lived', scopes: ['read'] });
    tokens.issueToken({ workspace: 'ws-a', label: 'live-ephemeral', scopes: ['read'], ttlMs: 60_000 });
    tokens.issueToken({ workspace: 'ws-a', label: 'dead-ephemeral', scopes: ['read'], ttlMs: 1 });
    await new Promise((r) => setTimeout(r, 20));
    const before = tokens.listTokens().length;
    assert.equal(before, 3);
    const removed = tokens.sweepExpiredTokens();
    assert.equal(removed, 1, `expected 1 expired sweep; got ${removed}`);
    const after = tokens.listTokens();
    assert.equal(after.length, 2);
    // The on-disk file is the source of truth; verify by re-reading.
    const reg = JSON.parse(fs.readFileSync(tokens.getRegistryPath(), 'utf8'));
    assert.equal(Object.keys(reg.entries).length, 2);
    // Idempotent re-sweep is 0.
    assert.equal(tokens.sweepExpiredTokens(), 0);
    console.log('  T7 ok');
}

async function t8_ttl_parsing(): Promise<void> {
    assert.equal(authCli.parseDurationToMs('30s'), 30_000);
    assert.equal(authCli.parseDurationToMs('5m'), 300_000);
    assert.equal(authCli.parseDurationToMs('1h'), 3_600_000);
    assert.equal(authCli.parseDurationToMs('2h'), 7_200_000);
    assert.equal(authCli.parseDurationToMs('1d'), 86_400_000);
    assert.throws(() => authCli.parseDurationToMs('5'), /invalid duration/);
    assert.throws(() => authCli.parseDurationToMs('0m'), /positive integer/);
    assert.throws(() => authCli.parseDurationToMs('1y'), /invalid duration/);
    console.log('  T8 ok');
}

const all: Array<[string, () => Promise<void>]> = [
    ['T1 issue --ephemeral writes expiresAt', t1_issue_ephemeral_writes_expiresAt],
    ['T2 token works within TTL', t2_token_works_within_ttl],
    ['T3 token rejected after expiration', t3_token_rejected_after_expiration],
    ['T4 bootstrap token path unchanged', t4_bootstrap_token_unchanged],
    ['T5 workspace scoping enforced', t5_workspace_scoping_enforced],
    ['T6 --admin token writes cross-workspace', t6_admin_token_writes_cross_workspace],
    ['T7 sweeper removes expired only', t7_sweeper_removes_expired_only],
    ['T8 --ttl parsing', t8_ttl_parsing],
];

console.log('auth-ephemeral-token-unit');
let failed = 0;
for (const [name, fn] of all) {
    try {
        await fn();
        console.log(`✓ ${name}`);
    } catch (err) {
        failed += 1;
        console.error(`✗ ${name}`);
        console.error((err as Error).stack ?? err);
    }
}
if (failed > 0) {
    console.error(`\n${failed}/${all.length} failed`);
    process.exit(1);
}
console.log(`\n${all.length}/${all.length} passed`);
