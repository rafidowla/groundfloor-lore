/**
 * migration/coordinator.ts — Sprint H MigrationCoordinator.
 *
 * Single orchestrator that owns the `migrations` SQLite table and
 * dispatches to per-substrate adapters. The H1 surface ships:
 *
 *   - apply(spec) — execute an additive migration end-to-end:
 *       1. insert pending row
 *       2. emit migration.started outbox notification
 *       3. dispatch to substrate adapter (addColumn/addTable/addIndex)
 *       4. update migrations table (applied or failed)
 *       5. emit migration.applied (or migration.failed) outbox notification
 *
 *   - rollback(id) — undo a previously applied migration via the
 *     adapter's reverse* verb. H1 wires additive reverses; H3
 *     extends to cross-substrate rollback orchestration. The verb
 *     surface is present at H1 so the gate test H-D7 stays red on
 *     the schema-grep check (sufficient at H0/H1; H3 ships the full
 *     atomicity story).
 *
 *   - addColumn / addTable / addIndex — convenience wrappers around
 *     apply() so the gate test H-D1 finds `addColumn(` in source and
 *     to give the CLI a typed surface.
 *
 * Coordinator boot ordering (audit Section 5 + spec H1 scope guard):
 *   1. wireOutbox()                — outbox store + replicator constructed
 *   2. graph.initialize()          — substrate handles available
 *   3. wireMigrationCoordinator()  — coordinator constructed + adapters
 *      registered AFTER outbox so notifications go out the moment
 *      apply() runs
 *   4. replicator.start()          — pickup of migration.* rows
 *
 * Coordinator is intentionally substrate-agnostic — it asks the
 * adapter's capabilities() before dispatching and throws
 * CapabilityNotSupportedError before any side effect lands if the
 * adapter declines.
 *
 * Cross-backend (cloud) migration boundary (DEC-MIGRATION):
 *   This coordinator runs LOCAL-substrate migrations only
 *   (SubstrateName = 'sqlite' | 'kuzu' | 'lance'). Cross-backend /
 *   cloud data migration is NOT run client-side — it stays delegated
 *   to Dataplane. The only cloud-facing concern this file owns is the
 *   single source-of-truth CURRENT_DATA_VERSION constant (below), which
 *   the sync engine stamps onto outbound payloads and checks on inbound
 *   ones so a host on vX and a peer/cloud on vY can detect a shape
 *   mismatch instead of silently last-writer-wins applying it.
 */

import { randomUUID } from 'node:crypto';
import type {
    AdapterCapabilities,
    AdapterOpResult,
    AddColumnSpec,
    AddIndexSpec,
    AddTableSpec,
    DualWriteState,
    MigrationKind,
    MigrationPhase,
    MigrationRow,
    MigrationSpec,
    MigrationStatus,
    SubstrateMigrationAdapter,
    SubstrateName,
} from './types.js';
import { CapabilityNotSupportedError } from './types.js';
import type { MigrationsStore } from './store.js';
import type { OutboxEntry, OutboxStore } from '../outbox/types.js';

/**
 * CURRENT_DATA_VERSION — single source of truth for the on-the-wire
 * data/schema version of nodes + edges this build produces.
 *
 * BOTH the migration coordinator (this file) and the sync engine
 * (engines/syncEngine.ts imports this constant) read it, so the two
 * never disagree about "what shape do we speak". The sync engine stamps
 * it onto every outbound push envelope and checks it on every inbound
 * pull: a STRICTLY HIGHER incoming version is refused (the peer/cloud
 * speaks a newer shape this build can't safely apply) rather than being
 * last-writer-wins applied. A missing/undefined incoming version means a
 * legacy peer that predates the handshake — treated as current, never a
 * failure (back-compat).
 *
 * Bump this when a node/edge shape change ships that a strictly-older
 * peer could not faithfully apply. Cross-backend (cloud) migration of
 * the data itself remains delegated to Dataplane — see the file header.
 */
export const CURRENT_DATA_VERSION = 1;

