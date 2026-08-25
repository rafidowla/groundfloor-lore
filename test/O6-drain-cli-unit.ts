#!/usr/bin/env tsx
/**
 * test/O6-drain-cli-unit.ts — Sprint O6 drain-failed CLI flag tests.
 *
 * Exercises the `outboxCommand`'s flag parsing + dispatch shape WITHOUT
 * spinning a graph engine / VerbatimStore. The end-to-end behavior with
 * real substrates is covered by O6-self-heal-unit.ts via the replicator
 * harness; this file pins the flag parser + the CLI router contract:
 *
 *   T1 — `lore outbox --help` prints subcommand list (no exit)
 *   T2 — `lore outbox drain-failed --help` prints flag list (no exit)
 *   T3 — `lore outbox bogus` exits non-zero with unknown-subcommand error
 *   T4 — parseDrainFlags defaults: checkSubstrate=true, markDead=false,
 *        dryRun=false (matches spec)
 *   T5 — parseDrainFlags parses --workspace, --dry-run, --mark-dead,
 *        --limit, --no-check-substrate
 *   T6 — parseDrainFlags ignores invalid --limit (negative / NaN)
 *   T7 — parseDrainFlags short-form -h sets help=true
 */

import assert from 'node:assert/strict';

import { outboxCommand, parseDrainFlags, buildDrainWiringInput } from '../packages/lore/src/cli/commands/outbox.js';

let passed = 0;
let failed = 0;
const cases: Array<{ name: string; fn: () => Promise<void> | void }> = [];

function test(name: string, fn: () => Promise<void> | void): void {
    cases.push({ name, fn });
}

async function runAll(): Promise<void> {
    for (const c of cases) {
        try {
            await c.fn();
            passed++;
            console.log(`  ✓ ${c.name}`);
        } catch (err) {
            failed++;
            console.error(`  ✗ ${c.name}: ${(err as Error).message}`);
        }
    }
}

function captureConsole(): { restore: () => void; out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (msg?: unknown) => { out.push(String(msg ?? '')); };
    console.error = (msg?: unknown) => { err.push(String(msg ?? '')); };
    return {
        restore: () => { console.log = origLog; console.error = origErr; },
        out, err,
    };
}

function captureExit(): { restore: () => void; readonly code: number | null } {
    const orig = process.exit;
    const tracker = { code: null as number | null };
    (process as unknown as { exit: (n?: number) => void }).exit = (n?: number) => {
        tracker.code = n ?? 0;
        throw new Error(`__test_exit_${tracker.code}`);
    };
    return {
        restore: () => { (process as unknown as { exit: typeof orig }).exit = orig; },
        get code() { return tracker.code; },
    };
}

console.log('Sprint O6 drain-failed CLI unit tests');

test('T1 outbox --help prints subcommand list', async () => {
    const cap = captureConsole();
    try { await outboxCommand([]); } finally { cap.restore(); }
    const joined = cap.out.join('\n');
    assert.match(joined, /drain-failed/);
    assert.match(joined, /Subcommands/);
});

test('T2 drain-failed --help prints flag list', async () => {
    const cap = captureConsole();
    try { await outboxCommand(['drain-failed', '--help']); } finally { cap.restore(); }
    const joined = cap.out.join('\n');
    assert.match(joined, /--workspace/);
    assert.match(joined, /--check-substrate/);
    assert.match(joined, /--mark-dead/);
    assert.match(joined, /--dry-run/);
});

test('T3 outbox bogus exits non-zero with unknown-subcommand error', async () => {
    const cap = captureConsole();
    const exitCap = captureExit();
    let threw = false;
    try { await outboxCommand(['bogus-subcommand']); }
    catch (e) { threw = String((e as Error).message).startsWith('__test_exit_'); }
    finally { cap.restore(); exitCap.restore(); }
    assert.equal(threw, true);
    assert.notEqual(exitCap.code, 0);
    assert.match(cap.err.join('\n'), /Unknown 'lore outbox' subcommand/);
});

test('T4 parseDrainFlags defaults', () => {
    const f = parseDrainFlags([]);
    assert.equal(f.checkSubstrate, true);
    assert.equal(f.markDead, false);
    assert.equal(f.dryRun, false);
    assert.equal(f.workspace, undefined);
    assert.equal(f.limit, undefined);
    assert.equal(f.help, false);
});

test('T5 parseDrainFlags parses full flag set', () => {
    const f = parseDrainFlags(['--workspace', 'ws1', '--dry-run', '--mark-dead', '--no-check-substrate', '--limit', '42']);
    assert.equal(f.workspace, 'ws1');
    assert.equal(f.dryRun, true);
    assert.equal(f.markDead, true);
    assert.equal(f.checkSubstrate, false);
    assert.equal(f.limit, 42);
});

test('T6 parseDrainFlags ignores invalid --limit', () => {
    const fNeg = parseDrainFlags(['--limit', '-5']);
    const fNaN = parseDrainFlags(['--limit', 'abc']);
    assert.equal(fNeg.limit, undefined);
    assert.equal(fNaN.limit, undefined);
});

test('T7 parseDrainFlags short-form -h sets help', () => {
    const f = parseDrainFlags(['-h']);
    assert.equal(f.help, true);
});

// L-004 — drain-failed must thread a getGraphForWorkspace resolver so a
// non-default workspace's rows are verified against THAT workspace's declared
// graph engine, not the boot-bound graph. Previously no resolver was passed →
// wiring.resolveGraph fell back to the boot graph for every row (false
// negatives on atlas rows). buildDrainWiringInput is the pure seam; we assert
// the resolver is present and routes by workspace through getGraphHandle — the
// engine-aware registry accessor — without opening real graphs.
test('T8 buildDrainWiringInput threads an engine-aware per-workspace resolver', async () => {
    const opened: string[] = [];
    const fakeGraph = { __fake: true };
    const registry = {
        getGraphHandle: async (ws: string) => { opened.push(ws); return fakeGraph; },
    };
    const input = buildDrainWiringInput({ loreDir: '/tmp/.lore', bootGraph: fakeGraph, registry });

    // getGraph returns the pre-opened boot graph synchronously (boot fallback).
    assert.equal(input.getGraph(), fakeGraph);

    // getGraphForWorkspace MUST be present (the L-004 fix) …
    assert.equal(typeof input.getGraphForWorkspace, 'function', 'resolver getter present');
    const resolver = input.getGraphForWorkspace();
    assert.equal(typeof resolver, 'function', 'resolver is a function');

    // … and routes each row's probe to its OWN workspace's graph handle.
    const g = await resolver!('atlas');
    assert.equal(g, fakeGraph);
    assert.deepEqual(opened, ['atlas'], 'resolver opened the requested workspace through getGraphHandle');

    // loreDir is passed through unchanged (outbox SQLite location must not move).
    assert.equal(input.loreDir, '/tmp/.lore');
});

await runAll();

console.log('');
console.log(`passed:  ${passed}`);
console.log(`failed:  ${failed}`);
if (failed > 0) process.exit(1);
console.log('OK');
