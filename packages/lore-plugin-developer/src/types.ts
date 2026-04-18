/**
 * developer/types.ts — Developer-plugin-owned type definitions.
 *
 * Previously lived in src/engines/localGraph.ts where they were core-
 * visible; moved here as part of Option C so core stays blind to
 * code-graph concerns.
 */

/**
 * CodeSymbol — A code element imported from GitNexus.
 * Represents a function, class, method, interface, or other structural
 * code element with its location and relationships.
 */
export interface CodeSymbol {
    uid: string;
    name: string;
    kind: string;
    filePath: string;
    startLine: number;
    endLine: number;
    content: string;
    signature: string;
    returnType: string;
    parameterCount: number;
    repo: string;
}

/**
 * CodeRelationEdge — A relationship between two code symbols.
 * Represents call graphs, type inheritance, imports, etc.
 */
export interface CodeRelationEdge {
    sourceUid: string;
    targetUid: string;
    type: string;
    confidence: number;
    reason: string;
}

/**
 * DevActivity — A developer activity heartbeat.
 * Who is working on what, where, and when.
 */
export interface DevActivity {
    dev: string;
    project: string;
    action: string;
    filePath: string;
    timestamp: string;
    tool: string;
}
