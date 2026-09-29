#!/usr/bin/env tsx
/**
 * test/version-history-policy-unit.ts — the effective version-history policy
 * (owner decision 2026-09-29: age-based deletion is OPT-IN, default keep
 * forever, 7 years when enabled) and its read-only REST surface.
 *
 * P*  resolveEffectiveVersionHistoryPolicy precedence + validation
 * S*  VersionStore carries/returns the effective policy
 * R*  GET /api/version-history/policy returns it; no write verb is handled
 *
 * The MCP tool and the embedded getter are proven through a real
 * createLore() in test/version-history-optin-embedded.ts.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
    DEFAULT_PRUNE_RETENTION_DAYS,
    resolveEffectiveVersionHistoryPolicy,
    _resetLegacyRetentionNoticeForTests,
} from '../packages/lore/src/outbox/versionPruningPolicy.js';
import { validateVersionHistoryPolicy } from '../packages/lore/src/outbox/versionPolicy.js';
import { VersionStore } from '../packages/lore/src/outbox/versionStore.js';
import { tryVersioningRoutes } from '../packages/lore/src/mcp/http/routes/versioning.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
}

console.log('\nVersion-history policy — opt-in retention\n');

await test('P1: no option, no env -> disabled, retentionDays null, source default', () => {
    const p = resolveEffectiveVersionHistoryPolicy(undefined, {});
    assert.equal(p.enabled, false);
    assert.equal(p.retentionDays, null);
    assert.equal(p.source, 'default');
    assert.deepEqual(p.skipTypes, []);
    assert.deepEqual(p.retentionDaysByType, {});
});

await test('P2: DEFAULT_PRUNE_RETENTION_DAYS is 7 years (2557 days)', () => {
    assert.equal(DEFAULT_PRUNE_RETENTION_DAYS, 2557);
});

await test('P3: option pruning.enabled -> 7-year default, source option', () => {
    const p = resolveEffectiveVersionHistoryPolicy({ pruning: { enabled: true } }, {});
    assert.equal(p.enabled, true);
    assert.equal(p.retentionDays, 2557);
    assert.equal(p.source, 'option');
});

await test('P4: option retentionDays wins over env; option enabled:false wins over env enable', () => {
    const on = resolveEffectiveVersionHistoryPolicy(
        { pruning: { enabled: true, retentionDays: 400 } },
        { LORE_VERSION_PRUNE_ENABLED: '1', LORE_VERSION_RETENTION_DAYS: '30' },
    );
    assert.equal(on.retentionDays, 400);
    const off = resolveEffectiveVersionHistoryPolicy(
        { pruning: { enabled: false } },
        { LORE_VERSION_PRUNE_ENABLED: '1' },
    );
    assert.equal(off.enabled, false);
    assert.equal(off.source, 'option');
});

await test('P5: env LORE_VERSION_PRUNE_ENABLED=1 -> enabled at 7 years, source env', () => {
    const p = resolveEffectiveVersionHistoryPolicy(undefined, { LORE_VERSION_PRUNE_ENABLED: '1' });
    assert.equal(p.enabled, true);
    assert.equal(p.retentionDays, 2557);
    assert.equal(p.source, 'env');
});

await test('P6: LORE_VERSION_PRUNE_ENABLED=1 + LORE_VERSION_RETENTION_DAYS=45 -> enabled at 45', () => {
    const p = resolveEffectiveVersionHistoryPolicy(undefined, { LORE_VERSION_PRUNE_ENABLED: '1', LORE_VERSION_RETENTION_DAYS: '45' });
    assert.equal(p.retentionDays, 45);
});

await test('P7: explicit LORE_VERSION_RETENTION_DAYS alone -> enabled at that value, logged ONCE', () => {
    _resetLegacyRetentionNoticeForTests();
    const lines: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { lines.push(a.join(' ')); };
    try {
        const a = resolveEffectiveVersionHistoryPolicy(undefined, { LORE_VERSION_RETENTION_DAYS: '30' });
        const b = resolveEffectiveVersionHistoryPolicy(undefined, { LORE_VERSION_RETENTION_DAYS: '30' });
        assert.equal(a.enabled, true);
        assert.equal(a.retentionDays, 30);
        assert.equal(a.source, 'env');
        assert.equal(b.retentionDays, 30);
    } finally { console.error = orig; }
    assert.equal(lines.filter((l) => l.includes('[version-prune]')).length, 1, `expected exactly one notice, got ${lines.length}`);
});

await test('P8: LORE_VERSION_PRUNE_ENABLED=0 wins over an explicit retention env; junk retention is ignored', () => {
    const off = resolveEffectiveVersionHistoryPolicy(undefined, { LORE_VERSION_PRUNE_ENABLED: '0', LORE_VERSION_RETENTION_DAYS: '30' });
    assert.equal(off.enabled, false);
    const junk = resolveEffectiveVersionHistoryPolicy(undefined, { LORE_VERSION_RETENTION_DAYS: 'abc' });
    assert.equal(junk.enabled, false);
    const neg = resolveEffectiveVersionHistoryPolicy(undefined, { LORE_VERSION_RETENTION_DAYS: '-5' });
    assert.equal(neg.enabled, false);
});

await test('P9: skipTypes / retentionDaysByType are reported but do NOT enable pruning', () => {
    const p = resolveEffectiveVersionHistoryPolicy(
        { skipTypes: ['code_symbol'], retentionDaysByType: { note: 5 } },
        {},
    );
    assert.equal(p.enabled, false);
    assert.equal(p.retentionDays, null);
    assert.deepEqual(p.skipTypes, ['code_symbol']);
    assert.deepEqual(p.retentionDaysByType, { note: 5 });
    assert.equal(p.skipTypesSource, 'option');
});

await test('P10: validateVersionHistoryPolicy accepts a good pruning block and rejects bad ones', () => {
    validateVersionHistoryPolicy({ pruning: { enabled: true, retentionDays: 90 } });
    validateVersionHistoryPolicy({ pruning: { enabled: false } });
    assert.throws(() => validateVersionHistoryPolicy({ pruning: { enabled: 'yes' as never } }));
    assert.throws(() => validateVersionHistoryPolicy({ pruning: { enabled: true, retentionDays: 0 } }));
    assert.throws(() => validateVersionHistoryPolicy({ pruning: { enabled: true, retentionDays: -1 } }));
    assert.throws(() => validateVersionHistoryPolicy({ pruning: 5 as never }));
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-vpol-'));

await test('S1: a bare VersionStore reports the default (disabled) policy; setEffectiveHistoryPolicy is what the host wires', () => {
    const store = VersionStore.open(dir);
    try {
        const before = store.getEffectiveHistoryPolicy();
        assert.equal(before.enabled, false);
        store.setEffectiveHistoryPolicy(resolveEffectiveVersionHistoryPolicy({ pruning: { enabled: true, retentionDays: 10 } }, {}));
        const after = store.getEffectiveHistoryPolicy();
        assert.equal(after.enabled, true);
        assert.equal(after.retentionDays, 10);
    } finally { store.close(); }
});

/* ─── REST ─────────────────────────────────────────────────────── */
type FakeRes = ServerResponse & { _status: number; _body: string };
function fakeRes(): FakeRes {
    return {
        _status: 0, _body: '',
        writeHead(s: number) { (this as FakeRes)._status = s; return this; },
        end(b?: string) { (this as FakeRes)._body = b ?? ''; },
    } as unknown as FakeRes;
}
function req(method: string): IncomingMessage {
    return { method, url: '/api/version-history/policy', on: () => undefined } as unknown as IncomingMessage;
}

