#!/usr/bin/env tsx
/**
 * migrate-probes-any-script-unit.ts — 3.27.2: the live read probes of
 * `lore migrate-vectors` / `lore migrate-graph` verify the SAMPLED ROW / NODE
 * itself (id-filtered membership, self-retrieval), not top-N membership or
 * cross-engine rank order. Real LanceDB + SQLite (and Surreal for the graph)
 * stores in temp dirs, driven through the real migrate functions / CLI.
 *
 *   A. keywordCandidates: whole-word letter runs in any script.
 *   B. migrate-vectors bm25 probe: Atlas repro (60 rows share "final", long
 *      sampled row ranks low), score ties, mid-token text, stopword first
 *      candidate, Bengali/Arabic/Russian/Spanish/CJK, a REAL miss (sampled row
 *      removed from the SQLite FTS index) -> MISMATCH + abort + Lance intact.
 *   C. vector probe: >10 identical vectors pass; sampled vector removed from
 *      SQLite -> MISMATCH. D. zero samples -> "no probe samples", passes.
 *   E. non-English Lance FTS sidecar -> warning; English -> none.
 *   F. migrate-graph search probe: >20 nodes match, sampled node found; a node
 *      missing from the target -> MISMATCH; rollback CLI text + tarball path.
 *
 * Run: npx tsx test/migrate-probes-any-script-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as lancedb from '@lancedb/lancedb';
import Database from 'better-sqlite3';

import { createWorkspace, loadWorkspaces, setWorkspaceGraphEngine } from '../packages/lore/src/config/workspaces.js';
import { resolveWorkspaceVectorEngine } from '../packages/lore/src/engines/vectorEngineSelector.js';
import { resolveWorkspaceGraphEngine } from '../packages/lore/src/engines/graphEngineSelector.js';
import { migrateVectorsToSqlite } from '../packages/lore/src/engines/migrateVectorsToSqlite.js';
import { migrateGraphToSqlite, MigrationVerificationError } from '../packages/lore/src/engines/migrateGraphToSqlite.js';
import { keywordCandidates } from '../packages/lore/src/engines/probeKeywords.js';
import { mapLanceRow, digestOfHashes } from '../packages/lore/src/engines/migrateVectorsRows.js';
import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import { readTokenizerFingerprint } from '../packages/lore/src/engines/ftsTokenizerProfile.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

process.env['LORE_DEFAULT_VECTOR_ENGINE'] = 'lance';
delete process.env['LORE_SEARCH_WORKER'];

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}
const freshHome = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'lore-migprobe-home-'));
const outDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'lore-migprobe-out-'));

class DetEmbedProvider implements EmbeddingProvider {
    readonly dimension = 8;
    readonly modelId = 'migprobe-det';
    readonly dtype = 'fp32';
    async initialize(): Promise<void> {}
    private vec(text: string): number[] {
        const v = new Array(this.dimension).fill(0);
        for (let i = 0; i < text.length; i++) v[(i * 7 + text.charCodeAt(i)) % this.dimension] += text.charCodeAt(i) / 128;
        const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
        return v.map((x) => x / norm);
    }
    async embed(t: string): Promise<number[]> { return this.vec(t); }
    async embedQuery(t: string): Promise<number[]> { return this.vec(t); }
    async embedDocument(t: string): Promise<number[]> { return this.vec(t); }
}

async function lanceDigest(wsPath: string): Promise<string> {
    const conn = await lancedb.connect(path.join(wsPath, '.lore', 'lancedb'));
    try {
        const t = await conn.openTable('lore_verbatim');
        try {
            const rows = (await t.query().toArray()) as Record<string, unknown>[];
            return digestOfHashes(rows.map((r) => mapLanceRow(r, 'x').hash));
        } finally { t.close(); }
    } finally { conn.close(); }
}
const sqlitePathOf = (wsPath: string): string => path.join(wsPath, '.lore', 'verbatim.sqlite');

/** Lance workspace written through the real VerbatimStore, one row per text, in order. */
async function buildLanceWs(home: string, name: string, texts: string[]): Promise<string> {
    loadWorkspaces(home);
    const entry = createWorkspace(name, {}, home);
    assert.equal(entry.vectorEngine, 'lance');
    const s = new VerbatimStore(entry.path, new DetEmbedProvider());
    await s.initialize();
    for (let i = 0; i < texts.length; i++) {
        await s.store({ id: `${name}-r${i}`, text: texts[i]!, metadata: { type: 'note', label: `r${i}` } });
    }
    await s.close();
    return entry.path;
}

