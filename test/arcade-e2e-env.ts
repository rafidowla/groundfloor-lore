/**
 * arcade-e2e-env.ts — lets the real-ArcadeDB e2e suites target an EXTERNALLY
 * MANAGED ArcadeDB server instead of the hard-coded `http://localhost:2480`
 * container (which collides with any other ArcadeDB on the host).
 *
 * Env vars (all optional; with none set, behaviour is unchanged — localhost:2480,
 * root password `SpikeRoot123!`, helper-managed docker container):
 *   LORE_ARCADE_E2E_URL                  base URL of an already-running server,
 *                                        e.g. http://127.0.0.1:2497. Setting it switches
 *                                        the suites to "external server" mode: the helper
 *                                        in spike-arcadedb-helpers.ts will NOT docker
 *                                        run / docker rm anything.
 *   LORE_ARCADE_E2E_ROOT_PASSWORD        root password of that server, or
 *   LORE_ARCADE_E2E_ROOT_PASSWORD_FILE   path to a file holding it (trailing
 *                                        whitespace trimmed). One of the two is required
 *                                        in external mode.
 *
 * IMPORT THIS FIRST in a suite (`import './arcade-e2e-env.js';` before any product
 * import): the product reads ARCADE_BASE_URL / ARCADE_ROOT_PASSWORD at module load,
 * and in external mode this module maps the LORE_ARCADE_E2E_* vars onto them.
 * Never logs the password.
 */
import * as fs from 'node:fs';

const rawUrl = process.env['LORE_ARCADE_E2E_URL'];

/** True when a server managed outside the test (not docker-run by the helper) is targeted. */
export const ARCADE_E2E_EXTERNAL: boolean = !!rawUrl && rawUrl.length > 0;

/** Base URL (no trailing slash) the suites should hit. */
export const ARCADE_E2E_BASE_URL: string = ARCADE_E2E_EXTERNAL
  ? rawUrl!.replace(/\/+$/, '')
  : 'http://localhost:2480';

function resolveRootPassword(): string {
  if (!ARCADE_E2E_EXTERNAL) return 'SpikeRoot123!';
  const direct = process.env['LORE_ARCADE_E2E_ROOT_PASSWORD'];
  if (direct && direct.length > 0) return direct;
  const file = process.env['LORE_ARCADE_E2E_ROOT_PASSWORD_FILE'];
  if (file && file.length > 0) {
    const pw = fs.readFileSync(file, 'utf8').trim();
    if (pw.length > 0) return pw;
  }
  throw new Error(
    'LORE_ARCADE_E2E_URL is set: also set LORE_ARCADE_E2E_ROOT_PASSWORD or LORE_ARCADE_E2E_ROOT_PASSWORD_FILE',
  );
}

/** Root password for the targeted server (the spike default unless external). */
export const ARCADE_E2E_ROOT_PASSWORD: string = resolveRootPassword();

if (ARCADE_E2E_EXTERNAL) {
  // Explicit E2E vars win over any ambient ARCADE_* values.
  process.env['ARCADE_BASE_URL'] = ARCADE_E2E_BASE_URL;
  process.env['ARCADE_ROOT_PASSWORD'] = ARCADE_E2E_ROOT_PASSWORD;
}
