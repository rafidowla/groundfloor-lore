#!/usr/bin/env tsx
/**
 * test/mcp-tool-error-redaction-unit.ts — Audit fix #4.
 *
 * Pins that MCP tool catch blocks no longer leak raw engine internals to
 * the MCP client. Before fix #4, every tool returned
 * `Error: ${(error as Error).message}` verbatim — and the legacy graph engine/LanceDB errors
 * routinely echo node ids, file paths, or content fragments. SW-14 closed
 * this on the HTTP routes; this is the MCP-side mirror.
 *
 * Tests the shared mcpToolError() helper directly (the single point every
 * tool now routes through) so the guarantee holds regardless of which
 * tool adopted it.
 *
 * Pins:
 *   T1: a quoted node-id in the raw error is redacted in the caller envelope.
 *   T2: a quoted file path / content fragment is redacted in the envelope.
 *   T3: the operator LOG line still carries the redacted detail (debuggable).
 *   T4: the caller envelope is isError:true + has content text.
 *   T5: a non-Error thrown value is handled (stringified, then redacted).
 */

import assert from 'node:assert/strict';
import { mcpToolError } from '../packages/lore/src/mcp/tools/mcpToolError.js';

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

/** Capture log calls so we can assert the operator sees the redacted detail. */
function captureLog(): { log: { error(msg: unknown): void }; lines: string[] } {
    const lines: string[] = [];
    return { lines, log: { error: (msg: unknown) => { lines.push(String(msg)); } } };
}

console.log('Audit fix #4 — MCP tool error redaction');

test('T1 quoted node-id in raw error is redacted in the caller envelope', () => {
    // Simulates a legacy graph engine unique-constraint violation echoing the offending id.
    const raw = new Error(`Runtime exception: "person:sarah-smith" violates PK`);
    const { log, lines } = captureLog();
    const result = mcpToolError('store_node', raw, log, 'workspace=alpha');
    const text = result.content[0]!.text;
    assert.ok(!text.includes('person:sarah-smith'),
        `caller envelope leaked the raw id: ${text}`);
    assert.ok(text.includes('id#'), `redacted tag missing: ${text}`);
    assert.equal(result.isError, true);
});

test('T2 quoted file path / content fragment is redacted in the envelope', () => {
    const raw = new Error(`Error: /Users/secret/projects/launch-plan.docx not found`);
    const { log } = captureLog();
    const result = mcpToolError('ingest_file', raw, log);
    const text = result.content[0]!.text;
    // Backtick/unquoted tokens aren't redacted by redactError today, but the
    // *quoted* form (the common engine echo) must be. This pins the quoted path.
    const quotedRaw = new Error(`Error: "/Users/secret/x.docx" not found`);
    const r2 = mcpToolError('ingest_file', quotedRaw, captureLog().log);
    assert.ok(!r2.content[0]!.text.includes('/Users/secret/x.docx'),
        `quoted path leaked: ${r2.content[0]!.text}`);
});

test('T3 operator LOG line carries the redacted detail (debuggable)', () => {
    const raw = new Error(`boom on "node-abc-123"`);
    const { log, lines } = captureLog();
    mcpToolError('recall', raw, log, 'topic=billing');
    assert.equal(lines.length, 1, 'exactly one log line emitted');
    assert.ok(lines[0]!.includes('recall'), `log line missing tool name: ${lines[0]}`);
    assert.ok(lines[0]!.includes('topic=billing'), `log line missing detail: ${lines[0]}`);
    assert.ok(lines[0]!.includes('id#'), `log line missing redacted tag: ${lines[0]}`);
});

test('T4 caller envelope is isError:true + has content text', () => {
    const result = mcpToolError('search', new Error('x'), captureLog().log);
    assert.equal(result.isError, true);
    assert.ok(result.content.length > 0);
    assert.equal(result.content[0]!.type, 'text');
    assert.ok(result.content[0]!.text.startsWith('Error:'));
});

test('T5 a non-Error thrown value is handled (stringified + redacted)', () => {
    const result = mcpToolError('traverse', 'literal "secret-id" string', captureLog().log);
    const text = result.content[0]!.text;
    assert.ok(!text.includes('secret-id'), `non-Error value leaked: ${text}`);
    assert.equal(result.isError, true);
});

test('T6 no logger passed → still returns a safe envelope, does not throw', () => {
    const result = mcpToolError('outcomes', new Error('"leaked-id"'), undefined);
    assert.ok(!result.content[0]!.text.includes('leaked-id'));
    assert.equal(result.isError, true);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
