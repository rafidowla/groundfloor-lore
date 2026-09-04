#!/usr/bin/env node
/**
 * test-arch.mjs — Architecture guardrails for Lore Core.
 *
 * Enforces two rules:
 *
 *   1. NO DIRECT CLOUD-DB DRIVER IMPORTS (D-017, 2026-04-21).
 *      All cloud-mode data access must go through Dataplane via
 *      groundfloor-ts-sdk. Core code must never import a cloud-DB
 *      driver directly — doing so leaks tenant-isolation, ReBAC,
 *      and change-feed invalidation guarantees that Dataplane owns.
 *
 *   2. WORKSPACE CONFINEMENT — NO LITERAL-UNDEFINED SCOPE GATES
 *      (D-021, Wave 4.1). `requireWriteToWorkspace(principal, undefined)` /
 *      `requireReadFromWorkspace(principal, undefined)` is the exact
 *      anti-pattern the Wave-4 audit named: a literal-undefined target
 *      defaults to the token's OWN workspace and so ALWAYS passes for any
 *      write/read-scoped token — it can never confine, and it hides a
 *      boot-scope default. Routes must resolve a CONCRETE target and gate
 *      through security/routeWorkspaceBinding.ts (bindRouteTarget /
 *      bindDaemonOperatorLane) instead. A transitional allowlist holds the
 *      not-yet-swept files (drained to [] by wave end); the rule fails on any
 *      NEW occurrence and also fails if an allowlist entry no longer violates
 *      (ratchet — no stale entries, mirroring .file-size-baseline.json).
 *
 * Note: Plugin-boundary rules (no-plugin-import, no-plugin-vocab) were
 * removed in v3.11.0 when the plugin system was deprecated. Domain logic
 * (CRE, Legal, Personal) now lives in standalone applications.
 *
 * Exit non-zero on any violation.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const srcRoot = path.join(repoRoot, 'packages');

/**
 * Q2.1 — Forbidden direct cloud-DB driver imports.
 *
 * Per D-017 (2026-04-21), all cloud-mode data access must go through
 * Dataplane via `groundfloor-ts-sdk`. Core Lore code must NEVER import
 * a cloud-DB driver directly — not even "just for a migration" or
 * "just for a benchmark". Any direct driver leaks tenant-isolation,
 * ReBAC, and change-feed invalidation guarantees that Dataplane owns.
 */
const FORBIDDEN_CLOUD_DRIVERS = [
    'pg',                  // Postgres
    'postgres',            // alt Postgres driver
    '@arangodb/arangojs',  // Arango server SDK
    'arangojs',            // Arango JS driver
    '@qdrant/js-client-rest', // Qdrant
    'qdrant-client',       // Qdrant (alt)
    '@zilliz/milvus2-sdk-node', // Zilliz / Milvus
    'milvus-sdk',          // Milvus (alt)
    'ioredis',             // Redis
    'redis',               // Redis (legacy)
];

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

