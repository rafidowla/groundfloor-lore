#!/usr/bin/env tsx
/**
 * run-arcade-real-e2e.ts - opt-in group runner for EVERY real-ArcadeDB e2e suite (3.35.0 readiness).
 *
 * NOT part of `test:e2e:all` or `npm test`: these suites need a running ArcadeDB, which the default chain never has.
 * Point it at a throwaway server you manage yourself (the runner refuses to fall back to the hard-coded
 * localhost:2480, which collides with any other ArcadeDB on the host):
 *
 *   LORE_ARCADE_E2E_URL=http://127.0.0.1:<port> \
 *   LORE_ARCADE_E2E_ROOT_PASSWORD_FILE=<file holding the root password> \
 *   LIVE_CONTAINER=<docker container name of THAT server>   # lets the outage / crash phases stop+start it
 *   npm run test:e2e:arcade-real [-- --only name1,name2] [--with-self-managed] [--list]
 *
 * Each suite runs as its own `tsx` process (stdio inherited) so one failure never contaminates the next; the exit code
 * is 1 if any suite failed. A suite listed `needsContainer` is SKIPPED (reported, not failed) when LIVE_CONTAINER is
 * unset, because its outage / crash phase is the point of the suite. A suite listed `selfManaged` starts and removes its OWN
 * docker container (fixed name + port, ignores LORE_ARCADE_E2E_URL), so it only runs with --with-self-managed.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface Suite { name: string; script: string; needsContainer?: boolean; selfManaged?: boolean }

export const ARCADE_REAL_SUITES: Suite[] = [
    { name: 'arcade-write-scopes-real',          script: 'arcade-write-scopes-real-e2e.ts', selfManaged: true },
    { name: 'arcade-reprovision-user-survives',  script: 'arcade-reprovision-user-survives-e2e.ts' },
    { name: 'arcade-slice2-deployable',          script: 'optionA-slice2-deployable-e2e.ts' },
    { name: 'hung-arcade-lock-hold',             script: 'hung-arcade-lock-hold-e2e.ts', needsContainer: true },
    { name: 'pending-commit-crash',              script: 'pending-commit-crash-e2e.ts', needsContainer: true },
    { name: 'outbox-no-dataloss-arcade',         script: 'outbox-no-dataloss-arcade-e2e.ts', needsContainer: true },
    { name: 'atomic-bulk-two-daemon',            script: 'atomic-bulk-two-daemon-e2e.ts' },
    { name: 'node-batch-two-daemon',             script: 'node-batch-two-daemon-e2e.ts' },
    { name: 'node-batch-arcade-live',            script: 'node-batch-arcade-live-e2e.ts' },
    { name: 'supersede-atomic-live',             script: 'supersede-atomic-live-e2e.ts' },
];

const here = path.dirname(fileURLToPath(import.meta.url));

function runOne(s: Suite): Promise<number> {
    return new Promise((resolve) => {
        console.log(`\n${'='.repeat(72)}\n  > ${s.name}   (test/${s.script})\n${'='.repeat(72)}`);
        const proc = spawn('npx', ['tsx', path.join(here, s.script)], { stdio: 'inherit', cwd: path.join(here, '..') });
        proc.on('exit', (code) => resolve(code ?? 1));
    });
}

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    if (argv.includes('--list')) { for (const s of ARCADE_REAL_SUITES) console.log(`${s.name}\t${s.script}${s.needsContainer ? '\t(needs LIVE_CONTAINER)' : ''}${s.selfManaged ? '\t(self-managed container; needs --with-self-managed)' : ''}`); return; }
    const onlyIdx = argv.indexOf('--only');
    const only = onlyIdx >= 0 ? new Set((argv[onlyIdx + 1] ?? '').split(',').filter(Boolean)) : null;
    if (only) for (const n of only) if (!ARCADE_REAL_SUITES.some((s) => s.name === n)) { console.error(`unknown suite "${n}" (see --list)`); process.exit(2); }

    const url = process.env['LORE_ARCADE_E2E_URL'];
    if (!url) { console.error('LORE_ARCADE_E2E_URL is required: point it at a throwaway ArcadeDB (this group never uses the default localhost:2480).'); process.exit(2); }
    if (!process.env['LORE_ARCADE_E2E_ROOT_PASSWORD'] && !process.env['LORE_ARCADE_E2E_ROOT_PASSWORD_FILE']) { console.error('LORE_ARCADE_E2E_ROOT_PASSWORD_FILE (or _ROOT_PASSWORD) is required.'); process.exit(2); }
    const container = process.env['LIVE_CONTAINER'] ?? '';

    const results: Array<{ name: string; result: 'PASS' | 'FAIL' | 'SKIP'; secs: number }> = [];
    for (const s of ARCADE_REAL_SUITES) {
        if (only && !only.has(s.name)) continue;
        if (s.selfManaged && !argv.includes('--with-self-managed')) { results.push({ name: s.name, result: 'SKIP', secs: 0 }); console.log(`\n  - skipping ${s.name}: starts its own docker container; pass --with-self-managed`); continue; }
        if (s.needsContainer && !container) { results.push({ name: s.name, result: 'SKIP', secs: 0 }); console.log(`\n  - skipping ${s.name}: LIVE_CONTAINER not set`); continue; }
        const t0 = Date.now();
        const code = await runOne(s);
        results.push({ name: s.name, result: code === 0 ? 'PASS' : 'FAIL', secs: Math.round((Date.now() - t0) / 1000) });
    }
    console.log(`\n${'='.repeat(72)}\n  real-ArcadeDB group @ ${url}\n${'='.repeat(72)}`);
    for (const r of results) console.log(`  ${r.result.padEnd(4)}  ${r.name.padEnd(36)} ${r.secs}s`);
    process.exit(results.some((r) => r.result === 'FAIL') ? 1 : 0);
}
await main();
