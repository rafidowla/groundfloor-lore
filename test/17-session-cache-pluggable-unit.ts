#!/usr/bin/env tsx
/**
 * 17-session-cache-pluggable-unit.ts — Sprint 17 pluggability proof.
 *
 * Goal: prove the ISessionCache surface is genuinely pluggable —
 * any consumer holding the interface (not the concrete file-backed
 * class) keeps working with any compliant impl, and the typed
 * RedisSessionCache stub throws the right "not yet implemented"
 * signal until Task #12 wires the real client.
 *
 * No actual Redis required — interface + typed stub only. Concrete
 * Redis impl ships in the cloud build phase.
 */

import assert from 'node:assert/strict';
import {
    RedisSessionCache,
    SessionCacheNotImplementedError,
    type ISessionCache,
    type HotSessionSnapshot,
} from '../packages/lore/src/engines/sessionCache.js';
import { SessionCacheManager } from '../packages/lore/src/engines/sessionCacheManager.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

let passed = 0;
let failed = 0;
const test = (name: string, fn: () => void | Promise<void>) => async () => {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ✗ ${name}\n    ${(e as Error).message}`);
        failed++;
    }
};

console.log('Sprint 17 — sessionCache pluggable interface');

// Throwaway tmp dir so the local file backend doesn't pollute anything.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-17-'));

await test('SessionCacheManager implements ISessionCache (structural)', () => {
    const local: ISessionCache = new SessionCacheManager(tmp);
    assert.equal(typeof local.pushNode, 'function');
    assert.equal(typeof local.getHotContext, 'function');
    assert.equal(typeof local.flushNow, 'function');
})();

await test('SessionCacheManager round-trip: pushNode → getHotContext', () => {
    const local: ISessionCache = new SessionCacheManager(tmp);
    local.pushNode('lore:a');
    local.pushNode('lore:b');
    local.pushNode('lore:c');
    const snap: HotSessionSnapshot = local.getHotContext();
    // Most-recent first, deduped, capped.
    assert.deepEqual(snap.recent_nodes.slice(0, 3), ['lore:c', 'lore:b', 'lore:a']);
})();

await test('SessionCacheManager flushNow writes hot_session.json', () => {
    // The cache path is <basePath>/.lore/hot_session.json. SessionCacheManager
    // does not mkdir on its own (the graph engine creates .lore at
    // construction); unit test stands in for that lifecycle.
    const sub = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-17-flush-'));
    fs.mkdirSync(path.join(sub, '.lore'), { recursive: true });
    const local = new SessionCacheManager(sub);
    local.pushNode('lore:flushtest');
    local.flushNow();
    const onDisk = path.join(sub, '.lore', 'hot_session.json');
    assert.ok(fs.existsSync(onDisk), 'hot_session.json should exist after flushNow');
    const body = JSON.parse(fs.readFileSync(onDisk, 'utf-8'));
    assert.ok(body.recent_nodes.includes('lore:flushtest'));
    fs.rmSync(sub, { recursive: true, force: true });
})();

await test('RedisSessionCache implements ISessionCache (structural)', () => {
    const fakeClient = { kind: 'ioredis' };
    const redis: ISessionCache = new RedisSessionCache(fakeClient);
    assert.equal(typeof redis.pushNode, 'function');
    assert.equal(typeof redis.getHotContext, 'function');
    assert.equal(typeof redis.flushNow, 'function');
})();

await test('RedisSessionCache.pushNode throws SessionCacheNotImplementedError', () => {
    const redis = new RedisSessionCache({});
    assert.throws(
        () => redis.pushNode('lore:x'),
        (e: unknown) =>
            e instanceof SessionCacheNotImplementedError &&
            (e as SessionCacheNotImplementedError).code === 'session_cache_redis_not_implemented',
    );
})();

await test('RedisSessionCache.getHotContext throws SessionCacheNotImplementedError', () => {
    const redis = new RedisSessionCache({});
    assert.throws(
        () => redis.getHotContext(),
        (e: unknown) => e instanceof SessionCacheNotImplementedError,
    );
})();

await test('RedisSessionCache.flushNow throws SessionCacheNotImplementedError', () => {
    const redis = new RedisSessionCache({});
    assert.throws(
        () => redis.flushNow(),
        (e: unknown) => e instanceof SessionCacheNotImplementedError,
    );
})();

await test('Swap rehearsal: code that reads ISessionCache works with both backends', () => {
    function readRecent(cache: ISessionCache): string[] {
        try {
            return cache.getHotContext().recent_nodes;
        } catch (e) {
            if (e instanceof SessionCacheNotImplementedError) return [];
            throw e;
        }
    }
    const local: ISessionCache = new SessionCacheManager(tmp);
    local.pushNode('lore:swap');
    assert.ok(readRecent(local).includes('lore:swap'));
    const redis: ISessionCache = new RedisSessionCache({});
    // Cloud-mode caller falls back gracefully via the typed sentinel.
    assert.deepEqual(readRecent(redis), []);
})();

setTimeout(() => {
    try {
        fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
        // best effort
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}, 200);
