#!/usr/bin/env tsx
/**
 * d7-piece-migration-unit.ts — T3, D7c (3.23, piece-level vectors, migration
 * slice). Exercises `lore migrate piece-vectors`
 * (cli/commands/migratePieceVectors.ts's exported migratePieceVectorsCommand)
 * directly, in-process, end to end: idempotency, resume after an interrupted
 * build, --dry-run writes nothing, a complete-but-mismatched sidecar is
 * refused without --force/--drop, and --drop removes + disables.
 *
 * ENGINE SELECTION — deliberately NOT the same convention as
 * d7-piece-recall-unit.ts (T2). Tracing config/workspaces.ts's
 * loadWorkspaces() first-run seeding logic this slice found that a FRESH
 * home with NO LORE_DEFAULT_VECTOR_ENGINE set now seeds `vectorEngine:
 * 'sqlite'` (not 'lance') — so T2's "base" npm script (no env override) may
 * not actually be exercising Lance at all, despite the naming convention
 * implying base=lance / :sqlite=sqlite. This file does not rely on that
 * ambient default: its base npm script explicitly sets
 * LORE_DEFAULT_VECTOR_ENGINE=lance so real LancePieceIndex coverage is
 * guaranteed regardless of what the unset default currently resolves to;
 * its `:sqlite` variant explicitly sets sqlite for both vector+graph engine,
 * matching every other D7 `:sqlite` script's convention. See D7c's handoff
 * for the full trace (config/loreHome.ts + config/workspaces.ts).
 *
 * EMBEDDING PROVIDER — this file drives the REAL CLI export
 * (migratePieceVectorsCommand), which — like production — always resolves
 * its embedding provider via mcp/services.ts's createEmbeddingProvider(), an
 * env-var-only selector with no injection seam. Rather than depend on the
 * real local ONNX model (not present in this sandbox's model cache, and
 * slow/network-dependent even when it is), this file runs its OWN tiny
 * OpenAI-compatible HTTP server (deterministic, fixed 4-d hash vectors, no
 * network, no ONNX) and points LORE_EMBEDDING_PROVIDER=openai_compat at it —
 * the exact wire shape OpenAICompatEmbeddingProvider expects, reusing the
 * fake-server pattern test/injected-embedding-provider-e2e-unit.ts already
 * established for this provider (POST /v1/embeddings, {input: string[]} ->
 * {data: [{index, embedding}]}), minus that file's real-model proxying (not
 * needed here — piece-count/build correctness doesn't depend on real
 * embedding quality, unlike T2's ranking assertions).
 *
 * LORE_HOME MANAGEMENT — migratePieceVectorsCommand calls loreHome() bare
 * (no override param), and config/loreHome.ts's isTestProcess() branch
 * caches a pid-keyed temp home for the WHOLE PROCESS when LORE_HOME is
 * unset — stable across every scenario run in this one file, which would
 * cross-contaminate them. Every scenario below (via withHome()) therefore
 * sets process.env.LORE_HOME to its own fresh mkdtemp'd directory before
 * touching Lore, and the seeding step (createLore({dataDir})) is pointed at
 * the SAME directory explicitly so both routes (bare loreHome() inside the
 * CLI, and this file's own createLore() call) resolve to the same place.
 *
 * Run: npx tsx test/d7-piece-migration-unit.ts
 *      LORE_DEFAULT_VECTOR_ENGINE=sqlite LORE_DEFAULT_GRAPH_ENGINE=sqlite npx tsx test/d7-piece-migration-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

const DIM = 4;
const FAKE_MODEL_ID = 'd7c-fake-embed';

/** Deterministic, cheap, no real semantic meaning needed — this file's
 *  assertions are about piece COUNTS and build ACTIONS, never ranking
 *  quality (that is T2's job). FNV-1a-ish hash mixed into DIM floats. */
function fakeVector(text: string): number[] {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    const out: number[] = [];
    for (let i = 0; i < DIM; i++) {
        h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
        out.push(((h >>> 0) / 0xffffffff) * 2 - 1);
    }
    return out;
}

