#!/usr/bin/env tsx
/**
 * sp17-env-scrub-timing-unit.ts — parent-env scrub: ORDERING + OWNERSHIP.
 *
 * Two findings live here.
 *
 * SP-17 (original, ordering): runEnvScrub() ran at the top of main(), but
 * server.ts performed its module-level env reads during module EVALUATION,
 * which completes BEFORE main() is called — so those reads saw the UNSCRUBBED
 * env. Construction has since moved into createLore(), and the scrub is the
 * first executed statement there, ahead of every env read.
 *
 * S9-EMBEDDED-ENV-SCRUB (this rewrite, ownership): the scrub deletes every
 * non-allowlisted var from the process-GLOBAL `process.env`. Because it sat
 * unconditionally at the top of createLore() — the public embedded entrypoint —
 * it ran for LIBRARY consumers too, deleting the HOST application's own config
 * out from under it. Reported by an embedder whose OPENROUTER_API_KEY vanished
 * mid-process; every subsequent LLM call failed with "401 Missing
 * Authentication header" while the key sat present and valid in .env.local, so
 * the error pointed at the key rather than at Lore. It reproduced in ALL THREE
 * deployment modes (embedded, local, cloud) because the scrub runs before the
 * mode is even resolved, and it ran even when Lore's own init THREW.
 *
 * The fix: gate both process-global side effects on `opts.ownsProcess`, which
 * only the daemon entry (`main()`, behind `isProcessEntrypoint()`) sets.
 *
 * WHY THIS FILE WAS REWRITTEN. The previous version asserted ordering by
 * comparing `indexOf()` positions of substrings in server.ts's SOURCE TEXT, and
 * asserted the scrub was "not the first statement of main()". That could not
 * have caught this bug: the call it was checking for was present and correctly
 * positioned the whole time — it was the missing GATE that was the defect, and
 * a text scan has no notion of whether a call is reachable for a given caller.
 * It also actively blocked the fix. Part A below is therefore BEHAVIORAL: it
 * runs real createLore() calls in child processes and inspects the resulting
 * process.env. Part C keeps a static guard, but on the one property that must
 * hold for ORDERING and cannot be observed at runtime (the gate must not read
 * env).
 *
 * Child processes are used for Part A because a passing daemon-path assertion
 * necessarily scrubs the env of the process that observes it — done in-process
 * that would destroy the test runner's own environment mid-suite.
 */

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scrubEnv } from '../packages/lore/src/security/envScrub.js';

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF), '..');
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');

/** The host secret planted before init and read back after — the reported repro. */
const HOST_VAR = 'SP17_HOST_OPENROUTER_API_KEY';

/* ════════════════════════════════════════════════════════════════════════════
 * CHILD MODE — runs one createLore() call and reports whether the planted host
 * var survived. Kept at the top so the parent's spawn contract is obvious.
 * ══════════════════════════════════════════════════════════════════════════ */

if (process.argv.includes('--child')) {
    const mode = process.argv[process.argv.indexOf('--mode') + 1] as
        'embedded' | 'local' | 'cloud';
    const owns = process.argv.includes('--owns');

    process.env[HOST_VAR] = 'host-secret-value';

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-sp17-'));
    let initThrew = false;
    let lore: { dispose?: (r?: string) => Promise<unknown> } | undefined;
    try {
        const { createLore } = await import('../packages/lore/src/index.js');
        lore = await createLore({
            deploymentMode: mode,
            dataDir,
            ...(owns ? { ownsProcess: true } : {}),
        });
    } catch {
        initThrew = true;
    }

    // Read LAZILY, after init — exactly how the reporting host reads its key.
    const survived = process.env[HOST_VAR] === 'host-secret-value';
    // stdout is shared with Lore's logger; use a unique prefix the parent greps.
    console.log(`__SP17__ survived=${survived} threw=${initThrew}`);

    try { await lore?.dispose?.('sp17-child'); } catch { /* teardown noise */ }
    process.exit(0);
}

/* ════════════════════════════════════════════════════════════════════════════
 * PARENT MODE
 * ══════════════════════════════════════════════════════════════════════════ */

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

/**
 * Run one child and return what it observed.
 *
 * @param stripCloudConfig blank out the cloud adapter vars in the CHILD's env so
 *   a 'cloud' construction is GUARANTEED to fail init. Without this the case
 *   only fails on a machine that happens to lack Dataplane config — i.e. the
 *   failed-init assertion would quietly stop testing failed init on a
 *   fully-configured developer box.
 */
