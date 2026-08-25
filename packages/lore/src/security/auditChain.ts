/**
 * auditChain.ts — Genesis anchor + tamper-evidence verification for the
 * append-only audit log (audit.jsonl).
 *
 * Extracted from audit.ts so the AuditLog *writer* and the chain *verifier /
 * genesis-anchor* logic each declare one concern (AGENTS.md file-size budget).
 *
 * It closes two defects from the 2026-06-27 launch audit (finding #3):
 *
 *   DEFECT 1 — Rotation orphaned the live chain from archived history.
 *     logRotator gzips audit.jsonl → audit.jsonl.<ts>.gz and truncates the
 *     live file; the old fix then reset the in-memory chain head to null, so
 *     the new live file began at a fresh "genesis" with NO cryptographic link
 *     back to the archive. An auditor could not prove continuity across a
 *     rotation boundary. We now (a) write a *continuation record* as the first
 *     line of the rotated live file (carrying prevHash = the pre-truncation
 *     tail + a pointer to the .gz), and (b) provide verifyChainWithHistory(),
 *     which gunzips the archives and walks the chain across every boundary.
 *
 *   DEFECT 2 — A whole-file rewrite (or truncate-to-zero) defeated the chain.
 *     With no anchored genesis, a same-uid process could rewrite audit.jsonl
 *     wholesale with internally-consistent prevHash links (first entry
 *     prevHash:null) and verifyChain accepted it; truncating the file to zero
 *     silently started a fresh chain with no alarm. We mint a one-time genesis
 *     anchor (random nonce + host + creation time) stored alongside the log;
 *     the genesis record carries anchorHash = SHA-256 of that anchor. The
 *     verifier asserts the tie, so a rewrite that omits/forges the anchor, or
 *     an anchored-but-empty file (truncation), is DETECTED.
 *
 * Threat model (honest): the primary adversary is a same-uid local process
 * that can read+write ~/.groundfloor/. This is tamper-EVIDENCE (detection),
 * not tamper-PREVENTION. Because the anchor file is itself same-uid readable,
 * a determined attacker who ALSO reads/forges the anchor (or deletes it and
 * forges a legacy-looking chain) can still rewrite history undetected — that
 * is the documented limitation. Full non-repudiation requires an external
 * witness (the daemon emits the chain head / anchor fingerprint to an
 * operator-controlled off-box sink) or an HSM — out of MVP scope; see
 * docs/audit/FINDINGS-2026-06-27-tamper-proofing.md.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as zlib from 'zlib';
import * as crypto from 'crypto';
import type { AuditEntry } from './audit.js';

/**
 * Same 25 MB ceiling tail()/since() use — the verifier is an O(n) full read.
 * Rotation default is 10 MB (logRotator) so this only trips if rotation was
 * missed for several cycles.
 */
export const AUDIT_READ_LIMIT = 25 * 1024 * 1024;

/** Human-readable provenance of an OK verification. */
export type ChainNote = 'legacy_genesis' | 'anchored' | 'continued' | 'legacy_history';

export type VerifyChainResult =
    | { ok: true; count: number; note?: ChainNote; segments?: number; continuedFrom?: string }
    | { ok: false; brokenAt: number; reason: string };

export function sha256Hex(input: string): string {
    return crypto.createHash('sha256').update(input, 'utf-8').digest('hex');
}

// ─── Genesis anchor (DEFECT 2) ────────────────────────────────────────────

/**
 * The one-time genesis anchor. Written once, at the first-ever write to a
 * fresh audit file, next to it as `<audit>.anchor` (0600). Its SHA-256 is
 * stamped onto the genesis record's `anchorHash`. An attacker rewriting the
 * log from scratch cannot reproduce the anchor tie without also reading or
 * forging this second artifact.
 */
export interface AuditAnchor {
    v: 1;
    algo: 'sha256';
    /** 256-bit random nonce — the unforgeable-without-reading part. */
    nonce: string;
    /** ISO-8601 creation time. */
    createdAt: string;
    /** Best-effort machine identity (os.hostname()). */
    host: string;
}

