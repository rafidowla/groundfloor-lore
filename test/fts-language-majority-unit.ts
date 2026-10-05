#!/usr/bin/env tsx
/**
 * fts-language-majority-unit.ts — fix/fts-language-majority.
 *
 * A LanceDB FTS stemming language is chosen for a workspace only when it is
 * CLEARLY the workspace's main language (see the rule block next to
 * CJK_FRACTION_THRESHOLD in ftsTokenizerProfile.ts). Before the fix a single
 * stray `fr` vote among 59 unclassifiable rows made an English/code
 * workspace French.
 *
 * Covers: the entry rule (pure), unmapped languages (Bengali), hysteresis
 * against the stored sidecar (pure + through real VerbatimStore reopens), the
 * windowed sampler (a language that exists only late in the table), and
 * reopen stability (an English workspace never rebuilds).
 *
 * Run: npx tsx test/fts-language-majority-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';
import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import { detectLanguage } from '../packages/lore/src/engines/language.js';
import {
    detectTokenizerProfile,
    getTokenizerFingerprintPath,
    readTokenizerFingerprint,
    writeTokenizerFingerprint,
    _deleteTokenizerFingerprintForTests,
} from '../packages/lore/src/engines/ftsTokenizerProfile.js';
import type { FtsTokenizerSettings } from '../packages/lore/src/engines/ftsTokenizerProfile.js';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'fts-lang-home-'));
process.env['LORE_HOME'] = TEST_HOME;

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`);
        failed++;
    }
}

class DeterministicEmbedder implements EmbeddingProvider {
    readonly modelId = 'deterministic-mock';
    readonly dimension = 32;
    async initialize(): Promise<void> { /* no-op */ }
    async embed(text: string): Promise<number[]> { return this.vec(text); }
    async embedQuery(text: string): Promise<number[]> { return this.vec(text); }
    async embedDocument(text: string): Promise<number[]> { return this.vec(text); }
    async embedDocumentBatch(texts: string[]): Promise<number[][]> { return texts.map((t) => this.vec(t)); }
    private vec(text: string): number[] {
        const v = new Array(this.dimension).fill(0);
        for (let i = 0; i < text.length; i++) v[i % this.dimension] += text.charCodeAt(i) / 1000;
        const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
        return v.map((x) => x / mag);
    }
}

function tmpDir(label: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), `fts-lang-${label}-`));
}

/* ── Corpora. Each language has a pool of distinct single-sentence rows that
 *    franc classifies decisively (precondition-checked below). A row is one
 *    pool sentence tagged with its index so every row is unique. ────────── */
