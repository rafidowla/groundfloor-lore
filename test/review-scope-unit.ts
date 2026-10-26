#!/usr/bin/env tsx
/**
 * test/review-scope-unit.ts - the `review` token scope: registry, CLI, and the guard.
 *
 *   review is a real scope, is NOT in the default CLI scope set, is NOT implied by write,
 *   `lore auth issue --scopes read,review` mints it, unknown scopes are rejected,
 *   requireReviewToWorkspace: 401 without a principal, 403 scope_missing without review,
 *   403 workspace_forbidden for a foreign workspace without cross-workspace-write.
 *
 *   LORE_MODEL_SERVER=0 npx tsx test/review-scope-unit.ts
 */
import assert from 'node:assert/strict';
import { setupReviewHome } from './helpers/reviewHttp.js';

setupReviewHome('lore-review-scope-');
const { ALL_SCOPES, issueToken, listTokens } = await import('../packages/lore/src/auth/tokens.js');
const { requireReviewToWorkspace } = await import('../packages/lore/src/auth/principal.js');
const { authCommand } = await import('../packages/lore/src/cli/commands/auth.js');

let passed = 0;
const t = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
};

await t('review is a registered scope and the scope list has no other new member', () => {
    assert.ok(ALL_SCOPES.includes('review'));
    assert.deepEqual([...ALL_SCOPES].sort(), ['cross-workspace-read', 'cross-workspace-write', 'read', 'review', 'write']);
});

await t('issueToken keeps review exactly as requested (write does not imply it)', () => {
    const w = issueToken({ workspace: 'default', label: 'w', scopes: ['read', 'write'] });
    assert.ok(!w.record.scopes.includes('review'));
    const r = issueToken({ workspace: 'default', label: 'r', scopes: ['read', 'review'] });
    assert.deepEqual([...r.record.scopes].sort(), ['read', 'review']);
});

const capture = async (args: string[]): Promise<{ out: string; err: string; exit: number | null }> => {
    const logs: string[] = []; const errs: string[] = [];
    let exit: number | null = null;
    const origLog = console.log; const origErr = console.error; const origExit = process.exit;
    console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
    console.error = (...a: unknown[]) => { errs.push(a.join(' ')); };
    (process as any).exit = (c?: number) => { exit = c ?? 0; throw new Error('__exit__'); };
    try { await authCommand(args); } catch (e) { if ((e as Error).message !== '__exit__') throw e; }
    finally { console.log = origLog; console.error = origErr; (process as any).exit = origExit; }
    return { out: logs.join('\n'), err: errs.join('\n'), exit };
};

await t('CLI default scopes are read,write (no review)', async () => {
    const r = await capture(['issue', '--workspace', 'default', '--label', 'cli-default', '--json']);
    assert.equal(r.exit, null);
    assert.deepEqual(JSON.parse(r.out).scopes, ['read', 'write']);
});

await t('CLI --scopes read,review mints a review token; plaintext is not stored', async () => {
    const r = await capture(['issue', '--workspace', 'default', '--label', 'cli-review', '--scopes', 'read,review', '--json']);
    assert.equal(r.exit, null);
    const j = JSON.parse(r.out);
    assert.deepEqual(j.scopes, ['read', 'review']);
    const rec = listTokens().find((e) => e.label === 'cli-review');
    assert.ok(rec, `no registry entry labelled cli-review`);
    assert.ok(rec.scopes.includes('review'), JSON.stringify(rec));
    assert.ok(!JSON.stringify(listTokens()).includes(j.token));
});

await t('CLI rejects an unknown scope', async () => {
    const r = await capture(['issue', '--workspace', 'default', '--label', 'bad', '--scopes', 'read,approve']);
    assert.equal(r.exit, 1);
    assert.match(r.err, /Unknown scope "approve"/);
});

await t('CLI help lists review', async () => {
    const r = await capture(['--help']);
    assert.match(r.out, /review/);
});

const principal = (workspace: string, scopes: string[]): any => ({ kind: 'app', workspace, scopes, label: 't' });

await t('requireReviewToWorkspace: 401 without a principal', () => {
    const o: any = requireReviewToWorkspace(null, 'a');
    assert.equal(o.ok, false); assert.equal(o.status, 401); assert.equal(o.code, 'auth_required');
});

await t('requireReviewToWorkspace: read / write / read+write tokens get 403 scope_missing', () => {
    for (const scopes of [['read'], ['write'], ['read', 'write'], ['cross-workspace-write', 'write']]) {
        const o: any = requireReviewToWorkspace(principal('a', scopes), 'a');
        assert.equal(o.ok, false); assert.equal(o.status, 403); assert.equal(o.code, 'scope_missing');
    }
});

await t('requireReviewToWorkspace: own workspace ok; foreign needs cross-workspace-write', () => {
    assert.equal((requireReviewToWorkspace(principal('a', ['review']), 'a') as any).ok, true);
    assert.equal((requireReviewToWorkspace(principal('a', ['review']), undefined) as any).ok, true);
    const f: any = requireReviewToWorkspace(principal('a', ['review']), 'b');
    assert.equal(f.ok, false); assert.equal(f.status, 403); assert.equal(f.code, 'workspace_forbidden');
    const f2: any = requireReviewToWorkspace(principal('a', ['review', 'cross-workspace-read']), 'b');
    assert.equal(f2.ok, false);
    assert.equal((requireReviewToWorkspace(principal('a', ['review', 'cross-workspace-write']), 'b') as any).ok, true);
});

console.log(`\nreview-scope-unit: ${passed} passed, 0 failed`);
