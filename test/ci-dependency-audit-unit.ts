#!/usr/bin/env tsx
/**
 * ci-dependency-audit-unit.ts — guard for the CI dependency-vulnerability gate.
 *
 * Security checklist item #18 (dependency hygiene) flagged that
 * bitbucket-pipelines.yml installed with `npm ci --no-audit` and had no
 * dependency-vulnerability step, and that no Renovate/Dependabot config
 * existed at all. Both gaps were closed by:
 *   - adding an `npm audit --omit=dev --audit-level=high` step to the
 *     pipeline's install-and-gate script, and
 *   - adding renovate.json at the repo root.
 *
 * This test is the guard against silent regression of either fix — e.g. a
 * future edit to the pipeline that drops the audit step while leaving the
 * unrelated `--no-audit` install flag in place (which would look correct at
 * a glance but silently stop failing on new high/critical CVEs), or a
 * renovate.json edit that removes the security-update fast path.
 *
 * UPDATE (2026-09-04, decision by Rafi): the audit step's first cut
 * (commit 4d436c71) was a blanket `npm audit ... || echo` soft-fail — it
 * kept the pipeline green against the two known-open advisories
 * (adm-zip/pdfjs-dist) but would have just as quietly waved through any
 * *new* high/critical finding too. It's replaced by
 * `scripts/audit-dependencies.mjs`, which parses `npm audit --json` and
 * hard-fails on anything not in its explicit `ALLOWLIST`. This file now
 * also asserts the allowlist is exactly the two tracked advisories, and
 * exercises the script's pass/fail behavior against fixture JSON (no
 * network access — `npm audit` itself is never invoked here).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const pipelinePath = path.join(repoRoot, 'bitbucket-pipelines.yml');
const renovatePath = path.join(repoRoot, 'renovate.json');
const auditScriptPath = path.join(repoRoot, 'scripts', 'audit-dependencies.mjs');

let passed = 0, failed = 0;
const test = async (name: string, fn: () => void | Promise<void>) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

(async () => {
    console.log('CI dependency-audit guard — finding #18');

    // ── bitbucket-pipelines.yml ──────────────────────────────────────
    await test('bitbucket-pipelines.yml exists', () => {
        assert.ok(fs.existsSync(pipelinePath), `${pipelinePath} not found`);
    });

    const pipelineText = fs.existsSync(pipelinePath) ? fs.readFileSync(pipelinePath, 'utf-8') : '';

    await test('pipeline runs the scoped audit-dependencies.mjs gate', () => {
        // The real `npm audit` invocation now lives inside
        // scripts/audit-dependencies.mjs (asserted below), not as a
        // literal pipeline script line — the pipeline just has to call it.
        const scriptLines = pipelineText
            .split('\n')
            .filter((line) => !line.trim().startsWith('#'));
        assert.ok(
            scriptLines.some((line) => /node\s+scripts\/audit-dependencies\.mjs\b/.test(line)),
            'no non-comment pipeline line invokes `node scripts/audit-dependencies.mjs` — ' +
            'the dependency-vulnerability gate has regressed',
        );
    });

    await test('the blanket npm-audit soft-fail is gone from the pipeline', () => {
        // Regression guard for the original 4d436c71 gate: a bare
        // `npm audit ... || echo ...` on a non-comment line would silently
        // wave through every finding, allowlisted or not.
        const softFailLines = pipelineText
            .split('\n')
            .filter((line) => !line.trim().startsWith('#'))
            .filter((line) => /npm audit\b/.test(line) && /\|\|\s*echo/.test(line));
        assert.equal(
            softFailLines.length,
            0,
            `found a blanket npm-audit soft-fail on a non-comment pipeline line:\n  ${softFailLines.join('\n  ')}`,
        );
    });

    await test('scripts/audit-dependencies.mjs exists', () => {
        assert.ok(fs.existsSync(auditScriptPath), `${auditScriptPath} not found`);
    });

    const auditScriptText = fs.existsSync(auditScriptPath) ? fs.readFileSync(auditScriptPath, 'utf-8') : '';

    await test('audit-dependencies.mjs invokes npm audit with --omit=dev --audit-level=high --json', () => {
        assert.match(auditScriptText, /['"]audit['"]/, 'no `npm audit` subcommand found in the script');
        assert.match(auditScriptText, /--omit=dev/, 'script does not scope to production deps (--omit=dev)');
        assert.match(auditScriptText, /--audit-level=high/, 'script does not gate on --audit-level=high');
        assert.match(auditScriptText, /--json/, 'script does not request --json output');
    });

    await test('the ci install step still runs (npm ci is present)', () => {
        assert.match(pipelineText, /npm ci\b/, 'no `npm ci` install step found');
    });

    // ── renovate.json ────────────────────────────────────────────────
    await test('renovate.json exists at repo root', () => {
        assert.ok(fs.existsSync(renovatePath), `${renovatePath} not found`);
    });

    let renovateConfig: Record<string, unknown> = {};
    await test('renovate.json parses as valid JSON', () => {
        const raw = fs.readFileSync(renovatePath, 'utf-8');
        renovateConfig = JSON.parse(raw);
        assert.ok(renovateConfig && typeof renovateConfig === 'object', 'parsed value is not an object');
    });

    await test('renovate.json declares lockfile maintenance', () => {
        assert.ok(
            'lockFileMaintenance' in renovateConfig,
            'missing lockFileMaintenance — weekly lockfile-only maintenance is required',
        );
        const lfm = renovateConfig.lockFileMaintenance as Record<string, unknown>;
        assert.equal(lfm.enabled, true, 'lockFileMaintenance.enabled must be true');
    });

    await test('renovate.json groups minor/patch updates', () => {
        assert.ok(Array.isArray(renovateConfig.packageRules), 'missing packageRules array');
        const rules = renovateConfig.packageRules as Array<Record<string, unknown>>;
        const groupsMinorPatch = rules.some((rule) => {
            const updateTypes = rule.matchUpdateTypes;
            return (
                Array.isArray(updateTypes) &&
                updateTypes.includes('minor') &&
                updateTypes.includes('patch') &&
                typeof rule.groupName === 'string'
            );
        });
        assert.ok(groupsMinorPatch, 'no packageRules entry groups minor+patch updates under a groupName');
    });

    await test('renovate.json enables vulnerability (security) alerts', () => {
        assert.ok(
            'vulnerabilityAlerts' in renovateConfig,
            'missing vulnerabilityAlerts config — security updates must be enabled',
        );
        const va = renovateConfig.vulnerabilityAlerts as Record<string, unknown>;
        assert.equal(va.enabled, true, 'vulnerabilityAlerts.enabled must be true');
    });

    await test('renovate.json documents that it also covers the GitHub mirror', () => {
        const raw = JSON.stringify(renovateConfig);
        assert.ok(
            /github/i.test(raw),
            'expected a note (e.g. in a description field) referencing the GitHub mirror',
        );
    });

    // ── scripts/audit-dependencies.mjs — allowlist shape ────────────────
    // Dynamic import so this test exercises the real, live ALLOWLIST const
    // (not a copy) — a change to the script is what this guards against.
    const auditModule = await import(pathToFileURL(auditScriptPath).href) as {
        ALLOWLIST: Array<{ id?: string; package: string; reason: string }>;
        extractAdvisories: (auditJson: unknown) => Array<{ id?: string; package: string; severity: string }>;
        evaluate: (
            auditJson: unknown,
            allowlist?: Array<{ id?: string; package: string; reason: string }>,
        ) => { ignored: unknown[]; failing: unknown[] };
    };

    await test('ALLOWLIST is exactly the two tracked advisories, each with a reason', () => {
        const ids = auditModule.ALLOWLIST.map((entry) => entry.id).sort();
        assert.deepEqual(
            ids,
            ['GHSA-hq66-cqwq-w95j', 'GHSA-xcpc-8h2w-3j85'],
            `ALLOWLIST ids changed — expected exactly the two tracked advisories, got: ${ids.join(', ')}`,
        );
        const packages = auditModule.ALLOWLIST.map((entry) => entry.package).sort();
        assert.deepEqual(packages, ['adm-zip', 'pdfjs-dist']);
        for (const entry of auditModule.ALLOWLIST) {
            assert.ok(
                typeof entry.reason === 'string' && entry.reason.length > 20,
                `ALLOWLIST entry for ${entry.package} is missing a substantive reason`,
            );
            assert.match(
                entry.reason,
                /major/i,
                `ALLOWLIST entry for ${entry.package} should note the planned major-bump fix`,
            );
        }
    });

    // ── scripts/audit-dependencies.mjs — behavior against fixture JSON ──
    // No network access: these fixtures are hand-built `npm audit --json`
    // shapes (captured from a real run, then trimmed/extended), never a
    // live `npm audit` invocation.
    const ADM_ZIP_ADVISORY = {
        name: 'adm-zip',
        severity: 'high',
        isDirect: false,
        via: [
            {
                source: 1123686,
                name: 'adm-zip',
                dependency: 'adm-zip',
                title: 'adm-zip: Crafted ZIP file triggers 4GB memory allocation',
                url: 'https://github.com/advisories/GHSA-xcpc-8h2w-3j85',
                severity: 'high',
                range: '<0.6.0',
            },
        ],
        effects: ['onnxruntime-node'],
        range: '<0.6.0',
        nodes: ['node_modules/adm-zip'],
        fixAvailable: { name: '@huggingface/transformers', version: '3.8.1', isSemVerMajor: true },
    };
    const PDFJS_ADVISORY = {
        name: 'pdfjs-dist',
        severity: 'high',
        isDirect: true,
        via: [
            {
                source: 1138116,
                name: 'pdfjs-dist',
                dependency: 'pdfjs-dist',
                title: 'PDF.js: Arbitrary JavaScript execution upon opening a malicious PDF',
                url: 'https://github.com/advisories/GHSA-hq66-cqwq-w95j',
                severity: 'high',
                range: '>=5.6.83 <6.2.108',
            },
        ],
        effects: [],
        range: '>=5.6.83 <6.2.108',
        nodes: ['node_modules/pdfjs-dist'],
        fixAvailable: { name: 'pdfjs-dist', version: '6.3.289', isSemVerMajor: true },
    };
    const ALLOWLISTED_ONLY_FIXTURE = {
        vulnerabilities: {
            'adm-zip': ADM_ZIP_ADVISORY,
            'pdfjs-dist': PDFJS_ADVISORY,
            'onnxruntime-node': { name: 'onnxruntime-node', severity: 'high', isDirect: false, via: ['adm-zip'], effects: ['@huggingface/transformers'] },
            '@huggingface/transformers': { name: '@huggingface/transformers', severity: 'high', isDirect: true, via: ['onnxruntime-node'], effects: [] },
        },
        metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 4, critical: 0, total: 4 } },
    };
    const NEW_ADVISORY_FIXTURE = {
        vulnerabilities: {
            ...ALLOWLISTED_ONLY_FIXTURE.vulnerabilities,
            'left-pad': {
                name: 'left-pad',
                severity: 'critical',
                isDirect: true,
                via: [
                    {
                        source: 9999999,
                        name: 'left-pad',
                        dependency: 'left-pad',
                        title: 'left-pad: Hypothetical remote code execution',
                        url: 'https://github.com/advisories/GHSA-0000-0000-0000',
                        severity: 'critical',
                        range: '*',
                    },
                ],
                effects: [],
            },
        },
        metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 4, critical: 1, total: 5 } },
    };
    const CLEAN_FIXTURE = { vulnerabilities: {}, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } } };

    await test('evaluate() ignores the two allowlisted advisories and finds nothing failing', () => {
        const { ignored, failing } = auditModule.evaluate(ALLOWLISTED_ONLY_FIXTURE);
        assert.equal(failing.length, 0, `expected no failing advisories, got: ${JSON.stringify(failing)}`);
        assert.equal(ignored.length, 2, `expected exactly 2 ignored advisories, got: ${JSON.stringify(ignored)}`);
    });

    await test('evaluate() fails on a non-allowlisted high/critical advisory', () => {
        const { failing } = auditModule.evaluate(NEW_ADVISORY_FIXTURE);
        assert.equal(failing.length, 1, `expected exactly 1 failing advisory, got: ${JSON.stringify(failing)}`);
        assert.equal((failing[0] as { package: string }).package, 'left-pad');
    });

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-dependencies-unit-'));

    const runScript = (fixture: unknown): { status: number | null; stdout: string; stderr: string } => {
        const fixturePath = path.join(tmpDir, `fixture-${Math.random().toString(36).slice(2)}.json`);
        fs.writeFileSync(fixturePath, JSON.stringify(fixture));
        try {
            const stdout = execFileSync('node', [auditScriptPath], {
                encoding: 'utf-8',
                env: { ...process.env, AUDIT_JSON_FILE: fixturePath },
            });
            return { status: 0, stdout, stderr: '' };
        } catch (e) {
            const err = e as { status: number | null; stdout?: string; stderr?: string };
            return { status: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
        }
    };

    await test('script run: exits 0 and prints the ignored list when only allowlisted advisories are present', () => {
        const { status, stdout } = runScript(ALLOWLISTED_ONLY_FIXTURE);
        assert.equal(status, 0, `expected exit 0, got ${status}. stdout:\n${stdout}`);
        assert.match(stdout, /ignoring tracked advisories/i);
        assert.match(stdout, /GHSA-xcpc-8h2w-3j85/);
        assert.match(stdout, /GHSA-hq66-cqwq-w95j/);
    });

    await test('script run: exits 0 on a clean audit with no vulnerabilities', () => {
        const { status, stdout } = runScript(CLEAN_FIXTURE);
        assert.equal(status, 0, `expected exit 0, got ${status}. stdout:\n${stdout}`);
    });

    await test('script run: exits non-zero and names the offender when a non-allowlisted advisory is present', () => {
        const { status, stdout, stderr } = runScript(NEW_ADVISORY_FIXTURE);
        assert.notEqual(status, 0, `expected a non-zero exit, got ${status}. stdout:\n${stdout}`);
        assert.match(stderr, /FAILING/i);
        assert.match(stderr, /left-pad/);
        // The two tracked advisories in the same fixture must still be
        // reported as ignored, not folded into the failure.
        assert.match(stdout, /GHSA-xcpc-8h2w-3j85/);
        assert.match(stdout, /GHSA-hq66-cqwq-w95j/);
    });

    fs.rmSync(tmpDir, { recursive: true, force: true });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
})();
