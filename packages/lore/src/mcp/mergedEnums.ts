/**
 * mergedEnums.ts — Merge workspace-contributed vocabulary into the
 * store_node / store_edge enums at boot.
 *
 * Extracted from server.ts (file-size cap).
 *
 * Core ships generic vocabulary (decision/convention/note ; decided_for
 * / caused_by / applies_to / supersedes / related_to / depends_on);
 * domain words come from workspace schema via contributeNodeTypes() and
 * contributeEdgeRelations(). Computed at boot, before tool registration.
 */

import { z } from 'zod';
export function buildMergedEnums(input: {
    coreNodeTypes: readonly string[];
    coreEdgeRelations: readonly string[];
}) {
    const mergedNodeTypes: string[] = [
        ...input.coreNodeTypes,
    ];
    const nodeTypesDescription = mergedNodeTypes.join(', ');
    console.error(`[Lore MCP] Node types: ${nodeTypesDescription}`);

    const mergedEdgeRelations: string[] = [
        ...input.coreEdgeRelations,
    ];
    const edgeRelationsDescription = mergedEdgeRelations.join(', ');
    console.error(`[Lore MCP] Edge relations: ${edgeRelationsDescription}`);

    return {
        nodeTypesEnum: z.enum(mergedNodeTypes as [string, ...string[]]),
        nodeTypesDescription,
        edgeRelationsEnum: z.enum(mergedEdgeRelations as [string, ...string[]]),
        edgeRelationsDescription,
    };
}
