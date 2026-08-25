/**
 * version.ts — Single source of truth for the daemon's version string.
 *
 * Reads the `version` field from the repo's package.json at module-load
 * time so every subsystem (MCP server handshake, /api/health, /metrics)
 * reports the same string and it is always in sync with the published
 * package version.
 *
 * Path resolution: the compiled file lands at dist/lore/src/version.js.
 * Three directories up from that is the repo root where package.json
 * lives.  We use import.meta.url → fileURLToPath so the resolution is
 * correct whether the daemon is launched from the repo root, from dist/,
 * or from an arbitrary cwd.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const _pkg = JSON.parse(
    readFileSync(resolve(__dirname, '../../../package.json'), 'utf-8'),
) as { version: string };

/** The daemon version, read from package.json at startup. */
export const VERSION: string = _pkg.version;