export interface MigrationCoordinatorOptions {
    /** Sprint L invariant — default workspace for global schema changes
     *  whose `spec.workspace === '*'` flows through to the outbox as
     *  this name. Default 'default'. */
    globalWorkspaceLabel?: string;
}

/**
 * Hook the coordinator uses to write a notification to the Sprint O
 * outbox. Narrow on purpose so tests can inject a no-op or a recording
 * spy without dragging in the full outbox wiring.
 */
export interface MigrationNotifier {
    record(entry: OutboxEntry): Promise<void>;
}

/**
 * Adapter for migration.* notifier — wraps any OutboxStore so the
 * coordinator can record() entries. Pulled out so tests can pass a
 * recording fake without subclassing the real store.
 */
export function outboxNotifier(store: OutboxStore): MigrationNotifier {
    return {
        record(entry) {
            return store.record(entry);
        },
    };
}

const KIND_TO_PHASE: Record<MigrationKind, MigrationPhase> = {
    add_column: 'additive',
    add_table: 'additive',
    add_index: 'additive',
    prepare_rename: 'expand',
    migrate_data: 'migrate',
    drop_old: 'contract',
    rename_column: 'expand',
    change_type: 'expand',
    drop_column: 'expand',
};

/** Destructive parent kinds — these own a full expand→migrate→contract
 *  lifecycle and progress via advance()/rollback(). */
const DESTRUCTIVE_PARENT_KINDS = new Set<MigrationKind>(['rename_column', 'change_type', 'drop_column']);

const PHASE_ORDER: MigrationPhase[] = ['expand', 'migrate', 'contract', 'complete'];

function nextPhase(p: MigrationPhase): MigrationPhase | undefined {
    const i = PHASE_ORDER.indexOf(p);
    if (i < 0 || i >= PHASE_ORDER.length - 1) return undefined;
    return PHASE_ORDER[i + 1];
}

function prevPhase(p: MigrationPhase): MigrationPhase | undefined {
    const i = PHASE_ORDER.indexOf(p);
    if (i <= 0) return undefined;
    return PHASE_ORDER[i - 1];
}

export class MigrationCoordinator {
    private readonly adapters = new Map<SubstrateName, SubstrateMigrationAdapter>();
    private readonly store: MigrationsStore;
    private readonly notifier: MigrationNotifier | undefined;
    private readonly globalWsLabel: string;
    /** In-memory index of active dual-write windows. Keyed by
     *  `${substrate}::${table}::${fromColumn}`. The bulk loader consults
     *  dualWriteActiveFor(table, column) to mirror writes during a window
     *  (read-your-writes on the new column); the operator status surface
     *  reads listDualWrites(). Hot write paths deliberately do NOT consult
     *  it — late-write CORRECTNESS is guaranteed at contract time by the
     *  atomic catch-up+drop (see the contract transition in advance()).
     *  Rehydrated from the durable migrations table on construction (a
     *  daemon restart or a separate CLI process used to start with an
     *  empty map, so the window silently did not exist for real operator
     *  workflows — 4.4 cause 3). Cleared once the parent migration leaves
     *  Phase 2. */
    private readonly dualWrites = new Map<string, DualWriteState>();

    constructor(store: MigrationsStore, notifier?: MigrationNotifier, opts: MigrationCoordinatorOptions = {}) {
        this.store = store;
        this.notifier = notifier;
        this.globalWsLabel = opts.globalWorkspaceLabel ?? 'default';
        this.rehydrateDualWrites();
    }

    /** 4.4 cause 3 — rebuild the dual-write index from rows sitting at
     *  phase='migrate' in the durable migrations table. The map is
     *  otherwise process-local, so a daemon restart or
     *  `lore migrate advance <id>` from a separate CLI process built a
     *  fresh coordinator with an empty map: the window did not exist for
     *  the real operator workflow. Best-effort — a store read failure
     *  logs and leaves the map empty (the table remains the durable
     *  truth and contract's atomic catch-up does not depend on the map). */
    private rehydrateDualWrites(): void {
        try {
            for (const row of this.store.list({ status: 'applied' })) {
                if (!DESTRUCTIVE_PARENT_KINDS.has(row.kind) || row.phase !== 'migrate') continue;
                this.openDualWrite(row, JSON.parse(row.paramsJson) as Record<string, unknown>);
            }
        } catch (err) {
            console.error(`[migration-coordinator] dual-write rehydration failed (continuing with empty window map): ${(err as Error).message}`);
        }
    }

