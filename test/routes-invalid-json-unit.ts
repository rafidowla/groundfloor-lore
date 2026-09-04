#!/usr/bin/env tsx
/**
 * test/routes-invalid-json-unit.ts — X-json400 audit (2026-09-03).
 *
 * FINDING: POST /api/node (mcp/http/routes/nodes/postNode.ts) answered 500
 * internal_error for a malformed/truncated JSON request body, because
 * JSON.parse sat inside the same generic try/catch as the rest of the write
 * gauntlet — a client mistake reported as a server crash. The audit found the
 * identical shape (JSON.parse or readJsonBody wrapped by a catch that never
 * checks for a parse failure before falling through to a domain-specific or
 * generic 500/other-status classifier) repeated across ~a dozen more route
 * files. Two files are owned by other workers and are OUT OF SCOPE here:
 * mcp/http/routes/edges.ts and mcp/http/routes/retention/policy.ts — neither
 * is touched or tested by this file.
 *
 * FIX: mcp/http/helpers.ts now tags the error `parseJsonBody`/`readJsonBody`
 * throw on malformed JSON with `code: 'invalid_json_body'` (INVALID_JSON_BODY),
 * and exports `isInvalidJsonBody(err)` + `writeInvalidJson(res, err)` — a
 * clean 400 that does NOT run the message through redactError (redactError's
 * quoted-token pass mangled the parser's own diagnostic into unreadable
 * `id#<hash>` fragments; that text is JSON-syntax metadata, not caller
 * content). Every route below was updated to check `isInvalidJsonBody` before
 * its old fallback.
 *
 * SCOPE OF THIS FILE:
 *   Part A — a full proof (400 + readable message, and 413 for an oversize
 *   body) for the primary target, POST /api/node.
 *   Part B — a 400 invalid_json_body regression test for every OTHER route
 *   where the audit found a genuine STATUS-CODE bug (malformed JSON used to
 *   answer 500, or some other wrong status) — these are the fail-before/
 *   pass-after cases. ~27 endpoints across 12 files.
 *   Part C — a handful of spot-checks for routes that already answered 400
 *   before this fix but ran the parse error through redactError, garbling the
 *   message into an `id#<hash>` fragment. These prove the message-cleanliness
 *   half of the fix; they are not exhaustive over every such site (see the
 *   worker's final report for the full table) since the status code there
 *   was already correct — only the message text changes.
 *
 * All tests drive route handlers DIRECTLY (no daemon, no HTTP listener,
 * no ports 3847/3848) with a mock IncomingMessage (EventEmitter) and a mock
 * ServerResponse, following the established pattern in
 * test/sw14-error-redaction-unit.ts. Deps objects are minimal stubs
 * (`as unknown as <Deps>`), matching the convention already used across this
 * suite (see test/r6-topology-scope-unit.ts, test/r4-scope-honesty-unit.ts) —
 * every case here throws during JSON.parse, before any dependency is
 * dereferenced, except the handful of routes whose catch block logs via
 * `deps.auditLog.log(...)` first (postNode, ingestion reconnect/reconsume,
 * admin retention/sweep), which get a real no-op log stub.
 */

import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';

import { handlePostNode } from '../packages/lore/src/mcp/http/routes/nodes/postNode.js';
import { handleSupersede, handleUnsupersede } from '../packages/lore/src/mcp/http/routes/nodes/supersede.js';
import { tryLifecycleRoutes } from '../packages/lore/src/mcp/http/routes/lifecycle.js';
import { tryOutcomesRoutes } from '../packages/lore/src/mcp/http/routes/outcomes.js';
import { tryVersioningRoutes } from '../packages/lore/src/mcp/http/routes/versioning.js';
import { tryAuditRoutes } from '../packages/lore/src/mcp/http/routes/audit.js';
import { tryConfigRoutes } from '../packages/lore/src/mcp/http/routes/config.js';
import { tryIngestionRoutes } from '../packages/lore/src/mcp/http/routes/ingestion.js';
import { tryVerbatimRoutes } from '../packages/lore/src/mcp/http/routes/retention/verbatim.js';
import { tryGovernanceRoutes } from '../packages/lore/src/mcp/http/routes/schema/governance.js';
import { tryProposalRoutes } from '../packages/lore/src/mcp/http/routes/schema/proposals.js';
import { tryMigrationRoutes } from '../packages/lore/src/mcp/http/routes/schema/migrations.js';
import { tryAdminRoutes } from '../packages/lore/src/mcp/http/routes/admin.js';
import { tryBulkListRoutes } from '../packages/lore/src/mcp/http/routes/bulkList.js';
import { tryWorkspaceMgmtRoutes } from '../packages/lore/src/mcp/http/routes/workspaces/workspaceMgmt.js';
import { MAX_BODY_BYTES } from '../packages/lore/src/mcp/http/helpers.js';

