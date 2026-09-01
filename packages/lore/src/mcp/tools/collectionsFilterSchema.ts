/**
 * Zod schemas for leaf Filter and nested FilterNode.
 * Kept out of collections.ts for the 800-line cap.
 */

import { z } from 'zod';
import type { Filter, FilterNode } from '../../engines/collectionStorage.js';

export const leafFilterZ = z.object({
    eq: z.record(z.string(), z.unknown()).optional(),
    contains: z.record(z.string(), z.string()).optional(),
    startsWith: z.record(z.string(), z.string()).optional(),
    gt: z.record(z.string(), z.unknown()).optional(),
    gte: z.record(z.string(), z.unknown()).optional(),
    lt: z.record(z.string(), z.unknown()).optional(),
    lte: z.record(z.string(), z.unknown()).optional(),
    in: z.record(z.string(), z.array(z.unknown())).optional(),
});

export const filterNodeZ: z.ZodType<FilterNode> = z.lazy(() =>
    z.union([
        z.object({ and: z.array(filterNodeZ).min(1) }),
        z.object({ or: z.array(filterNodeZ).min(1) }),
        z.object({ not: filterNodeZ }),
        leafFilterZ,
    ]),
);

export const optionalFilterNodeZ = filterNodeZ.optional();

export function parseFilterNode(value: unknown): FilterNode | undefined {
    if (value === undefined) return undefined;
    return filterNodeZ.parse(value);
}

export type ParsedLeafFilter = z.infer<typeof leafFilterZ> & Filter;
