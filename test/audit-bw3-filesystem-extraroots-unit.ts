#!/usr/bin/env tsx
/**
 * audit-bw3-filesystem-extraroots-unit.ts — re-audit 2026-06-25 (MEDIUM, bug).
 *
 * The filesystem connector walks the user-configured roots but called
 * assertPathAllowed with only { workspaceRoot } — omitting extraRoots. So every
 * file under a configured root that wasn't also under a default root
 * (~/Documents, ~/Downloads, ~/Desktop) failed the allowlist and was silently
 * dropped (continue). Now it passes the scanned roots as extraRoots; the
 * blocklist + credential-basename checks still apply per file.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FilesystemConnector } from '../packages/lore/src/engines/connectors/filesystem.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const stubRegistry = { mimeFromPath: (p: string) => (p.endsWith('.md') ? 'text/markdown' : null) } as never;

console.log('BW-3 — filesystem connector honors configured roots in the allowlist');

await test('a file under an explicit configured root is yielded, not silently dropped', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-bw3-')); // NOT under ~/Documents etc.
    try {
        fs.writeFileSync(path.join(dir, 'doc.md'), '# hello');
        const c = new FilesystemConnector({ roots: [dir], extractorRegistry: stubRegistry });
        const ids: string[] = [];
        for await (const item of c.sync()) ids.push(item.sourceId);
        assert.ok(ids.some((id) => id.endsWith('doc.md')), `a file under the configured root must be yielded; got ${JSON.stringify(ids)}`);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

await test('a credential-named file under a configured root is STILL refused (defense-in-depth holds)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-bw3-'));
    try {
        // .md mime but a blocklisted basename pattern → must be dropped by the per-file checks.
        fs.writeFileSync(path.join(dir, 'id_rsa.md'), 'PRIVATE');
        fs.writeFileSync(path.join(dir, 'ok.md'), '# fine');
        const c = new FilesystemConnector({ roots: [dir], extractorRegistry: stubRegistry });
        const ids: string[] = [];
        for await (const item of c.sync()) ids.push(item.sourceId);
        assert.ok(ids.some((id) => id.endsWith('ok.md')), 'the benign file is yielded');
        assert.ok(!ids.some((id) => id.endsWith('id_rsa.md')), 'a credential-named file is still refused even under a configured root');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
