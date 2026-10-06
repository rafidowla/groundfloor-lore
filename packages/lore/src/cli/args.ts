/**
 * cli/args.ts — strict argument parser shared by the writing CLI commands.
 *
 * Why this exists: several destructive commands used ad-hoc parsing
 * (`args.find(a => !a.startsWith('--'))`, `args.includes('--force')`,
 * `args.indexOf('--to')`). That silently dropped anything it did not know:
 * a mistyped `--dryrun` ran for real, and an unsupported `--data-dir` made
 * `migrate-graph` fall back to LORE_HOME and migrate the operator's REAL
 * workspace while the operator believed they were targeting a copy.
 *
 * Contract — each command DECLARES what it accepts and anything else is a
 * `UsageError` raised before the command does any work:
 *   - boolean flags (`--force`), value flags (`--to sqlite` and `--to=sqlite`),
 *     and a positional count;
 *   - unknown flags, a flag missing its value, a value flag given twice, a
 *     boolean flag given a value (`--force=1`) and surplus/missing
 *     positionals are all rejected;
 *   - a value flag's value is NEVER also counted as a positional
 *     (`--to sqlite ws` yields positional `ws`, not `sqlite`);
 *   - a flag's value may not look like a flag: any token starting with `-`
 *     other than a lone `-` or a negative number is a missing value (use
 *     `--flag=-x` to pass one on purpose); `-h`/`--help` in a value position
 *     never triggers help;
 *   - a bare `--` ends flag parsing (everything after it is positional);
 *   - `--data-dir` values are made absolute with `path.resolve` by
 *     {@link dataDirFlag}.
 *
 * Exit-code convention (matches the existing commands): a usage error prints
 * `lore <command>: <reason>` plus the command's usage text to stderr and exits
 * 1 (`migrate` online subcommands historically exit 2 and pass `exitCode: 2`).
 */

import * as path from 'node:path';

export class UsageError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'UsageError';
    }
}

export interface ArgSpec {
    /** Boolean flags, e.g. `['--force', '--dry-run']`. */
    readonly bool?: readonly string[];
    /** Value flags (each at most once), e.g. `['--to', '--data-dir']`. */
    readonly value?: readonly string[];
    /** Value flags that may be repeated (values are collected in order). */
    readonly repeatable?: readonly string[];
    /** Alias → canonical flag, e.g. `{ '-h': '--help' }`. */
    readonly aliases?: Readonly<Record<string, string>>;
    /** Positional arity. Defaults to none allowed. */
    readonly positionals?: { readonly min?: number; readonly max?: number };
    /**
     * When true, `--help` / `-h` anywhere (before a bare `--`) short-circuits:
     * `help` is set and no other validation runs, so `lore x --bogus --help`
     * still prints help instead of erroring.
     */
    readonly help?: boolean;
}

export interface ParsedArgs {
    readonly positionals: string[];
    readonly help: boolean;
    /** Was this boolean flag present? (canonical name) */
    has(flag: string): boolean;
    /** Value of a value flag (canonical name); undefined when absent. */
    get(flag: string): string | undefined;
    /** All values of a (repeatable) value flag, in order. */
    getAll(flag: string): string[];
}

const NUMERIC_TOKEN = /^-\d/;

function isFlagToken(tok: string): boolean {
    return tok.startsWith('-') && tok !== '-' && !NUMERIC_TOKEN.test(tok);
}

