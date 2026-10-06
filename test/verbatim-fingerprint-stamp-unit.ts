#!/usr/bin/env tsx
/**
 * test/verbatim-fingerprint-stamp-unit.ts — every open of a Lance verbatim
 * store with a real embedding provider leaves `.lore/lancedb/embedding_model.json`
 * behind whenever the `lore_verbatim` table exists.
 *
 * Atlas had `<ws>/.lore/lancedb/lore_verbatim.lance` with NO embedding_model.json
 * (so `migrate-vectors` refused it) although the workspace was opened many times
 * through createLore(). Reproduced against real LanceDB in temp homes:
 *
 *   (1) role:'read' never opened the write table, so the legacy stamp (which
 *       required `this.table != null`) never ran — boot workspace or not;
 *   (2) the prebuilt-row bulk path (bulkAdd/bulkUpsertPrebuiltRows) created the
 *       table without stamping it;
 *   (3) a non-boot workspace is not opened by createLore() at all — only the
 *       first use (recall / nodeUpsert) opens it, through the resolver.
 *
 * Fix under test: a missing fingerprint is stamped on open in every role when
 * the table's vector width equals the provider's (else warn + no stamp), table
 * birth stamps from every creation path, an existing fingerprint is never
 * overwritten, and a Null provider never stamps.
 *
 * Every store lives under os.tmpdir(); nothing touches ~/.groundfloor.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import {
    readFingerprint, writeFingerprint, writeFingerprintIfAbsent, getFingerprintPath, _deleteFingerprintForTests,
} from '../packages/lore/src/engines/embeddingFingerprint.js';
import { NullEmbeddingProvider } from '../packages/lore/src/providers/nullEmbeddingProvider.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';
import type { VerbatimStoreRole } from '../packages/lore/src/engines/verbatimStoreRole.js';

const DIM = 8;
const MODEL = 'stamp-test-fake';

function provider(dim = DIM, modelId = MODEL): EmbeddingProvider {
    const v = () => Array.from({ length: dim }, () => 0.1);
    return {
        modelId, dimension: dim,
        async initialize() { /* no-op */ },
        async embed() { return v(); },
        async embedDocument() { return v(); },
        async embedQuery() { return v(); },
        async embedDocumentBatch(ts: string[]) { return ts.map(v); },
    };
}

const UPDATED = '2026-10-05T00:00:00.000Z';
const prebuilt = (tag: string, dim = DIM): Array<Record<string, unknown>> => [{
    vector: Array.from({ length: dim }, () => 0), id: `${tag}:1`, text: `bulk ${tag}`, type: 'note', label: '', tags: '',
    project: 'p', ecosystem: 'e', updatedAt: UPDATED, security_scopes: [], contentHash: `h-${tag}`,
}];

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-fp-stamp-'));
let n = 0;
const wsDir = (): string => { const d = path.join(root, `ws${++n}`); fs.mkdirSync(path.join(d, '.lore'), { recursive: true }); return d; };

/** Capture stderr (the logger's only sink) while `fn` runs. */
async function captureStderr<T>(fn: () => Promise<T>): Promise<{ value: T; text: string }> {
    const orig = process.stderr.write.bind(process.stderr);
    let text = '';
    (process.stderr.write as unknown) = (chunk: unknown): boolean => { text += String(chunk); return true; };
    try { return { value: await fn(), text }; } finally { process.stderr.write = orig; }
}

/** An Atlas-shaped workspace: lore_verbatim exists, embedding_model.json does not. */
async function seedUnstamped(dim = DIM, dir = wsDir()): Promise<string> {
    const s = new VerbatimStore(dir, provider(dim));
    await s.initialize();
    await s.bulkUpsertPrebuiltRows(prebuilt('seed', dim));
    await s.close();
    _deleteFingerprintForTests(dir);
    assert.equal(readFingerprint(dir), null, 'precondition: seeded workspace has no fingerprint');
    assert.ok(fs.existsSync(path.join(dir, '.lore', 'lancedb', 'lore_verbatim.lance')), 'precondition: table on disk');
    return dir;
}

async function openClose(dir: string, p: EmbeddingProvider, role?: VerbatimStoreRole, strict = false): Promise<void> {
    const s = new VerbatimStore(dir, p, { ...(role ? { role } : {}), strictFingerprintCheck: strict });
    await s.initialize();
    await s.close();
}

console.log('\nVerbatimStore — embedding fingerprint is stamped whenever the table exists\n');