const POOLS: Record<string, string[]> = {
    fr: [
        "Notre équipe a terminé la revue trimestrielle de la feuille de route du projet et a décidé de reporter la prochaine version jusqu'à nouvel ordre",
        "Le client a signalé que la fonction d'exportation ne fonctionne plus après la dernière mise à jour et nous a demandé d'enquêter sur le problème",
        "Il faudrait consigner la décision concernant la migration de la base de données afin que personne n'ait à en rediscuter le mois prochain",
        "N'oubliez pas de mettre à jour la documentation chaque fois que les options de configuration changent, car les gens la lisent avant de poser des questions",
        "Le pipeline de déploiement a échoué deux fois vendredi soir et les ingénieurs ont passé le week-end à chercher la cause de la panne",
    ],
    es: [
        'Nuestro equipo terminó la revisión trimestral de la hoja de ruta del proyecto y decidió posponer el próximo lanzamiento hasta nuevo aviso',
        'El cliente informó que la función de exportación dejó de funcionar después de la última actualización y nos pidió investigar el problema',
        'Esta mañana el equipo de soporte respondió todas las solicitudes pendientes de los clientes antes del mediodía y cerró los casos abiertos',
        'Recuerden actualizar la documentación cada vez que cambien las opciones de configuración, porque la gente la lee antes de hacer preguntas',
        'El proceso de despliegue falló dos veces el viernes por la tarde y los ingenieros pasaron el fin de semana buscando la causa del fallo',
    ],
    ar: [
        'أنهى فريقنا المراجعة الفصلية لخارطة طريق المشروع وقرر تأجيل الإصدار القادم حتى إشعار آخر بسبب مخاوف العملاء',
        'أبلغ العميل أن ميزة التصدير توقفت عن العمل بعد آخر تحديث وطلب منا التحقيق في المشكلة بأسرع وقت ممكن',
        'يجب أن نسجل القرار المتعلق بترحيل قاعدة البيانات حتى لا يضطر أحد إلى مناقشته مرة أخرى في الشهر القادم',
        'لا تنسوا تحديث الوثائق كلما تغيرت خيارات الإعداد، لأن الناس يقرؤونها قبل أن يطرحوا الأسئلة على الفريق',
        'فشل خط النشر مرتين مساء الجمعة وقضى المهندسون عطلة نهاية الأسبوع في البحث عن سبب هذا الفشل المتكرر',
    ],
    ru: [
        'Наша команда завершила квартальный обзор дорожной карты проекта и решила отложить следующий выпуск до дальнейшего уведомления',
        'Клиент сообщил, что функция экспорта перестала работать после последнего обновления, и попросил нас разобраться в проблеме',
        'Нужно записать решение о миграции базы данных, чтобы никому не пришлось обсуждать его заново в следующем месяце',
        'Не забывайте обновлять документацию каждый раз, когда меняются параметры конфигурации, потому что люди читают её перед тем, как задать вопрос',
        'Конвейер развёртывания дважды упал в пятницу вечером, и инженеры провели выходные в поисках причины сбоя',
    ],
    bn: [
        'আমাদের দল প্রকল্পের ত্রৈমাসিক পর্যালোচনা শেষ করেছে এবং পরবর্তী সংস্করণ পরবর্তী নির্দেশ না আসা পর্যন্ত স্থগিত রাখার সিদ্ধান্ত নিয়েছে',
        'গ্রাহক জানিয়েছেন যে সর্বশেষ আপডেটের পর রপ্তানি সুবিধাটি কাজ করছে না এবং আমাদের সমস্যাটি তদন্ত করতে বলেছেন',
        'ডাটাবেস স্থানান্তরের সিদ্ধান্তটি লিখে রাখা উচিত যাতে আগামী মাসে কাউকে আবার এ নিয়ে তর্ক করতে না হয়',
        'কনফিগারেশন বিকল্প পরিবর্তন হলেই নথিপত্র হালনাগাদ করতে ভুলবেন না, কারণ মানুষ প্রশ্ন করার আগে সেটি পড়ে',
        'শুক্রবার সন্ধ্যায় ডিপ্লয়মেন্ট পাইপলাইন দুইবার ব্যর্থ হয়েছে এবং প্রকৌশলীরা সপ্তাহান্তে ব্যর্থতার কারণ খুঁজেছেন',
    ],
    en: [
        'Our team finished the quarterly review of the project roadmap and decided to postpone the next release until further notice',
        'The customer reported that the export feature stopped working after the latest update and asked us to investigate the problem',
        'The manager asked everyone to review the budget carefully before the meeting on Monday morning and send comments by evening',
        'Please remember to update the documentation whenever the configuration options change, because people read it before they ask questions',
        'The deployment pipeline failed twice on Friday evening, and the engineers spent the weekend finding the cause of the failure',
    ],
};

/** `n` rows of language `lang`, numbered from `from` so rows are unique. */
function rows(lang: string, n: number, from = 0): string[] {
    const pool = POOLS[lang]!;
    const out: string[] = [];
    for (let i = from; i < from + n; i++) out.push(`${pool[i % pool.length]} (${i})`);
    return out;
}

/** Code-like rows franc cannot classify (margin below its threshold). */
function codeRows(n: number, from = 0): string[] {
    const shapes = [
        (i: number) => `const x${i} = foo(bar, ${i}); return x${i} + y; // tmp`,
        (i: number) => `export function handler${i}(req, res) { res.status(200).json({ ok: true, n: ${i} }); }`,
        (i: number) => `kubectl rollout restart deploy/api-${i} -n prod --timeout=${i}s && kubectl get pods -l app=api-${i}`,
        (i: number) => `{"id":"a${i}b","kind":"file","path":"src/lib/util${i}.ts","lines":[1,${i + 40}]}`,
    ];
    const out: string[] = [];
    for (let i = from; i < from + n; i++) out.push(shapes[i % shapes.length]!(i));
    return out;
}

const DEFAULT_ENGLISH: FtsTokenizerSettings = { baseTokenizer: 'simple', stem: true, removeStopWords: true, lowercase: true, language: 'English' };
const DEFAULT_ABSENT: FtsTokenizerSettings = { baseTokenizer: 'simple', stem: true, removeStopWords: true, lowercase: true };
const withLang = (language: string): FtsTokenizerSettings => ({ ...DEFAULT_ENGLISH, language });

