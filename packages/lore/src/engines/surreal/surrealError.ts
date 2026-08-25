/**
 * surrealError.ts — redaction boundary for SurrealDB engine failures.
 *
 * SurrealDB's errors are unusually leaky by design: a parse failure echoes the
 * FULL statement back inside an ASCII code frame, and an open/IO failure
 * echoes the absolute on-disk path. Both land in `LoreGraphError.message`
 * (which deliberately inlines its cause — see loreGraphError.ts) and from
 * there into stderr, log files, and pasted bug reports. In a personal
 * workspace a statement can carry node content and a path can carry a
 * username, so this is the same exposure the repo's 149-site
 * `sw14-error-redaction` effort closed everywhere else.
 *
 * Every LoreGraphError raised from a SurrealDB failure goes through here, so
 * the substrate has exactly ONE place where a raw driver message can escape —
 * and it doesn't. Redaction is `security/logRedact.redactError`, the same
 * function the rest of the codebase uses: quoted tokens, absolute paths, and
 * bare `type:slug` ids become stable `id#<hash>` tags while ordinary prose
 * ("Specify a database to use", "Parse error") survives, so the failure stays
 * diagnosable and two log lines about the same id still correlate.
 *
 * The raw error is deliberately NOT retained on the thrown object. A `.cause`
 * that still holds the unredacted text is one `JSON.stringify` away from
 * undoing all of this.
 */

import { redactError } from '../../security/logRedact.js';
import { LoreGraphError } from '../loreGraphError.js';

/**
 * surrealError — wrap a raw SurrealDB failure as a LoreGraphError whose cause
 * text has been redacted.
 *
 * Pass-through for a LoreGraphError we raised ourselves: those messages are
 * authored here (e.g. `edge_endpoint_missing: source 'x' not found`) and are
 * meant to name the id the caller just passed in. Re-redacting would hash the
 * caller's own input back at them and make the error useless.
 */
export function surrealError(message: string, operation: string, cause?: unknown): LoreGraphError {
    if (cause instanceof LoreGraphError) return cause;
    if (cause === undefined) return new LoreGraphError(message, operation);
    return new LoreGraphError(message, operation, new Error(redactError(cause)));
}

/**
 * redactSurrealLog — scrub a string destined for a log line.
 *
 * Used for the non-throwing paths (a warn about a capped scan, a non-fatal
 * prune failure) where the text is assembled here rather than caught.
 */
export function redactSurrealLog(value: unknown): string {
    return redactError(value);
}