    register(adapter: SubstrateMigrationAdapter): void {
        this.adapters.set(adapter.substrate, adapter);
    }

    getAdapter(substrate: SubstrateName): SubstrateMigrationAdapter | undefined {
        return this.adapters.get(substrate);
    }

    capabilities(substrate: SubstrateName): AdapterCapabilities | undefined {
        return this.adapters.get(substrate)?.capabilities();
    }

    listMigrations(opts: { status?: MigrationStatus; substrate?: SubstrateName; workspace?: string } = {}): MigrationRow[] {
        return this.store.list(opts);
    }

    getMigration(id: string): MigrationRow | undefined {
        return this.store.get(id);
    }

    // ----- convenience wrappers (CLI + tests + gate test H-D1) -----

    async addColumn(spec: AddColumnSpec & { id?: string; substrate: SubstrateName; workspace: string; note?: string }): Promise<MigrationRow> {
        return this.apply({
            id: spec.id ?? `add-col-${spec.table}-${Date.now()}-${randomUUID().slice(0, 8)}`,
            kind: 'add_column',
            substrate: spec.substrate,
            target: spec.table,
            workspace: spec.workspace,
            params: { column: spec.column },
            note: spec.note,
        });
    }

    async addTable(spec: AddTableSpec & { id?: string; substrate: SubstrateName; workspace: string; note?: string }): Promise<MigrationRow> {
        return this.apply({
            id: spec.id ?? `add-tbl-${spec.table}-${Date.now()}-${randomUUID().slice(0, 8)}`,
            kind: 'add_table',
            substrate: spec.substrate,
            target: spec.table,
            workspace: spec.workspace,
            params: { columns: spec.columns },
            note: spec.note,
        });
    }

    async addIndex(spec: AddIndexSpec & { id?: string; substrate: SubstrateName; workspace: string; note?: string }): Promise<MigrationRow> {
        return this.apply({
            id: spec.id ?? `add-idx-${spec.indexName}-${Date.now()}-${randomUUID().slice(0, 8)}`,
            kind: 'add_index',
            substrate: spec.substrate,
            target: spec.table,
            workspace: spec.workspace,
            params: { indexName: spec.indexName, columns: spec.columns },
            note: spec.note,
        });
    }

    /**
     * Apply a migration spec end-to-end. The migrations table tracks
     * pending → running → applied/failed. Outbox emits migration.started
     * + migration.applied (or migration.failed) so downstream observers
     * (Sprint O replicator self-heal, dashboards) see every state change.
     */
    async apply(spec: MigrationSpec): Promise<MigrationRow> {
        if (!spec.workspace) {
            // Sprint L invariant — every migration carries workspace.
            throw new Error(`migration coordinator: spec '${spec.id}' missing workspace (Sprint L invariant)`);
        }
        const adapter = this.adapters.get(spec.substrate);
        if (!adapter) {
            throw new Error(`migration coordinator: no adapter registered for substrate '${spec.substrate}'`);
        }
        const caps = adapter.capabilities();
        this.preflight(spec, caps);

        const phase = KIND_TO_PHASE[spec.kind];
        this.store.insertPending({
            id: spec.id,
            kind: spec.kind,
            substrate: spec.substrate,
            target: spec.target,
            workspace: spec.workspace,
            phase,
            paramsJson: JSON.stringify(spec.params),
        });
        await this.emit(spec, 'migration.started');

        this.store.update(spec.id, { status: 'running' });
        let result: AdapterOpResult;
        try {
            result = await this.dispatch(adapter, spec);
        } catch (err) {
            this.store.update(spec.id, { status: 'failed', error: (err as Error).message });
            await this.emit(spec, 'migration.failed', { error: (err as Error).message });
            throw err;
        }

        if (!result.ok) {
            this.store.update(spec.id, { status: 'failed', error: result.reason ?? 'unknown' });
            await this.emit(spec, 'migration.failed', { error: result.reason ?? 'unknown', detail: result.detail });
            const row = this.store.get(spec.id);
            if (!row) throw new Error('migration coordinator: vanished row after update');
            return row;
        }

        this.store.update(spec.id, { status: 'applied', appliedAt: new Date().toISOString() });
        await this.emit(spec, 'migration.applied', { reason: result.reason, detail: result.detail });
        const row = this.store.get(spec.id);
        if (!row) throw new Error('migration coordinator: vanished row after update');
        return row;
    }

