#!/usr/bin/env tsx
/**
 * surreal-error-redaction-unit.ts — SurrealDB failures must not leak raw
 * content into errors or logs (Phase 1 hard constraint: "error redaction").
 *
 * Companion to test/sw14-error-redaction-unit.ts, which covers the same
 * property for the analytics/DDL surface. SurrealDB deserves its own file
 * because it leaks in two shapes the legacy graph engine does not:
 *
 *   1. A parse failure echoes the FULL statement back inside an ASCII code
 *      frame — including any literal in it.
 *   2. An open/IO failure echoes the absolute on-disk path — which on a
 *      personal machine contains the username and often the workspace name.
 *
 * `LoreGraphError` deliberately inlines its cause into `.message` (NW-BULK, so
 * a real backpressure signal isn't hidden behind a generic wrapper), which
 * means anything the driver says travels straight to stderr, to
 * `~/.groundfloor/logs/`, and into pasted bug reports. The single chokepoint
 * is engines/surreal/surrealError.ts.
 *
 * What is asserted:
 *   A. A driver failure surfaces as a LoreGraphError whose message keeps the
 *      diagnosable PROSE but hashes paths / quoted content to `id#<hash>`.
 *   B. Our OWN authored errors are NOT re-redacted — an error that names the
 *      id the caller just passed is useful, not a leak.
 *   C. Nothing written to stderr during a real failing operation contains the
 *      workspace path or the node content.
 *   D. The hash is stable, so two log lines about the same value still
 *      correlate (the property that makes redaction usable at all).
 *
 * Run: npx tsx test/surreal-error-redaction-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import { redactSurrealLog, surrealError } from '../packages/lore/src/engines/surreal/surrealError.js';
import { LoreGraphError } from '../packages/lore/src/engines/loreGraphError.js';
import { shortHash } from '../packages/lore/src/security/logRedact.js';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? String(err)}`);
        failed++;
    }
}

/**
 * Capture everything written to stderr while `fn` runs. Mirrors the harness in
 * test/sw32-logger-unit.ts — patching `process.stderr.write` catches
 * console.error/console.warn and anything else that bypasses a logger.
 */
async function captureStderr(fn: () => Promise<void>): Promise<string> {
    const original = process.stderr.write.bind(process.stderr);
    let captured = '';
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
        captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
        return original(chunk as string, ...(rest as []));
    }) as typeof process.stderr.write;
    try {
        await fn();
    } finally {
        process.stderr.write = original;
    }
    return captured;
}

console.log('SurrealGraph — error redaction');

/* ─── A. driver failures are redacted ────────────────────────────── */

