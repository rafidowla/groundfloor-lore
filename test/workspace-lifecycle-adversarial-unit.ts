#!/usr/bin/env tsx
/**
 * test/workspace-lifecycle-adversarial-unit.ts — rc4 workspace-lifecycle
 * audit (audit/rc4-workspace).
 *
 * Scope: workspace switch, retention sweep, sync push/pull. Hits the
 * live daemon at http://127.0.0.1:3847 with the bearer token. Every
 * test is designed to be safe against the baseline workspace — i.e.,
 * uses validation-only paths (no daemon exit, no real writes to live
 * data) unless explicitly creating a throwaway workspace first.
 *
 * Conventions:
 *   - Bearer token from lore-local-data/auth.token (path is fixed for
 *     this dev box; CI would inject via env).
 *   - Each phase's tests are tagged in the test name.
 *   - Findings are documented as comments above the assertion that
 *     proves the bug.
 *
 * Out of scope:
 *   - Backup/restore — CLI-only, no REST surface (documented gap).
 *   - Cross-workspace contamination tests that require triggering a
 *     real workspace switch — switch calls process.exit(0), so the
 *     daemon must be restarted by launchd; we test the validation +
 *     short-circuit paths that DON'T trigger exit, plus structural
 *     unit-test of switchWorkspace logic against a tmp registry.
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { backupWorkspace } from '../packages/lore/src/engines/backup.js';
import { restoreWorkspace } from '../packages/lore/src/engines/restore.js';

/** Recursively list every regular file under `root`. Returns absolute paths. */
function listFilesRecursive(root: string): string[] {
    const out: string[] = [];
    function walk(dir: string): void {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const abs = path.join(dir, e.name);
            if (e.isDirectory()) walk(abs);
            else if (e.isFile()) out.push(abs);
        }
    }
    walk(root);
    return out;
}

const DAEMON_URL = process.env.LORE_AUDIT_DAEMON_URL ?? 'http://127.0.0.1:3847';
const TOKEN_PATH = process.env.LORE_AUDIT_TOKEN_PATH
    ?? '/Users/rdowla/Downloads/AiDev/BitBucket/lore/lore-local-data/auth.token';

let TOKEN = '';
try { TOKEN = fs.readFileSync(TOKEN_PATH, 'utf8').trim(); }
catch { /* TOKEN stays empty; tests will skip gracefully */ }

let passed = 0;
let failed = 0;
let skipped = 0;

function test(name: string, fn: () => Promise<void>) {
    return (async () => {
        if (!TOKEN) {
            console.log(`  ⊘ ${name} — skipped (no bearer at ${TOKEN_PATH})`);
            skipped++;
            return;
        }
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
    })();
}

async function req(method: string, urlPath: string, body?: unknown): Promise<{ status: number; json: any; text: string }> {
    const init: RequestInit = {
        method,
        headers: {
            'Authorization': `Bearer ${TOKEN}`,
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    };
    const r = await fetch(`${DAEMON_URL}${urlPath}`, init);
    const text = await r.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, json, text };
}

async function getActiveWorkspaceName(): Promise<string> {
    const { json } = await req('GET', '/api/workspaces');
    return json?.active ?? '';
}

