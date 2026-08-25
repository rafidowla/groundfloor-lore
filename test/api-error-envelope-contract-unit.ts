#!/usr/bin/env tsx
/**
 * test/api-error-envelope-contract-unit.ts — Wave 5 Step 3: lock the frozen
 * error-envelope contract.
 *
 * DECISION (Wave 5, API freeze): the single canonical HTTP error envelope is
 *
 *   { code: string, message: string, ...extras }
 *
 * emitted exclusively via `writeError` / `writeWorkspaceRequired` /
 * `writeOutboxBackpressure` in packages/lore/src/mcp/http/helpers.ts. Wave 4/5
 * codemods swept the route families to stop hand-rolling `{ error: ... }`
 * bodies. This test is the ratchet that keeps a hand-rolled shape from
 * creeping back in — it has two parts:
 *
 *   PART A (static scan) — walk every file under
 *   packages/lore/src/mcp/http/routes/** and flag any
 *   `res.end(JSON.stringify({ ... }))` call whose top-level object literal
 *   has a top-level `error:` key. That is the exact hand-rolled shape the
 *   codemod eliminated ({error: ...} instead of {code, message}).
 *
 *   The scan is deliberately scoped to the *response-body call site*, not
 *   every occurrence of the token `error` in a route file — route files
 *   legitimately use `error:` as a field name in internal discriminated
 *   unions (`resolveWorkspaceOrError` helpers), per-item bulk-result rows
 *   (`{ ok: false, error: '...' }` inside a `results[]` array), and
 *   redaction helper signatures. None of those are HTTP response envelopes;
 *   flagging every `error:` token would drown real violations in false
 *   positives. Only the literal object passed to `JSON.stringify(...)`
 *   inside `.end(JSON.stringify(...))` is inspected.
 *
 *   PART B (runtime check) — import writeError / writeWorkspaceRequired
 *   from helpers.ts and assert against a mock ServerResponse that the
 *   emitted body actually deserializes to `{code, message, ...extras}`
 *   with no `error` key, and that the HTTP status code passed through
 *   untouched (status codes are isolation-critical and out of scope for
 *   this wave's body-shape changes).
 *
 * PART A also sweeps four named NON-ROUTE layers that hand-write HTTP error
 * JSON bodies outside routes/**: security/httpAuth.ts, mcp/http/middleware.ts,
 * mcp/http/dispatcher.ts, mcp/server.ts. These were swept to {code, message}
 * in Wave 5 (RC audit) alongside the route families, but — unlike
 * routes/** — were never covered by this ratchet, so a regression there
 * would go undetected. `NON_ROUTE_SWEPT_FILES` is the ratchet allowlist for
 * those four files: seeded to `[]` (verified clean on this tree). Any file
 * in the list that is NOT actually clean fails the test (stale-entry
 * ratchet, mirrors D-021's pattern in scripts/test-arch.mjs) so the list
 * can't silently rot into a permanent exemption.
 *
 * Run: npx tsx test/api-error-envelope-contract-unit.ts
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const routesRoot = path.join(repoRoot, 'packages/lore/src/mcp/http/routes');

/**
 * Non-route layers swept to {code, message} in Wave 5 that carry NO ratchet
 * coverage today. Scanned with the SAME hand-rolled-{error:...} detector as
 * routes/**. This allowlist is NOT "files allowed to violate" — it is a
 * stale-entry ratchet: every path listed here must currently scan CLEAN, or
 * the test fails and tells you to remove it. Its only job is to pin the set
 * of extra files under coverage so someone extending the sweep later can see
 * at a glance what is (and isn't) protected.
 */
const NON_ROUTE_SWEPT_FILES = [
    'packages/lore/src/security/httpAuth.ts',
    'packages/lore/src/mcp/http/middleware.ts',
    'packages/lore/src/mcp/http/dispatcher.ts',
    'packages/lore/src/mcp/server.ts',
] as const;

let passed = 0;
let failed = 0;
const test = async (name: string, fn: () => void | Promise<void>) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

