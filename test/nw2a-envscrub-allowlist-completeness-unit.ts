#!/usr/bin/env tsx
/**
 * nw2a-envscrub-allowlist-completeness-unit.ts — NW-2a bidirectional
 * drift guard for the envScrub allowlist.
 *
 * Why this test exists.
 * --------------------
 * Round 2 audit cluster `A.4 envScrub-allowlist` (HIGH-CFG-A) found
 * 5 high-severity findings collapsing to one root cause: variables
 * documented in `docs/CONFIGURATION.md` AND read by production code
 * were missing from `security/envScrub.ts`'s ALLOWED_VARS, so
 * `scrubEnv()` (called at the top of main) deleted them before the
 * consumer ever ran. Symptom: operator sets `LORE_CLOUD_URL` or
 * `LORE_METRICS=on`, sees no effect, no warning, no log line — the
 * documented configuration surface is non-functional.
 *
 * The existing `test/env-scrub-allowlist-unit.ts` catches the
 * one-direction case "var read literally as `process.env.X` but not
 * allowlisted". It MISSED this cluster because the cluster's reads
 * are indirect — `envNum('LORE_X')`, `loadOtelConfig(env)`,
 * `createCloudSyncClient({env})` — the env parameter defaults to
 * `process.env` but the regex scanner sees `process.env[name]` not
 * `process.env.LORE_X`.
 *
 * This test closes the gap from the docs side: every LORE_* /
 * DATAPLANE_* variable that appears in `docs/CONFIGURATION.md`
 * MUST be in the envScrub allowlist (or in the explicit
 * known-rejected legacy set). If you document a knob, the daemon
 * must actually receive its value.
 *
 * Excluded from the docs scan (NOT real var names):
 *   - bare prefixes that grep finds in identifiers/headings
 *     (`LORE_MAINTAIN_`, `LORE_EMBEDDING_`)
 *   - LORE_STREAM_CONSUMER: documented future-pluggability seam,
 *     no current consumer.
 *
 * Drift policy.
 * -------------
 * If a new var lands in CONFIGURATION.md, you have three options:
 *   1. Add it to ALLOWED_VARS (most common — wire it through).
 *   2. Add it to KNOWN_REJECTED_LEGACY here, with a comment
 *      explaining why it's documented but intentionally not
 *      allowlisted (almost never the right call).
 *   3. Remove it from CONFIGURATION.md (preferred when phantom).
 *
 * This test sits next to the existing one-way drift guards:
 *   - sw24-config-reference-unit.ts: source → docs
 *   - env-scrub-allowlist-unit.ts: literal `process.env.X` → allowlist
 *   - this file: docs → allowlist (the missing direction)
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;
function test(name: string, fn: () => Promise<void> | void) {
    return Promise.resolve()
        .then(() => fn())
        .then(
            () => { console.log(`  ✓ ${name}`); passed++; },
            (err: Error) => { console.error(`  ✗ ${name}\n    ${err.stack ?? err.message}`); failed++; },
        );
}

/**
 * Tokens grep finds in CONFIGURATION.md that aren't real env var names.
 * Bare prefixes are header artifacts (e.g. `### LORE_EMBEDDING_*` is
 * one heading covering several concrete vars listed below it).
 */
const DOC_GREP_NOISE = new Set<string>([
    'LORE_MAINTAIN_',
    'LORE_EMBEDDING_',
]);

/**
 * Vars that are documented but intentionally not in the allowlist.
 * Should normally be empty; an entry here needs a clear reason.
 *
 * `LORE_STREAM_CONSUMER` appears in CONFIGURATION.md as a
 * future-pluggability seam (mirroring the existing exclusion in
 * sw24-config-reference-unit.ts). Nothing reads it today, so it
 * doesn't matter whether envScrub keeps it — adding to the legacy
 * set documents that this is intentional.
 */
const KNOWN_REJECTED_LEGACY = new Set<string>([
    'LORE_STREAM_CONSUMER',
]);

/** Parse string literals out of the ALLOWED_VARS const block. Mirrors
 *  the parser in env-scrub-allowlist-unit.ts so the two tests agree on
 *  what counts as "allowlisted". */
function readAllowlistFromSource(): Set<string> {
    const file = path.join(repoRoot, 'packages/lore/src/security/envScrub.ts');
    const src = fs.readFileSync(file, 'utf8');
    const stripped = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
    const start = stripped.indexOf('const ALLOWED_VARS');
    assert.ok(start >= 0, 'envScrub.ts: ALLOWED_VARS const not found');
    const eqOpen = stripped.indexOf('= [', start);
    assert.ok(eqOpen > 0, 'envScrub.ts: ALLOWED_VARS assignment "= [" not found');
    const openBracket = eqOpen + 2;
    const closeBracket = stripped.indexOf('];', openBracket);
    assert.ok(closeBracket > openBracket, 'envScrub.ts: ALLOWED_VARS delimiters not found');
    const body = stripped.slice(openBracket, closeBracket);
    const allow = new Set<string>();
    const lit = /'([A-Z][A-Z0-9_]*)'/g;
    let m: RegExpExecArray | null;
    while ((m = lit.exec(body)) !== null) allow.add(m[1]);
    return allow;
}