export function parseStrict(argv: readonly string[], spec: ArgSpec): ParsedArgs {
    const bools = new Set(spec.bool ?? []);
    const values = new Set(spec.value ?? []);
    const repeatable = new Set(spec.repeatable ?? []);
    const aliases = spec.aliases ?? {};
    const canon = (f: string): string => aliases[f] ?? f;

    const present = new Set<string>();
    const valueMap = new Map<string, string[]>();
    const positionals: string[] = [];

    if (spec.help) {
        for (let i = 0; i < argv.length; i++) {
            const t = argv[i]!;
            if (t === '--') break;
            if (canon(t) === '--help') {
                return makeParsed([], true, present, valueMap);
            }
            // A token in a value flag's VALUE position is that flag's value (or its
            // missing-value error below), never a request for help: skip it.
            if (isFlagToken(t) && !(t.startsWith('--') && t.includes('=')) && (values.has(canon(t)) || repeatable.has(canon(t)))) i++;
        }
    }

    for (let i = 0; i < argv.length; i++) {
        const raw = argv[i]!;
        if (raw === '--') {
            positionals.push(...argv.slice(i + 1));
            break;
        }
        if (!isFlagToken(raw)) {
            positionals.push(raw);
            continue;
        }
        let tok = raw;
        let inline: string | undefined;
        if (tok.startsWith('--')) {
            const eq = tok.indexOf('=');
            if (eq > 0) {
                inline = tok.slice(eq + 1);
                tok = tok.slice(0, eq);
            }
        }
        const flag = canon(tok);
        if (bools.has(flag)) {
            if (inline !== undefined) throw new UsageError(`${tok} takes no value`);
            present.add(flag);
            continue;
        }
        if (values.has(flag) || repeatable.has(flag)) {
            let val = inline;
            if (val === undefined) {
                val = argv[i + 1];
                // Any flag-looking token (single-dash included) is a missing value; `-` alone and negative numbers are values.
                if (val === undefined || isFlagToken(val)) throw new UsageError(`${tok} needs a value`);
                i++;
            }
            if (val === '') throw new UsageError(`${tok} needs a non-empty value`);
            const list = valueMap.get(flag) ?? [];
            if (list.length > 0 && !repeatable.has(flag)) throw new UsageError(`${tok} given more than once`);
            list.push(val);
            valueMap.set(flag, list);
            continue;
        }
        throw new UsageError(`unknown flag ${tok}`);
    }

    const min = spec.positionals?.min ?? 0;
    const max = spec.positionals?.max ?? 0;
    if (positionals.length > max) {
        throw new UsageError(max === 0
            ? `unexpected argument '${positionals[0]}'`
            : `unexpected argument '${positionals[max]}' (takes at most ${max} positional argument${max === 1 ? '' : 's'})`);
    }
    if (positionals.length < min) {
        throw new UsageError(`missing required argument${min === 1 ? '' : 's'} (expected ${min === max ? min : `at least ${min}`})`);
    }
    return makeParsed(positionals, false, present, valueMap);
}

function makeParsed(
    positionals: string[], help: boolean, present: Set<string>, valueMap: Map<string, string[]>,
): ParsedArgs {
    return {
        positionals,
        help,
        has: (f) => present.has(f),
        get: (f) => valueMap.get(f)?.[0],
        getAll: (f) => [...(valueMap.get(f) ?? [])],
    };
}

/**
 * The absolute `--data-dir` (via `path.resolve`), or undefined when the flag
 * was not given. Does not check existence — callers that write must.
 */
export function dataDirFlag(parsed: ParsedArgs): string | undefined {
    const v = parsed.get('--data-dir');
    return v === undefined ? undefined : path.resolve(v);
}

export interface ParseOrExitOptions {
    /** Prints the command's usage text to stderr after the error line. */
    usage?: () => void;
    /** Exit code on a usage error (default 1). */
    exitCode?: number;
}

/**
 * Parse `argv` against `spec`; on a `UsageError` print it (plus usage) to
 * stderr and exit non-zero BEFORE the caller has done anything.
 */
export function parseOrExit(
    command: string, argv: readonly string[], spec: ArgSpec, opts: ParseOrExitOptions = {},
): ParsedArgs {
    try {
        return parseStrict(argv, spec);
    } catch (e) {
        if (!(e instanceof UsageError)) throw e;
        console.error(`lore ${command}: ${e.message}`);
        if (opts.usage) opts.usage();
        else console.error(`Run 'lore ${command} --help' for usage.`);
        return process.exit(opts.exitCode ?? 1);
    }
}
