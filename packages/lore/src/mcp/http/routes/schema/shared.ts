/**
 * shared.ts — types + constants for the /api/schema route family.
 *
 * SchemaRoutesDeps is the bundle every schema handler group receives;
 * PREFIX is the family's owned path prefix. SCHEMA_APPROVE_OPERATION now
 * lives canonically in security/schemaApprovalGate.ts (GAP 1, 2026-08-17
 * MCP follow-up — the mandatory-HITL gate logic moved there so this route
 * family and the schema_approve MCP tool share ONE chokepoint); re-exported
 * here so existing importers of this module are unaffected.
 */

import type { SchemaLoader } from '../../../../schemas/loader.js';
import type { PhaseAServices } from '../../../services.js';
import type { MigrationBackend } from '../../../../schemas/migration/types.js';
import type { CheckpointStore } from '../../../../schemas/migration/checkpointStore.js';
import type { PendingOpsStore } from '../../../../security/pendingOps.js';
import type { LoreDeploymentMode } from '../../../server.js';

export { SCHEMA_APPROVE_OPERATION } from '../../../../security/schemaApprovalGate.js';

export const PREFIX = '/api/schema';

// TODO(L-031): enforce the 'ddl'/'deploy' ReBAC permissions on the
// mutating governance/migration verbs (rollback, execute, resume,
// decompose, migrations/rollback). These currently gate only on the
// principal's token write-scope (requireMigrationWriteScope) + the
// destructive-execute human-approval guards. The cloud ReBAC gateRoute
// path cannot be called here because SchemaRoutesDeps carries no
// deploymentMode/dataplane — threading RouteGateDeps (deploymentMode +
// dataplane, mirroring DiagnosticDeps) into SchemaRoutesDeps and every
// schema-route construction site is the prerequisite. Deferred: that
// change touches the server wiring + every schema-route harness, out of
// scope for the minimal node/edge/lifecycle delete-permission fix.

export interface SchemaRoutesDeps {
    phaseA: PhaseAServices;
    schemaLoader: SchemaLoader;
    /**
     * Phase 4 item 8 — migration backend (Kùzu in local mode; cloud
     * impl pending). Optional so legacy callers + tests that don't
     * exercise /api/schema/migrations/* can pass undefined and the
     * routes refuse with a 503 instead of crashing.
     */
    migrationBackend?: MigrationBackend;
    /** Phase 4 batched checkpointing — persists per-batch progress to
     *  <workspace>/.lore/migrations/in-flight.json. Optional;
     *  /resume + /in-flight routes return 503 when absent. */
    migrationCheckpointStore?: CheckpointStore;
    /** Phase 4 rollback — absolute path to the workspace's
     *  `<workspace>/.lore/` directory. Required for /rollback to
     *  locate the Phase 1 data snapshots; /rollback returns 503
     *  when absent. */
    loreDir?: string;
    /** Phase 4 item 10 / GAP 1 (2026-08-17, reframed) — HITL queue. REQUIRED
     *  for destructive schema approves: the queue's separate /decision call
     *  is the mandatory human-confirmation step, so a destructive approve is
     *  refused (503 destructive_hitl_unavailable) when this is absent, rather
     *  than falling back to immediate execute. Additive proposals still
     *  execute immediately regardless. Optional only because most callers
     *  (additive-only workspaces, tests that don't exercise destructive
     *  changes) never need it wired. */
    pendingOpsStore?: PendingOpsStore;
    /**
     * Wave 4.2 — the workspace the entire /api/schema authoring + governance
     * + migration family is physically wired to. Today the SchemaAuthoringStore,
     * the migration backend, CheckpointStore, and PlanOrchestrator are all built
     * over the BOOT workspace's `.lore` (createPhaseAServices + wireOrchestration
     * in mcp/server.ts), so schema state persists under this workspace REGARDLESS
     * of the request's target. trySchemaRoutes fails closed (409
     * schema_workspace_not_active) when the request's bound target differs from
     * this value, so an app token bound to a non-boot workspace can no longer
     * silently mutate the boot workspace's schema.
     *
     * Renamed from `workspaceId` in Wave 4.2 to make the boot-binding explicit
     * (same value — detectedScope.workspace — at every construction site). Also
     * stamped on enqueued HITL approval rows. Falls back to 'default' if unset. */
    schemaWorkspace?: string;
    /**
     * ITEM 3 (launch-fixes-2026-08) — the instance's full run mode
     * (`LoreInstance.runMode`), threaded into gateSchemaApproval so an
     * 'embedded' boot refuses destructive approves at proposal time. In
     * practice the HTTP surface only exists in daemon modes (embedded
     * opens no port — main() returns before binding), so this is always
     * 'local'/'cloud'/'arcade' here today; wired anyway so the gate's
     * embedded refusal is reachable from BOTH entry points and a future
     * embedded-HTTP host fails closed instead of hanging. Optional only
     * for pre-existing test harnesses; production wires
     * `deps.runMode` in the dispatcher.
     */
    runMode?: LoreDeploymentMode;
}
