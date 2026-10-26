/**
 * planValidator.ts - strict validation of an untrusted query plan against a workspace catalogue (Tables P3).
 *
 * Input: `unknown` JSON. Output: a `ValidPlan` (typed, normalised, values already coerced to their column type)
 * or EVERY reason the plan was refused. Rules, in the order they matter for safety:
 *   - closed grammar: unknown step ops and unknown properties are refused; the deferred ops (follow_link,
 *     semantic_search, judge) and recorded-time as_of answer `not_supported_yet`;
 *   - a plan cannot name a workspace (`workspace_not_allowed`);
 *   - every entity type and field must exist in the catalogue; aliases are plan-local labels and never reach SQL;
 *   - step cap 12, join cap 4 (MAX_JOIN_HOPS), per-step list caps;
 *   - `order`/`limit` are the final shaping steps; `aggregate` is terminal apart from them;
 *   - money is currency-aware (planMoney.ts): comparisons and having thresholds are `{amount, currency}`, the currency is
 *     the pseudo-field `<column>__currency`, and a money group_by/join key is `not_supported_yet`.
 * The validator is pure: it reads only the catalogue map it is given.
 */

import type { TableSchema } from '../contracts/tables.js';
import { encodePgValue } from '../engines/postgres/postgresTableCodec.js';
import {
    DEFERRED_OPS, MAX_GROUP_KEYS, MAX_HAVING, MAX_IN_VALUES, MAX_MEASURES, MAX_ORDER_KEYS, MAX_PLAN_JOINS, MAX_PLAN_LIMIT,
    MAX_PLAN_STEPS, MAX_PREDICATES, MAX_VALUE_CHARS, PLAN_VERSION,
    type AggFn, type Bound, type ColumnKind, type HavingOp, type IssueCode, type MoneyBound, type PlanIssue, type PlanValidation,
    type PredOp, type ValidHaving, type ValidMeasure, type ValidOrderKey, type ValidPlan, type ValidPredicate, type ValidStep,
} from './planTypes.js';
import { bindCurrencyCode, bindMoneyValue, currencyBase } from './planMoney.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const LABEL_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const WORKSPACE_KEYS = new Set(['workspace', 'workspace_id', 'workspaceId', 'tenant', 'tenant_id', 'tenantId']);
const PRED_OPS: readonly PredOp[] = ['eq', 'neq', 'in', 'gt', 'gte', 'lt', 'lte', 'contains', 'starts_with', 'is_null', 'not_null'];
const AGG_FNS: readonly AggFn[] = ['count', 'sum', 'avg', 'min', 'max'];
const HAVING_OPS: readonly HavingOp[] = ['gt', 'gte', 'lt', 'lte', 'eq', 'neq'];
const RANGE_KINDS: readonly ColumnKind[] = ['string', 'integer', 'float', 'date', 'datetime'];
const NUMERIC: readonly ColumnKind[] = ['integer', 'float'];
const INT64_MAX = 9223372036854775807n;

interface Source { type: string; schema: TableSchema }

/** `money` = a money column (amount + currency); `currency` = the `<money column>__currency` pseudo-field. */
type PlanKind = ColumnKind | 'money' | 'currency';
const MONEY_CMP_OPS: readonly PredOp[] = ['eq', 'neq', 'in', 'gt', 'gte', 'lt', 'lte', 'is_null', 'not_null'];
const CURRENCY_OPS: readonly PredOp[] = ['eq', 'neq', 'in', 'is_null', 'not_null'];
const MONEY_FNS: readonly AggFn[] = ['sum', 'avg', 'min', 'max'];

class Ctx {
    readonly issues: PlanIssue[] = [];
    add(code: IssueCode, step: number | null, path: string, message: string): void {
        this.issues.push({ code, step, path, message });
    }
}

function strictKeys(o: Obj, allowed: readonly string[], c: Ctx, step: number | null, path: string): void {
    for (const k of Object.keys(o)) {
        if (allowed.includes(k)) continue;
        if (WORKSPACE_KEYS.has(k)) c.add('workspace_not_allowed', step, `${path}.${k}`, 'a plan cannot name a workspace; the caller supplies it');
        else c.add('unknown_property', step, `${path}.${k}`, `unknown property '${k}'`);
    }
}

