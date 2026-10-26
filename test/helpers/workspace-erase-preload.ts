/**
 * test/helpers/workspace-erase-preload.ts - node `--import` preload for the workspace-erase daemon e2e (lane f6b).
 *
 * Sets the process-wide lifecycle TEST seam in the spawned daemon: OS keychain eraser off (keytar is global per
 * user and must not be touched by a test), a fast scheduled-erase tick (500 ms first run, 1 s interval), and a
 * fake clock = real time + the number of milliseconds found in `$HOME/f6b-clock-offset-ms` (the test writes that
 * file to jump past the recovery window without waiting). Test-only: nothing in packages/ reads this file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { setLifecycleTestDefaults } from '../../packages/lore/src/engines/workspaceErase/lifecycle.js';

const offsetFile = path.join(process.env['HOME'] ?? '.', 'f6b-clock-offset-ms');
const offset = (): number => { try { return Number(fs.readFileSync(offsetFile, 'utf8').trim()) || 0; } catch { return 0; } };
setLifecycleTestDefaults({
    now: () => new Date(Date.now() + offset()),
    eraserFactory: { keyringEnabled: false },
    tick: { firstRunMs: 500, intervalMs: 1000 },
});
