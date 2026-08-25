#!/usr/bin/env tsx
/**
 * sp10-domain-cli-removed-unit.ts — SP-10 regression.
 *
 * Lore Core is a schema-agnostic database. Two CLI verbs carried domain logic
 * and were removed (audit = MDM/CRE schema-drift business rules; migrate
 * l5b-data = a one-off that branded orphan rows under the client product name
 * "atlas"), along with scripts/seed-mdm-run.js (a CRE real-estate seeder).
 *
 * These assertions fail on the pre-SP-10 tree and pass after the deletions, so
 * the domain commands cannot silently creep back into Core.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const cliDir = path.join(repoRoot, 'packages/lore/src/cli');
const commandsDir = path.join(cliDir, 'commands');

let passed = 0, failed = 0;
const test = async (name: string, fn: () => void | Promise<void>) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf-8');

(async () => {
    console.log('SP-10 — domain-specific CLI commands removed from Core');

    await test('audit.ts deleted', () => {
        assert.equal(fs.existsSync(path.join(commandsDir, 'audit.ts')), false);
    });

    await test('migrateL5bData.ts deleted', () => {
        assert.equal(fs.existsSync(path.join(commandsDir, 'migrateL5bData.ts')), false);
    });

    await test('scripts/seed-mdm-run.js deleted', () => {
        assert.equal(fs.existsSync(path.join(repoRoot, 'scripts/seed-mdm-run.js')), false);
    });

    await test('commands/index.ts no longer exports auditCommand', () => {
        assert.equal(/auditCommand/.test(read('packages/lore/src/cli/commands/index.ts')), false);
    });

    await test('cli/index.ts has no audit verb (no case, import, or help line)', () => {
        const src = read('packages/lore/src/cli/index.ts');
        assert.equal(/auditCommand/.test(src), false, 'auditCommand still imported/called');
        assert.equal(/case 'audit'/.test(src), false, "case 'audit' still present");
        assert.equal(/Master Data Model/.test(src), false, 'MDM help text still present');
    });

    await test('migrate.ts no longer wires l5b-data subcommand', () => {
        const src = read('packages/lore/src/cli/commands/migrate.ts');
        assert.equal(/migrateL5bData/.test(src), false, 'migrateL5bData still imported/called');
        assert.equal(/l5b-data/.test(src), false, 'l5b-data dispatch/help still present');
    });

    await test('no client-product brand name in CLI source', () => {
        // The migration finding: Core must not bake the downstream client
        // product name into its CLI surface.
        const offenders: string[] = [];
        const walk = (dir: string) => {
            for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, ent.name);
                if (ent.isDirectory()) { walk(p); continue; }
                if (!p.endsWith('.ts')) continue;
                const txt = fs.readFileSync(p, 'utf-8');
                if (/['"`]atlas['"`]/i.test(txt)) offenders.push(path.relative(repoRoot, p));
            }
        };
        walk(cliDir);
        assert.deepEqual(offenders, [], `CLI files still reference 'atlas': ${offenders.join(', ')}`);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
})();
