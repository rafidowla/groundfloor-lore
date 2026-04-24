#!/usr/bin/env tsx
/**
 * scaffold-plugin.test.ts — Integration test for `lore scaffold-plugin`.
 *
 * Q1.4 acceptance (per docs/post_v2_plan.md):
 *   "New plugin template can be scaffolded with `npx lore
 *    scaffold-plugin <name>` and has a working IR on first boot."
 *
 * The test runs the scaffolder end-to-end against a real monorepo
 * checkout (this one), verifies the generated files, typechecks the
 * new plugin against the current core, and cleans up.
 *
 * This is a destructive filesystem test — if it fails mid-run it may
 * leave `packages/lore-plugin-scaffold-test/` and tsconfig.json
 * modifications behind. The cleanup block restores both.
 *
 * Usage:
 *   npx tsx test/scaffold-plugin.test.ts
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const pluginName = 'scaffold-test';
const pluginDir = path.join(repoRoot, 'packages', `lore-plugin-${pluginName}`);
const tsconfigPath = path.join(repoRoot, 'tsconfig.json');

let failures = 0;
const assertions: string[] = [];

function ok(msg: string): void {
    assertions.push(`  ✓ ${msg}`);
}
function fail(msg: string): void {
    failures++;
    assertions.push(`  ✗ ${msg}`);
}

function assertTrue(cond: boolean, msg: string): void {
    if (cond) ok(msg);
    else fail(msg);
}

function readText(p: string): string {
    return fs.readFileSync(p, 'utf-8');
}

/* ─── Snapshot tsconfig for restore ─────────────────────────── */
const tsconfigBefore = readText(tsconfigPath);

/* ─── Guardrail: refuse to run if target dir exists ─────────── */
if (fs.existsSync(pluginDir)) {
    console.error(`Refusing to run — ${pluginDir} already exists. Delete it first.`);
    process.exit(2);
}

let scaffoldOk = false;
try {
    /* ─── 1. Invoke the scaffolder ──────────────────────────── */
    console.log(`[scaffold-plugin.test] Invoking: lore scaffold-plugin ${pluginName}`);
    const run = spawnSync('npx', ['tsx', 'packages/lore/src/cli/index.ts', 'scaffold-plugin', pluginName], {
        cwd: repoRoot,
        encoding: 'utf-8',
    });

    assertTrue(run.status === 0, `scaffolder exits 0 (got ${run.status})`);
    if (run.status !== 0) {
        console.error('STDOUT:', run.stdout);
        console.error('STDERR:', run.stderr);
    }

    /* ─── 2. Verify generated files exist ──────────────────── */
    const indexTs = path.join(pluginDir, 'src', 'index.ts');
    const schemaTs = path.join(pluginDir, 'src', 'schema.ts');
    const toolsTs = path.join(pluginDir, 'src', 'tools.ts');
    const readme = path.join(pluginDir, 'README.md');

    assertTrue(fs.existsSync(indexTs), 'src/index.ts exists');
    assertTrue(fs.existsSync(schemaTs), 'src/schema.ts exists');
    assertTrue(fs.existsSync(toolsTs), 'src/tools.ts exists');
    assertTrue(fs.existsSync(readme), 'README.md exists');

    /* ─── 3. Verify IR descriptor is present in index.ts ───── */
    if (fs.existsSync(indexTs)) {
        const src = readText(indexTs);
        assertTrue(/\bir:\s*\{/.test(src), 'index.ts declares an `ir` descriptor');
        assertTrue(/ownedNodeTables:\s*\[/.test(src), 'ir.ownedNodeTables declared');
        assertTrue(/ownedEdgeTables:\s*\[/.test(src), 'ir.ownedEdgeTables declared');
        assertTrue(/nodeKinds:\s*\[/.test(src), 'ir.nodeKinds declared');
        assertTrue(/edgeKinds:\s*\[/.test(src), 'ir.edgeKinds declared');
        assertTrue(/version:\s*'[0-9]+\.[0-9]+\.[0-9]+'/.test(src), 'ir.version is semver string');
        assertTrue(/async\s+registerSchema\s*\(/.test(src), 'registerSchema hook present');
    }

    /* ─── 4. Verify schema.ts has DDL matching IR ──────────── */
    if (fs.existsSync(schemaTs)) {
        const src = readText(schemaTs);
        assertTrue(/CREATE NODE TABLE IF NOT EXISTS/.test(src), 'schema.ts CREATE NODE TABLE DDL');
        assertTrue(/CREATE REL TABLE IF NOT EXISTS/.test(src), 'schema.ts CREATE REL TABLE DDL');
    }

    /* ─── 5. Verify tsconfig.json was patched ──────────────── */
    const tsconfigAfter = readText(tsconfigPath);
    assertTrue(
        tsconfigAfter.includes(`"@lore-plugin-${pluginName}/*"`),
        'tsconfig.json path alias added',
    );
    assertTrue(
        tsconfigAfter.includes(`packages/lore-plugin-${pluginName}/src/**/*`),
        'tsconfig.json include glob added',
    );

    /* ─── 6. Typecheck the whole repo incl. new plugin ─────── */
    console.log(`[scaffold-plugin.test] Typechecking with scaffolded plugin included...`);
    const tsc = spawnSync('npx', ['tsc', '--noEmit'], {
        cwd: repoRoot,
        encoding: 'utf-8',
    });
    assertTrue(tsc.status === 0, 'tsc --noEmit passes with scaffolded plugin on the include list');
    if (tsc.status !== 0) {
        console.error('TSC STDOUT:', tsc.stdout);
        console.error('TSC STDERR:', tsc.stderr);
    }

    /* ─── 7. Arch test still green ─────────────────────────── */
    console.log(`[scaffold-plugin.test] Running test:arch with scaffolded plugin...`);
    const arch = spawnSync('node', ['scripts/test-arch.mjs'], {
        cwd: repoRoot,
        encoding: 'utf-8',
    });
    assertTrue(arch.status === 0, 'npm run test:arch passes with scaffolded plugin present');
    if (arch.status !== 0) {
        console.error('ARCH STDOUT:', arch.stdout);
        console.error('ARCH STDERR:', arch.stderr);
    }

    scaffoldOk = true;
} finally {
    /* ─── Cleanup: remove plugin dir + restore tsconfig ─────── */
    if (fs.existsSync(pluginDir)) {
        fs.rmSync(pluginDir, { recursive: true, force: true });
    }
    fs.writeFileSync(tsconfigPath, tsconfigBefore);
    console.log(`[scaffold-plugin.test] Cleanup complete (removed plugin dir, restored tsconfig).`);
}

/* ─── Report ──────────────────────────────────────────────── */
console.log('');
console.log('Scaffold-plugin integration test');
for (const line of assertions) console.log(line);
console.log('');
if (failures > 0) {
    console.error(`FAIL — ${failures} assertion${failures === 1 ? '' : 's'} failed.`);
    process.exit(1);
}
console.log(`PASS — ${assertions.length} assertions, scaffolder ran ${scaffoldOk ? 'clean' : 'with issues'}.`);
process.exit(0);
