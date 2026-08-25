/**
 * ident-test-util.ts — Test-only re-export of assertIdent.
 *
 * Moved from packages/lore/src/engines/kuzuTableStorage.ts (NW-7d).
 * Production code must never export test helpers; this module gives
 * SP-25 exploit regression tests a stable import path without leaking
 * into the production bundle.
 *
 * Import in tests:
 *   import { assertIdentForTests } from '../helpers/ident-test-util.js';
 */

import { assertIdent } from '../../packages/lore/src/engines/whereClause.js';

/** Re-export assertIdent for exploit-regression tests (SP-25, SW-14). */
export function assertIdentForTests(name: string): string {
    return assertIdent(name);
}

/**
 * Underscore alias kept for backwards compat with existing test imports
 * that use the old `_assertIdentForTests` name from kuzuTableStorage.
 * @deprecated Use assertIdentForTests instead.
 */
export const _assertIdentForTests = assertIdentForTests;
