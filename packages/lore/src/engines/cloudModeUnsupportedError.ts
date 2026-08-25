/**
 * cloudModeUnsupportedError.ts — the 501-shaped error for code paths that
 * legitimately require a local engine surface and have no cloud-mode
 * equivalent yet. Engine-agnostic: names no engine and imports nothing, so
 * any layer (engines, MCP HTTP routes, background jobs) can throw and catch
 * it uniformly.
 */

/**
 * Thrown when a call site that requires a local engine surface is invoked
 * against a DataplaneGraph (or anything else). Has `code:
 * 'cloud_not_implemented'` + a `status: 501` shape so HTTP routes can map it
 * to a structured 501 response without parsing strings.
 */
export class CloudModeUnsupportedError extends Error {
    public readonly code = 'cloud_not_implemented' as const;
    public readonly status = 501 as const;
    public readonly operation: string;
    constructor(operation: string, hint?: string) {
        const detail = hint ? ` (${hint})` : '';
        super(
            `${operation}: not yet implemented for cloud-mode storage. ` +
            `Local-engine-only path${detail}. Tracked as a Bucket B/C parity ` +
            `follow-up — see groundfloor-dataplane parity assessment.`,
        );
        this.name = 'CloudModeUnsupportedError';
        this.operation = operation;
    }
}
