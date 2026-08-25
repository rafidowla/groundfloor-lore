#!/usr/bin/env tsx
/**
 * test/local-source-ingest-unit.ts
 *
 * Comprehensive tests for the Lore Core local-first sprint:
 *
 *   #10 — Boot wiring + ingest callback  (makeFileIngestCallback)
 *   #11 — LORE_WATCH_PATHS auto-added to ingestion path allowlist
 *   #12 — Recursive option for LocalSourceWatcher
 *   #13 — syncVectorMirror.ts extraction (regression)
 *
 * Wishlist items (shipped after initial sprint):
 *   W1 — Linux recursive watcher: static subdir pre-scan (collectSubdirs)
 *   W2 — Freshness: locally-updated nodes count as fresh (updatedAt fallback)
 *   W3 — SIGTERM: stopAllLocalWatchers() exported + wired in server.ts
 *   W4 — Auto-embed: makeFileIngestCallback stores to verbatimStore when provided
 *
 * Coverage: happy · unhappy · adversarial · regression · e2e
 */

import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { makeFileIngestCallback, stopAllLocalWatchers } from '../packages/lore/src/mcp/bootSteps.js';
import { computeFreshness } from '../packages/lore/src/engines/freshnessEngine.js';
import { LocalSourceWatcher } from '../packages/lore/src/engines/localSourceWatcher.js';
import {
    loadWatchPathsAsRoots,
    loadAllExtraRoots,
} from '../packages/lore/src/security/pathAllowlist.js';
import {
    upsertVectorMirror,
    recoverVectorMirrors,
} from '../packages/lore/src/engines/syncVectorMirror.js';
import type { LoreNode } from '../packages/lore/src/providers/types.js';
import type { LoreGraphHandle } from '../packages/lore/src/storage/loreStorageClient.js';
import type { WorkspaceGraph } from '../packages/lore/src/engines/openWorkspaceGraph.js';

/* ─── harness ──────────────────────────────────────────────────── */

let passed = 0;
let failed = 0;
const pending: Promise<void>[] = [];

function test(name: string, fn: () => void | Promise<void>): void {
    pending.push(
        Promise.resolve().then(async () => {
            try {
                await fn();
                console.log(`  ✓ ${name}`);
                passed++;
            } catch (e) {
                console.error(`  ✗ ${name}\n    ${(e as Error).message}`);
                failed++;
            }
        }),
    );
}

/* ─── allowlist helper (re-audit 2026-06-25) ───────────────────────
 * makeFileIngestCallback now gates the watched path through assertPathAllowed.
 * Tests create files under os.tmpdir(), which is NOT a default allowed root, so
 * they inject a permissive allowlist (the tmp dir as workspaceRoot) to exercise
 * the unchanged ingest logic. The gate's reject behavior is pinned separately. */
const allow = (dir: string) => ({ workspaceRoot: dir, extraRoots: [dir] });

/* ─── mock helpers ─────────────────────────────────────────────── */

interface CapturedNode {
    id: string; type: string; label: string; content: string;
    tags: string; project: string; ecosystem: string; metadata: string;
}

function makeGraphMock(): { graph: WorkspaceGraph; nodes: CapturedNode[] } {
    const nodes: CapturedNode[] = [];
    const graph = {
        nodes,
        upsertNode: async (n: CapturedNode) => {
            nodes.push({ ...n });
            return { ...n, createdAt: '', updatedAt: '', syncedAt: null } as unknown as LoreNode;
        },
    } as unknown as WorkspaceGraph;
    return { graph, nodes };
}

function makeVectorStoreMock(): {
    store: (item: unknown) => Promise<void>;
    stored: unknown[];
    throwNext?: boolean;
} {
    const stored: unknown[] = [];
    let throwNext = false;
    return {
        stored,
        get throwNext() { return throwNext; },
        set throwNext(v) { throwNext = v; },
        store: async (item: unknown) => {
            if (throwNext) { throwNext = false; throw new Error('mock vector error'); }
            stored.push(item);
        },
    };
}

