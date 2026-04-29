/**
 * validator.ts — Pure runtime validation for plugin manifests.
 *
 * Takes a parsed-but-untrusted value (the result of YAML or JSON parsing)
 * and either returns a `ValidatedManifest` or throws `ManifestValidationError`
 * with every issue it found.
 *
 * Design choices:
 *
 *   - **Collect-all, throw-once.** Callers see every problem in a single
 *     run rather than re-running after each fix. Matches TypeScript's
 *     own diagnostic UX.
 *
 *   - **TypeScript types are canonical.** The Tauri shell's Rust loader
 *     deliberately stops at coarse checks (parse + required fields + ≥1
 *     primitive) and defers the rest here — see the comment in
 *     `apps/lore-shell/src-tauri/src/manifest.rs`. This file is the
 *     stricter layer the Rust loader expects.
 *
 *   - **Unknown fields warn-and-strip, don't error.** v1 manifests can
 *     carry unknown top-level keys without rejecting (forward-compat
 *     headroom for v2 spec additions). The validator records a
 *     warning issue but still returns a ValidatedManifest. Callers
 *     decide whether to display warnings.
 *
 *   - **Permission strings are validated for shape, not contents.** The
 *     spec says namespaces (`fs:`, `net:`, `credentials:`, …) live in
 *     the shell's permission registry. We check the format here; the
 *     shell rejects unknown namespaces at install time.
 *
 * The function is pure — no IO, no globals, deterministic.
 */

import type {
    PluginManifest,
    ValidatedManifest,
    LoreContribution,
    DEFContribution,
    InspectorPanel,
    InspectorColumn,
    InspectorFilter,
    InspectorSort,
    AgentDescriptor,
    ScheduledTaskDescriptor,
    ScheduledTaskTrigger,
    EngineRequirements,
    Permission,
} from '../manifest.js';
import { ManifestValidationError, type ManifestValidationIssue } from './errors.js';

const SUPPORTED_MANIFEST_VERSIONS = [1] as const;
const KEBAB_CASE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const SEMVER_LOOSE = /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/;
const PERMISSION_FORMAT = /^[a-z][a-z0-9-]*(?::[^:]+)+$|^[a-z][a-z0-9-]*$/;
const VALID_INSPECTOR_KINDS = ['table', 'graph', 'timeline', 'document'] as const;
const VALID_COLUMN_TYPES = ['string', 'number', 'date', 'boolean', 'tags'] as const;
const VALID_FILTER_KINDS = ['text', 'number', 'date-range', 'select', 'multi-select', 'boolean'] as const;
const VALID_TRIGGER_KINDS = ['cron', 'event', 'manual'] as const;

const KNOWN_TOP_LEVEL = new Set([
    'manifestVersion', 'name', 'version', 'description',
    'author', 'license', 'homepage',
    'lore', 'def', 'engines',
]);
const KNOWN_LORE_KEYS = new Set(['module', 'schema', 'inspectors', 'permissions', 'ingest', 'queries', 'settings']);
const VALID_SETTINGS_FIELD_TYPES = ['string', 'number', 'boolean', 'secret'] as const;
const VALID_INGEST_SOURCES = ['csv', 'json', 'http'] as const;
const VALID_AUTH_KINDS = ['none', 'bearer', 'header', 'basic'] as const;
const VALID_PAGINATION_KINDS = ['none', 'page', 'cursor'] as const;
const VALID_HTTP_METHODS = ['GET', 'POST'] as const;
const VALID_ID_STRATEGY_KINDS = ['column', 'hash'] as const;
const VALID_FIELD_KEYS = new Set(['label', 'content', 'project', 'ecosystem', 'language', 'tags']);
const VALID_QUERY_PARAM_TYPES = ['string', 'number', 'boolean'] as const;
const QUERY_ID_FORMAT = /^[a-z][a-z0-9_]*$/;
const PARAM_NAME_FORMAT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const SCHEMA_NAME_FORMAT = /^[a-z][a-z0-9_]*$/;
const KNOWN_DEF_KEYS = new Set(['required', 'agents', 'scheduledTasks', 'permissions']);
const KNOWN_ENGINES_KEYS = new Set(['lore', 'def']);

/**
 * Validate a manifest. Returns the value cast to `ValidatedManifest` if
 * every check passes; throws `ManifestValidationError` with the full
 * issue list otherwise.
 *
 * The optional `warnings` out-array, if provided, receives any
 * non-fatal issues (currently: unknown fields). When omitted, warnings
 * are silently dropped.
 */
