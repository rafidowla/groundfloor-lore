#!/usr/bin/env tsx
/**
 * test/arcade-credential-rotation-e2e.ts — CONTAINER-BACKED proof for the
 * slice-2 W6 rotation path (needs a live ArcadeDB 26.7.1 on :2480).
 *
 * Pins the two behaviors that can ONLY be proven against a real ArcadeDB user
 * wall (the pure-SQLite logic is covered by
 * test/arcade-secrets-token-lifecycle-unit.ts):
 *
 *   1. rotateCredential mints a fresh password, swaps the ArcadeDB user, and
 *      the app KEEPS WORKING through the auth resolver with the new secret —
 *      while the OLD password is dead (the drop+create-only rotation contract,
 *      transient-401 window tolerated). Proves the "rotation keeps the app
 *      working (allowing a brief retry)" VERIFY item.
 *   2. Under the default sqlite backend the secret is in the db_pass column;
 *      after a rotation the column holds the NEW secret (not the old one), and
 *      readSecret resolves the live value through the store.
 *
 * Run: npx tsx test/arcade-credential-rotation-e2e.ts
 * Pre-req: ArcadeDB 26.7.1 container on :2480 (see test/spike-arcadedb-helpers).
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import Database from 'better-sqlite3';

import { LoreStorageClient } from '../packages/lore/src/storage/loreStorageClient.js';
import { ArcadeHttp, ArcadeHttpError } from '../packages/lore/src/engines/arcade/arcadeHttp.js';
import {
  provisionApp,
  destroyApp,
  rotateCredential,
  readSecret,
  closeRegistryDb,
  ARCADE_BASE_URL,
} from '../packages/lore/src/engines/arcade/arcadeProvisioner.js';
import {
  issueToken,
  arcadeCellForToken,
  closeTokenDb,
} from '../packages/lore/src/engines/arcade/arcadeAuthResolver.js';
import { resetSecretStoreForTests } from '../packages/lore/src/engines/arcade/arcadeSecretStore.js';
import { loadKeytar } from '../packages/lore/src/security/keytarLoader.js';
import { LocalEmbeddingProvider } from '../packages/lore/src/providers/localEmbeddingProvider.js';

const REG = path.join(os.tmpdir(), `arcade-rotation-${process.pid}.sqlite`);
const CELL = { customerId: 'rotcust', appId: 'rotapp' };
const embedder = new LocalEmbeddingProvider();

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) { pass++; console.log(`  [PASS] ${label}`); }
  else { fail++; const m = `  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`; failures.push(m); console.error(m); }
}

/** Retry a request across the transient-401 rotation window (bounded). */
async function withBriefRetry<T>(fn: () => Promise<T>, tries = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) { last = e; await new Promise((r) => setTimeout(r, 150 * (i + 1))); }
  }
  throw last;
}

async function cleanup(): Promise<void> {
  try { await destroyApp(CELL, { registryDbPath: REG }); } catch { /* best-effort */ }
  closeTokenDb();
  closeRegistryDb();
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(REG + s); } catch { /* ignore */ } }
}