/** Build a minimal LoreNode for syncVectorMirror tests. */
function makeNode(overrides: Partial<LoreNode> = {}): LoreNode {
    return {
        id: 'node-test-1',
        type: 'note',
        label: 'Test Label',
        content: 'Test content body',
        tags: 'a,b',
        project: 'test-project',
        ecosystem: '*',
        metadata: '{}',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        syncedAt: '2026-01-01T00:00:00.000Z',
        ...overrides,
    } as LoreNode;
}

/* ─── env isolation ────────────────────────────────────────────── */

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(vars)) {
        saved[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    try {
        fn();
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

/* ═══════════════════════════════════════════════════════════════
   #10 — makeFileIngestCallback
   ═══════════════════════════════════════════════════════════════ */

console.log('\n#10 — makeFileIngestCallback');

const MAX_AUTO_INGEST_BYTES = 512 * 1024;

test('[happy] creates note node with correct type and label', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-ingest-'));
    const filePath = path.join(tmp, 'readme.md');
    fs.writeFileSync(filePath, '# Hello\nWorld');
    const { graph, nodes } = makeGraphMock();
    const cb = makeFileIngestCallback(graph, 'my-workspace', null, allow(tmp));
    cb(filePath);
    await new Promise(r => setTimeout(r, 50));
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].type, 'note');
    assert.equal(nodes[0].label, 'readme.md');
    fs.rmSync(tmp, { recursive: true });
});

test('[happy] node ID is deterministic — same path yields same ID', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-ingest-'));
    const filePath = path.join(tmp, 'notes.txt');
    fs.writeFileSync(filePath, 'content');
    const { graph, nodes } = makeGraphMock();
    const cb = makeFileIngestCallback(graph, 'ws', null, allow(tmp));
    cb(filePath); await new Promise(r => setTimeout(r, 50));
    cb(filePath); await new Promise(r => setTimeout(r, 50));
    assert.equal(nodes.length, 2);
    assert.equal(nodes[0].id, nodes[1].id, 'ID must be deterministic across calls');
    const expectedHash = crypto.createHash('sha256').update(filePath).digest('hex').slice(0, 12);
    assert.equal(nodes[0].id, `file:${expectedHash}`);
    fs.rmSync(tmp, { recursive: true });
});

test('[happy] project field equals the workspace arg', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-ingest-'));
    const filePath = path.join(tmp, 'doc.md');
    fs.writeFileSync(filePath, 'text');
    const { graph, nodes } = makeGraphMock();
    makeFileIngestCallback(graph, 'acme-workspace', null, allow(tmp))(filePath);
    await new Promise(r => setTimeout(r, 50));
    assert.equal(nodes[0].project, 'acme-workspace');
    fs.rmSync(tmp, { recursive: true });
});

test('[happy] tags contain local-file and auto-ingested', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-ingest-'));
    const filePath = path.join(tmp, 'note.rst');
    fs.writeFileSync(filePath, 'rst content');
    const { graph, nodes } = makeGraphMock();
    makeFileIngestCallback(graph, 'ws', null, allow(tmp))(filePath);
    await new Promise(r => setTimeout(r, 50));
    assert.ok(nodes[0].tags.includes('local-file'), 'missing local-file tag');
    assert.ok(nodes[0].tags.includes('auto-ingested'), 'missing auto-ingested tag');
    fs.rmSync(tmp, { recursive: true });
});

test('[happy] metadata JSON contains sourcePath and ingestedAt', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-ingest-'));
    const filePath = path.join(tmp, 'x.md');
    fs.writeFileSync(filePath, 'x');
    const { graph, nodes } = makeGraphMock();
    makeFileIngestCallback(graph, 'ws', null, allow(tmp))(filePath);
    await new Promise(r => setTimeout(r, 50));
    const meta = JSON.parse(nodes[0].metadata);
    assert.equal(meta.sourcePath, filePath);
    assert.ok(typeof meta.ingestedAt === 'string');
    fs.rmSync(tmp, { recursive: true });
});

test('[unhappy] missing file → no throw, upsertNode never called', async () => {
    const { graph, nodes } = makeGraphMock();
    makeFileIngestCallback(graph, 'ws')('/nonexistent/path/to/file.md');
    await new Promise(r => setTimeout(r, 50));
    assert.equal(nodes.length, 0);
});