export function validateManifest(
    raw: unknown,
    warnings?: ManifestValidationIssue[],
): ValidatedManifest {
    const errors: ManifestValidationIssue[] = [];
    const warns: ManifestValidationIssue[] = warnings ?? [];

    if (!isPlainObject(raw)) {
        errors.push({ path: '', message: 'manifest must be an object at the top level' });
        throw new ManifestValidationError(errors);
    }

    // ── Required identity fields ────────────────────────────────
    const m = raw as Record<string, unknown>;

    if (typeof m['manifestVersion'] !== 'number') {
        errors.push({ path: 'manifestVersion', message: 'required, must be a number' });
    } else if (!SUPPORTED_MANIFEST_VERSIONS.includes(m['manifestVersion'] as 1)) {
        errors.push({
            path: 'manifestVersion',
            message: `unsupported version ${m['manifestVersion']} — supported: ${SUPPORTED_MANIFEST_VERSIONS.join(', ')}`,
        });
    }

    requireString(m, 'name', errors);
    if (typeof m['name'] === 'string' && !KEBAB_CASE.test(m['name'])) {
        errors.push({
            path: 'name',
            message: `must be kebab-case (lowercase, alphanumerics, hyphens), got "${m['name']}"`,
        });
    }

    requireString(m, 'version', errors);
    if (typeof m['version'] === 'string' && !SEMVER_LOOSE.test(m['version'])) {
        errors.push({
            path: 'version',
            message: `must be a valid semver string, got "${m['version']}"`,
        });
    }

    requireString(m, 'description', errors);

    // ── Optional identity fields ────────────────────────────────
    optionalString(m, 'author', errors);
    optionalString(m, 'license', errors);
    optionalString(m, 'homepage', errors);

    // ── At least one primitive contribution ─────────────────────
    const hasLore = m['lore'] !== undefined;
    const hasDef = m['def'] !== undefined;
    if (!hasLore && !hasDef) {
        errors.push({
            path: '',
            message: 'manifest must declare at least one of `lore` or `def`',
        });
    }

    // ── Lore contribution ───────────────────────────────────────
    if (hasLore) {
        validateLoreContribution(m['lore'], 'lore', errors, warns);
    }

    // ── DEF contribution ────────────────────────────────────────
    if (hasDef) {
        validateDefContribution(m['def'], 'def', errors, warns);
    }

    // ── Engines ─────────────────────────────────────────────────
    if (m['engines'] !== undefined) {
        validateEngines(m['engines'], 'engines', errors, warns);
    }

    // ── Unknown top-level keys (warn-and-strip) ─────────────────
    for (const key of Object.keys(m)) {
        if (!KNOWN_TOP_LEVEL.has(key)) {
            warns.push({
                path: key,
                message: `unknown top-level field; ignored (manifestVersion=1 stripping)`,
            });
        }
    }

    if (errors.length > 0) {
        throw new ManifestValidationError(errors);
    }

    // Cast through `unknown` because `Record<string, unknown>` doesn't
    // structurally satisfy `ValidatedManifest` from TypeScript's POV —
    // we've validated structurally at runtime, the type system can't see it.
    return raw as unknown as ValidatedManifest;
}

// ────────────────────────────────────────────────────────────────────────
// Section validators
// ────────────────────────────────────────────────────────────────────────

function validateLoreContribution(
    raw: unknown,
    path: string,
    errors: ManifestValidationIssue[],
    warns: ManifestValidationIssue[],
): void {
    if (!isPlainObject(raw)) {
        errors.push({ path, message: 'must be an object' });
        return;
    }
    const c = raw as Record<string, unknown>;

    // module + schema are both optional individually, but at least one must
    // be present so the daemon has SOMETHING to load (a JS module or a
    // synthesised Tier-1 plugin from the schema block).
    const hasModule = c['module'] !== undefined;
    const hasSchema = c['schema'] !== undefined;
    if (!hasModule && !hasSchema) {
        errors.push({
            path,
            message: 'must declare at least one of `module` (TypeScript plugin) or `schema` (Tier 1 declarative plugin)',
        });
    }

    if (hasModule) {
        if (typeof c['module'] !== 'string' || (c['module'] as string).length === 0) {
            errors.push({ path: `${path}.module`, message: 'must be a non-empty string when present' });
        }
    }

    if (hasSchema) {
        validateLoreSchema(c['schema'], `${path}.schema`, errors, warns);
    }

    if (c['ingest'] !== undefined) {
        if (!Array.isArray(c['ingest'])) {
            errors.push({ path: `${path}.ingest`, message: 'must be an array' });
        } else {
            const declaredNodeTypes = collectDeclaredNodeTypes(c['schema']);
            (c['ingest'] as unknown[]).forEach((entry, i) => {
                validateIngestSpec(entry, `${path}.ingest[${i}]`, declaredNodeTypes, errors);
            });
        }
    }

    if (c['queries'] !== undefined) {
        if (!Array.isArray(c['queries'])) {
            errors.push({ path: `${path}.queries`, message: 'must be an array' });
        } else {
            const seen = new Set<string>();
            const declaredNodeTypes = collectDeclaredNodeTypes(c['schema']);
            (c['queries'] as unknown[]).forEach((entry, i) => {
                validateQuerySpec(entry, `${path}.queries[${i}]`, declaredNodeTypes, errors);
                if (isPlainObject(entry) && typeof entry['id'] === 'string') {
                    if (seen.has(entry['id'])) {
                        errors.push({
                            path: `${path}.queries[${i}].id`,
                            message: `duplicate query id "${entry['id']}" within this manifest`,
                        });
                    }
                    seen.add(entry['id']);
                }
            });
        }
    }

    if (c['settings'] !== undefined) {
        if (!Array.isArray(c['settings'])) {
            errors.push({ path: `${path}.settings`, message: 'must be an array' });
        } else {
            const seen = new Set<string>();
            (c['settings'] as unknown[]).forEach((entry, i) => {
                if (!isPlainObject(entry)) {
                    errors.push({ path: `${path}.settings[${i}]`, message: 'must be an object' });
                    return;
                }
                const e = entry as Record<string, unknown>;
                requireString(e, 'name', errors, `${path}.settings[${i}].name`);
                requireString(e, 'label', errors, `${path}.settings[${i}].label`);
                requireString(e, 'description', errors, `${path}.settings[${i}].description`);
                if (typeof e['type'] !== 'string' ||
                    !VALID_SETTINGS_FIELD_TYPES.includes(e['type'] as typeof VALID_SETTINGS_FIELD_TYPES[number])) {
                    errors.push({
                        path: `${path}.settings[${i}].type`,
                        message: `expected ${VALID_SETTINGS_FIELD_TYPES.map((t) => `'${t}'`).join(' | ')}, got ${JSON.stringify(e['type'])}`,
                    });
                }
                if (e['required'] !== undefined && typeof e['required'] !== 'boolean') {
                    errors.push({ path: `${path}.settings[${i}].required`, message: 'must be a boolean when present' });
                }
                if (typeof e['name'] === 'string') {
                    if (seen.has(e['name'])) {
                        errors.push({
                            path: `${path}.settings[${i}].name`,
                            message: `duplicate setting name "${e['name']}"`,
                        });
                    }
                    seen.add(e['name']);
                }
            });
        }
    }

    if (c['inspectors'] !== undefined) {
        if (!Array.isArray(c['inspectors'])) {
            errors.push({ path: `${path}.inspectors`, message: 'must be an array' });
        } else {
            (c['inspectors'] as unknown[]).forEach((entry, i) => {
                validateInspectorPanel(entry, `${path}.inspectors[${i}]`, errors);
            });
        }
    }

    if (c['permissions'] !== undefined) {
        validatePermissions(c['permissions'], `${path}.permissions`, errors);
    }

    for (const key of Object.keys(c)) {
        if (!KNOWN_LORE_KEYS.has(key)) {
            warns.push({ path: `${path}.${key}`, message: 'unknown field; ignored' });
        }
    }
}

