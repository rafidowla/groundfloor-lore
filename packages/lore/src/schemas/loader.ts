import fs from 'fs';
import path from 'path';

export interface LoreSchema {
    domain: string;
    description: string;
    nodeTypes: string[];
    edgeRelations: string[];
    systemPrompt: string;
}

const DEFAULT_SCHEMA: LoreSchema = {
    domain: "Software Engineering",
    description: "Default domain for Groundfloor-Lore code intelligence.",
    nodeTypes: [
        "decision", "convention", "bug_pattern", "file_ref", 
        "architecture", "troubleshooting", "note", "schema"
    ],
    edgeRelations: [
        "decided_for", "caused_by", "applies_to", 
        "fixed_by", "supersedes", "related_to", "depends_on"
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