await test('R1: GET /api/version-history/policy returns the effective policy (default: disabled)', async () => {
    const store = VersionStore.open(dir);
    try {
        const res = fakeRes();
        const handled = await tryVersioningRoutes(
            req('GET'), res, '/api/version-history/policy', '/api/version-history/policy',
            { deploymentMode: 'local', dataplane: null, versionStore: store, store: {} } as never,
        );
        assert.equal(handled, true);
        assert.equal(res._status, 200);
        const body = JSON.parse(res._body);
        assert.equal(body.enabled, false);
        assert.equal(body.retentionDays, null);
        assert.equal(body.source, 'default');
        assert.deepEqual(Object.keys(body).sort(), ['enabled', 'retentionDays', 'retentionDaysByType', 'skipTypes', 'skipTypesSource', 'source']);
    } finally { store.close(); }
});

await test('R2: the route reflects an enabled policy, and no write verb is handled (read-only)', async () => {
    const store = VersionStore.open(dir);
    try {
        store.setEffectiveHistoryPolicy(resolveEffectiveVersionHistoryPolicy({ pruning: { enabled: true } }, {}));
        const deps = { deploymentMode: 'local', dataplane: null, versionStore: store, store: {} } as never;
        const res = fakeRes();
        await tryVersioningRoutes(req('GET'), res, '/api/version-history/policy', '/api/version-history/policy', deps);
        const body = JSON.parse(res._body);
        assert.equal(body.enabled, true);
        assert.equal(body.retentionDays, 2557);
        for (const verb of ['POST', 'PUT', 'PATCH', 'DELETE']) {
            const r = fakeRes();
            const handled = await tryVersioningRoutes(req(verb), r, '/api/version-history/policy', '/api/version-history/policy', deps);
            assert.equal(handled, false, `${verb} must not be handled by the versioning routes`);
            assert.equal(r._status, 0, `${verb} must not write a response`);
        }
    } finally { store.close(); }
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
