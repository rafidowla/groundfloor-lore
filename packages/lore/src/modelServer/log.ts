/**
 * modelServer/log.ts — size-capped, rotated logging for the model server
 * (D9 §5.4). Writes to `<LORE_HOME>/logs/model-server.log`.
 *
 * HARD INVARIANT: this logger (and every call site in modelServer/*) must
 * NEVER write embed/rerank payload text — no query strings, no document
 * text, no passage text. Only structural metadata: request ids, op names,
 * counts, byte sizes, durations, error names/messages, client counts. This
 * is checked by a dedicated test (log-redaction) that greps the log file
 * for a known test query string and asserts it is absent.
 *
 * Deliberately does NOT reuse `security/logRedact.ts` — that module hashes
 * quoted node-ID-shaped tokens inside otherwise-loggable strings, which is
 * the wrong tool here: the requirement is that payload text is never
 * *passed to* the logger at all, not that it be redacted after the fact.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { MODEL_SERVER_LOG_MAX_BYTES, MODEL_SERVER_LOG_MAX_FILES } from './config.js';

export type ModelServerLogLevel = 'error' | 'warn' | 'info' | 'debug';

function safeJson(meta: Record<string, unknown>): string {
    try {
        return JSON.stringify(meta);
    } catch {
        return '"{unserializable}"';
    }
}

export class ModelServerLogger {
    constructor(private readonly path_: string) {
        fs.mkdirSync(path.dirname(path_), { recursive: true, mode: 0o700 });
    }

    private write(level: ModelServerLogLevel, message: string, meta?: Record<string, unknown>): void {
        this.rotateIfNeeded();
        const suffix = meta && Object.keys(meta).length > 0 ? ' ' + safeJson(meta) : '';
        const line = `${new Date().toISOString()} ${level.toUpperCase()} [model-server] ${message}${suffix}\n`;
        try {
            fs.appendFileSync(this.path_, line, { mode: 0o600 });
        } catch {
            // best-effort — a logging failure must never take down the server
        }
    }

    error(message: string, meta?: Record<string, unknown>): void {
        this.write('error', message, meta);
    }
    warn(message: string, meta?: Record<string, unknown>): void {
        this.write('warn', message, meta);
    }
    info(message: string, meta?: Record<string, unknown>): void {
        this.write('info', message, meta);
    }
    debug(message: string, meta?: Record<string, unknown>): void {
        this.write('debug', message, meta);
    }

    /** Rotate when the current file is at/over the cap. Oldest rotated file
     *  is dropped first so retention never exceeds MODEL_SERVER_LOG_MAX_FILES. */
    private rotateIfNeeded(): void {
        let size: number;
        try {
            size = fs.statSync(this.path_).size;
        } catch {
            return; // file doesn't exist yet — nothing to rotate
        }
        if (size < MODEL_SERVER_LOG_MAX_BYTES) return;
        const oldest = `${this.path_}.${MODEL_SERVER_LOG_MAX_FILES}`;
        try {
            fs.rmSync(oldest, { force: true });
        } catch {
            /* best-effort */
        }
        for (let i = MODEL_SERVER_LOG_MAX_FILES - 1; i >= 1; i--) {
            try {
                fs.renameSync(`${this.path_}.${i}`, `${this.path_}.${i + 1}`);
            } catch {
                /* best-effort — a missing intermediate file is fine */
            }
        }
        try {
            fs.renameSync(this.path_, `${this.path_}.1`);
        } catch {
            /* best-effort */
        }
    }
}