let passed = 0;
let failed = 0;
const tests: Array<Promise<void>> = [];

function test(name: string, fn: () => Promise<void> | void): void {
    tests.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? String(err)}`); failed++; }
    })());
}

// ── Mock req/res (pattern shared with test/sw14-error-redaction-unit.ts) ──

/** Build a mock IncomingMessage that emits a raw (possibly non-JSON) body. */
function makeMockReq(rawBody: string | Buffer, method = 'POST'): IncomingMessage {
    const emitter = new EventEmitter() as IncomingMessage;
    (emitter as unknown as Record<string, unknown>).method = method;
    (emitter as unknown as Record<string, unknown>).headers = { 'content-type': 'application/json' };
    setImmediate(() => {
        emitter.emit('data', Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody));
        emitter.emit('end');
    });
    return emitter;
}

interface MockResponse {
    readonly statusCode: number | null;
    readonly body: string;
    readonly res: ServerResponse;
}

function makeMockRes(): MockResponse {
    let statusCode: number | null = null;
    let body = '';
    const res: { headersSent: boolean; writeHead: (code: number) => void; end: (chunk?: string) => void } = {
        headersSent: false,
        writeHead(code: number) { statusCode = code; res.headersSent = true; },
        end(chunk?: string) { if (chunk) body += chunk; },
    };
    return { res: res as unknown as ServerResponse, get statusCode() { return statusCode; }, get body() { return body; } };
}

/** A body one byte over MAX_BODY_BYTES — must trip the 413 path, not the JSON one. */
function oversizeBody(): Buffer {
    return Buffer.alloc(MAX_BODY_BYTES + 1, 'a');
}

const TRUNCATED = '{"id":"x"'; // missing closing brace — the canonical malformed-JSON fixture used across this suite (see test/collections-routes-unit.ts).

/** Assert the standard 400 invalid_json_body envelope with a readable message. */
function assertInvalidJson(mock: MockResponse, label: string): void {
    assert.equal(mock.statusCode, 400, `${label}: must answer 400, got ${mock.statusCode}. Body: ${mock.body}`);
    const parsed = JSON.parse(mock.body) as { code?: string; message?: string };
    assert.equal(parsed.code, 'invalid_json_body', `${label}: code must be invalid_json_body. Got: ${mock.body}`);
    assert.ok(parsed.message && parsed.message.length > 0, `${label}: message must be present. Got: ${mock.body}`);
    // The redactError-garbling regression this fix closes: a quoted JSON
    // parse diagnostic run through redactError comes back as `id#<8-hex>`.
    assert.ok(!/id#[0-9a-f]{8}/.test(parsed.message ?? ''), `${label}: message must not be redactError-hashed. Got: ${parsed.message}`);
}

function assertOversize(mock: MockResponse, label: string): void {
    assert.equal(mock.statusCode, 413, `${label}: oversize body must answer 413, got ${mock.statusCode}. Body: ${mock.body}`);
}

const noopAuditLog = { log: () => { /* no-op */ } };

// ── Part A: POST /api/node (the primary finding) ───────────────────────────

test('POST /api/node — truncated JSON body -> 400 invalid_json_body (was 500)', async () => {
    const mock = makeMockRes();
    await handlePostNode(makeMockReq(TRUNCATED), mock.res, '', {
        deploymentMode: 'local', dataplane: null,
        store: { loreGraph: {} }, auditLog: noopAuditLog,
    } as unknown as Parameters<typeof handlePostNode>[3]);
    assertInvalidJson(mock, 'POST /api/node');
});

test('POST /api/node — >10MB body -> 413 (unchanged by this fix)', async () => {
    const mock = makeMockRes();
    await handlePostNode(makeMockReq(oversizeBody()), mock.res, '', {
        deploymentMode: 'local', dataplane: null,
        store: { loreGraph: {} }, auditLog: noopAuditLog,
    } as unknown as Parameters<typeof handlePostNode>[3]);
    assertOversize(mock, 'POST /api/node');
});

// ── Part B: every other route with a genuine 500 (or wrong-status) bug ─────

