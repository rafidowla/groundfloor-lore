/**
 * postgresTableCodec.ts - value coercion and row decoding for PostgresTableStorage.
 *
 * Writes are STRICTER than SQLite's verbatim storage: a typed column rejects a
 * value that does not parse as its type (SQLite stored whatever it was given).
 * Reads return the same JS shapes SQLite does, with two documented
 * normalisations: date/datetime come back as canonical UTC ISO strings, and
 * bigint columns come back as Number when safe (string otherwise).
 */

import type { ColumnDecl, ColumnType, Row } from '../../contracts/tables.js';
import { parseTableBoolean } from '../tableBoolean.js';

const LABEL = 'PostgresTableStorage';

/** Encoded value ready to bind (null = SQL NULL). */
export type Encoded = string | number | boolean | null;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}(:?\d{2})?)?$/;
const INT_RE = /^[+-]?\d+$/;
const FLOAT_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

function validDate(s: string): boolean {
    const m = DATE_RE.exec(s);
    if (!m) return false;
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

const DECIMAL_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const CURRENCY_RE = /^[A-Za-z]{3}$/;

/** Exact decimal as text (never via a JS float); accepts a decimal string, a finite number or a bigint. */
export function encodeDecimal(v: unknown, ctx: string): string {
    if (typeof v === 'bigint') return v.toString();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    if (typeof v === 'string' && DECIMAL_RE.test(v.trim())) return v.trim().replace(/^\+/, '');
    throw new Error(`${LABEL}: ${ctx} expects a decimal amount, got ${JSON.stringify(v)}`);
}

/** Split an encoded money value (the JSON text `encodePgValue` returns for `money`) into its two stored halves. */
export function splitMoney(enc: Encoded): { amount: string; currency: string } {
    return JSON.parse(String(enc)) as { amount: string; currency: string };
}

function encodeMoney(v: unknown, ctx: string): string {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
        const o = v as { amount?: unknown; currency?: unknown };
        if (typeof o.currency === 'string' && CURRENCY_RE.test(o.currency) && o.amount !== undefined && o.amount !== null) {
            return JSON.stringify({ amount: encodeDecimal(o.amount, `${ctx} amount`), currency: o.currency.toUpperCase() });
        }
    }
    throw new Error(`${LABEL}: ${ctx} expects { amount, currency } with a decimal amount and a 3-letter currency, got ${JSON.stringify(v)}`);
}

/** Encode one value for column type `t`. `ctx` names the column in errors. */
export function encodePgValue(v: unknown, t: ColumnType, ctx: string): Encoded {
    if (v === null || v === undefined) return null;
    switch (t) {
        case 'string':
            if (typeof v === 'string') return v;
            if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') return String(v);
            throw new Error(`${LABEL}: ${ctx} expects a string, got ${typeof v}`);
        case 'integer': {
            if (typeof v === 'number' && Number.isInteger(v)) return String(v);
            if (typeof v === 'bigint') return v.toString();
            if (typeof v === 'string' && INT_RE.test(v.trim())) return v.trim().replace(/^\+/, '');
            throw new Error(`${LABEL}: ${ctx} expects an integer, got ${JSON.stringify(v)}`);
        }
        case 'float': {
            if (typeof v === 'number' && Number.isFinite(v)) return v;
            if (typeof v === 'string' && FLOAT_RE.test(v.trim())) return Number(v.trim());
            throw new Error(`${LABEL}: ${ctx} expects a finite number, got ${JSON.stringify(v)}`);
        }
        case 'boolean':
            return parseTableBoolean(v, `${LABEL}: ${ctx}`);
        case 'date': {
            const s = v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === 'string' ? v.trim() : '';
            if (!validDate(s)) throw new Error(`${LABEL}: ${ctx} expects a YYYY-MM-DD date, got ${JSON.stringify(v)}`);
            return s;
        }
        case 'datetime': {
            if (v instanceof Date) {
                if (Number.isNaN(v.getTime())) throw new Error(`${LABEL}: ${ctx} expects a valid datetime`);
                return v.toISOString();
            }
            if (typeof v === 'string') {
                const s = v.trim();
                if (validDate(s)) return `${s}T00:00:00Z`;
                if (DATETIME_RE.test(s)) {
                    // No zone designator: interpret as UTC so the result never depends on the server's TimeZone.
                    return /(Z|[+-]\d{2}(:?\d{2})?)$/.test(s) ? s : `${s}Z`;
                }
            }
            throw new Error(`${LABEL}: ${ctx} expects an ISO 8601 datetime, got ${JSON.stringify(v)}`);
        }
        case 'json': {
            if (typeof v === 'string') {
                try { JSON.parse(v); return v; } catch { return JSON.stringify(v); }
            }
            return JSON.stringify(v);
        }
        case 'money':
            return encodeMoney(v, ctx);
    }
}

/** SQL expression turning view column `expr` into the text/number shape the decoder expects. */
export function selectExpr(expr: string, t: ColumnType, currencyExpr?: string): string {
    if (t === 'money') {
        if (!currencyExpr) throw new Error(`${LABEL}: money select needs its currency column`);
        return `CASE WHEN ${expr} IS NULL THEN NULL ELSE jsonb_build_object('amount', ${expr}::text, 'currency', ${currencyExpr}::text) END`;
    }
    if (t === 'date') return `to_char(${expr}, 'YYYY-MM-DD')`;
    if (t === 'datetime') return `to_char(${expr} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
    return expr;
}

/** Decode one driver value back to its declared type. */
export function decodePgValue(v: unknown, t: ColumnType): unknown {
    if (v === null || v === undefined) return null;
    if (t === 'integer') {
        if (typeof v === 'number') return v;
        const n = Number(v);
        return Number.isSafeInteger(n) ? n : String(v);
    }
    if (t === 'money') {
        const o = (typeof v === 'string' ? JSON.parse(v) : v) as { amount: unknown; currency: unknown };
        return { amount: String(o.amount), currency: String(o.currency) };
    }
    return v;
}

export function decodePgRow(raw: Row, cols: ColumnDecl[], prefix = ''): Row {
    const out: Row = {};
    for (const c of cols) {
        const key = `${prefix}${c.name}`;
        if (key in raw) out[key] = decodePgValue(raw[key], c.type);
    }
    return out;
}
