/**
 * logRedact.ts — One-way identifiers for user content in stderr logs (S9).
 *
 * Stderr lands in ~/.groundfloor/logs/lore-mcp.log (0600 after S1, so only
 * the owning user can read it). But:
 *   - Time Machine / cloud-sync apps can back up log files
 *   - Stack traces copy-pasted to bug reports can leak content
 *   - A multi-user Mac (rare but possible) widens the blast radius
 *
 * For a personal workspace, node IDs can be PII: `person:sarah-smith` or
 * `memory:sister-wedding-2019`. Rather than log the raw ID, log a short
 * content-addressed hash — operators can still correlate two log lines
 * about the same node, but can't reverse the hash to recover the ID.
 *
 * Not cryptographic — just a collision-resistant tag. SHA-1 truncated to
 * 8 hex chars gives plenty of entropy for a log line's lifetime.
 */

import * as crypto from 'crypto';

/**
 * shortHash — one-way 8-char hex tag for a string. Same input → same tag
 * across processes. Different inputs → extremely unlikely to collide in
 * any realistic log volume.
 */
export function shortHash(input: string): string {
    return crypto.createHash('sha1').update(input, 'utf-8').digest('hex').slice(0, 8);
}

/**
 * redactId — format a node-like identifier for logging.
 *
 * Input:  "person:sarah-smith"
 * Output: "id#a3f2c891"
 *
 * Operators see consistent tags (same id → same tag) and can reference
 * them in debugging, but the original ID never lands on disk.
 */
export function redactId(id: string): string {
    if (!id) return 'id#<empty>';
    return `id#${shortHash(id)}`;
}

/**
 * redactError — format an Error's message for logging, redacting any
 * node-ID-looking substring.
 *
 * Best-effort. The native error messages from Kùzu and LanceDB can echo
 * the ID back in their own strings. We catch several leak shapes:
 *   1. Quoted tokens — `'...'` and `"..."` (the original behavior).
 *   2. Absolute filesystem paths — `/Users/...`, `/home/...`, `/var/...`,
 *      `/tmp/...`, `/private/...` — which can carry usernames + content.
 *   3. Bare node-id-like tokens — a word containing a `:` such as
 *      `type:slug` (e.g. `person:sarah-smith`), even when unquoted.
 *
 * F-T06: the previous version only scrubbed quoted tokens, so unquoted
 * ids/paths slipped through every redaction site. The added patterns are
 * deliberately conservative so ordinary prose is left intact:
 *   - paths require a leading known root segment + at least one more
 *     segment, so a sentence like "see /docs" is not mangled.
 *   - id-like tokens require a `:` flanked by id-safe characters
 *     (no whitespace, no slashes), so prose like "note: hello" or a
 *     URL scheme like "https://..." is not matched.
 *
 * Each matched run is replaced with the same `id#<hash>` tag style used
 * elsewhere, so operators can still correlate repeated lines. The
 * function stays pure and does a fixed number of regex passes.
 */
/**
 * LD-02 (DoS): cap the input before running the redaction passes. redactError
 * runs on every logged Error/string, and substrate error messages can echo
 * caller-controlled node ids/content up to the 10 MB request-body cap. The
 * id-token pass below is regex over the whole string, so an unbounded input is
 * a synchronous event-loop stall. 8 KB is far more than any real log line needs.
 */
const MAX_REDACT_LEN = 8192;

export function redactError(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    const msg = raw.length > MAX_REDACT_LEN
        ? `${raw.slice(0, MAX_REDACT_LEN)}…(+${raw.length - MAX_REDACT_LEN} chars truncated)`
        : raw;
    return msg
        // F-T06: quoted tokens (original behavior, preserved first so
        // already-quoted ids keep their surrounding quotes).
        .replace(/'([^']{1,200})'/g, (_m, inner) => `'id#${shortHash(inner)}'`)
        .replace(/"([^"]{1,200})"/g, (_m, inner) => `"id#${shortHash(inner)}"`)
        // F-T06: absolute filesystem paths under common roots. Requires a
        // root segment plus at least one further path segment so bare
        // roots / single words are not touched.
        // D2-data-3: include /Volumes (macOS external mounts) so content
        // paths under an external disk are scrubbed like /Users etc.
        .replace(
            /\/(?:Users|home|var|tmp|private|opt|mnt|data|root|srv|Volumes)\/[^\s'"]+/g,
            (m) => `id#${shortHash(m)}`,
        )
        // F-T06: bare node-id-like tokens (type:slug). The `:` must be
        // flanked by id-safe chars (letters/digits/_-.) and not be part
        // of a `://` URL scheme. Skipped if either side touches a quote
        // (already handled above) or a slash.
        // D2-data-2: the namespace (left of `:`) must contain at least one
        // letter, so bare numeric tokens like `12:30:45` (timestamps) or
        // `1:2` (ratios) are NOT matched — only real ids like `person:sarah`.
        // LD-02: each id-safe run is length-bounded ({0,64}/{0,128}) so the two
        // adjacent runs can't backtrack quadratically on a long id-safe string
        // (a real id namespace/slug is well under these bounds anyway).
        .replace(
            /\b[A-Za-z0-9_.-]{0,64}[A-Za-z][A-Za-z0-9_.-]{0,64}:(?![/])[A-Za-z0-9_][A-Za-z0-9_.-]{0,128}\b/g,
            (m) => `id#${shortHash(m)}`,
        );
}
