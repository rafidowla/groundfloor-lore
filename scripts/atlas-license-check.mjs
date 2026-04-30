#!/usr/bin/env node
/**
 * atlas-license-check.mjs — Atlas (developer plugin) license-compliance guardrail.
 *
 * Two checks on every new Atlas source file under
 * `packages/lore-plugin-developer/src/{parser,resolver,analytics,git,mcp}/`
 * (the rebuild surface — see plan §10):
 *
 *   1. Required header. Each file must declare original authorship via
 *      a fixed marker string. The header is the audit trail that the
 *      file was written from notes/general knowledge, not by porting
 *      GitNexus or jcodemunch source.
 *
 *   2. No string-fragment overlap with GitNexus / jcodemunch upstream.
 *      A small set of non-trivial fingerprint strings — collected from
 *      our reading notes — are checked against every Atlas source file.
 *      A hit means the implementation may have been transcribed
 *      verbatim and needs a re-write.
 *
 * The fingerprint corpus deliberately uses *summary-shape* fragments
 * (function-signature snippets, distinctive constant names) NOT
 * verbatim source code. This avoids re-distributing upstream code in
 * our own repo while still catching paste mistakes.
 *
 * Exit code 0 if clean, 1 if dirty. Hooked into `npm run test:arch`
 * so it runs on every commit.
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * Original work; see docs/PLAN_replace_gitnexus_in_developer_plugin.md
 * section 10 for the policy this script enforces.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const ATLAS_DIRS = [
    'packages/lore-plugin-developer/src/parser',
    'packages/lore-plugin-developer/src/resolver',
    'packages/lore-plugin-developer/src/analytics',
    'packages/lore-plugin-developer/src/git',
    'packages/lore-plugin-developer/src/mcp',
];

// Fingerprint marker required at the top of every Atlas .ts file.
// Either of these substrings counts as a valid header. The plan's
// section-10 wording is the canonical phrasing.
const REQUIRED_HEADER_FRAGMENTS = [
    "Atlas — Lore developer plugin's tree-sitter code intelligence layer",
    'Original work authored for groundfloor-lore',
];

// Distinctive fingerprint fragments from upstream sources we read for
// understanding (GitNexus and jcodemunch). These are SHORT, NON-TRIVIAL
// summary-shape strings — function signatures and distinctive constant
// names — chosen so that any verbatim copy of the upstream surface
// would trigger a hit. We deliberately do NOT include long source
// excerpts here.
//
// Keep the list narrow. Every fragment must be:
//   - distinctive (not a common idiom)
//   - non-trivial (≥ 12 characters or a multi-token symbol name)
//   - safe to redistribute (we did not lift it out of the upstream
//     binary; it was already published in their public README / API
//     surface or chosen as a paraphrase of a distinctive identifier).
const FORBIDDEN_FINGERPRINTS = [
    // GitNexus distinctive tool names — we do not register these in our
    // own MCP surface (we use code_*). If they appear in Atlas source
    // it almost certainly means a paste from GitNexus.
    'analyzeRepository(',
    'GitNexusAnalyzer',
    'gitnexus_query(', // tool registration with this exact spelling
    'gitnexus_context(',
    'gitnexus_impact(',
    // jcodemunch distinctive surface — these tool names belong to
    // upstream. Atlas exposes the same capability under different
    // names (code_tectonic_map, code_search_ast).
    'get_tectonic_map(',
    'winnow_symbols(',
    'JCodeMunch',
    'jcodemunch',
    // Unique ladybugDB identifier (gitnexus's internal embedded DB)
    // — Atlas writes into Kùzu + LanceDB and never touches LadybugDB.
    'LadybugDB',
];

// Allowlist for fingerprint hits — files where the string is allowed
// (e.g. this script itself, comments referencing the rule, alias
// modules that legitimately quote the old tool name).
const FINGERPRINT_ALLOWLIST = new Set([
    'scripts/atlas-license-check.mjs',
    // mcp/aliases.ts will need to register `gitnexus_query` etc. as
    // back-compat aliases per plan §6. The string MAY appear there.
    'packages/lore-plugin-developer/src/mcp/aliases.ts',
]);

function walk(dir, out = []) {
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walk(abs, out);
        } else if (entry.isFile() && entry.name.endsWith('.ts')) {
            out.push(abs);
        }
    }
    return out;
}

const allFiles = ATLAS_DIRS.flatMap((d) => walk(path.join(repoRoot, d)));
const headerMisses = [];
const fingerprintHits = [];

for (const abs of allFiles) {
    const rel = path.relative(repoRoot, abs).replace(/\\/g, '/');
    const content = fs.readFileSync(abs, 'utf8');

    const hasHeader = REQUIRED_HEADER_FRAGMENTS.some((frag) => content.includes(frag));
    if (!hasHeader) {
        headerMisses.push(rel);
    }

    if (!FINGERPRINT_ALLOWLIST.has(rel)) {
        // Strip comments before fingerprint check — license-policy text
        // and citations of upstream by name are allowed in headers and
        // doc-comments. The forbidden case is verbatim identifiers in
        // executable code. Same pattern test-arch.mjs uses for plugin
        // vocab tokens.
        const codeOnly = content
            .replace(/\/\/[^\n]*/g, '')
            .replace(/\/\*[\s\S]*?\*\//g, '');
        for (const frag of FORBIDDEN_FINGERPRINTS) {
            if (codeOnly.includes(frag)) {
                fingerprintHits.push({ file: rel, fragment: frag });
            }
        }
    }
}

if (headerMisses.length === 0 && fingerprintHits.length === 0) {
    console.log(
        `✓ Atlas license-compliance check passed (${allFiles.length} file(s) scanned across parser/, resolver/, analytics/, git/, mcp/).`,
    );
    process.exit(0);
}

if (headerMisses.length > 0) {
    console.error(
        `\n✗ Atlas license-compliance check FAILED — ${headerMisses.length} file(s) missing the required header:`,
    );
    for (const f of headerMisses) console.error(`    ${f}`);
    console.error(
        `\nAdd this header (or the equivalent phrasing) to each new Atlas source file:\n` +
        `    /**\n` +
        `     * <relative path>\n` +
        `     *\n` +
        `     * Atlas — Lore developer plugin's tree-sitter code intelligence layer.\n` +
        `     * <one-line summary>\n` +
        `     *\n` +
        `     * Original work authored for groundfloor-lore. Patterns informed by\n` +
        `     * reading GitNexus and jcodemunch source for understanding only — no\n` +
        `     * code copied, no structural mirroring. See \`docs/PLAN_replace_gitnexus_in_developer_plugin.md\`\n` +
        `     * section 10 for the license-compliance protocol.\n` +
        `     */\n`,
    );
}

if (fingerprintHits.length > 0) {
    console.error(
        `\n✗ Atlas license-compliance check FAILED — ${fingerprintHits.length} forbidden fingerprint hit(s):`,
    );
    for (const h of fingerprintHits) {
        console.error(`    ${h.file} contains "${h.fragment}"`);
    }
    console.error(
        `\nThese substrings are distinctive identifiers from GitNexus or jcodemunch.\n` +
        `Their presence in Atlas source suggests a verbatim port. Re-implement from\n` +
        `notes / first principles instead. Plan §10 has the policy.\n`,
    );
}

process.exit(1);