test('[adversarial] content > 512KB is truncated with cap marker', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-ingest-'));
    const filePath = path.join(tmp, 'big.md');
    const big = 'A'.repeat(MAX_AUTO_INGEST_BYTES + 10_000);
    fs.writeFileSync(filePath, big);
    const { graph, nodes } = makeGraphMock();
    makeFileIngestCallback(graph, 'ws', null, allow(tmp))(filePath);
    await new Promise(r => setTimeout(r, 50));
    assert.ok(nodes[0].content.length <= MAX_AUTO_INGEST_BYTES + 100);
    assert.ok(nodes[0].content.includes('[truncated by auto-ingest cap]'));
    fs.rmSync(tmp, { recursive: true });
});

test('[adversarial] content exactly at 512KB is NOT truncated', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-ingest-'));
    const filePath = path.join(tmp, 'exact.md');
    const exact = 'B'.repeat(MAX_AUTO_INGEST_BYTES);
    fs.writeFileSync(filePath, exact);
    const { graph, nodes } = makeGraphMock();
    makeFileIngestCallback(graph, 'ws', null, allow(tmp))(filePath);
    await new Promise(r => setTimeout(r, 50));
    assert.ok(!nodes[0].content.includes('[truncated'));
    assert.equal(nodes[0].content.length, MAX_AUTO_INGEST_BYTES);
    fs.rmSync(tmp, { recursive: true });
});

test('[regression] callback return value is void (fire-and-forget)', () => {
    const { graph } = makeGraphMock();
    const cb = makeFileIngestCallback(graph, 'ws');
    const result = cb('/nonexistent.md');
    assert.equal(result, undefined);
});

// re-audit 2026-06-25 (security) — the watcher is an ingestion entry point and
// now gates the path through assertPathAllowed, like the MCP tool + /api/ingest.
test('[security] a file OUTSIDE the allowlist is refused — no node ingested', async () => {
    const allowedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-allowed-'));
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-other-'));
    const outside = path.join(otherDir, 'leak.md');
    fs.writeFileSync(outside, 'must not be ingested');
    const { graph, nodes } = makeGraphMock();
    // allowlist permits allowedDir only; the file lives in otherDir.
    makeFileIngestCallback(graph, 'ws', null, allow(allowedDir))(outside);
    await new Promise(r => setTimeout(r, 50));
    assert.equal(nodes.length, 0, 'a file outside the allowlist must not be ingested');
    fs.rmSync(allowedDir, { recursive: true });
    fs.rmSync(otherDir, { recursive: true });
});

test('[security] a credential-looking basename under an allowed root is refused', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-cred-'));
    const cred = path.join(tmp, 'id_rsa'); // blocklisted basename
    fs.writeFileSync(cred, 'PRIVATE KEY MATERIAL');
    const { graph, nodes } = makeGraphMock();
    makeFileIngestCallback(graph, 'ws', null, allow(tmp))(cred);
    await new Promise(r => setTimeout(r, 50));
    assert.equal(nodes.length, 0, 'a credential-named file must not be ingested even under an allowed root');
    fs.rmSync(tmp, { recursive: true });
});

/* ═══════════════════════════════════════════════════════════════
   #11 — LORE_WATCH_PATHS in ingestion allowlist
   ═══════════════════════════════════════════════════════════════ */

console.log('\n#11 — loadWatchPathsAsRoots / loadAllExtraRoots');

// SW-15 (A5): LORE_WATCH_PATHS entries are now validated — only paths
// strictly under the user's home survive; system roots and out-of-home
// paths are dropped. These tests therefore use under-home paths; the
// rejection behavior is pinned in sw15-ingestion-allowlist-unit.ts.
const HOME = os.homedir();
const underHome = (...parts: string[]): string => path.join(HOME, ...parts);

test('[happy] loadWatchPathsAsRoots returns absolute paths from env', () => {
    const a = underHome('sw11-docs');
    const b = underHome('sw11-workspace', 'notes');
    withEnv({ LORE_WATCH_PATHS: `${a}:${b}` }, () => {
        const roots = loadWatchPathsAsRoots();
        assert.deepEqual(roots, [a, b]);
    });
});

