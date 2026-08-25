#!/usr/bin/env tsx
/**
 * sw32-logger-unit.ts — SW-32 (F6): structured logger unit tests.
 *
 * Asserts the thin logger in packages/lore/src/logger.ts:
 *   - respects LORE_LOG_LEVEL (debug suppressed at info; error always emits),
 *   - writes to stderr (never stdout — MCP stdio invariant),
 *   - emits a parseable line: <ISO-ts> <LEVEL> <message> [+ JSON context],
 *   - routes messages + context through security/logRedact (quoted node-IDs
 *     are hashed before they hit the log sink).
 *
 * Approach: capture process.stderr.write, drive the logger at varying
 * thresholds via refreshLogLevel(), and assert on the captured lines.
 */

import assert from 'node:assert/strict';

let passed = 0;
let failed = 0;
const tests: Array<Promise<void>> = [];

function test(name: string, fn: () => Promise<void> | void): void {
    tests.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? String(err)}`); failed++; }
    })());
}

const loggerMod = await import('../packages/lore/src/logger.js');
const { log, refreshLogLevel, currentLogLevel } = loggerMod;

/** Run `fn` with LORE_LOG_LEVEL set, capturing every stderr write. */
function withLevel(level: string | undefined, fn: () => void): string[] {
    const prev = process.env.LORE_LOG_LEVEL;
    if (level === undefined) delete process.env.LORE_LOG_LEVEL;
    else process.env.LORE_LOG_LEVEL = level;
    refreshLogLevel();

    const lines: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    // @ts-expect-error — test shim narrows the overloaded signature.
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
        lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
        return true;
    };
    try {
        fn();
    } finally {
        process.stderr.write = origWrite;
        if (prev === undefined) delete process.env.LORE_LOG_LEVEL;
        else process.env.LORE_LOG_LEVEL = prev;
        refreshLogLevel();
    }
    return lines;
}

/* ─────────── level filtering ─────────── */

test('default (unset) level = info: info emits, debug suppressed', () => {
    const lines = withLevel(undefined, () => {
        log.info('info-line');
        log.debug('debug-line');
    });
    assert.equal(currentLogLevel(), 'info');
    assert.ok(lines.some(l => l.includes('info-line')), 'info should emit at default level');
    assert.ok(!lines.some(l => l.includes('debug-line')), 'debug should be suppressed at info');
});

test('LORE_LOG_LEVEL=info suppresses debug', () => {
    const lines = withLevel('info', () => log.debug('quiet'));
    assert.equal(lines.length, 0, 'debug must produce no output at info threshold');
});

test('LORE_LOG_LEVEL=debug lets debug through', () => {
    const lines = withLevel('debug', () => log.debug('verbose'));
    assert.ok(lines.some(l => l.includes('verbose')), 'debug should emit at debug threshold');
});

test('error always emits — even at the strictest (error) threshold', () => {
    const lines = withLevel('error', () => {
        log.error('boom');
        log.warn('should-not-show');
        log.info('should-not-show');
        log.debug('should-not-show');
    });
    assert.ok(lines.some(l => l.includes('boom')), 'error must always emit');
    assert.ok(!lines.some(l => l.includes('should-not-show')), 'warn/info/debug suppressed at error level');
});

test('unknown LORE_LOG_LEVEL falls back to info', () => {
    const lines = withLevel('bananas', () => {
        log.info('fallback-info');
        log.debug('fallback-debug');
    });
    assert.equal(currentLogLevel(), 'info');
    assert.ok(lines.some(l => l.includes('fallback-info')));
    assert.ok(!lines.some(l => l.includes('fallback-debug')));
});

/* ─────────── output shape ─────────── */

test('line shape: ISO timestamp + uppercase LEVEL + message', () => {
    const lines = withLevel('info', () => log.warn('[Lore MCP] hello'));
    const line = lines.find(l => l.includes('hello'))!;
    assert.match(line, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z WARN \[Lore MCP\] hello\n$/);
});

test('context object is appended as JSON', () => {
    const lines = withLevel('info', () => log.info('with-ctx', { port: 3847, mode: 'local' }));
    const line = lines.find(l => l.includes('with-ctx'))!;
    assert.ok(line.includes('"port":3847'), 'context port should appear');
    assert.ok(line.includes('"mode":"local"'), 'context mode should appear');
});

/* ─────────── redaction ─────────── */

test('routes through logRedact: quoted node-ID is hashed, not raw', async () => {
    const { shortHash } = await import('../packages/lore/src/security/logRedact.js');
    const secretId = 'person:sarah-smith';
    const lines = withLevel('info', () => log.error(`lookup failed for '${secretId}'`));
    const line = lines.find(l => l.includes('lookup failed'))!;
    assert.ok(!line.includes('sarah-smith'), 'raw quoted id must not appear in the log line');
    assert.ok(line.includes(`id#${shortHash(secretId)}`), 'hashed id tag must appear');
});

test('redaction also covers quoted ids inside the context object', () => {
    const lines = withLevel('info', () => log.info('ctx-redact', { detail: "failed on 'memory:wedding-2019'" }));
    const line = lines.find(l => l.includes('ctx-redact'))!;
    assert.ok(!line.includes('wedding-2019'), 'quoted id in context must be redacted');
});

/* ─────────── MCP stdio safety: stdout-never-written invariant ─────────── */

/**
 * NW-7e — test-logger-stdout-invariant-missing
 *
 * The daemon speaks MCP over stdout in stdio mode. Any stray write to
 * process.stdout corrupts the JSON-RPC stream. Assert that EVERY logger
 * method — at every level — never calls process.stdout.write, regardless
 * of the current level threshold.
 *
 * Approach: replace process.stdout.write with a sentinel that records the
 * call AND throws, then exercise all four log methods at all four levels.
 * The test fails if the sentinel is ever invoked.
 */
test('stdout-never-written: no log method touches process.stdout at any level', () => {
    const levels: Array<string> = ['error', 'warn', 'info', 'debug'];
    const methods: Array<'error' | 'warn' | 'info' | 'debug'> = ['error', 'warn', 'info', 'debug'];
    const calls: string[] = [];

    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    // @ts-expect-error — test shim narrows the overloaded signature.
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
        const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
        calls.push(text);
        return true;
    };

    const origStderrWrite = process.stderr.write.bind(process.stderr);
    // Suppress stderr output during this sub-test but capture it cleanly.
    // @ts-expect-error
    process.stderr.write = (_chunk: string | Uint8Array): boolean => true;

    try {
        for (const level of levels) {
            process.env.LORE_LOG_LEVEL = level;
            refreshLogLevel();
            for (const method of methods) {
                log[method](`stdout-invariant-probe-${method}-at-${level}`);
            }
        }
    } finally {
        process.stdout.write = origStdoutWrite;
        process.stderr.write = origStderrWrite;
        delete process.env.LORE_LOG_LEVEL;
        refreshLogLevel();
    }

    assert.equal(
        calls.length,
        0,
        `logger must never write to stdout; got ${calls.length} call(s): ${JSON.stringify(calls.slice(0, 3))}`,
    );
});

/* ─────────── runner ─────────── */

console.log('\n=== SW-32 structured-logger unit tests ===\n');
await Promise.all(tests);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