type Mig = Awaited<ReturnType<typeof migrateVectorsToSqlite>>;
async function migrate(home: string, name: string, extra: Partial<Parameters<typeof migrateVectorsToSqlite>[0]> = {}): Promise<Mig> {
    return migrateVectorsToSqlite({ workspaceName: name, home, backupOutDir: outDir(), skipDaemonCheck: true, ...extra });
}
const probeOk = (r: Mig): void => {
    assert.ok(!r.probeDetails.some((d) => d.startsWith('MISMATCH')), r.probeDetails.join('; '));
};

console.log('MIGRATE PROBES (any script, membership) — 3.27.2\n');

// ── A. keywordCandidates ────────────────────────────────────────────────
await test('keywordCandidates: whole words only, any script, text order, max 5, tombstone prefix stripped', async () => {
    assert.deepEqual(keywordCandidates('item12345 Zürich harbour'), ['zürich', 'harbour']);
    assert.ok(!keywordCandidates('item12345 Zürich').includes('item'));
    assert.ok(!keywordCandidates('item12345 Zürich').includes('rich'));
    assert.deepEqual(keywordCandidates('[TOMBSTONED: old] final report'), ['final', 'report']);
    assert.deepEqual(keywordCandidates('ab abc abcd snake_case_word 4ever'), ['abcd']);
    assert.deepEqual(keywordCandidates('alpha beta gamma delta epsilon zetas etas'), ['alpha', 'beta', 'gamma', 'delta', 'epsilon']);
    assert.deepEqual(keywordCandidates('alpha alpha alpha beta'), ['alpha', 'beta']);
    assert.deepEqual(keywordCandidates('Привет мир, столица России'), ['привет', 'столица', 'россии']);
    assert.deepEqual(keywordCandidates('東京は日本の首都です'), ['東京は日本の首都です']);
    assert.deepEqual(keywordCandidates('東京 は'), []);
    assert.equal(keywordCandidates('ঢাকা বাংলাদেশের রাজধানী').length, 3, 'Bengali words incl. combining marks');
    assert.deepEqual(keywordCandidates('1234 5678 --- ??'), []);
});

// ── B. bm25 probe ───────────────────────────────────────────────────────
function atlasTexts(n: number): string[] {
    const filler = Array.from({ length: 150 }, (_, i) => `lengthy${String.fromCharCode(97 + (i % 26))}${i}word`).join(' ');
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
        const long = i === 0 || i === Math.floor(n / 2) || i === n - 1;
        out.push(long ? `final ${filler} ${i}` : `final report ${i}`);
    }
    return out;
}

