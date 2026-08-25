/**
 * engines/contentHash.ts — single source of truth for verbatim-text fingerprints.
 *
 * Why this file exists (PR #69, memory-backbone hardening P2):
 *   Lore's verbatim store has had a `contentHash` schema field, a
 *   `hashCache`, and a `lookupByContentHash` function since 2026-04-30,
 *   but the live write callsites never populated `doc.metadata.contentHash`.
 *   That meant `lookupByContentHash` always early-returned null and the
 *   30-minute consistency sweep re-embedded text that hadn't actually
 *   changed — driving the 8.5 GB / 18,943-version churn we observed
 *   live in the developer workspace.
 *
 *   Centralizing the hash here guarantees that every write path AND the
 *   sweep produce *identical* hashes for the same text. If a sweep
 *   computes a different hash than the original write, the
 *   skip-on-match optimization fails silently and we re-embed everything
 *   again — exactly the bug we're trying to kill.
 *
 * The hash:
 *   sha1(verbatimText), hex, truncated to 16 chars (64 bits).
 *
 * Why sha1-16 (and not sha256, not md5):
 *   - We're not authenticating anything, only detecting change. Collision
 *     odds at 64 bits across a single workspace's note set are negligible.
 *   - sha1 is ~3× faster than sha256 on small inputs (typical notes are
 *     <2 KiB). At sweep scale (thousands of notes per pass) that matters.
 *   - 16 hex chars keeps the LanceDB Utf8 column small (~24 B/row vs ~70 B
 *     for a full sha256). 60k rows × saved bytes ≈ 3 MB reclaimed at the
 *     storage layer, which is small but non-zero.
 *   - matches the existing pattern in `engines/feedbackStore.ts:75` and
 *     `security/logRedact.ts:27` — keep one hash convention in the
 *     codebase so reviewers don't ask "why is this one different?"
 *
 * Determinism contract:
 *   Same input string → same hash, forever. If we ever need to migrate
 *   to a new hash (longer, different algo), we'll add a versioned column.
 *   Today: one hash, one length, one truth.
 */

import { createHash } from 'node:crypto';

/**
 * Compute the canonical content fingerprint for a verbatim text body.
 *
 * Callers should pass the *exact* text that will be (or was) embedded —
 * typically the output of `buildVerbatimText(label, content, tags)`.
 * Hashing anything else means the skip-on-match optimization breaks.
 *
 * Empty string is treated as a real input — returns the sha1-16 of '',
 * not a special "no hash" sentinel. Callers that want "no hash" must
 * check `text.length === 0` themselves before calling.
 *
 * Pure, synchronous, no I/O. Safe to call from any code path including
 * tight loops.
 */
export function computeContentHash(text: string): string {
    return createHash('sha1').update(text, 'utf-8').digest('hex').slice(0, 16);
}