// ── table birth, every creation path ─────────────────────────────────────────
for (const [label, create] of [
    ['bulkUpsertPrebuiltRows', (s: VerbatimStore) => s.bulkUpsertPrebuiltRows(prebuilt('b1'))],
    ['bulkAddPrebuiltRows', (s: VerbatimStore) => s.bulkAddPrebuiltRows(prebuilt('b2'))],
    ['store', (s: VerbatimStore) => s.store({ id: 'n:1', text: 'hello', metadata: { type: 'note', project: 'p', ecosystem: 'e', updatedAt: UPDATED } })],
    ['storeBatch', (s: VerbatimStore) => s.storeBatch([{ id: 'n:2', text: 'hello', metadata: { type: 'note', project: 'p', ecosystem: 'e', updatedAt: UPDATED } }])],
] as const) {
    await test(`table birth via ${label} stamps the fingerprint`, async () => {
        const dir = wsDir();
        const s = new VerbatimStore(dir, provider());
        await s.initialize();
        assert.equal(readFingerprint(dir), null, 'no table yet, nothing stamped');
        await create(s);
        await s.close();
        const fp = readFingerprint(dir);
        assert.equal(fp?.modelId, MODEL);
        assert.equal(fp?.dimension, DIM);
    });
}

// ── legacy table, open in every role ─────────────────────────────────────────
for (const role of ['both', 'write', 'read'] as const) {
    await test(`legacy table (no fingerprint) is stamped on open, role:'${role}'`, async () => {
        const dir = await seedUnstamped();
        await openClose(dir, provider(), role);
        const fp = readFingerprint(dir);
        assert.equal(fp?.modelId, MODEL);
        assert.equal(fp?.dimension, DIM);
    });
}

await test('legacy table is stamped on open under a strict (injected) provider, role:read', async () => {
    const dir = await seedUnstamped();
    await openClose(dir, provider(), 'read', true);
    assert.equal(readFingerprint(dir)?.modelId, MODEL);
});

await test('role:read stamping does not write the table (no new Lance version)', async () => {
    const dir = await seedUnstamped();
    const versionsDir = path.join(dir, '.lore', 'lancedb', 'lore_verbatim.lance', '_versions');
    const before = fs.readdirSync(versionsDir).sort();
    await openClose(dir, provider(), 'read');
    assert.equal(readFingerprint(dir)?.modelId, MODEL);
    assert.deepEqual(fs.readdirSync(versionsDir).sort(), before, 'a read-role open must not commit to the table');
});

// ── dimension safety ─────────────────────────────────────────────────────────
for (const role of ['both', 'read'] as const) {
    await test(`dimension mismatch is not stamped and warns, role:'${role}'`, async () => {
        const dir = await seedUnstamped(DIM);
        const { text } = await captureStderr(() => openClose(dir, provider(DIM * 2, 'other-model'), role));
        assert.equal(readFingerprint(dir), null, 'no fingerprint may be derived from a provider that cannot have written these vectors');
        assert.match(text, /not stamping/);
        assert.match(text, new RegExp(`${DIM}-dimensional`));
        assert.match(text, new RegExp(`${DIM * 2}-dimensional`));
    });
}

// ── never overwrite ──────────────────────────────────────────────────────────
for (const role of ['both', 'write', 'read'] as const) {
    await test(`an existing fingerprint is never overwritten, role:'${role}'`, async () => {
        const dir = await seedUnstamped();
        writeFingerprint(dir, { modelId: 'the-original-model', dimension: DIM });
        const before = fs.readFileSync(getFingerprintPath(dir), 'utf8');
        await captureStderr(() => openClose(dir, provider(DIM, 'a-different-model'), role)); // non-strict: warn-only
        assert.equal(fs.readFileSync(getFingerprintPath(dir), 'utf8'), before);
    });
}

await test('strict mismatch against an existing fingerprint still refuses (unchanged)', async () => {
    const dir = await seedUnstamped();
    writeFingerprint(dir, { modelId: 'the-original-model', dimension: DIM });
    await captureStderr(async () => {
        await assert.rejects(() => openClose(dir, provider(DIM, 'a-different-model'), 'both', true), /EmbeddingFingerprintMismatch|fingerprint/i);
    });
    assert.equal(readFingerprint(dir)?.modelId, 'the-original-model');
});

await test('writeFingerprintIfAbsent: first writer wins, racers never overwrite', async () => {
    const dir = wsDir();
    const results = await Promise.all(
        ['m1', 'm2', 'm3', 'm4'].map(async (m) => writeFingerprintIfAbsent(dir, { modelId: m, dimension: DIM })),
    );
    const winners = results.filter((r) => r != null);
    assert.equal(winners.length, 1, 'exactly one racer stamps');
    assert.equal(readFingerprint(dir)?.modelId, winners[0]!.modelId);
    assert.equal(writeFingerprintIfAbsent(dir, { modelId: 'late', dimension: DIM }), null);
    assert.equal(readFingerprint(dir)?.modelId, winners[0]!.modelId);
    const leftovers = fs.readdirSync(path.dirname(getFingerprintPath(dir))).filter((f) => f.includes('.tmp-'));
    assert.deepEqual(leftovers, [], 'no staging files left behind');
});