await test('Atlas repro: 60 rows share "final", the sampled (long) rows rank low -> probe passes, verified on SQLite', async () => {
    const home = freshHome();
    await buildLanceWs(home, 'pr-atlas', atlasTexts(60));
    const r = await migrate(home, 'pr-atlas');
    probeOk(r);
    assert.ok(r.probeDetails.some((d) => /bm25 verified on both for pr-atlas-r0 \(sqlite "final"/.test(d)), `lance + sqlite verified: ${r.probeDetails.join('; ')}`);
    assert.equal(resolveWorkspaceVectorEngine('pr-atlas', home), 'sqlite');
});

await test('60 identical-text rows (score ties) -> probe passes', async () => {
    const home = freshHome();
    await buildLanceWs(home, 'pr-ties', Array.from({ length: 60 }, () => 'identical harbour ledger entry'));
    const r = await migrate(home, 'pr-ties');
    probeOk(r);
    assert.ok(r.probeDetails.some((d) => d.startsWith('bm25 verified on both')), r.probeDetails.join('; '));
});

await test('mid-token text (item12345, Zürich): passes and the chosen keyword is a whole word', async () => {
    const home = freshHome();
    await buildLanceWs(home, 'pr-token', ['item12345 Zürich harbour', 'item12346 Zürich quay', 'item12347 Zürich pier']);
    const r = await migrate(home, 'pr-token');
    probeOk(r);
    const bm = r.probeDetails.filter((d) => d.startsWith('bm25'));
    assert.equal(bm.length, 3);
    for (const d of bm) {
        assert.match(d, /"zürich"/, d);
        assert.doesNotMatch(d, /"item"|"rich"/, d);
    }
});

await test('first candidate is a stopword ("that ...") -> Lance has 0 hits for it, probe advances to the next candidate and passes', async () => {
    const home = freshHome();
    const topics = ['harbour keeper records tides', 'lighthouse beam sweeps across the bay', 'ferries cross the channel hourly', 'fishermen mend their nets at dawn', 'cargo ships queue outside the breakwater', 'the pilot boat meets every tanker', 'storm warnings are posted at the quay', 'sailors repair canvas beside the slipway', 'customs officers inspect incoming containers', 'tugboats guide vessels toward the berth', 'the old pier needs fresh timber planks', 'buoys mark the shipping lane carefully'];
    const ws = await buildLanceWs(home, 'pr-stop', topics.map((t, i) => `that ${t} number ${i}`));
    const lang = readTokenizerFingerprint(ws)?.language;
    const r = await migrate(home, 'pr-stop');
    probeOk(r);
    const d = r.probeDetails.find((x) => x.startsWith('bm25') && x.includes('pr-stop-r0'))!;
    assert.match(d, /sqlite "that"/, `sqlite verifies on the first candidate: ${d}`);
    assert.doesNotMatch(d, /no keyword|MISMATCH/, d);
    if (lang) {
        // English stop-word removal active in Lance: "that" cannot hit there.
        assert.doesNotMatch(d, /lance "that"/, `lance advanced past the stopword (lang=${lang}): ${d}`);
    }
    assert.match(d, /^bm25 verified on both|^bm25 lance not verified/, d);
});

const SCRIPT_CASES: Array<[string, string[]]> = [
    ['bengali', ['ঢাকা বাংলাদেশের রাজধানী শহর', 'চট্টগ্রাম বন্দর নগরী বাংলাদেশের', 'সিলেট চা বাগান অঞ্চল বাংলাদেশের']],
    ['arabic', ['القاهرة عاصمة جمهورية مصر العربية', 'الإسكندرية ميناء مصر المتوسطي القديم', 'أسوان مدينة جنوب مصر النيل']],
    ['russian', ['Москва столица российской федерации', 'Санкт-Петербург северная столица страны', 'Новосибирск крупный сибирский город']],
    ['spanish', ['Canción española sobre el corazón del jardín', 'Niño pequeño juega en el jardín grande', 'Año nuevo celebración tradicional española']],
    ['cjk', ['東京は日本の首都です', '大阪は日本の商業都市です', '京都は日本の古い都です']],
];
for (const [label, texts] of SCRIPT_CASES) {
    await test(`${label}: keyword candidate found, bm25 verified on SQLite (not "no keyword"), migration passes`, async () => {
        const home = freshHome();
        const name = `pr-${label}`;
        await buildLanceWs(home, name, texts);
        const r = await migrate(home, name);
        probeOk(r);
        const bm = r.probeDetails.filter((d) => d.startsWith('bm25'));
        assert.ok(bm.length > 0);
        for (const d of bm) {
            assert.doesNotMatch(d, /no keyword/, d);
            assert.match(d, /^bm25 verified on both|^bm25 lance not verified/, d);
        }
        assert.equal(resolveWorkspaceVectorEngine(name, home), 'sqlite');
    });
}

await test('REAL miss: sampled row removed from the SQLite FTS index -> MISMATCH, migration aborts, Lance untouched', async () => {
    const home = freshHome();
    const ws = await buildLanceWs(home, 'pr-miss', atlasTexts(20));
    const before = await lanceDigest(ws);
    await assert.rejects(
        migrate(home, 'pr-miss', {
            beforeProbes: (sqlitePath) => {
                const db = new Database(sqlitePath);
                try {
                    const row = db.prepare(`SELECT rowid, text FROM verbatim WHERE id = ?`).get('pr-miss-r0') as { rowid: number; text: string };
                    db.prepare(`INSERT INTO verbatim_fts(verbatim_fts, rowid, text) VALUES('delete', ?, ?)`).run(row.rowid, row.text);
                } finally { db.close(); }
            },
        }),
        /MISMATCH bm25\(.*"final".*\) sqlite missing pr-miss-r0/,
    );
    assert.equal(resolveWorkspaceVectorEngine('pr-miss', home), 'lance');
    assert.ok(!fs.existsSync(sqlitePathOf(ws)), 'partial sqlite removed');
    assert.equal(await lanceDigest(ws), before, 'Lance rows untouched');
});

await test('failure message says "Lance data untouched (its keyword index may have been rebuilt on open)"', async () => {
    const home = freshHome();
    await buildLanceWs(home, 'pr-msg', atlasTexts(5));
    await assert.rejects(migrate(home, 'pr-msg', { simulateFailure: 'verify' }), /Lance data untouched \(its keyword index may have been rebuilt on open\)/);
});

// ── C. vector probe ─────────────────────────────────────────────────────
await test('>10 identical vectors (ties) -> vector probe passes by self-retrieval', async () => {
    const home = freshHome();
    await buildLanceWs(home, 'pr-vdup', Array.from({ length: 14 }, () => 'duplicate vector payload text'));
    const r = await migrate(home, 'pr-vdup');
    probeOk(r);
    assert.ok(r.probeDetails.some((d) => /^vector self-retrieval ok on both for pr-vdup-r0/.test(d)), r.probeDetails.join('; '));
    assert.ok(r.probeDetails.some((d) => /^vector top-\d order/.test(d)), 'order comparison kept as an informational line');
});

await test('sampled vector missing from SQLite -> vector MISMATCH, aborts, registry stays lance', async () => {
    const home = freshHome();
    const ws = await buildLanceWs(home, 'pr-vmiss', Array.from({ length: 14 }, () => 'duplicate vector payload text'));
    const before = await lanceDigest(ws);
    await assert.rejects(
        migrate(home, 'pr-vmiss', {
            beforeProbes: (sqlitePath) => {
                const db = new Database(sqlitePath);
                try { db.prepare(`UPDATE verbatim SET vector = NULL WHERE id = ?`).run('pr-vmiss-r0'); } finally { db.close(); }
            },
        }),
        /MISMATCH vector self-retrieval: sqlite did not return pr-vmiss-r0/,
    );
    assert.equal(resolveWorkspaceVectorEngine('pr-vmiss', home), 'lance');
    assert.equal(await lanceDigest(ws), before);
});

// ── D. zero samples ─────────────────────────────────────────────────────
await test('zero probe samples (every row tombstoned/unembedded) -> passes with an explicit "no probe samples" detail', async () => {
    const home = freshHome();
    const ws = await buildLanceWs(home, 'pr-zero', ['anchors hold the ship', 'chains hold the anchors']);
    const direct = new VerbatimStore(ws, new DetEmbedProvider());
    await direct.initialize();
    await direct.tombstone('pr-zero-r0', 'probe test');
    await direct.tombstone('pr-zero-r1', 'probe test');
    await direct.bulkAddPrebuiltRows([{
        vector: new Array(8).fill(0), id: 'pr-zero-raw', text: 'unembedded row about anchors', type: 'note', label: 'raw',
        tags: '', project: '', ecosystem: '*', updatedAt: '2026-10-03T00:00:00.000Z', security_scopes: [], contentHash: 'h-zero-raw',
    }]);
    await direct.close();
    const r = await migrate(home, 'pr-zero');
    assert.ok(r.probeDetails.some((d) => d.startsWith('no probe samples')), r.probeDetails.join('; '));
    probeOk(r);
    assert.equal(resolveWorkspaceVectorEngine('pr-zero', home), 'sqlite');
});

// ── E. non-English warning ──────────────────────────────────────────────
const FRENCH = [
    'Le chat dort tranquillement sur le canapé du salon pendant que la pluie tombe.',
    'Nous avons décidé de partir en vacances à la montagne au début du mois prochain.',
    'La boulangerie du village vend les meilleurs croissants de toute la région.',
    'Il faut absolument que tu viennes dîner chez nous samedi soir avec tes amis.',
    'Les enfants jouent dans le jardin pendant que leurs parents préparent le repas.',
    'Cette entreprise propose des solutions innovantes pour la gestion des documents.',
    'Mon frère habite à Marseille depuis presque dix ans maintenant avec sa famille.',
    'Le directeur a annoncé hier que la réunion serait reportée à la semaine prochaine.',
    'Elle lit un roman passionnant dans le train qui traverse les montagnes enneigées.',
    'Je voudrais réserver une table pour quatre personnes dans votre restaurant ce soir.',
    'La bibliothèque municipale ouvre ses portes tous les jours sauf le dimanche matin.',
    'Ils ont construit une maison magnifique au bord de la mer avec une grande terrasse.',
];
await test('non-English Lance FTS language -> report warning; English workspace -> none', async () => {
    const home = freshHome();
    const wsFr = await buildLanceWs(home, 'pr-fr', FRENCH);
    // Re-open once so the tokenizer reconcile sees the populated store, then confirm the setup.
    const again = new VerbatimStore(wsFr, new DetEmbedProvider());
    await again.initialize();
    await again.close();
    const lang = readTokenizerFingerprint(wsFr)?.language;
    assert.equal(lang, 'French', `fixture precondition: Lance FTS sidecar is French (got ${lang})`);
    const fr = await migrate(home, 'pr-fr');
    probeOk(fr);
    assert.ok(fr.warnings.some((w) => /SQLite keyword search applies English stemming only; French stemming and stop-words will not be used after migration\./.test(w)), JSON.stringify(fr.warnings));

    await buildLanceWs(home, 'pr-en', ['The quick brown fox jumps over the lazy dog near the harbour.', 'Ferries leave the harbour every morning at eight sharp.', 'The lighthouse keeper records the tide tables daily.']);
    const en = await migrate(home, 'pr-en');
    assert.deepEqual(en.warnings, []);
});

// ── F. migrate-graph ────────────────────────────────────────────────────
function createSurrealWorkspace(name: string, home: string) {
    loadWorkspaces(home);
    const entry = createWorkspace(name, {}, home);
    setWorkspaceGraphEngine(name, 'surreal', home);
    return entry;
}
async function sharedLabelGraph(home: string, name: string, n: number) {
    const entry = createSurrealWorkspace(name, home);
    const g = new SurrealGraph(entry.path, { workspaceId: entry.name });
    await g.initialize();
    for (let i = 0; i < n; i++) {
        await g.upsertNode({ id: `n${String(i).padStart(2, '0')}`, type: 'note', label: 'Shared topic', content: `body number ${i}`, tags: [], project: '*', ecosystem: '*', metadata: '{}' } as never);
    }
    await g.close();
    return entry;
}

await test('graph: 30 nodes match the term (>20 page) -> search probe verifies the sampled node by membership and passes', async () => {
    const home = freshHome();
    const entry = await sharedLabelGraph(home, 'pg-many', 30);
    const r = await migrateGraphToSqlite({ workspaceName: entry.name, home, backupOutDir: outDir(), force: true });
    assert.ok(r.readProbesMatched, r.readProbeDetails.join('; '));
    assert.ok(r.readProbeDetails.some((d) => /^search\("Shared topic"\): sampled node n\d\d found on both$/.test(d)), r.readProbeDetails.join('; '));
    assert.equal(resolveWorkspaceGraphEngine(entry.name, home), 'sqlite');
});

await test('graph: nodes missing from the target -> search probe MISMATCH, migration aborts, registry stays surreal', async () => {
    const home = freshHome();
    const entry = await sharedLabelGraph(home, 'pg-miss', 30);
    await assert.rejects(
        migrateGraphToSqlite({
            workspaceName: entry.name, home, backupOutDir: outDir(), force: true,
            beforeReadProbes: async (dest) => {
                for (let i = 0; i < 30; i++) await dest.deleteNode(`n${String(i).padStart(2, '0')}`);
            },
        }),
        (e: unknown) => e instanceof MigrationVerificationError && /search\("Shared topic"\): MISMATCH sqlite missing n\d\d/.test(e.message),
    );
    assert.equal(resolveWorkspaceGraphEngine(entry.name, home), 'surreal');
});

async function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, '127.0.0.1', () => {
            const a = srv.address();
            srv.close(() => resolve(typeof a === 'object' && a ? a.port : 0));
        });
        srv.on('error', reject);
    });
}