function validateLoreSchema(
    raw: unknown,
    path: string,
    errors: ManifestValidationIssue[],
    warns: ManifestValidationIssue[],
): void {
    if (!isPlainObject(raw)) {
        errors.push({ path, message: 'must be an object' });
        return;
    }
    const s = raw as Record<string, unknown>;

    if (s['nodeTypes'] !== undefined) {
        if (!Array.isArray(s['nodeTypes'])) {
            errors.push({ path: `${path}.nodeTypes`, message: 'must be an array' });
        } else {
            const seen = new Set<string>();
            (s['nodeTypes'] as unknown[]).forEach((entry, i) => {
                validateSchemaEntry(entry, `${path}.nodeTypes[${i}]`, errors);
                if (isPlainObject(entry) && typeof entry['name'] === 'string') {
                    if (seen.has(entry['name'])) {
                        errors.push({
                            path: `${path}.nodeTypes[${i}].name`,
                            message: `duplicate node type "${entry['name']}" within this manifest`,
                        });
                    }
                    seen.add(entry['name']);
                }
            });
        }
    }

    if (s['edgeRelations'] !== undefined) {
        if (!Array.isArray(s['edgeRelations'])) {
            errors.push({ path: `${path}.edgeRelations`, message: 'must be an array' });
        } else {
            const seen = new Set<string>();
            (s['edgeRelations'] as unknown[]).forEach((entry, i) => {
                validateSchemaEntry(entry, `${path}.edgeRelations[${i}]`, errors);
                if (isPlainObject(entry) && typeof entry['name'] === 'string') {
                    if (seen.has(entry['name'])) {
                        errors.push({
                            path: `${path}.edgeRelations[${i}].name`,
                            message: `duplicate edge relation "${entry['name']}" within this manifest`,
                        });
                    }
                    seen.add(entry['name']);
                }
            });
        }
    }

    // Reject the empty schema object — declaring `schema: {}` is almost
    // certainly a copy-paste mistake. Require at least one of the two
    // arrays (each may still be an empty array, which is fine).
    if (s['nodeTypes'] === undefined && s['edgeRelations'] === undefined) {
        warns.push({
            path,
            message: 'schema declares neither nodeTypes nor edgeRelations; the plugin will contribute nothing',
        });
    }

    const KNOWN_SCHEMA_KEYS = new Set(['nodeTypes', 'edgeRelations']);
    for (const key of Object.keys(s)) {
        if (!KNOWN_SCHEMA_KEYS.has(key)) {
            warns.push({ path: `${path}.${key}`, message: 'unknown field; ignored' });
        }
    }
}

function validateSchemaEntry(
    raw: unknown,
    path: string,
    errors: ManifestValidationIssue[],
): void {
    if (!isPlainObject(raw)) {
        errors.push({ path, message: 'must be an object' });
        return;
    }
    const e = raw as Record<string, unknown>;
    requireString(e, 'name', errors, `${path}.name`);
    requireString(e, 'description', errors, `${path}.description`);
    if (typeof e['name'] === 'string' && !SCHEMA_NAME_FORMAT.test(e['name'])) {
        errors.push({
            path: `${path}.name`,
            message: `must be lowercase letters/digits/underscores starting with a letter, got "${e['name']}"`,
        });
    }
}