test('[happy] loadAllExtraRoots merges ingestion.json + LORE_WATCH_PATHS', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-allow-'));
    // NW-1a: ingestion.json roots are now filtered at read-time by isWatchRootSafe
    // (matches the LORE_WATCH_PATHS behavior SW-15 added). Use an under-home path
    // for the ingestion.json value; the rejection-of-system-roots behavior is
    // pinned in test/nw1a-ingestion-root-bypass-unit.ts.
    const cfg = underHome('nw1a-cfg-root');
    fs.writeFileSync(path.join(tmp, 'ingestion.json'), JSON.stringify({ roots: [cfg] }));
    const watch = underHome('sw11-watch-root');
    withEnv({ LORE_WATCH_PATHS: watch }, () => {
        const roots = loadAllExtraRoots(tmp);
        assert.ok(roots.includes(cfg), 'missing ingestion.json root');
        assert.ok(roots.includes(watch), 'missing LORE_WATCH_PATHS root');
    });
    fs.rmSync(tmp, { recursive: true });
});

test('[unhappy] non-absolute paths in LORE_WATCH_PATHS are dropped', () => {
    const abs = underHome('sw11-absolute');
    withEnv({ LORE_WATCH_PATHS: `relative/path:${abs}` }, () => {
        const roots = loadWatchPathsAsRoots();
        assert.deepEqual(roots, [abs]);
    });
});

test('[unhappy] empty LORE_WATCH_PATHS yields empty array', () => {
    withEnv({ LORE_WATCH_PATHS: '' }, () => {
        assert.deepEqual(loadWatchPathsAsRoots(), []);
    });
});

test('[unhappy] unset LORE_WATCH_PATHS yields empty array', () => {
    withEnv({ LORE_WATCH_PATHS: undefined }, () => {
        assert.deepEqual(loadWatchPathsAsRoots(), []);
    });
});

test('[adversarial] duplicate path in LORE_WATCH_PATHS and ingestion.json → deduplicated', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-allow-'));
    const shared = underHome('sw11-shared');
    fs.writeFileSync(path.join(tmp, 'ingestion.json'), JSON.stringify({ roots: [shared] }));
    withEnv({ LORE_WATCH_PATHS: shared }, () => {
        const roots = loadAllExtraRoots(tmp);
        const count = roots.filter(r => r === shared).length;
        assert.equal(count, 1, 'duplicated path should appear only once');
    });
    fs.rmSync(tmp, { recursive: true });
});

test('[adversarial] whitespace-padded LORE_WATCH_PATHS entries are trimmed', () => {
    const a = underHome('sw11-padded');
    const b = underHome('sw11-other');
    withEnv({ LORE_WATCH_PATHS: `  ${a}  : ${b} ` }, () => {
        const roots = loadWatchPathsAsRoots();
        assert.deepEqual(roots, [a, b]);
    });
});

test('[regression] missing ingestion.json → watch paths still returned', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-allow-'));
    // no ingestion.json written
    const watch = underHome('sw11-watch-only');
    withEnv({ LORE_WATCH_PATHS: watch }, () => {
        const roots = loadAllExtraRoots(tmp);
        assert.ok(roots.includes(watch));
    });
    fs.rmSync(tmp, { recursive: true });
});

/* ═══════════════════════════════════════════════════════════════
   #12 — LocalSourceWatcher recursive option
   ═══════════════════════════════════════════════════════════════ */

console.log('\n#12 — LocalSourceWatcher recursive option');

test('[happy] readRecursive returns true for "true"', () => {
    withEnv({ LORE_WATCH_RECURSIVE: 'true' }, () => {
        assert.equal(LocalSourceWatcher.readRecursive(), true);
    });
});

test('[happy] readRecursive returns true for "1"', () => {
    withEnv({ LORE_WATCH_RECURSIVE: '1' }, () => {
        assert.equal(LocalSourceWatcher.readRecursive(), true);
    });
});

test('[happy] readRecursive returns true for "yes"', () => {
    withEnv({ LORE_WATCH_RECURSIVE: 'yes' }, () => {
        assert.equal(LocalSourceWatcher.readRecursive(), true);
    });
});

test('[happy] readRecursive is case-insensitive (TRUE / YES / 1)', () => {
    for (const val of ['TRUE', 'True', 'YES', 'Yes']) {
        withEnv({ LORE_WATCH_RECURSIVE: val }, () => {
            assert.equal(LocalSourceWatcher.readRecursive(), true, `failed for ${val}`);
        });
    }
});

