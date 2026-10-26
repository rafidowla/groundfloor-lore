/**
 * planMoney.ts - the money rules of query plans (Tables P3, currency-aware).
 *
 * Money is (amount, currency), never a bare number (design Q9). Rules enforced by the validator and executor:
 *   - a money COMPARISON in a filter (`eq neq in gt gte lt lte`) takes `{ amount, currency }`; a bare number is refused
 *     so "> 1,000,000" can never silently mix CAD and USD. Rows in OTHER currencies are filtered out (not compared) and
 *     counted in the step report as `excludedOtherCurrency`;
 *   - the currency half is addressed as the pseudo-field `<money column>__currency` (same name as the table API);
 *   - `aggregate` sum/avg/min/max over a set (a group, when grouped) holding more than one currency is refused with the
 *     table API's MixedCurrencyError shape (`code: 'mixed_currency'`); group by `<column>__currency` to split first;
 *   - a `having` threshold on a money measure is `{ amount, currency }` and must match the group's currency.
 * Amounts are exact decimal strings end to end (bound as text, cast to numeric, read back as text).
 */

import { CURRENCY_SUFFIX } from '../engines/postgres/postgresTableSchema.js';
import { encodePgValue, splitMoney } from '../engines/postgres/postgresTableCodec.js';
import { MixedCurrencyError } from '../engines/postgres/postgresTableErrors.js';
import type { TableSchema } from '../contracts/tables.js';
import type { MoneyBound } from './planTypes.js';

const MAX_EXPONENT = 1000;
const CURRENCY_RE = /^[A-Za-z]{3}$/;

/** `price__currency` -> `price` when `price` is a money column of `schema`; otherwise undefined. */
export function currencyBase(schema: TableSchema, field: string): string | undefined {
    if (!field.endsWith(CURRENCY_SUFFIX)) return undefined;
    const base = field.slice(0, -CURRENCY_SUFFIX.length);
    return schema.columns.find(c => c.name === base)?.type === 'money' ? base : undefined;
}

export type Bind<T> = { ok: true; value: T } | { ok: false; message: string };

/** One `{ amount, currency }` literal (filter value or having threshold) as an exact decimal string + upper-case ISO code. */
export function bindMoneyValue(v: unknown, ctx: string): Bind<MoneyBound> {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
        return { ok: false, message: `${ctx}: a money value must be { amount, currency } (e.g. {"amount":"1000000","currency":"USD"}); ` +
            'a bare number is refused so a threshold never mixes currencies' };
    }
    const keys = Object.keys(v);
    if (keys.some(k => k !== 'amount' && k !== 'currency')) return { ok: false, message: `${ctx}: a money value has only amount and currency` };
    if (typeof (v as { amount?: unknown }).amount !== 'string') {
        return { ok: false, message: `${ctx}: amount must be a decimal string (e.g. "1000.50"), never a JSON number, so no float rounding is involved` };
    }
    try {
        const m = splitMoney(encodePgValue(v, 'money', ctx));
        const exp = /[eE]([+-]?\d+)$/.exec(m.amount);
        if (exp && Math.abs(Number(exp[1])) > MAX_EXPONENT) return { ok: false, message: `${ctx}: amount exponent out of range` };
        if (m.amount.length > 1000) return { ok: false, message: `${ctx}: amount too long` };
        return { ok: true, value: { amount: m.amount, currency: m.currency } };
    } catch (err) {
        return { ok: false, message: (err as Error).message.replace(/^PostgresTableStorage:\s*/, '') };
    }
}

/** One ISO currency code for the `<column>__currency` pseudo-field (upper-cased). */
export function bindCurrencyCode(v: unknown, ctx: string): Bind<string> {
    if (typeof v !== 'string' || !CURRENCY_RE.test(v)) return { ok: false, message: `${ctx}: expected a 3-letter ISO currency code` };
    return { ok: true, value: v.toUpperCase() };
}

/**
 * EXTENSION POINT - the single place that decides whether money in several currencies may be combined.
 * Today it ALWAYS refuses (design Q9, Atlas decision "no mixed-currency sums"): there is no rate table feature. A future
 * rate-table feature changes only this function (accept the currencies and return the conversion to apply); the
 * executor, validator and SQL templates call nothing else for this decision. Throws MixedCurrencyError.
 */
export function decideCurrencyCombination(column: string, currencies: readonly string[]): never {
    throw new MixedCurrencyError(column, [...currencies]);
}
