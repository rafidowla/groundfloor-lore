import fs from 'fs';
import path from 'path';
import {
    DEFAULT_SCHEMA_V2,
    LegacyLoreSchema,
    LoreSchemaV2,
    SCHEMA_FORMAT_VERSION,
    migrateLegacySchema,
    validateSchema,
} from './types.js';

export type {
    LoreSchemaV2,
    NodeTypeSpec,
    EdgeTypeSpec,
    FieldSpec,
    NodeKind,
    PermissionSchema,
    PermissionExpression,
    ProvenanceRef,
} from './types.js';

export {
    NODE_FLOOR_FIELDS,
    EDGE_FLOOR_FIELDS,
    REBAC_RELATION_EDGES,
    REBAC_RELATION_EDGE_NAMES,
    DEFAULT_NODE_KIND,
    SCHEMA_FORMAT_VERSION,
    DEFAULT_SCHEMA_V2,
    validateSchema,
} from './types.js';

/**
 * Legacy flat-string shape preserved for back-compat with callers that
 * still expect `nodeTypes: string[]` / `edgeRelations: string[]`.
 *
 * New code should consume `LoreSchemaV2` (typed nodeTypes / edgeTypes).
 * The string-array fields here are derived from V2 at load time so old
 * call sites keep working without churn.
 */
export interface LoreSchema {
    domain: string;
    description: string;
    nodeTypes: string[];
    edgeRelations: string[];
    systemPrompt: string;
}

function isLegacyShape(raw: unknown): raw is LegacyLoreSchema {
    if (!raw || typeof raw !== 'object') return false;
    const r = raw as Record<string, unknown>;
    if (typeof r.version === 'number' && r.version >= SCHEMA_FORMAT_VERSION) {
        return false;
    }
    return (
        Array.isArray(r.nodeTypes) &&
        (r.nodeTypes as unknown[]).every(n => typeof n === 'string')
    );
}

function loadV2(raw: Record<string, unknown>): LoreSchemaV2 {
    const merged: LoreSchemaV2 = {
        ...DEFAULT_SCHEMA_V2,
        ...(raw as Partial<LoreSchemaV2>),
    };
    return merged;
}

function v2ToLegacyShape(v2: LoreSchemaV2): LoreSchema {
    return {
        domain: v2.domain,
        description: v2.description,
        nodeTypes: v2.nodeTypes.map(nt => nt.name),
        edgeRelations: v2.edgeTypes.map(et => et.name),
        systemPrompt: v2.systemPrompt,
    };
}

/**
 * SchemaLoader — reads `<basePath>/.lore/schema.json` and exposes both the
 * legacy flat shape (old call sites) and the typed V2 shape (new code).
 *
 * Backward-compat path:
 *   - If the file is missing, DEFAULT_SCHEMA_V2 is used.
 *   - If the file is in legacy flat-string format, it is migrated through
 *     `migrateLegacySchema` (kind defaults to 'factual', ReBAC relation
 *     edges are appended).
 *   - If the file is V2, it is merged onto DEFAULT_SCHEMA_V2 so partial
 *     overrides still get the floor + ReBAC edges.
 *
 * Validation runs on the resolved V2 schema; failures are logged but
 * don't throw (parity with previous behavior). Callers that want strict
 * validation use `validateSchema(loader.getV2())` directly.
 */
export class SchemaLoader {
    private v2: LoreSchemaV2;
    private legacy: LoreSchema;
    private schemaPath: string;

    constructor(basePath: string) {
        this.schemaPath = path.join(basePath, '.lore', 'schema.json');
        this.v2 = this.load();
        this.legacy = v2ToLegacyShape(this.v2);
    }

    private load(): LoreSchemaV2 {
        try {
            if (fs.existsSync(this.schemaPath)) {
                const raw = JSON.parse(fs.readFileSync(this.schemaPath, 'utf-8'));
                const v2 = isLegacyShape(raw)
                    ? migrateLegacySchema(raw)
                    : loadV2(raw as Record<string, unknown>);
                const result = validateSchema(v2);
                if (!result.valid) {
                    console.error(
                        `[SchemaLoader] Schema at ${this.schemaPath} has errors:`,
                        result.errors,
                    );
                }
                if (result.warnings.length > 0) {
                    console.warn(
                        `[SchemaLoader] Schema warnings:`,
                        result.warnings,
                    );
                }
                return v2;
            }
        } catch (e) {
            console.error(
                `[SchemaLoader] Failed to parse schema at ${this.schemaPath}. Defaulting.`,
                e,
            );
        }
        return DEFAULT_SCHEMA_V2;
    }

    /** Legacy flat shape — preserved for existing callers. */
    public get(): LoreSchema {
        return this.legacy;
    }

    /** Typed V2 shape — new code uses this. */
    public getV2(): LoreSchemaV2 {
        return this.v2;
    }
}
