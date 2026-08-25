/**
 * surrealLicenceGuard.ts — BSL 1.1 boundary for the SurrealDB engine.
 *
 * SurrealDB core is licensed under the Business Source License 1.1.
 * Embedding it inside a product is explicitly permitted. Offering SurrealDB
 * itself as a hosted service is NOT, without a commercial licence.
 *
 * Lore's local and embedded modes are squarely on the permitted side: the
 * engine runs in-process, on the user's own machine, against the user's own
 * files. Lore's cloud modes are the side that is not — a multi-tenant
 * Dataplane serving other people's data from a SurrealDB we operate is the
 * exact shape BSL carves out.
 *
 * That distinction must not live only in prose. It is enforced twice:
 *
 *   1. HERE, at runtime — `LoreStorageClient.fromSurreal` calls
 *      `assertSurrealLicenceBoundary()`, which throws in a cloud-side mode.
 *      This catches an operator flipping LORE_DEPLOYMENT_MODE on a build that
 *      already has the engine compiled in.
 *   2. STATICALLY, in scripts/test-arch.mjs (rule D-022) — no cloud-mode
 *      module may import the engine or the factory, and the engine may not
 *      import the cloud SDK. This catches a code path being wired up.
 *
 * Neither check is a substitute for the other: (1) cannot see an import that
 * has not run yet, and (2) cannot see a mode chosen at runtime.
 */

/** Modes where a SurrealDB-backed substrate would cross the BSL boundary. */
const CLOUD_SIDE_MODES: readonly string[] = [
    // Dataplane-backed, multi-tenant.
    'cloud',
    // The db-per-app ArcadeDB cloud backend — hosted, other people's data.
    'arcade',
];

export class SurrealLicenceBoundaryError extends Error {
    public readonly code = 'surreal_licence_boundary';
    constructor(mode: string) {
        super(
            `[SurrealGraph] refusing to construct a SurrealDB-backed store in '${mode}' mode. `
            + 'SurrealDB core is BSL 1.1: embedding is permitted, offering it as a hosted '
            + 'service is not. The engine is local/embedded ONLY. If a hosted SurrealDB is '
            + 'genuinely wanted, that needs a commercial licence and an explicit decision — '
            + 'not an env var.',
        );
        this.name = 'SurrealLicenceBoundaryError';
    }
}

/**
 * assertSurrealLicenceBoundary — throw when the effective deployment mode is
 * cloud-side.
 *
 * Reads `LORE_DEPLOYMENT_MODE` directly rather than going through
 * `resolveDeploymentMode(config)`. That is deliberate: this guard must hold
 * for every caller, including ones with no ConfigManager in hand (tests, CLI
 * one-shots, an embedder constructing the store itself), and a guard that can
 * be bypassed by not passing config is not a guard. Callers that HAVE resolved
 * a mode should pass it — the explicit argument wins.
 *
 * Unknown/absent values are permitted: `resolveDeploymentMode` defaults to
 * 'local', so absence means local, which is the licensed case.
 */
export function assertSurrealLicenceBoundary(
    mode: string | undefined = process.env['LORE_DEPLOYMENT_MODE'],
): void {
    if (mode === undefined) return;
    const normalized = mode.trim().toLowerCase();
    if (CLOUD_SIDE_MODES.includes(normalized)) {
        throw new SurrealLicenceBoundaryError(normalized);
    }
}