test('POST /api/nodes/prune — truncated JSON body -> 400 (was 500)', async () => {
    const mock = makeMockRes();
    await tryLifecycleRoutes(makeMockReq(TRUNCATED), mock.res, '', '/api/nodes/prune', {
        deploymentMode: 'local', dataplane: null,
    } as unknown as Parameters<typeof tryLifecycleRoutes>[4]);
    assertInvalidJson(mock, 'POST /api/nodes/prune');
});

test('POST /api/nodes/:id/restore — truncated JSON body -> 400 (was 500)', async () => {
    const mock = makeMockRes();
    await tryLifecycleRoutes(makeMockReq(TRUNCATED), mock.res, '', '/api/nodes/n1/restore', {
        deploymentMode: 'local', dataplane: null,
    } as unknown as Parameters<typeof tryLifecycleRoutes>[4]);
    assertInvalidJson(mock, 'POST /api/nodes/:id/restore');
});

test('POST /api/nodes/:id/outcomes — truncated JSON body -> 400 (was 500)', async () => {
    const mock = makeMockRes();
    await tryOutcomesRoutes(makeMockReq(TRUNCATED), mock.res, '', '/api/nodes/n1/outcomes', {
        deploymentMode: 'local', dataplane: null,
    } as unknown as Parameters<typeof tryOutcomesRoutes>[4]);
    assertInvalidJson(mock, 'POST /api/nodes/:id/outcomes');
});

test('POST /api/changesets — truncated JSON body -> 400 (was 500)', async () => {
    const mock = makeMockRes();
    await tryVersioningRoutes(makeMockReq(TRUNCATED), mock.res, '', '/api/changesets', {
        deploymentMode: 'local', dataplane: null,
    } as unknown as Parameters<typeof tryVersioningRoutes>[4]);
    assertInvalidJson(mock, 'POST /api/changesets');
});

test('POST /api/feedback — truncated JSON body -> 400 (was 500)', async () => {
    const mock = makeMockRes();
    await tryAuditRoutes(makeMockReq(TRUNCATED), mock.res, '', '/api/feedback', {
        deploymentMode: 'local', dataplane: null,
    } as unknown as Parameters<typeof tryAuditRoutes>[4]);
    assertInvalidJson(mock, 'POST /api/feedback');
});

test('POST /api/language/detect — truncated JSON body -> 400 (was 500)', async () => {
    const mock = makeMockRes();
    await tryConfigRoutes(makeMockReq(TRUNCATED), mock.res, '', '/api/language/detect', {
        deploymentMode: 'local', dataplane: null,
    } as unknown as Parameters<typeof tryConfigRoutes>[4]);
    assertInvalidJson(mock, 'POST /api/language/detect');
});

test('POST /api/graph/reconnect — truncated JSON body -> 400 (was 500)', async () => {
    const mock = makeMockRes();
    await tryIngestionRoutes(makeMockReq(TRUNCATED), mock.res, '', '/api/graph/reconnect', {
        deploymentMode: 'local', dataplane: null, auditLog: noopAuditLog,
    } as unknown as Parameters<typeof tryIngestionRoutes>[4]);
    assertInvalidJson(mock, 'POST /api/graph/reconnect');
});

test('POST /api/graph/reconnect — >10MB body -> 413 (unchanged by this fix)', async () => {
    const mock = makeMockRes();
    await tryIngestionRoutes(makeMockReq(oversizeBody()), mock.res, '', '/api/graph/reconnect', {
        deploymentMode: 'local', dataplane: null, auditLog: noopAuditLog,
    } as unknown as Parameters<typeof tryIngestionRoutes>[4]);
    assertOversize(mock, 'POST /api/graph/reconnect');
});

test('POST /api/graph/reconsume — truncated JSON body -> 400 (was 500)', async () => {
    const mock = makeMockRes();
    await tryIngestionRoutes(makeMockReq(TRUNCATED), mock.res, '', '/api/graph/reconsume', {
        deploymentMode: 'local', dataplane: null, auditLog: noopAuditLog,
    } as unknown as Parameters<typeof tryIngestionRoutes>[4]);
    assertInvalidJson(mock, 'POST /api/graph/reconsume');
});

test('POST /api/ingest/file — truncated JSON body -> 400 (was 500)', async () => {
    const mock = makeMockRes();
    await tryIngestionRoutes(makeMockReq(TRUNCATED), mock.res, '', '/api/ingest/file', {
        deploymentMode: 'local', dataplane: null, extractorRegistry: {},
    } as unknown as Parameters<typeof tryIngestionRoutes>[4]);
    assertInvalidJson(mock, 'POST /api/ingest/file');
});

