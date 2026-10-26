/**
 * postgresPlanAlias.ts - make plan `eq` / `in` filters on a string column match the canonical spelling AND its aliases
 * (design section 9 Q5), without touching the fixed SQL templates.
 *
 * Before the steps run, each such predicate is rewritten to an `in` list: the values the plan named, plus every stored
 * spelling of that column whose normalised form belongs to the same alias group. The group lookup is the per-workspace
 * alias table (`lore_entity_alias`); the stored spellings come from one bounded DISTINCT scan of the column. Only
 * values that resolve through the alias table (directly as a canonical or an alias) are widened - a value with no
 * alias entry keeps its exact-equality meaning, so a workspace with no aliases behaves exactly as before.
 * `neq`, `contains`, `starts_with` and the range operators are NOT alias-aware (documented limitation).
 */

import type { PoolClient } from 'pg';
import type { AliasApplied, Bound, ValidPredicate, ValidStep } from '../../query/planTypes.js';
import { normaliseAliasValue } from '../../query/aliasNormalise.js';
import type { TableMeta } from './postgresTableCatalog.js';
import { loadAliasIndex, scanSpellings } from './postgresTableAlias.js';

export async function expandAliasPredicates(
    client: PoolClient, workspace: string, tables: ReadonlyMap<string, TableMeta>, steps: readonly ValidStep[],
): Promise<{ steps: ValidStep[]; applied: AliasApplied[] }> {
    const typeOf = new Map<string, string>();
    for (const st of steps) {
        if ((st.op === 'filter' && st.type !== undefined) || st.op === 'join') typeOf.set(st.alias, st.type!);
    }
    const candidates = (st: ValidStep): ValidPredicate[] => {
        if (st.op !== 'filter') return [];
        const meta = tables.get(typeOf.get(st.alias) ?? '');
        return meta ? st.where.filter(p => (p.op === 'eq' || p.op === 'in') && meta.fields.get(p.field)?.col.type === 'string' && !meta.fields.get(p.field)?.header) : [];
    };
    const fieldIds = new Set<number>();
    for (const st of steps) {
        const meta = st.op === 'filter' ? tables.get(typeOf.get(st.alias) ?? '') : undefined;
        for (const p of candidates(st)) fieldIds.add(meta!.fields.get(p.field)!.fieldId);
    }
    if (fieldIds.size === 0) return { steps: [...steps], applied: [] };
    const index = await loadAliasIndex(client, workspace, [...fieldIds]);
    if (index.size === 0) return { steps: [...steps], applied: [] };

    const scans = new Map<string, Array<{ value: string; norm: string }>>();
    const applied: AliasApplied[] = [];
    const out: ValidStep[] = [];
    for (let i = 0; i < steps.length; i++) {
        const st = steps[i]!;
        const meta = st.op === 'filter' ? tables.get(typeOf.get(st.alias) ?? '') : undefined;
        if (st.op !== 'filter' || !meta) { out.push(st); continue; }
        const cand = new Set(candidates(st));
        const where: ValidPredicate[] = [];
        for (const p of st.where) {
            const fm = cand.has(p) ? meta.fields.get(p.field)! : undefined;
            const idx = fm ? index.get(fm.fieldId) : undefined;
            if (!fm || !idx) { where.push(p); continue; }
            const given = (p.op === 'eq' ? [p.bound] : (p.bound as Bound[])).map(String);
            const groups = new Set<string>();
            for (const g of given) { const c = idx.get(normaliseAliasValue(g)); if (c !== undefined) groups.add(c); }
            if (groups.size === 0) { where.push(p); continue; }
            const key = `${meta.entityTypeId}:${p.field}`;
            if (!scans.has(key)) scans.set(key, (await scanSpellings(client, meta, p.field)).map(s => ({ value: s.value, norm: normaliseAliasValue(s.value) })));
            const matched = scans.get(key)!.filter(s => s.norm !== '' && groups.has(idx.get(s.norm) ?? '')).map(s => s.value);
            const bound = [...new Set([...given, ...matched])];
            where.push({ field: p.field, op: 'in', bound });
            applied.push({ step: i + 1, alias: st.alias, field: p.field, given, matched: bound.filter(v => !given.includes(v)) });
        }
        out.push({ ...st, where });
    }
    return { steps: out, applied };
}