// ── PART A: static scan ─────────────────────────────────────────────────────

interface Violation {
    file: string;
    line: number;
    snippet: string;
}

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(abs, out); continue; }
        if (entry.isFile() && entry.name.endsWith('.ts')) out.push(abs);
    }
    return out;
}

/**
 * Find every `.end(JSON.stringify(<expr>))` call in `content` and return the
 * balanced-paren text of `<expr>` (the argument to JSON.stringify). This is
 * a lightweight brace/paren matcher, not a full parser — it is the same
 * "regex/ast-ish scan" approach scripts/test-arch.mjs already uses for the
 * D-017/D-021 architecture rules, applied to a narrower call-site pattern.
 */
function findJsonStringifyEndArgs(content: string): Array<{ start: number; text: string }> {
    const results: Array<{ start: number; text: string }> = [];
    const callRe = /\.end\(\s*JSON\.stringify\(/g;
    let m: RegExpExecArray | null;
    while ((m = callRe.exec(content)) !== null) {
        // m.index + full match length - 1 is the index of the '(' that opens
        // JSON.stringify's argument list.
        const openParenIdx = callRe.lastIndex - 1;
        if (content[openParenIdx] !== '(') continue;
        let depth = 0;
        let i = openParenIdx;
        for (; i < content.length; i++) {
            if (content[i] === '(') depth++;
            else if (content[i] === ')') {
                depth--;
                if (depth === 0) break;
            }
        }
        results.push({ start: openParenIdx, text: content.slice(openParenIdx, i + 1) });
    }
    return results;
}

/**
 * A top-level `error:` key inside the JSON.stringify argument. Matches
 * `error:` preceded by `{` or `,` (allowing whitespace/newlines) so it only
 * catches the key at the object's own level, not inside a nested value —
 * though for this narrow call-site pattern (small literal error bodies) a
 * simple token match on the whole snippet is sufficient in practice; the
 * negative lookbehind avoids matching identifiers like `myError:` or
 * `hasError:`.
 */
const TOP_LEVEL_ERROR_KEY_RE = /(?<![A-Za-z0-9_$])error\s*:/;

/** Scan a single absolute file path for hand-rolled {error: ...} response
 *  bodies; shared by the routes/** walk and the named non-route sweep. */
function scanFileForHandRolledErrorEnvelopes(abs: string): Violation[] {
    const violations: Violation[] = [];
    const rel = path.relative(repoRoot, abs).replace(/\\/g, '/');
    const content = fs.readFileSync(abs, 'utf8');
    for (const { start, text } of findJsonStringifyEndArgs(content)) {
        if (!TOP_LEVEL_ERROR_KEY_RE.test(text)) continue;
        const line = content.slice(0, start).split('\n').length;
        violations.push({
            file: rel,
            line,
            snippet: text.replace(/\s+/g, ' ').slice(0, 140),
        });
    }
    return violations;
}

function scanRoutesForHandRolledErrorEnvelopes(): Violation[] {
    const violations: Violation[] = [];
    const files = walk(routesRoot).filter((f) => f.endsWith('.ts'));
    for (const abs of files) {
        violations.push(...scanFileForHandRolledErrorEnvelopes(abs));
    }
    return violations;
}

await test('no route under mcp/http/routes/** hand-rolls a {error: ...} JSON response body', () => {
    const violations = scanRoutesForHandRolledErrorEnvelopes();
    if (violations.length > 0) {
        const report = violations
            .map((v) => `    ${v.file}:${v.line} — ${v.snippet}`)
            .join('\n');
        assert.fail(
            `${violations.length} hand-rolled {error: ...} response bod${violations.length === 1 ? 'y' : 'ies'} found ` +
            `(must go through writeError/writeWorkspaceRequired/writeOutboxBackpressure instead):\n${report}`,
        );
    }
});

await test('non-route swept layers (httpAuth/middleware/dispatcher/server) hand-roll no {error: ...} body — stale-entry ratchet', () => {
    const staleEntries: string[] = [];
    const liveViolations: Violation[] = [];
    for (const rel of NON_ROUTE_SWEPT_FILES) {
        const abs = path.join(repoRoot, rel);
        if (!fs.existsSync(abs)) {
            // A listed file was moved/renamed/deleted — the allowlist entry
            // is stale either way; fail loudly rather than silently no-op.
            staleEntries.push(`${rel} (file not found — update NON_ROUTE_SWEPT_FILES)`);
            continue;
        }
        const violations = scanFileForHandRolledErrorEnvelopes(abs);
        liveViolations.push(...violations);
    }
    if (liveViolations.length > 0) {
        const report = liveViolations
            .map((v) => `    ${v.file}:${v.line} — ${v.snippet}`)
            .join('\n');
        assert.fail(
            `${liveViolations.length} hand-rolled {error: ...} response bod${liveViolations.length === 1 ? 'y' : 'ies'} found ` +
            `in the non-route swept layers (must go through writeError/writeAuthFailure's {code,message} shape instead):\n${report}`,
        );
    }
    if (staleEntries.length > 0) {
        assert.fail(`NON_ROUTE_SWEPT_FILES has stale entries:\n    ${staleEntries.join('\n    ')}`);
    }
});

// ── PART B: runtime check ───────────────────────────────────────────────────

await test('writeError() emits the canonical {code, message, ...extras} envelope (no `error` key)', async () => {
    const { writeError } = await import('../packages/lore/src/mcp/http/helpers.js');

    let status: number | undefined;
    let headers: Record<string, string> | undefined;
    let body = '';
    const mockRes = {
        writeHead: (s: number, h: Record<string, string>) => { status = s; headers = h; },
        end: (b: string) => { body = b; },
    } as unknown as import('node:http').ServerResponse;

    writeError(mockRes, 404, 'not_found', 'node does not exist', { nodeId: 'abc' });

    assert.equal(status, 404, 'HTTP status passes through untouched');
    assert.equal(headers?.['Content-Type'], 'application/json');
    const parsed = JSON.parse(body) as Record<string, unknown>;
    assert.equal(parsed['code'], 'not_found');
    assert.equal(parsed['message'], 'node does not exist');
    assert.equal(parsed['nodeId'], 'abc', 'extras ride along on the envelope');
    assert.equal('error' in parsed, false, 'canonical envelope must not carry a legacy `error` key');
});

await test('writeWorkspaceRequired() emits {code:"workspace_required", message} at HTTP 400', async () => {
    const { writeWorkspaceRequired } = await import('../packages/lore/src/mcp/http/helpers.js');

    let status: number | undefined;
    let body = '';
    const mockRes = {
        writeHead: (s: number) => { status = s; },
        end: (b: string) => { body = b; },
    } as unknown as import('node:http').ServerResponse;

    writeWorkspaceRequired(mockRes);

    assert.equal(status, 400, 'status code is isolation-critical and must stay 400');
    const parsed = JSON.parse(body) as Record<string, unknown>;
    assert.equal(parsed['code'], 'workspace_required');
    assert.equal(typeof parsed['message'], 'string');
    assert.equal('error' in parsed, false);
});

await test('writeError() never changes HTTP status across a range of codes (status/body independence)', async () => {
    const { writeError } = await import('../packages/lore/src/mcp/http/helpers.js');

    for (const status of [400, 401, 403, 404, 409, 413, 429, 500, 503]) {
        let seenStatus: number | undefined;
        let body = '';
        const mockRes = {
            writeHead: (s: number) => { seenStatus = s; },
            end: (b: string) => { body = b; },
        } as unknown as import('node:http').ServerResponse;
        writeError(mockRes, status, 'some_code', 'some message');
        assert.equal(seenStatus, status, `status ${status} must pass through unchanged`);
        const parsed = JSON.parse(body) as Record<string, unknown>;
        assert.deepEqual(Object.keys(parsed).sort(), ['code', 'message'], `envelope shape is fixed regardless of status ${status}`);
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