/** Path of the anchor sidecar for a given audit file. */
export function anchorPathFor(filePath: string): string {
    return filePath + '.anchor';
}

/** Canonical SHA-256 of an anchor (fixed key order — never JSON.stringify(anchor) directly). */
export function computeAnchorHash(anchor: AuditAnchor): string {
    const canon = JSON.stringify({
        v: anchor.v,
        algo: anchor.algo,
        nonce: anchor.nonce,
        createdAt: anchor.createdAt,
        host: anchor.host,
    });
    return sha256Hex(canon);
}

/** Read the anchor sidecar, or null if it does not exist / is unreadable. */
export function readAnchor(filePath: string): AuditAnchor | null {
    try {
        const ap = anchorPathFor(filePath);
        if (!fs.existsSync(ap)) return null;
        const parsed = JSON.parse(fs.readFileSync(ap, 'utf-8')) as AuditAnchor;
        if (parsed && parsed.v === 1 && typeof parsed.nonce === 'string') return parsed;
        return null;
    } catch {
        return null;
    }
}

/**
 * Mint the genesis anchor if absent and return its hash. Returns null if the
 * anchor could not be persisted (best-effort: the chain then falls back to the
 * legacy unanchored scheme rather than failing a tool call). Only call this at
 * the genuine genesis moment (writing the first record to an empty file) so
 * pre-existing legacy logs are never retroactively "anchored" — that would
 * false-alarm on records that predate the anchor.
 */
export function ensureAnchor(filePath: string): string | null {
    let anchor = readAnchor(filePath);
    if (!anchor) {
        anchor = {
            v: 1,
            algo: 'sha256',
            nonce: crypto.randomBytes(32).toString('hex'),
            createdAt: new Date().toISOString(),
            host: safeHost(),
        };
        try {
            fs.writeFileSync(anchorPathFor(filePath), JSON.stringify(anchor), { mode: 0o600 });
        } catch {
            return null;
        }
    }
    return computeAnchorHash(anchor);
}

function safeHost(): string {
    try { return os.hostname(); } catch { return 'unknown-host'; }
}

/** A continuation record marks the first line of a freshly-rotated live file. */
export function isContinuationEntry(e: Partial<AuditEntry>): boolean {
    return e.kind === 'continuation';
}

// ─── Archive discovery ────────────────────────────────────────────────────

/** All `<audit>.<ts>.gz` rotated archives, oldest → newest by mtime. */
export function listArchives(filePath: string): string[] {
    try {
        const dir = path.dirname(filePath);
        const base = path.basename(filePath);
        return fs.readdirSync(dir)
            .filter((f) => f.startsWith(base + '.') && f.endsWith('.gz'))
            .map((f) => {
                const full = path.join(dir, f);
                return { full, mtime: fs.statSync(full).mtimeMs };
            })
            .sort((a, b) => a.mtime - b.mtime)
            .map((x) => x.full);
    } catch {
        return [];
    }
}

/** Newest rotated archive for this audit file, or null if none exist. */
export function newestArchive(filePath: string): string | null {
    const all = listArchives(filePath);
    return all.length ? all[all.length - 1]! : null;
}

// ─── Chain head warming ───────────────────────────────────────────────────

/**
 * SHA-256 of the last record line (or null if empty/missing). Warms the
 * in-memory chain head on AuditLog construction so a restart continues the
 * chain instead of starting a parallel one.
 */
export function readTailHash(filePath: string): string | null {
    try {
        if (!fs.existsSync(filePath)) return null;
        if (fs.statSync(filePath).size === 0) return null;
        const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i]!;
            if (line !== '') return sha256Hex(line + '\n');
        }
        return null;
    } catch {
        return null;
    }
}

// ─── Verification ─────────────────────────────────────────────────────────

/** Split file text into record lines, dropping the trailing '' from a final '\n'. */
function splitLines(text: string): string[] {
    const lines = text.split('\n');
    return lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
}