test('POST /api/ingest/reprocess — truncated JSON body -> 400 (was 500)', async () => {
    const mock = makeMockRes();
    await tryIngestionRoutes(makeMockReq(TRUNCATED), mock.res, '', '/api/ingest/reprocess', {
        deploymentMode: 'local', dataplane: null, extractorRegistry: {},
    } as unknown as Parameters<typeof tryIngestionRoutes>[4]);
    assertInvalidJson(mock, 'POST /api/ingest/reprocess');
});

test('POST /api/node/supersede — truncated JSON body -> 400 (was 500)', async () => {
    const mock = makeMockRes();
    await handleSupersede(makeMockReq(TRUNCATED), mock.res, '', {
        deploymentMode: 'local', dataplane: null,
    } as unknown as Parameters<typeof handleSupersede>[3]);
    assertInvalidJson(mock, 'POST /api/node/supersede');
});

test('POST /api/node/unsupersede — truncated JSON body -> 400 (was 500)', async () => {
    const mock = makeMockRes();
    await handleUnsupersede(makeMockReq(TRUNCATED), mock.res, '', {
        deploymentMode: 'local', dataplane: null,
    } as unknown as Parameters<typeof handleUnsupersede>[3]);
    assertInvalidJson(mock, 'POST /api/node/unsupersede');
});

test('POST /api/verbatim/reap — truncated JSON body -> 400 (was 500)', async () => {
    const mock = makeMockRes();
    await tryVerbatimRoutes(makeMockReq(TRUNCATED), mock.res, '', {
        deploymentMode: 'local', dataplane: null,
    } as unknown as Parameters<typeof tryVerbatimRoutes>[3], '/api/verbatim/reap');
    assertInvalidJson(mock, 'POST /api/verbatim/reap');
});

test('POST /api/verbatim/tombstone — truncated JSON body -> 400 (was 500)', async () => {
    const mock = makeMockRes();
    await tryVerbatimRoutes(makeMockReq(TRUNCATED), mock.res, '', {
        deploymentMode: 'local', dataplane: null,
    } as unknown as Parameters<typeof tryVerbatimRoutes>[3], '/api/verbatim/tombstone');
    assertInvalidJson(mock, 'POST /api/verbatim/tombstone');
});

test('POST /api/verbatim (store) — truncated JSON body -> 400 (was 500)', async () => {
    const mock = makeMockRes();
    await tryVerbatimRoutes(makeMockReq(TRUNCATED), mock.res, '', {
        deploymentMode: 'local', dataplane: null,
    } as unknown as Parameters<typeof tryVerbatimRoutes>[3], '/api/verbatim');
    assertInvalidJson(mock, 'POST /api/verbatim (store)');
});

test('POST /api/schema/history/:file/rollback — truncated JSON body -> 400 (was 500)', async () => {
    const mock = makeMockRes();
    await tryGovernanceRoutes(makeMockReq(TRUNCATED), mock.res, '', '/api/schema/history/f1/rollback', {} as unknown as Parameters<typeof tryGovernanceRoutes>[4]);
    assertInvalidJson(mock, 'POST /api/schema/history/:file/rollback');
});

test('POST /api/schema/exceptions/:id/resolve — truncated JSON body -> 400 (was 500)', async () => {
    const mock = makeMockRes();
    await tryGovernanceRoutes(makeMockReq(TRUNCATED), mock.res, '', '/api/schema/exceptions/e1/resolve', {} as unknown as Parameters<typeof tryGovernanceRoutes>[4]);
    assertInvalidJson(mock, 'POST /api/schema/exceptions/:id/resolve');
});

test('POST /api/schema/proposals/:id/approve — truncated JSON body -> 400 (was 500)', async () => {
    const mock = makeMockRes();
    await tryProposalRoutes(makeMockReq(TRUNCATED), mock.res, {} as unknown as Parameters<typeof tryProposalRoutes>[2], '/api/schema/proposals/p1/approve');
    assertInvalidJson(mock, 'POST /api/schema/proposals/:id/approve');
});

test('POST /api/schema/proposals/:id/reject — truncated JSON body -> 400 (was 500)', async () => {
    const mock = makeMockRes();
    await tryProposalRoutes(makeMockReq(TRUNCATED), mock.res, {} as unknown as Parameters<typeof tryProposalRoutes>[2], '/api/schema/proposals/p1/reject');
    assertInvalidJson(mock, 'POST /api/schema/proposals/:id/reject');
});

const migrationDeps = { migrationBackend: {}, migrationCheckpointStore: {}, loreDir: '/tmp/x' } as unknown as Parameters<typeof tryMigrationRoutes>[2];