function validateQuerySpec(
    raw: unknown,
    path: string,
    declaredNodeTypes: Set<string>,
    errors: ManifestValidationIssue[],
): void {
    if (!isPlainObject(raw)) {
        errors.push({ path, message: 'must be an object' });
        return;
    }
    const q = raw as Record<string, unknown>;

    requireString(q, 'id', errors, `${path}.id`);
    if (typeof q['id'] === 'string' && !QUERY_ID_FORMAT.test(q['id'])) {
        errors.push({
            path: `${path}.id`,
            message: `must be lowercase letters/digits/underscores starting with a letter, got "${q['id']}"`,
        });
    }

    requireString(q, 'description', errors, `${path}.description`);

    const hasCypher = q['cypher'] !== undefined;
    const hasPattern = q['pattern'] !== undefined;
    if (hasCypher && hasPattern) {
        errors.push({
            path,
            message: 'declare exactly one of `cypher` (raw form) or `pattern` (stock form), not both',
        });
        return;
    }
    if (!hasCypher && !hasPattern) {
        errors.push({
            path,
            message: 'must declare either `cypher` (raw form) or `pattern` (stock form)',
        });
        return;
    }

    // Validate declared parameters first; both forms need them.
    const declared = new Set<string>();
    const declaredTypes = new Map<string, 'string' | 'number' | 'boolean'>();
    if (q['parameters'] !== undefined) {
        if (!Array.isArray(q['parameters'])) {
            errors.push({ path: `${path}.parameters`, message: 'must be an array when present' });
        } else {
            (q['parameters'] as unknown[]).forEach((entry, i) => {
                validateQueryParameter(entry, `${path}.parameters[${i}]`, errors);
                if (isPlainObject(entry) && typeof entry['name'] === 'string') {
                    if (declared.has(entry['name'])) {
                        errors.push({
                            path: `${path}.parameters[${i}].name`,
                            message: `duplicate parameter "${entry['name']}" within this query`,
                        });
                    }
                    declared.add(entry['name']);
                    if (typeof entry['type'] === 'string') {
                        declaredTypes.set(entry['name'], entry['type'] as 'string' | 'number' | 'boolean');
                    }
                }
            });
        }
    }

    if (hasCypher) {
        // Raw cypher form: must be a non-empty string + cross-check $params.
        if (typeof q['cypher'] !== 'string' || (q['cypher'] as string).length === 0) {
            errors.push({ path: `${path}.cypher`, message: 'must be a non-empty string' });
        } else {
            const referenced = new Set<string>();
            const re = /\$([a-zA-Z_][a-zA-Z0-9_]*)/g;
            let m: RegExpExecArray | null;
            while ((m = re.exec(q['cypher'] as string)) !== null) {
                referenced.add(m[1]!);
            }
            for (const ref of referenced) {
                if (!declared.has(ref)) {
                    errors.push({
                        path: `${path}.cypher`,
                        message: `references parameter "$${ref}" not declared in parameters[]`,
                    });
                }
            }
        }
    } else {
        // Stock-pattern form.
        if (typeof q['pattern'] !== 'string' || (q['pattern'] as string).length === 0) {
            errors.push({ path: `${path}.pattern`, message: 'must be a non-empty string' });
        }
        if (typeof q['bindNodeType'] !== 'string' || (q['bindNodeType'] as string).length === 0) {
            errors.push({ path: `${path}.bindNodeType`, message: 'required when using `pattern` form' });
        } else if (declaredNodeTypes.size > 0 && !declaredNodeTypes.has(q['bindNodeType'] as string)) {
            errors.push({
                path: `${path}.bindNodeType`,
                message: `references node type "${q['bindNodeType']}" which is not declared in lore.schema.nodeTypes`,
            });
        }
        // Best-effort: if the pattern name is known, surface required-parameter
        // mismatches at validate time (don't import expandPattern to avoid a
        // cycle; do a lightweight catalog lookup inline).
        const patternName = q['pattern'];
        if (typeof patternName === 'string') {
            const required = STOCK_PATTERN_REQS[patternName];
            if (!required) {
                errors.push({
                    path: `${path}.pattern`,
                    message: `unknown stock pattern "${patternName}" — known: ${Object.keys(STOCK_PATTERN_REQS).sort().join(', ')}`,
                });
            } else {
                for (const r of required) {
                    if (!declared.has(r.name)) {
                        errors.push({
                            path: `${path}.parameters`,
                            message: `pattern "${patternName}" requires parameter "${r.name}" (${r.type}); not declared`,
                        });
                    } else if (declaredTypes.get(r.name) !== r.type) {
                        errors.push({
                            path: `${path}.parameters`,
                            message: `pattern "${patternName}" requires parameter "${r.name}" of type ${r.type}, got ${declaredTypes.get(r.name)}`,
                        });
                    }
                }
            }
        }
    }
}

/**
 * Lightweight mirror of the stock pattern catalog's required-parameter
 * shape. Kept in sync with `manifest/queryPatterns.ts` STOCK_PATTERNS;
 * NOT imported from there to avoid pulling Cypher templates into the
 * validator's bundle. CI's reference-manifest tests catch drift.
 */
const STOCK_PATTERN_REQS: Record<string, Array<{ name: string; type: 'string' | 'number' | 'boolean' }>> = {
    find_by_field: [{ name: 'field', type: 'string' }, { name: 'value', type: 'string' }],
    find_by_tag_substring: [{ name: 'tag', type: 'string' }],
    count_by_field: [{ name: 'field', type: 'string' }, { name: 'value', type: 'string' }],
    list_recent: [{ name: 'limit', type: 'number' }],
};

function validateQueryParameter(
    raw: unknown,
    path: string,
    errors: ManifestValidationIssue[],
): void {
    if (!isPlainObject(raw)) {
        errors.push({ path, message: 'must be an object' });
        return;
    }
    const p = raw as Record<string, unknown>;
    requireString(p, 'name', errors, `${path}.name`);
    if (typeof p['name'] === 'string' && !PARAM_NAME_FORMAT.test(p['name'])) {
        errors.push({
            path: `${path}.name`,
            message: `must match /^[a-zA-Z_][a-zA-Z0-9_]*$/, got "${p['name']}"`,
        });
    }
    if (typeof p['type'] !== 'string' || !VALID_QUERY_PARAM_TYPES.includes(p['type'] as typeof VALID_QUERY_PARAM_TYPES[number])) {
        errors.push({
            path: `${path}.type`,
            message: `expected ${VALID_QUERY_PARAM_TYPES.map((t) => `'${t}'`).join(' | ')}, got ${JSON.stringify(p['type'])}`,
        });
    }
    requireString(p, 'description', errors, `${path}.description`);
    if (p['required'] !== undefined && typeof p['required'] !== 'boolean') {
        errors.push({ path: `${path}.required`, message: 'must be a boolean when present' });
    }
}

