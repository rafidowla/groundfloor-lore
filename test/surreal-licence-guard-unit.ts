#!/usr/bin/env tsx
/**
 * surreal-licence-guard-unit.ts — the BSL 1.1 boundary is enforced by CODE,
 * and the enforcement actually fires (Phase 1 hard constraint: "a code-level
 * guard, not prose, enforcing the licence boundary… a comment is not").
 *
 * SurrealDB core is BSL 1.1: embedding it in a product is permitted, offering
 * SurrealDB itself as a hosted service is not. Local and embedded modes are on
 * the permitted side; a multi-tenant cloud Dataplane is not.
 *
 * Two independent guards, because neither covers the other's blind spot:
 *   - RUNTIME: `assertSurrealLicenceBoundary`, called by
 *     `LoreStorageClient.fromSurreal`. Catches an operator flipping
 *     LORE_DEPLOYMENT_MODE on a build that already has the engine compiled in.
 *     A static rule cannot see that.
 *   - STATIC: rule D-022 in scripts/test-arch.mjs. Catches a cloud code path
 *     being wired up at all. A runtime throw cannot see an import that has not
 *     run yet.
 *
 * The static half is proved by DELIBERATELY INTRODUCING a violation and
 * asserting the arch test goes red — a guard that has never been observed
 * failing is indistinguishable from one that does nothing.
 *
 * Run: npx tsx test/surreal-licence-guard-unit.ts
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LoreStorageClient, type LoreGraphHandle, type LoreVectorHandle } from '../packages/lore/src/storage/loreStorageClient.js';
import {
    SurrealLicenceBoundaryError,
    assertSurrealLicenceBoundary,
} from '../packages/lore/src/storage/surrealLicenceGuard.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARCH_SCRIPT = path.join(REPO_ROOT, 'scripts', 'test-arch.mjs');

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

/** Run the arch script; return its exit code and combined output. */
function runArch(): { code: number; output: string } {
    try {
        const output = execFileSync(process.execPath, [ARCH_SCRIPT], {
            cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { code: 0, output };
    } catch (err) {
        const e = err as { status?: number; stdout?: string; stderr?: string };
        return { code: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
}

/** Write a file, run the arch test, always remove the file. */
function withTempSource(relPath: string, contents: string, fn: () => void): void {
    const abs = path.join(REPO_ROOT, relPath);
    assert.ok(!fs.existsSync(abs), `${relPath} must not already exist — refusing to clobber a real file`);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
    try {
        fn();
    } finally {
        fs.rmSync(abs, { force: true });
    }
}

/** Minimal stand-ins; the factory only stores the handles it is given. */
const graphStub = {} as LoreGraphHandle;
const vectorStub = {} as LoreVectorHandle;

console.log('SurrealDB — BSL 1.1 licence boundary');

/* ─── runtime guard ──────────────────────────────────────────────── */

await test('the guard permits local, embedded, and an unset mode', () => {
    for (const mode of ['local', 'embedded', 'LOCAL', ' Embedded ', undefined]) {
        assert.doesNotThrow(() => assertSurrealLicenceBoundary(mode),
            `mode ${String(mode)} is on the licensed side and must be allowed`);
    }
});

await test('the guard REFUSES cloud and arcade (both hosted, both other people\'s data)', () => {
    for (const mode of ['cloud', 'CLOUD', ' arcade ', 'Arcade']) {
        assert.throws(
            () => assertSurrealLicenceBoundary(mode),
            SurrealLicenceBoundaryError,
            `mode ${mode} must be refused`,
        );
    }
});

await test('the refusal explains the licence, not just "denied"', () => {
    try {
        assertSurrealLicenceBoundary('cloud');
        assert.fail('expected a throw');
    } catch (err) {
        const message = (err as Error).message;
        assert.match(message, /BSL 1\.1/);
        assert.match(message, /hosted service/);
        assert.match(message, /commercial licence/);
        assert.equal((err as SurrealLicenceBoundaryError).code, 'surreal_licence_boundary');
    }
});

await test('fromSurreal builds a facade in local mode', () => {
    const client = LoreStorageClient.fromSurreal({ graph: graphStub, verbatim: vectorStub, deploymentMode: 'local' });
    // A SurrealDB-backed workspace is LOCAL mode with a different substrate —
    // not a fourth mode. getMode() must not start reporting one.
    assert.equal(client.getMode(), 'local');
});

await test('fromSurreal THROWS in cloud mode — the chokepoint is wired, not decorative', () => {
    assert.throws(
        () => LoreStorageClient.fromSurreal({ graph: graphStub, verbatim: vectorStub, deploymentMode: 'cloud' }),
        SurrealLicenceBoundaryError,
    );
    assert.throws(
        () => LoreStorageClient.fromSurreal({ graph: graphStub, verbatim: vectorStub, deploymentMode: 'arcade' }),
        SurrealLicenceBoundaryError,
    );
});

await test('fromSurreal reads LORE_DEPLOYMENT_MODE when no mode is passed', () => {
    // A guard that can be bypassed by simply not passing config is not a guard.
    const previous = process.env['LORE_DEPLOYMENT_MODE'];
    try {
        process.env['LORE_DEPLOYMENT_MODE'] = 'cloud';
        assert.throws(
            () => LoreStorageClient.fromSurreal({ graph: graphStub, verbatim: vectorStub }),
            SurrealLicenceBoundaryError,
        );
        process.env['LORE_DEPLOYMENT_MODE'] = 'local';
        assert.doesNotThrow(() => LoreStorageClient.fromSurreal({ graph: graphStub, verbatim: vectorStub }));
    } finally {
        if (previous === undefined) delete process.env['LORE_DEPLOYMENT_MODE'];
        else process.env['LORE_DEPLOYMENT_MODE'] = previous;
    }
});

/* ─── static guard (D-022) ───────────────────────────────────────── */

await test('the arch test passes on the current tree', () => {
    const { code, output } = runArch();
    assert.equal(code, 0, `arch test should be green on main:\n${output}`);
    assert.match(output, /SurrealDB engine unreachable from cloud-mode code/,
        'the D-022 rule must actually be part of the run, not just defined');
});

await test('D-022 FAILS when a cloud-mode module imports the engine', () => {
    withTempSource(
        'packages/lore/src/engines/dataplaneSurrealProbe.ts',
        "import { SurrealGraph } from './surrealGraph.js';\nexport const probe = SurrealGraph;\n",
        () => {
            const { code, output } = runArch();
            assert.equal(code, 1, 'a cloud-mode module importing the engine must fail the build');
            assert.match(output, /surreal-local-only/);
            assert.match(output, /dataplaneSurrealProbe\.ts/);
        },
    );
});

await test('D-022 FAILS when the engine imports the cloud SDK', () => {
    withTempSource(
        'packages/lore/src/engines/surreal/surrealCloudProbe.ts',
        "import type { GroundfloorClient } from 'groundfloor-ts-sdk';\nexport type Probe = GroundfloorClient;\n",
        () => {
            const { code, output } = runArch();
            assert.equal(code, 1, 'the engine reaching for a cloud transport must fail the build');
            assert.match(output, /surreal-local-only/);
            assert.match(output, /imports groundfloor-ts-sdk/);
        },
    );
});

await test('D-022 FAILS when fromSurreal is called outside the permitted paths', () => {
    withTempSource(
        'packages/lore/src/engines/surrealFactoryProbe.ts',
        'export function probe(client: { fromSurreal: (o: unknown) => unknown }): unknown {\n'
        + '    return client.fromSurreal({});\n}\n',
        () => {
            const { code, output } = runArch();
            assert.equal(code, 1, 'constructing the store outside the chokepoint must fail the build');
            assert.match(output, /calls LoreStorageClient\.fromSurreal/);
        },
    );
});

await test('the arch tree is clean again after every probe is removed', () => {
    const { code } = runArch();
    assert.equal(code, 0, 'the probes must leave no residue');
});

/* ─── the two halves cannot be silently decoupled ────────────────── */

await test('D-022 fails if fromSurreal stops calling the runtime guard', () => {
    // The static rule reads the facade and asserts the call is present. Without
    // this, deleting the runtime throw would leave a green build and a guard
    // that does nothing.
    const facade = fs.readFileSync(path.join(REPO_ROOT, 'packages/lore/src/storage/loreStorageClient.ts'), 'utf8');
    assert.match(facade, /static\s+fromSurreal\s*\(/);
    assert.match(facade, /assertSurrealLicenceBoundary\s*\(/);
    const archSource = fs.readFileSync(ARCH_SCRIPT, 'utf8');
    assert.match(archSource, /fromSurreal does not call assertSurrealLicenceBoundary/,
        'the arch rule must check the wiring, not merely the imports');
});

/* ─── D-023 — graph-stored ReBAC has no production consumers ─────── */
//
// D-022 has had fails-when-violated coverage since it was written. D-023 did
// not: it was proven to fire once, by hand, when it was added in the Phase 3
// amendment, and nothing has re-checked it since. That is the exact hole the
// amendment itself warned about — "a rule that passes because it matches
// nothing is not a rule" — left open in the rule that warning produced. These
// use the same withTempSource + runArch harness as the D-022 cases above.

await test('D-023 FAILS when a src file imports security/rebac.js', () => {
    withTempSource(
        'packages/lore/src/mcp/rebacConsumerProbe.ts',
        "import { RebacStore } from '../security/rebac.js';\nexport const probe = RebacStore;\n",
        () => {
            const { code, output } = runArch();
            assert.equal(code, 1, 'wiring graph-stored ReBAC to production code must fail the build');
            assert.match(output, /rebac-no-production-consumers/);
            assert.match(output, /rebacConsumerProbe\.ts/);
            assert.match(output, /DEC-SURREAL-REBAC/, 'and must send the author to the decision');
            assert.match(output, /SPEED BUMP, NOT A WALL/, 'phrased as a checkpoint, not a prohibition');
        },
    );
});

await test('D-023 FAILS when a src file imports security/rebacEvaluator.js', () => {
    withTempSource(
        'packages/lore/src/mcp/rebacEvalProbe.ts',
        "import { evaluate } from '../security/rebacEvaluator.js';\nexport const probe = evaluate;\n",
        () => {
            const { code, output } = runArch();
            assert.equal(code, 1);
            assert.match(output, /rebac-no-production-consumers/);
            assert.match(output, /imports security\/rebacEvaluator\.js/);
        },
    );
});

await test('D-023 does NOT fire on security/rebacGate.js — a different module entirely', () => {
    // rebacGate is the SpiceDB-via-Dataplane path with no graph dependency.
    // A rule that swept it up would block legitimate cloud authz work and would
    // get disabled rather than obeyed.
    withTempSource(
        'packages/lore/src/mcp/rebacGateProbe.ts',
        "import * as gate from '../security/rebacGate.js';\nexport const probe = gate;\n",
        () => {
            const { code, output } = runArch();
            assert.equal(code, 0, `rebacGate must stay out of scope; arch said:\n${output}`);
        },
    );
});

await test('D-023 does NOT fire on the one allowed edge (rebacEvaluator → rebac)', () => {
    // The real repo already contains that import. If the allowlist regressed,
    // the arch run would be red for every developer on every commit — so this
    // asserts the baseline repo is clean, which is the cheapest possible canary.
    const { code } = runArch();
    assert.equal(code, 0, 'the unmodified repo must pass D-023');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
