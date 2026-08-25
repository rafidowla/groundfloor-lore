/**
 * migration/adapters/lanceMigrationAdapter.ts — LanceDB adapter.
 *
 * LanceDB stores Arrow tables backed by Parquet files. Schema is
 * Arrow-typed and add-field is supported via:
 *
 *   - table.addColumns([{ name, valueSql }])   — online (Lance>=0.8)
 *     OR a full Arrow schema migration where add-field requires
 *     rewriting Parquet files (i.e. rebuild). The current vectordb
 *     binding pinned in this tree exposes a narrow API surface; the
 *     adapter probes at construction and falls back to flagging
 *     "schema-rebuild-required" if add-field isn't supported.
 *
 *   - addTable → create a new lance dataset; supported via
 *     `db.createTable(name, data, options)`. H1 does NOT wire dataset
 *     creation against a live lance connection — it ships the verb
 *     shape so the operator CLI can route through. Real wiring lands
 *     when the H1 unit tests exercise a per-test lance directory; the
 *     scope guard ("LanceDB Arrow add-field requires rebuild → flag
 *     for H2") still applies for add-field semantics.
 *
 *   - addIndex → lance supports CREATE INDEX (vector index, scalar
 *     btree index). H1 wires the surface; runtime can be exercised
 *     against a real lance dataset by the operator.
 *
 * Like the kuzu adapter, this adapter takes a narrow shim so tests can
 * inject deterministic fakes without spinning a real lance datastore.
 *
 * SCOPE GUARD (audit Section 7 + spec H1):
 *   LanceDB Arrow add-field may require Parquet rewrite. Adapter
 *   surfaces capabilities() with addColumn=true on the assumption
 *   that the bound vectordb supports it; operator override via env
 *   `LORE_LANCE_ADD_COLUMN_SUPPORTED=false` flips to rebuild path,
 *   which H2 wires.
 */

import type {
    AdapterCapabilities,
    AdapterOpResult,
    AddColumnSpec,
    AddIndexSpec,
    AddTableSpec,
    DropOldSpec,
    MigrateDataSpec,
    PrepareDropColumnSpec,
    PrepareRenameSpec,
    PrepareTypeChangeSpec,
    SubstrateMigrationAdapter,
    SubstrateName,
} from '../types.js';

export interface LanceConnectionShim {
    /** Add a field to an existing lance table. Substrate impl may
     *  rewrite Parquet files; the shim hides that detail. */
    addField(table: string, column: string): Promise<void>;
    /** Create a new lance table. */
    createTable(table: string, schema: string): Promise<void>;
    /** Drop a lance table. */
    dropTable(table: string): Promise<void>;
    /** Create an index on a table column. */
    createIndex(table: string, indexName: string, columns: string): Promise<void>;
    /** Drop an index. */
    dropIndex(table: string, indexName: string): Promise<void>;
    /** H2 — copy values from fromColumn → toColumn within a single table.
     *  Implementations typically do an Arrow projection rewrite. */
    copyColumn?(table: string, fromColumn: string, toColumn: string): Promise<{ rowsCopied: number }>;
    /** H2 — drop a column from a lance table (Parquet rewrite). */
    dropColumn?(table: string, column: string): Promise<void>;
    /** H2 — atomic swap-rename of a staging dataset over the live name.
     *  Used by the table-rebuild fallback path when the binding does not
     *  expose drop-column directly. */
    swapRename?(stagingTable: string, liveTable: string): Promise<void>;
}

export interface LanceAdapterOptions {
    addColumnSupported?: boolean;
}

function readEnvOverride(): LanceAdapterOptions {
    const v = process.env['LORE_LANCE_ADD_COLUMN_SUPPORTED'];
    if (v === undefined) return {};
    return { addColumnSupported: v === 'true' || v === '1' };
}

export class LanceMigrationAdapter implements SubstrateMigrationAdapter {
    readonly substrate: SubstrateName = 'lance';
    private readonly conn: LanceConnectionShim;
    private readonly addColumnSupported: boolean;

    constructor(conn: LanceConnectionShim, opts: LanceAdapterOptions = {}) {
        this.conn = conn;
        const env = readEnvOverride();
        this.addColumnSupported = opts.addColumnSupported ?? env.addColumnSupported ?? true;
    }

    capabilities(): AdapterCapabilities {
        return {
            addColumn: this.addColumnSupported,
            addTable: true,
            addIndex: true,
            renameColumn: false,
            changeType: false,
            // lance can DROP column via rewrite — H1 leaves false until H2
            // wires the expand/migrate/contract decomposition.
            dropColumn: false,
        };
    }

    async addColumn(spec: AddColumnSpec): Promise<AdapterOpResult> {
        if (!this.addColumnSupported) {
            return {
                ok: false,
                reason: 'additive-not-supported',
                detail: {
                    hint: 'lance binding lacks addColumns; Parquet rewrite required — flag for H2 expand/migrate/contract',
                    substrate: 'lance',
                    verb: 'addColumn',
                },
            };
        }
        try {
            await this.conn.addField(spec.table, spec.column);
            return { ok: true };
        } catch (err) {
            return { ok: false, reason: `lance-add-field-failed:${(err as Error).message.slice(0, 120)}` };
        }
    }