function collectDeclaredNodeTypes(schema: unknown): Set<string> {
    const out = new Set<string>();
    if (!isPlainObject(schema)) return out;
    const nt = (schema as Record<string, unknown>)['nodeTypes'];
    if (!Array.isArray(nt)) return out;
    for (const entry of nt as unknown[]) {
        if (isPlainObject(entry) && typeof entry['name'] === 'string') {
            out.add(entry['name']);
        }
    }
    return out;
}

function validateIngestSpec(
    raw: unknown,
    path: string,
    declaredNodeTypes: Set<string>,
    errors: ManifestValidationIssue[],
): void {
    if (!isPlainObject(raw)) {
        errors.push({ path, message: 'must be an object' });
        return;
    }
    const s = raw as Record<string, unknown>;

    if (s['id'] !== undefined && typeof s['id'] !== 'string') {
        errors.push({ path: `${path}.id`, message: 'must be a string when present' });
    }

    const source = s['source'];
    if (typeof source !== 'string' || !VALID_INGEST_SOURCES.includes(source as typeof VALID_INGEST_SOURCES[number])) {
        errors.push({
            path: `${path}.source`,
            message: `expected ${VALID_INGEST_SOURCES.map((k) => `'${k}'`).join(' | ')}, got ${JSON.stringify(source)}`,
        });
    }

    // Source-specific shape checks.
    if (source === 'csv' || source === 'json') {
        requireString(s, 'file', errors, `${path}.file`);
    } else if (source === 'http') {
        requireString(s, 'url', errors, `${path}.url`);
        if (s['method'] !== undefined && !VALID_HTTP_METHODS.includes(s['method'] as typeof VALID_HTTP_METHODS[number])) {
            errors.push({ path: `${path}.method`, message: `expected one of ${VALID_HTTP_METHODS.join(' | ')}, got ${JSON.stringify(s['method'])}` });
        }
        if (s['auth'] !== undefined) validateIngestAuth(s['auth'], `${path}.auth`, errors);
        if (s['pagination'] !== undefined) validateIngestPagination(s['pagination'], `${path}.pagination`, errors);
        if (s['responsePath'] !== undefined && typeof s['responsePath'] !== 'string') {
            errors.push({ path: `${path}.responsePath`, message: 'must be a string when present' });
        }
        if (s['headers'] !== undefined && (typeof s['headers'] !== 'object' || s['headers'] === null || Array.isArray(s['headers']))) {
            errors.push({ path: `${path}.headers`, message: 'must be an object of header-name → value strings' });
        }
        // Cross-check URL placeholders against declared `vars`.
        if (typeof s['url'] === 'string' && Array.isArray(s['vars'])) {
            const declaredVarNames = new Set(
                (s['vars'] as unknown[])
                    .filter((v): v is { name: string } => isPlainObject(v) && typeof (v as Record<string, unknown>)['name'] === 'string')
                    .map((v) => v.name),
            );
            const refs = (s['url'].match(/\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g) ?? []).map((m) => m.slice(2, -2));
            for (const r of refs) {
                if (!declaredVarNames.has(r)) {
                    errors.push({ path: `${path}.url`, message: `references {{${r}}} not declared in vars[]` });
                }
            }
        }
    }

    const mapTo = s['mapTo'];
    if (typeof mapTo !== 'string' || mapTo.length === 0) {
        errors.push({ path: `${path}.mapTo`, message: 'required, must be a non-empty string' });
    } else if (declaredNodeTypes.size > 0 && !declaredNodeTypes.has(mapTo)) {
        errors.push({
            path: `${path}.mapTo`,
            message: `references node type "${mapTo}" which is not declared in lore.schema.nodeTypes`,
        });
    }

    validateIdStrategy(s['idStrategy'], `${path}.idStrategy`, errors);
    validateFieldMap(s['fields'], `${path}.fields`, errors);

    if (s['delimiter'] !== undefined) {
        if (typeof s['delimiter'] !== 'string' || (s['delimiter'] as string).length !== 1) {
            errors.push({ path: `${path}.delimiter`, message: 'must be a single character when present' });
        }
    }
    if (s['tagDelimiter'] !== undefined) {
        if (typeof s['tagDelimiter'] !== 'string' || (s['tagDelimiter'] as string).length === 0) {
            errors.push({ path: `${path}.tagDelimiter`, message: 'must be a non-empty string when present' });
        }
    }
}

function validateIngestAuth(
    raw: unknown,
    path: string,
    errors: ManifestValidationIssue[],
): void {
    if (!isPlainObject(raw)) {
        errors.push({ path, message: 'must be an object' });
        return;
    }
    const a = raw as Record<string, unknown>;
    const kind = a['kind'];
    if (typeof kind !== 'string' || !VALID_AUTH_KINDS.includes(kind as typeof VALID_AUTH_KINDS[number])) {
        errors.push({ path: `${path}.kind`, message: `expected one of ${VALID_AUTH_KINDS.join(' | ')}, got ${JSON.stringify(kind)}` });
        return;
    }
    if (kind === 'bearer' || kind === 'basic') {
        requireString(a, 'credentialKey', errors, `${path}.credentialKey`);
    }
    if (kind === 'header') {
        requireString(a, 'headerName', errors, `${path}.headerName`);
        requireString(a, 'credentialKey', errors, `${path}.credentialKey`);
    }
}