await test('graph CLI: --to sqlite prints the lost-writes warning + tarball; --rollback prints both and the same tarball path', async () => {
    const home = freshHome();
    const entry = await sharedLabelGraph(home, 'pg-cli', 3);
    const here = path.dirname(fileURLToPath(import.meta.url));
    const tsxBin = path.join(here, '..', 'node_modules', '.bin', 'tsx');
    const cli = path.join(here, '..', 'packages', 'lore', 'src', 'cli', 'index.ts');
    const env = { ...process.env, LORE_PORT: String(await freePort()), LORE_HOME: home };
    const mig = spawnSync(tsxBin, [cli, 'migrate-graph', entry.name, '--to', 'sqlite'], { encoding: 'utf8', env });
    assert.equal(mig.status, 0, `${mig.stdout}\n${mig.stderr}`);
    assert.match(mig.stdout, /NOT carried back to SurrealDB/);
    const tarball = /The real undo is the backup tarball: (\S+\.tar\.gz)/.exec(mig.stdout)?.[1];
    assert.ok(tarball && fs.existsSync(tarball), `tarball path printed and exists (${tarball})`);
    const rb = spawnSync(tsxBin, [cli, 'migrate-graph', entry.name, '--rollback'], { encoding: 'utf8', env });
    assert.equal(rb.status, 0, `${rb.stdout}\n${rb.stderr}`);
    assert.match(rb.stdout, /writes made after the migration were stored in graph\.sqlite only and are/);
    assert.match(rb.stdout, /NOT carried back/);
    assert.ok(rb.stdout.includes(tarball!), `rollback names the real tarball ${tarball}:\n${rb.stdout}`);
    assert.equal(resolveWorkspaceGraphEngine(entry.name, home), 'surreal');
});

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
