#!/usr/bin/env tsx
/**
 * model-server-meta-models-e2e-unit.ts — D9 (3.24 slice C3a), gap fix #2:
 * proves `_meta.models` end-to-end through a REAL `createLore(...).recall()`
 * call, not just at the `withModelStatusMeta()` unit level.
 *
 * Two scenarios, each run in its OWN self-forked child process:
 *
 *   - 'healthy': an eligible `createLore()` instance actually reaches
 *     `modelStatus().mode === 'shared'` (a real cold model-server boot,
 *     generous budgets) and its `recall()` output must be byte-identical
 *     (deep-equal) to a `modelServer:false` control instance's output —
 *     i.e. no `_meta.models` leaks into the default/healthy path.
 *   - 'fallback': deliberately too-tight budgets (mirroring the
 *     "unspawnable-within-budget" pattern in
 *     model-server-client-lifecycle-unit.ts) force a loud shared->fallback
 *     transition on the FIRST embed call inside `bulkIngest`. While in
 *     fallback, `recall()` must carry `_meta.models = {served_by:
 *     'in_process_fallback', reason, since}`, `modelStatus()` must report
 *     'fallback', `onModelStatus` must have fired the transition exactly
 *     once, and exactly one `log.error` must announce it (client.ts's
 *     `transitionToFallback` only logs on the shared->fallback edge, never
 *     on repeat calls already in fallback — see its `wasShared` guard).
 *     The detached spawn from that failed first attempt keeps booting in
 *     the background; once the recovery probe (bounded by `probeMs`) picks
 *     it up, status flips back to 'shared' and `_meta.models` disappears
 *     again on the next `recall()`.
 *
 * Split into subprocesses because `modelServer/applicability.ts` freezes
 * its budget constants (`MODEL_SERVER_CLIENT_READY_MS` etc.) at MODULE
 * IMPORT time via top-level `parseEnvInt(...)` calls — one process cannot
 * run a "generous" scenario and a "tiny budget" scenario back to back
 * against the same imported module graph. Each child sets its own env
 * BEFORE importing `mcp/server.ts`'s module graph for the first time.
 *
 * Run: npx tsx test/model-server-meta-models-e2e-unit.ts
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const THIS_FILE = fileURLToPath(import.meta.url);
const SCENARIO = process.env.__MS_META_SCENARIO as 'healthy' | 'fallback' | undefined;

function mkHome(tag: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), `ms-meta-${tag}-`));
}

const NODE_CONTENT = 'the quick brown fox jumps over the lazy dog near the riverbank';
function ingestNode(id: string) {
    return { id, workspace: 'default', ecosystem: '*', nodeData: { id, type: 'note', label: id, content: NODE_CONTENT, project: 'default', ecosystem: '*' } };
}

// ── Child scenarios ─────────────────────────────────────────────────────

async function runHealthy(): Promise<void> {
    process.env.LORE_MODEL_SERVER = '1';
    process.env.LORE_MODEL_SERVER_READY_MS ??= '25000';
    process.env.LORE_MODEL_SERVER_RESTART_BUDGET_MS ??= '20000';
    process.env.LORE_MODEL_SERVER_RESTARTS ??= '5';
    process.env.LORE_MODEL_SERVER_CALL_MS ??= '30000';
    process.env.LORE_MODEL_SERVER_PROBE_MS ??= '1000';
    delete process.env.LORE_LOCAL_EMBEDDING_DEVICE;
    const home = mkHome('healthy');
    process.env.LORE_HOME = home;
    const dataDirShared = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-meta-healthy-shared-data-'));
    const dataDirControl = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-meta-healthy-control-data-'));
    const { createLore } = await import('../packages/lore/src/mcp/server.js');
    const shared = await createLore({ dataDir: dataDirShared, deploymentMode: 'embedded', ownsProcess: false });
    const control = await createLore({ dataDir: dataDirControl, deploymentMode: 'embedded', ownsProcess: false, modelServer: false });
    try {
        await shared.bulkIngest([ingestNode('healthy-n1')], { embed: 'sync' });
        await control.bulkIngest([ingestNode('healthy-n1')], { embed: 'sync' });
        assert.equal(shared.modelStatus().mode, 'shared', 'healthy scenario must actually reach shared mode (real cold boot) before comparing — a fallback here would invalidate the whole scenario');
        assert.equal(control.modelStatus().mode, 'in_process', 'modelServer:false control must never construct a ModelServerClient at all');
        const rShared: any = await shared.recall('quick brown fox', { workspace: 'default', mode: 'summary' });
        const rControl: any = await control.recall('quick brown fox', { workspace: 'default', mode: 'summary' });
        assert.equal(rShared?._meta?.models, undefined, 'shared/healthy recall must carry no _meta.models — additive metadata is fallback-only (withModelStatusMeta)');
        assert.equal(rControl?._meta?.models, undefined, 'modelServer:false control must likewise carry no _meta.models');
        // queryId is a fresh random UUID minted per recall() call (not a
        // function of model-server involvement) — the ONLY field expected
        // to differ between two otherwise-identical calls. Strip it before
        // the identity comparison; everything else, including the rest of
        // _meta, must match exactly.
        const { queryId: _qs, ...rSharedRest } = rShared ?? {};
        const { queryId: _qc, ...rControlRest } = rControl ?? {};
        assert.deepEqual(rSharedRest, rControlRest, 'shared/healthy recall output must be byte-identical (deep-equal, modulo the per-call queryId) to the modelServer:false control — the ONLY allowed structural difference is _meta.models, and neither result has it here');
        console.log('HEALTHY_OK');
    } finally {
        await shared.dispose();
        await control.dispose();
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(dataDirShared, { recursive: true, force: true });
        fs.rmSync(dataDirControl, { recursive: true, force: true });
    }
}

async function runFallback(): Promise<void> {
    process.env.LORE_MODEL_SERVER = '1';
    // Deliberately far too small for a real cold boot to finish within —
    // forces the FIRST embed call inside bulkIngest to fail fast and the
    // client to give up (rather than retrying) and transition loudly.
    // Mirrors the proven "unspawnable-within-budget" config in
    // model-server-client-lifecycle-unit.ts.
    process.env.LORE_MODEL_SERVER_READY_MS = '150';
    process.env.LORE_MODEL_SERVER_RESTART_BUDGET_MS = '50';
    process.env.LORE_MODEL_SERVER_RESTARTS = '1';
    process.env.LORE_MODEL_SERVER_CALL_MS = '30000';
    // NOT tiny: the background spawn this failed first attempt kicks off
    // finishes booting in ~2s on this machine (model already cached), and
    // bulkIngest's own sync-embed work can itself take a comparable amount
    // of wall time — a small probeMs risks the recovery firing (async,
    // independent of our own await) before we ever get to assert we were
    // still in 'fallback'. Large enough to give a reliable assertion
    // window, still well inside the 25s recovery-wait bound below.
    process.env.LORE_MODEL_SERVER_PROBE_MS = '8000';
    delete process.env.LORE_LOCAL_EMBEDDING_DEVICE;
    const home = mkHome('fallback');
    process.env.LORE_HOME = home;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-meta-fallback-data-'));
    const { createLore } = await import('../packages/lore/src/mcp/server.js');
    const statuses: Array<{ mode: string }> = [];
    const lore = await createLore({ dataDir, deploymentMode: 'embedded', ownsProcess: false, onModelStatus: (s) => statuses.push(s) });
    try {
        await lore.bulkIngest([ingestNode('fallback-n1')], { embed: 'sync' });
        assert.equal(lore.modelStatus().mode, 'fallback', 'first embed within the tiny budget must force a loud fallback transition (the detached spawn keeps booting in the background regardless)');

        const rFallback: any = await lore.recall('quick brown fox', { workspace: 'default', mode: 'summary' });
        assert.equal(rFallback?._meta?.models?.served_by, 'in_process_fallback', '_meta.models must be present with the documented served_by value while in fallback');
        assert.ok('reason' in rFallback._meta.models && 'since' in rFallback._meta.models, '_meta.models must carry reason + since per withModelStatusMeta()');

        const fallbackHits = statuses.filter((s) => s.mode === 'fallback').length;
        assert.equal(fallbackHits, 1, `onModelStatus must fire the fallback transition exactly once (client.ts only logs/emits on the shared->fallback edge), got ${fallbackHits}`);

        // Background recovery: the detached server from the failed first
        // attempt keeps booting; the probe (bounded by probeMs=500) should
        // pick it up well within this budget.
        const deadline = Date.now() + 25_000;
        while (lore.modelStatus().mode !== 'shared' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
        assert.equal(lore.modelStatus().mode, 'shared', 'must recover to shared within 25s once the background spawn finishes booting');
        assert.ok(statuses.some((s) => s.mode === 'shared'), 'onModelStatus must have fired a recovery status too');

        const rRecovered: any = await lore.recall('quick brown fox', { workspace: 'default', mode: 'summary' });
        assert.equal(rRecovered?._meta?.models, undefined, '_meta.models must be absent again once recovered to shared');
        console.log('FALLBACK_OK');
    } finally {
        await lore.dispose();
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
}

async function child(): Promise<void> {
    try {
        if (SCENARIO === 'healthy') await runHealthy();
        else if (SCENARIO === 'fallback') await runFallback();
        else throw new Error(`unknown __MS_META_SCENARIO ${String(SCENARIO)}`);
        process.exit(0);
    } catch (err) {
        console.error('SCENARIO_FAILED:', (err as Error).stack ?? err);
        process.exit(1);
    }
}

// ── Orchestrator ─────────────────────────────────────────────────────────

async function orchestrate(): Promise<void> {
    console.log('model-server _meta.models end-to-end via real createLore().recall() (3.24 C3a gap fix #2)\n');
    let passed = 0, failed = 0;
    for (const scenario of ['healthy', 'fallback'] as const) {
        const res = spawnSync(process.execPath, [...process.execArgv, THIS_FILE], {
            env: { ...process.env, __MS_META_SCENARIO: scenario },
            encoding: 'utf8',
            timeout: 120_000,
        });
        const stdout = res.stdout ?? '';
        const stderr = res.stderr ?? '';
        const okMarker = scenario === 'healthy' ? 'HEALTHY_OK' : 'FALLBACK_OK';
        let ok = res.status === 0 && stdout.includes(okMarker);
        if (ok && scenario === 'fallback') {
            // Cross-check log.error count from OUTSIDE the child's own
            // assertions too — all Lore log output goes to stderr
            // (logger.ts), so this is a direct, independent proof that
            // exactly one loud announcement was made for the whole
            // fallback+recovery lifecycle, not just what the child's own
            // onModelStatus bookkeeping claims.
            const hits = (stderr.match(/falling back to in-process/g) ?? []).length;
            if (hits !== 1) {
                ok = false;
                console.log(`  \x1b[31m✗ fallback scenario: expected exactly one 'falling back to in-process' log.error on stderr, saw ${hits}\x1b[0m`);
            }
        }
        if (ok) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${scenario} scenario`); }
        else {
            failed++;
            console.log(`  \x1b[31m✗ ${scenario} scenario (exit ${res.status})\x1b[0m`);
            for (const line of stdout.split('\n')) if (line.trim()) console.log(`    out: ${line}`);
            for (const line of stderr.split('\n')) if (line.trim()) console.log(`    err: ${line}`);
        }
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

if (SCENARIO) {
    void child();
} else {
    orchestrate().catch((e) => { console.error('TEST HARNESS FAILED:', e); process.exit(2); });
}