// ── Null provider ────────────────────────────────────────────────────────────
for (const role of ['both', 'write', 'read'] as const) {
    await test(`a Null provider never stamps (legacy table), role:'${role}'`, async () => {
        const dir = await seedUnstamped();
        await openClose(dir, new NullEmbeddingProvider() as unknown as EmbeddingProvider, role);
        assert.equal(readFingerprint(dir), null);
        assert.ok(!fs.existsSync(getFingerprintPath(dir)));
    });
}

await test('a Null provider never stamps at table birth', async () => {
    const dir = wsDir();
    const s = new VerbatimStore(dir, new NullEmbeddingProvider() as unknown as EmbeddingProvider);
    await s.initialize();
    await s.bulkUpsertPrebuiltRows(prebuilt('nullbirth')).catch(() => undefined); // the Null provider may refuse writes; either way, no stamp
    await s.close();
    assert.equal(readFingerprint(dir), null);
});

// ── through createLore() (the Atlas path) ────────────────────────────────────
const prevHome = process.env['LORE_HOME'];
const { createLore } = await import('../packages/lore/src/index.js');

/** A home with a boot workspace ('default') and one non-boot workspace ('other'), both Atlas-shaped. */
async function atlasHome(): Promise<{ h: string; other: string }> {
    const h = fs.mkdtempSync(path.join(root, 'home-'));
    const other = path.join(h, 'workspaces', 'other');
    fs.mkdirSync(path.join(h, '.lore'), { recursive: true });
    await seedUnstamped(DIM, h);
    await seedUnstamped(DIM, other);
    fs.writeFileSync(path.join(h, 'workspaces.json'), JSON.stringify({
        active: 'default',
        workspaces: [
            { name: 'default', path: h, createdAt: '2026-06-15T00:00:00.000Z' },
            { name: 'other', path: other, createdAt: '2026-06-15T00:00:00.000Z' },
        ],
    }, null, 2));
    return { h, other };
}

for (const role of [undefined, 'read'] as const) {
    await test(`createLore(${role ? `vectorStoreRole:'${role}'` : 'default role'}): boot workspace is stamped at open`, async () => {
        const { h } = await atlasHome();
        process.env['LORE_HOME'] = h;
        const lore = await createLore({ deploymentMode: 'embedded', dataDir: h, embeddingProvider: provider(), ...(role ? { vectorStoreRole: role } : {}) } as never);
        try {
            const fp = readFingerprint(h);
            assert.equal(fp?.modelId, MODEL);
            assert.equal(fp?.dimension, DIM);
        } finally { await lore.dispose(); }
    });

    await test(`createLore(${role ? `vectorStoreRole:'${role}'` : 'default role'}): non-boot workspace is stamped when first opened (recall)`, async () => {
        const { h, other } = await atlasHome();
        process.env['LORE_HOME'] = h;
        const lore = await createLore({ deploymentMode: 'embedded', dataDir: h, embeddingProvider: provider(), ...(role ? { vectorStoreRole: role } : {}) } as never);
        try {
            await lore.recall('anything', { workspace: 'other' } as never);
            const fp = readFingerprint(other);
            assert.equal(fp?.modelId, MODEL);
            assert.equal(fp?.dimension, DIM);
        } finally { await lore.dispose(); }
    });
}

await test('Atlas-shaped workspace (table, no json) has model + dimension on disk after createLore, ready for migrate-vectors', async () => {
    const { h } = await atlasHome();
    process.env['LORE_HOME'] = h;
    const lore = await createLore({ deploymentMode: 'embedded', dataDir: h, embeddingProvider: provider(), vectorStoreRole: 'read' } as never);
    await lore.dispose();
    const json = JSON.parse(fs.readFileSync(path.join(h, '.lore', 'lancedb', 'embedding_model.json'), 'utf8')) as { modelId: string; dimension: number };
    assert.equal(json.modelId, MODEL);
    assert.equal(json.dimension, DIM);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
fs.rmSync(root, { recursive: true, force: true });
if (prevHome === undefined) delete process.env['LORE_HOME']; else process.env['LORE_HOME'] = prevHome;
process.exit(failed ? 1 : 0);