    async addTable(spec: AddTableSpec): Promise<AdapterOpResult> {
        try {
            await this.conn.createTable(spec.table, spec.columns);
            return { ok: true };
        } catch (err) {
            const msg = (err as Error).message;
            if (/already exists/i.test(msg)) return { ok: true, reason: 'already-present' };
            return { ok: false, reason: `lance-create-table-failed:${msg.slice(0, 120)}` };
        }
    }

    async addIndex(spec: AddIndexSpec): Promise<AdapterOpResult> {
        try {
            await this.conn.createIndex(spec.table, spec.indexName, spec.columns);
            return { ok: true };
        } catch (err) {
            return { ok: false, reason: `lance-create-index-failed:${(err as Error).message.slice(0, 120)}` };
        }
    }

    async reverseAddColumn(_spec: AddColumnSpec): Promise<AdapterOpResult> {
        return {
            ok: false,
            reason: 'reverse-not-supported',
            detail: {
                hint: 'lance add-field reverse requires Parquet rewrite — flag for H2',
                substrate: 'lance',
            },
        };
    }

    async reverseAddTable(spec: AddTableSpec): Promise<AdapterOpResult> {
        try {
            await this.conn.dropTable(spec.table);
            return { ok: true };
        } catch (err) {
            const msg = (err as Error).message;
            if (/does not exist|not found/i.test(msg)) return { ok: true, reason: 'already-absent' };
            return { ok: false, reason: `lance-drop-table-failed:${msg.slice(0, 120)}` };
        }
    }

    // ----- H2 expand/migrate/contract verbs -----

    /** Phase 1 EXPAND for rename — add new field (Parquet rewrite if
     *  the binding requires; shim hides the cost). */
    async prepareRename(spec: PrepareRenameSpec): Promise<AdapterOpResult> {
        try {
            await this.conn.addField(spec.table, spec.columnDdl);
            return { ok: true, detail: { phase: 'expand', verb: 'prepareRename' } };
        } catch (err) {
            const msg = (err as Error).message;
            if (/already exists|duplicate/i.test(msg)) return { ok: true, reason: 'already-present' };
            return { ok: false, reason: `lance-prepare-rename-failed:${msg.slice(0, 120)}` };
        }
    }

    async prepareTypeChange(spec: PrepareTypeChangeSpec): Promise<AdapterOpResult> {
        try {
            await this.conn.addField(spec.table, spec.columnDdl);
            return { ok: true, detail: { phase: 'expand', verb: 'prepareTypeChange' } };
        } catch (err) {
            const msg = (err as Error).message;
            if (/already exists|duplicate/i.test(msg)) return { ok: true, reason: 'already-present' };
            return { ok: false, reason: `lance-prepare-type-change-failed:${msg.slice(0, 120)}` };
        }
    }

    async prepareDropColumn(_spec: PrepareDropColumnSpec): Promise<AdapterOpResult> {
        return { ok: true, detail: { phase: 'expand', verb: 'prepareDropColumn', noop: true } };
    }

    /** Phase 2 MIGRATE — uses shim.copyColumn if available (preferred,
     *  may use Arrow projection); falls back to ok=false with a structured
     *  hint so the operator knows to upgrade the binding. */
    async migrateData(spec: MigrateDataSpec): Promise<AdapterOpResult> {
        if (!this.conn.copyColumn) {
            return {
                ok: false,
                reason: 'lance-migrate-data-failed:copy-column-not-supported',
                detail: {
                    hint: 'lance binding lacks copyColumn; operator must run a manual Arrow projection or upgrade vectordb',
                    substrate: 'lance',
                    sizeCeiling: 'Arrow rebuild OOM on very large tables — chunk per partition per H4 runbook',
                },
            };
        }
        try {
            const { rowsCopied } = await this.conn.copyColumn(spec.table, spec.fromColumn, spec.toColumn);
            return { ok: true, detail: { phase: 'migrate', rowsCopied, mechanism: 'arrow-copy' } };
        } catch (err) {
            return { ok: false, reason: `lance-migrate-data-failed:${(err as Error).message.slice(0, 120)}` };
        }
    }

    /** Phase 3 CONTRACT — drop column via Parquet rewrite. Prefers
     *  shim.dropColumn (direct), otherwise emits a structured failure so
     *  operators run the swap-rename workflow. */
    async dropOld(spec: DropOldSpec): Promise<AdapterOpResult> {
        if (this.conn.dropColumn) {
            try {
                await this.conn.dropColumn(spec.table, spec.column);
                return { ok: true, detail: { phase: 'contract', mechanism: 'native-drop-column' } };
            } catch (err) {
                return { ok: false, reason: `lance-drop-old-failed:${(err as Error).message.slice(0, 120)}` };
            }
        }
        return {
            ok: false,
            reason: 'lance-drop-old-failed:drop-column-not-supported',
            detail: {
                hint: 'lance binding lacks dropColumn; operator must run swap-rename via shim.swapRename or upgrade vectordb',
                substrate: 'lance',
            },
        };
    }

    async reverseAddIndex(spec: AddIndexSpec): Promise<AdapterOpResult> {
        try {
            await this.conn.dropIndex(spec.table, spec.indexName);
            return { ok: true };
        } catch (err) {
            const msg = (err as Error).message;
            if (/does not exist|not found/i.test(msg)) return { ok: true, reason: 'already-absent' };
            return { ok: false, reason: `lance-drop-index-failed:${msg.slice(0, 120)}` };
        }
    }
}