/** Kind for a plan reference: `undefined` = no such field. A money column is `money`; `<money>__currency` is `currency`. */
function kindOf(s: Source, field: string): PlanKind | undefined {
    const t = s.schema.columns.find(col => col.name === field)?.type;
    if (t !== undefined) return t;
    return currencyBase(s.schema, field) !== undefined ? 'currency' : undefined;
}

function label(v: unknown, c: Ctx, step: number, path: string, what: string): string | undefined {
    if (typeof v !== 'string' || !LABEL_RE.test(v)) {
        c.add('invalid_plan', step, path, `${what} must match ${LABEL_RE.source}`);
        return undefined;
    }
    return v;
}

/** Coerce one JSON value to the bound form of a column type, or explain why not. */
function bind(v: unknown, kind: ColumnKind, ctx: string): { ok: true; value: Bound } | { ok: false; message: string } {
    if (kind === 'json') return { ok: false, message: `${ctx}: json columns support only is_null / not_null` };
    if (v === null || v === undefined) return { ok: false, message: `${ctx}: a value is required (use is_null / not_null for nulls)` };
    if (typeof v === 'string' && (v.length > MAX_VALUE_CHARS || v.includes('\u0000'))) {
        return { ok: false, message: `${ctx}: string too long or contains a NUL character` };
    }
    if (kind === 'string' && typeof v !== 'string') return { ok: false, message: `${ctx}: expected a string` };
    if (typeof v === 'object') return { ok: false, message: `${ctx}: expected a scalar` };
    try {
        const e = encodePgValue(v, kind, ctx);
        if (kind === 'integer' && typeof e === 'string') {
            const n = BigInt(e);
            if (n > INT64_MAX || n < -INT64_MAX - 1n) return { ok: false, message: `${ctx}: integer out of 64-bit range` };
        }
        return { ok: true, value: e };
    } catch (err) {
        return { ok: false, message: (err as Error).message.replace(/^PostgresTableStorage:\s*/, '') };
    }
}

function resolveAlias(aliases: Map<string, Source>, a: unknown, c: Ctx, step: number, path: string): Source | undefined {
    if (typeof a !== 'string' || !aliases.has(a)) {
        c.add('unknown_alias', step, path, `alias ${JSON.stringify(a)} is not declared by an earlier step`);
        return undefined;
    }
    return aliases.get(a);
}

function colRef(o: unknown, aliases: Map<string, Source>, c: Ctx, step: number, path: string): { alias: string; field: string; kind: PlanKind } | undefined {
    if (!isObj(o)) { c.add('invalid_plan', step, path, 'expected {alias, field}'); return undefined; }
    strictKeys(o, ['alias', 'field'], c, step, path);
    const src = resolveAlias(aliases, o['alias'], c, step, `${path}.alias`);
    if (!src) return undefined;
    const field = o['field'];
    const kind = typeof field === 'string' ? kindOf(src, field) : undefined;
    if (kind === undefined) {
        c.add('unknown_field', step, `${path}.field`, `field ${JSON.stringify(field)} does not exist on type '${src.type}'`);
        return undefined;
    }
    return { alias: o['alias'] as string, field: field as string, kind };
}

