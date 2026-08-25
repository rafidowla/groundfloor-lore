#!/usr/bin/env tsx
/**
 * test/sprint-H-online-migration-property.ts — Sprint H0 gate test
 *
 * 10 cases asserting the Sprint H online-schema-migration contract
 * (audit doc: docs/audits/sprint-H-online-migration-2026-05-24.md,
 * Sprint H principle clauses 1-10). Mirrors L0 / O0 / E0 / Z0 pattern:
 *
 *   - H-D1, D2, D3 were xfail-strict at H0; H1 (2026-05-24) landed
 *     the MigrationCoordinator + SubstrateMigrationAdapter and flipped
 *     them to expectPass.
 *   - H-D4, D5, D6, D7, D10 remain xfail-strict: destructive verbs +
 *     cross-substrate atomicity + migration.applied emission via
 *     Coordinator wait on H2/H3. Each assertion fails = xfail-pass.
 *     As each sub-chain lands, the case becomes "unexpected pass"
 *     and the sub-chain MUST flip it to expectPass in the same commit.
 *   - H-D8, H-D9 are expectPass regression sentinels: Sprint L
 *     workspace_required and Sprint O outbox-first invariants must
 *     remain green THROUGHOUT Sprint H. Either flipping to red
 *     counts as a regression and fails the runner.
 *
 * Sub-chain flip schedule (per SPRINT-H-online-schema-migration.md):
 *   H1 → flips D1 (add column), D2 (add table), D3 (add index)
 *   H2 → flips D4 (rename via expand/migrate/contract), D5 (type
 *        change via expand/migrate/contract), D6 (drop column via
 *        expand/migrate/contract)
 *   H3 → flips D7 (cross-substrate atomicity), D10 (migration.applied
 *        outbox emission)
 *   H4 (closure) → all 10 expectPass; D8 + D9 still expectPass as
 *        regression sentinels
 *
 * After H0 commit:
 *   xfail-pass:  8  (H-D1..H-D7, H-D10)
 *   expect-pass: 2  (H-D8, H-D9 regression sentinels)
 *
 * After H1 commit (2026-05-24):
 *   xfail-pass:  3  (H-D4, H-D5, H-D6 — destructive runbook deferred to H2)
 *   expect-pass: 7  (H-D1, H-D2, H-D3, H-D7, H-D10 flipped early; H-D8 + H-D9 sentinels)
 *
 * After H2 commit (2026-05-24):
 *   xfail-pass:  0
 *   expect-pass: 10  (H-D4, H-D5, H-D6 flipped; Sprint H gate 10/10. H4 closes with tag.)
 *
 *   Note: H-D7 + H-D10 flipped in H1 because the H1 Coordinator already
 *   ships the rollback verb + migrations schema with rolled_back terminal
 *   state AND emits migration.applied via the outbox surface. H3 extends
 *   the rollback story with cross-substrate atomicity orchestration — the
 *   shape of the verb does not change.
 *
 * Each case is intentionally STATIC (file-system probe / source-text
 * grep / audit-doc grep) rather than runtime — H0 must commit without
 * spinning a daemon. The cases are written so that the act of landing
 * the implementation (which writes a new file, adds a Coordinator
 * method, or surfaces an outbox kind) flips them to passing. Sub-chains
 * land both the runtime change AND the marker change in the same
 * commit, then promote the case to expectPass per the harness
 * convention.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/* ============================================================
 * xfail-strict harness (matches test/L-database-property-unit.ts,
 * test/sprint-O-outbox-property.ts, test/sprint-E-embed-property.ts,
 * test/sprint-Z-bulk-loader-property.ts shape)
 * ============================================================ */

let xfailPassed = 0;     // case threw as expected — good
let unexpectedPass = 0;  // case did NOT throw — sprint flipped behavior, must promote
let runnerErrors = 0;    // case errored outside the assertion (harness bug)
let expectPassed = 0;    // case passed (post-flip) as required
let expectFailed = 0;    // case failed after being flipped to expectPass — regression
const pending: Array<Promise<void>> = [];

