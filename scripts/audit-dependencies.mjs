#!/usr/bin/env node
/**
 * audit-dependencies.mjs — scoped `npm audit` gate.
 *
 * Replaces the blanket soft-fail added in commit 4d436c71 (V-depaudit):
 * `npm audit --omit=dev --audit-level=high || echo "AUDIT: known-open
 * advisories..."` warned on *every* high/critical finding, tracked or not,
 * which meant a genuinely new vulnerability would only print a line and
 * exit 0 — no different from the two advisories it was meant to excuse.
 *
 * This script instead runs the same `npm audit --omit=dev --audit-level=high
 * --json`, extracts every high/critical advisory, and fails unless each one
 * is on the explicit ALLOWLIST below. Anything not on the allowlist fails
 * the build; anything on it is printed (not silently swallowed) so the
 * ignored findings stay visible in CI output.
 *
 * Decision by Rafi, 2026-09-04 (see docs/SECURITY_MODEL.md §12 and the
 * CHANGELOG "Verification audit" entry for the same date).
 *
 * Testing without the network: set AUDIT_JSON_FILE to a path containing a
 * pre-captured `npm audit --json` payload and this script reads that file
 * instead of shelling out to npm. See test/ci-dependency-audit-unit.ts.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

/**
 * Advisories intentionally excluded from the hard-fail gate. Each entry
 * MUST carry a reason and a planned fix — this is a tracked exception
 * list, not a blanket bypass. Keep in sync with docs/SECURITY_MODEL.md §12.
 *
 * `id` is the GHSA id parsed from the advisory's `url` (stable — GitHub
 * Security Advisory ids do not get reused or renumbered). `package` is the
 * npm package the advisory is reported against (the `via` entry's own
 * `name`), kept as a secondary/defense-in-depth match in case a future
 * `npm audit` schema change ever stops emitting a parseable GHSA url.
 */
export const ALLOWLIST = [
  {
    id: 'GHSA-xcpc-8h2w-3j85',
    package: 'adm-zip',
    // adm-zip <0.6.0, pulled in via onnxruntime-node -> @huggingface/transformers.
    // Install-time only (unzips a prebuilt onnxruntime binary during `npm
    // install`, never touches user-ingested content). No patched adm-zip
    // exists in onnxruntime-node's declared range (fixAvailable: false).
    // Planned fix: upstream @huggingface/transformers major release that
    // repins onnxruntime-node; tracked, not yet available.
    reason:
      'install-time only via onnxruntime-node -> @huggingface/transformers; ' +
      'no non-breaking fix exists yet. Planned fix: major bump once ' +
      '@huggingface/transformers repins onnxruntime-node.',
  },
  {
    id: 'GHSA-hq66-cqwq-w95j',
    package: 'pdfjs-dist',
    // pdfjs-dist >=5.6.83 <6.2.108. The vulnerable scripting-sandbox path
    // requires enableScripting: true, which packages/lore/src/engines/
    // extractors/pdf.ts never sets and which is architecturally absent
    // from the pdf.mjs entry point it imports. Fixed in pdfjs-dist@6.2.108,
    // a breaking major bump (5->6), deliberately deferred.
    reason:
      'requires enableScripting: true, which this repo never sets and the ' +
      'pdf.mjs entry point it imports cannot reach. Planned fix: major ' +
      'bump to pdfjs-dist@6.2.108+ once scheduled.',
  },
];

const GATED_SEVERITIES = new Set(['high', 'critical']);

function parseGhsaId(url) {
  if (typeof url !== 'string') return undefined;
  const match = url.match(/GHSA-[a-zA-Z0-9]+-[a-zA-Z0-9]+-[a-zA-Z0-9]+/);
  return match ? match[0] : undefined;
}

/**
 * Walk an `npm audit --json` payload and return every distinct advisory at
 * high/critical severity. `npm audit` nests the real advisory (an object
 * with a `url`) inside the `via` array of the package it was found on;
 * packages that only transitively depend on a vulnerable package instead
 * list the dependency's *name* (a string) in `via`, which is not a new
 * advisory — it just points at the object recorded elsewhere in the tree.
 * So only object `via` entries are treated as advisories here.
 */