function predicates(raw: unknown, src: Source, c: Ctx, step: number, path: string): ValidPredicate[] {
    if (!Array.isArray(raw)) { c.add('invalid_plan', step, path, 'where must be an array'); return []; }
    if (raw.length > MAX_PREDICATES) c.add('cap_exceeded', step, path, `at most ${MAX_PREDICATES} predicates per filter`);
    const out: ValidPredicate[] = [];
    raw.slice(0, MAX_PREDICATES).forEach((p, i) => {
        const pp = `${path}[${i}]`;
        if (!isObj(p)) { c.add('invalid_plan', step, pp, 'a predicate must be an object'); return; }
        strictKeys(p, ['field', 'op', 'value'], c, step, pp);
        const field = p['field'], op = p['op'] as PredOp;
        const kind = typeof field === 'string' ? kindOf(src, field) : undefined;
        if (kind === undefined) { c.add('unknown_field', step, `${pp}.field`, `field ${JSON.stringify(field)} does not exist on type '${src.type}'`); return; }
        if (typeof op !== 'string' || !PRED_OPS.includes(op)) { c.add('bad_operator', step, `${pp}.op`, `operator must be one of ${PRED_OPS.join(', ')}`); return; }
        if (op === 'is_null' || op === 'not_null') {
            if (p['value'] !== undefined) c.add('bad_value', step, `${pp}.value`, `${op} takes no value`);
            else out.push({ field: field as string, op });
            return;
        }
        if (kind === 'money' || kind === 'currency') {
            const allowed = kind === 'money' ? MONEY_CMP_OPS : CURRENCY_OPS;
            if (!allowed.includes(op)) { c.add('type_mismatch', step, `${pp}.op`, `${op} is not defined for ${kind === 'money' ? 'money columns' : 'currency fields'} (allowed: ${allowed.join(', ')})`); return; }
            const ctx = `${pp}.value`;
            const one = (v: unknown, at: string): { ok: true; value: MoneyBound | string } | { ok: false; message: string } =>
                kind === 'money' ? bindMoneyValue(v, at) : bindCurrencyCode(v, at);
            const field_ = field as string;
            const put = (vals: Array<MoneyBound | string>, single: boolean): void => {
                if (kind === 'money') out.push({ field: field_, op, money: single ? vals[0] as MoneyBound : vals as MoneyBound[] });
                else out.push({ field: field_, op, bound: single ? vals[0] as string : vals as string[] });
            };
            if (op === 'in') {
                const vals = p['value'];
                if (!Array.isArray(vals) || vals.length === 0 || vals.length > MAX_IN_VALUES) { c.add('bad_value', step, ctx, `in needs a non-empty array of at most ${MAX_IN_VALUES} values`); return; }
                const bound: Array<MoneyBound | string> = [];
                for (let j = 0; j < vals.length; j++) {
                    const b = one(vals[j], `${ctx}[${j}]`);
                    if (!b.ok) { c.add('bad_value', step, `${ctx}[${j}]`, b.message); return; }
                    bound.push(b.value);
                }
                put(bound, false);
                return;
            }
            const b = one(p['value'], ctx);
            if (!b.ok) { c.add('bad_value', step, ctx, b.message); return; }
            put([b.value], true);
            return;
        }
        if (kind === 'json') { c.add('type_mismatch', step, pp, 'json columns support only is_null / not_null'); return; }
        if ((op === 'contains' || op === 'starts_with') && kind !== 'string') { c.add('type_mismatch', step, `${pp}.op`, `${op} needs a string column`); return; }
        if ((op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') && !RANGE_KINDS.includes(kind)) { c.add('type_mismatch', step, `${pp}.op`, `${op} is not defined for ${kind} columns`); return; }
        const ctx = `${pp}.value`;
        if (op === 'in') {
            const vals = p['value'];
            if (!Array.isArray(vals) || vals.length === 0 || vals.length > MAX_IN_VALUES) {
                c.add('bad_value', step, ctx, `in needs a non-empty array of at most ${MAX_IN_VALUES} values`); return;
            }
            const bound: Bound[] = [];
            for (let j = 0; j < vals.length; j++) {
                const b = bind(vals[j], kind, `${ctx}[${j}]`);
                if (!b.ok) { c.add('bad_value', step, `${ctx}[${j}]`, b.message); return; }
                bound.push(b.value);
            }
            out.push({ field: field as string, op, bound });
            return;
        }
        const b = bind(p['value'], kind, ctx);
        if (!b.ok) { c.add('bad_value', step, ctx, b.message); return; }
        if ((op === 'contains' || op === 'starts_with') && String(b.value).length === 0) { c.add('bad_value', step, ctx, `${op} needs a non-empty string`); return; }
        out.push({ field: field as string, op, bound: b.value });
    });
    return out;
}

/** Remember which currencies a money predicate (or a `<money>__currency` equals/in) limits its column to. */
function pinCurrency(pins: Map<string, string[]>, alias: string, src: Source, p: ValidPredicate): void {
    let base: string | undefined, cur: string[] | undefined;
    if (p.money !== undefined) {
        base = p.field;
        cur = (Array.isArray(p.money) ? p.money : [p.money]).map(m => m.currency);
    } else if ((p.op === 'eq' || p.op === 'in') && p.bound !== undefined) {
        base = currencyBase(src.schema, p.field);
        cur = (Array.isArray(p.bound) ? p.bound : [p.bound]).map(String);
    }
    if (base === undefined || cur === undefined) return;
    const key = `${alias}.${base}`, now = [...new Set(cur)], prev = pins.get(key);
    pins.set(key, prev ? prev.filter(x => now.includes(x)) : now);
}

export function validatePlan(input: unknown, catalogue: ReadonlyMap<string, TableSchema>): PlanValidation {
    const c = new Ctx();
    if (!isObj(input)) return { ok: false, errors: [{ code: 'invalid_plan', step: null, path: '$', message: 'a plan must be a JSON object {version?, steps}' }] };
    strictKeys(input, ['version', 'steps'], c, null, '$');
    if (input['version'] !== undefined && input['version'] !== PLAN_VERSION) c.add('invalid_plan', null, '$.version', `version must be ${PLAN_VERSION}`);
    const raw = input['steps'];
    if (!Array.isArray(raw) || raw.length === 0) {
        c.add('invalid_plan', null, '$.steps', 'steps must be a non-empty array');
        return { ok: false, errors: c.issues };
    }
    if (raw.length > MAX_PLAN_STEPS) {
        c.add('step_cap', null, '$.steps', `a plan may have at most ${MAX_PLAN_STEPS} steps (got ${raw.length})`);
        return { ok: false, errors: c.issues };
    }

    const aliases = new Map<string, Source>();
    /** `alias.moneyColumn` -> the currencies earlier filters limit it to (drives the static having-currency check). */
    const pins = new Map<string, string[]>();
    const steps: ValidStep[] = [];
    let sourced = false, aggregated = false, joins = 0, ordered = false, limited = false;
    let measures = new Map<string, ValidMeasure>();
    let groupKeys: Array<{ alias: string; field: string }> = [];

    raw.forEach((s, idx) => {
        const n = idx + 1, path = `$.steps[${idx}]`;
        if (!isObj(s) || typeof s['op'] !== 'string') { c.add('invalid_plan', n, path, 'a step must be an object with a string op'); return; }
        const op = s['op'];
        if ((DEFERRED_OPS as readonly string[]).includes(op)) { c.add('not_supported_yet', n, `${path}.op`, `step '${op}' is part of the grammar but not supported yet`); return; }
        if (limited) { c.add('bad_order', n, path, "no step may follow 'limit'"); return; }
        if (ordered && op !== 'limit') { c.add('bad_order', n, path, "only 'limit' may follow 'order'"); return; }
        if (aggregated && op !== 'order' && op !== 'limit') { c.add('bad_order', n, path, `'${op}' cannot follow 'aggregate'; only order and limit can`); return; }
        if (op !== 'filter' && op !== 'as_of' && !sourced && ['join', 'aggregate', 'order', 'limit'].includes(op)) {
            c.add('no_source', n, path, `'${op}' needs a source first: begin with a filter that names a type`); return;
        }

        switch (op) {
            case 'filter': {
                strictKeys(s, ['op', 'type', 'alias', 'where'], c, n, path);
                let alias: string | undefined, type: string | undefined;
                if (s['type'] !== undefined) {
                    if (sourced) { c.add('invalid_plan', n, `${path}.type`, "a filter names a type only as the first source; add more types with 'join'"); return; }
                    const t = s['type'];
                    if (typeof t !== 'string' || !catalogue.has(t)) { c.add('unknown_type', n, `${path}.type`, `entity type ${JSON.stringify(t)} does not exist in this workspace`); return; }
                    type = t;
                    alias = s['alias'] === undefined ? (LABEL_RE.test(t) ? t : undefined) : label(s['alias'], c, n, `${path}.alias`, 'alias');
                    if (alias === undefined) { c.add('invalid_plan', n, `${path}.alias`, 'an alias is required for this type name'); return; }
                    aliases.set(alias, { type, schema: catalogue.get(t)! });
                    sourced = true;
                } else {
                    if (!sourced) { c.add('no_source', n, path, 'the first source must name a type'); return; }
                    if (typeof s['alias'] !== 'string') { c.add('missing_property', n, `${path}.alias`, 'alias is required when no type is given'); return; }
                    alias = s['alias'];
                }
                const src = resolveAlias(aliases, alias, c, n, `${path}.alias`);
                if (!src) return;
                const where = predicates(s['where'] ?? [], src, c, n, `${path}.where`);
                for (const p of where) pinCurrency(pins, alias, src, p);
                steps.push({ op: 'filter', ...(type !== undefined ? { type } : {}), alias, where });
                return;
            }
            case 'join': {
                strictKeys(s, ['op', 'type', 'alias', 'on'], c, n, path);
                if (++joins > MAX_PLAN_JOINS) { c.add('join_hop_cap', n, path, `a plan may have at most ${MAX_PLAN_JOINS} joins`); return; }
                const t = s['type'];
                if (typeof t !== 'string' || !catalogue.has(t)) { c.add('unknown_type', n, `${path}.type`, `entity type ${JSON.stringify(t)} does not exist in this workspace`); return; }
                const alias = s['alias'] === undefined ? (LABEL_RE.test(t) ? t : undefined) : label(s['alias'], c, n, `${path}.alias`, 'alias');
                if (alias === undefined) { c.add('invalid_plan', n, `${path}.alias`, 'an alias is required for this type name'); return; }
                if (aliases.has(alias)) { c.add('duplicate_alias', n, `${path}.alias`, `alias '${alias}' is already used`); return; }
                const on = s['on'];
                if (!isObj(on)) { c.add('missing_property', n, `${path}.on`, 'on must be {left:{alias,field}, right:{field}}'); return; }
                strictKeys(on, ['left', 'right'], c, n, `${path}.on`);
                const left = colRef(on['left'], aliases, c, n, `${path}.on.left`);
                const schema = catalogue.get(t)!;
                const right = on['right'];
                let rightField: string | undefined, rightKind: PlanKind | undefined;
                if (!isObj(right)) c.add('missing_property', n, `${path}.on.right`, 'right must be {field}');
                else {
                    strictKeys(right, ['field'], c, n, `${path}.on.right`);
                    const rk = typeof right['field'] === 'string' ? kindOf({ type: t, schema }, right['field']) : undefined;
                    if (rk === undefined) c.add('unknown_field', n, `${path}.on.right.field`, `field ${JSON.stringify(right['field'])} does not exist on type '${t}'`);
                    else { rightKind = rk; rightField = right['field'] as string; }
                }
                if (left?.kind === 'money') c.add('not_supported_yet', n, `${path}.on.left.field`, `money column '${left.field}' cannot be a join key; join on an id column`);
                if (rightKind === 'money') c.add('not_supported_yet', n, `${path}.on.right.field`, `money column '${String(rightField)}' cannot be a join key; join on an id column`);
                if (!left || rightField === undefined || rightKind === undefined || left.kind === 'money' || rightKind === 'money') return;
                if (left.kind !== rightKind || left.kind === 'json') {
                    c.add('type_mismatch', n, `${path}.on`, `cannot join ${left.kind} to ${rightKind}; both sides must be the same non-json type`); return;
                }
                aliases.set(alias, { type: t, schema });
                steps.push({ op: 'join', type: t, alias, left: { alias: left.alias, field: left.field }, rightField });
                return;
            }
            case 'as_of': {
                strictKeys(s, ['op', 'date', 'time'], c, n, path);
                if (s['time'] === 'recorded') { c.add('not_supported_yet', n, `${path}.time`, 'recorded-time as_of is not supported yet (valid time only)'); return; }
                if (s['time'] !== undefined && s['time'] !== 'valid') { c.add('bad_value', n, `${path}.time`, "time must be 'valid' (or 'recorded', not supported yet)"); return; }
                const d = s['date'];
                if (d !== 'today') {
                    const b = typeof d === 'string' ? bind(d, 'datetime', 'date') : { ok: false as const, message: 'date must be a string' };
                    if (!b.ok) { c.add('bad_value', n, `${path}.date`, `${b.message}; use YYYY-MM-DD, an ISO datetime or "today"`); return; }
                }
                steps.push({ op: 'as_of', date: d as string });
                return;
            }
            case 'aggregate': {
                strictKeys(s, ['op', 'group_by', 'measures', 'having'], c, n, path);
                const gb = s['group_by'] ?? [];
                const ms = s['measures'];
                const hv = s['having'] ?? [];
                if (!Array.isArray(gb) || gb.length > MAX_GROUP_KEYS) { c.add('bad_value', n, `${path}.group_by`, `group_by must be an array of at most ${MAX_GROUP_KEYS} refs`); return; }
                if (!Array.isArray(ms) || ms.length === 0 || ms.length > MAX_MEASURES) { c.add('bad_value', n, `${path}.measures`, `measures must have 1..${MAX_MEASURES} entries`); return; }
                if (!Array.isArray(hv) || hv.length > MAX_HAVING) { c.add('bad_value', n, `${path}.having`, `having must be an array of at most ${MAX_HAVING} entries`); return; }
                const before = c.issues.length;
                const keys: Array<{ alias: string; field: string }> = [];
                gb.forEach((g, i) => {
                    const r = colRef(g, aliases, c, n, `${path}.group_by[${i}]`);
                    if (!r) return;
                    if (r.kind === 'json') c.add('type_mismatch', n, `${path}.group_by[${i}]`, 'cannot group by a json column');
                    else if (r.kind === 'money') c.add('not_supported_yet', n, `${path}.group_by[${i}]`, `cannot group by money column '${r.field}'; group by '${r.field}__currency' (one currency per group)`);
                    else keys.push({ alias: r.alias, field: r.field });
                });
                const named = new Map<string, ValidMeasure>();
                const numericMeasure = new Set<string>();
                const moneyMeasure = new Map<string, string>();
                ms.forEach((m, i) => {
                    const mp = `${path}.measures[${i}]`;
                    if (!isObj(m)) { c.add('invalid_plan', n, mp, 'a measure must be an object'); return; }
                    strictKeys(m, ['fn', 'as', 'alias', 'field'], c, n, mp);
                    const fn = m['fn'] as AggFn;
                    if (typeof fn !== 'string' || !AGG_FNS.includes(fn)) { c.add('bad_operator', n, `${mp}.fn`, `fn must be one of ${AGG_FNS.join(', ')}`); return; }
                    const as = label(m['as'], c, n, `${mp}.as`, 'measure name');
                    if (as === undefined) return;
                    if (named.has(as)) { c.add('duplicate_alias', n, `${mp}.as`, `measure name '${as}' is used twice`); return; }
                    if (fn === 'count' && m['field'] === undefined && m['alias'] === undefined) { named.set(as, { fn, as }); numericMeasure.add(as); return; }
                    const r = colRef({ alias: m['alias'], field: m['field'] }, aliases, c, n, mp);
                    if (!r) return;
                    if (r.kind === 'json') { c.add('type_mismatch', n, mp, 'cannot aggregate a json column'); return; }
                    if (r.kind === 'money' && MONEY_FNS.includes(fn)) {
                        named.set(as, { fn, as, ref: { alias: r.alias, field: r.field } });
                        moneyMeasure.set(as, `${r.alias}.${r.field}`);
                        return;
                    }
                    if (r.kind === 'currency' && fn !== 'count') { c.add('type_mismatch', n, mp, `${fn} is not defined for a currency field; use count`); return; }
                    if (r.kind === 'money' || r.kind === 'currency') {
                        named.set(as, { fn, as, ref: { alias: r.alias, field: r.field } });
                        numericMeasure.add(as);
                        return;
                    }
                    if ((fn === 'sum' || fn === 'avg') && !NUMERIC.includes(r.kind)) { c.add('type_mismatch', n, mp, `${fn} needs an integer or float column`); return; }
                    if ((fn === 'min' || fn === 'max') && !RANGE_KINDS.includes(r.kind)) { c.add('type_mismatch', n, mp, `${fn} is not defined for ${r.kind} columns`); return; }
                    named.set(as, { fn, as, ref: { alias: r.alias, field: r.field } });
                    if (fn !== 'min' && fn !== 'max' || NUMERIC.includes(r.kind)) numericMeasure.add(as);
                });
                const having: ValidHaving[] = [];
                hv.forEach((h, i) => {
                    const hp = `${path}.having[${i}]`;
                    if (!isObj(h)) { c.add('invalid_plan', n, hp, 'a having entry must be an object'); return; }
                    strictKeys(h, ['measure', 'op', 'value'], c, n, hp);
                    const isMoney = typeof h['measure'] === 'string' && moneyMeasure.has(h['measure']);
                    if (typeof h['measure'] !== 'string' || (!numericMeasure.has(h['measure']) && !isMoney)) { c.add('unknown_field', n, `${hp}.measure`, 'having must name a numeric or money measure of this step'); return; }
                    if (typeof h['op'] !== 'string' || !HAVING_OPS.includes(h['op'] as HavingOp)) { c.add('bad_operator', n, `${hp}.op`, `op must be one of ${HAVING_OPS.join(', ')}`); return; }
                    if (isMoney) {
                        const b = bindMoneyValue(h['value'], `${hp}.value`);
                        if (!b.ok) { c.add('bad_value', n, `${hp}.value`, `having threshold on money measure '${h['measure']}': ${b.message}`); return; }
                        const pinned = pins.get(moneyMeasure.get(h['measure'] as string)!);
                        if (pinned && !pinned.includes(b.value.currency)) {
                            c.add('type_mismatch', n, `${hp}.value.currency`, `having threshold is in ${b.value.currency} but an earlier filter limits '${moneyMeasure.get(h['measure'] as string)}' to ${pinned.join(', ')}`);
                            return;
                        }
                        having.push({ measure: h['measure'], op: h['op'] as HavingOp, money: b.value });
                        return;
                    }
                    const v = typeof h['value'] === 'string' && h['value'].trim() !== '' ? Number(h['value']) : h['value'];
                    if (typeof v !== 'number' || !Number.isFinite(v)) { c.add('bad_value', n, `${hp}.value`, 'value must be a finite number'); return; }
                    having.push({ measure: h['measure'], op: h['op'] as HavingOp, value: v });
                });
                if (c.issues.length > before) return;
                aggregated = true; measures = named; groupKeys = keys;
                steps.push({ op: 'aggregate', groupBy: keys, measures: [...named.values()], having });
                return;
            }
            case 'order': {
                strictKeys(s, ['op', 'by'], c, n, path);
                const by = s['by'];
                if (!Array.isArray(by) || by.length === 0 || by.length > MAX_ORDER_KEYS) { c.add('bad_order', n, `${path}.by`, `by must have 1..${MAX_ORDER_KEYS} keys`); return; }
                const keys: ValidOrderKey[] = [];
                by.forEach((k, i) => {
                    const kp = `${path}.by[${i}]`;
                    if (!isObj(k)) { c.add('invalid_plan', n, kp, 'an order key must be an object'); return; }
                    strictKeys(k, ['alias', 'field', 'measure', 'dir'], c, n, kp);
                    if (k['dir'] !== undefined && k['dir'] !== 'asc' && k['dir'] !== 'desc') { c.add('bad_order', n, `${kp}.dir`, "dir must be 'asc' or 'desc'"); return; }
                    const dir = (k['dir'] ?? 'asc') as 'asc' | 'desc';
                    if (k['measure'] !== undefined) {
                        if (!aggregated || typeof k['measure'] !== 'string' || !measures.has(k['measure'])) { c.add('bad_order', n, `${kp}.measure`, 'measure must name a measure of the aggregate step'); return; }
                        keys.push({ kind: 'measure', measure: k['measure'], dir });
                        return;
                    }
                    const r = colRef({ alias: k['alias'], field: k['field'] }, aliases, c, n, kp);
                    if (!r) return;
                    if (r.kind === 'json') { c.add('type_mismatch', n, kp, 'cannot order by a json column'); return; }
                    if (aggregated && !groupKeys.some(g => g.alias === r.alias && g.field === r.field)) { c.add('bad_order', n, kp, 'after aggregate, order by a group_by column or a measure'); return; }
                    keys.push({ kind: 'column', alias: r.alias, field: r.field, dir });
                });
                if (keys.length === by.length) { ordered = true; steps.push({ op: 'order', by: keys }); }
                return;
            }
            case 'limit': {
                strictKeys(s, ['op', 'n'], c, n, path);
                const v = s['n'];
                if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > MAX_PLAN_LIMIT) { c.add('bad_value', n, `${path}.n`, `n must be an integer 1..${MAX_PLAN_LIMIT}`); return; }
                limited = true;
                steps.push({ op: 'limit', n: v });
                return;
            }
            default:
                c.add('unknown_step', n, `${path}.op`, `unknown step '${op}'; allowed: filter, join, aggregate, as_of, order, limit`);
        }
    });

    if (!sourced && c.issues.length === 0) c.add('no_source', null, '$.steps', 'a plan needs a filter step that names an entity type');
    if (c.issues.length > 0) return { ok: false, errors: c.issues };
    const plan: ValidPlan = { steps };
    return { ok: true, plan };
}