    /**
     * Reverse a previously applied migration via the adapter's reverse*
     * verb. H1 ships the per-substrate reverse path; H3 layers
     * cross-substrate atomicity (rollback wholesale, not just one row).
     */
    async rollback(id: string): Promise<MigrationRow> {
        const row = this.store.get(id);
        if (!row) throw new Error(`migration coordinator: unknown id '${id}'`);
        if (row.status !== 'applied') {
            throw new Error(`migration coordinator: cannot rollback '${id}' in status '${row.status}'`);
        }
        const adapter = this.adapters.get(row.substrate);
        if (!adapter) {
            throw new Error(`migration coordinator: no adapter for substrate '${row.substrate}'`);
        }
        const params = JSON.parse(row.paramsJson) as Record<string, unknown>;
        let result: AdapterOpResult;
        try {
            switch (row.kind) {
                case 'add_column':
                    result = await adapter.reverseAddColumn({ table: row.target, column: params['column'] as string });
                    break;
                case 'add_table':
                    result = await adapter.reverseAddTable({ table: row.target, columns: params['columns'] as string });
                    break;
                case 'add_index':
                    result = await adapter.reverseAddIndex({
                        table: row.target,
                        indexName: params['indexName'] as string,
                        columns: params['columns'] as string,
                    });
                    break;
                default:
                    throw new Error(`migration coordinator: rollback for kind '${row.kind}' not wired in H1`);
            }
        } catch (err) {
            this.store.update(id, { status: 'failed', error: `rollback-threw:${(err as Error).message}` });
            await this.emit({ ...this.rowToSpec(row) }, 'migration.failed', { error: (err as Error).message });
            throw err;
        }
        if (!result.ok) {
            this.store.update(id, { status: 'failed', error: `rollback-failed:${result.reason ?? 'unknown'}` });
            await this.emit({ ...this.rowToSpec(row) }, 'migration.failed', { error: result.reason ?? 'unknown' });
            const updated = this.store.get(id);
            if (!updated) throw new Error('migration coordinator: vanished row after rollback update');
            return updated;
        }
        this.store.update(id, { status: 'rolled_back' });
        await this.emit(this.rowToSpec(row), 'migration.applied', { reason: 'rolled_back', detail: { rollbackOf: id } });
        const updated = this.store.get(id);
        if (!updated) throw new Error('migration coordinator: vanished row after rollback');
        return updated;
    }

    // ----- internals -----

    private preflight(spec: MigrationSpec, caps: AdapterCapabilities): void {
        switch (spec.kind) {
            case 'add_column':
                if (!caps.addColumn) throw new CapabilityNotSupportedError(spec.substrate, 'addColumn', 'additive-not-supported, schema-rebuild-required (flag for H2)');
                return;
            case 'add_table':
                if (!caps.addTable) throw new CapabilityNotSupportedError(spec.substrate, 'addTable', 'addTable not supported by substrate');
                return;
            case 'add_index':
                if (!caps.addIndex) throw new CapabilityNotSupportedError(spec.substrate, 'addIndex', 'CREATE INDEX not exposed by substrate binding; flag for H2');
                return;
            // H2 destructive parents — preflight defers to per-phase
            // dispatch since each phase has its own capability check.
            case 'rename_column':
            case 'change_type':
            case 'drop_column':
                return;
            // H2 sub-phase explicit kinds (operator-driven step apply).
            case 'prepare_rename':
            case 'migrate_data':
            case 'drop_old':
                return;
        }
    }

