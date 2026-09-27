#!/usr/bin/env tsx
/**
 * d9-recall-parity-gate-unit.ts — D9 (3.24 slice C3c) release gate, THE
 * NON-NEGOTIABLE ONE per the C3c brief: recall results through the shared
 * model server must be identical — same top-10 ids, same ORDER, same scores
 * — to recall computed fully in-process, across every combination of
 * {model server on, off} x {rerank on, off}, using the recall-eval harness's
 * OWN real fixture and real question set (not a synthetic stand-in).
 *
 * Design (deviates from the brief's literal "ingest in 4 configurations" —
 * see note below):
 *   - The corpus is embedded ONCE via the recall-eval harness's own
 *     `ensureFixture()` (scripts/diagnostics/recall-eval/lib/buildFixture.mjs),
 *     the exact function `runner.mjs` itself calls. `codeRowCount: 0` since
 *     this gate only queries the knowledge/note fixture rows the harness's
 *     `questions.json` targets — code rows are irrelevant to this comparison
 *     and would only add embedding time. `embedder: 'real'` — this satisfies
 *     "fail loudly if a model is missing, do not skip": `ensureFixture`
 *     itself throws `code: 'embedder_not_cached'` if the local embedder
 *     isn't cached, and this test lets that throw propagate uncaught rather
 *     than catching/skipping.
 *   - That ONE built `dataDir` is copied (`fs.cpSync`) into two independent
 *     copies — one per Lore instance — so two SQLite-backed hosts are never
 *     open against the same files at once. Node-level embeddings are
 *     already baked into the fixture identically for both copies; only
 *     QUERY-TIME behaviour (query embedding + rerank scoring) can differ
 *     between server-on and server-off, which is exactly the path D9's
 *     parity guarantee is about (node-embedding bit-identity between the
 *     shared server and in-process is already covered separately by
 *     `model-server-embed-parity-unit.ts`).
 *   - Deviation from the brief's literal wording ("ingest ... in 4
 *     configurations: server on/off x rerank on/off"): rerank is a PER-CALL
 *     `recall()` option (`RecallOpts.rerank`), never an ingest-time setting
 *     — `packages/lore/src/mcp/server.ts` resolves exactly one
 *     `RerankBackend` per host at `createLore()` time and every call reuses
 *     it, while `rerank: true`/`false` is decided fresh on each `recall()`
 *     call. So only TWO Lore hosts are created (server-on, server-off), and
 *     each is queried with `rerank: false` AND `rerank: true` — covering all
 *     4 combinations without 4x the (CPU-bound) ingestion cost. Re-ingesting
 *     4 times would not exercise any code path this design doesn't already
 *     cover, since rerank has no ingest-time footprint at all.
 *   - The real rerank model comes from `installRerankModel()`
 *     (test/helpers/rerank-model-fixture.ts) — `test/d8-rerank-e2e*.ts` uses a
 *     FAKE scorer, which would prove nothing here. Both hosts share ONE
 *     `LORE_HOME`: `rerankBackend.ts` resolves the same `<LORE_HOME>/models`
 *     for the local and the shared-server rerank path, and only the
 *     server-on host writes `run/` + `logs/` under it.
 *
 * Run: npx tsx test/d9-recall-parity-gate-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installRerankModel } from './helpers/rerank-model-fixture.js';
import type { RecallOpts } from '../packages/lore/src/recall/inProcessRecall.js';
import type { RecallResult, RecallResultSummary } from '../packages/lore/src/recall/recallPreset.js';

// Same established pattern as test/r3221-d1-recall-types-inprocess-unit.ts:
// `lore.recall()` always returns the `RecallResultSummary | RecallResultFull`
// union (mode is a runtime opt, not a type-level discriminant on the return
// type), so a `mode: 'summary'` call site needs an explicit runtime-checked
// narrow to reach `.hits` at all.
function asSummary(r: RecallResult): RecallResultSummary {
    assert.equal(r.mode, 'summary', 'expected summary-mode recall result');
    return r as RecallResultSummary;
}

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
};

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

function mkLoreHome(tag: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), `lore-d9-parity-${tag}-`));
}
function isAlive(pid: number): boolean {
    const res = spawnSync('ps', ['-p', String(pid)]);
    return res.status === 0 && res.stdout.toString().includes(String(pid));
}
const spawnedPids = new Set<number>();
function trackPid(pid: number | null | undefined): void { if (pid) spawnedPids.add(pid); }
function cleanupAllTrackedPids(): void {
    for (const pid of spawnedPids) {
        if (isAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
    }
}
async function waitFor(fn: () => boolean, timeoutMs: number, label: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (fn()) return;
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timed out waiting for: ${label}`);
}

console.log('D9 §6 release gate — recall parity: shared model server vs in-process, id+order+score identical (NON-NEGOTIABLE gate)\n');

const cleanupDirs: string[] = [];
let loreHome = '';

await test('setup: build the real recall-eval fixture once (fail loudly if the embedder is not cached — no skip, no fake fallback)', async () => {
    const { ensureFixture } = await import('../scripts/diagnostics/recall-eval/lib/buildFixture.mjs' as string);
    const cacheRoot = path.join(os.tmpdir(), 'lore-d9-recall-parity-fixture-cache');
    const fixture = await ensureFixture({
        graphEngine: 'sqlite',
        vectorEngine: 'sqlite',
        codeRowCount: 0,
        embedder: 'real',
        cacheRoot,
        force: false,
        log: (m: string) => console.log(`    [fixture] ${m}`),
    });
    assert.ok(fs.existsSync(fixture.dataDir), 'fixture dataDir must exist on disk after ensureFixture()');
    (globalThis as Record<string, unknown>).__d9FixtureDataDir = fixture.dataDir;
});

await test('setup: shared LORE_HOME with a real (non-fake) rerank model cache for both hosts', async () => {
    loreHome = mkLoreHome('home');
    await installRerankModel(loreHome);
    cleanupDirs.push(loreHome);
    assert.ok(fs.existsSync(path.join(loreHome, 'models', 'Xenova', 'ms-marco-MiniLM-L-6-v2', '.complete')), 'rerank model cache marker must exist before any rerank:true call');
});

await test('recall parity across {server on, off} x {rerank off, on}: identical top-10 ids, order, and scores; server-on genuinely reaches mode:shared; rerank genuinely applies', async () => {
    const fixtureDataDir = (globalThis as Record<string, unknown>).__d9FixtureDataDir as string;
    assert.ok(fixtureDataDir, 'fixture must have been built by the setup step above');

    const dataDirOn = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-d9-parity-data-on-'));
    const dataDirOff = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-d9-parity-data-off-'));
    fs.rmSync(dataDirOn, { recursive: true, force: true });
    fs.rmSync(dataDirOff, { recursive: true, force: true });
    fs.cpSync(fixtureDataDir, dataDirOn, { recursive: true });
    fs.cpSync(fixtureDataDir, dataDirOff, { recursive: true });
    cleanupDirs.push(dataDirOn, dataDirOff);

    const prevHome = process.env.LORE_HOME;
    const prevServer = process.env.LORE_MODEL_SERVER;
    process.env.LORE_HOME = loreHome;
    process.env.LORE_MODEL_SERVER = '1'; // force eligibility despite running inside a test process (isTestProcess() gate)

    const { createLore } = await import('../packages/lore/src/mcp/server.js');

    let loreOn: Awaited<ReturnType<typeof createLore>> | undefined;
    let loreOff: Awaited<ReturnType<typeof createLore>> | undefined;
    try {
        loreOn = await createLore({ dataDir: dataDirOn, deploymentMode: 'embedded', ownsProcess: false });
        loreOff = await createLore({ dataDir: dataDirOff, deploymentMode: 'embedded', ownsProcess: false, modelServer: false });

        // Warm + confirm the server-on host genuinely reached the shared
        // model server — otherwise this whole gate would silently prove
        // nothing (in-process vs in-process is not the comparison D9 needs).
        await waitFor(() => loreOn!.modelStatus().mode === 'shared', 30_000, 'server-on host to reach modelStatus().mode === "shared"');
        const onStatus = loreOn.modelStatus() as { mode: string; server?: { pid?: number } };
        assert.equal(onStatus.mode, 'shared', 'server-on host must be in shared mode for this comparison to be meaningful');
        if (onStatus.server?.pid) trackPid(onStatus.server.pid);

        const offStatus = loreOff.modelStatus() as { mode: string };
        assert.equal(offStatus.mode, 'in_process', 'server-off host must never attach to the shared model server (modelServer: false)');

        const questionsPath = path.join(repoRoot, 'scripts', 'diagnostics', 'recall-eval', 'questions.json');
        const questions = JSON.parse(fs.readFileSync(questionsPath, 'utf8')) as Array<{ id: string; terse: string; workspace: string }>;
        assert.ok(questions.length > 0, 'questions.json must be non-empty');

        // Mirrors runner.mjs's recallOne() opts shape (read directly from
        // scripts/diagnostics/recall-eval/runner.mjs) so this gate exercises
        // the harness's own real query convention, not an invented one.
        const baseOpts: Omit<RecallOpts, 'rerank'> = { workspace: 'default', ecosystem: 'riverstone', mode: 'summary', depth: 0, max: 10, searchMode: 'hybrid', abstain: false };

        // D1's getCalibration() is deliberately non-blocking whenever
        // `abstain` is false (calibration.ts: `blocking: abstain`, retrieve.ts
        // line ~572) — the harness's own default, which baseOpts mirrors
        // above. The FIRST recall() call against a fresh store therefore
        // returns `relevance: null` on every hit (_meta.calibration.status:
        // 'pending') while the 128-probe fit runs in the BACKGROUND; a later
        // call sees the cached fit once it lands. This is intentional,
        // documented D1 behaviour, not a parity defect — but it IS a real
        // source of nondeterminism for this gate specifically: the two hosts
        // fit calibration at different wall-clock speeds (server-on pays a
        // unix-socket IPC round trip per probe embed; server-off embeds
        // in-process), so without a warm-up, `relevance` can land 'ok' on one
        // host and still 'pending' on the other for the first several
        // real queries below — a false parity failure, not the shared-server
        // bug this gate exists to catch (already covered, and was genuinely
        // caught and fixed this session: see clientConnection.ts's
        // reference-counted ref()/unref() fix). So: warm up each host with
        // throwaway calls until ITS OWN calibration fit has actually
        // landed (status no longer 'pending') before the real comparison
        // loop, exactly mirroring what a long-lived host does naturally.
        async function warmUpCalibration(lore: NonNullable<typeof loreOn>, label: string): Promise<void> {
            const deadline = Date.now() + 30_000;
            let status = 'pending';
            while (Date.now() < deadline) {
                const res = await lore.recall(questions[0]!.terse, { ...baseOpts, rerank: false });
                status = res._meta.calibration.status;
                if (status !== 'pending') return;
                await new Promise((r) => setTimeout(r, 200));
            }
            throw new Error(`[${label}] calibration never left 'pending' within 30s warm-up budget (last status: ${status})`);
        }
        await Promise.all([warmUpCalibration(loreOn, 'server-on'), warmUpCalibration(loreOff, 'server-off')]);

        let rerankAppliedSeenOn = false;
        let rerankAppliedSeenOff = false;

        for (const q of questions) {
            for (const rerank of [false, true]) {
                const opts: RecallOpts = { ...baseOpts, rerank };
                const [resOnRaw, resOffRaw] = await Promise.all([
                    loreOn.recall(q.terse, opts),
                    loreOff.recall(q.terse, opts),
                ]);
                const resOn = asSummary(resOnRaw);
                const resOff = asSummary(resOffRaw);

                const idsOn = resOn.hits.map((h) => h.id);
                const idsOff = resOff.hits.map((h) => h.id);
                assert.deepEqual(idsOn, idsOff, `[${q.id}, rerank=${rerank}] top-10 ids+order must be identical between server-on and server-off`);

                const scoresOn = resOn.hits.map((h) => ({ similarity: h.similarity ?? null, relevance: h.relevance ?? null, rerank_score: h.rerank_score ?? null }));
                const scoresOff = resOff.hits.map((h) => ({ similarity: h.similarity ?? null, relevance: h.relevance ?? null, rerank_score: h.rerank_score ?? null }));
                assert.deepEqual(scoresOn, scoresOff, `[${q.id}, rerank=${rerank}] per-hit similarity/relevance/rerank_score must be exactly equal between server-on and server-off`);

                if (rerank) {
                    const metaOn = resOn._meta.rerank;
                    const metaOff = resOff._meta.rerank;
                    if (idsOn.length > 0) {
                        // Only assert rerank actually applied when there was
                        // something to rerank — an empty hit set can't apply
                        // reranking, and that is not a parity failure.
                        assert.equal(metaOn?.applied, true, `[${q.id}] rerank:true must have actually applied on the server-on host (not a silent fail-open) — got _meta.rerank=${JSON.stringify(metaOn)}`);
                        assert.equal(metaOff?.applied, true, `[${q.id}] rerank:true must have actually applied on the server-off host — got _meta.rerank=${JSON.stringify(metaOff)}`);
                        rerankAppliedSeenOn = true;
                        rerankAppliedSeenOff = true;
                    }
                }
            }
        }

        assert.ok(rerankAppliedSeenOn, 'at least one query must have had rerank genuinely applied on the server-on host, or this gate never really exercised the shared-server rerank path');
        assert.ok(rerankAppliedSeenOff, 'at least one query must have had rerank genuinely applied on the server-off host, or this gate never really exercised the in-process rerank path');

        // Re-confirm still shared at the end (not just when it first warmed up).
        assert.equal(loreOn.modelStatus().mode, 'shared', 'server-on host must still be in shared mode at the end of the run');
    } finally {
        if (loreOn) { try { await loreOn.dispose('d9-recall-parity-gate-complete'); } catch { /* non-fatal */ } }
        if (loreOff) { try { await loreOff.dispose('d9-recall-parity-gate-complete'); } catch { /* non-fatal */ } }
        if (prevHome === undefined) delete process.env.LORE_HOME; else process.env.LORE_HOME = prevHome;
        if (prevServer === undefined) delete process.env.LORE_MODEL_SERVER; else process.env.LORE_MODEL_SERVER = prevServer;
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
cleanupAllTrackedPids();
for (const d of cleanupDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
if (failed > 0) process.exit(1);