function startFakeEmbeddingServer(): Promise<{ port: number; close: () => Promise<void> }> {
    const server = http.createServer((req, res) => {
        if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            try {
                const parsed = JSON.parse(body) as { input: string[] };
                const data = parsed.input.map((text, index) => ({ index, embedding: fakeVector(text) }));
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ data }));
            } catch (err) {
                res.writeHead(500, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: (err as Error).message }));
            }
        });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const port = (server.address() as AddressInfo).port;
            resolve({ port, close: () => new Promise((r) => server.close(() => r())) });
        });
    });
}

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
        console.log(`  \x1b[32m✓\x1b[0m ${name}`);
        passed++;
    } catch (err) {
        console.error(`  \x1b[31m✗ ${name}\x1b[0m\n    ${(err as Error).stack ?? (err as Error).message}`);
        failed++;
    }
}

/** Fresh mkdtemp'd LORE_HOME for the duration of `fn`, restoring the
 *  previous value afterward — see file header's "LORE_HOME MANAGEMENT".
 *  LORE_DEFAULT_VECTOR_ENGINE/GRAPH_ENGINE and the embedding-provider env
 *  vars are deliberately left untouched here: they are set ONCE for the
 *  whole process (engine choice by the npm script that launched this file;
 *  embedding provider by main(), below). */
async function withHome<T>(fn: (dataDir: string) => Promise<T>): Promise<T> {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'd7-piece-migration-'));
    const prevHome = process.env['LORE_HOME'];
    process.env['LORE_HOME'] = dataDir;
    try {
        return await fn(dataDir);
    } finally {
        if (prevHome === undefined) delete process.env['LORE_HOME'];
        else process.env['LORE_HOME'] = prevHome;
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
}

/** >480 chars so pieceLayout.ts's char-window fallback produces more than
 *  one body window (CHAR_WINDOW_SIZE=480/CHAR_WINDOW_OVERLAP=120). */
function longBody(marker: string): string {
    return `${marker} ` + 'lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(30);
}

async function seed(dataDir: string, n = 5): Promise<void> {
    const { createLore } = await import('../packages/lore/src/index.js');
    const lore = await createLore({ dataDir, deploymentMode: 'embedded' });
    try {
        const nodes = Array.from({ length: n }, (_, i) => ({
            id: `d7c-node-${i}`,
            workspace: 'default',
            ecosystem: '*',
            nodeData: {
                id: `d7c-node-${i}`,
                type: 'knowledge',
                label: `D7c Node ${i}`,
                // Alternate long (multi-window) / short (single-window) bodies
                // so the seeded corpus produces a realistic mix of piece counts.
                content: i % 2 === 0 ? longBody(`marker-${i}`) : `short body ${i}`,
                project: 'default',
                ecosystem: '*',
            },
        }));
        const result = await lore.bulkIngest(nodes, { autolink: false, embed: 'sync' });
        assert.ok(
            result.results.every((r) => r.ok),
            `seed bulkIngest had failures: ${JSON.stringify(result.results.filter((r) => !r.ok))}`,
        );
    } finally {
        await lore.dispose();
    }
}

interface CliResult {
    lines: string[];
    action?: string;
    nodesScanned?: number;
    nodesRebuilt?: number;
    piecesIndexed?: number;
    reason?: string;
}

/** Runs the real CLI export in-process and parses its printed result-summary
 *  block (the same block a real operator reads) rather than reaching into
 *  buildPieceIndex() directly — this is what makes it a CLI-level test. */
async function runCli(args: string[]): Promise<CliResult> {
    const { migratePieceVectorsCommand } = await import('../packages/lore/src/cli/commands/migratePieceVectors.js');
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.map((x) => String(x)).join(' ')); };
    try {
        await migratePieceVectorsCommand(args);
    } finally {
        console.log = origLog;
    }
    const field = (label: string): string | undefined => {
        const re = new RegExp(`^\\s*${label}:\\s*(.*)$`);
        for (const l of lines) { const m = re.exec(l); if (m) return m[1].trim(); }
        return undefined;
    };
    const numOf = (s: string | undefined): number | undefined => {
        if (s === undefined) return undefined;
        const m = /^(\d+)/.exec(s);
        return m ? Number(m[1]) : undefined;
    };
    return {
        lines,
        action: field('Action'),
        nodesScanned: numOf(field('Nodes scanned')),
        nodesRebuilt: numOf(field('Nodes rebuilt')),
        piecesIndexed: numOf(field('Pieces indexed')),
        reason: field('Reason'),
    };
}

/* ── (1) idempotency ──────────────────────────────────────────────────── */

