#!/usr/bin/env tsx
/**
 * cli-strict-args-unit.ts — the shared strict CLI parser (cli/args.ts) and the
 * migration target guard (cli/targetGuard.ts), plus the exported flag parsers
 * of converted commands.
 *
 * Run: npx tsx test/cli-strict-args-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { parseStrict, dataDirFlag, UsageError, type ArgSpec } from '../packages/lore/src/cli/args.js';
import { assertWorkspaceTarget, isInside, TargetRefusedError } from '../packages/lore/src/cli/targetGuard.js';
import { parseDrainFlags } from '../packages/lore/src/cli/commands/outbox.js';
import { parseRequeueFlags } from '../packages/lore/src/cli/commands/outboxRequeue.js';
import { createWorkspace, loadWorkspaces } from '../packages/lore/src/config/workspaces.js';

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void): void {
    try {
        fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? String(err)}`);
        failed++;
    }
}
const usage = (re: RegExp) => (e: unknown) => e instanceof UsageError && re.test(e.message);

const SPEC: ArgSpec = {
    bool: ['--force', '--dry-run'],
    value: ['--to', '--data-dir'],
    repeatable: ['--tag'],
    aliases: { '-h': '--help' },
    positionals: { min: 1, max: 1 },
    help: true,
};

console.log('CLI strict args');
console.log('='.repeat(72));

test('boolean + value flags + positional', () => {
    const p = parseStrict(['ws', '--force', '--to', 'sqlite'], SPEC);
    assert.deepEqual(p.positionals, ['ws']);
    assert.ok(p.has('--force'));
    assert.ok(!p.has('--dry-run'));
    assert.equal(p.get('--to'), 'sqlite');
});

test('a value flag\'s value is never a positional (value-first ordering)', () => {
    const p = parseStrict(['--to', 'sqlite', 'ws'], SPEC);
    assert.deepEqual(p.positionals, ['ws']);
    assert.equal(p.get('--to'), 'sqlite');
});

test('--flag=value form', () => {
    const p = parseStrict(['--to=sqlite', 'ws', '--data-dir=/x/y'], SPEC);
    assert.equal(p.get('--to'), 'sqlite');
    assert.equal(p.get('--data-dir'), '/x/y');
    assert.deepEqual(p.positionals, ['ws']);
});

test('unknown flag is a usage error (the --data-dir incident class)', () => {
    assert.throws(() => parseStrict(['ws', '--dryrun'], SPEC), usage(/unknown flag --dryrun/));
    assert.throws(() => parseStrict(['ws', '--data-dri', '/x'], SPEC), usage(/unknown flag --data-dri/));
    assert.throws(() => parseStrict(['ws', '-x'], SPEC), usage(/unknown flag -x/));
});

test('missing value is a usage error', () => {
    assert.throws(() => parseStrict(['ws', '--to'], SPEC), usage(/--to needs a value/));
    assert.throws(() => parseStrict(['ws', '--to', '--force'], SPEC), usage(/--to needs a value/));
    assert.throws(() => parseStrict(['ws', '--to='], SPEC), usage(/non-empty/));
});

test('value flag given twice is rejected; repeatable collects', () => {
    assert.throws(() => parseStrict(['ws', '--to', 'a', '--to', 'b'], SPEC), usage(/more than once/));
    const p = parseStrict(['ws', '--tag', 'a', '--tag=b'], SPEC);
    assert.deepEqual(p.getAll('--tag'), ['a', 'b']);
});

test('boolean flag with =value is rejected', () => {
    assert.throws(() => parseStrict(['ws', '--force=1'], SPEC), usage(/takes no value/));
});

test('extra and missing positionals are rejected', () => {
    assert.throws(() => parseStrict(['a', 'b'], SPEC), usage(/unexpected argument 'b'/));
    assert.throws(() => parseStrict([], SPEC), usage(/missing required/));
    assert.throws(() => parseStrict(['a'], { positionals: {} }), usage(/unexpected argument 'a'/));
});

test('-5 style tokens are positionals / values, not flags', () => {
    const p = parseStrict(['-5'], { positionals: { min: 1, max: 1 } });
    assert.deepEqual(p.positionals, ['-5']);
    const q = parseStrict(['--n', '-5'], { value: ['--n'] });
    assert.equal(q.get('--n'), '-5');
});

test('-- terminates flag parsing', () => {
    const p = parseStrict(['--force', '--', '--weird-name'], SPEC);
    assert.deepEqual(p.positionals, ['--weird-name']);
    assert.ok(p.has('--force'));
});

test('aliases and help short-circuit', () => {
    const p = parseStrict(['--bogus', '-h'], SPEC);
    assert.ok(p.help);
    assert.ok(parseStrict(['--help'], SPEC).help);
    // help short-circuit does not fire without spec.help
    assert.throws(() => parseStrict(['--help'], { positionals: { max: 0 } }), usage(/unknown flag --help/));
    // after `--` it is a positional, not help
    assert.ok(!parseStrict(['ws', '--', '--help'], { help: true, positionals: { max: 2 } }).help);
});

test('dataDirFlag resolves relative paths and is undefined when absent', () => {
    const p = parseStrict(['ws', '--data-dir', 'rel/dir'], SPEC);
    assert.equal(dataDirFlag(p), path.resolve('rel/dir'));
    assert.equal(dataDirFlag(parseStrict(['ws'], SPEC)), undefined);
});

console.log('\nCLI target guard');
console.log('='.repeat(72));

function tmp(label: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), `lore-cli-guard-${label}-`));
}

test('isInside handles equal, nested, sibling and ..', () => {
    const root = tmp('inside');
    fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
    assert.ok(isInside(root, root));
    assert.ok(isInside(path.join(root, 'a', 'b'), root));
    assert.ok(isInside(path.join(root, 'not-yet', 'there'), root));
    assert.ok(!isInside(path.join(root, '..'), root));
    assert.ok(!isInside(tmp('other'), root));
});

test('guard refuses a missing registry and does not create one', () => {
    const home = tmp('noreg');
    assert.throws(() => assertWorkspaceTarget({ home, workspaceName: 'default', dataDirGiven: true }), TargetRefusedError);
    assert.ok(!fs.existsSync(path.join(home, 'workspaces.json')), 'workspaces.json must not be bootstrapped');
});

test('guard refuses a workspace the registry does not name', () => {
    const home = tmp('noname');
    loadWorkspaces(home);
    assert.throws(() => assertWorkspaceTarget({ home, workspaceName: 'nope', dataDirGiven: false }), /not in .*workspaces\.json/);
});

test('guard accepts a workspace inside the data dir', () => {
    const home = tmp('ok');
    loadWorkspaces(home);
    const ws = createWorkspace('inside-ws', {}, home);
    const r = assertWorkspaceTarget({ home, workspaceName: 'inside-ws', dataDirGiven: true });
    assert.equal(r.registryPath, path.join(home, 'workspaces.json'));
    assert.equal(r.workspacePath, ws.path);
});

test('guard refuses (naming both paths) a registry path outside the data dir', () => {
    const real = tmp('real');
    loadWorkspaces(real);
    const ws = createWorkspace('copied-ws', {}, real);
    const copy = tmp('copy');
    fs.copyFileSync(path.join(real, 'workspaces.json'), path.join(copy, 'workspaces.json'));
    assert.throws(
        () => assertWorkspaceTarget({ home: copy, workspaceName: 'copied-ws', dataDirGiven: true }),
        (e: unknown) => e instanceof TargetRefusedError && e.message.includes(ws.path) && e.message.includes(copy),
    );
    // without --data-dir (plain LORE_HOME use) the path-inside rule is not applied
    assert.doesNotThrow(() => assertWorkspaceTarget({ home: copy, workspaceName: 'copied-ws', dataDirGiven: false }));
});

console.log('\nConverted exported flag parsers');
console.log('='.repeat(72));

test('parseDrainFlags / parseRequeueFlags reject unknown flags and keep lenient --limit', () => {
    assert.throws(() => parseDrainFlags(['--bogus']), UsageError);
    assert.throws(() => parseDrainFlags(['--workspace']), UsageError);
    assert.throws(() => parseDrainFlags(['stray']), UsageError);
    assert.equal(parseDrainFlags(['--limit', 'abc']).limit, undefined);
    assert.equal(parseDrainFlags(['--limit=7']).limit, 7);
    assert.ok(parseDrainFlags(['--bogus', '-h']).help);
    assert.throws(() => parseRequeueFlags(['--lore-dir']), UsageError);
    assert.throws(() => parseRequeueFlags(['--dryrun']), UsageError);
    assert.equal(parseRequeueFlags(['--lore-dir=/a/.lore']).loreDir, '/a/.lore');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