async function run() {
    console.log('\n=== rc4 workspace-lifecycle adversarial audit ===\n');

    /* ─── Phase 1: workspace switch ───────────────────────────── */

    /* Helper: wait for the daemon to restart after a switch.
     *
     * The switch route in mcp/http/routes/workspaces.ts:170 schedules
     * process.exit on a 150ms setTimeout — so for ~150ms AFTER the
     * 202 response, the OLD daemon is still serving requests on the
     * OLD workspace's substrate. A naive poll-until-200 returns
     * immediately and the next request hits the OLD daemon, reading
     * OLD substrate even though workspaces.json says the new active
     * workspace. The audit's first version of this helper had that
     * bug — it surfaced as "phantom cross-workspace contamination"
     * because the test's canary recall (after switching back to
     * the baseline workspace) actually hit the still-throwaway-substrate old
     * daemon and got the canary from throwaway's lance.
     *
     * Fix: sleep past the 150ms exit window first (so the OLD daemon
     * is definitely dying), THEN poll until /health is back up. */
    async function waitForDaemon(timeoutMs = 30_000): Promise<void> {
        // 250ms covers the 150ms setTimeout + epsilon for the actual
        // exit call. Conservative — the cost is one extra 250ms wait
        // per real switch, not per test.
        await new Promise((res) => setTimeout(res, 250));
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            try {
                const r = await fetch(`${DAEMON_URL}/health`);
                if (r.ok) return;
            } catch { /* daemon down — keep polling */ }
            await new Promise((res) => setTimeout(res, 250));
        }
        throw new Error(`daemon did not come back up within ${timeoutMs}ms`);
    }

    /* Helper: SAFE switch-back. The destructive bucket may be
     * exhausted by prior tests; retry on 429 with deterministic
     * sleeps until refill (1 token / 3s). Critical for finally
     * blocks: leaving the daemon on a throwaway workspace breaks
     * every subsequent test in the run and pollutes the operator's
     * baseline (this exact failure mode caused the audit's prior
     * "phantom contamination" finding — daemon was stuck on a
     * throwaway from a prior failed run). */
    async function safeSwitchBack(target: string, timeoutMs = 30_000): Promise<void> {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const current = await getActiveWorkspaceName();
            if (current === target) return;
            const r = await req('POST', '/api/workspaces/switch', { name: target });
            if (r.status === 202) {
                await waitForDaemon();
                return;
            }
            if (r.status === 429) {
                await new Promise((res) => setTimeout(res, 3500));
                continue;
            }
            // 200 (short-circuit) is fine; any other status is hard error
            if (r.status === 200) return;
            throw new Error(`safeSwitchBack: unexpected status ${r.status}: ${r.text}`);
        }
        throw new Error(`safeSwitchBack: could not return to '${target}' within ${timeoutMs}ms`);
    }

    /* Hard precondition: the daemon MUST be on the expected baseline
     * workspace before destructive tests run. If a prior run left the
     * daemon on a throwaway, the contamination test will write its
     * canary to the WRONG workspace and produce a false positive. */
    const BASELINE_WS = process.env.LORE_AUDIT_BASELINE_WS ?? 'workspace-a';
    {
        const baseline = await getActiveWorkspaceName();
        if (baseline !== BASELINE_WS) {
            throw new Error(
                `audit precondition failed: daemon active workspace is '${baseline}', `
                + `expected '${BASELINE_WS}'. Recover via: ` +
                `curl -H "Authorization: Bearer $TOKEN" -d '{"name":"${BASELINE_WS}"}' ` +
                `${DAEMON_URL}/api/workspaces/switch  (then wait for respawn)`,
            );
        }
    }

    /* Order matters in this phase: the destructive (real-switch)
     * tests run FIRST while the destructive rate-limit bucket
     * (capacity 5, refill 20/min per rateLimit.ts:66) is fresh.
     * Each real switch triggers daemon process.exit + launchd
     * respawn which RESETS the in-memory bucket. The validation
     * tests below (5 × POST /switch returning 400) each burn a
     * destructive token but land on a bucket freshly reset by the
     * second destructive test's switch-back. Net: every test in
     * this phase lands with a usable bucket. */

    await test('[P1] switch + switch-back: no cross-workspace contamination (CRITICAL path)', async () => {
        // Audit goal: "switch to a workspace with different plugins;
        // verify stale connections + caches + plugin ctx flush
        // cleanly. Cross-workspace contamination = CRITICAL."
        //
        // Real-trigger E2E. Creates a throwaway workspace, switches
        // to it (daemon exits + launchd restarts), writes a CANARY
        // node, switches back, then asserts the canary is NOT
        // visible from the original workspace's recall/search.
        //
        // Safeguards: each wait is bounded; on any failure we still
        // attempt to switch back to the original workspace + delete
        // the throwaway via finally.
        const originalActive = await getActiveWorkspaceName();
        if (!originalActive) {
            throw new Error('no active workspace — cannot run switch test safely');
        }
        const throwawayName = `rc4-audit-throwaway-${Date.now()}`;
        const canaryId = `rc4-switch-canary-${Date.now()}`;
        let createdThrowaway = false;
        try {
            // 1) Create throwaway workspace.
            const create = await req('POST', '/api/workspaces', { name: throwawayName });
            assert.equal(create.status, 201, `create throwaway: ${create.status} ${create.text}`);
            createdThrowaway = true;

            // 2) Switch to throwaway — daemon will exit ~150ms later.
            const sw1 = await req('POST', '/api/workspaces/switch', { name: throwawayName });
            assert.equal(sw1.status, 202, `switch to throwaway: ${sw1.status}`);
            assert.equal(sw1.json?.restarting, true);
            await waitForDaemon();

            // 3) Verify we are on throwaway, then write the canary.
            const onThrowaway = await getActiveWorkspaceName();
            assert.equal(onThrowaway, throwawayName, `expected daemon on '${throwawayName}', got '${onThrowaway}'`);
            const canaryWrite = await req('POST', '/api/node', {
                id: canaryId,
                type: 'note',
                label: 'rc4 switch canary',
                content: `CANARY-CONTENT-${canaryId}-this-should-only-exist-in-throwaway`,
                tags: 'rc4,canary,must-not-leak',
                project: '*', ecosystem: '*', metadata: '{}',
            });
            assert.ok(canaryWrite.status >= 200 && canaryWrite.status < 300, `canary write status ${canaryWrite.status}`);

            // 4) Switch back to original.
            const sw2 = await req('POST', '/api/workspaces/switch', { name: originalActive });
            assert.equal(sw2.status, 202);
            await waitForDaemon();

            // 5) Verify we are back on original.
            const onOrig = await getActiveWorkspaceName();
            assert.equal(onOrig, originalActive, `expected daemon back on '${originalActive}', got '${onOrig}'`);

            // 6) CRITICAL ASSERTION — canary must NOT be visible from
            //    the original workspace via any read surface.
            const recallCheck = await req('GET', `/api/recall?topic=${encodeURIComponent('CANARY-CONTENT')}&max=10`);
            assert.equal(recallCheck.status, 200);
            const recallResults = recallCheck.json?.results ?? [];
            const leaked = recallResults.find((r: any) => r?.id === canaryId);
            assert.equal(leaked, undefined, `CROSS-WORKSPACE CONTAMINATION — canary ${canaryId} from throwaway visible in ${originalActive} recall`);

            const nodeCheck = await req('GET', `/api/node?id=${encodeURIComponent(canaryId)}`);
            // Either 404 or "not found" payload — must NOT return the canary content.
            if (nodeCheck.status === 200 && nodeCheck.json?.node) {
                assert.fail(`CROSS-WORKSPACE CONTAMINATION — /api/node returned canary from throwaway: ${JSON.stringify(nodeCheck.json).slice(0, 200)}`);
            }
        } finally {
            // Best-effort recovery: ensure we end up on the original
            // workspace + delete the throwaway. Won't throw — even if
            // anything failed, leaving the baseline workspace in a sane state matters
            // more than reporting cleanup errors.
            try { await safeSwitchBack(originalActive); } catch { /* */ }
            if (createdThrowaway) {
                try {
                    await req('DELETE', `/api/workspaces/${encodeURIComponent(throwawayName)}`);
                } catch { /* */ }
            }
        }
    });

    await test('[P1] switch-under-load: concurrent reads complete or fail cleanly, no daemon hang', async () => {
        // Audit goal: "switch under load". 10 concurrent recall calls
        // immediately followed by a switch trigger. Some recalls may
        // complete before the exit; others will see ECONNRESET (200ms
        // exit window). The contract under test:
        //  - the switch itself succeeds (202),
        //  - the daemon comes back up on the new workspace,
        //  - no recall causes a 500 or daemon-side hang.
        // Same safeguards as the contamination test.
        const originalActive = await getActiveWorkspaceName();
        if (!originalActive) throw new Error('no active workspace');
        const throwawayName = `rc4-audit-load-${Date.now()}`;
        let createdThrowaway = false;
        try {
            await req('POST', '/api/workspaces', { name: throwawayName });
            createdThrowaway = true;

            // Fire 10 concurrent recalls in-flight, then race a switch.
            const loadPromises = Array.from({ length: 10 }, (_, i) =>
                req('GET', `/api/recall?topic=load-${i}&max=3`).then(
                    (r) => ({ ok: true, status: r.status }),
                    (e) => ({ ok: false, error: (e as Error).message }),
                ),
            );
            // Tiny pause so the recalls actually hit the wire before
            // we trigger the exit.
            await new Promise((r) => setTimeout(r, 25));

            const sw = await req('POST', '/api/workspaces/switch', { name: throwawayName });
            assert.equal(sw.status, 202, 'switch under load must still 202 cleanly');

            // Concurrent recalls either completed (200) or got a
            // network-level error (daemon dying mid-request). Neither
            // is a 5xx; a 5xx would indicate the route panicked.
            const results = await Promise.all(loadPromises);
            for (const r of results) {
                if (r.ok) {
                    assert.ok(
                        r.status < 500 || r.status === 503,
                        `recall under load returned 5xx (got ${r.status}); shouldn't panic mid-shutdown`,
                    );
                }
                // !r.ok = fetch threw (ECONNRESET / undici socket
                // hangup) — that's expected when the daemon exits
                // mid-response; the client must handle it. No assert.
            }

            await waitForDaemon();
            assert.equal(await getActiveWorkspaceName(), throwawayName, 'daemon must be on throwaway after load+switch');
        } finally {
            try { await safeSwitchBack(originalActive); } catch { /* */ }
            if (createdThrowaway) {
                try { await req('DELETE', `/api/workspaces/${encodeURIComponent(throwawayName)}`); } catch { /* */ }
            }
        }
    });

    await test('[P1] switch: empty body returns 400', async () => {
        const { status, json } = await req('POST', '/api/workspaces/switch', '');
        assert.equal(status, 400, `expected 400, got ${status}`);
        assert.ok(json?.error, 'error message expected on 400');
    });

    await test('[P1] switch: missing `name` returns 400 — does NOT exit daemon', async () => {
        const before = await getActiveWorkspaceName();
        const { status, json } = await req('POST', '/api/workspaces/switch', { foo: 'bar' });
        assert.equal(status, 400, `expected 400, got ${status}`);
        assert.match(json?.error ?? '', /name required/i);
        // If the validation path leaked through to process.exit(),
        // the next request would hang / connection-reset.
        const after = await getActiveWorkspaceName();
        assert.equal(after, before, 'daemon should still be alive on the same workspace');
    });

    await test('[P1] switch: unknown workspace name returns 400 — does NOT exit daemon', async () => {
        // FINDING (audit 2026-05-18): switchWorkspace at workspaces.ts:182
        // validates membership BEFORE writing or exiting; an unknown
        // name throws, the route catches and returns 400. Confirmed
        // here as a regression guard — if anyone reorders the
        // validation/exit sequence in the future, this test catches it.
        const before = await getActiveWorkspaceName();
        const bogus = `audit-rc4-nonexistent-${Date.now()}`;
        const { status } = await req('POST', '/api/workspaces/switch', { name: bogus });
        assert.equal(status, 400, `expected 400 for unknown workspace, got ${status}`);
        const after = await getActiveWorkspaceName();
        assert.equal(after, before, 'unknown-workspace switch must NOT trigger daemon exit');
    });

    await test('[P1] switch: name === currently-active short-circuits (no exit)', async () => {
        const active = await getActiveWorkspaceName();
        if (!active) {
            console.log(`    (note: no active workspace; skipping short-circuit assertion)`);
            return;
        }
        const { status, json } = await req('POST', '/api/workspaces/switch', { name: active });
        assert.equal(status, 200, `expected 200 for no-op switch, got ${status}`);
        assert.equal(json?.restarting, false, 'no-op switch must report restarting:false');
        // Verify daemon is still up
        const still = await getActiveWorkspaceName();
        assert.equal(still, active);
    });

    await test('[P1] switch: malformed JSON returns 400 — does NOT exit daemon', async () => {
        // After the prior 4 switch-validation tests, the destructive
        // rate-limit bucket (capacity 5, refill 1 token / 3s) has 0–1
        // tokens. Sleep one refill cycle so this 5th destructive call
        // lands on a non-empty bucket and exercises the 400 path
        // instead of the 429 short-circuit.
        await new Promise((r) => setTimeout(r, 3500));
        const before = await getActiveWorkspaceName();
        const { status } = await req('POST', '/api/workspaces/switch', '{not-json');
        assert.equal(status, 400);
        const after = await getActiveWorkspaceName();
        assert.equal(after, before);
    });

    await test('[P1] rename: missing oldName/newName returns 400', async () => {
        const { status, json } = await req('POST', '/api/workspaces/rename', { oldName: 'x' });
        assert.equal(status, 400);
        assert.match(json?.error ?? '', /oldName and newName required/i);
    });

    /* ─── Phase 2: retention sweep ────────────────────────────── */

    await test('[P2] retention: GET active policy returns valid shape', async () => {
        const { status, json } = await req('GET', '/api/workspace/retention');
        assert.equal(status, 200);
        assert.ok(typeof json === 'object' && json !== null, 'policy object expected');
        // Schema fields per workspaces.ts WorkspaceRetentionPolicy
        for (const k of ['hideSupersededInRecall', 'hideSupersededInGraph', 'autoArchiveSupersededAfterDays']) {
            assert.ok(k in json, `expected '${k}' field in policy, got: ${Object.keys(json).join(', ')}`);
        }
    });

    await test('[P2] retention: PUT with arbitrary unrecognized fields is accepted (silent ignore)', async () => {
        // FINDING (audit 2026-05-18): setWorkspaceRetention does a
        // shallow spread of the patch onto the existing policy. Unknown
        // keys are silently retained on disk. Severity 🟢 — no
        // correctness impact (the runtime only reads known keys) but
        // grows the JSON over time + masks typos. Documented; no fix
        // shipped this branch.
        const before = await req('GET', '/api/workspace/retention');
        const { status } = await req('PUT', '/api/workspace/retention', {
            zzz_audit_rc4_unknown_field: 'should be rejected or warned',
        });
        assert.equal(status, 200, 'PUT currently accepts unknown keys (silent ignore)');
        const after = await req('GET', '/api/workspace/retention');
        // Document the observed behavior — assertion is on the actual
        // behavior so the test passes today but pins the contract.
        const wroteUnknown = JSON.stringify(after.json).includes('zzz_audit_rc4_unknown_field');
        if (wroteUnknown) {
            console.log('    [finding 🟢] retention PUT silently persists unknown keys; consider strict validation in rc4.1');
            // Clean up the noise we wrote so the live baseline workspace policy isn't
            // permanently polluted by the audit run.
            await req('PUT', '/api/workspace/retention', {
                hideSupersededInRecall: before.json?.hideSupersededInRecall,
                hideSupersededInGraph: before.json?.hideSupersededInGraph,
                autoArchiveSupersededAfterDays: before.json?.autoArchiveSupersededAfterDays,
            });
        }
    });

    await test('[P2] retention sweep: dryRun=true returns counts without writes', async () => {
        const before = await req('GET', '/api/stats');
        const { status, json } = await req('POST', '/api/workspace/retention/sweep', { dryRun: true });
        assert.equal(status, 200);
        // result shape per RetentionEngine.runSweep — fields vary, just
        // assert it didn't crash and returned an object.
        assert.ok(typeof json === 'object' && json !== null, `sweep result must be an object; got ${typeof json}`);
        const after = await req('GET', '/api/stats');
        // Compare node counts to confirm dry-run didn't actually
        // tombstone anything.
        const beforeCount = before.json?.nodeCount ?? before.json?.totalNodes ?? null;
        const afterCount = after.json?.nodeCount ?? after.json?.totalNodes ?? null;
        if (beforeCount !== null && afterCount !== null) {
            assert.equal(afterCount, beforeCount, `dryRun must not change node count (was ${beforeCount}, now ${afterCount})`);
        }
    });

    await test('[P2] SIGKILL mid-write: workspace dir survives, no orphan partial files', async () => {
        // The audit goal asks: "SIGKILL the daemon mid-sweep; verify
        // resume or clean abort. Orphaned files = CRITICAL."
        //
        // The strict scenario (mid-sweep) is hard to time because
        // baseline-workspace sweeps complete in <100ms. The broader property we
        // care about is that ANY mid-write SIGKILL doesn't leave the
        // workspace in a corrupt state — the substrate engines
        // (Kùzu WAL, LanceDB MVCC, SQLite WAL) all advertise crash
        // recovery, this test verifies the file-system-level claim:
        // no partial-write tmp files (.tmp, .partial, .lock) outside
        // documented WAL/manifest patterns.
        const { spawn, spawnSync } = await import('node:child_process');
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-rc4-sigkill-'));
        try {
            const wsDir = path.join(tmp, 'workspace');
            fs.mkdirSync(wsDir, { recursive: true });

            const fixture = path.resolve('test/fixtures/rc4-sigkill-writer.ts');
            // detached:true creates a new process group; killing the
            // group via process.kill(-pid) propagates to grandchildren.
            // Otherwise `child.kill` only signals npx, leaving the
            // node-tsx writer orphaned (this exact bug accumulated 6×
            // CPU-pegged zombies during prior audit runs and starved
            // the daemon enough to make all subsequent tests
            // fetch-fail).
            const child = spawn('npx', ['tsx', fixture, wsDir], {
                stdio: ['ignore', 'pipe', 'pipe'],
                detached: true,
            });
            let lastCount = 0;
            child.stdout?.on('data', (chunk: Buffer) => {
                const m = /(\d+)/g.exec(chunk.toString().trim().split('\n').pop() ?? '');
                if (m) lastCount = Number(m[1]);
            });

            // Wait until the child has done at least one batch of
            // writes (proven by lastCount > 0). Time-bounded so
            // a stuck child doesn't hang the test.
            const startWait = Date.now();
            while (lastCount === 0 && Date.now() - startWait < 30_000) {
                await new Promise((r) => setTimeout(r, 100));
            }
            assert.ok(lastCount > 0, `child failed to make progress within 30s (lastCount=${lastCount})`);

            // SIGKILL the whole process group — the brutal kill.
            // Equivalent to OS killing the daemon mid-work; no chance
            // for graceful shutdown. -pid means "process group pid".
            try { process.kill(-child.pid!, 'SIGKILL'); }
            catch { /* group already gone */ }
            // Wait for the lead process to actually exit.
            await new Promise<void>((resolve) => {
                child.on('exit', () => resolve());
                setTimeout(resolve, 5000);
            });
            // Belt-and-suspenders: pkill any survivor matching the
            // exact fixture path. Avoids zombie writers compounding
            // across audit runs.
            spawnSync('pkill', ['-9', '-f', fixture], { stdio: 'ignore' });

            // Workspace integrity check — no parent-side graph open (keeps
            // the assertion purely file-system-level regardless of engine).
            // The .lore/ dir exists, and no obviously orphan partial files
            // are present.
            const loreDir = path.join(wsDir, '.lore');
            assert.ok(fs.existsSync(loreDir), '.lore/ must exist after SIGKILL');

            const allFiles = listFilesRecursive(loreDir);
            assert.ok(allFiles.length > 0, '.lore/ must have substrate files after writes');

            const orphans = allFiles.filter((f) => {
                const base = path.basename(f);
                // The whole SurrealDB store directory (.lore/surreal/) is
                // opaque backend-owned storage — surrealkv/rocksdb SST
                // files, WAL, LOCK, MANIFEST, CURRENT, etc. — whose naming
                // isn't ours to police here (surrealDataPath in
                // engines/surreal/surrealConnection.ts).
                if (f.includes('/surreal/')) return false;
                if (base.endsWith('.json')) return false;
                if (f.includes('/lancedb/') && (base.endsWith('.lance') || base.endsWith('.bin') || base.endsWith('.json') || base === '_versions' || base.endsWith('.manifest'))) return false;
                // Anything else with a partial-write suffix is orphan
                return /\.(tmp|partial|swap|crdownload)$/.test(base) || base.startsWith('.~');
            });
            assert.deepEqual(
                orphans, [],
                `SIGKILL mid-write left orphan partial files: ${orphans.map((f) => path.relative(loreDir, f)).join(', ')}`,
            );

            // Sanity: run `du -s` to confirm the dir isn't somehow
            // wedged at 0 bytes (which would suggest a deeper failure
            // even if no orphans are detectable by suffix).
            const du = spawnSync('du', ['-s', loreDir]);
            const sizeBytes = Number(du.stdout.toString().trim().split(/\s+/)[0]);
            assert.ok(sizeBytes > 0, `.lore/ must contain data after writes (du -s reported ${sizeBytes})`);
        } finally {
            try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
        }
    });

    await test('[P2] retention sweep with delete-everything policy: rejects negative threshold OR completes safely', async () => {
        // The audit goal: "Sweep with rules that delete everything".
        // The retention API exposes autoArchiveSupersededAfterDays
        // (null/0/<0 = "disabled"). A naive operator might set this
        // to 0 hoping to archive everything immediately. Verify the
        // route either rejects clearly or treats 0 as "disabled" (no
        // surprise mass delete).
        const before = await req('GET', '/api/workspace/retention');
        try {
            const { status: putStatus } = await req('PUT', '/api/workspace/retention', {
                autoArchiveSupersededAfterDays: 0,
            });
            assert.equal(putStatus, 200, 'setting threshold=0 should be accepted (means "disabled" per spec)');
            // Sweep with threshold=0 must complete and report zero
            // archives (per services.ts:530 — threshold<=0 short-circuits).
            const { status: sweepStatus, json: sweep } = await req('POST', '/api/workspace/retention/sweep', { dryRun: false });
            assert.equal(sweepStatus, 200);
            assert.equal(sweep?.archived ?? 0, 0, `threshold=0 must NOT mass-archive (got archived=${sweep?.archived})`);
            assert.equal(sweep?.eligible ?? 0, 0, `threshold=0 must yield 0 eligible (got eligible=${sweep?.eligible})`);
        } finally {
            // Restore the original policy so the audit doesn't drift the baseline workspace.
            await req('PUT', '/api/workspace/retention', {
                hideSupersededInRecall: before.json?.hideSupersededInRecall,
                hideSupersededInGraph: before.json?.hideSupersededInGraph,
                autoArchiveSupersededAfterDays: before.json?.autoArchiveSupersededAfterDays,
            });
        }
    });

    await test('[P2] retention sweep: malformed body returns 400 (parser error, not 500)', async () => {
        // REGRESSION (fixed audit/rc4-workspace, retention.ts): the
        // route used to wrap JSON.parse and runRetentionSweep in the
        // same try/catch, so malformed JSON surfaced as 500 with the
        // parser's message — confusingly attributing client errors to
        // the server. Now parsed separately; bad JSON returns 400.
        const { status, json } = await req('POST', '/api/workspace/retention/sweep', '{not-json');
        assert.equal(status, 400, `malformed sweep body must be 400 (client error), got ${status}`);
        assert.match(json?.error ?? '', /malformed JSON/i);
    });

    /* ─── Phase 3: sync push/pull ─────────────────────────────── */

    await test('[P3] sync status: returns walPending + lastSync without throwing', async () => {
        const { status, json } = await req('GET', '/api/sync/status');
        assert.equal(status, 200);
        assert.ok(json !== null, 'status response must be JSON');
        // Core fields per sync.ts contract
        for (const k of ['walPending', 'lastSync', 'hasAdapter']) {
            assert.ok(k in json, `expected '${k}' in sync status, got: ${Object.keys(json).join(', ')}`);
        }
    });

    await test('[P3] sync push: returns ok-shape even when no adapter or no pending', async () => {
        const { status, json } = await req('POST', '/api/sync/push', {});
        // Airplane-safe contract: push when no adapter returns 200 with
        // ok:false + error, not 5xx.
        assert.equal(status, 200, `push must be 200 even in degraded mode, got ${status}`);
        assert.ok('ok' in json, 'push response must have `ok` field');
    });

    await test('[P3] sync pull: returns 200 even when no adapter (airplane-safe)', async () => {
        const { status, json } = await req('POST', '/api/sync/pull', {});
        assert.equal(status, 200, `pull must be 200 in degraded mode, got ${status}`);
        assert.ok('ok' in json, 'pull response must have `ok` field');
    });

    await test('[P3] sync routes are bearer-gated (no bearer → 401)', async () => {
        // FINDING (audit 2026-05-18): sync.ts routes don't call
        // gateRoute() — auth is provided by middleware.ts upstream.
        // This test pins the upstream guard so a future refactor that
        // moves dispatcher.ts can't accidentally drop bearer auth on
        // the sync endpoints.
        const r = await fetch(`${DAEMON_URL}/api/sync/status`); // no Authorization header
        assert.equal(r.status, 401, `bare /api/sync/status must require bearer; got ${r.status}`);
    });

    /* ─── Phase 4: backup/restore ─────────────────────────────── */

    await test('[P4] backup/restore: REST surface is absent (documented gap)', async () => {
        const checks = await Promise.all([
            req('POST', '/api/backup', {}).then((r) => r.status),
            req('POST', '/api/workspace/backup', {}).then((r) => r.status),
            req('POST', '/api/restore', {}).then((r) => r.status),
            req('POST', '/api/workspace/restore', {}).then((r) => r.status),
        ]);
        for (const s of checks) {
            assert.equal(s, 404, `backup/restore REST surface should not exist (got ${s}); CLI-only by design — see Lore node rc4-backup-restore-no-rest-surface`);
        }
    });

    // Phase 4 library-level adversarial coverage. Backup/restore is
    // exposed via packages/lore/src/cli/commands/{backup,restore}.ts
    // wrapping the engines/{backup,restore}.ts functions; the CLI is
    // the real surface. Exercising the library directly is the
    // adversarial equivalent of what an HTTP audit would do — we
    // can't probe the route because the route doesn't exist.

    await test('[P4] backupWorkspace: missing workspace dir throws cleanly (no partial tarball)', async () => {
        // Adversarial: caller passes a wsDir that doesn't exist on
        // disk. Expectation: hard error before any staging or
        // tarball-create work. Anything else risks emitting a
        // truncated tarball that operators might mistake for valid.
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-rc4-backup-'));
        try {
            const outDir = path.join(tmp, 'out');
            fs.mkdirSync(outDir, { recursive: true });
            const bogus = path.join(tmp, 'does-not-exist');
            await assert.rejects(
                backupWorkspace({ workspaceDir: bogus, workspaceName: 'rc4-test', outDir }),
                /workspace dir not found/i,
                'backup with missing workspaceDir must throw with a clear message',
            );
            const produced = fs.readdirSync(outDir);
            assert.equal(produced.length, 0, `failed backup must not leave artifacts in outDir; found: ${produced.join(', ')}`);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    await test('[P4] backup→wipe→restore round-trip: file-level bit-identical', async () => {
        // E2E round-trip via the engines/{backup,restore}.ts library.
        // Verifies the restored .lore/ has the same byte content as
        // the source — this is the "bit-identical" check the audit
        // goal calls for. Done at the filesystem level (not by
        // opening Kùzu/LanceDB on both sides) because kuzu-lite native
        // bindings segfault on repeated open/close cycles in one
        // process; production never does that (each daemon is its
        // own process), but unit tests can't safely cycle. The file-
        // level hash comparison is actually stronger than opening +
        // counting because it catches sidecar/index drift too.
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-rc4-roundtrip-'));
        try {
            // 1) Build a source .lore/ directly on disk with all three
            //    substrate file shapes plus a sidecar config.
            const srcDir = path.join(tmp, 'src');
            const srcLore = path.join(srcDir, '.lore');
            fs.mkdirSync(srcLore, { recursive: true });
            fs.writeFileSync(path.join(srcLore, 'graph'), Buffer.from('synthetic-kuzu-bytes-for-round-trip-AAA'));
            fs.writeFileSync(path.join(srcLore, 'graph.wal'), Buffer.from('synthetic-wal-BBB'));
            // SQLite file: backup uses better-sqlite3's online .backup
            // API, so the file must be a valid SQLite db.
            const Database = (await import('better-sqlite3')).default;
            const db = new Database(path.join(srcLore, 'tables.sqlite'));
            db.exec('CREATE TABLE rt (id INTEGER PRIMARY KEY, v TEXT)');
            const insert = db.prepare('INSERT INTO rt (id, v) VALUES (?, ?)');
            for (let i = 0; i < 25; i++) insert.run(i, `row-${i}`);
            db.close();
            // LanceDB shaped directory.
            fs.mkdirSync(path.join(srcLore, 'lancedb', 'lore_verbatim.lance'), { recursive: true });
            fs.writeFileSync(path.join(srcLore, 'lancedb', 'lore_verbatim.lance', 'data.bin'), Buffer.from('synthetic-lance-CCC'));
            fs.writeFileSync(path.join(srcLore, 'lancedb', 'lore_verbatim.lance', 'manifest.json'), '{"v":1}');
            // Sidecar.
            fs.writeFileSync(path.join(srcLore, 'config.json'), '{"k":"v","seed":"round-trip"}');

            const srcFiles = listFilesRecursive(srcLore);
            assert.ok(srcFiles.length >= 5, `source workspace should have multiple files; got ${srcFiles.length}`);

            // 2) Backup.
            const backupOut = path.join(tmp, 'backups');
            fs.mkdirSync(backupOut, { recursive: true });
            const backup = await backupWorkspace({
                workspaceDir: srcDir, workspaceName: 'rt-test', outDir: backupOut,
            });
            assert.ok(backup.bytesWritten > 0);

            // 3) "Wipe a copy" — restore into a fresh dest dir.
            const destDir = path.join(tmp, 'dest');
            fs.mkdirSync(destDir, { recursive: true });
            const restore = await restoreWorkspace({
                tarballPath: backup.tarballPath, workspaceDir: destDir,
            });
            assert.equal(restore.sidelinedPriorTo, null, 'fresh dest must report null sidelinedPriorTo');

            // 4) Verify every source file exists in the restored copy
            //    with bit-identical content (graph, graph.wal, sqlite,
            //    lance/data.bin, lance/manifest.json, config.json). This
            //    is the "bit-identical" assertion the audit goal asks
            //    for, made stronger than just counts because it catches
            //    every byte not just the row totals.
            const destLore = path.join(destDir, '.lore');
            const destFiles = listFilesRecursive(destLore);
            const srcRel = new Set(srcFiles.map((f) => path.relative(srcLore, f)).sort());
            const dstRel = new Set(destFiles.map((f) => path.relative(destLore, f)).sort());
            for (const rel of srcRel) {
                assert.ok(dstRel.has(rel), `restored .lore/ missing file: ${rel}`);
                const srcBytes = fs.readFileSync(path.join(srcLore, rel));
                const dstBytes = fs.readFileSync(path.join(destLore, rel));
                // SQLite's online backup may write a slightly different
                // page layout but the row data must be queryable; for
                // synthetic .sqlite without page-layout dependencies it
                // round-trips byte-identical too, so we compare bytes
                // on all files.
                assert.equal(
                    srcBytes.length, dstBytes.length,
                    `restored ${rel} size ${dstBytes.length} != source ${srcBytes.length}`,
                );
                assert.deepEqual(srcBytes, dstBytes, `restored ${rel} content drift`);
            }
        } finally {
            try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
        }
    });

    await test('[P4] restore over existing workspace: sidelines prior .lore/ (no silent overwrite)', async () => {
        // Adversarial: restore target already has live data. Contract
        // (restore.ts:65-72): sideline existing .lore/ to a timestamped
        // sibling before moving staged into place. The operator can
        // roll back manually if the restored data is wrong.
        //
        // Synthetic substrate files (not real Kùzu/LanceDB) — the
        // contract under test is restore.ts's sidelining logic, not
        // the substrates. Using real engines here would trigger the
        // kuzu-lite repeated-open SIGSEGV (see round-trip test).
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-rc4-overlay-'));
        try {
            // 1) Build a source .lore/ + tarball.
            const srcDir = path.join(tmp, 'src');
            const srcLore = path.join(srcDir, '.lore');
            fs.mkdirSync(srcLore, { recursive: true });
            fs.writeFileSync(path.join(srcLore, 'graph'), Buffer.from('from-source-graph'));
            const Database = (await import('better-sqlite3')).default;
            const sdb = new Database(path.join(srcLore, 'tables.sqlite'));
            sdb.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
            sdb.prepare('INSERT INTO t (id, v) VALUES (?, ?)').run(1, 'source-marker');
            sdb.close();
            fs.mkdirSync(path.join(srcLore, 'lancedb', 'lore_verbatim.lance'), { recursive: true });
            fs.writeFileSync(path.join(srcLore, 'lancedb', 'lore_verbatim.lance', 'data.bin'), Buffer.from('source-lance'));
            fs.writeFileSync(path.join(srcLore, 'config.json'), '{"marker":"source"}');

            const backupOut = path.join(tmp, 'backups');
            fs.mkdirSync(backupOut, { recursive: true });
            const backup = await backupWorkspace({
                workspaceDir: srcDir, workspaceName: 'overlay', outDir: backupOut,
            });

            // 2) Build "live" destination workspace with distinct
            //    markers so we can tell post-restore which side wins.
            const destDir = path.join(tmp, 'dest');
            const destLore = path.join(destDir, '.lore');
            fs.mkdirSync(destLore, { recursive: true });
            const liveMarkerPath = path.join(destLore, 'live-marker.txt');
            fs.writeFileSync(liveMarkerPath, 'i-am-the-live-workspace');
            fs.writeFileSync(path.join(destLore, 'config.json'), '{"marker":"live"}');

            // 3) Restore over.
            const restore = await restoreWorkspace({
                tarballPath: backup.tarballPath,
                workspaceDir: destDir,
            });
            assert.ok(restore.sidelinedPriorTo, 'sidelinedPriorTo must be set when prior .lore/ existed');
            assert.ok(
                fs.existsSync(restore.sidelinedPriorTo!),
                `sidelined dir must exist on disk at ${restore.sidelinedPriorTo}`,
            );
            const sidelinedBase = path.basename(restore.sidelinedPriorTo!);
            assert.match(sidelinedBase, /^\.lore\.pre-restore-/, 'sideline name must follow the documented convention');

            // 4) Live marker must survive — in the sidelined dir, not destLore.
            const sidelinedLiveMarker = path.join(restore.sidelinedPriorTo!, 'live-marker.txt');
            assert.ok(fs.existsSync(sidelinedLiveMarker), 'live-marker must be preserved in sidelined dir');
            assert.equal(
                fs.readFileSync(sidelinedLiveMarker, 'utf8'),
                'i-am-the-live-workspace',
            );

            // 5) Restored .lore/ must have the SOURCE config, not the live one.
            const restoredConfig = fs.readFileSync(path.join(destLore, 'config.json'), 'utf8');
            assert.match(restoredConfig, /"source"/, 'restored .lore/config.json must come from the source backup');
            assert.doesNotMatch(restoredConfig, /"live"/, 'restored .lore/config.json must NOT contain the pre-restore live marker');

            // 6) Live marker must NOT be in the restored .lore/ (it
            //    moved to the sidelined dir).
            assert.ok(!fs.existsSync(liveMarkerPath), 'live-marker.txt must be removed from .lore/ after restore (now sidelined)');
        } finally {
            try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
        }
    });

    await test('[P4] restoreWorkspace: corrupted tarball is rejected (no partial restore)', async () => {
        // Adversarial: operator points restore at a file that is
        // present but not a valid Lore backup (corrupt bytes, wrong
        // format). Expectation: the function rejects cleanly without
        // sidelining the existing .lore/ — otherwise an operator who
        // restores from a bad backup loses the live workspace AND
        // gets nothing back.
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-rc4-restore-'));
        try {
            const wsDir = path.join(tmp, 'workspace');
            const liveLore = path.join(wsDir, '.lore');
            fs.mkdirSync(liveLore, { recursive: true });
            const sentinel = path.join(liveLore, 'sentinel.txt');
            fs.writeFileSync(sentinel, 'live-data-should-not-disappear');

            // Write a "tarball" that isn't actually a tar — random
            // bytes ending in .tar.gz.
            const corruptTarball = path.join(tmp, 'corrupt.tar.gz');
            fs.writeFileSync(corruptTarball, Buffer.from('not a real tarball, just bytes'));

            // Error message contract (set in restore.ts after this
            // audit): bad tarballs reject with "failed to extract
            // backup tarball" plus tar's own stderr diagnostic. Pins
            // the operator-actionable form against future regressions.
            await assert.rejects(
                restoreWorkspace({ tarballPath: corruptTarball, workspaceDir: wsDir }),
                /failed to extract backup tarball/i,
                'corrupt tarball must be rejected with an operator-actionable message',
            );

            // Live data must still be present and untouched. (If
            // sidelining happened before the validity check, the
            // sentinel would be gone or at a .pre-restore- path.)
            assert.ok(fs.existsSync(sentinel), 'live .lore/ contents must survive a rejected restore');
            const siblings = fs.readdirSync(wsDir);
            const sidelined = siblings.find((n) => n.startsWith('.lore.pre-restore-'));
            assert.equal(
                sidelined, undefined,
                `corrupt-tarball restore must not sideline the live .lore/ — found sidelined dir ${sidelined}`,
            );
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped\n`);
    if (failed > 0) process.exit(1);
}

run().catch((err) => { console.error(err); process.exit(1); });