async function testIdempotency(): Promise<void> {
    await withHome(async (dataDir) => {
        await seed(dataDir, 5);

        const first = await runCli([]);
        assert.equal(first.action, 'built', `expected built, got ${first.action}: ${first.lines.join('\n')}`);
        assert.equal(first.nodesScanned, 5);
        assert.equal(first.nodesRebuilt, 5);
        assert.ok((first.piecesIndexed ?? 0) > 5, `expected more pieces than nodes (title row + windows), got ${first.piecesIndexed}`);

        const second = await runCli([]);
        assert.equal(second.action, 'noop', `expected noop on the second run, got ${second.action}: ${second.lines.join('\n')}`);
        assert.equal(second.reason, 'already built');
        assert.equal(second.nodesRebuilt, 0);
        assert.equal(second.piecesIndexed, first.piecesIndexed, 'a no-op must report the same piece count as the last real build');
    });
}

/* ── (2) resume after an interrupted build ────────────────────────────── */

async function testResumeAfterInterrupted(): Promise<void> {
    await withHome(async (dataDir) => {
        await seed(dataDir, 5);

        const { writePieceSidecar, PIECE_LAYOUT_V1 } = await import('../packages/lore/src/engines/pieces/pieceLayout.js');
        const { embeddingProviderFingerprint } = await import('../packages/lore/src/providers/localEmbeddingProvider.js');
        // Simulates exactly what buildPieceIndex() itself leaves behind when a
        // run is aborted mid-loop: a sidecar with the CURRENT layout and
        // fingerprint, but complete:false (written before the batch loop,
        // flipped to true only after — see pieceIndexBuild.ts).
        writePieceSidecar(dataDir, {
            layout: PIECE_LAYOUT_V1.layout,
            windowTokens: PIECE_LAYOUT_V1.windowTokens,
            overlapTokens: PIECE_LAYOUT_V1.overlapTokens,
            titleRow: PIECE_LAYOUT_V1.titleRow,
            tokenizer: 'model',
            embedding: embeddingProviderFingerprint({ modelId: FAKE_MODEL_ID, dtype: undefined }),
            complete: false,
        });

        const result = await runCli([]);
        // An incomplete sidecar is a DIFFERENT case from a complete-but-
        // mismatched one (see testMixedLayoutRefused): it resumes/rebuilds
        // automatically, no --force needed.
        assert.equal(result.action, 'built', `expected an incomplete sidecar to trigger an automatic rebuild, got ${result.action}: ${result.lines.join('\n')}`);
        assert.equal(result.nodesRebuilt, 5);

        const { readPieceSidecar } = await import('../packages/lore/src/engines/pieces/pieceLayout.js');
        const sidecar = readPieceSidecar(dataDir);
        assert.ok(sidecar?.complete, 'sidecar must be complete after the resumed build');
    });
}

/* ── (3) --dry-run writes nothing ─────────────────────────────────────── */

async function testDryRunWritesNothing(): Promise<void> {
    await withHome(async (dataDir) => {
        await seed(dataDir, 5);

        const dry = await runCli(['--dry-run']);
        assert.equal(dry.action, 'dry-run', `expected dry-run, got ${dry.action}: ${dry.lines.join('\n')}`);
        assert.equal(dry.nodesRebuilt, 0);

        const { readPieceSidecar } = await import('../packages/lore/src/engines/pieces/pieceLayout.js');
        assert.equal(readPieceSidecar(dataDir), null, '--dry-run must not write a sidecar');

        // Functional proof it wrote nothing else either: a bare run
        // afterward must still see this as a FIRST build ('built'), never a
        // no-op — if dry-run had written anything real this would be 'noop'.
        const real = await runCli([]);
        assert.equal(real.action, 'built', `dry-run must not have left anything for the real build to no-op against, got ${real.action}: ${real.lines.join('\n')}`);
    });
}

/* ── (4) a complete-but-mismatched sidecar is refused ─────────────────── */