async function main(): Promise<void> {
  console.log('=== ArcadeDB credential-rotation e2e ===');
  await cleanup();

  const embedDim = embedder.dimension;
  await provisionApp(CELL, { registryDbPath: REG, embedDim });
  const secretBefore = readSecret(CELL, { registryDbPath: REG })!;
  check('provision: secret resolvable via readSecret (sqlite column)', typeof secretBefore === 'string' && secretBefore.length > 0);

  // Default sqlite backend keeps the secret in the column — assert it is there
  // (the keychain "column NULL" path is asserted in the unit test's backend
  // selection + covered by the store's delete NULLing behavior).
  {
    const db = new Database(REG);
    const row = db.prepare(`SELECT db_pass FROM tenant_apps WHERE tenant_id=? AND app_id=?`).get(CELL.customerId, CELL.appId) as { db_pass: string | null };
    check('sqlite backend: db_pass column populated (matches readSecret)', row.db_pass === secretBefore);
    db.close();
  }

  // App works before rotation.
  const { token } = issueToken({ tenantId: CELL.customerId, appId: CELL.appId, scopes: ['read', 'write'] }, { registryDbPath: REG });
  {
    const cell = arcadeCellForToken(token, { registryDbPath: REG, embedder });
    const facade = LoreStorageClient.fromLocal({ graph: cell.graph, verbatim: cell.verbatim });
    const n = await facade.upsertNode({ id: 'pre-rotate', type: 'decision', label: 'before rotation', content: 'x', tags: [], embed: false });
    check('pre-rotation: upsertNode through facade works', n.id === 'pre-rotate');
  }

  // Capture a client on the OLD secret to prove it dies after rotation.
  const oldHttp = new ArcadeHttp({ user: `${CELL.customerId}_${CELL.appId}_svc`, pass: secretBefore }, ARCADE_BASE_URL);

  // ── ROTATE ────────────────────────────────────────────────────────────────
  const result = await rotateCredential(CELL, { registryDbPath: REG });
  check('rotateCredential: returns rotated:true + secretRef', result.rotated === true && result.secretRef.startsWith('arcade-svc:'));

  const secretAfter = readSecret(CELL, { registryDbPath: REG })!;
  check('rotation: readSecret now returns a DIFFERENT secret', secretAfter !== secretBefore && secretAfter.length > 0);
  {
    const db = new Database(REG);
    const row = db.prepare(`SELECT db_pass FROM tenant_apps WHERE tenant_id=? AND app_id=?`).get(CELL.customerId, CELL.appId) as { db_pass: string | null };
    check('rotation: db_pass column holds the NEW secret (old is gone)', row.db_pass === secretAfter && row.db_pass !== secretBefore);
    db.close();
  }

  // OLD credential is dead (401/403).
  {
    let died = false;
    try { await oldHttp.query(`tenant_${CELL.customerId}_${CELL.appId}`, `SELECT count(*) AS n FROM LoreNode`); }
    catch (e) { died = e instanceof ArcadeHttpError && (e.status === 401 || e.status === 403); }
    check('rotation: OLD password is dead (401/403) against its own db', died);
  }

  // App KEEPS WORKING with a fresh cell (new secret), allowing a brief retry
  // across the transient-401 window.
  {
    // Cell pool analogue: build a fresh bound cell AFTER rotation so it reads
    // the new secret from the store.
    const readBack = await withBriefRetry(async () => {
      const cell = arcadeCellForToken(token, { registryDbPath: REG, embedder });
      const facade = LoreStorageClient.fromLocal({ graph: cell.graph, verbatim: cell.verbatim });
      const got = await facade.getNode('pre-rotate');
      if (!got) throw new Error('node not readable yet');
      return got;
    });
    check('rotation: app keeps working post-rotation (data still readable via new secret)', readBack?.id === 'pre-rotate');

    const cell = arcadeCellForToken(token, { registryDbPath: REG, embedder });
    const facade = LoreStorageClient.fromLocal({ graph: cell.graph, verbatim: cell.verbatim });
    const w = await withBriefRetry(() => facade.upsertNode({ id: 'post-rotate', type: 'decision', label: 'after rotation', content: 'y', tags: [], embed: false }));
    check('rotation: writes work post-rotation with the new credential', w.id === 'post-rotate');
  }

  await cleanup();

  // ── KEYCHAIN BACKEND: secret leaves the sqlite column (release-criteria #6) ─
  // Provision a cell with LORE_ARCADE_SECRET_BACKEND=keychain and assert the
  // db_pass column is NULL (plaintext gone) while the cell still works through
  // the resolver (secret resolved from the OS keychain).
  {
    const keytar = await loadKeytar('[rotation-e2e]');
    if (!keytar) {
      console.log('  [SKIP] keychain backend: keytar unavailable in this environment');
    } else {
      const KCELL = { customerId: 'kccust', appId: 'kcapp' };
      const ref = `arcade-svc:${KCELL.customerId}:${KCELL.appId}`;
      process.env['LORE_ARCADE_SECRET_BACKEND'] = 'keychain';
      resetSecretStoreForTests();
      try {
        try { await destroyApp(KCELL, { registryDbPath: REG }); } catch { /* best-effort */ }
        await provisionApp(KCELL, { registryDbPath: REG, embedDim });

        const db = new Database(REG);
        const row = db.prepare(`SELECT db_pass FROM tenant_apps WHERE tenant_id=? AND app_id=?`).get(KCELL.customerId, KCELL.appId) as { db_pass: string | null };
        db.close();
        check('keychain backend: db_pass column is NULL (plaintext gone from registry)', row.db_pass === null);

        const inKeychain = await keytar.getPassword('groundfloor-lore.arcade', ref);
        check('keychain backend: secret present in OS keychain under secretRef', typeof inKeychain === 'string' && inKeychain.length > 0);

        const kt = issueToken({ tenantId: KCELL.customerId, appId: KCELL.appId, scopes: ['read', 'write'] }, { registryDbPath: REG });
        // arcadeCellForToken uses the synchronous readSecret; the keychain
        // backend answers via the store's async path in production (cell pool).
        // Here we assert the async readSecret resolves the keychain value.
        const { readSecretAsync } = await import('../packages/lore/src/engines/arcade/arcadeProvisioner.js');
        const resolved = await readSecretAsync(KCELL, { registryDbPath: REG });
        check('keychain backend: readSecretAsync resolves the keychain secret', resolved === inKeychain);
        void kt;

        try { await destroyApp(KCELL, { registryDbPath: REG }); } catch { /* best-effort */ }
        const afterDestroy = await keytar.getPassword('groundfloor-lore.arcade', ref);
        check('keychain backend: destroyApp purges the keychain secret', afterDestroy === null || afterDestroy === undefined);
      } finally {
        await keytar.deletePassword('groundfloor-lore.arcade', ref).catch(() => {});
        delete process.env['LORE_ARCADE_SECRET_BACKEND'];
        resetSecretStoreForTests();
        closeTokenDb();
        closeRegistryDb();
        for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(REG + s); } catch { /* ignore */ } }
      }
    }
  }

  console.log(`\n=== rotation e2e: ${pass} passed, ${fail} failed ===`);
  if (failures.length) { console.error('\nFAILURES:\n' + failures.join('\n')); process.exit(1); }
}

main().catch(async (e) => {
  console.error('FATAL:', e);
  await cleanup();
  process.exit(1);
});