test('[unhappy] readRecursive returns false when unset', () => {
    withEnv({ LORE_WATCH_RECURSIVE: undefined }, () => {
        assert.equal(LocalSourceWatcher.readRecursive(), false);
    });
});

test('[unhappy] readRecursive returns false for "false" / "0" / "no"', () => {
    for (const val of ['false', '0', 'no', 'off', '']) {
        withEnv({ LORE_WATCH_RECURSIVE: val }, () => {
            assert.equal(LocalSourceWatcher.readRecursive(), false, `should be false for "${val}"`);
        });
    }
});

test('[e2e] recursive=true: file created in subdirectory triggers callback', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-rec-'));
    const subdir = path.join(tmp, 'subdir');
    fs.mkdirSync(subdir);

    const received: string[] = [];
    const w = new LocalSourceWatcher();
    w.start((fp) => received.push(fp), [tmp], 50, true);

    // macOS fs.watch (kqueue) needs ~150ms to arm before events fire
    await new Promise(r => setTimeout(r, 200));

    const testFile = path.join(subdir, 'deep.md');
    fs.writeFileSync(testFile, 'recursive content');

    // wait for debounce (50ms) + event loop + margin
    await new Promise(r => setTimeout(r, 300));
    await w.stop();
    fs.rmSync(tmp, { recursive: true });

    // On Linux, recursive fs.watch is not supported and silently falls back
    // to non-recursive — we accept either 0 or 1 here (platform-dependent).
    // On macOS and Windows it must fire exactly once.
    const platform = process.platform;
    if (platform === 'darwin' || platform === 'win32') {
        assert.equal(received.length, 1, `expected 1 event, got ${received.length}`);
        assert.ok(received[0].endsWith('deep.md'));
    } else {
        // Linux: accept 0 (non-recursive fallback) or 1 (if kernel supports it)
        assert.ok(received.length <= 1, 'unexpected extra events on Linux');
    }
});

test('[regression] non-recursive (default) does NOT fire for subdir files', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-nonrec-'));
    const subdir = path.join(tmp, 'subdir');
    fs.mkdirSync(subdir);

    const received: string[] = [];
    const w = new LocalSourceWatcher();
    w.start((fp) => received.push(fp), [tmp], 50, false);

    await new Promise(r => setTimeout(r, 200));
    fs.writeFileSync(path.join(subdir, 'hidden.md'), 'hidden');
    await new Promise(r => setTimeout(r, 300));
    await w.stop();
    fs.rmSync(tmp, { recursive: true });

    assert.equal(received.length, 0, 'non-recursive watcher should not see subdirectory file');
});

/* ═══════════════════════════════════════════════════════════════
   #13 — syncVectorMirror.ts extraction regression
   ═══════════════════════════════════════════════════════════════ */

console.log('\n#13 — syncVectorMirror regression');

test('[happy] upsertVectorMirror stores item with id "lore:<nodeId>"', async () => {
    const vs = makeVectorStoreMock();
    const node = makeNode({ id: 'abc-123' });
    await upsertVectorMirror(vs as never, node);
    assert.equal(vs.stored.length, 1);
    assert.equal((vs.stored[0] as { id: string }).id, 'lore:abc-123');
});

test('[happy] upsertVectorMirror metadata includes type, label, tags, project, ecosystem', async () => {
    const vs = makeVectorStoreMock();
    const node = makeNode({ type: 'decision', label: 'My Label', tags: 'x,y', project: 'proj', ecosystem: 'eco' });
    await upsertVectorMirror(vs as never, node);
    const stored = vs.stored[0] as { metadata: Record<string, unknown> };
    assert.equal(stored.metadata.type, 'decision');
    assert.equal(stored.metadata.label, 'My Label');
    assert.equal(stored.metadata.tags, 'x,y');
    assert.equal(stored.metadata.project, 'proj');
    assert.equal(stored.metadata.ecosystem, 'eco');
});

test('[happy] upsertVectorMirror is no-op when vectorStore is null', async () => {
    // must not throw
    await upsertVectorMirror(null, makeNode());
});

