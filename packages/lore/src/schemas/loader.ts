import fs from 'fs';
import path from 'path';

export interface LoreSchema {
    domain: string;
    description: string;
    nodeTypes: string[];
    edgeRelations: string[];
    systemPrompt: string;
}

// Core node types are workspace-agnostic — a hypothetical family or
// finance workspace would use these too. Domain-specific types
// (bug_pattern, architecture, troubleshooting, file_ref, schema) live
// in the plug-in that owns them and are merged in at boot via
// ILorePlugin.contributeNodeTypes() — see PluginRegistry.collectNodeTypeContributions
// and the merge in mcp/server.ts.
const DEFAULT_SCHEMA: LoreSchema = {
    domain: "Software Engineering",
    description: "Default domain for Groundfloor-Lore code intelligence.",
    nodeTypes: [
        "decision", "convention", "note"
    ],
    // Core edge relations are workspace-agnostic. 'fixed_by' (dev-coded —
    // implies bugs) lives in the developer plugin via
    // contributeEdgeRelations(). 'depends_on' kept in core because it's
    // genuinely generic ("school choice depends_on the move").
    edgeRelations: [
        "decided_for", "caused_by", "applies_to",
        "supersedes", "related_to", "depends_on"
    ],
    systemPrompt: "You are a senior developer operating within the groundfloor-lore ecosystem."
};

export class SchemaLoader {
    private schema: LoreSchema;
    private schemaPath: string;

    constructor(basePath: string) {
        this.schemaPath = path.join(basePath, '.lore', 'schema.json');
        this.schema = this.load();
    }

    private load(): LoreSchema {
        try {
            if (fs.existsSync(this.schemaPath)) {
                const customSchema = JSON.parse(fs.readFileSync(this.schemaPath, 'utf-8'));
                // Merge with default schema to ensure all keys exist
                return { ...DEFAULT_SCHEMA, ...customSchema };
            }
        } catch (e) {
            console.error(`[SchemaLoader] Failed to parse custom schema at ${this.schemaPath}. Defaulting.`, e);
        }
        return DEFAULT_SCHEMA;
    }

    public get(): LoreSchema {
        return this.schema;
    }
}