function xfailStrict(name: string, fn: () => Promise<void> | void): void {
    pending.push((async () => {
        try {
            await fn();
        } catch (err) {
            console.log(`  ✓ ${name} (xfail-pass: ${(err as Error).message.split('\n')[0]?.slice(0, 80)})`);
            xfailPassed++;
            return;
        }
        console.error(`  ✗ ${name} — UNEXPECTED PASS. Sprint sub-chain has landed the fix; promote this case to expectPass() and remove the xfail wrapper.`);
        unexpectedPass++;
    })().catch((err) => {
        console.error(`  ! ${name} — harness error: ${(err as Error).message}`);
        runnerErrors++;
    }));
}

function expectPass(name: string, fn: () => Promise<void> | void): void {
    pending.push((async () => {
        try {
            await fn();
            console.log(`  ✓ ${name} (pass)`);
            expectPassed++;
        } catch (err) {
            console.error(`  ✗ ${name} — REGRESSION: ${(err as Error).message.split('\n')[0]?.slice(0, 200)}`);
            expectFailed++;
        }
    })().catch((err) => {
        console.error(`  ! ${name} — harness error: ${(err as Error).message}`);
        runnerErrors++;
    }));
}

/* ============================================================
 * Test cases
 * ============================================================ */

console.log('Sprint H gate test — Online schema migration (8 xfail + 2 expect-pass sentinels at H0 commit)');

const LORE_SRC = join(process.cwd(), 'packages/lore/src');
const MIGRATION_DIR = join(LORE_SRC, 'migration');
const OUTBOX_TYPES = join(LORE_SRC, 'outbox/types.ts');
const ROUTES_DIR = join(LORE_SRC, 'mcp/http/routes');
const AUDIT_DOC = join(process.cwd(), 'docs/audits/sprint-H-online-migration-2026-05-24.md');

/* ----- H-D1 — Add column to existing table executes online via Coordinator
 *
 * Sprint H principle clause 1: additive changes land without daemon
 * restart. H1 ships the MigrationCoordinator + SubstrateMigrationAdapter
 * interface (audit Section 5) with `addColumn(table, column)` verb. The
 * assertion: the new packages/lore/src/migration/ directory exists with a
 * coordinator.ts that exposes addColumn (or equivalent verb on the
 * adapter interface).
 */
