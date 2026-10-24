/**
 * tableBoolean.ts — the ONE boolean-column parser shared by every ITableStorage backend.
 *
 * Audit 5.5 (2026-08-17): plain JS truthiness stored every non-empty string ('false', '0', 'no') as TRUE.
 * A boolean column therefore parses: real booleans pass through; numbers coerce (0 -> false, non-zero ->
 * true); strings match the canonical sets below case-insensitively. An unparseable value THROWS — a
 * boolean has no lossless "verbatim" form, so guessing would silently corrupt the row.
 *
 * SQLite stores the result as 0/1 (`SqliteTableStorage`), Postgres as a real boolean
 * (`PostgresTableStorage`); both previously-identical semantics now come from here so they cannot drift.
 */

const TRUE_STRINGS: Record<string, true> = { true: true, '1': true, yes: true, y: true, on: true };
const FALSE_STRINGS: Record<string, true> = { false: true, '0': true, no: true, n: true, off: true };

/** `label` prefixes error messages (the backend class name, e.g. 'SqliteTableStorage'). */
export function parseTableBoolean(v: unknown, label: string): boolean {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') {
        if (Number.isNaN(v)) throw new Error(`${label}: cannot store NaN in a boolean column`);
        return v !== 0;
    }
    if (typeof v === 'string') {
        const s = v.trim().toLowerCase();
        // Object.hasOwn, not a bare lookup: a plain Record lookup would treat prototype keys ('constructor') as TRUE.
        if (Object.hasOwn(TRUE_STRINGS, s)) return true;
        if (Object.hasOwn(FALSE_STRINGS, s)) return false;
        throw new Error(
            `${label}: unparseable boolean value ${JSON.stringify(v)} ` +
            `(expected a boolean, a number, or one of ` +
            `${[...Object.keys(TRUE_STRINGS), ...Object.keys(FALSE_STRINGS)].join('/')})`,
        );
    }
    throw new Error(`${label}: unparseable boolean value of type ${typeof v}`);
}