function validateIngestPagination(
    raw: unknown,
    path: string,
    errors: ManifestValidationIssue[],
): void {
    if (!isPlainObject(raw)) {
        errors.push({ path, message: 'must be an object' });
        return;
    }
    const p = raw as Record<string, unknown>;
    const kind = p['kind'];
    if (typeof kind !== 'string' || !VALID_PAGINATION_KINDS.includes(kind as typeof VALID_PAGINATION_KINDS[number])) {
        errors.push({ path: `${path}.kind`, message: `expected one of ${VALID_PAGINATION_KINDS.join(' | ')}, got ${JSON.stringify(kind)}` });
        return;
    }
    if (kind === 'page') {
        requireString(p, 'pageParam', errors, `${path}.pageParam`);
        if (p['sizeParam'] !== undefined && typeof p['sizeParam'] !== 'string') {
            errors.push({ path: `${path}.sizeParam`, message: 'must be a string when present' });
        }
        if (p['pageSize'] !== undefined && typeof p['pageSize'] !== 'number') {
            errors.push({ path: `${path}.pageSize`, message: 'must be a number when present' });
        }
        if (p['maxPages'] !== undefined && typeof p['maxPages'] !== 'number') {
            errors.push({ path: `${path}.maxPages`, message: 'must be a number when present' });
        }
    }
    if (kind === 'cursor') {
        requireString(p, 'cursorPathInResponse', errors, `${path}.cursorPathInResponse`);
        requireString(p, 'cursorParam', errors, `${path}.cursorParam`);
        if (p['maxRequests'] !== undefined && typeof p['maxRequests'] !== 'number') {
            errors.push({ path: `${path}.maxRequests`, message: 'must be a number when present' });
        }
    }
}

function validateIdStrategy(
    raw: unknown,
    path: string,
    errors: ManifestValidationIssue[],
): void {
    if (!isPlainObject(raw)) {
        errors.push({ path, message: 'required, must be an object' });
        return;
    }
    const s = raw as Record<string, unknown>;
    const kind = s['kind'];
    if (typeof kind !== 'string' || !VALID_ID_STRATEGY_KINDS.includes(kind as typeof VALID_ID_STRATEGY_KINDS[number])) {
        errors.push({
            path: `${path}.kind`,
            message: `expected ${VALID_ID_STRATEGY_KINDS.map((k) => `'${k}'`).join(' | ')}, got ${JSON.stringify(kind)}`,
        });
        return;
    }
    if (kind === 'column') {
        requireString(s, 'column', errors, `${path}.column`);
    }
    if (kind === 'hash') {
        if (!Array.isArray(s['columns']) || (s['columns'] as unknown[]).length === 0) {
            errors.push({ path: `${path}.columns`, message: 'required for `kind: "hash"`, must be a non-empty string array' });
        } else if (!(s['columns'] as unknown[]).every((c) => typeof c === 'string')) {
            errors.push({ path: `${path}.columns`, message: 'every entry must be a string column name' });
        }
        if (s['algo'] !== undefined && s['algo'] !== 'sha1') {
            errors.push({ path: `${path}.algo`, message: `only 'sha1' is supported, got ${JSON.stringify(s['algo'])}` });
        }
    }
}

function validateFieldMap(
    raw: unknown,
    path: string,
    errors: ManifestValidationIssue[],
): void {
    if (!isPlainObject(raw)) {
        errors.push({ path, message: 'required, must be an object mapping LoreNode field → source column' });
        return;
    }
    const f = raw as Record<string, unknown>;
    if (Object.keys(f).length === 0) {
        errors.push({ path, message: 'must declare at least one field mapping' });
        return;
    }
    for (const [key, val] of Object.entries(f)) {
        if (!VALID_FIELD_KEYS.has(key)) {
            errors.push({
                path: `${path}.${key}`,
                message: `unknown LoreNode field; valid fields: ${[...VALID_FIELD_KEYS].sort().join(', ')}`,
            });
            continue;
        }
        if (typeof val !== 'string' || val.length === 0) {
            errors.push({ path: `${path}.${key}`, message: 'must be a non-empty source column name' });
        }
    }
}

function validateInspectorPanel(
    raw: unknown,
    path: string,
    errors: ManifestValidationIssue[],
): void {
    if (!isPlainObject(raw)) {
        errors.push({ path, message: 'must be an object' });
        return;
    }
    const p = raw as Record<string, unknown>;

    requireString(p, 'id', errors, `${path}.id`);
    requireString(p, 'label', errors, `${path}.label`);
    if (p['icon'] !== undefined && typeof p['icon'] !== 'string') {
        errors.push({ path: `${path}.icon`, message: 'must be a string when present' });
    }

    const kind = p['kind'];
    if (typeof kind !== 'string') {
        errors.push({ path: `${path}.kind`, message: 'required, must be a string' });
        return;
    }
    if (!VALID_INSPECTOR_KINDS.includes(kind as typeof VALID_INSPECTOR_KINDS[number])) {
        errors.push({
            path: `${path}.kind`,
            message: `expected ${VALID_INSPECTOR_KINDS.map((k) => `'${k}'`).join(' | ')}, got '${kind}'`,
        });
        return;
    }

    switch (kind) {
        case 'table':
            requireString(p, 'entity', errors, `${path}.entity`);
            if (!Array.isArray(p['columns'])) {
                errors.push({ path: `${path}.columns`, message: 'required, must be an array' });
            } else {
                (p['columns'] as unknown[]).forEach((c, i) => {
                    validateColumn(c, `${path}.columns[${i}]`, errors);
                });
            }
            if (p['sort'] !== undefined) validateSort(p['sort'], `${path}.sort`, errors);
            if (p['filters'] !== undefined) {
                if (!Array.isArray(p['filters'])) {
                    errors.push({ path: `${path}.filters`, message: 'must be an array when present' });
                } else {
                    (p['filters'] as unknown[]).forEach((f, i) => {
                        validateFilter(f, `${path}.filters[${i}]`, errors);
                    });
                }
            }
            if (p['drilldown'] !== undefined) {
                validateInspectorPanel(p['drilldown'], `${path}.drilldown`, errors);
            }
            break;
        case 'graph':
            requireString(p, 'entity', errors, `${path}.entity`);
            if (p['depth'] !== undefined && typeof p['depth'] !== 'number') {
                errors.push({ path: `${path}.depth`, message: 'must be a number when present' });
            }
            if (p['edgeTypes'] !== undefined) {
                if (!Array.isArray(p['edgeTypes']) ||
                    !(p['edgeTypes'] as unknown[]).every((s) => typeof s === 'string')) {
                    errors.push({ path: `${path}.edgeTypes`, message: 'must be an array of strings' });
                }
            }
            break;
        case 'timeline':
            requireString(p, 'entity', errors, `${path}.entity`);
            requireString(p, 'dateField', errors, `${path}.dateField`);
            requireString(p, 'labelField', errors, `${path}.labelField`);
            if (p['groupBy'] !== undefined && typeof p['groupBy'] !== 'string') {
                errors.push({ path: `${path}.groupBy`, message: 'must be a string when present' });
            }
            break;
        case 'document':
            requireString(p, 'labelField', errors, `${path}.labelField`);
            requireString(p, 'contentField', errors, `${path}.contentField`);
            break;
    }
}