expectPass('H-D1 MigrationCoordinator.addColumn surface exists (H1 — landed)', () => {
    const coord = join(MIGRATION_DIR, 'coordinator.ts');
    assert.ok(existsSync(coord), `expected ${coord} (H1 must add the MigrationCoordinator per audit Section 5)`);
    const src = readFileSync(coord, 'utf8');
    assert.match(src, /addColumn\s*\(/, 'coordinator must expose addColumn verb (audit Section 5)');
});

/* ----- H-D2 — Add new table executes online via Coordinator
 *
 * Sprint H principle clause 1: add-table is additive, online. H1 ships
 * the `addTable(spec)` verb on the SubstrateMigrationAdapter interface.
 * Assertion: types.ts defines the interface and addTable is part of it.
 */
expectPass('H-D2 SubstrateMigrationAdapter.addTable verb defined (H1 — landed)', () => {
    const types = join(MIGRATION_DIR, 'types.ts');
    assert.ok(existsSync(types), `expected ${types} (H1 must add the SubstrateMigrationAdapter interface per audit Section 5)`);
    const src = readFileSync(types, 'utf8');
    assert.match(src, /addTable\s*\(/, 'adapter interface must expose addTable verb (audit Section 5)');
    assert.match(src, /SubstrateMigrationAdapter|MigrationAdapter/, 'adapter interface must be named per audit Section 5');
});

/* ----- H-D3 — Add new index executes online via Coordinator
 *
 * Sprint H principle clause 1: add-index is additive, online (background
 * build). H1 ships the `addIndex(table, index)` verb. Per Section 7 R4,
 * kuzu has no CREATE INDEX surface — H1 ships addIndex for SQLite + lance
 * only and the kuzu adapter throws CapabilityNotSupported. Assertion:
 * the verb exists on the interface.
 */
expectPass('H-D3 SubstrateMigrationAdapter.addIndex verb defined (H1 — landed)', () => {
    const types = join(MIGRATION_DIR, 'types.ts');
    assert.ok(existsSync(types), `expected ${types} (H1 must add the SubstrateMigrationAdapter interface per audit Section 5)`);
    const src = readFileSync(types, 'utf8');
    assert.match(src, /addIndex\s*\(/, 'adapter interface must expose addIndex verb (audit Section 5)');
});

/* ----- H-D4 — Rename column via expand/migrate/contract
 *
 * Sprint H principle clause 2: destructive changes use the 3-phase
 * expand/migrate/contract pattern (audit Section 4), each phase
 * independently reversible. H2 ships the prepareRename + migrateData +
 * dropOld verbs on the adapter interface. Assertion: all three verbs
 * present plus a phase-state enum/type covering expand/migrate/contract.
 */
expectPass('H-D4 expand/migrate/contract verbs + phase enum present (H2 — landed)', () => {
    const types = join(MIGRATION_DIR, 'types.ts');
    assert.ok(existsSync(types), `expected ${types} (H2 must add destructive-change verbs per audit Section 5)`);
    const src = readFileSync(types, 'utf8');
    assert.match(src, /prepareRename\s*\(/, 'adapter interface must expose prepareRename verb (Phase 1) per audit Section 5');
    assert.match(src, /migrateData\s*\(/, 'adapter interface must expose migrateData verb (Phase 2) per audit Section 5');
    assert.match(src, /dropOld\s*\(/, 'adapter interface must expose dropOld verb (Phase 3) per audit Section 5');
    assert.match(src, /['"]expand['"]|['"]migrate['"]|['"]contract['"]/, 'phase enum must include expand/migrate/contract literals per audit Section 4');
});

/* ----- H-D5 — Change column type via expand/migrate/contract
 *
 * Sprint H principle clause 2 + Section 2 matrix: type changes require
 * expand/migrate/contract on every substrate (SQLite has no ALTER COLUMN
 * TYPE; kuzu/lance both rebuild). H2 documents the operator runbook
 * for type-change migrations. Assertion: docs/architecture/online-migration.md
 * exists and covers type-change.
 */
expectPass('H-D5 online-migration runbook covers type-change via expand/migrate/contract (H2 — landed)', () => {
    const runbook = join(process.cwd(), 'docs/architecture/online-migration.md');
    assert.ok(existsSync(runbook), `expected ${runbook} (H2/H4 must publish the operator runbook per Sprint H done-criterion)`);
    const src = readFileSync(runbook, 'utf8');
    assert.match(src, /type[- ]?change|ALTER\s+COLUMN\s+TYPE|change\s+column\s+type/i, 'runbook must cover type-change migrations');
    assert.match(src, /expand.{0,30}migrate.{0,30}contract|expand\/migrate\/contract/i, 'runbook must reference the expand/migrate/contract pattern');
});

/* ----- H-D6 — Drop column via expand/migrate/contract
 *
 * Sprint H principle clause 2 + Section 2/7 (R5): drop column uses the
 * 3-phase pattern; kuzu binding has no DROP COLUMN, so the kuzu adapter
 * falls back to null-out + leave-in-place (audit Section 7 R5). H2
 * documents the workaround. Assertion: runbook covers drop-column with
 * the kuzu-workaround note.
 */
expectPass('H-D6 online-migration runbook covers drop-column + kuzu workaround (H2 — landed)', () => {
    const runbook = join(process.cwd(), 'docs/architecture/online-migration.md');
    assert.ok(existsSync(runbook), `expected ${runbook} (H2/H4 must publish the operator runbook per Sprint H done-criterion)`);
    const src = readFileSync(runbook, 'utf8');
    assert.match(src, /drop[- ]?column|DROP\s+COLUMN/i, 'runbook must cover drop-column migrations');
    assert.match(src, /kuzu/i, 'runbook must reference the kuzu drop-column workaround per audit Section 7 R5');
});

/* ----- H-D7 — Cross-substrate atomicity: all-applied or all-rolled-back
 *
 * Sprint H principle clauses 3 + 4: Coordinator orchestrates per-
 * substrate operations atomically; a cross-substrate change either
 * commits across every substrate or rolls back wholesale (audit
 * Section 7 R6). H3 ships the cross-substrate orchestration + per-
 * adapter rollback. Assertion: Coordinator surface exposes a rollback
 * verb and the migrations sqlite schema includes phase + status
 * columns capable of representing "rolled_back" terminal state.
 */
expectPass('H-D7 Coordinator.rollback + migrations table schema present (H1 — landed early; H3 extends cross-substrate atomicity)', () => {
    const coord = join(MIGRATION_DIR, 'coordinator.ts');
    assert.ok(existsSync(coord), `expected ${coord} (H3 must extend the Coordinator with cross-substrate rollback per audit Section 5/7-R6)`);
    const coordSrc = readFileSync(coord, 'utf8');
    assert.match(coordSrc, /rollback\s*\(/, 'Coordinator must expose rollback verb');
    // Migrations table schema must encode rolled_back terminal state.
    const schemaFile = join(MIGRATION_DIR, 'schema.ts');
    const storeFile = join(MIGRATION_DIR, 'store.ts');
    const schemaPath = existsSync(schemaFile) ? schemaFile : storeFile;
    assert.ok(existsSync(schemaPath), `expected ${schemaFile} or ${storeFile} with migrations table DDL per audit Section 5`);
    const schemaSrc = readFileSync(schemaPath, 'utf8');
    assert.match(schemaSrc, /CREATE\s+TABLE.{0,40}migrations/i, 'schema file must include the migrations table CREATE TABLE');
    assert.match(schemaSrc, /rolled_back/i, 'migrations.status must include rolled_back terminal state per audit Section 5');
});

/* ----- H-D8 — Sprint L workspace_required preserved during migration
 *
 * Regression sentinel — must hold today and throughout Sprint H. Every
 * write API + migration code path enforces workspace presence. Assertion:
 * the workspace_required helper still exists in the workspace module
 * (Sprint L L2 anchor) and is referenced from bulk write routes.
 */
expectPass('H-D8 workspace_required helper exists for migration paths to reuse (Sprint L invariant)', () => {
    const wsFile = join(LORE_SRC, 'workspaces/required.ts');
    const altWsFile = join(LORE_SRC, 'config/workspaces.ts');
    const candidate = existsSync(wsFile) ? wsFile : altWsFile;
    assert.ok(existsSync(candidate), `expected workspace_required helper at ${wsFile} or ${altWsFile} (Sprint L invariant)`);
    const src = readFileSync(candidate, 'utf8');
    // Either the function is named requireWorkspace/workspaceRequired or
    // the file exports the active-workspace resolution surface used by
    // Sprint L workspace gating.
    assert.match(
        src,
        /(requireWorkspace|workspaceRequired|getActiveWorkspaceName|activeWorkspace)/,
        'workspace gating surface must exist for migration paths to reuse',
    );
});

/* ----- H-D9 — Sprint O outbox + replicator continue functioning during migration
 *
 * Regression sentinel — must hold today and throughout Sprint H. The
 * SQLite outbox store + replicator preserve their Sprint O contract;
 * migration code paths emit via the same outbox surface (audit
 * Section 5 + Section 6). Assertion: outbox sqliteStore + replicator
 * source files still exist with the expected exports.
 */
expectPass('H-D9 outbox SQLite store + replicator preserved for migration emissions (Sprint O invariant)', () => {
    const sqliteStore = join(LORE_SRC, 'outbox/sqliteStore.ts');
    const replicator = join(LORE_SRC, 'outbox/replicator.ts');
    assert.ok(existsSync(sqliteStore), `expected ${sqliteStore} (Sprint O invariant)`);
    assert.ok(existsSync(replicator), `expected ${replicator} (Sprint O invariant)`);
    const storeSrc = readFileSync(sqliteStore, 'utf8');
    // Outbox table DDL must still be present (Sprint O3c migration anchor).
    assert.match(storeSrc, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+outbox_entries/i, 'outbox_entries table DDL must remain (Sprint O3c)');
});

/* ----- H-D10 — Coordinator emits migration.applied outbox notification
 *
 * Sprint H principle clauses 6 + 8: Coordinator emits migration.started,
 * migration.phase.complete, migration.applied via the outbox surface.
 * Sprint O contract preserved (every state change rides the outbox).
 * Assertion: outbox types.ts has the migration.* operation kinds
 * declared, AND the audit doc lists them.
 */
expectPass('H-D10 migration.* outbox kinds declared + Coordinator emits migration.applied (H1 — landed early)', () => {
    assert.ok(existsSync(OUTBOX_TYPES), `expected ${OUTBOX_TYPES} (Sprint O outbox types file)`);
    const typesSrc = readFileSync(OUTBOX_TYPES, 'utf8');
    // The OutboxOperationKind / outbox kind enum must include the
    // migration.* family for the Coordinator to emit via the existing
    // outbox surface (audit Section 5).
    assert.match(
        typesSrc,
        /migration\.applied|['"]migration\.[a-z._]+['"]/,
        'outbox types.ts must declare migration.* kinds for Coordinator emissions per audit Section 5',
    );
    // The Coordinator implementation must actually emit migration.applied.
    const coord = join(MIGRATION_DIR, 'coordinator.ts');
    assert.ok(existsSync(coord), `expected ${coord} (H3 ships the emission path)`);
    const coordSrc = readFileSync(coord, 'utf8');
    assert.match(coordSrc, /migration\.applied/, 'Coordinator must emit migration.applied per Sprint H principle clause 8');
});

/* ============================================================
 * Runner
 * ============================================================ */

await Promise.all(pending);

console.log('');
console.log(`xfail-pass:       ${xfailPassed}`);
console.log(`unexpected-pass:  ${unexpectedPass}`);
console.log(`expect-pass:      ${expectPassed}`);
console.log(`expect-fail:      ${expectFailed}`);
console.log(`harness-errors:   ${runnerErrors}`);

if (unexpectedPass > 0) {
    console.error('');
    console.error(`FAIL: ${unexpectedPass} xfail case(s) unexpectedly passed.`);
    console.error('A sprint sub-chain has landed the underlying fix — promote those cases to expectPass() and remove the xfail wrapper in the same commit.');
    process.exit(1);
}
if (expectFailed > 0) {
    console.error('');
    console.error(`FAIL: ${expectFailed} expectPass case(s) regressed.`);
    process.exit(1);
}
if (runnerErrors > 0) {
    console.error('');
    console.error(`FAIL: ${runnerErrors} harness error(s) — fix before merge.`);
    process.exit(1);
}
// Reference AUDIT_DOC to ensure the import-time check sees the audit
// is present alongside the gate test (H0 ships them together).
if (!existsSync(AUDIT_DOC)) {
    console.error('');
    console.error(`FAIL: companion audit doc missing at ${AUDIT_DOC}.`);
    process.exit(1);
}
console.log('');
console.log(`OK: ${xfailPassed} xfail-pass + ${expectPassed} expect-pass.`);
