#!/usr/bin/env tsx
/**
 * sp16-docs-freshness-unit.ts — SP-16 regression.
 *
 * Several docs misdescribed the repo after the v3.11.0 plugin-system removal and
 * the monorepo move. This static-probe suite is the regression sentinel that keeps
 * the docs in sync with the code:
 *
 *   1. The four plugin author/contract docs are archived under docs/archive/ with a
 *      deprecation banner (not present at the live docs/ paths).
 *   2. docs/IStorageAdapter.md names LoreStorageClient as the runtime swap point and
 *      no longer claims the runtime works directly against IStorageAdapter.
 *   3. FROZEN.md freeze entries resolve to real files (no dangling `src/...` paths for
 *      Core source that moved to `packages/lore/src/...`).
 *   4. docs/architecture.md no longer references the removed `packages/lore-plugin-developer/`.
 *   5. BUILD_ORDER.md carries a banner flagging the plugin/step state as superseded.
 *   6. No live (non-archived) doc links to the four moved plugin docs at their old paths.
 *
 * These assertions fail on the pre-SP-16 tree and pass after the docs refresh, so the
 * stale plugin/path claims cannot silently creep back into the live docs.
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

const exists = (rel: string) => fs.existsSync(path.join(repoRoot, rel));
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf-8');

const MOVED_PLUGIN_DOCS = [
    'PLUGIN_AUTHOR_GUIDE.md',
    'ILorePlugin.md',
    'PLUGIN_VS_WORKSPACE.md',
    'plugin-manifest-spec.md',
];

(async () => {
    console.log('SP-16 — stale docs refreshed');

    // (1) Plugin docs archived with a deprecation banner; gone from live docs/.
    for (const name of MOVED_PLUGIN_DOCS) {
        await test(`docs/${name} moved to docs/archive/ with ARCHIVED banner`, () => {
            assert.equal(exists(`docs/${name}`), false, `docs/${name} still at live path`);
            assert.equal(exists(`docs/archive/${name}`), true, `docs/archive/${name} missing`);
            const txt = read(`docs/archive/${name}`);
            assert.match(txt, /ARCHIVED/i, `docs/archive/${name} missing ARCHIVED banner`);
            assert.match(txt, /v3\.11\.0/, `docs/archive/${name} banner does not cite v3.11.0`);
        });
    }

    // (2) IStorageAdapter.md names the real runtime swap point.
    await test('docs/IStorageAdapter.md names LoreStorageClient as the runtime swap point', () => {
        const txt = read('docs/IStorageAdapter.md');
        assert.match(txt, /LoreStorageClient/, 'LoreStorageClient not mentioned');
        assert.match(txt, /loreStorageClient\.ts/, 'facade source path not cited');
        assert.match(txt, /services\.ts/, 'services.ts wiring not cited');
        // Must no longer assert the old, wrong claim verbatim.
        assert.equal(
            /Lore Core works against this contract; it never imports adapter-specific code\./.test(txt),
            false,
            'old incorrect runtime claim still present',
        );
        // Must not reference the removed plugins storage path.
        assert.equal(
            /packages\/lore\/src\/plugins\/storage\.ts/.test(txt),
            false,
            'still references removed packages/lore/src/plugins/storage.ts',
        );
    });

    // (3) FROZEN.md freeze entries resolve to real files.
    await test('FROZEN.md has no dangling bare src/ paths (Core moved to packages/lore/src/)', () => {
        const txt = read('FROZEN.md');
        // Bullet entries beginning "- src/..." are the stale form; none should remain.
        const bareSrc = txt.split('\n').filter((l) => /^-\s+src\//.test(l.trim()));
        assert.deepEqual(bareSrc, [], `stale bare src/ entries remain:\n${bareSrc.join('\n')}`);
    });

    await test('FROZEN.md packages/lore/src/... freeze paths all resolve', () => {
        const txt = read('FROZEN.md');
        const refs = [...txt.matchAll(/(packages\/lore\/src\/[\w./-]+\.ts)/g)].map((m) => m[1]);
        assert.ok(refs.length > 0, 'expected at least one packages/lore/src path in FROZEN.md');
        const missing = refs.filter((r) => !exists(r));
        assert.deepEqual(missing, [], `FROZEN.md references non-existent files: ${missing.join(', ')}`);
    });

    // (4) architecture.md dropped the removed plugin package reference.
    await test('docs/architecture.md no longer references packages/lore-plugin-developer/', () => {
        const txt = read('docs/architecture.md');
        assert.equal(
            /packages\/lore-plugin-developer/.test(txt),
            false,
            'packages/lore-plugin-developer still referenced',
        );
    });

    // (5) BUILD_ORDER.md carries the superseded-state banner.
    await test('BUILD_ORDER.md carries a v3.11.0 superseded-state banner', () => {
        const txt = read('BUILD_ORDER.md');
        assert.match(txt, /STATUS BANNER/i, 'no status banner');
        assert.match(txt, /v3\.11\.0/, 'banner does not cite v3.11.0');
        assert.match(txt, /HANDOFF\.md/, 'banner does not point to HANDOFF.md');
    });

    // (6) No live doc links to the moved plugin docs at their old paths.
    await test('no live (non-archived) doc links to the moved plugin docs', () => {
        const offenders: string[] = [];
        const docsDir = path.join(repoRoot, 'docs');
        const walk = (dir: string) => {
            for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, ent.name);
                const rel = path.relative(repoRoot, p);
                if (ent.isDirectory()) {
                    if (rel === 'docs/archive') continue; // archived docs may cross-link freely
                    walk(p);
                    continue;
                }
                if (!p.endsWith('.md')) continue;
                const txt = fs.readFileSync(p, 'utf-8');
                for (const name of MOVED_PLUGIN_DOCS) {
                    // A markdown link to ./NAME.md or ../docs/NAME.md (NOT archive/NAME.md).
                    const linkRe = new RegExp(`\\]\\((?:\\.\\.?/)?(?:docs/)?${name.replace('.', '\\.')}\\)`);
                    if (linkRe.test(txt)) offenders.push(`${rel} -> ${name}`);
                }
            }
        };
        walk(docsDir);
        assert.deepEqual(offenders, [], `live docs link to moved plugin docs:\n${offenders.join('\n')}`);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
})();