function validateColumn(
    raw: unknown,
    path: string,
    errors: ManifestValidationIssue[],
): void {
    if (!isPlainObject(raw)) {
        errors.push({ path, message: 'must be an object' });
        return;
    }
    const c = raw as Record<string, unknown>;
    requireString(c, 'field', errors, `${path}.field`);
    requireString(c, 'label', errors, `${path}.label`);

    const hasWidth = c['width'] !== undefined;
    const hasFlex = c['flex'] !== undefined;
    if (hasWidth && hasFlex) {
        errors.push({ path, message: '`width` and `flex` are mutually exclusive' });
    }
    if (hasWidth && typeof c['width'] !== 'number') {
        errors.push({ path: `${path}.width`, message: 'must be a number when present' });
    }
    if (hasFlex && typeof c['flex'] !== 'number') {
        errors.push({ path: `${path}.flex`, message: 'must be a number when present' });
    }
    if (c['type'] !== undefined) {
        const t = c['type'];
        if (typeof t !== 'string' || !VALID_COLUMN_TYPES.includes(t as typeof VALID_COLUMN_TYPES[number])) {
            errors.push({
                path: `${path}.type`,
                message: `expected ${VALID_COLUMN_TYPES.map((k) => `'${k}'`).join(' | ')}, got ${JSON.stringify(t)}`,
            });
        }
    }
}

function validateSort(
    raw: unknown,
    path: string,
    errors: ManifestValidationIssue[],
): void {
    if (!isPlainObject(raw)) {
        errors.push({ path, message: 'must be an object' });
        return;
    }
    const s = raw as Record<string, unknown>;
    requireString(s, 'field', errors, `${path}.field`);
    if (s['order'] !== 'asc' && s['order'] !== 'desc') {
        errors.push({ path: `${path}.order`, message: `expected 'asc' | 'desc', got ${JSON.stringify(s['order'])}` });
    }
}

function validateFilter(
    raw: unknown,
    path: string,
    errors: ManifestValidationIssue[],
): void {
    if (!isPlainObject(raw)) {
        errors.push({ path, message: 'must be an object' });
        return;
    }
    const f = raw as Record<string, unknown>;
    requireString(f, 'field', errors, `${path}.field`);
    const k = f['kind'];
    if (typeof k !== 'string' || !VALID_FILTER_KINDS.includes(k as typeof VALID_FILTER_KINDS[number])) {
        errors.push({
            path: `${path}.kind`,
            message: `expected ${VALID_FILTER_KINDS.map((s) => `'${s}'`).join(' | ')}, got ${JSON.stringify(k)}`,
        });
        return;
    }
    if (k === 'select') {
        if (!Array.isArray(f['options']) ||
            !(f['options'] as unknown[]).every((o) => typeof o === 'string')) {
            errors.push({ path: `${path}.options`, message: 'required for `kind: "select"`, must be a string array' });
        }
    }
    if (k === 'multi-select' && f['options'] !== undefined) {
        if (!Array.isArray(f['options']) ||
            !(f['options'] as unknown[]).every((o) => typeof o === 'string')) {
            errors.push({ path: `${path}.options`, message: 'must be a string array when present' });
        }
    }
}

function validateDefContribution(
    raw: unknown,
    path: string,
    errors: ManifestValidationIssue[],
    warns: ManifestValidationIssue[],
): void {
    if (!isPlainObject(raw)) {
        errors.push({ path, message: 'must be an object' });
        return;
    }
    const d = raw as Record<string, unknown>;

    if (d['required'] !== undefined && typeof d['required'] !== 'boolean') {
        errors.push({ path: `${path}.required`, message: 'must be a boolean when present' });
    }

    if (d['agents'] !== undefined) {
        if (!Array.isArray(d['agents'])) {
            errors.push({ path: `${path}.agents`, message: 'must be an array' });
        } else {
            (d['agents'] as unknown[]).forEach((a, i) => {
                validateAgentDescriptor(a, `${path}.agents[${i}]`, errors);
            });
        }
    }

    if (d['scheduledTasks'] !== undefined) {
        if (!Array.isArray(d['scheduledTasks'])) {
            errors.push({ path: `${path}.scheduledTasks`, message: 'must be an array' });
        } else {
            (d['scheduledTasks'] as unknown[]).forEach((t, i) => {
                validateScheduledTask(t, `${path}.scheduledTasks[${i}]`, errors);
            });
        }
    }

    if (d['permissions'] !== undefined) {
        validatePermissions(d['permissions'], `${path}.permissions`, errors);
    }

    for (const key of Object.keys(d)) {
        if (!KNOWN_DEF_KEYS.has(key)) {
            warns.push({ path: `${path}.${key}`, message: 'unknown field; ignored' });
        }
    }
}

