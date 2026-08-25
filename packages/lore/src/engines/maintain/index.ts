/**
 * maintain — Config-driven capacity maintenance for a Lore store.
 *
 * Public surface:
 *   resolveMaintainPolicy   build the effective policy (defaults+env+overrides)
 *   runMaintenance          the orchestrator (programmatic API)
 *   formatMaintainReport    human-readable summary
 *   adapters                real LanceDB / graph / workspace ports
 */

export * from './policy.js';
export * from './selection.js';
export * from './ports.js';
export * from './maintain.js';
export * from './format.js';
export {
    LanceMaintainer,
    GraphNodeStore,
    WorkspaceRegistry,
    DaemonSafety,
    AlwaysSafe,
    dirSizeBytes,
} from './adapters.js';
export type { GraphLike } from './adapters.js';