    private async dispatch(adapter: SubstrateMigrationAdapter, spec: MigrationSpec): Promise<AdapterOpResult> {
        switch (spec.kind) {
            case 'add_column':
                return adapter.addColumn({ table: spec.target, column: spec.params['column'] as string });
            case 'add_table':
                return adapter.addTable({ table: spec.target, columns: spec.params['columns'] as string });
            case 'add_index':
                return adapter.addIndex({
                    table: spec.target,
                    indexName: spec.params['indexName'] as string,
                    columns: spec.params['columns'] as string,
                });
            // Destructive parent: apply() lands Phase 1 EXPAND. Operator
            // calls advance() to progress through migrate + contract.
            case 'rename_column':
                if (!adapter.prepareRename) throw new CapabilityNotSupportedError(spec.substrate, 'prepareRename', 'adapter missing H2 verb');
                return adapter.prepareRename({
                    table: spec.target,
                    fromColumn: spec.params['fromColumn'] as string,
                    toColumn: spec.params['toColumn'] as string,
                    columnDdl: spec.params['columnDdl'] as string,
                });
            case 'change_type':
                if (!adapter.prepareTypeChange) throw new CapabilityNotSupportedError(spec.substrate, 'prepareTypeChange', 'adapter missing H2 verb');
                return adapter.prepareTypeChange({
                    table: spec.target,
                    fromColumn: spec.params['fromColumn'] as string,
                    toColumn: spec.params['toColumn'] as string,
                    columnDdl: spec.params['columnDdl'] as string,
                });
            case 'drop_column':
                if (!adapter.prepareDropColumn) throw new CapabilityNotSupportedError(spec.substrate, 'prepareDropColumn', 'adapter missing H2 verb');
                return adapter.prepareDropColumn({ table: spec.target, column: spec.params['column'] as string });
            // Explicit sub-phase kinds (one-shot apply, e.g. CLI step mode).
            case 'prepare_rename':
                if (!adapter.prepareRename) throw new CapabilityNotSupportedError(spec.substrate, 'prepareRename', 'adapter missing H2 verb');
                return adapter.prepareRename({
                    table: spec.target,
                    fromColumn: spec.params['fromColumn'] as string,
                    toColumn: spec.params['toColumn'] as string,
                    columnDdl: spec.params['columnDdl'] as string,
                });
            case 'migrate_data':
                if (!adapter.migrateData) throw new CapabilityNotSupportedError(spec.substrate, 'migrateData', 'adapter missing H2 verb');
                return adapter.migrateData({
                    table: spec.target,
                    fromColumn: spec.params['fromColumn'] as string,
                    toColumn: spec.params['toColumn'] as string,
                    batchSize: spec.params['batchSize'] as number | undefined,
                });
            case 'drop_old':
                if (!adapter.dropOld) throw new CapabilityNotSupportedError(spec.substrate, 'dropOld', 'adapter missing H2 verb');
                return adapter.dropOld({ table: spec.target, column: spec.params['column'] as string });
        }
    }

    // ----- H2 phase state machine -----