function runChild(mode: 'embedded' | 'local' | 'cloud', owns: boolean, stripCloudConfig = false): {
    survived: boolean; threw: boolean;
} {
    const args = [SELF, '--child', '--mode', mode, ...(owns ? ['--owns'] : [])];
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    if (stripCloudConfig) {
        for (const k of Object.keys(childEnv)) {
            if (k.startsWith('DATAPLANE_') || k.startsWith('LORE_CLOUD_')) delete childEnv[k];
        }
    }
    const res = spawnSync(TSX_BIN, args, {
        cwd: REPO_ROOT,
        // A clean-ish env: the child plants its own HOST_VAR. Inheriting is fine
        // and realistic (a host process has a populated env).
        env: childEnv,
        encoding: 'utf-8',
        // Model load + the legacy graph engine/LanceDB init dominate; generous so a cold first run
        // (model download) cannot flake the security assertion.
        timeout: 300_000,
    });
    const line = (res.stdout ?? '').split('\n').find((l) => l.startsWith('__SP17__'));
    assert.ok(
        line,
        `child (mode=${mode} owns=${owns}) produced no result line. ` +
        `status=${res.status} signal=${res.signal}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
    );
    return {
        survived: /survived=true/.test(line),
        threw: /threw=true/.test(line),
    };
}

console.log('SP-17 / S9-EMBEDDED-ENV-SCRUB — env scrub ordering + process ownership');

/* ───────────────────────── A. OWNERSHIP (behavioral) ───────────────────────── */

console.log('\n── A. ownership gate: only a process Lore OWNS may be scrubbed ──');

// The reported bug, verbatim: a host embeds Lore and reads its own key lazily.
test('(A1) library path, embedded — HOST env survives createLore()', () => {
    const r = runChild('embedded', false);
    assert.equal(
        r.survived, true,
        'embedded createLore() deleted the HOST process\'s own env var — the reported defect',
    );
});

// Mode-blindness regression. The scrub runs BEFORE the mode is resolved, so
// "only fix embedded" would have left these two doors open — a host can embed
// in-process with any deploymentMode.
test('(A2) library path, local — HOST env survives (scrub is mode-blind)', () => {
    const r = runChild('local', false);
    assert.equal(
        r.survived, true,
        'in-process host with deploymentMode:local lost its env — gating on mode instead of ownership',
    );
});

test('(A3) library path, cloud — HOST env survives even when init THROWS', () => {
    // Cloud config is stripped from the child so init is GUARANTEED to fail —
    // this case exists to cover the failed-init half of the report ("a
    // non-functioning Lore still destroyed the host's environment"), and an
    // assertion that only holds on an unconfigured machine is not coverage.
    const r = runChild('cloud', false, true);
    assert.equal(
        r.threw, true,
        'expected cloud construction to FAIL with the adapter config stripped. It succeeded, so ' +
        'this case is no longer exercising the failed-init path — point it at a construction that ' +
        'does fail, or the "even when init THROWS" guarantee is untested',
    );
    assert.equal(
        r.survived, true,
        'in-process host with deploymentMode:cloud lost its env. A non-functioning Lore ' +
        'must not destroy the host environment on its way out',
    );
});

// The other half of the contract: the daemon MUST still be scrubbed. Without
// this, "fixing" the bug by deleting the scrub would pass A1-A3.
test('(A4) daemon path (ownsProcess:true) — env IS still scrubbed', () => {
    const r = runChild('local', true);
    assert.equal(
        r.survived, false,
        'ownsProcess:true must still scrub — the daemon inherits an IDE\'s full env ' +
        '(AWS/GitHub tokens) and S9 exists to drop it',
    );
});

/* ───────────────────── B. SCRUB MECHANICS (behavioral) ────────────────────── */

console.log('\n── B. scrub mechanics: allowlist completeness ──');

/** Extract every PROCESS-env var name read in a source file. */
function envVarsRead(rel: string): Set<string> {
    const src = read(rel);
    const out = new Set<string>();
    for (const m of src.matchAll(/process\.env\[?['"]?([A-Z][A-Z0-9_]{2,})['"]?\]?/g)) {
        out.add(m[1]);
    }
    for (const m of src.matchAll(/process\.env\.([A-Z][A-Z0-9_]{2,})/g)) {
        out.add(m[1]);
    }
    return out;
}

test('every env var the construction factories read survives scrubEnv()', () => {
    // services.ts holds createGraph / createVectorStore / createEmbeddingProvider
    // / resolveSyncAdapterFromEnv. pickEmbeddingProvider.ts is on that path
    // (LORE_OPENAI_API_KEY). All are invoked inside createLore(), AFTER the
    // scrub — so anything they read must be allowlisted or it is silently lost.
    const needed = new Set<string>([
        ...envVarsRead('packages/lore/src/mcp/services.ts'),
        ...envVarsRead('packages/lore/src/providers/pickEmbeddingProvider.ts'),
    ]);
    // Bare-name external fallbacks (OPENAI_API_KEY, OLLAMA_HOST) are
    // deliberately NOT allowlisted: each has a supported, allowlisted
    // LORE_-prefixed canonical name, and the bare name is only a courtesy
    // fallback the scrub is allowed to drop. (Ollama is not a supported
    // embedding backend per the locked embedding-strategy decision.)
    for (const bare of ['OPENAI_API_KEY', 'OLLAMA_HOST']) needed.delete(bare);

    const before: Record<string, string | undefined> = {};
    for (const v of needed) { before[v] = process.env[v]; process.env[v] = `__sp17_probe_${v}`; }
    try {
        scrubEnv();
        const dropped = [...needed].filter((v) => process.env[v] === undefined);
        assert.deepEqual(
            dropped, [],
            `scrubEnv() dropped construction-path vars the daemon needs: ${dropped.join(', ')}. Add them to envScrub ALLOWED_VARS.`,
        );
    } finally {
        for (const v of needed) {
            if (before[v] === undefined) delete process.env[v];
            else process.env[v] = before[v]!;
        }
    }
});

test('a planted non-allowlisted secret IS scrubbed (scrub still does its job)', () => {
    const SECRET = 'SP17_FAKE_AWS_SECRET_ACCESS_KEY';
    const prev = process.env[SECRET];
    process.env[SECRET] = 'super-secret-value';
    try {
        scrubEnv();
        assert.equal(process.env[SECRET], undefined, 'non-allowlisted secret must be scrubbed');
    } finally {
        if (prev === undefined) delete process.env[SECRET];
        else process.env[SECRET] = prev;
    }
});

/* ─────────────────────────── C. ORDERING (static) ─────────────────────────── */

console.log('\n── C. ordering: the gate itself must not read env ──');

const server = read('packages/lore/src/mcp/server.ts');
const ownership = read('packages/lore/src/mcp/processOwnership.ts');

// This is the one SP-17 property that cannot be asserted at runtime: the scrub
// must stay ahead of every env read, so its GATE has to be decidable without
// reading env. `opts.ownsProcess` is caller-supplied and satisfies that;
// resolving the deployment mode first would NOT, and would silently reintroduce
// the original SP-17 defect (construction reads seeing an unscrubbed env).
test('(C1) the scrub gate reads NO env and no resolved mode', () => {
    const m = ownership.match(
        /export function scrubEnvIfOwned\([^)]*\)[^{]*\{([\s\S]*?)\n\}/,
    );
    assert.ok(m, 'scrubEnvIfOwned() not found in processOwnership.ts');
    const body = m[1];
    assert.match(
        body, /ownsProcess\s*!==\s*true/,
        `the scrub must be gated on the caller-supplied ownsProcess flag (body: "${body.trim()}")`,
    );
    assert.doesNotMatch(
        body, /process\.env|resolveDeploymentMode|deploymentMode/,
        `the scrub gate must not depend on env or resolved mode — either would move an env ` +
        `read BEFORE the scrub and reintroduce SP-17 (body: "${body.trim()}")`,
    );
});

test('(C1b) createLore() passes the caller-supplied flag straight through', () => {
    assert.match(
        server, /scrubEnvIfOwned\(opts\.ownsProcess\)/,
        'createLore() must gate the scrub on opts.ownsProcess directly — deriving the value ' +
        'from anything else risks reading env before the scrub',
    );
});

test('(C2) the scrub precedes every construction-path env read in createLore()', () => {
    // Match the CALL, not the import line (which necessarily sits above
    // everything and would make this assertion trivially true).
    const scrubIdx = server.indexOf('scrubEnvIfOwned(opts.ownsProcess)');
    assert.ok(scrubIdx >= 0, 'scrubEnvIfOwned(opts.ownsProcess) call site not found');
    for (const marker of [
        'resolveWorkspaceScope(', 'resolveDeploymentMode(', 'createGraph(',
        'createVectorStore(', 'resolveSyncAdapterFromEnv(', 'createEmbeddingProvider(',
    ]) {
        const idx = server.indexOf(marker);
        if (idx < 0) continue;
        assert.ok(scrubIdx < idx, `runEnvScrub() must run before the construction read "${marker}"`);
    }
});

/**
 * Strip comments so a static assertion cannot be satisfied by prose.
 *
 * Not a parser — it does not understand `//` inside a string literal — but the
 * slice it is used on is the opening of main(), which contains none. Enough to
 * close the specific false-pass this guards.
 */
function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

// NOTE ON SCOPE: this asserts main() CONTAINS the ownership claim; it does not
// boot the daemon, so it cannot prove main() actually runs. A4 covers the other
// half (the flag really does scrub). A behavioral daemon-boot case was
// considered and deliberately not added: it would spawn a real Lore daemon on
// this machine, which the operator's standing rule forbids. If that rule ever
// relaxes, spawn dist/lore/src/mcp/server.js as argv[1] with a scratch
// LORE_HOME and assert the "Env scrub: dropped N var(s)" line on stderr.
test('(C3) the daemon entry main() claims process ownership', () => {
    const mainIdx = server.indexOf('async function main(');
    assert.ok(mainIdx >= 0, 'main() not found');
    // Comments are stripped FIRST: the rationale comment sitting above this very
    // call site mentions ownsProcess, and a stale comment must never be able to
    // satisfy the assertion after the real argument has been removed — that
    // would let the daemon silently lose the scrub with this test still green.
    const mainBody = stripComments(server.slice(mainIdx, mainIdx + 1500));
    assert.match(
        mainBody, /createLore\(\{[^}]*ownsProcess:\s*true/s,
        'main() must call createLore({ ownsProcess: true }) — otherwise the daemon silently ' +
        'loses the S9 parent-env scrub and the native-pool safety net',
    );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
