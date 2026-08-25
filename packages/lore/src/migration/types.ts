/**
 * migration/types.ts — Sprint H online-schema-migration types.
 *
 * Defines the SubstrateMigrationAdapter interface that the
 * MigrationCoordinator dispatches to. Designed cloud-compatible:
 * the same shape works for local SQLite + kuzu + LanceDB today AND
 * for Postgres / Arango / Zilliz when cloud activates. Concrete
 * cloud adapters land in the cloud-activation phase; H1 ships only
 * the local adapters.
 *
 * Design notes (audit Section 5 + Section 7):
 *
 *   - additive verbs (addColumn/addTable/addIndex) MUST be online —
 *     no daemon-down, in-flight writes succeed (verified per substrate
 *     in the H1 unit suite).
 *   - destructive verbs (prepareRename/migrateData/dropOld + changeType
 *     + dropColumn) shape lands in H2 with expand/migrate/contract
 *     decomposition. The verbs are declared here so the gate test
 *     H-D4/D5/D6 can flip in the H2 commit without re-shaping the
 *     interface mid-sprint.
 *   - Each verb returns AdapterOpResult so the coordinator can surface
 *     success/failure to the migrations table + outbox.
 *   - Capability probing: adapters expose `capabilities()` so the
 *     coordinator can refuse to dispatch a verb the substrate doesn't
 *     support (e.g., kuzu lacks ALTER COLUMN — coordinator throws
 *     CapabilityNotSupported with a structured reason the operator
 *     CLI surfaces as "additive-not-supported, schema-rebuild-required").
 */

export type SubstrateName = 'sqlite' | 'kuzu' | 'lance';

/**
 * Phase enum for destructive changes (expand/migrate/contract per
 * audit Section 4). Additive changes use phase='additive' which
 * collapses the 3-phase ceremony into a single step. H2 wires
 * expand/migrate/contract end-to-end.
 */
export type MigrationPhase = 'additive' | 'expand' | 'migrate' | 'contract' | 'complete' | 'failed';

/** Terminal + in-flight states for the migrations table. */
export type MigrationStatus =
    | 'pending'
    | 'running'
    | 'applied'
    | 'failed'
    | 'rolled_back';

export interface AdapterOpResult {
    /** True iff the substrate change landed. False = adapter refused
     *  (e.g., capability missing) or the substrate raised. */
    ok: boolean;
    /** Short tag the coordinator records in migrations.error /
     *  outbox.lastError for operator visibility. */
    reason?: string;
    /** Free-form structured detail (op-kind specific) the operator CLI
     *  surfaces under `lore migrate status <id>`. */
    detail?: Record<string, unknown>;
}

export interface AddColumnSpec {
    table: string;
    /** Full column DDL fragment, e.g. `"author TEXT"` or
     *  `"priority INTEGER DEFAULT 0"`. Adapter quotes per substrate. */
    column: string;
}

export interface AddTableSpec {
    table: string;
    /** Full CREATE TABLE column list. e.g. `"id TEXT PRIMARY KEY,
     *  body TEXT NOT NULL"`. Substrate-specific syntax. */
    columns: string;
}

export interface AddIndexSpec {
    table: string;
    indexName: string;
    /** Column expression. e.g. `"workspace, createdAt"`. */
    columns: string;
}

/** Destructive op specs. H2 wires the runtime via the 3-phase
 *  expand/migrate/contract decomposition (audit Section 4). */
export interface PrepareRenameSpec {
    table: string;
    fromColumn: string;
    toColumn: string;
    /** Column DDL for the new column (same shape as AddColumnSpec.column). */
    columnDdl: string;
}

/** Phase 1 for change_type: add a new column with the new type. The
 *  fromColumn keeps its original type — Phase 2 backfills, Phase 3
 *  drops fromColumn. */
export interface PrepareTypeChangeSpec {
    table: string;
    fromColumn: string;
    toColumn: string;
    /** Column DDL for the new (replacement) column, e.g. "priority_v2 INTEGER NOT NULL DEFAULT 0". */
    columnDdl: string;
}

/** Phase 1 for drop_column is a no-op marker — the column stays until
 *  Phase 3 contract. Recorded so the coordinator can track dual-write
 *  state + reject writes to a column that's been queued for drop. */
export interface PrepareDropColumnSpec {
    table: string;
    column: string;
}

export interface MigrateDataSpec {
    table: string;
    fromColumn: string;
    toColumn: string;
    /** Optional batch size for the UPDATE loop. Defaults to 500.
     *  Adapter checkpoints after each batch so a crash mid-migration
     *  can resume from the last checkpoint. */
    batchSize?: number;
}

export interface DropOldSpec {
    table: string;
    column: string;
}

/** Coordinator-side marker recorded in migrations.sqlite while Phase 2
 *  is in progress. Sprint Z bulk loader + hot write paths consult
 *  `dualWriteActiveFor(table, column)` and mirror writes to the new
 *  column too, so no row written during Phase 2 is lost. */
export interface DualWriteState {
    table: string;
    /** Old column name (writes mirror to newColumn). */
    fromColumn: string;
    /** New column name. */
    toColumn: string;
    /** Migration row id that owns this dual-write window. */
    migrationId: string;
}

export interface AdapterCapabilities {
    addColumn: boolean;
    addTable: boolean;
    addIndex: boolean;
    /** Native rename (single-statement) — false today on every substrate,
     *  decomposed via expand/migrate/contract in H2. */
    renameColumn: boolean;
    /** Native column-type change — false today; H2 decomposes. */
    changeType: boolean;
    /** Native drop column — sqlite>=3.35 supports; kuzu does not. */
    dropColumn: boolean;
}