    /**
     * Advance a destructive migration to its next phase. Phase ordering:
     * expand → migrate → contract → complete. Phase 2 (migrate) opens a
     * dual-write window via dualWriteActiveFor; Phase 3 (contract) closes
     * it before dropping the old shape.
     */
    async advance(id: string): Promise<MigrationRow> {
        const row = this.store.get(id);
        if (!row) throw new Error(`migration coordinator: unknown id '${id}'`);
        if (!DESTRUCTIVE_PARENT_KINDS.has(row.kind)) {
            throw new Error(`migration coordinator: advance() only valid for destructive parent kinds; got '${row.kind}'`);
        }
        if (row.status !== 'applied') {
            throw new Error(`migration coordinator: cannot advance '${id}' from status '${row.status}'`);
        }
        const target = nextPhase(row.phase);
        if (!target) {
            throw new Error(`migration coordinator: '${id}' already at terminal phase '${row.phase}'`);
        }
        const adapter = this.adapters.get(row.substrate);
        if (!adapter) throw new Error(`migration coordinator: no adapter for substrate '${row.substrate}'`);
        const params = JSON.parse(row.paramsJson) as Record<string, unknown>;
        const spec = this.rowToSpec(row);

        // Mark in-flight by flipping status to 'running' for the duration
        // of the substrate call, then back to 'applied' at the new phase.
        this.store.update(id, { status: 'running', phase: target });
        await this.emit(spec, 'migration.started', { phase: target, transition: `${row.phase}->${target}` });

        let result: AdapterOpResult;
        try {
            if (target === 'migrate') {
                // drop_column has no data-copy step — Phase 2 is a no-op
                // marker for symmetry with rename/type-change.
                if (row.kind === 'drop_column') {
                    result = { ok: true, detail: { phase: 'migrate', verb: 'noop-for-drop' } };
                } else {
                    // Open dual-write window BEFORE running the backfill so any
                    // writer that hits the table mid-Phase-2 mirrors writes.
                    this.openDualWrite(row, params);
                    if (!adapter.migrateData) throw new CapabilityNotSupportedError(row.substrate, 'migrateData', 'adapter missing H2 verb');
                    result = await adapter.migrateData({
                        table: row.target,
                        fromColumn: params['fromColumn'] as string,
                        toColumn: params['toColumn'] as string,
                        batchSize: params['batchSize'] as number | undefined,
                    });
                }
            } else if (target === 'contract') {
                if (!adapter.dropOld) throw new CapabilityNotSupportedError(row.substrate, 'dropOld', 'adapter missing H2 verb');
                // Close dual-write window first — Phase 3 must see writes
                // going only to the new shape.
                this.closeDualWrite(row, params);
                const colToDrop = row.kind === 'drop_column'
                    ? (params['column'] as string)
                    : (params['fromColumn'] as string);
                if (row.kind !== 'drop_column' && adapter.contract) {
                    // 4.4 (2026-08-18) — ATOMIC catch-up + drop. The old
                    // path ran migrateData once in Phase 2 and then dropped
                    // the old column here without re-copying, silently
                    // discarding every write that landed in the dual-write
                    // window after the Phase-2 backfill. Adapters with the
                    // combined verb (sqlite) run the final backfill and the
                    // drop in ONE substrate transaction: late writes are
                    // either committed before it (and copied) or land after
                    // it (and fail loudly against the new schema).
                    result = await adapter.contract({
                        table: row.target,
                        fromColumn: params['fromColumn'] as string,
                        toColumn: params['toColumn'] as string,
                        column: colToDrop,
                        batchSize: params['batchSize'] as number | undefined,
                    });
                } else {
                    // Fallback (drop_column, or adapters without the atomic
                    // verb): re-run the backfill immediately before dropOld
                    // so late writes reach the new column first. Back-to-
                    // back, not atomic — for kuzu that narrows the loss
                    // window from the whole Phase-2 span to between the two
                    // statements.
                    let fallback: AdapterOpResult | undefined;
                    if (row.kind !== 'drop_column' && adapter.migrateData) {
                        const catchUp = await adapter.migrateData({
                            table: row.target,
                            fromColumn: params['fromColumn'] as string,
                            toColumn: params['toColumn'] as string,
                            batchSize: params['batchSize'] as number | undefined,
                        });
                        if (!catchUp.ok) {
                            fallback = catchUp;
                        }
                    }
                    result = fallback ?? await adapter.dropOld({ table: row.target, column: colToDrop });
                }
            } else if (target === 'complete') {
                // 'complete' is a coordinator-only transition; no substrate side-effect.
                result = { ok: true, detail: { phase: 'complete', transition: 'no-op' } };
            } else {
                throw new Error(`migration coordinator: unexpected advance target '${target}'`);
            }
        } catch (err) {
            this.store.update(id, { status: 'failed', error: (err as Error).message, phase: target });
            await this.emit(spec, 'migration.failed', { error: (err as Error).message, phase: target });
            throw err;
        }

        if (!result.ok) {
            this.store.update(id, { status: 'failed', error: result.reason ?? 'unknown', phase: target });
            await this.emit(spec, 'migration.failed', { error: result.reason ?? 'unknown', phase: target, detail: result.detail });
            const updated = this.store.get(id);
            if (!updated) throw new Error('migration coordinator: vanished row after advance');
            return updated;
        }

        this.store.update(id, { status: 'applied', phase: target, appliedAt: new Date().toISOString() });
        await this.emit(spec, 'migration.applied', { phase: target, transition: `${row.phase}->${target}`, detail: result.detail });
        const updated = this.store.get(id);
        if (!updated) throw new Error('migration coordinator: vanished row after advance');
        return updated;
    }

