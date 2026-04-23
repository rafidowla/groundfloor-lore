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
 * node-ID-looking substring (`'...'` or `"..."` quoted tokens).
 *
 * Best-effort. The native error messages from Kùzu and LanceDB can echo
 * the ID back in their own strings; this catches the common quoted form.
 */
export function redactError(err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);
    return msg.replace(/'([^']{1,200})'/g, (_m, inner) => `'id#${shortHash(inner)}'`)
              .replace(/"([^"]{1,200})"/g, (_m, inner) => `"id#${shortHash(inner)}"`);
}