await test('a driver error carrying an absolute path is hashed, prose survives', () => {
    const raw = new Error('IO error opening /Users/someone/Downloads/lore-data/.lore/surreal: locked');
    const wrapped = surrealError('Failed to open embedded SurrealDB (surrealkv)', 'openSurreal', raw);

    assert.ok(wrapped instanceof LoreGraphError);
    assert.ok(!wrapped.message.includes('/Users/someone'), 'the absolute path must not survive');
    assert.ok(!wrapped.message.includes('lore-data'), 'nor any segment of it');
    assert.match(wrapped.message, /id#[0-9a-f]{8}/, 'it is replaced by a correlatable tag');
    // The parts an operator needs are still there.
    assert.match(wrapped.message, /Failed to open embedded SurrealDB \(surrealkv\)/);
    assert.match(wrapped.message, /IO error opening/);
    assert.match(wrapped.message, /locked/);
});

await test('a parse error echoing the statement does not leak its literals', () => {
    const raw = new Error(
        'Parse error: Unexpected token\n --> [1:8]\n  |\n1 | SELECT * FROM node WHERE content = "salary is 250000"\n  |        ^',
    );
    const wrapped = surrealError('Failed to search', 'search', raw);
    assert.ok(!wrapped.message.includes('salary is 250000'), 'quoted content must be hashed');
    assert.match(wrapped.message, /Parse error/, 'the failure kind is still legible');
});

await test('a bare namespaced id in a driver message is hashed', () => {
    const wrapped = surrealError('Failed to get node', 'getNode', new Error('no record person:sarah-smith'));
    assert.ok(!wrapped.message.includes('sarah-smith'));
    assert.match(wrapped.message, /id#[0-9a-f]{8}/);
});

await test('the redaction tag is STABLE, so log lines still correlate', () => {
    const secret = '/Users/someone/workspace/.lore/surreal';
    const first = surrealError('a', 'op', new Error(`open ${secret}`)).message;
    const second = surrealError('b', 'op', new Error(`close ${secret}`)).message;
    const tag = `id#${shortHash(secret)}`;
    assert.ok(first.includes(tag) && second.includes(tag),
        'the same input yields the same tag across calls — that is what makes this usable');
});

await test('a non-Error cause (string / object) is still redacted', () => {
    const fromString = surrealError('x', 'op', '/var/data/secret-workspace/db failed').message;
    assert.ok(!fromString.includes('secret-workspace'));
    const fromObject = surrealError('x', 'op', { toString: () => '/home/me/private/.lore' }).message;
    assert.ok(!fromObject.includes('/home/me/private'));
});

/* ─── B. our own errors stay legible ─────────────────────────────── */

await test('an error we authored ourselves is passed through, not re-hashed', () => {
    const ours = new LoreGraphError("edge_endpoint_missing: source 'ghost' not found", 'addEdge');
    const wrapped = surrealError('Failed to add edge', 'addEdge', ours);
    assert.equal(wrapped, ours, 'the same object is returned, unchanged');
    assert.match(wrapped.message, /ghost/, 'naming the caller\'s own input is the point of the message');
});

await test('a missing cause produces a clean error with no cause noise', () => {
    const wrapped = surrealError('Something failed', 'op');
    assert.match(wrapped.message, /\[LoreGraph:op\] Something failed$/);
});

/* ─── C. real failing operations do not leak to stderr ───────────── */

await test('a real failed open logs no workspace path to stderr', async () => {
    // A path that cannot be opened: the data directory's parent is a FILE.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-surreal-redact-'));
    const blocker = path.join(base, '.lore');
    fs.writeFileSync(blocker, 'not a directory');
    try {
        const graph = new SurrealGraph(base, { backend: 'surrealkv' });
        let message = '';
        const stderr = await captureStderr(async () => {
            try {
                await graph.initialize();
            } catch (err) {
                message = (err as Error).message;
            }
            await graph.close().catch(() => undefined);
        });
        assert.ok(message.length > 0, 'the open must fail for this case to mean anything');
        assert.ok(!message.includes(base), `the workspace path leaked into the error:\n${message}`);
        assert.ok(!stderr.includes(base), `the workspace path leaked to stderr:\n${stderr}`);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

await test('a non-fatal prune failure logs a redacted message, not a raw one', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-surreal-redact-prune-'));
    try {
        const graph = new SurrealGraph(base);
        await graph.initialize();
        await graph.close();
        // Closed handle → the prune fails internally and must log non-fatally.
        const stderr = await captureStderr(async () => {
            const pruned = await graph.pruneEphemeralNodes();
            assert.equal(pruned, 0, 'prune failure is non-fatal and reports zero');
        });
        assert.ok(!stderr.includes(base), `the workspace path leaked to stderr:\n${stderr}`);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

await test('markStaleByTags does not log raw tag values', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-surreal-redact-tags-'));
    try {
        const graph = new SurrealGraph(base);
        await graph.initialize();
        await graph.upsertNode({
            id: 'n1', type: 'decision', label: 'L', content: 'C',
            tags: ['client-acme-confidential'], project: 'p', ecosystem: '*', metadata: '{}',
        });
        const stderr = await captureStderr(async () => {
            assert.equal(await graph.markStaleByTags(['client-acme-confidential']), 1);
        });
        assert.ok(stderr.includes('marked 1 node(s) stale'), 'the operational fact is still logged');
        assert.ok(!stderr.includes('client-acme-confidential'), `the raw tag leaked:\n${stderr}`);
        await graph.close();
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

/* ─── D. the log helper itself ───────────────────────────────────── */

await test('redactSurrealLog scrubs paths and quoted content in a composed line', () => {
    const line = redactSurrealLog('[SurrealGraph] failed on "secret content" at /Users/me/ws/.lore/surreal');
    assert.ok(!line.includes('secret content'));
    assert.ok(!line.includes('/Users/me'));
    assert.match(line, /\[SurrealGraph\] failed on/, 'the operational prefix survives');
});

await test('redactSurrealLog leaves ordinary prose alone', () => {
    const line = redactSurrealLog('[SurrealGraph] pruneEphemeralNodes: deleted 3 expired ephemeral node(s)');
    assert.equal(line, '[SurrealGraph] pruneEphemeralNodes: deleted 3 expired ephemeral node(s)',
        'over-redaction would make logs useless — only ids/paths/quoted runs are hashed');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