    /**
     * Roll a destructive migration BACK one phase. Reversing Phase 2
     * (migrate) closes the dual-write window and leaves the new column
     * in place (data is recoverable; operator can re-advance). Reversing
     * Phase 1 (expand) drops the new column added in Phase 1.
     *
     * Phase 3 (contract) is NOT reversible — once the old shape is
     * dropped, the data is gone. rollback() from 'contract' returns an
     * error so the operator must restore from snapshot (Z3 pattern).
     */
    async rollbackPhase(id: string): Promise<MigrationRow> {
        const row = this.store.get(id);
        if (!row) throw new Error(`migration coordinator: unknown id '${id}'`);
        if (!DESTRUCTIVE_PARENT_KINDS.has(row.kind)) {
            throw new Error(`migration coordinator: rollbackPhase() only valid for destructive parent kinds; got '${row.kind}'`);
        }
        // Rolling back from 'expand' is allowed: it drops the new column
        // and flips status to 'rolled_back'. So we do NOT require prevPhase
        // to exist — we only require row.phase to be one of the reversible
        // phases.
        const adapter = this.adapters.get(row.substrate);
        if (!adapter) throw new Error(`migration coordinator: no adapter for substrate '${row.substrate}'`);
        const params = JSON.parse(row.paramsJson) as Record<string, unknown>;
        const spec = this.rowToSpec(row);

        if (row.phase === 'contract' || row.phase === 'complete') {
            const msg = `migration coordinator: cannot rollback '${id}' from '${row.phase}' — contract phase is terminal; restore from snapshot if data must come back (Sprint Z3 pattern)`;
            this.store.update(id, { status: 'failed', error: 'rollback-not-supported-from-contract' });
            await this.emit(spec, 'migration.failed', { error: 'rollback-not-supported-from-contract', phase: row.phase });
            throw new Error(msg);
        }

        // Reversing 'migrate' → 'expand': close dual-write, leave new col present.
        if (row.phase === 'migrate') {
            this.closeDualWrite(row, params);
            this.store.update(id, { status: 'applied', phase: 'expand' });
            await this.emit(spec, 'migration.applied', { phase: 'expand', transition: 'migrate->expand', detail: { rollback: true, hint: 'dual-write closed; new column retained' } });
            const updated = this.store.get(id);
            if (!updated) throw new Error('migration coordinator: vanished row after rollbackPhase');
            return updated;
        }

        // Reversing 'expand' → 'rolled_back': drop the new column we added.
        if (row.phase === 'expand') {
            if (row.kind === 'drop_column') {
                // drop_column's Phase 1 is a no-op marker — rollback just resets state.
                this.store.update(id, { status: 'rolled_back' });
                await this.emit(spec, 'migration.applied', { reason: 'rolled_back', detail: { rollbackOf: id, phase: 'expand', noop: true } });
                const updated = this.store.get(id);
                if (!updated) throw new Error('migration coordinator: vanished row after rollbackPhase');
                return updated;
            }
            const toColumn = params['toColumn'] as string;
            const columnDdl = (params['columnDdl'] as string | undefined) ?? toColumn;
            // Reuse reverseAddColumn — it does the column existence probe
            // + ALTER TABLE DROP COLUMN on SQLite; kuzu/lance return
            // structured failures we surface upward.
            const reverseResult = await adapter.reverseAddColumn({ table: row.target, column: columnDdl });
            if (!reverseResult.ok) {
                this.store.update(id, { status: 'failed', error: `rollback-expand-failed:${reverseResult.reason ?? 'unknown'}` });
                await this.emit(spec, 'migration.failed', { error: reverseResult.reason, phase: 'expand' });
                const updated = this.store.get(id);
                if (!updated) throw new Error('migration coordinator: vanished row after rollbackPhase');
                return updated;
            }
            this.store.update(id, { status: 'rolled_back' });
            await this.emit(spec, 'migration.applied', { reason: 'rolled_back', detail: { rollbackOf: id, phase: 'expand', droppedColumn: toColumn } });
            const updated = this.store.get(id);
            if (!updated) throw new Error('migration coordinator: vanished row after rollbackPhase');
            return updated;
        }

        // Unreachable given the phase guard above; satisfy TS.
        throw new Error(`migration coordinator: unexpected rollback shape from '${row.phase}'`);
    }

