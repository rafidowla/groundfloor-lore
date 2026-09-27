#!/usr/bin/env tsx
/**
 * model-server-no-spawn-when-idle-unit.ts — D9 (3.24 slice C3c) release
 * gate: a `createLore()` host that never embeds, recalls, or ingests
 * anything must never spawn the shared model server at all — attachment
 * eligibility is lazy, not eager on construction.
 *
 * Asserts, after `createLore()` + immediate `dispose()` with zero calls
 * in between:
 *   - no socket, pid, token or lock file anywhere under `<LORE_HOME>/run/`;
 *   - none at the tmpdir socket-fallback path for this key either;
 *   - no model-server process was ever spawned (nothing to kill).
 *
 * Run: npx tsx test/model-server-no-spawn-when-idle-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { serverKey, socketPath } from '../packages/lore/src/modelServer/paths.js';

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
};

function mkLoreHome(tag: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), `lore-ms-idle-${tag}-`));
}

console.log('D9 §6 release gate — no model server spawned when never embedded\n');

await test('createLore() + dispose() with zero embed/recall/ingest calls leaves no run/ footprint and no fallback-socket footprint', async () => {
    const home = mkLoreHome('never-embedded');
    const prevHome = process.env.LORE_HOME;
    const prevServer = process.env.LORE_MODEL_SERVER;
    process.env.LORE_HOME = home;
    process.env.LORE_MODEL_SERVER = '1'; // opt this test process IN to eligibility — if a server were going to spawn eagerly, this removes the "it just wasn't eligible anyway" escape hatch
    try {
        const { createLore } = await import('../packages/lore/src/mcp/server.js');
        const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-ms-idle-data-'));
        const lore = await createLore({ dataDir, deploymentMode: 'embedded', ownsProcess: false });
        try {
            // Deliberately nothing: no bulkIngest, no recall, no embed call of any kind.
        } finally {
            await lore.dispose();
        }

        const runRoot = path.join(home, 'run');
        if (fs.existsSync(runRoot)) {
            const entries = fs.readdirSync(runRoot, { recursive: true } as { recursive: true });
            assert.equal(entries.length, 0, `<LORE_HOME>/run/ must be completely empty (or absent) when no model call was ever made; found: ${JSON.stringify(entries)}`);
        }

        const key = serverKey(home);
        const sock = socketPath(home, key);
        assert.ok(!fs.existsSync(sock), `no socket file must exist at ${sock}`);

        const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
        const fallbackDir = path.join(os.tmpdir(), `lore-${uid}`);
        if (fs.existsSync(fallbackDir)) {
            const fallbackSock = path.join(fallbackDir, `${key}.sock`);
            assert.ok(!fs.existsSync(fallbackSock), `no tmpdir-fallback socket must exist at ${fallbackSock}`);
        }

        fs.rmSync(dataDir, { recursive: true, force: true });
    } finally {
        if (prevHome === undefined) delete process.env.LORE_HOME; else process.env.LORE_HOME = prevHome;
        if (prevServer === undefined) delete process.env.LORE_MODEL_SERVER; else process.env.LORE_MODEL_SERVER = prevServer;
        fs.rmSync(home, { recursive: true, force: true });
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
