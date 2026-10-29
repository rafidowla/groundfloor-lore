/**
 * postgresTableEvolve.ts - additive schema evolution for PostgresTableStorage.
 *
 * Runs on a caller-supplied client inside a caller-owned transaction (the caller
 * also holds the per-workspace table advisory lock). Same contract as
 * SqliteTableStorage.evolveSchema: add columns, add indexes, record
 * extractedFields; refuse removals, type changes and primary-key changes.
 * Differences from SQLite: a new UNIQUE column is allowed (a partial unique
 * index, not an ALTER), and a required column added to a non-empty table is
 * backfilled only for string/integer/float/boolean (date/datetime/json throw -
 * there is no honest default for them).
 */

import type { PoolClient } from 'pg';
import type { ColumnDecl, EvolutionStep, TableSchema } from '../../contracts/tables.js';
import { assertIdent } from '../whereClause.js';
import { TABLE_TABLES, VALUE_COLUMN, PG_TYPE } from './postgresTableSchema.js';
import { RESERVED, buildMeta, flagsOf, validateSchema, type TableMeta } from './postgresTableCatalog.js';
import { fieldIndexDdl, viewDdl } from './postgresTableViews.js';

const BACKFILL: Partial<Record<ColumnDecl['type'], string | number | boolean>> = { string: '', integer: 0, float: 0, boolean: false };

export async function evolveTable(
    client: PoolClient, workspace: string, current: TableMeta, name: string, next: TableSchema,
): Promise<{ steps: EvolutionStep[]; meta: TableMeta }> {
    if (next.name !== name) {
        throw new Error(`evolveSchema: name mismatch (current '${name}' vs new '${next.name}'). Rename is a destructive change - use the Phase 4 orchestrator.`);
    }
    validateSchema(next);
    const oldByName = new Map(current.schema.columns.map(c => [c.name, c]));
    const newByName = new Map(next.columns.map(c => [c.name, c]));
    for (const old of current.schema.columns) {
        const n = newByName.get(old.name);
        if (!n) throw new Error(`evolveSchema: column '${old.name}' was removed. Destructive. Use the Phase 4 expand->migrate->contract orchestrator.`);
        if (n.type !== old.type) throw new Error(`evolveSchema: column '${old.name}' type change ${old.type} -> ${n.type}. Destructive - route via Phase 4 orchestrator.`);
        if (!!n.primary !== !!old.primary) throw new Error(`evolveSchema: column '${old.name}' primary-key flag changed. Destructive.`);
        if (!!n.required !== !!old.required || (old.unique && !n.unique) || (old.indexed && !n.indexed)) {
            throw new Error(`evolveSchema: column '${old.name}' required/unique/indexed flags may only be added as indexes, never removed or made required (destructive).`);
        }
    }

    const { entity, fieldDef, value } = TABLE_TABLES;
    const steps: EvolutionStep[] = [];
    const merged: ColumnDecl[] = current.schema.columns.map(c => ({ ...c }));
    const ids = new Map([...current.fields].map(([k, f]) => [k, f.fieldId] as const));
    const indexDdl: string[] = [];

    const total = Number((await client.query(
        `SELECT count(*) AS c FROM ${entity} WHERE workspace_id = $1 AND entity_type_id = $2`, [workspace, current.entityTypeId])).rows[0].c);

    // Existing columns: index / unique additions and newly recorded extractedFields.
    for (let i = 0; i < merged.length; i++) {
        const old = merged[i]!;
        const n = newByName.get(old.name)!;
        const addUnique = !!n.unique && !old.unique;
        const addIndexed = !!n.indexed && !old.indexed && !n.unique;
        const oldKeys = new Set((old.extractedFields ?? []).map(e => e.key));
        const newEfs = (n.extractedFields ?? []).filter(e => !oldKeys.has(e.key));
        if (!addUnique && !addIndexed && newEfs.length === 0) continue;
        const upd: ColumnDecl = { ...old, unique: addUnique ? true : old.unique, indexed: addIndexed || n.indexed ? true : old.indexed };
        if (n.extractedFields) upd.extractedFields = n.extractedFields.map(e => ({ ...e }));
        merged[i] = upd;
        if (addUnique || addIndexed) {
            indexDdl.push(...fieldIndexDdl(workspace, ids.get(old.name)!, upd));
            steps.push({ kind: 'add_index', column: old.name });
        }
        for (const ef of newEfs) { assertIdent(ef.key); steps.push({ kind: 'add_extracted_field', column: old.name, extractedKey: ef.key }); }
        await client.query(`UPDATE ${fieldDef} SET decl_json = $3, flags = $4 WHERE workspace_id = $1 AND field_id = $2`,
            [workspace, ids.get(old.name), JSON.stringify(upd), flagsOf(upd)]);
    }

    // Brand-new columns.
    for (const col of next.columns) {
        if (oldByName.has(col.name)) continue;
        if (col.primary) throw new Error(`evolveSchema: cannot add a primary-key column ('${col.name}') to an existing table. Primary keys are fixed at create time.`);
        if (col.required && total > 0) {
            if (RESERVED[col.name]) throw new Error(`evolveSchema: cannot add required reserved column '${col.name}' to a non-empty table`);
            if (BACKFILL[col.type] === undefined) {
                throw new Error(`evolveSchema: cannot add required ${col.type} column '${col.name}' to non-empty table '${name}' - no honest backfill default; add it optional.`);
            }
        }
        const r = await client.query(
            `INSERT INTO ${fieldDef} (workspace_id, entity_type_id, name, data_type, flags, position, decl_json)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING field_id`,
            [workspace, current.entityTypeId, col.name, col.type, flagsOf(col), merged.length, JSON.stringify(col)]);
        const fid = Number((r.rows[0] as { field_id: string }).field_id);
        ids.set(col.name, fid);
        merged.push({ ...col });
        steps.push({ kind: 'add_column', column: col.name });
        if (col.required && total > 0) {
            const vc = VALUE_COLUMN[col.type];
            await client.query(
                `INSERT INTO ${value} (workspace_id, entity_id, field_id, ${vc})
                 SELECT workspace_id, entity_id, $3, $4::${PG_TYPE[col.type]} FROM ${entity} WHERE workspace_id = $1 AND entity_type_id = $2`,
                [workspace, current.entityTypeId, String(fid), BACKFILL[col.type]]);
        }
        if (col.unique || col.indexed) {
            indexDdl.push(...fieldIndexDdl(workspace, fid, col));
            if (col.indexed || col.unique) steps.push({ kind: 'add_index', column: col.name });
        }
        for (const ef of col.extractedFields ?? []) { assertIdent(ef.key); steps.push({ kind: 'add_extracted_field', column: col.name, extractedKey: ef.key }); }
    }

    const schema: TableSchema = { ...current.schema, columns: merged };
    const meta = buildMeta(current.entityTypeId, schema, ids, current.createdAt);
    for (const ddl of indexDdl) await client.query(ddl);
    await client.query(viewDdl(workspace, meta));
    return { steps, meta };
}