/* ── Store helpers ──────────────────────────────────────────────────────── */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const sidecarBytes = (dir: string): string => fs.readFileSync(getTokenizerFingerprintPath(dir), 'utf-8');

/** Seed a store with `texts` in ONE batch, close it, and clear the sidecar so
 *  the next open starts from "unknown" and detects over the full table. */
async function seed(dir: string, texts: string[]): Promise<void> {
    const store = new VerbatimStore(dir, new DeterministicEmbedder());
    await store.initialize();
    await store.storeBatch(texts.map((text, i) => ({ id: `lore:doc-${i}`, text, metadata: {} })));
    await store.close();
    _deleteTokenizerFingerprintForTests(dir);
}

/** Reopen the store (initialize() reconciles the tokenizer) and return the
 *  sidecar bytes before/after, so "did it rebuild" is observable: a rebuild
 *  rewrites the file with a fresh `writtenAt`. */
async function reopen(dir: string): Promise<{ before: string | null; after: string; rebuilt: boolean }> {
    const before = fs.existsSync(getTokenizerFingerprintPath(dir)) ? sidecarBytes(dir) : null;
    await sleep(5);
    const store = new VerbatimStore(dir, new DeterministicEmbedder());
    await store.initialize();
    await store.close();
    const after = sidecarBytes(dir);
    return { before, after, rebuilt: before !== after };
}

const langOf = (dir: string): string | undefined => readTokenizerFingerprint(dir)?.language;

console.log('fix/fts-language-majority\n');

