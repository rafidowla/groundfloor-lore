/**
 * logger.ts — Thin structured logger for the Lore daemon (SW-32, F6).
 *
 * Why this exists
 * ───────────────
 * The daemon historically used ~600 ad-hoc `console.*` calls with no level,
 * no structure, and no redaction. For an enterprise that ships logs to
 * Splunk/Datadog this is a liability: operators can't filter by severity,
 * can't parse fields, and secrets can leak verbatim into log sinks.
 *
 * This module is a dependency-free, zero-config replacement that:
 *   - is leveled (error / warn / info / debug),
 *   - honors the LORE_LOG_LEVEL env var (already documented + envScrub-
 *     allowlisted; this is the first consumer),
 *   - emits a stable, parseable line: `<ISO-ts> <LEVEL> <message>` plus an
 *     optional one-line JSON context object,
 *   - routes every message through `security/logRedact` so quoted node-IDs
 *     (potential PII) are hashed before they hit disk.
 *
 * Critical invariant: ALL output goes to **stderr**, never stdout. This
 * daemon speaks the MCP protocol over stdout in stdio mode — any stray
 * stdout write corrupts the JSON-RPC stream. The legacy code already used
 * `console.error` everywhere for exactly this reason; the logger preserves it
 * for info/debug too.
 */

import { redactError } from './security/logRedact.js';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

/** Numeric severity ordering — higher = more verbose. */
const LEVEL_RANK: Record<LogLevel, number> = {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3,
};

const DEFAULT_LEVEL: LogLevel = 'info';

/**
 * Resolve the active threshold from LORE_LOG_LEVEL. Unknown / unset values
 * fall back to `info`. Read once at module load; the daemon is long-lived
 * and the value is set at startup (matches the documented "at startup"
 * semantics in docs/CONFIGURATION.md).
 */
function resolveThreshold(): LogLevel {
    const raw = (process.env.LORE_LOG_LEVEL ?? '').trim().toLowerCase();
    if (raw === 'error' || raw === 'warn' || raw === 'info' || raw === 'debug') {
        return raw;
    }
    return DEFAULT_LEVEL;
}

let threshold: LogLevel = resolveThreshold();

/**
 * Re-read LORE_LOG_LEVEL. Primarily for tests that mutate the env var; the
 * daemon itself never needs to call this.
 */
export function refreshLogLevel(): void {
    threshold = resolveThreshold();
}

/** Current effective threshold (for tests / diagnostics). */
export function currentLogLevel(): LogLevel {
    return threshold;
}

function enabled(level: LogLevel): boolean {
    return LEVEL_RANK[level] <= LEVEL_RANK[threshold];
}

/**
 * Render the optional context object as a compact, redacted JSON suffix.
 * Best-effort: anything that can't be stringified (cycles, BigInt) degrades
 * to a safe marker rather than throwing inside a log call.
 */
function renderContext(context?: Record<string, unknown>): string {
    if (!context || Object.keys(context).length === 0) return '';
    try {
        // Redact at the value level, not over the whole serialized blob —
        // running redactError on the full JSON would hash the keys too and
        // destroy the structure operators rely on. A replacer lets us hash
        // quoted ID-looking tokens inside string *values* while keeping keys
        // intact. Errors are stringified to their (redacted) message.
        return ' ' + JSON.stringify(context, (_key, value) => {
            if (value instanceof Error) return redactError(value);
            if (typeof value === 'string') return redactError(value);
            return value;
        });
    } catch {
        return ' {context:unserializable}';
    }
}

/**
 * Redact the human message. Strings and Errors both flow through
 * redactError, which hashes quoted node-ID tokens (PII for personal
 * workspaces) while leaving the rest of the message intact.
 */
function renderMessage(message: unknown): string {
    if (message instanceof Error) return redactError(message);
    return redactError(String(message));
}

function emit(level: LogLevel, message: unknown, context?: Record<string, unknown>): void {
    if (!enabled(level)) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${renderMessage(message)}${renderContext(context)}`;
    // ALWAYS stderr — see module header. Keeps stdout clean for MCP stdio.
    process.stderr.write(line + '\n');
}

/**
 * The shared logger. Each method takes a message plus an optional structured
 * context object, e.g. `log.info('[Lore MCP] started', { port })`.
 */
export const log = {
    error(message: unknown, context?: Record<string, unknown>): void {
        emit('error', message, context);
    },
    warn(message: unknown, context?: Record<string, unknown>): void {
        emit('warn', message, context);
    },
    info(message: unknown, context?: Record<string, unknown>): void {
        emit('info', message, context);
    },
    debug(message: unknown, context?: Record<string, unknown>): void {
        emit('debug', message, context);
    },
};

/** Alias for callers/tests that prefer the `logger` name. */
export const logger = log;
