#!/usr/bin/env node
/**
 * test-arch.mjs — V2.1 Option C plugin-boundary guardrail.
 *
 * Enforces two rules on the Lore source tree:
 *
 *   1. NO CORE IMPORTS FROM PLUGINS. Files outside src/plugins/** must
 *      not `import` from src/plugins/** (except the ILorePlugin type in
 *      src/plugins/types.ts and the PluginRegistry).
 *
 *   2. NO PLUGIN-SPECIFIC VOCABULARY IN CORE. Files outside
 *      src/plugins/** and outside the allowlist must not textually
 *      mention plugin-owned identifiers (CodeSymbol, CodeFile, gitnexus,
 *      etc.). This catches the failure mode from V2.1 — a method that
 *      only makes sense for a specific plugin written in core without
 *      going through a plugin hook.
 *
 * Baseline model:
 *   We carry a .arch-baseline.json listing known legacy violations the
 *   team plans to fix. The test fails ONLY on NEW violations that
 *   aren't in the baseline. Adding a legacy violation to the baseline
 *   requires writing a one-line justification in the file.
 *
 * Exit non-zero on any new violation. Intended to run as
 * `npm run test:arch` in CI and as a pre-commit safety net.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const srcRoot = path.join(repoRoot, 'src');
const baselinePath = path.join(repoRoot, '.arch-baseline.json');

const PLUGIN_SCOPED_TOKENS = [
    // developer plugin
    'CodeSymbol',
    'CodeFile',
    'LoreAppliesToCode',
    'LoreTouchesFile',
    'FileContains',
    'CodeRelation',
    'DevActivity',
    'gitnexus',
    'GitNexus',
    // Add future plugins' tokens here.
];

/**
 * Core files that legitimately reference plugin-scoped tokens — usually
 * because they document the rule itself or hold the one sanctioned
 * plugin-by-name knowledge. Small and justified.
 */
const ALLOWED_IN_CORE = [
    'scripts/test-arch.mjs',
    // Registry's BUILTIN_PLUGINS map is the one place core knows plugin
    // names. It still imports from src/plugins/developer/index for the
    // instance, which is structurally legal (registry is the bridge).
    'src/plugins/registry.ts',
];

const PLUGIN_ROOTS = ['src/plugins'];

function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
            walk(abs, out);
        } else if (entry.isFile() && /\.(ts|tsx|mjs|js)$/.test(entry.name)) {
            out.push(abs);
        }
    }
    return out;
}

function isPluginFile(relPath) {
    return PLUGIN_ROOTS.some((root) => relPath.startsWith(root + '/'));
}

function isAllowlisted(relPath) {
    return ALLOWED_IN_CORE.includes(relPath);
}

function scanAll() {
    const files = walk(srcRoot).concat(walk(path.join(repoRoot, 'scripts')));
    const violations = [];
    const importFromPluginsRe = /import\s+[^;]*?from\s+['"]([^'"]*plugins[/\\][^'"]+)['"]/g;
    const tokenRegexes = PLUGIN_SCOPED_TOKENS.map((t) => ({
        token: t,
        re: new RegExp(`\\b${t}\\b`, 'g'),
    }));

    for (const abs of files) {
        const relPath = path.relative(repoRoot, abs).replace(/\\/g, '/');
        if (isPluginFile(relPath)) continue;
        if (isAllowlisted(relPath)) continue;

        const content = fs.readFileSync(abs, 'utf8');

        let m;
        while ((m = importFromPluginsRe.exec(content)) !== null) {
            const importedPath = m[1];
            // Sanctioned cross-boundary imports:
            //   - plugins/types.js        — ILorePlugin contract
            //   - plugins/registry.js     — dispatcher
            //   - plugins/<name>/api.js   — plugin's public contract. The
            //     api module is the ONE place a plugin declares its
            //     outward-facing surface; importing the type is how core
            //     callers (e.g. CLI orchestration) stay loosely coupled.
            if (importedPath.endsWith('plugins/types.js') || importedPath.endsWith('plugins/types')) continue;
            if (importedPath.endsWith('plugins/registry.js') || importedPath.endsWith('plugins/registry')) continue;
            if (/plugins\/[^/]+\/api(\.js)?$/.test(importedPath)) continue;
            violations.push({ rule: 'no-plugin-import', file: relPath, token: importedPath });
        }

        const stripped = content.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
        for (const { token, re } of tokenRegexes) {
            re.lastIndex = 0;
            if (re.test(stripped)) {
                violations.push({ rule: 'no-plugin-vocab', file: relPath, token });
            }
        }
    }
    return violations;
}

function keyOf(v) {
    return `${v.rule}\t${v.file}\t${v.token}`;
}

function loadBaseline() {
    if (!fs.existsSync(baselinePath)) return { entries: [] };
    try {
        const raw = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
        return raw.entries ? raw : { entries: raw };
    } catch {
        return { entries: [] };
    }
}

const shouldUpdate = process.argv.includes('--update-baseline');
const violations = scanAll();

if (shouldUpdate) {
    const entries = violations.map((v) => ({
        rule: v.rule,
        file: v.file,
        token: v.token,
        justification: 'Legacy V2.1 debt — to be moved into plugin in a follow-up.',
    }));
    fs.writeFileSync(
        baselinePath,
        JSON.stringify(
            {
                note: 'Known plugin-boundary violations tracked as technical debt. New violations must either be fixed or added here with a justification.',
                entries,
            },
            null,
            2,
        ),
    );
    console.log(`✓ Baseline updated: ${entries.length} legacy violation(s) tracked.`);
    process.exit(0);
}

const baseline = loadBaseline();
const baselineKeys = new Set((baseline.entries ?? []).map(keyOf));
const newViolations = violations.filter((v) => !baselineKeys.has(keyOf(v)));

if (newViolations.length === 0) {
    const legacy = violations.length;
    console.log(`✓ Architecture test passed (no new plugin-boundary violations).`);
    if (legacy > 0) {
        console.log(`  (${legacy} legacy violation(s) still tracked in .arch-baseline.json — move them into plugins when touched.)`);
    }
    process.exit(0);
}

console.error(`✗ Architecture test FAILED with ${newViolations.length} NEW violation(s):\n`);
const grouped = new Map();
for (const v of newViolations) {
    const arr = grouped.get(v.file) ?? [];
    arr.push(v);
    grouped.set(v.file, arr);
}
for (const [file, vs] of grouped) {
    console.error(`  ${file}`);
    for (const v of vs) {
        console.error(`    [${v.rule}] ${v.token}`);
    }
}
console.error(
    '\nHow to fix:\n' +
    '  1. Move the offending logic into src/plugins/<name>/ and route through an ILorePlugin hook.\n' +
    '  2. OR, if genuinely legacy (existed before C-4), re-run `npm run test:arch -- --update-baseline` to record.\n' +
    '  3. OR, if genuinely core, add the file to ALLOWED_IN_CORE in scripts/test-arch.mjs with a comment.\n',
);
process.exit(1);