(async () => {

    /* ══════════════════════════════════════════════════════════════════
     * Fixture sanity — the rest of the suite is only meaningful if the
     * corpora classify the way the tests assume.
     * ══════════════════════════════════════════════════════════════════ */
    await test('fixtures: every pool sentence classifies as its own language; code rows never classify', () => {
        const expect: Record<string, string> = { fr: 'fr', es: 'es', ar: 'arb', ru: 'ru', bn: 'bn', en: 'en' };
        for (const [lang, want] of Object.entries(expect)) {
            for (const text of rows(lang, 5)) {
                assert.equal(detectLanguage(text).language, want, `${lang} fixture misclassified: ${text}`);
            }
        }
        for (const text of codeRows(40)) {
            assert.equal(detectLanguage(text).language, null, `code fixture classified: ${text}`);
        }
    });

    /* ══════════════════════════════════════════════════════════════════
     * Pure: the entry rule
     * ══════════════════════════════════════════════════════════════════ */
    await test('pure: 1 French + 59 unclassifiable -> no French (the Atlas repro)', () => {
        const p = detectTokenizerProfile([...rows('fr', 1), ...codeRows(59)]);
        assert.notEqual(p.language, 'French');
        assert.equal(p.language, undefined);
    });
    await test('pure: 4 French + rest unclassifiable -> not French (below 5 votes)', () => {
        const p = detectTokenizerProfile([...rows('fr', 4), ...codeRows(56)]);
        assert.notEqual(p.language, 'French');
    });
    await test('pure: sample-share floor — 17 French of 60 (28%) does not enter, 18 of 60 (30%) does', () => {
        // 17 of 60 = 28.3% < 30% of N: must not enter even though it is 100% of
        // the classified votes. 18 of 60 = 30%: enters.
        assert.notEqual(detectTokenizerProfile([...rows('fr', 17), ...codeRows(43)]).language, 'French');
        assert.equal(detectTokenizerProfile([...rows('fr', 18), ...codeRows(42)]).language, 'French');
    });
    for (const [lang, name] of [['fr', 'French'], ['es', 'Spanish'], ['ar', 'Arabic'], ['ru', 'Russian']] as const) {
        await test(`pure: 60 ${name} rows -> ${name}`, () => {
            assert.equal(detectTokenizerProfile(rows(lang, 60)).language, name);
        });
    }
    await test('pure: 20 Spanish + 40 unclassifiable -> Spanish', () => {
        assert.equal(detectTokenizerProfile([...rows('es', 20), ...codeRows(40)]).language, 'Spanish');
    });
    await test('pure: 60 Bengali -> no language field (unmapped), no crash', () => {
        const p = detectTokenizerProfile(rows('bn', 60));
        assert.equal(p.language, undefined);
        assert.equal(p.baseTokenizer, 'simple');
    });
    await test('pure: 40% English + 35% Spanish + 25% unclassifiable -> English', () => {
        const p = detectTokenizerProfile([...rows('en', 24), ...rows('es', 21), ...codeRows(15)]);
        assert.equal(p.language, 'English');
    });
    await test('pure: 3 English + 9 French of 12 -> French needs >5 votes: 9 votes, 75% of classified -> French', () => {
        assert.equal(detectTokenizerProfile([...rows('en', 3), ...rows('fr', 9)]).language, 'French');
    });
    await test('pure: English plurality with any count still wins (2 English, 1 French)', () => {
        assert.equal(detectTokenizerProfile([...rows('en', 2), ...rows('fr', 1), ...codeRows(30)]).language, 'English');
    });
    await test('pure: 6 French vs 6 Spanish of 12 -> neither exceeds 50% of classified -> no language', () => {
        assert.equal(detectTokenizerProfile([...rows('fr', 6), ...rows('es', 6)]).language, undefined);
    });
    await test('pure: single-argument call still works and is deterministic', () => {
        const a = detectTokenizerProfile(rows('en', 10));
        const b = detectTokenizerProfile(rows('en', 10));
        assert.deepEqual(a, b);
        assert.equal(a.language, 'English');
    });

    /* ══════════════════════════════════════════════════════════════════
     * Pure: hysteresis
     * ══════════════════════════════════════════════════════════════════ */
    await test('pure hysteresis: previous French + 1 French vote -> default (not French)', () => {
        const p = detectTokenizerProfile([...rows('fr', 1), ...codeRows(59)], withLang('French'));
        assert.notEqual(p.language, 'French');
        assert.equal(p.baseTokenizer, 'simple');
    });
    await test('pure hysteresis: previous French + 1 French + English plurality -> English', () => {
        const p = detectTokenizerProfile([...rows('fr', 1), ...rows('en', 20), ...codeRows(39)], withLang('French'));
        assert.equal(p.language, 'English');
    });
    await test('pure hysteresis: previous English + new verdict absent -> previous returned unchanged (same object)', () => {
        const prev = { ...DEFAULT_ENGLISH };
        const p = detectTokenizerProfile(codeRows(60), prev);
        assert.equal(p, prev);
    });
    await test('pure hysteresis: previous absent + new verdict English -> previous returned unchanged', () => {
        const prev = { ...DEFAULT_ABSENT };
        const p = detectTokenizerProfile(rows('en', 30), prev);
        assert.equal(p, prev);
    });
    await test('pure hysteresis: previous Spanish + 4 Spanish votes as plurality -> Spanish kept', () => {
        const prev = withLang('Spanish');
        const p = detectTokenizerProfile([...rows('es', 4), ...codeRows(56)], prev);
        assert.equal(p, prev);
        // Without `previous`, 4 votes is not enough to enter.
        assert.notEqual(detectTokenizerProfile([...rows('es', 4), ...codeRows(56)]).language, 'Spanish');
    });
    await test('pure hysteresis: previous Spanish but only 2 Spanish votes -> falls back to the new verdict', () => {
        const p = detectTokenizerProfile([...rows('es', 2), ...codeRows(58)], withLang('Spanish'));
        assert.notEqual(p.language, 'Spanish');
    });
    await test('pure hysteresis: previous Spanish but English is now the plurality -> English', () => {
        const p = detectTokenizerProfile([...rows('es', 4), ...rows('en', 30), ...codeRows(26)], withLang('Spanish'));
        assert.equal(p.language, 'English');
    });
    await test('pure hysteresis: previous ngram is not "default" -> the new Latin verdict applies', () => {
        const p = detectTokenizerProfile(rows('en', 30), { baseTokenizer: 'ngram', ngramMinLength: 1, ngramMaxLength: 2 });
        assert.equal(p.baseTokenizer, 'simple');
        assert.equal(p.language, 'English');
    });
    await test('pure hysteresis: previous English, corpus clearly French -> French (hysteresis never blocks a clear change)', () => {
        const p = detectTokenizerProfile(rows('fr', 60), { ...DEFAULT_ENGLISH });
        assert.equal(p.language, 'French');
    });

    /* ══════════════════════════════════════════════════════════════════
     * Through a real Lance VerbatimStore (temp dir, reopen)
     * ══════════════════════════════════════════════════════════════════ */
    await test('store: Atlas repro — fresh workspace of 1 French + 59 code rows is NOT French', async () => {
        const dir = tmpDir('atlas-fresh');
        try {
            await seed(dir, [...rows('fr', 1), ...codeRows(59)]);
            const r = await reopen(dir);
            assert.equal(r.before, null);
            assert.notEqual(langOf(dir), 'French');
            // and stable thereafter
            const again = await reopen(dir);
            assert.equal(again.rebuilt, false, 'second open must not rebuild');
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    await test('store: Atlas FIX — stored French sidecar on a 1-French workspace rebuilds exactly once, then reopen is stable', async () => {
        const dir = tmpDir('atlas-fix');
        try {
            await seed(dir, [...rows('fr', 1), ...codeRows(59)]);
            writeTokenizerFingerprint(dir, withLang('French')); // what the old logic left on disk
            const first = await reopen(dir);
            assert.equal(first.rebuilt, true, 'the mis-detected workspace must rebuild once');
            assert.notEqual(langOf(dir), 'French');
            const second = await reopen(dir);
            assert.equal(second.rebuilt, false, 'no second rebuild');
            const third = await reopen(dir);
            assert.equal(third.rebuilt, false, 'no third rebuild');
            assert.equal(third.after, first.after);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    for (const [lang, name] of [['fr', 'French'], ['es', 'Spanish'], ['ar', 'Arabic'], ['ru', 'Russian']] as const) {
        await test(`store: 60 ${name} rows -> ${name} sidecar, stable on reopen`, async () => {
            const dir = tmpDir(`lang-${lang}`);
            try {
                await seed(dir, rows(lang, 60));
                await reopen(dir);
                assert.equal(langOf(dir), name);
                const again = await reopen(dir);
                assert.equal(again.rebuilt, false);
                assert.equal(langOf(dir), name);
            } finally { fs.rmSync(dir, { recursive: true, force: true }); }
        });
    }

    await test('store: 60 Bengali rows -> no language field, no crash', async () => {
        const dir = tmpDir('bengali');
        try {
            await seed(dir, rows('bn', 60));
            await reopen(dir);
            const fp = readTokenizerFingerprint(dir);
            assert.ok(fp, 'sidecar written');
            assert.equal(fp!.language, undefined);
            assert.equal(fp!.baseTokenizer, 'simple');
            const again = await reopen(dir);
            assert.equal(again.rebuilt, false);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    await test('store: English workspace reopened 3 times -> zero rebuilds, sidecar byte-identical, language English', async () => {
        const dir = tmpDir('english-stable');
        try {
            await seed(dir, rows('en', 60));
            const first = await reopen(dir);
            assert.deepEqual((JSON.parse(first.after) as { settings: unknown }).settings, DEFAULT_ENGLISH, 'on-disk settings must be exactly what origin/main wrote for an English workspace');
            let prev = first.after;
            for (let i = 0; i < 3; i++) {
                const r = await reopen(dir);
                assert.equal(r.rebuilt, false, `reopen #${i + 1} must not rebuild`);
                assert.equal(r.after, prev, `reopen #${i + 1} sidecar must be byte-identical`);
                prev = r.after;
            }
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    await test('store: previous English + new verdict absent (code-only corpus) -> previous kept, no rebuild', async () => {
        const dir = tmpDir('english-to-absent');
        try {
            await seed(dir, codeRows(60));
            writeTokenizerFingerprint(dir, DEFAULT_ENGLISH);
            // The first open still builds the missing index; capture state after it.
            await reopen(dir);
            const baseline = sidecarBytes(dir);
            assert.equal(langOf(dir), 'English');
            const r = await reopen(dir);
            assert.equal(r.rebuilt, false);
            assert.equal(r.after, baseline);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    await test('store: previous Spanish + 4 Spanish votes as plurality -> Spanish kept, no rebuild', async () => {
        const dir = tmpDir('spanish-kept');
        try {
            await seed(dir, [...rows('es', 4), ...codeRows(56)]);
            writeTokenizerFingerprint(dir, withLang('Spanish'));
            await reopen(dir);
            assert.equal(langOf(dir), 'Spanish');
            const baseline = sidecarBytes(dir);
            const r = await reopen(dir);
            assert.equal(r.rebuilt, false);
            assert.equal(r.after, baseline);
            assert.equal(langOf(dir), 'Spanish');
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    await test('store: windowed sampling — French rows only in the LAST part of a 400-row table are found', async () => {
        const dir = tmpDir('windows');
        try {
            // First 270 rows unclassifiable code, last 130 French. A first-N
            // sample sees no French at all; the windowed sample reaches it.
            await seed(dir, [...codeRows(270), ...rows('fr', 130)]);
            await reopen(dir);
            assert.equal(langOf(dir), 'French');
            const again = await reopen(dir);
            assert.equal(again.rebuilt, false);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
    process.exit(failed === 0 ? 0 : 1);
})();