/**
 * SubstrateMigrationAdapter — cloud-compatible by design.
 *
 * Each method MUST be online: the substrate stays writable for in-flight
 * traffic while the schema change is applied. If the substrate cannot
 * meet that contract for a given verb, capabilities() returns false and
 * the coordinator throws CapabilityNotSupported before any side effect.
 */
export interface SubstrateMigrationAdapter {
    readonly substrate: SubstrateName;
    capabilities(): AdapterCapabilities;

    // ----- additive (H1) -----
    addColumn(spec: AddColumnSpec): Promise<AdapterOpResult>;
    addTable(spec: AddTableSpec): Promise<AdapterOpResult>;
    addIndex(spec: AddIndexSpec): Promise<AdapterOpResult>;

    /** Reverse the most recent additive op for rollback. Coordinator
     *  passes back the spec it previously applied. Adapters MUST be
     *  idempotent: removing an already-removed column is success. */
    reverseAddColumn(spec: AddColumnSpec): Promise<AdapterOpResult>;
    reverseAddTable(spec: AddTableSpec): Promise<AdapterOpResult>;
    reverseAddIndex(spec: AddIndexSpec): Promise<AdapterOpResult>;

    // ----- destructive (H2 — wired via expand/migrate/contract) -----
    /** Phase 1 EXPAND for rename — add new column alongside old. */
    prepareRename(spec: PrepareRenameSpec): Promise<AdapterOpResult>;
    /** Phase 1 EXPAND for type-change — add replacement column with new type. */
    prepareTypeChange(spec: PrepareTypeChangeSpec): Promise<AdapterOpResult>;
    /** Phase 1 EXPAND for drop — marker only; column stays until Phase 3. */
    prepareDropColumn(spec: PrepareDropColumnSpec): Promise<AdapterOpResult>;
    /** Phase 2 MIGRATE — batched backfill from fromColumn to toColumn. */
    migrateData(spec: MigrateDataSpec): Promise<AdapterOpResult>;
    /** Phase 3 CONTRACT — remove the old column. On substrates that
     *  cannot drop (kuzu), null-out + leave-in-place; result.detail
     *  carries `{ workaround: 'leave-in-place' }` so the coordinator
     *  surfaces it to the operator. */
    dropOld(spec: DropOldSpec): Promise<AdapterOpResult>;
    /** Phase 3 CONTRACT, ATOMIC form (4.4, 2026-08-18): catch-up backfill
     *  from fromColumn to toColumn AND drop of `column` in ONE substrate
     *  transaction, so writes that landed during the Phase-2 dual-write
     *  window cannot be lost — they are either committed before the
     *  transaction (and copied) or land after it (and fail loudly against
     *  the post-contract schema). Optional: adapters without it get the
     *  coordinator's back-to-back migrateData + dropOld fallback. */
    contract?(spec: { table: string; fromColumn: string; toColumn: string; column: string; batchSize?: number }): Promise<AdapterOpResult>;
    /** Native single-statement column rename. False on every substrate
     *  today — H2 decomposes via prepareRename/migrateData/dropOld. */
    renameColumn?(spec: { table: string; fromColumn: string; toColumn: string }): Promise<AdapterOpResult>;
    changeType?(spec: { table: string; column: string; newType: string }): Promise<AdapterOpResult>;
    dropColumn?(spec: DropOldSpec): Promise<AdapterOpResult>;
}

/**
 * Op kind discriminator for the migrations table + CLI spec files.
 * Mirrored in the outbox payload so dispatchers can self-heal.
 */
export type MigrationKind =
    | 'add_column'
    | 'add_table'
    | 'add_index'
    // H2 — declared for table stability; runtime lands in H2.
    | 'prepare_rename'
    | 'migrate_data'
    | 'drop_old'
    | 'rename_column'
    | 'change_type'
    | 'drop_column';

/**
 * Migration spec — what the operator's JSON file looks like, and what
 * the coordinator persists into the migrations table.
 *
 * `target` is the substrate-specific table identifier (SQLite table
 * name, kuzu node-table name, lance dataset name). `params` carries
 * op-kind-specific fields (column DDL, index name, etc.) so the spec
 * stays a single JSON envelope.
 *
 * `workspace` follows Sprint L invariant: schema changes scoped to a
 * single workspace carry that workspace name; global schemas
 * (outbox_entries, migrations itself) carry '*'.
 */
export interface MigrationSpec {
    id: string;
    kind: MigrationKind;
    substrate: SubstrateName;
    target: string;
    workspace: string;
    params: Record<string, unknown>;
    /** Optional operator note surfaced in `lore migrate list`. */
    note?: string;
}

/** Row shape persisted in the migrations sqlite table. */
export interface MigrationRow {
    id: string;
    kind: MigrationKind;
    substrate: SubstrateName;
    target: string;
    workspace: string;
    phase: MigrationPhase;
    status: MigrationStatus;
    /** JSON-serialized MigrationSpec.params for replay/rollback. */
    paramsJson: string;
    appliedAt?: string;
    error?: string;
    createdAt: string;
    updatedAt: string;
}

export class CapabilityNotSupportedError extends Error {
    readonly substrate: SubstrateName;
    readonly verb: string;
    readonly hint: string;
    constructor(substrate: SubstrateName, verb: string, hint: string) {
        super(`migration adapter '${substrate}' does not support '${verb}': ${hint}`);
        this.name = 'CapabilityNotSupportedError';
        this.substrate = substrate;
        this.verb = verb;
        this.hint = hint;
    }
}
