#!/usr/bin/env node
/**
 * test/helpers/migrate-graph-crash-child.ts — runs `migrateGraphToSqlite`
 * with `simulateCrashBeforeFlip: true` so the process exits (code 137, the
 * conventional SIGKILL code) at the latest possible instant BEFORE the
 * atomic `graphEngine` flip. Reads workspaceName/home/backupOutDir from
 * argv so the parent test controls the fixture.
 */
import { migrateGraphToSqlite } from '../../packages/lore/src/engines/migrateGraphToSqlite.js';

const [workspaceName, home, backupOutDir] = process.argv.slice(2);
if (!workspaceName || !home || !backupOutDir) {
    console.error('usage: migrate-graph-crash-child.ts <workspaceName> <home> <backupOutDir>');
    process.exit(2);
}

await migrateGraphToSqlite({ workspaceName, home, backupOutDir, force: true, simulateCrashBeforeFlip: true });
// Unreachable — simulateCrashBeforeFlip always exits first. If we get here,
// the crash injection itself is broken, which the parent test must catch.
console.error('migrate-graph-crash-child: simulateCrashBeforeFlip did not exit — test harness bug');
process.exit(1);