async function testMixedLayoutRefused(): Promise<void> {
    await withHome(async (dataDir) => {
        await seed(dataDir, 5);

        const built = await runCli([]);
        assert.equal(built.action, 'built', `expected built, got ${built.action}: ${built.lines.join('\n')}`);

        const { writePieceSidecar, readPieceSidecar, PIECE_LAYOUT_V1 } = await import('../packages/lore/src/engines/pieces/pieceLayout.js');
        const afterBuild = readPieceSidecar(dataDir);
        assert.ok(afterBuild, 'expected a sidecar after the first build');

        // (a) embedding fingerprint mismatch — same layout, different model.
        writePieceSidecar(dataDir, { ...afterBuild!, embedding: 'some-other-model@fp32' });
        const refusedFp = await runCli([]);
        assert.equal(refusedFp.action, 'aborted', `expected aborted on fingerprint mismatch, got ${refusedFp.action}: ${refusedFp.lines.join('\n')}`);
        assert.match(refusedFp.reason ?? '', /fingerprint mismatch/, `reason should mention the fingerprint mismatch: ${refusedFp.reason}`);
        assert.match(refusedFp.reason ?? '', /--force|--drop/, `reason should point at the recovery flags: ${refusedFp.reason}`);

        // --force rebuilds right over the mismatch and restores a valid sidecar.
        const forced = await runCli(['--force']);
        assert.equal(forced.action, 'built', `expected --force to rebuild over the mismatch, got ${forced.action}: ${forced.lines.join('\n')}`);

        // (b) layout mismatch — windowTokens changed, fingerprint untouched.
        const afterForce = readPieceSidecar(dataDir);
        writePieceSidecar(dataDir, { ...afterForce!, windowTokens: PIECE_LAYOUT_V1.windowTokens + 1 });
        const refusedLayout = await runCli([]);
        assert.equal(refusedLayout.action, 'aborted', `expected aborted on layout mismatch, got ${refusedLayout.action}: ${refusedLayout.lines.join('\n')}`);
        assert.match(refusedLayout.reason ?? '', /layout mismatch/, `reason should mention the layout mismatch: ${refusedLayout.reason}`);

        // --drop also recovers from the refused state (not just --force).
        const dropped = await runCli(['--drop']);
        assert.equal(dropped.action, 'dropped', `expected --drop to recover from the refused state, got ${dropped.action}: ${dropped.lines.join('\n')}`);
    });
}

/* ── (5) --drop removes + disables ────────────────────────────────────── */

async function testDrop(): Promise<void> {
    await withHome(async (dataDir) => {
        await seed(dataDir, 5);

        const built = await runCli([]);
        assert.equal(built.action, 'built', `expected built, got ${built.action}: ${built.lines.join('\n')}`);
        assert.ok((built.piecesIndexed ?? 0) > 0);

        const dropped = await runCli(['--drop']);
        assert.equal(dropped.action, 'dropped', `expected dropped, got ${dropped.action}: ${dropped.lines.join('\n')}`);

        const { readPieceSidecar } = await import('../packages/lore/src/engines/pieces/pieceLayout.js');
        assert.equal(readPieceSidecar(dataDir), null, '--drop must remove the sidecar');

        // A bare run afterward is treated as a fresh first build again, not
        // a no-op — proving --drop actually disabled the index rather than
        // merely emptying it while leaving the sidecar complete:true.
        const rebuilt = await runCli([]);
        assert.equal(rebuilt.action, 'built', `expected a fresh build after --drop, got ${rebuilt.action}: ${rebuilt.lines.join('\n')}`);
    });
}

/* ── main ──────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
    console.log('d7-piece-migration-unit: `lore migrate piece-vectors` — idempotency, resume, dry-run, mismatch refusal, drop');

    const { port, close } = await startFakeEmbeddingServer();
    // Constant for the whole process — see file header's "EMBEDDING PROVIDER".
    process.env['LORE_EMBEDDING_PROVIDER'] = 'openai_compat';
    process.env['LORE_EMBEDDING_BASE_URL'] = `http://127.0.0.1:${port}/v1`;
    process.env['LORE_EMBEDDING_MODEL'] = FAKE_MODEL_ID;
    process.env['LORE_EMBEDDING_DIMENSION'] = String(DIM);
    process.env['LORE_EMBEDDING_API_KEY'] = 'd7c-test-key';

    try {
        await test('idempotent: a second bare run is a no-op reporting the same piece count', testIdempotency);
        await test('resumes automatically from an interrupted (incomplete) sidecar', testResumeAfterInterrupted);
        await test('--dry-run writes nothing (no sidecar; a later bare run still does the real first build)', testDryRunWritesNothing);
        await test('a complete-but-mismatched sidecar (fingerprint or layout) is refused without --force/--drop', testMixedLayoutRefused);
        await test('--drop removes the sidecar; a later bare run rebuilds fresh', testDrop);
    } finally {
        await close();
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
