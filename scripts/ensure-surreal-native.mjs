#!/usr/bin/env node
/**
 * ensure-surreal-native.mjs — Lore postinstall: verify @surrealdb/node's NAPI
 * addon is present and loadable for THIS platform.
 *
 * Why this is a VERIFY step, not a fetch step: @surrealdb/node@3.0.3 embeds
 * a prebuilt `.node` for every supported platform inside the npm tarball
 * (~180 MB), has no install script, and declares no platform-specific
 * optionalDependencies. There is nothing to download. (The repo's former
 * second postinstall, for the former legacy graph engine, WAS a fetch step — it closed
 * the CDN-outage gap for a package that shipped without a binary — and was
 * deleted with the legacy graph engine, 2026-08-21. This script now runs
 * alone.)
 *
 * What CAN still go wrong, and is worth catching at install time rather than
 * at first query:
 *   - `--ignore-scripts` / partial extraction leaving the addon absent.
 *   - An unsupported platform/arch triple (the package covers darwin
 *     arm64/x64, linux arm64/x64 × gnu/musl, win32 arm64/x64 — nothing else).
 *   - A Node ABI mismatch: the addon is built for a NODE_MODULE_VERSION, and
 *     this package pins Node 22 (`engines.node: ">=22 <23"`). Running it on
 *     another major fails at dlopen with a message most people read as
 *     "the package is broken".
 *
 * FAIL-SOFT by design: this prints an actionable warning and exits 0. The
 * addon ships inside @surrealdb/node's own tarball, so a failure here means
 * the npm install itself went wrong (unsupported platform, ABI mismatch) —
 * aborting the install over it buys nothing the warning at install time
 * plus the loud failure at first graph query don't already provide.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_NAME = '@surrealdb/node';

/**
 * Locate the package wherever the package manager put it. npm normally HOISTS
 * it to the consumer's top-level node_modules when Lore is a dependency; the
 * nested layout only exists in this repo's own checkout. Same resolution
 * strategy (and same reason) as the equivalent locator in the now-deleted
 * legacy-engine postinstall script.
 */
function findPackageDir() {
    const require = createRequire(import.meta.url);
    try {
        return path.dirname(require.resolve(`${PACKAGE_NAME}/package.json`));
    } catch { /* fall through to the manual node_modules walk */ }
    for (let dir = ROOT_DIR; ; dir = path.dirname(dir)) {
        const candidate = path.join(dir, 'node_modules', '@surrealdb', 'node');
        if (fs.existsSync(candidate)) return candidate;
        if (dir === path.dirname(dir)) return null;
    }
}

/** The addon filename this platform needs, mirroring @napi-rs/cli's naming. */
function platformBinaryName() {
    const { platform, arch } = process;
    if (platform === 'darwin') return `surrealdb-node.darwin-${arch}.node`;
    if (platform === 'win32') return `surrealdb-node.win32-${arch}-msvc.node`;
    if (platform === 'linux') {
        let libc = 'gnu';
        try {
            // musl builds (Alpine) need the musl-linked addon.
            if (fs.readFileSync('/etc/os-release', 'utf8').includes('Alpine Linux')) libc = 'musl';
        } catch { /* not Alpine, or the file is absent */ }
        return `surrealdb-node.linux-${arch}-${libc}.node`;
    }
    return null;
}

function warn(message) {
    console.warn(`[lore] ${PACKAGE_NAME}: ${message}`);
}

const packageDir = findPackageDir();
if (packageDir === null) {
    // Not installed at all — legitimate. The engine is optional, and a consumer
    // that never opts into SurrealDB has no reason to carry a 180 MB dependency.
    process.exit(0);
}

const binaryName = platformBinaryName();
if (binaryName === null) {
    warn(
        `no prebuilt addon exists for ${process.platform}/${process.arch}. `
        + 'The SurrealDB engine — the only graph engine — will be unavailable on this machine.',
    );
    process.exit(0);
}

const binaryPath = path.join(packageDir, 'dist', binaryName);
if (!fs.existsSync(binaryPath)) {
    warn(
        `the native addon for this platform is missing (expected dist/${binaryName}). `
        + 'This usually means the package was extracted partially or installed with '
        + '--ignore-scripts against a mirror that strips binaries. Reinstall with '
        + `\`npm install ${PACKAGE_NAME} --force\` if you intend to use the SurrealDB engine.`,
    );
    process.exit(0);
}

// Actually LOAD it. Presence on disk proves nothing about ABI compatibility,
// and the ABI mismatch is the failure mode that produces the most confusing
// error message later.
try {
    process.dlopen({ exports: {} }, binaryPath);
} catch (err) {
    const nodeMajor = process.versions.node.split('.')[0];
    warn(
        `the native addon failed to load on Node ${process.versions.node} `
        + `(NODE_MODULE_VERSION ${process.versions.modules}): ${err.message}\n`
        + `       Lore pins Node 22 (package.json engines: ">=22 <23"); you are on Node ${nodeMajor}. `
        + 'Switch to Node 22 (`nvm use`, this repo ships a .nvmrc) if you intend to use the SurrealDB engine.',
    );
    process.exit(0);
}

process.exit(0);