test('[happy] recoverVectorMirrors recovers a known node', async () => {
    const vs = makeVectorStoreMock();
    const node = makeNode({ id: 'node-recover' });
    const graph = {
        getNode: async (id: string) => (id === 'node-recover' ? node : null),
    } as unknown as LoreGraphHandle;
    const result = await recoverVectorMirrors(vs as never, graph, ['node-recover']);
    assert.equal(result.recovered, 1);
    assert.equal(result.skipped, 0);
    assert.equal(vs.stored.length, 1);
});

test('[unhappy] recoverVectorMirrors skips missing nodes', async () => {
    const vs = makeVectorStoreMock();
    const graph = {
        getNode: async () => null,
    } as unknown as LoreGraphHandle;
    const result = await recoverVectorMirrors(vs as never, graph, ['missing-1', 'missing-2']);
    assert.equal(result.recovered, 0);
    assert.equal(result.skipped, 2);
    assert.equal(vs.stored.length, 0);
});

test('[unhappy] upsertVectorMirror catches store errors without re-throwing', async () => {
    const vs = makeVectorStoreMock();
    vs.throwNext = true;
    await assert.doesNotReject(async () => {
        await upsertVectorMirror(vs as never, makeNode());
    });
});

test('[regression] recoverVectorMirrors with null vectorStore returns skipped=nodeIds.length', async () => {
    const graph = { getNode: async () => null } as unknown as
        LoreGraphHandle;
    const result = await recoverVectorMirrors(null, graph, ['a', 'b', 'c']);
    assert.equal(result.recovered, 0);
    assert.equal(result.skipped, 3);
});

test('[regression] upsertVectorMirror text field contains label and content', async () => {
    const vs = makeVectorStoreMock();
    const node = makeNode({ label: 'My Title', content: 'Body text here' });
    await upsertVectorMirror(vs as never, node);
    const stored = vs.stored[0] as { text: string };
    assert.ok(stored.text.includes('My Title'), 'text should include label');
    assert.ok(stored.text.includes('Body text here'), 'text should include content');
});

/* ═══════════════════════════════════════════════════════════════
   Wishlist — W1: Linux recursive watcher static pre-scan
   ═══════════════════════════════════════════════════════════════ */

console.log('\nW1 — Linux recursive: static subdir pre-scan');

test('[happy] watcherCount > 1 when recursive=true and subdirs exist', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-w1-'));
    fs.mkdirSync(path.join(tmp, 'sub1'));
    fs.mkdirSync(path.join(tmp, 'sub2'));
    const w = new LocalSourceWatcher();
    w.start(() => {}, [tmp], 50, true);
    // On Linux the static pre-scan opens one handle per directory;
    // on macOS/Windows a single recursive handle covers all.
    if (process.platform === 'linux') {
        assert.ok(w.watcherCount >= 3, `expected ≥3 handles on Linux, got ${w.watcherCount}`);
    } else {
        assert.equal(w.watcherCount, 1, 'macOS/Windows: one native recursive handle');
    }
    await w.stop();
    fs.rmSync(tmp, { recursive: true });
});

test('[happy] Linux pre-scan catches file in existing nested subdir', async () => {
    if (process.platform !== 'linux') {
        console.log('  (skip — Linux-only test)');
        return;
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-w1-'));
    const deep = path.join(tmp, 'a', 'b');
    fs.mkdirSync(deep, { recursive: true });

    const received: string[] = [];
    const w = new LocalSourceWatcher();
    w.start((fp) => received.push(fp), [tmp], 50, true);
    await new Promise(r => setTimeout(r, 200));
    fs.writeFileSync(path.join(deep, 'doc.md'), 'content');
    await new Promise(r => setTimeout(r, 300));
    await w.stop();
    fs.rmSync(tmp, { recursive: true });

    assert.equal(received.length, 1);
    assert.ok(received[0].endsWith('doc.md'));
});

test('[regression] watcherCount is 1 when non-recursive regardless of subdirs', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-w1-'));
    fs.mkdirSync(path.join(tmp, 'ignored'));
    const w = new LocalSourceWatcher();
    w.start(() => {}, [tmp], 50, false);
    assert.equal(w.watcherCount, 1);
    await w.stop();
    fs.rmSync(tmp, { recursive: true });
});

