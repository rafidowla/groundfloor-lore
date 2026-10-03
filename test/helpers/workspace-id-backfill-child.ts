/**
 * workspace-id-backfill-child.ts — child process for workspace-id-registry-unit.ts: builds the cloud
 * registry view over <home>, waits for a shared start time (so several children really race), then
 * resolves the ids of the given names (which backfills any that are missing) and prints them as JSON.
 *
 * usage: tsx workspace-id-backfill-child.ts <home> <startAtEpochMs> <name> [<name> ...]
 */
import { createWorkspaceRegistry } from '../../packages/lore/src/mcp/cloudBootConfig.js';

const [home, startAt, ...names] = process.argv.slice(2) as [string, string, ...string[]];
const view = createWorkspaceRegistry(home);
view.has(names[0]!); // warm the cache so the write below is the first thing that differs
while (Date.now() < Number(startAt)) { /* spin: align the start across children */ }
const out: Record<string, string | null> = {};
for (const n of names) out[n] = view.resolveId(n) ?? null;
process.stdout.write(JSON.stringify(out) + '\n');