/** Pull every LORE_/DATAPLANE_ identifier out of CONFIGURATION.md. */
function readDocumentedVars(): Set<string> {
    const docPath = path.join(repoRoot, 'docs/CONFIGURATION.md');
    const text = fs.readFileSync(docPath, 'utf8');
    const found = new Set<string>();
    const re = /(LORE|DATAPLANE)_[A-Z0-9_]+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        const name = m[0];
        if (DOC_GREP_NOISE.has(name)) continue;
        found.add(name);
    }
    return found;
}

async function run() {
    console.log('\n=== NW-2a envScrub allowlist completeness (bidirectional) ===\n');

    const allow = readAllowlistFromSource();
    const documented = readDocumentedVars();

    await test('sanity: scanners find expected anchor vars', () => {
        assert.ok(allow.has('LORE_HOME'), 'allowlist scanner: LORE_HOME missing');
        assert.ok(documented.has('LORE_HOME'), 'docs scanner: LORE_HOME missing');
        assert.ok(documented.size >= 50, `docs scan found ${documented.size}, expected >= 50`);
        assert.ok(allow.size >= 60, `allowlist scan found ${allow.size}, expected >= 60`);
    });

    await test('every CONFIGURATION.md var is in envScrub.ALLOWED_VARS (or legacy-rejected)', () => {
        const missing: string[] = [];
        for (const v of documented) {
            if (allow.has(v)) continue;
            if (KNOWN_REJECTED_LEGACY.has(v)) continue;
            missing.push(v);
        }
        assert.equal(
            missing.length,
            0,
            `\n${missing.length} var(s) documented in docs/CONFIGURATION.md but missing from ALLOWED_VARS in packages/lore/src/security/envScrub.ts:\n\n  ${missing.join('\n  ')}\n\n` +
            `These vars are silently scrubbed at daemon startup — operators following the docs see no effect, no log line, no error.\n` +
            `Fix: add each to ALLOWED_VARS, OR remove from CONFIGURATION.md if the knob is phantom (no consumer), OR add to KNOWN_REJECTED_LEGACY here with a comment explaining why.\n` +
            `Context: audit cluster HIGH-CFG-A / NW-2a.\n`,
        );
    });

    await test('cluster-specific vars present in allowlist (anti-regression)', () => {
        const cluster = [
            // §5 Maintenance
            'LORE_MAINTAIN_RETENTION_DAYS',
            'LORE_MAINTAIN_COMPACT_FRAGMENT_THRESHOLD',
            'LORE_MAINTAIN_EPHEMERAL_TTL_DAYS',
            'LORE_MAINTAIN_COMPACTION',
            'LORE_MAINTAIN_VERSION_CLEANUP',
            'LORE_MAINTAIN_NODE_RETENTION',
            'LORE_MAINTAIN_EPHEMERAL_EXPIRY',
            // §10 Observability
            'LORE_METRICS',
            'LORE_OTEL_EXPORTER_OTLP_ENDPOINT',
            'LORE_OTEL_SERVICE_NAME',
            'LORE_OTEL_SAMPLING',
            // §5 Audit
            'LORE_AUDIT_EXPORTER',
            // §6 HTTP rate limits
            'LORE_RATE_LIMIT_CAP',
            'LORE_RATE_LIMIT_REFILL',
            // §3 Cloud sync
            'LORE_CLOUD_URL',
            'LORE_CLOUD_AUTH_TOKEN',
        ];
        const missing = cluster.filter((v) => !allow.has(v));
        assert.deepEqual(
            missing,
            [],
            `cluster vars missing from allowlist (regression of NW-2a fix): ${missing.join(', ')}`,
        );
    });

    await test('phantom LORE_SWEEP_KEEP_ORPHANS removed from docs', () => {
        // The audit confirmed `LORE_SWEEP_KEEP_ORPHANS` is documented at
        // CONFIGURATION.md but no consumer reads it. NW-2a removed the
        // doc entry — guard that it doesn't reappear without a wired
        // consumer. If a future change re-adds the var, also wire it
        // into sweeper.ts and remove from this assertion.
        assert.ok(
            !documented.has('LORE_SWEEP_KEEP_ORPHANS'),
            'LORE_SWEEP_KEEP_ORPHANS reappeared in CONFIGURATION.md — either wire it in src/diagnostics/sweeper.ts or keep it removed.',
        );
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    console.log(`(scanned ${documented.size} documented vars; ${allow.size} allowlisted)\n`);
    if (failed > 0) process.exit(1);
}

run().catch((err) => { console.error(err); process.exit(1); });
