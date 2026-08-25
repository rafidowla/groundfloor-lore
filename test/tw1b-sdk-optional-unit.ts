#!/usr/bin/env tsx
/**
 * tw1b-sdk-optional-unit.ts — TW-1b regression.
 *
 * Owner-directed: `groundfloor-ts-sdk` must be an OPTIONAL, lazily-loaded,
 * CLOUD-ONLY dependency so the local/embedded product installs and runs
 * WITHOUT it. This suite locks that invariant in two ways:
 *
 *   (a) Source scan — NO TypeScript source file under packages/**\/src may
 *       statically VALUE-import the SDK. Only `import type ... from
 *       'groundfloor-ts-sdk'` (erased at compile time) or a dynamic
 *       `import('groundfloor-ts-sdk')` (cloud-gated, lazy) are permitted.
 *       A static value import (`import { GroundfloorClient } from
 *       'groundfloor-ts-sdk'`) forces the module to load even in local mode
 *       and re-breaks the local install — that is what we forbid.
 *
 *   (b) package.json — the SDK must be declared under `devDependencies`
 *       only, never under `dependencies` or `optionalDependencies`. Both of
 *       those are installed for every consumer of the published tarball;
 *       since the SDK is still an unpublished `file:../../v3/...` reference
 *       (TW-1b/SW-10, parked pending SDK registry release), shipping it in
 *       either of those manifests means `npm install` on any machine
 *       without that exact sibling path attempts to resolve a path that
 *       doesn't exist. `devDependencies` is never installed for consumers
 *       at all — it only satisfies this repo's own `tsc` build, which is
 *       where the type-only import actually needs it resolvable.
 *
 * These assertions fail on the pre-TW-1b tree (services.ts /
 * tsSdkAdapter.ts / dataplaneVectorStore.ts had value imports; the SDK sat
 * under dependencies) and pass after the fix.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const srcDir = path.join(repoRoot, 'packages/lore/src');

let passed = 0, failed = 0;
const test = async (name: string, fn: () => void | Promise<void>) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

/** Recursively collect every .ts file under a directory. */
function walkTs(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walkTs(full, out);
        else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
    }
    return out;
}

const SDK = 'groundfloor-ts-sdk';

(async () => {
    console.log('TW-1b — groundfloor-ts-sdk is optional / lazy / cloud-only');

    // ── (a) No static VALUE import of the SDK anywhere in source ──────
    await test('no source file statically value-imports groundfloor-ts-sdk', () => {
        const offenders: string[] = [];
        // Matches `import ... from 'groundfloor-ts-sdk'` that is NOT a
        // type-only import. `import type ...` is erased and allowed; a
        // dynamic `import('groundfloor-ts-sdk')` is a call expression (no
        // leading `from`) and is also allowed.
        const fromSdk = new RegExp(`from\\s+['"]${SDK}['"]`);
        const importTypeFromSdk = new RegExp(`import\\s+type\\b[^;]*from\\s+['"]${SDK}['"]`);
        for (const file of walkTs(srcDir)) {
            const src = fs.readFileSync(file, 'utf-8');
            for (const rawLine of src.split('\n')) {
                const line = rawLine.trim();
                if (!fromSdk.test(line)) continue;        // not an SDK import statement
                if (importTypeFromSdk.test(line)) continue; // `import type` — erased, fine
                offenders.push(`${path.relative(repoRoot, file)}: ${line}`);
            }
        }
        assert.equal(
            offenders.length, 0,
            `static value imports of '${SDK}' are forbidden (use 'import type' or dynamic import()):\n  ` +
                offenders.join('\n  '),
        );
    });

    // Belt-and-suspenders: the previously-known value-import sites must be
    // type-only now.
    await test('previously-offending files now use import type', () => {
        const formerlyValueImport = [
            'mcp/services.ts',
            'engines/tsSdkAdapter.ts',
            'engines/dataplaneVectorStore.ts',
        ];
        const importTypeFromSdk = new RegExp(`import\\s+type\\b[^;]*from\\s+['"]${SDK}['"]`);
        for (const rel of formerlyValueImport) {
            const src = fs.readFileSync(path.join(srcDir, rel), 'utf-8');
            assert.ok(
                importTypeFromSdk.test(src),
                `${rel} must keep a type-only import of '${SDK}'`,
            );
        }
    });

    // ── (b) package.json: SDK under devDependencies only ──────────────
    await test('package.json lists groundfloor-ts-sdk under devDependencies only', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8')) as {
            dependencies?: Record<string, string>;
            optionalDependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
        };
        assert.ok(
            pkg.devDependencies && pkg.devDependencies[SDK],
            `'${SDK}' must be declared under devDependencies`,
        );
        assert.ok(
            !(pkg.dependencies && pkg.dependencies[SDK]),
            `'${SDK}' must NOT be under dependencies (would fail consumer npm install when unresolvable)`,
        );
        assert.ok(
            !(pkg.optionalDependencies && pkg.optionalDependencies[SDK]),
            `'${SDK}' must NOT be under optionalDependencies — it is still an unpublishable ` +
                'file: reference (TW-1b/SW-10), and optionalDependencies IS installed-attempted ' +
                "for every consumer of the published tarball, unlike devDependencies.",
        );
    });

    console.log(`\nTW-1b: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
})();