/* ═══════════════════════════════════════════════════════════════
   Wishlist — W2: freshness locally-updated fallback
   ═══════════════════════════════════════════════════════════════ */

console.log('\nW2 — Freshness: locally-updated nodes count as fresh');

const NOW = new Date('2026-01-01T12:00:00Z').getTime();
const H = 3_600_000;

function freshLocalNode(hoursAgo = 1): LoreNode {
    // syncedAt null (never synced), updatedAt recent → should be fresh
    return {
        id: `local-${Math.random().toString(36).slice(2)}`,
        type: 'note', label: 'x', content: 'x', tags: '', project: 'ws',
        ecosystem: '*', metadata: '{}',
        createdAt: new Date(NOW - hoursAgo * H).toISOString(),
        updatedAt: new Date(NOW - hoursAgo * H).toISOString(),
        syncedAt: null,
    } as LoreNode;
}

function staleLocalNode(): LoreNode {
    // syncedAt null, updatedAt old → neverSynced bucket
    return {
        id: `stale-${Math.random().toString(36).slice(2)}`,
        type: 'note', label: 'x', content: 'x', tags: '', project: 'ws',
        ecosystem: '*', metadata: '{}',
        createdAt: new Date(NOW - 48 * H).toISOString(),
        updatedAt: new Date(NOW - 48 * H).toISOString(),
        syncedAt: null,
    } as LoreNode;
}

test('[happy] node with null syncedAt + recent updatedAt is counted as fresh', () => {
    const report = computeFreshness([freshLocalNode(1)], 'ws', 24, NOW);
    assert.equal(report.freshNodes, 1);
    assert.equal(report.neverSyncedNodes, 0);
    assert.equal(report.freshnessPercent, 100);
});

test('[happy] node with null syncedAt + old updatedAt lands in neverSyncedNodes', () => {
    const report = computeFreshness([staleLocalNode()], 'ws', 24, NOW);
    assert.equal(report.freshNodes, 0);
    assert.equal(report.neverSyncedNodes, 1);
});

test('[happy] mixed: synced-fresh + locally-fresh + neverSynced counted correctly', () => {
    const syncedFreshNode: LoreNode = {
        id: 'sf', type: 'note', label: 'x', content: 'x', tags: '', project: 'ws',
        ecosystem: '*', metadata: '{}',
        createdAt: new Date(NOW - H).toISOString(),
        updatedAt: new Date(NOW - H).toISOString(),
        syncedAt: new Date(NOW - H).toISOString(),
    } as LoreNode;
    const nodes = [syncedFreshNode, freshLocalNode(2), staleLocalNode()];
    const report = computeFreshness(nodes, 'ws', 24, NOW);
    assert.equal(report.totalNodes, 3);
    assert.equal(report.freshNodes, 2);   // synced-fresh + locally-fresh
    assert.equal(report.neverSyncedNodes, 1);
    assert.equal(report.freshnessPercent, 100); // 2 fresh / (3 - 1 never-synced) = 100%
});

test('[adversarial] node with null syncedAt and null updatedAt → neverSynced', () => {
    const n = { ...freshLocalNode(1), updatedAt: null as unknown as string };
    const report = computeFreshness([n], 'ws', 24, NOW);
    assert.equal(report.neverSyncedNodes, 1);
    assert.equal(report.freshNodes, 0);
});

test('[regression] previously-synced nodes still use syncedAt (not updatedAt)', () => {
    // syncedAt stale (48h ago), updatedAt fresh (1h ago) → should be STALE, not fresh
    const n: LoreNode = {
        id: 'mixed', type: 'note', label: 'x', content: 'x', tags: '', project: 'ws',
        ecosystem: '*', metadata: '{}',
        createdAt: new Date(NOW - 48 * H).toISOString(),
        updatedAt: new Date(NOW - H).toISOString(),
        syncedAt: new Date(NOW - 48 * H).toISOString(),
    } as LoreNode;
    const report = computeFreshness([n], 'ws', 24, NOW);
    assert.equal(report.staleNodes, 1);
    assert.equal(report.freshNodes, 0);
});