/**
 * verifyLiveChain — verify the hash chain across the LIVE file only.
 *
 * Backward-compatible successor to the original verifyChain():
 *   - returns { ok:true, count } on an intact chain (with a `note`),
 *   - returns { ok:false, brokenAt, reason } at the first problem.
 *
 * Anchor-aware (DEFECT 2):
 *   - anchor present  → strict: the genesis record must tie to the anchor;
 *     an anchored-but-empty/missing file is flagged as truncation/deletion.
 *   - anchor absent   → legacy: a null-genesis chain verifies as before.
 *
 * Rotation-aware (DEFECT 1):
 *   - a first line that is a continuation record is accepted as a rotation
 *     boundary (full cross-archive continuity is checked by
 *     verifyChainWithHistory()).
 */
export function verifyLiveChain(filePath: string): VerifyChainResult {
    const anchor = readAnchor(filePath);

    if (!fs.existsSync(filePath)) {
        // [DEFECT 2] A missing live file once a chain was anchored means the
        // file was deleted/moved out of band — not a clean "never written".
        return anchor
            ? { ok: false, brokenAt: 0, reason: 'audit log missing but genesis anchor present (possible deletion)' }
            : { ok: true, count: 0 };
    }

    const stat = fs.statSync(filePath);
    if (stat.size > AUDIT_READ_LIMIT) {
        return { ok: false, brokenAt: -1, reason: `audit file exceeds ${AUDIT_READ_LIMIT} bytes; rotate before verifying` };
    }
    if (stat.size === 0) {
        // [DEFECT 2] Legit rotation always writes a continuation record, so an
        // anchored-but-empty live file means an out-of-band truncate-to-zero.
        return anchor
            ? { ok: false, brokenAt: 0, reason: 'audit log is empty but genesis anchor present (truncation?)' }
            : { ok: true, count: 0 };
    }

    const effective = splitLines(fs.readFileSync(filePath, 'utf-8'));
    const anchorHash = anchor ? computeAnchorHash(anchor) : null;
    let note: ChainNote = anchor ? 'anchored' : 'legacy_genesis';
    let continuedFrom: string | undefined;
    let prevLineHash: string | null = null;

    for (let i = 0; i < effective.length; i++) {
        const line = effective[i]!;
        if (line === '') return { ok: false, brokenAt: i, reason: 'blank line inside audit log' };
        let entry: AuditEntry;
        try { entry = JSON.parse(line) as AuditEntry; }
        catch { return { ok: false, brokenAt: i, reason: `malformed JSON at line ${i}` }; }

        if (i === 0) {
            if (isContinuationEntry(entry)) {
                // [DEFECT 1] Post-rotation live file. The anchored genesis now
                // lives in an archive; verifyChainWithHistory() proves the link.
                note = 'continued';
                continuedFrom = entry.rotatedFrom;
            } else if (anchor) {
                // [DEFECT 2] Strict: genesis must tie to the on-disk anchor.
                if ((entry.prevHash ?? null) !== null || entry.anchorHash !== anchorHash) {
                    return {
                        ok: false,
                        brokenAt: 0,
                        reason: `genesis not anchored: expected anchorHash ${anchorHash}, record anchorHash ${entry.anchorHash ?? 'none'}, prevHash ${entry.prevHash ?? 'null'} (possible whole-file rewrite)`,
                    };
                }
            } else if ((entry.prevHash ?? null) !== null) {
                // Legacy genesis must be null (preserve the original contract).
                return { ok: false, brokenAt: 0, reason: `prevHash mismatch at line 0: record says ${entry.prevHash}, actual null` };
            }
            prevLineHash = sha256Hex(line + '\n');
            continue;
        }

        const expected = entry.prevHash ?? null;
        if (expected !== prevLineHash) {
            return {
                ok: false,
                brokenAt: i,
                reason: `prevHash mismatch at line ${i}: record says ${expected ?? 'null'}, actual ${prevLineHash ?? 'null'}`,
            };
        }
        prevLineHash = sha256Hex(line + '\n');
    }

    return { ok: true, count: effective.length, note, ...(continuedFrom ? { continuedFrom } : {}) };
}

