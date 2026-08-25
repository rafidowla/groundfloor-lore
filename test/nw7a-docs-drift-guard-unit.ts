#!/usr/bin/env tsx
/**
 * nw7a-docs-drift-guard-unit.ts — NW-7a outcome pin.
 *
 * Audit findings addressed: docs-cli-ghost-commands, docs-readme-tool-count-stale,
 * docs-readme-tree-sitter-credit-stale.
 *
 * Prior to this fix:
 *   - docs/architecture.md and CLI help referenced `lore explore`, `lore analyze`,
 *     `lore team`, and `plugins` — commands that don't exist in cli/index.ts.
 *   - README.md ASCII diagram had `(9 tools)` next to "MCP Server" while the MCP
 *     server registers ~78 tools. A stale count is worse than no count.
 *   - README.md Credits table listed tree-sitter, which has been unused since the
 *     v3.11.0 plugin-system removal (not in package.json).
 *
 * These tests fail on the pre-NW-7a tree and pass after the fixes, so drift
 * cannot silently creep back.
 *
 * Run: npx tsx test/nw7a-docs-drift-guard-unit.ts
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

let passed = 0, failed = 0;
const test = async (name: string, fn: () => void | Promise<void>) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf-8');

(async () => {
    console.log('NW-7a — docs drift guard');

    // ── Ghost CLI commands ────────────────────────────────────────────────────

    await test('docs/architecture.md does not reference `lore explore` (no CLI for it)', () => {
        const txt = read('docs/architecture.md');
        assert.equal(
            /`lore explore`/.test(txt),
            false,
            '`lore explore` is a ghost command that does not exist in cli/index.ts',
        );
    });

    await test('docs/architecture.md does not reference `lore analyze` (no CLI for it)', () => {
        const txt = read('docs/architecture.md');
        assert.equal(
            /`lore analyze`/.test(txt),
            false,
            '`lore analyze` is a ghost command that does not exist in cli/index.ts',
        );
    });

    await test('docs/architecture.md does not reference `lore team` (no CLI for it)', () => {
        const txt = read('docs/architecture.md');
        assert.equal(
            /`lore team`/.test(txt),
            false,
            '`lore team` is a ghost command that does not exist in cli/index.ts',
        );
    });

    await test('CLI help (packages/lore/src/cli/index.ts) does not advertise `plugins` command', () => {
        const txt = read('packages/lore/src/cli/index.ts');
        // The CORE_HELP constant must not list `plugins` as a command entry.
        // The pattern below matches the word "plugins" appearing as a CLI
        // subcommand line in the help block (indented, followed by description).
        const pluginsCommandLine = /^\s+plugins\s+/m;
        assert.equal(
            pluginsCommandLine.test(txt),
            false,
            '`plugins` is advertised in CLI help but has no handler in the command switch',
        );
    });

    // ── README tool-count parenthetical ──────────────────────────────────────

    await test('README.md ASCII diagram does not contain a stale `(N tools)` count', () => {
        const txt = read('README.md');
        // Matches any "(<number> tools)" variant in the ASCII diagram section.
        // A stale hardcoded count is misleading; removing it is the accepted fix.
        const staleCount = /\(\d+\s+tools\)/;
        assert.equal(
            staleCount.test(txt),
            false,
            'README.md still has a hardcoded tool count "(N tools)" that can drift from reality',
        );
    });

    // ── tree-sitter credit ────────────────────────────────────────────────────

    await test('README.md Credits table does not list tree-sitter (removed since v3.11.0)', () => {
        const txt = read('README.md');
        assert.equal(
            /tree-sitter/.test(txt),
            false,
            'README.md Credits still lists tree-sitter, which is unused since v3.11.0 plugin removal',
        );
    });

    await test('package.json does not depend on tree-sitter', () => {
        const pkg = JSON.parse(read('package.json')) as Record<string, unknown>;
        const deps = {
            ...(pkg['dependencies'] as Record<string, string> ?? {}),
            ...(pkg['devDependencies'] as Record<string, string> ?? {}),
            ...(pkg['optionalDependencies'] as Record<string, string> ?? {}),
        };
        const found = Object.keys(deps).filter((k) => k.includes('tree-sitter'));
        assert.deepEqual(
            found,
            [],
            `package.json has tree-sitter deps: ${found.join(', ')}`,
        );
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
})();