function scanAll() {
    const files = walk(srcRoot).concat(walk(path.join(repoRoot, 'scripts')));
    const violations = [];
    const anyImportRe = /(?:import\s+[^;]*?from|require\s*\()\s*['"]([^'"]+)['"]/g;

    for (const abs of files) {
        const relPath = path.relative(repoRoot, abs).replace(/\\/g, '/');
        const content = fs.readFileSync(abs, 'utf8');

        anyImportRe.lastIndex = 0;
        let dm;
        while ((dm = anyImportRe.exec(content)) !== null) {
            const spec = dm[1];
            if (spec.startsWith('.') || spec.startsWith('/')) continue;
            const firstSeg = spec.startsWith('@')
                ? spec.split('/').slice(0, 2).join('/')
                : spec.split('/')[0];
            if (FORBIDDEN_CLOUD_DRIVERS.includes(firstSeg)) {
                violations.push({ rule: 'no-direct-cloud-driver', file: relPath, token: firstSeg });
            }
        }
    }
    return violations;
}

/**
 * D-018 (SP-14, 2026-06-10) — NO PLUGIN VOCAB ON THE STORAGE SURFACE.
 *
 * The plugin system was removed in v3.11.0 (CLAUDE.md: "No plugin hooks or
 * extension points"). The public storage surface — contracts/ and the
 * engine *Storage.ts adapters — must not reintroduce plugin naming, or a
 * future contributor reads `PluginStorage` and infers plugins exist. This
 * rule fails on any `Plugin` substring in those files so the residue can't
 * creep back. Scope is intentionally narrow (storage surface only);
 * unrelated `Plugin` identifiers elsewhere (e.g. legacy migration code) are
 * out of scope for this rule.
 */
function scanPluginVocab() {
    const out = [];
    const targets = [];
    const contractsDir = path.join(srcRoot, 'lore/src/contracts');
    if (fs.existsSync(contractsDir)) {
        for (const f of walk(contractsDir)) if (/\.ts$/.test(f)) targets.push(f);
    }
    const enginesDir = path.join(srcRoot, 'lore/src/engines');
    if (fs.existsSync(enginesDir)) {
        for (const entry of fs.readdirSync(enginesDir)) {
            if (/Storage\.ts$/.test(entry)) targets.push(path.join(enginesDir, entry));
        }
    }
    for (const abs of targets) {
        const relPath = path.relative(repoRoot, abs).replace(/\\/g, '/');
        const content = fs.readFileSync(abs, 'utf8');
        if (/Plugin/.test(content)) {
            out.push({ rule: 'no-plugin-vocab-on-storage-surface', file: relPath, token: 'Plugin' });
        }
    }
    return out;
}

/**
 * D-019 (SP-20, 2026-06-10) — NO DIRECT STORE-BYPASS GRAPH WRITES.
 *
 * Code outside the storage facade and engines directory must not call
 * graph write methods directly via the StorageBundle's loreGraph field
 * (e.g. `deps.store.loreGraph.upsertNode`, `this.store.loreGraph.upsertNode`).
 * This pattern bypasses LoreStorageClient — the cloud-swap point and the
 * embed/outbox boundary. Writes should go through `deps.store.storageClient`.
 *
 * The rule is intentionally narrow: it only fires on the specific bypass
 * pattern `loreGraph.upsertNode|upsertEdge|deleteNode` (the StorageBundle
 * field name), not on every `.upsertNode` call site. This avoids false
 * positives on engine internals that legitimately own the substrate.
 */
function scanDirectGraphUpserts() {
    const out = [];
    // Only the facade itself is exempt from this specific pattern check.
    // Engines own the substrate so they're also permitted.
    const PERMITTED_PATHS = [
        'storage/loreStorageClient.ts',
        'packages/lore/src/engines/',
        'packages/lore/src/outbox/',  // replicator/dispatcher fan-out is intentional
    ];
    // The specific pattern: loreGraph.(upsertNode|upsertEdge|deleteNode)(
    // This catches `deps.store.loreGraph.upsertNode(` and `this.loreGraph.upsertNode(`
    // without flagging `storageClient.upsertNode(` or any other .upsertNode usage.
    const BYPASS_RE = /\bloreGraph\.(upsertNode|upsertEdge|deleteNode)\s*\(/g;
    const files = walk(srcRoot);
    for (const abs of files) {
        if (!abs.endsWith('.ts')) continue;
        const relPath = path.relative(repoRoot, abs).replace(/\\/g, '/');
        if (PERMITTED_PATHS.some(p => relPath.includes(p))) continue;
        // Skip test files
        if (relPath.includes('/test/') || relPath.endsWith('.test.ts') || relPath.endsWith('.spec.ts')) continue;
        const content = fs.readFileSync(abs, 'utf8');
        // Strip single-line comments (//) and backtick/string literals to avoid false
        // positives from comments that describe the old pattern (e.g. "don't call loreGraph.upsertNode")
        const stripped = content
            .replace(/\/\/[^\n]*/g, '')   // strip // line comments
            .replace(/`[^`]*`/g, '``');   // strip template literals
        BYPASS_RE.lastIndex = 0;
        let m;
        while ((m = BYPASS_RE.exec(stripped)) !== null) {
            out.push({ rule: 'no-direct-graph-upsert', file: relPath, token: `loreGraph.${m[1]}` });
            break; // one violation per file is enough to signal
        }
    }
    return out;
}

/**
 * D-021(a) (Wave 4.1) — BAN literal-undefined workspace targets.
 *
 * `requireWriteToWorkspace(principal, undefined)` and
 * `requireReadFromWorkspace(principal, undefined)` resolve the target to the
 * principal's OWN workspace (auth/principal.ts `requested ?? principal.workspace`),
 * so the gate always passes for any correctly-scoped token and NEVER confines a
 * cross-workspace request. It is the precise bug the wave eliminates. Routes
 * must pass a concrete target through security/routeWorkspaceBinding.ts.
 *
 * Scope: all of packages/lore/src/** except *.test.* / *.spec.* and
 * auth/principal.ts (the definition site, whose `undefined` default is the
 * thing being fenced off). Line comments + template literals are stripped so a
 * comment describing the old pattern doesn't false-positive.
 *
 * Transitional allowlist: files known to still contain the pattern at the start
 * of Wave 4.1, to be drained to [] as Group-A routes are swept. The rule:
 *   - FAILS on any violating file NOT in the allowlist (blocks new/undrained hits).
 *   - FAILS if an allowlist entry no longer violates (stale-entry ratchet).
 */
const D021_UNDEFINED_TARGET_ALLOWLIST = [];

/**
 * Strip `//` line comments, `/* *​/` block comments, and template literals so
 * that a comment describing the old anti-pattern (or a banned token embedded in
 * a doc-comment / backtick string) never false-positives. Shared by the three
 * D-021 sub-checks below.
 */
function stripCommentsAndTemplates(content) {
    return content
        .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
        .replace(/\/\/[^\n]*/g, '')       // line comments
        .replace(/`[^`]*`/g, '``');       // template literals
}

/**
 * Scan `stripped` source for calls to a gate function whose SECOND top-level
 * argument is exactly the literal `undefined`, and return true on the first hit.
 *
 * Robustness vs. the old regex `\(\s*[^,)]+,\s*undefined\s*[,)]`: that regex
 * required the FIRST argument to contain no parens, so `require…Workspace(
 * getCurrentPrincipal(), undefined)` EVADED it (the `(` of `getCurrentPrincipal()`
 * broke the `[^,)]+`). This walks the actual argument list tracking paren/
 * bracket/brace depth, so a first argument that is itself a call expression
 * (or any balanced-paren expression) is handled correctly. It flags the call
 * iff the depth-1 argument list splits into exactly two top-level arguments and
 * the second, trimmed, is the bare identifier `undefined`.
 */
function hasUndefinedSecondArg(stripped, fnNames) {
    const nameAlt = fnNames.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    // Match the gate name immediately followed by the opening paren of its call.
    const callHead = new RegExp(`\\b(?:${nameAlt})\\s*\\(`, 'g');
    let m;
    while ((m = callHead.exec(stripped)) !== null) {
        // Position of the char right after the opening `(`.
        let i = m.index + m[0].length;
        let depth = 1;          // we're inside the gate call's arg list
        const topLevelArgs = []; // trimmed source of each depth-1 argument
        let argStart = i;
        for (; i < stripped.length && depth > 0; i++) {
            const c = stripped[i];
            if (c === '(' || c === '[' || c === '{') {
                depth++;
            } else if (c === ')' || c === ']' || c === '}') {
                depth--;
                if (depth === 0) {
                    topLevelArgs.push(stripped.slice(argStart, i).trim());
                    break;
                }
            } else if (c === ',' && depth === 1) {
                topLevelArgs.push(stripped.slice(argStart, i).trim());
                argStart = i + 1;
            }
        }
        // Flag iff exactly two top-level args and the second is the bare literal.
        if (topLevelArgs.length === 2 && topLevelArgs[1] === 'undefined') return true;
    }
    return false;
}

function scanUndefinedScopeTargets() {
    const out = [];
    const GATE_FNS = ['requireWriteToWorkspace', 'requireReadFromWorkspace'];
    const loreSrc = path.join(srcRoot, 'lore/src');
    const violatingFiles = new Set();
    const files = fs.existsSync(loreSrc) ? walk(loreSrc) : [];
    for (const abs of files) {
        if (!abs.endsWith('.ts')) continue;
        const relPath = path.relative(repoRoot, abs).replace(/\\/g, '/');
        if (/\.(test|spec)\.ts$/.test(relPath)) continue;
        if (relPath.endsWith('auth/principal.ts')) continue; // definition site.
        const content = fs.readFileSync(abs, 'utf8');
        const stripped = stripCommentsAndTemplates(content);
        if (hasUndefinedSecondArg(stripped, GATE_FNS)) violatingFiles.add(relPath);
    }
    // (1) any violating file NOT allowlisted → violation.
    for (const relPath of violatingFiles) {
        if (!D021_UNDEFINED_TARGET_ALLOWLIST.includes(relPath)) {
            out.push({ rule: 'workspace-confinement-no-undefined-target', file: relPath, token: 'requireWriteTo/ReadFromWorkspace(_, undefined)' });
        }
    }
    // (2) stale allowlist entry that no longer violates → violation (ratchet).
    for (const entry of D021_UNDEFINED_TARGET_ALLOWLIST) {
        if (!violatingFiles.has(entry)) {
            out.push({ rule: 'workspace-confinement-stale-allowlist', file: entry, token: 'remove from D021_UNDEFINED_TARGET_ALLOWLIST — no longer violates' });
        }
    }
    return out;
}

/**
 * D-021(b) (Wave 4.1) — HTTP routes must not RAW-import the scope guards.
 *
 * Files under packages/lore/src/mcp/http/routes/** must resolve a concrete
 * target and gate through security/routeWorkspaceBinding.ts (bindRouteTarget /
 * bindDaemonOperatorLane) — NOT reach for the raw requireWriteToWorkspace /
 * requireReadFromWorkspace scope guards from auth/principal. A raw import in a
 * route is the smell that a handler is about to hand-roll a scope gate (and
 * likely pass a literal-undefined target, D-021(a)) instead of going through the
 * chokepoint. Banning the import at the route boundary is a cheaper, earlier
 * fence than catching every call site.
 *
 * Detector: an `import … { … requireWriteToWorkspace | requireReadFromWorkspace
 * … } from …` statement in any file under routes/**. Multi-line import blocks
 * are handled because the import statement is matched up to its terminating
 * `from` across newlines. Same ratchet shape as D-021(a): seed the allowlist
 * with whatever imports them today (GREEN now), fail on any NEW route import,
 * and fail on a stale allowlist entry.
 */
const D021_RAW_GUARD_IMPORT_ALLOWLIST = [];

/**
 * D-021(c) (Wave 4.1) — HTTP routes must not use the boot-default anti-pattern.
 *
 * `getActiveWorkspaceName(` and `detectedScope.workspace` both reach for the
 * daemon's boot/active default workspace. In local mode that default is the
 * WRONG target for a workspace-taking route: every operation must route to the
 * REQUESTED workspace (the app-isolation boundary), never the active default.
 * A route that reads the active/detected workspace is silently confining to the
 * boot default — the exact isolation leak Wave 4 closes.
 *
 * Detector: literal `getActiveWorkspaceName(` or `detectedScope.workspace` in a
 * file under routes/** (comments + template literals stripped). Same ratchet
 * shape: seed with today's offenders (GREEN now), fail on any NEW occurrence,
 * fail on a stale allowlist entry.
 */
const D021_BOOT_DEFAULT_ALLOWLIST = [
    'packages/lore/src/mcp/http/routes/diagnostic/health.ts',
    'packages/lore/src/mcp/http/routes/diagnostic/stats.ts',
    'packages/lore/src/mcp/http/routes/import.ts',
    'packages/lore/src/mcp/http/routes/inspect.ts',
    'packages/lore/src/mcp/http/routes/retention/policy.ts',
    'packages/lore/src/mcp/http/routes/workspaces/workspaceMgmt.ts',
];

/**
 * D-021(d) (Wave 5) — HTTP routes must not use res.headersSent to discriminate a
 * bindRouteTarget result.
 *
 * bindRouteTarget returns null in TWO distinct cases: (i) a DENIAL, where it has
 * already synchronously written a 4xx; and (ii) the pure legacy/direct-call
 * bypass (no principal, no binding slot, no requested workspace), where it wrote
 * NOTHING and the caller must fall through. Some routes disambiguated these with
 * `bindRouteTarget(...) === null && res.headersSent` (or a `bindRouteTarget(...)`
 * followed by a separate `if (res.headersSent) return`). That is FRAGILE and
 * SECURITY-RELEVANT: res.headersSent is set by real Node ServerResponses on
 * writeHead, but stub/fake ServerResponses across the test suite (and any future
 * non-Node HTTP shim — cloud/embedded) never track it. Under such a response a
 * REAL cross-workspace 403 denial (null + headersSent-falsy) fell through and the
 * handler overwrote the 403 with a 2xx — a silent confinement bypass.
 *
 * The robust pattern (schema.ts / orchestrations.ts, generalized as
 * isLegacyBypass in routeWorkspaceBinding.ts): detect the bypass UP FRONT
 * (`isLegacyBypass(requested)`) and skip the gate; then a null return from
 * bindRouteTarget is UNAMBIGUOUSLY a denial → `return true`, never consulting
 * res.headersSent.
 *
 * Detector: a file under routes/** whose stripped source (comments + template
 * literals removed) contains BOTH `bindRouteTarget(` AND a `res.headersSent`
 * denial discriminator — either `res.headersSent` on the SAME statement as a
 * `bindRouteTarget(...) === null` test, or a `bindRouteTarget(` occurrence
 * followed within ~2 lines by an `if (res.headersSent) return`. A bare
 * res.headersSent with no nearby bindRouteTarget (e.g. a body-reader guard) does
 * NOT match. Same two-way ratchet: seed [] (nothing matches after the sweep),
 * fail on any NEW occurrence, fail on a stale allowlist entry.
 */
const D021_HEADERSSENT_DISCRIMINATOR_ALLOWLIST = [];

const ROUTES_DIR = path.join(srcRoot, 'lore/src/mcp/http/routes');

/**
 * Shared ratchet: given the set of files that currently violate a route-scoped
 * sub-check and its transitional allowlist, produce (1) new-violation findings
 * and (2) stale-allowlist findings — the same two-way ratchet used by D-021(a).
 */
function ratchetRouteViolations(violatingFiles, allowlist, ruleId, token, allowlistVarName) {
    const out = [];
    for (const relPath of violatingFiles) {
        if (!allowlist.includes(relPath)) {
            out.push({ rule: ruleId, file: relPath, token });
        }
    }
    for (const entry of allowlist) {
        if (!violatingFiles.has(entry)) {
            out.push({ rule: `${ruleId}-stale-allowlist`, file: entry, token: `remove from ${allowlistVarName} — no longer violates` });
        }
    }
    return out;
}

function scanRouteRawGuardImports() {
    if (!fs.existsSync(ROUTES_DIR)) return [];
    const IMPORT_RE = /import\b[^;]*?\b(?:requireWriteToWorkspace|requireReadFromWorkspace)\b[^;]*?\bfrom\b[^;]*?['"][^'"]+['"]/;
    const violatingFiles = new Set();
    for (const abs of walk(ROUTES_DIR)) {
        if (!abs.endsWith('.ts')) continue;
        const relPath = path.relative(repoRoot, abs).replace(/\\/g, '/');
        if (/\.(test|spec)\.ts$/.test(relPath)) continue;
        const stripped = stripCommentsAndTemplates(fs.readFileSync(abs, 'utf8'));
        if (IMPORT_RE.test(stripped)) violatingFiles.add(relPath);
    }
    return ratchetRouteViolations(
        violatingFiles,
        D021_RAW_GUARD_IMPORT_ALLOWLIST,
        'workspace-confinement-no-raw-guard-import-in-route',
        'raw import of requireWriteTo/ReadFromWorkspace — route must gate via routeWorkspaceBinding.ts',
        'D021_RAW_GUARD_IMPORT_ALLOWLIST',
    );
}

function scanRouteBootDefault() {
    if (!fs.existsSync(ROUTES_DIR)) return [];
    const BOOT_DEFAULT_RE = /getActiveWorkspaceName\s*\(|detectedScope\.workspace\b/;
    const violatingFiles = new Set();
    for (const abs of walk(ROUTES_DIR)) {
        if (!abs.endsWith('.ts')) continue;
        const relPath = path.relative(repoRoot, abs).replace(/\\/g, '/');
        if (/\.(test|spec)\.ts$/.test(relPath)) continue;
        const stripped = stripCommentsAndTemplates(fs.readFileSync(abs, 'utf8'));
        if (BOOT_DEFAULT_RE.test(stripped)) violatingFiles.add(relPath);
    }
    return ratchetRouteViolations(
        violatingFiles,
        D021_BOOT_DEFAULT_ALLOWLIST,
        'workspace-confinement-no-boot-default-in-route',
        'getActiveWorkspaceName()/detectedScope.workspace — route must resolve the REQUESTED workspace',
        'D021_BOOT_DEFAULT_ALLOWLIST',
    );
}

function scanRouteHeadersSentDiscriminator() {
    if (!fs.existsSync(ROUTES_DIR)) return [];
    // Same-statement form: `bindRouteTarget(...) === null && res.headersSent`
    // (order-insensitive: also `res.headersSent && bindRouteTarget(...)`), or a
    // `res.headersSent` guard sharing a `bindRouteTarget(... === null` clause.
    const SAME_STATEMENT_RE =
        /bindRouteTarget\s*\([\s\S]*?===\s*null[\s\S]*?res\.headersSent|res\.headersSent[\s\S]{0,80}?bindRouteTarget\s*\([\s\S]*?===\s*null/;
    // Split form: a `bindRouteTarget(` occurrence followed within ~2 lines by an
    // `if (res.headersSent) return` (the separate-statement discriminator).
    const violatingFiles = new Set();
    for (const abs of walk(ROUTES_DIR)) {
        if (!abs.endsWith('.ts')) continue;
        const relPath = path.relative(repoRoot, abs).replace(/\\/g, '/');
        if (/\.(test|spec)\.ts$/.test(relPath)) continue;
        const stripped = stripCommentsAndTemplates(fs.readFileSync(abs, 'utf8'));
        if (!stripped.includes('res.headersSent')) continue; // fast-path: nothing to discriminate.
        let hit = SAME_STATEMENT_RE.test(stripped);
        if (!hit) {
            // Split form: for each `if (res.headersSent) return`, look back up to 2
            // preceding non-blank lines for a `bindRouteTarget(`. This keeps a bare
            // body-reader `if (res.headersSent) return;` (no adjacent bind) clean.
            const lines = stripped.split('\n');
            for (let i = 0; i < lines.length && !hit; i++) {
                if (!/\bif\s*\(\s*res\.headersSent\s*\)\s*return\b/.test(lines[i])) continue;
                let seen = 0;
                for (let j = i - 1; j >= 0 && seen < 2; j--) {
                    if (lines[j].trim() === '') continue;
                    seen++;
                    if (lines[j].includes('bindRouteTarget(')) { hit = true; break; }
                }
            }
        }
        if (hit) violatingFiles.add(relPath);
    }
    return ratchetRouteViolations(
        violatingFiles,
        D021_HEADERSSENT_DISCRIMINATOR_ALLOWLIST,
        'workspace-confinement-no-headerssent-discriminator-in-route',
        'res.headersSent used to discriminate a bindRouteTarget result — detect the bypass up front via isLegacyBypass()',
        'D021_HEADERSSENT_DISCRIMINATOR_ALLOWLIST',
    );
}

/**
 * D-022 (2026-08-04) — SURREALDB IS LOCAL/EMBEDDED ONLY (BSL 1.1 boundary).
 *
 * SurrealDB core is licensed BSL 1.1. Embedding it in a product is explicitly
 * permitted; offering SurrealDB itself as a hosted service is not, without a
 * commercial licence. Lore's local and embedded modes are on the permitted
 * side. A multi-tenant cloud Dataplane serving other people's data from a
 * SurrealDB we operate is exactly what BSL carves out.
 *
 * docs/SURREALDB_BUILD_PLAN.md requires this be a CODE-LEVEL guard, not prose.
 * There are two, because neither alone is sufficient: the runtime throw in
 * storage/surrealLicenceGuard.ts cannot see an import that has not run yet,
 * and a static rule cannot see a mode chosen at runtime.
 *
 * Three sub-checks:
 *   (a) No cloud-mode module may import the engine or the factory.
 *   (b) The engine may not import the cloud SDK / Dataplane surface — that
 *       would make it reachable from cloud code by transitivity, which (a)
 *       cannot see.
 *   (c) `fromSurreal` may only be CALLED from permitted (non-cloud) paths, so
 *       the licence chokepoint cannot be reached from cloud code by any route.
 */

/** Modules that are, by definition, cloud-side. */
const CLOUD_MODE_PATH_RE = /(^|\/)(dataplane[A-Za-z]*\.ts$|arcade\/|cloud[A-Za-z]*\.ts$|tsSdkAdapter\.ts$)/;

/** Cloud transports the engine must never reach for. */
const CLOUD_SDK_SPECIFIERS = ['groundfloor-ts-sdk'];

/** Where a SurrealDB-backed store may legitimately be constructed. */
const SURREAL_FACTORY_CALLERS = [
    'packages/lore/src/storage/loreStorageClient.ts', // the definition site
];

function scanSurrealLicenceBoundary() {
    const out = [];
    const surrealEngine = 'packages/lore/src/engines/surrealGraph.ts';
    const files = walk(srcRoot).concat(walk(path.join(repoRoot, 'scripts')));

    for (const abs of files) {
        if (!/\.(ts|mjs|js)$/.test(abs)) continue;
        const relPath = path.relative(repoRoot, abs).replace(/\\/g, '/');
        if (/\.(test|spec)\.ts$/.test(relPath)) continue;
        const content = fs.readFileSync(abs, 'utf8');
        const stripped = stripCommentsAndTemplates(content);

        // (b) The engine itself must stay clear of the cloud SDK.
        if (relPath === surrealEngine || relPath.startsWith('packages/lore/src/engines/surreal/')) {
            for (const spec of CLOUD_SDK_SPECIFIERS) {
                if (new RegExp(`from\\s+['"]${spec}['"]`).test(stripped)) {
                    out.push({ rule: 'surreal-local-only', file: relPath, token: `imports ${spec}` });
                }
            }
            continue;
        }

        // Deliberately matches RELATIVE specifiers too ('./surrealGraph.js'):
        // a cloud module sitting in the same directory as the engine imports it
        // relatively, which an `engines/`-anchored pattern would miss entirely.
        const touchesSurreal =
            /surrealGraph\.js|surreal\/surreal|\bfromSurreal\s*\(|\bSurrealGraph\b|surrealLicenceGuard/.test(stripped);
        if (!touchesSurreal) continue;

        // (a) Cloud-mode modules may not reference the engine at all.
        if (CLOUD_MODE_PATH_RE.test(relPath)) {
            out.push({ rule: 'surreal-local-only', file: relPath, token: 'cloud-mode module references the SurrealDB engine' });
            continue;
        }

        // (c) fromSurreal may only be called from permitted paths.
        if (/\bfromSurreal\s*\(/.test(stripped) && !SURREAL_FACTORY_CALLERS.includes(relPath)) {
            out.push({ rule: 'surreal-local-only', file: relPath, token: 'calls LoreStorageClient.fromSurreal' });
        }
    }

    // The runtime half must exist and must actually be wired into the factory —
    // a rule that only checks imports would pass happily if the throw were
    // deleted.
    const guardPath = path.join(repoRoot, 'packages/lore/src/storage/surrealLicenceGuard.ts');
    if (!fs.existsSync(guardPath)) {
        out.push({ rule: 'surreal-local-only', file: 'packages/lore/src/storage/surrealLicenceGuard.ts', token: 'runtime licence guard is missing' });
    }
    const facadePath = path.join(repoRoot, 'packages/lore/src/storage/loreStorageClient.ts');
    if (fs.existsSync(facadePath)) {
        const facade = stripCommentsAndTemplates(fs.readFileSync(facadePath, 'utf8'));
        if (/\bstatic\s+fromSurreal\s*\(/.test(facade) && !/assertSurrealLicenceBoundary\s*\(/.test(facade)) {
            out.push({ rule: 'surreal-local-only', file: 'packages/lore/src/storage/loreStorageClient.ts', token: 'fromSurreal does not call assertSurrealLicenceBoundary' });
        }
    }
    return out;
}

/**
 * D-023 (2026-08-05) — GRAPH-STORED ReBAC HAS NO PRODUCTION CONSUMERS.
 *
 * DEC-SURREAL-REBAC decided that graph-stored ReBAC (security/rebac.ts L1 +
 * security/rebacEvaluator.ts L2) stays on the legacy graph engine and is not ported to SurrealDB.
 * That decision is safe for exactly one reason: nothing in production calls it.
 *
 * The reason matters, because ReBAC anchors every query on `LoreNode` endpoint
 * ids. On a Surreal-backed workspace the legacy engine's `LoreNode` table is present and
 * EMPTY, so graph-stored ReBAC there is non-functional — reads return
 * false/[] and, before the item-A fix, `grant()` returned a phantom `true`.
 * The moment someone wires it to a route or tool, "no ACLs on a Surreal
 * workspace" stops being a documented non-issue and becomes a live hole.
 *
 * Nothing else enforces that fact, so it can rot the day someone adds an
 * import. This is a SPEED BUMP, NOT A WALL — wiring ReBAC up is a legitimate
 * future task. The rule's only job is to make sure whoever does it reads
 * DEC-SURREAL-REBAC first and revisits it deliberately.
 *
 * Comments are stripped before matching: `security/rebac.ts` and
 * `engines/scopeResolver.ts` both NAME rebacEvaluator in prose, and those are
 * not imports.
 */

/** The two modules whose consumers are being frozen. */
const D023_REBAC_MODULES = [
    'packages/lore/src/security/rebac.ts',
    'packages/lore/src/security/rebacEvaluator.ts',
];

/** importer -> the one specifier it may legitimately import. */
const D023_ALLOWED_EDGES = new Map([
    ['packages/lore/src/security/rebacEvaluator.ts', 'rebac'],
]);

/** `from '…/rebac.js'`, `import('…/rebacEvaluator.js')`, `require(…)`. Not rebacGate.js. */
const D023_IMPORT_RE = /(?:from|import|require)\s*\(?\s*['"](?:[^'"]*\/)?(rebac|rebacEvaluator)\.js['"]/g;

function scanRebacConsumers() {
    const out = [];
    const loreSrc = path.join(srcRoot, 'lore/src');

    // If the guarded modules are gone, the rule guards nothing and the decision
    // it protects is stale. Fail rather than pass vacuously.
    for (const rel of D023_REBAC_MODULES) {
        if (!fs.existsSync(path.join(repoRoot, rel))) {
            out.push({ rule: 'rebac-no-production-consumers', file: rel, token: 'guarded module no longer exists — D-023 and DEC-SURREAL-REBAC need revisiting' });
        }
    }

    for (const abs of walk(loreSrc)) {
        if (!/\.ts$/.test(abs)) continue;
        const relPath = path.relative(repoRoot, abs).replace(/\\/g, '/');
        if (/\.(test|spec)\.ts$/.test(relPath)) continue;
        if (D023_REBAC_MODULES.includes(relPath) && !D023_ALLOWED_EDGES.has(relPath)) continue;

        const stripped = stripCommentsAndTemplates(fs.readFileSync(abs, 'utf8'));
        const allowed = D023_ALLOWED_EDGES.get(relPath);
        for (const m of stripped.matchAll(D023_IMPORT_RE)) {
            const mod = m[1];
            if (mod === allowed) continue;
            out.push({ rule: 'rebac-no-production-consumers', file: relPath, token: `imports security/${mod}.js` });
        }
    }
    return out;
}

/**
 * D-024 (2026-08-06, completed 2026-08-21) — LEGACY GRAPH-ENGINE IMPORTS
 * BANNED OUTRIGHT.
 *
 * The legacy graph-engine removal finished (Phase 3d, docs/KUZU_REMOVAL.md):
 * LocalGraph and every legacy-engine-only module were deleted, and the
 * baseline below was emptied by the same change — the ratchet closed to
 * zero. What was a ratchet (a shrinking allowlist of importers) is now a
 * flat ban: any file that imports the removed `@kineviz/kuzu-lite` package
 * is a violation, no exceptions, and adding an allowlist entry requires a
 * DECISIONS.md entry first.
 */
const D024_LEGACY_ENGINE_IMPORTERS = new Set([
]);

const D024_IMPORT_RE = /from\s+['"]@kineviz\/kuzu-lite['"]/;

function scanLegacyEngineImportRatchet() {
    const out = [];
    const loreSrc = path.join(srcRoot, 'lore/src');
    const seen = new Set();

    for (const abs of walk(loreSrc)) {
        if (!/\.ts$/.test(abs)) continue;
        const relPath = path.relative(repoRoot, abs).replace(/\\/g, '/');
        if (/\.(test|spec)\.ts$/.test(relPath)) continue;
        const stripped = stripCommentsAndTemplates(fs.readFileSync(abs, 'utf8'));
        if (!D024_IMPORT_RE.test(stripped)) continue;
        seen.add(relPath);
        if (!D024_LEGACY_ENGINE_IMPORTERS.has(relPath)) {
            out.push({
                rule: 'legacy-engine-imports-ratchet',
                file: relPath,
                token: 'NEW @kineviz/kuzu-lite import — the legacy graph-engine surface may only shrink (D-024, docs/KUZU_REMOVAL.md)',
            });
        }
    }

    // Baseline entries that have been cleaned up must be removed from the set,
    // otherwise the rule silently permits a file to regain the import later.
    for (const rel of D024_LEGACY_ENGINE_IMPORTERS) {
        if (!seen.has(rel)) {
            out.push({
                rule: 'legacy-engine-imports-ratchet',
                file: rel,
                token: 'no longer imports the legacy graph engine — delete it from D024_LEGACY_ENGINE_IMPORTERS to tighten the ratchet',
            });
        }
    }
    return out;
}

/**
 * D-025 (2026-08-12) — THE INJECT HELPER IS A ONE-WAY IMPORT BOUNDARY.
 *
 * `packages/lore/src/inject/` is the context-injection helper (decision
 * `context-injection-helper-placement-2026-08-03`): an app-called library
 * layered ON TOP of Lore core — outbound retrieval (no LLM needed) plus
 * LLM-judged inbound capture (the caller supplies the LLM). It may import
 * Lore core; Lore core must NEVER import it back. That one-way boundary is
 * what keeps Lore's write path LLM-free — Lore Core never needs LLM
 * credentials to start, unlike TencentDB-Agent-Memory, which requires two
 * LLM configs just to boot because it entangled memory-write with
 * memory-judgment. inject/ is deliberately the only place in this codebase
 * that entanglement is allowed to exist.
 *
 * Much simpler than D-022: this is a one-directional layering rule, not a
 * licence boundary — there is no runtime half, a static import scan alone is
 * sufficient.
 *
 * Detector: any import/require/dynamic-import specifier, in a file under
 * `packages/lore/src/**` OUTSIDE `inject/` itself, that resolves into
 * `packages/lore/src/inject/`. Matches relative specifiers (`../inject/index.js`,
 * resolved against the importing file's own directory) AND named/absolute
 * ones (containing `/inject/`, or the package subpath `@groundfloor/lore/inject`)
 * — mirroring D-022's surreal-local-only check, which matches relative AND
 * named specifiers for the same reason: a same-directory relative import is
 * exactly the kind of thing a path-anchored regex alone would miss.
 */
const INJECT_DIR_REL = 'packages/lore/src/inject';
const INJECT_IMPORT_SPEC_RE = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;

function scanInjectBoundary() {
    const out = [];
    const loreSrc = path.join(srcRoot, 'lore/src');
    const injectDirAbs = path.join(repoRoot, INJECT_DIR_REL);
    if (!fs.existsSync(loreSrc)) return out;

    for (const abs of walk(loreSrc)) {
        if (!abs.endsWith('.ts')) continue;
        const relPath = path.relative(repoRoot, abs).replace(/\\/g, '/');
        if (relPath === INJECT_DIR_REL || relPath.startsWith(`${INJECT_DIR_REL}/`)) continue; // inject/ may import itself freely.

        const stripped = stripCommentsAndTemplates(fs.readFileSync(abs, 'utf8'));
        INJECT_IMPORT_SPEC_RE.lastIndex = 0;
        let m;
        while ((m = INJECT_IMPORT_SPEC_RE.exec(stripped)) !== null) {
            const spec = m[1];
            let touchesInject;
            if (spec.startsWith('.')) {
                // Relative specifier — resolve against the importing file's own dir.
                const resolved = path.resolve(path.dirname(abs), spec);
                touchesInject = resolved === injectDirAbs || resolved.startsWith(injectDirAbs + path.sep);
            } else {
                // Named/absolute specifier — substring match, same technique
                // D-022 uses for its named-specifier half.
                touchesInject = spec.includes('/inject/') || spec === '@groundfloor/lore/inject' || spec.endsWith('/inject');
            }
            if (touchesInject) {
                out.push({ rule: 'inject-one-way-boundary', file: relPath, token: `imports ${spec}` });
                break; // one violation per file is enough to signal.
            }
        }
    }
    return out;
}

/**
 * D-026 (2026-08-17) — SCHEMAAUTHORINGSTORE.APPROVE() HAS EXACTLY 3
 * KNOWN-SAFE CALLERS.
 *
 * This remediation (GAP 1, 2026-08-17) found the SAME underlying
 * `SchemaAuthoringStore.approve()` called from TWO separate, unprotected
 * entry points at DIFFERENT times — the HTTP route first (fixed in
 * 71e0607), then the `schema_approve` MCP tool (fixed in 4d12a8c) —
 * because nothing forced a new caller through the mandatory-HITL gate
 * (`security/schemaApprovalGate.ts`, `gateSchemaApproval`). Each was only
 * caught by a manual, one-off caller audit. This rule makes a THIRD
 * unprotected caller a build failure instead of something that waits for
 * the next manual audit.
 *
 * Every SchemaAuthoringStore holder in this codebase uses the same
 * property/variable name — `schemaAuthoring` (`PhaseAContext`,
 * `PhaseAServices`, `OrchestratorDeps`, `wiring.ts`'s `input`) — so the
 * detector keys off `schemaAuthoring.approve(` (word-boundary match, so it
 * catches both `ctx.schemaAuthoring.approve(` and a bare local variable
 * named `schemaAuthoring`). A call site matching that pattern must be one
 * of the three known-safe callers below:
 *
 *   - mcp/http/routes/schema/proposals.ts   — gated via gateSchemaApproval()
 *   - mcp/phaseATools.ts (schema_approve)   — gated via gateSchemaApproval()
 *   - schemas/orchestration/wiring.ts       — the 'schema_approve' REPLAY
 *     handler. NOT a bypass: `replayApprovedOp()` only invokes it after
 *     `pendingOpsStore.decide()` has already recorded a human decision, and
 *     the handler additionally requires `ctx.decidedBy` to start with
 *     `human:`. This is the execution step downstream of confirmation, not
 *     a second gate to duplicate.
 *
 * A NEW file matching `.schemaAuthoring.approve(` fails the build
 * regardless of whether it's actually unsafe — the point is that a 4th
 * caller can no longer land silently. Adding a legitimate one means
 * routing it through `gateSchemaApproval()` first, then adding it to
 * `D026_SCHEMA_APPROVE_ALLOWED_CALLERS` with a one-line justification, same
 * as every other allowlist in this file.
 *
 * (Textual heuristic, matching this file's other rules — not a real
 * call-graph. It keys off the `schemaAuthoring` name, which every current
 * holder uses consistently; renaming a variable specifically to dodge this
 * rule is itself exactly the kind of thing a caller audit — manual or this
 * one — exists to catch.)
 */
const D026_SCHEMA_APPROVE_ALLOWED_CALLERS = new Set([
    'packages/lore/src/mcp/http/routes/schema/proposals.ts',
    'packages/lore/src/mcp/phaseATools.ts',
    'packages/lore/src/schemas/orchestration/wiring.ts',
]);

const D026_APPROVE_CALL_RE = /\bschemaAuthoring\.approve\s*\(/;

function scanSchemaApproveCallers() {
    const out = [];
    const loreSrc = path.join(srcRoot, 'lore/src');
    const seen = new Set();

    for (const abs of walk(loreSrc)) {
        if (!abs.endsWith('.ts')) continue;
        const relPath = path.relative(repoRoot, abs).replace(/\\/g, '/');
        if (/\.(test|spec)\.ts$/.test(relPath)) continue;
        const stripped = stripCommentsAndTemplates(fs.readFileSync(abs, 'utf8'));
        if (!D026_APPROVE_CALL_RE.test(stripped)) continue;
        seen.add(relPath);
        if (!D026_SCHEMA_APPROVE_ALLOWED_CALLERS.has(relPath)) {
            out.push({
                rule: 'schema-approve-known-callers',
                file: relPath,
                token: 'NEW SchemaAuthoringStore.approve() caller — must route through security/schemaApprovalGate.ts (gateSchemaApproval) before calling .approve(), then be added to D026_SCHEMA_APPROVE_ALLOWED_CALLERS with a one-line justification (GAP 1, 2026-08-17)',
            });
        }
    }

    // Ratchet: an allowlisted file that no longer calls .approve() must be
    // removed, else a future unrelated caller could silently reuse the slot.
    for (const rel of D026_SCHEMA_APPROVE_ALLOWED_CALLERS) {
        if (!seen.has(rel)) {
            out.push({
                rule: 'schema-approve-known-callers',
                file: rel,
                token: 'no longer calls .schemaAuthoring.approve() — remove it from D026_SCHEMA_APPROVE_ALLOWED_CALLERS to tighten the guardrail',
            });
        }
    }
    return out;
}

const violations = scanAll()
    .concat(scanPluginVocab())
    .concat(scanDirectGraphUpserts())
    .concat(scanUndefinedScopeTargets())
    .concat(scanRouteRawGuardImports())
    .concat(scanRouteBootDefault())
    .concat(scanRouteHeadersSentDiscriminator())
    .concat(scanSurrealLicenceBoundary())
    .concat(scanRebacConsumers())
    .concat(scanLegacyEngineImportRatchet())
    .concat(scanInjectBoundary())
    .concat(scanSchemaApproveCallers());

if (violations.length === 0) {
    console.log('✓ Architecture test passed (no forbidden cloud-DB drivers; no plugin vocab on storage surface; no direct graph upserts outside facade; no literal-undefined workspace scope gates; no raw scope-guard imports or boot-default lookups in HTTP routes; no res.headersSent bindRouteTarget discriminators in HTTP routes; SurrealDB engine unreachable from cloud-mode code; graph-stored ReBAC has no production consumers; legacy graph-engine imports banned outright (zero baseline); inject/ import boundary is one-way; SchemaAuthoringStore.approve() has exactly the 3 known-safe callers).');
    process.exit(0);
}

console.error(`✗ Architecture test FAILED with ${violations.length} violation(s):\n`);
for (const v of violations) {
    console.error(`  [${v.rule}] ${v.file}: ${v.token}`);
}
console.error(
    '\nHow to fix:\n' +
    '  [no-direct-cloud-driver]\n' +
    '  Per D-017, cloud-DB drivers must never be imported directly.\n' +
    '  Route through groundfloor-ts-sdk / TsSdkAdapter.\n' +
    '  [no-plugin-vocab-on-storage-surface]\n' +
    '  Per D-018 (SP-14), the storage surface (contracts/ + engines/*Storage.ts)\n' +
    '  must not use plugin naming — the plugin system was removed in v3.11.0.\n' +
    '  Rename to collection/storage-context vocabulary.\n' +
    '  [no-direct-graph-upsert]\n' +
    '  Per D-019 (SP-20), graph writes (upsertNode/upsertEdge/deleteNode) must\n' +
    '  go through LoreStorageClient, not direct graph handle calls.\n' +
    '  [workspace-confinement-no-undefined-target]\n' +
    '  Per D-021 (Wave 4.1), requireWriteToWorkspace/requireReadFromWorkspace(_,\n' +
    '  undefined) always passes for the token\'s own workspace and can never\n' +
    '  confine a cross-workspace request. Resolve a concrete target and gate\n' +
    '  through security/routeWorkspaceBinding.ts (bindRouteTarget /\n' +
    '  bindDaemonOperatorLane). If the file is mid-sweep, add it to the\n' +
    '  transitional allowlist; drain the allowlist to [] by wave end.\n' +
    '  [workspace-confinement-stale-allowlist]\n' +
    '  A D-021 allowlist entry no longer contains the pattern — remove it from\n' +
    '  D021_UNDEFINED_TARGET_ALLOWLIST so the ratchet can\'t silently rot.\n' +
    '  [workspace-confinement-no-raw-guard-import-in-route]\n' +
    '  Per D-021(b), HTTP routes must not raw-import requireWriteToWorkspace /\n' +
    '  requireReadFromWorkspace — gate through security/routeWorkspaceBinding.ts\n' +
    '  (bindRouteTarget / bindDaemonOperatorLane). If mid-sweep, add the file to\n' +
    '  D021_RAW_GUARD_IMPORT_ALLOWLIST and drain it to [] by wave end.\n' +
    '  [workspace-confinement-no-boot-default-in-route]\n' +
    '  Per D-021(c), HTTP routes must not read the boot/active default via\n' +
    '  getActiveWorkspaceName() or detectedScope.workspace — resolve the REQUESTED\n' +
    '  workspace instead. If mid-sweep, add the file to D021_BOOT_DEFAULT_ALLOWLIST\n' +
    '  and drain it to [] by wave end.\n' +
    '  [workspace-confinement-no-headerssent-discriminator-in-route]\n' +
    '  Per D-021(d), HTTP routes must not use res.headersSent to tell a\n' +
    '  bindRouteTarget DENIAL (4xx already written) apart from the legacy/direct-\n' +
    '  call bypass (null, nothing written). Stub ServerResponses do not track\n' +
    '  headersSent, so a real cross-workspace 403 silently falls through. Detect\n' +
    '  the bypass up front with isLegacyBypass(requested) and skip the gate; a\n' +
    '  null return from bindRouteTarget is then unambiguously a denial → return.\n' +
    '  If mid-sweep, add the file to D021_HEADERSSENT_DISCRIMINATOR_ALLOWLIST.\n' +
    '  [surreal-local-only]\n' +
    '  Per D-022, SurrealDB core is BSL 1.1: embedding is permitted, offering it\n' +
    '  as a hosted service is not. The engine (engines/surrealGraph.ts +\n' +
    '  engines/surreal/) is LOCAL/EMBEDDED ONLY — no cloud-mode module may import\n' +
    '  it, it may not import groundfloor-ts-sdk, and fromSurreal may only be\n' +
    '  called from the storage facade. If cloud genuinely needs SurrealDB, that\n' +
    '  requires a commercial licence and an explicit decision, not an import.\n' +
    '  [rebac-no-production-consumers]\n' +
    '  Per D-023 (DEC-SURREAL-REBAC, DECISIONS.md 2026-08-05), graph-stored ReBAC\n' +
    '  (security/rebac.ts + security/rebacEvaluator.ts) has NO production\n' +
    '  consumers today, and that fact is the ONLY reason it was allowed to stay\n' +
    '  on the legacy graph engine while the graph substrate became pluggable. Every ReBAC query\n' +
    '  anchors on LoreNode endpoint ids, so on a Surreal-backed workspace — where\n' +
    "  the legacy engine's LoreNode table is present and EMPTY — it is non-functional: reads\n" +
    '  return false/[] and writes grant nothing.\n' +
    '  This is a SPEED BUMP, NOT A WALL. Wiring ReBAC up is legitimate; it just\n' +
    '  cannot happen by accident. Read DEC-SURREAL-REBAC, decide what a\n' +
    '  Surreal-backed workspace should do about ACLs, record that decision, THEN\n' +
    '  add your file to D023_ALLOWED_EDGES. Tests under test/ are unrestricted.\n' +
    '  (Note: security/rebacGate.ts is a DIFFERENT module — SpiceDB via the\n' +
    '  Dataplane SDK, no graph dependency — and is not covered by this rule.)\n' +
    '  [inject-one-way-boundary]\n' +
    '  Per D-025 (context-injection-helper-placement-2026-08-03), Lore core must\n' +
    '  NEVER import packages/lore/src/inject/ — the helper may import core, not\n' +
    '  the reverse. This keeps Lore\'s write path LLM-free. Move the dependency\n' +
    '  the other way, or the shared logic into core if it genuinely belongs there.\n' +
    '  [schema-approve-known-callers]\n' +
    '  Per D-026 (GAP 1, 2026-08-17), SchemaAuthoringStore.approve() has exactly\n' +
    '  3 known-safe callers (the HTTP route, the schema_approve MCP tool — both\n' +
    '  gated via security/schemaApprovalGate.ts\'s gateSchemaApproval — and the\n' +
    '  orchestration replay handler, safe because it only runs after\n' +
    '  pendingOpsStore.decide() already succeeded). This remediation found TWO\n' +
    '  separate unprotected callers at different times because nothing forced a\n' +
    '  new one through the gate. A NEW file calling .schemaAuthoring.approve(\n' +
    '  must call gateSchemaApproval() first, then be added to\n' +
    '  D026_SCHEMA_APPROVE_ALLOWED_CALLERS with a one-line justification.\n' +
    '  [*-stale-allowlist]\n' +
    '  The named allowlist has an entry that no longer violates — remove it so the\n' +
    '  ratchet can\'t silently rot.\n',
);
process.exit(1);