/**
 * verifyChainWithHistory — walk the chain across ALL rotated archives AND the
 * live file, proving continuity over every rotation boundary (DEFECT 1).
 *
 * Segments are ordered oldest → newest: each `.gz` (gunzipped) then the live
 * file. With an anchor present (strict mode) it asserts:
 *   - the oldest segment's first record is the anchored genesis;
 *   - every later segment begins with a continuation record whose prevHash
 *     equals the previous segment's tail hash;
 *   - each segment's internal prevHash chain is intact.
 * Without an anchor (legacy mode) it verifies each segment internally and
 * tolerates the pre-fix null-genesis boundaries (so old logs don't false-alarm).
 */
export function verifyChainWithHistory(filePath: string): VerifyChainResult {
    const anchor = readAnchor(filePath);
    const anchorHash = anchor ? computeAnchorHash(anchor) : null;

    const segments: Array<{ label: string; lines: string[] }> = [];
    for (const ar of listArchives(filePath)) {
        try {
            const text = zlib.gunzipSync(fs.readFileSync(ar)).toString('utf-8');
            const lines = splitLines(text);
            if (lines.length) segments.push({ label: path.basename(ar), lines });
        } catch {
            return { ok: false, brokenAt: -1, reason: `cannot gunzip archive ${path.basename(ar)}` };
        }
    }
    if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath);
        if (stat.size > AUDIT_READ_LIMIT) return { ok: false, brokenAt: -1, reason: 'live audit file too large to verify' };
        const lines = splitLines(fs.readFileSync(filePath, 'utf-8'));
        if (lines.length) segments.push({ label: '(live)', lines });
    }

    if (segments.length === 0) {
        return anchor
            ? { ok: false, brokenAt: 0, reason: 'genesis anchor present but no audit data found (truncation/deletion?)' }
            : { ok: true, count: 0 };
    }

    let prevTail: string | null = null;
    let globalIndex = 0;

    for (let s = 0; s < segments.length; s++) {
        const seg = segments[s]!;
        for (let i = 0; i < seg.lines.length; i++) {
            const line = seg.lines[i]!;
            if (line === '') return { ok: false, brokenAt: globalIndex, reason: `blank line in ${seg.label}` };
            let entry: AuditEntry;
            try { entry = JSON.parse(line) as AuditEntry; }
            catch { return { ok: false, brokenAt: globalIndex, reason: `malformed JSON in ${seg.label} (local line ${i})` }; }

            if (s === 0 && i === 0) {
                // Very first record of the whole history.
                if (anchor) {
                    if (isContinuationEntry(entry)) {
                        return { ok: false, brokenAt: 0, reason: 'history begins with a continuation record but no anchored genesis' };
                    }
                    if ((entry.prevHash ?? null) !== null || entry.anchorHash !== anchorHash) {
                        return { ok: false, brokenAt: 0, reason: `oldest genesis not anchored (expected anchorHash ${anchorHash}, got ${entry.anchorHash ?? 'none'})` };
                    }
                }
                // legacy: accept whatever genesis it had.
            } else if (i === 0) {
                // Segment boundary (rotation).
                if (anchor) {
                    if (!isContinuationEntry(entry)) {
                        return { ok: false, brokenAt: globalIndex, reason: `segment ${seg.label} does not begin with a continuation record (rotation continuity broken)` };
                    }
                    if ((entry.prevHash ?? null) !== prevTail) {
                        return { ok: false, brokenAt: globalIndex, reason: `rotation continuity broken at ${seg.label}: continuation.prevHash ${entry.prevHash ?? 'null'} != prior segment tail ${prevTail ?? 'null'}` };
                    }
                }
                // legacy: pre-fix rotations reset to a null genesis with no
                // continuation record — accept the boundary and resume.
            } else {
                const expected = entry.prevHash ?? null;
                if (expected !== prevTail) {
                    return { ok: false, brokenAt: globalIndex, reason: `prevHash mismatch in ${seg.label} (global ${globalIndex}): record ${expected ?? 'null'} != actual ${prevTail ?? 'null'}` };
                }
            }

            prevTail = sha256Hex(line + '\n');
            globalIndex++;
        }
    }

    return { ok: true, count: globalIndex, segments: segments.length, note: anchor ? 'anchored' : 'legacy_history' };
}