function validateAgentDescriptor(
    raw: unknown,
    path: string,
    errors: ManifestValidationIssue[],
): void {
    if (!isPlainObject(raw)) {
        errors.push({ path, message: 'must be an object' });
        return;
    }
    const a = raw as Record<string, unknown>;
    requireString(a, 'name', errors, `${path}.name`);
    if (a['displayName'] !== undefined && typeof a['displayName'] !== 'string') {
        errors.push({ path: `${path}.displayName`, message: 'must be a string when present' });
    }
    if (a['system'] !== undefined && typeof a['system'] !== 'string') {
        errors.push({ path: `${path}.system`, message: 'must be a string when present' });
    }
    if (a['model'] !== undefined && typeof a['model'] !== 'string') {
        errors.push({ path: `${path}.model`, message: 'must be a string when present' });
    }
    if (a['tools'] !== undefined) {
        if (!Array.isArray(a['tools']) ||
            !(a['tools'] as unknown[]).every((s) => typeof s === 'string')) {
            errors.push({ path: `${path}.tools`, message: 'must be an array of strings' });
        }
    }
    // memory + extra fields are intentionally opaque (DEF owns the schema).
}

function validateScheduledTask(
    raw: unknown,
    path: string,
    errors: ManifestValidationIssue[],
): void {
    if (!isPlainObject(raw)) {
        errors.push({ path, message: 'must be an object' });
        return;
    }
    const t = raw as Record<string, unknown>;
    requireString(t, 'id', errors, `${path}.id`);
    requireString(t, 'agent', errors, `${path}.agent`);

    if (!isPlainObject(t['trigger'])) {
        errors.push({ path: `${path}.trigger`, message: 'required, must be an object' });
    } else {
        const tr = t['trigger'] as Record<string, unknown>;
        const k = tr['kind'];
        if (typeof k !== 'string' || !VALID_TRIGGER_KINDS.includes(k as typeof VALID_TRIGGER_KINDS[number])) {
            errors.push({
                path: `${path}.trigger.kind`,
                message: `expected ${VALID_TRIGGER_KINDS.map((s) => `'${s}'`).join(' | ')}, got ${JSON.stringify(k)}`,
            });
        } else if (k === 'cron') {
            requireString(tr, 'expression', errors, `${path}.trigger.expression`);
        } else if (k === 'event') {
            requireString(tr, 'topic', errors, `${path}.trigger.topic`);
        }
    }

    if (t['prompt'] !== undefined && typeof t['prompt'] !== 'string') {
        errors.push({ path: `${path}.prompt`, message: 'must be a string when present' });
    }
}

function validatePermissions(
    raw: unknown,
    path: string,
    errors: ManifestValidationIssue[],
): void {
    if (!Array.isArray(raw)) {
        errors.push({ path, message: 'must be an array of permission strings' });
        return;
    }
    (raw as unknown[]).forEach((perm, i) => {
        if (typeof perm !== 'string') {
            errors.push({ path: `${path}[${i}]`, message: 'each permission must be a string' });
            return;
        }
        if (!PERMISSION_FORMAT.test(perm)) {
            errors.push({
                path: `${path}[${i}]`,
                message: `permission "${perm}" is not in the form "namespace[:verb][:target]"`,
            });
        }
    });
}

function validateEngines(
    raw: unknown,
    path: string,
    errors: ManifestValidationIssue[],
    warns: ManifestValidationIssue[],
): void {
    if (!isPlainObject(raw)) {
        errors.push({ path, message: 'must be an object' });
        return;
    }
    const e = raw as Record<string, unknown>;
    if (e['lore'] !== undefined && typeof e['lore'] !== 'string') {
        errors.push({ path: `${path}.lore`, message: 'must be a semver range string when present' });
    }
    if (e['def'] !== undefined && typeof e['def'] !== 'string') {
        errors.push({ path: `${path}.def`, message: 'must be a semver range string when present' });
    }
    for (const key of Object.keys(e)) {
        if (!KNOWN_ENGINES_KEYS.has(key)) {
            warns.push({ path: `${path}.${key}`, message: 'unknown field; ignored' });
        }
    }
}

// ────────────────────────────────────────────────────────────────────────
// Field helpers
// ────────────────────────────────────────────────────────────────────────

function requireString(
    obj: Record<string, unknown>,
    key: string,
    errors: ManifestValidationIssue[],
    path?: string,
): void {
    const val = obj[key];
    const p = path ?? key;
    if (val === undefined || val === null) {
        errors.push({ path: p, message: 'required' });
        return;
    }
    if (typeof val !== 'string') {
        errors.push({ path: p, message: `must be a string, got ${typeof val}` });
        return;
    }
    if (val.length === 0) {
        errors.push({ path: p, message: 'must be non-empty' });
    }
}

function optionalString(
    obj: Record<string, unknown>,
    key: string,
    errors: ManifestValidationIssue[],
    path?: string,
): void {
    const val = obj[key];
    const p = path ?? key;
    if (val === undefined) return;
    if (typeof val !== 'string') {
        errors.push({ path: p, message: `must be a string when present, got ${typeof val}` });
    }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}