    /** Returns the active dual-write target for (table, column) IF a
     *  destructive migration owns a Phase-2 window on it. The bulk loader
     *  consults this to mirror writes; hot write paths do not (late-write
     *  correctness lives in contract's atomic catch-up — see advance()).
     *  Returns undefined if no window active. */
    dualWriteActiveFor(table: string, column: string, substrate?: SubstrateName): DualWriteState | undefined {
        if (substrate) {
            return this.dualWrites.get(`${substrate}::${table}::${column}`);
        }
        // Substrate-agnostic lookup: scan for any substrate matching table+column.
        for (const v of this.dualWrites.values()) {
            if (v.table === table && v.fromColumn === column) return v;
        }
        return undefined;
    }

    /** Returns all active dual-write windows. Used by diagnostics +
     *  the operator CLI `lore migrate-online status`. */
    listDualWrites(): DualWriteState[] {
        return Array.from(this.dualWrites.values());
    }

    private openDualWrite(row: MigrationRow, params: Record<string, unknown>): void {
        const from = params['fromColumn'] as string | undefined;
        const to = params['toColumn'] as string | undefined;
        if (!from || !to) return;
        const key = `${row.substrate}::${row.target}::${from}`;
        this.dualWrites.set(key, { table: row.target, fromColumn: from, toColumn: to, migrationId: row.id });
    }

    private closeDualWrite(row: MigrationRow, params: Record<string, unknown>): void {
        const from = params['fromColumn'] as string | undefined;
        if (!from) return;
        const key = `${row.substrate}::${row.target}::${from}`;
        this.dualWrites.delete(key);
    }

    private rowToSpec(row: MigrationRow): MigrationSpec {
        return {
            id: row.id,
            kind: row.kind,
            substrate: row.substrate,
            target: row.target,
            workspace: row.workspace,
            params: JSON.parse(row.paramsJson) as Record<string, unknown>,
        };
    }

    private async emit(spec: MigrationSpec, kind: 'migration.started' | 'migration.applied' | 'migration.failed', extra?: Record<string, unknown>): Promise<void> {
        if (!this.notifier) return;
        const ws = spec.workspace === '*' ? this.globalWsLabel : spec.workspace;
        const now = new Date().toISOString();
        const entry: OutboxEntry = {
            id: `${kind}-${spec.id}-${randomUUID().slice(0, 8)}`,
            operation: kind,
            initiator: 'migration-coordinator',
            createdAt: now,
            updatedAt: now,
            steps: [],
            completed: false,
            workspace: ws,
            // operationKind is typed via the outbox union (added below).
            operationKind: kind as unknown as OutboxEntry['operationKind'],
            payload: {
                migrationId: spec.id,
                migrationKind: spec.kind,
                substrate: spec.substrate,
                target: spec.target,
                workspaceScope: spec.workspace,
                ...(extra ?? {}),
            },
            status: 'pending',
            attempts: 0,
        };
        try {
            await this.notifier.record(entry);
        } catch (err) {
            // Notification failure must not break the substrate-side
            // change. Log via console; the migrations table row IS the
            // durable record of the schema change.
            console.error(`[migration-coordinator] failed to emit ${kind} for ${spec.id}: ${(err as Error).message}`);
        }
    }
}