export function extractAdvisories(auditJson) {
  const vulnerabilities = auditJson && auditJson.vulnerabilities;
  if (!vulnerabilities || typeof vulnerabilities !== 'object') return [];

  const advisoriesById = new Map();
  for (const [topLevelPackage, info] of Object.entries(vulnerabilities)) {
    const via = Array.isArray(info?.via) ? info.via : [];
    for (const entry of via) {
      if (!entry || typeof entry !== 'object') continue; // string = pointer, not an advisory
      const severity = entry.severity;
      if (!GATED_SEVERITIES.has(severity)) continue;
      const ghsaId = parseGhsaId(entry.url);
      const key = ghsaId ?? `${entry.name}:${entry.title}`;
      if (advisoriesById.has(key)) continue;
      advisoriesById.set(key, {
        id: ghsaId,
        package: entry.name ?? topLevelPackage,
        title: entry.title,
        url: entry.url,
        severity,
      });
    }
  }
  return Array.from(advisoriesById.values());
}

/**
 * Split extracted advisories into `ignored` (matched an allowlist entry —
 * printed, not silenced) and `failing` (everything else). Match by GHSA id
 * first, falling back to package name so a missing/garbled id doesn't
 * accidentally let a real regression through, or block a legitimately
 * allowlisted one.
 */
export function evaluate(auditJson, allowlist = ALLOWLIST) {
  const advisories = extractAdvisories(auditJson);
  const ignored = [];
  const failing = [];
  for (const advisory of advisories) {
    const match = allowlist.find(
      (entry) => (advisory.id && entry.id === advisory.id) || entry.package === advisory.package,
    );
    if (match) {
      ignored.push({ ...advisory, reason: match.reason });
    } else {
      failing.push(advisory);
    }
  }
  return { advisories, ignored, failing };
}

function loadAuditJson() {
  const fixturePath = process.env.AUDIT_JSON_FILE;
  if (fixturePath) {
    const raw = fs.readFileSync(fixturePath, 'utf-8');
    return JSON.parse(raw);
  }

  // `npm audit` exits non-zero when it finds matching vulnerabilities even
  // with --json, so stdout must be captured regardless of exit status.
  try {
    const stdout = execFileSync(
      'npm',
      ['audit', '--omit=dev', '--audit-level=high', '--json'],
      {
        cwd: repoRoot,
        encoding: 'utf-8',
        // 60s: `npm audit` occasionally stalls on registry/update-notifier
        // network calls unrelated to the advisory bulk lookup itself; fail
        // the gate loudly on a hang instead of blocking CI indefinitely.
        timeout: 60_000,
        env: {
          ...process.env,
          NO_UPDATE_NOTIFIER: '1',
          npm_config_update_notifier: 'false',
          npm_config_fund: 'false',
          npm_config_progress: 'false',
        },
      },
    );
    return JSON.parse(stdout);
  } catch (error) {
    if (error?.signal === 'SIGTERM' && error?.code === 'ETIMEDOUT') {
      console.error('audit-dependencies: `npm audit --json` timed out after 60s');
      throw error;
    }
    // execFileSync throws on non-zero exit; npm still wrote JSON to stdout.
    const stdout = error?.stdout;
    if (typeof stdout === 'string' && stdout.trim().length > 0) {
      try {
        return JSON.parse(stdout);
      } catch (parseError) {
        console.error('audit-dependencies: failed to parse `npm audit --json` output');
        console.error(stdout);
        throw parseError;
      }
    }
    throw error;
  }
}

function main() {
  const auditJson = loadAuditJson();
  const { ignored, failing } = evaluate(auditJson, ALLOWLIST);

  if (ignored.length > 0) {
    console.log('audit-dependencies: ignoring tracked advisories (see docs/SECURITY_MODEL.md §12):');
    for (const advisory of ignored) {
      console.log(`  - ${advisory.id ?? '(no GHSA id)'} ${advisory.package}: ${advisory.title}`);
      console.log(`      reason: ${advisory.reason}`);
    }
  }

  if (failing.length > 0) {
    console.error('audit-dependencies: FAILING on advisories not in the allowlist:');
    for (const advisory of failing) {
      console.error(`  - ${advisory.id ?? '(no GHSA id)'} ${advisory.package}: ${advisory.title}`);
      console.error(`      ${advisory.url ?? '(no url)'}`);
    }
    console.error(
      '\nEither fix the dependency, or if this is a deliberately accepted risk, ' +
        'add it to ALLOWLIST in scripts/audit-dependencies.mjs with a reason and a ' +
        'planned fix, and record it in docs/SECURITY_MODEL.md §12.',
    );
    process.exitCode = 1;
    return;
  }

  console.log('audit-dependencies: no non-allowlisted high/critical advisories found.');
  process.exitCode = 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