test('POST /api/schema/migrations/dry-run — truncated JSON body -> 400 (was 500)', async () => {
    const mock = makeMockRes();
    await tryMigrationRoutes(makeMockReq(TRUNCATED), mock.res, migrationDeps, '/api/schema/migrations/dry-run');
    assertInvalidJson(mock, 'POST /api/schema/migrations/dry-run');
});

test('POST /api/schema/migrations/execute — truncated JSON body -> 400 (was 500)', async () => {
    const mock = makeMockRes();
    await tryMigrationRoutes(makeMockReq(TRUNCATED), mock.res, migrationDeps, '/api/schema/migrations/execute');
    assertInvalidJson(mock, 'POST /api/schema/migrations/execute');
});

test('POST /api/schema/migrations/resume — truncated JSON body -> 400 (was 500)', async () => {
    const mock = makeMockRes();
    await tryMigrationRoutes(makeMockReq(TRUNCATED), mock.res, migrationDeps, '/api/schema/migrations/resume');
    assertInvalidJson(mock, 'POST /api/schema/migrations/resume');
});

test('POST /api/schema/migrations/decompose — truncated JSON body -> 400 (was 500)', async () => {
    const mock = makeMockRes();
    await tryMigrationRoutes(makeMockReq(TRUNCATED), mock.res, migrationDeps, '/api/schema/migrations/decompose');
    assertInvalidJson(mock, 'POST /api/schema/migrations/decompose');
});

test('POST /api/schema/migrations/rollback — truncated JSON body -> 400 (was 500)', async () => {
    const mock = makeMockRes();
    await tryMigrationRoutes(makeMockReq(TRUNCATED), mock.res, migrationDeps, '/api/schema/migrations/rollback');
    assertInvalidJson(mock, 'POST /api/schema/migrations/rollback');
});

test('POST /api/retention/sweep (admin.ts) — truncated JSON body -> 400 (was 500)', async () => {
    const mock = makeMockRes();
    await tryAdminRoutes(makeMockReq(TRUNCATED), mock.res, '', '/api/retention/sweep', {
        deploymentMode: 'local', dataplane: null, auditLog: noopAuditLog,
    } as unknown as Parameters<typeof tryAdminRoutes>[4]);
    assertInvalidJson(mock, 'POST /api/retention/sweep (admin.ts)');
});

test('POST /api/nodes/bulk-list — truncated JSON body -> 400 (was 500)', async () => {
    const mock = makeMockRes();
    await tryBulkListRoutes(makeMockReq(TRUNCATED), mock.res, '', '/api/nodes/bulk-list', {
        deploymentMode: 'local', dataplane: null,
    } as unknown as Parameters<typeof tryBulkListRoutes>[4]);
    assertInvalidJson(mock, 'POST /api/nodes/bulk-list');
});

test('POST /api/nodes/bulk-list — >10MB body -> 413 (unchanged by this fix)', async () => {
    const mock = makeMockRes();
    await tryBulkListRoutes(makeMockReq(oversizeBody()), mock.res, '', '/api/nodes/bulk-list', {
        deploymentMode: 'local', dataplane: null,
    } as unknown as Parameters<typeof tryBulkListRoutes>[4]);
    assertOversize(mock, 'POST /api/nodes/bulk-list');
});

// ── Part C: message-cleanliness spot checks (already 400, redactError-garbled before) ──

test('POST /api/workspaces (create) — truncated JSON body -> clean 400 message (was redactError-garbled)', async () => {
    const mock = makeMockRes();
    await tryWorkspaceMgmtRoutes(makeMockReq(TRUNCATED), mock.res, '', '/api/workspaces', {
        deploymentMode: 'local', dataplane: null,
    } as unknown as Parameters<typeof tryWorkspaceMgmtRoutes>[4]);
    assertInvalidJson(mock, 'POST /api/workspaces (create)');
});

test('POST /api/workspaces/switch — truncated JSON body -> clean 400 message (was redactError-garbled)', async () => {
    const mock = makeMockRes();
    await tryWorkspaceMgmtRoutes(makeMockReq(TRUNCATED), mock.res, '', '/api/workspaces/switch', {
        deploymentMode: 'local', dataplane: null,
    } as unknown as Parameters<typeof tryWorkspaceMgmtRoutes>[4]);
    assertInvalidJson(mock, 'POST /api/workspaces/switch');
});

// ── runner ───────────────────────────────────────────────────────────────

console.log('\n=== X-json400: malformed-body regression across mcp/http/routes/** ===\n');
await Promise.all(tests);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