/* ═══════════════════════════════════════════════════════════════
   Wishlist — W3: stopAllLocalWatchers SIGTERM cleanup
   ═══════════════════════════════════════════════════════════════ */

console.log('\nW3 — stopAllLocalWatchers');

test('[happy] stopAllLocalWatchers stops the stashed LocalSourceWatcher', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-w3-'));
    const w = new LocalSourceWatcher();
    w.start(() => {}, [tmp], 50, false);
    assert.equal(w.isRunning, true);

    // Simulate what startLocalSourceWatcher() does: stash on globalThis.
    (globalThis as Record<string, unknown>).__loreSourceWatcher = w;
    stopAllLocalWatchers();
    await new Promise(r => setTimeout(r, 20)); // let the void stop() settle

    assert.equal(w.isRunning, false, 'watcher should be stopped after stopAllLocalWatchers()');
    delete (globalThis as Record<string, unknown>).__loreSourceWatcher;
    fs.rmSync(tmp, { recursive: true });
});

test('[regression] stopAllLocalWatchers is safe when no watcher is stashed', () => {
    delete (globalThis as Record<string, unknown>).__loreSourceWatcher;
    assert.doesNotThrow(() => stopAllLocalWatchers());
});

/* ═══════════════════════════════════════════════════════════════
   Wishlist — W4: auto-embed to verbatimStore
   ═══════════════════════════════════════════════════════════════ */

console.log('\nW4 — Auto-embed: makeFileIngestCallback with verbatimStore');

test('[happy] verbatimStore.store() called when verbatimStore provided', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-w4-'));
    const filePath = path.join(tmp, 'note.md');
    fs.writeFileSync(filePath, 'embed me');
    const { graph } = makeGraphMock();
    const vs = makeVectorStoreMock();
    makeFileIngestCallback(graph, 'ws', vs as never, allow(tmp))(filePath);
    await new Promise(r => setTimeout(r, 100));
    assert.equal(vs.stored.length, 1, 'vector store should have received one entry');
    const item = vs.stored[0] as { id: string; text: string; metadata: Record<string, unknown> };
    assert.ok(item.id.startsWith('lore:file:'), `unexpected id: ${item.id}`);
    assert.ok(item.text.includes('embed me'), 'text should include file content');
    fs.rmSync(tmp, { recursive: true });
});

test('[happy] verbatimStore metadata has correct type and project fields', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-w4-'));
    const filePath = path.join(tmp, 'check.md');
    fs.writeFileSync(filePath, 'meta check');
    const { graph } = makeGraphMock();
    const vs = makeVectorStoreMock();
    makeFileIngestCallback(graph, 'acme', vs as never, allow(tmp))(filePath);
    await new Promise(r => setTimeout(r, 100));
    const item = vs.stored[0] as { metadata: Record<string, unknown> };
    assert.equal(item.metadata.type, 'note');
    assert.equal(item.metadata.project, 'acme');
    fs.rmSync(tmp, { recursive: true });
});

test('[unhappy] verbatimStore error does not abort graph write', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-w4-'));
    const filePath = path.join(tmp, 'safe.md');
    fs.writeFileSync(filePath, 'content');
    const { graph, nodes } = makeGraphMock();
    const vs = makeVectorStoreMock();
    vs.throwNext = true;
    makeFileIngestCallback(graph, 'ws', vs as never, allow(tmp))(filePath);
    await new Promise(r => setTimeout(r, 100));
    assert.equal(nodes.length, 1, 'graph node should still be written despite embed error');
    fs.rmSync(tmp, { recursive: true });
});

test('[regression] no verbatimStore arg → graph write still works, no crash', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-w4-'));
    const filePath = path.join(tmp, 'plain.md');
    fs.writeFileSync(filePath, 'plain');
    const { graph, nodes } = makeGraphMock();
    makeFileIngestCallback(graph, 'ws', null, allow(tmp))(filePath); // no verbatimStore arg
    await new Promise(r => setTimeout(r, 100));
    assert.equal(nodes.length, 1);
    fs.rmSync(tmp, { recursive: true });
});

/* ─── run ──────────────────────────────────────────────────────── */

await Promise.all(pending);

console.log(`\n${passed + failed} tests · ${passed} passed · ${failed} failed`);
if (failed > 0) process.exit(1);
