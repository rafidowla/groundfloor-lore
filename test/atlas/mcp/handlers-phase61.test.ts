/**
 * test/atlas/mcp/handlers-phase61.test.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * Smoke test for the 5 Phase 6.1 handler scaffolds.
 *
 * License-compliance note: original work; see
 * `docs/PLAN_replace_gitnexus_in_developer_plugin.md` section 10.
 */

import * as assert from 'node:assert/strict';
import {
    ATLAS_HANDLERS_PHASE61,
    handleCodeContext,
    handleCodeCypher,
    handleCodeQuery,
    handleCodeRename,
    handleCodeSearchAst,
    type Phase61Context,
} from '../../../packages/lore-plugin-developer/src/mcp/handlers-phase61.js';
import type { ParsedSymbol } from '../../../packages/lore-plugin-developer/src/parser/types.js';

function makeSymbol(over: Partial<ParsedSymbol> = {}): ParsedSymbol {
    return {
        id: 'src/foo.ts:greet:function',
        name: 'greet',
        qualifiedName: 'greet',
        kind: 'function',
        file: 'src/foo.ts',
        byteRange: { start: 0, end: 10, startLine: 1, endLine: 1 },
        signature: 'function greet()',
        complexity: 1,
        parentSymbolId: null,
        parsedAt: new Date().toISOString(),
        ...over,
    };
}

function makeCtx(over: Partial<Phase61Context> = {}): Phase61Context {
    const sym = makeSymbol();
    return {
        repoRoot: '/tmp/repo',
        table: {
            byId: new Map([[sym.id, sym]]),
            byQualifiedName: new Map([[sym.qualifiedName, [sym]]]),
            byFile: new Map([[sym.file, [sym]]]),
            all: [sym],
        },
        relations: [],
        graph: null,
        verbatimStore: null,
        nativeTools: null,
        ...over,
    };
}

function isNotYetWired(result: unknown, handler: string): boolean {
    return typeof result === 'object'
        && result !== null
        && (result as { error?: string }).error === 'not-yet-wired'
        && (result as { handler?: string }).handler === handler;
}

function main() {
    // ── code_query: needs verbatimStore ──
    const queryResult = handleCodeQuery(makeCtx(), { query: 'auth' });
    assert.ok(isNotYetWired(queryResult, 'code_query'),
        `code_query should return not-yet-wired without verbatimStore. Got: ${JSON.stringify(queryResult)}`);

    // ── code_query with verbatimStore bound: returns implementation-pending notice ──
    const queryResultBound = handleCodeQuery(makeCtx({ verbatimStore: {} }), { query: 'auth' });
    assert.ok(typeof queryResultBound === 'object' && queryResultBound !== null
        && 'notice' in queryResultBound,
        'code_query with verbatimStore bound should return implementation-pending notice');

    // ── code_context: works partially without ctx.graph ──
    const ctxResult = handleCodeContext(makeCtx(), { name: 'greet', depth: 1 }) as { partial: boolean; symbol?: unknown };
    assert.equal(ctxResult.partial, true, 'code_context without graph should be partial');
    assert.ok(ctxResult.symbol, 'code_context should still return symbol from snapshot');

    // ── code_context with graph: not partial ──
    const ctxResultBound = handleCodeContext(makeCtx({ graph: {} }), { name: 'greet', depth: 1 }) as { partial: boolean };
    assert.equal(ctxResultBound.partial, false, 'code_context with graph should not be partial');

    // ── code_context: symbol-not-found path ──
    const ctxNotFound = handleCodeContext(makeCtx(), { name: 'doesNotExist' }) as { error?: string };
    assert.ok(ctxNotFound.error?.includes('not found'));

    // ── code_rename: needs nativeTools ──
    const renameResult = handleCodeRename(makeCtx(), { symbol: 'greet', newName: 'salute' });
    assert.ok(isNotYetWired(renameResult, 'code_rename'));

    // ── code_cypher: needs graph ──
    const cypherResult = handleCodeCypher(makeCtx(), { query: 'MATCH (n) RETURN n' });
    assert.ok(isNotYetWired(cypherResult, 'code_cypher'));

    // ── code_cypher with graph: read-only enforcement ──
    const writeCypher = handleCodeCypher(makeCtx({ graph: {} }), { query: 'CREATE (n:Foo) RETURN n' }) as { error?: string; rejectedKeyword?: string };
    assert.equal(writeCypher.error, 'read-only', 'code_cypher should reject CREATE');
    assert.equal(writeCypher.rejectedKeyword, 'CREATE');

    const writeCypher2 = handleCodeCypher(makeCtx({ graph: {} }), { query: 'MATCH (n) DETACH DELETE n' }) as { error?: string; rejectedKeyword?: string };
    assert.equal(writeCypher2.error, 'read-only');
    // Whichever keyword scans first wins; both DETACH and DELETE are blocked.
    assert.ok(['DELETE', 'DETACH'].includes(writeCypher2.rejectedKeyword ?? ''));

    // ── code_cypher with graph + safe query: passes the read-only gate ──
    const readCypher = handleCodeCypher(makeCtx({ graph: {} }), { query: 'MATCH (n:CodeSymbol) RETURN n LIMIT 10' }) as { notice?: string };
    assert.ok(readCypher.notice, 'safe MATCH query should reach implementation-pending notice');

    // ── code_search_ast: parsers not yet surfaced ──
    const astResult = handleCodeSearchAst(makeCtx(), { pattern: '(call_expression)' });
    assert.ok(isNotYetWired(astResult, 'code_search_ast'));

    // ── Registry: 5 entries, all callable ──
    assert.equal(ATLAS_HANDLERS_PHASE61.size, 5);
    for (const name of ['code_query', 'code_context', 'code_rename', 'code_cypher', 'code_search_ast']) {
        const handler = ATLAS_HANDLERS_PHASE61.get(name);
        assert.ok(typeof handler === 'function', `expected handler for ${name}`);
    }

    console.log('✓ phase 6.1 handler scaffolds smoke test (5 handlers)');
}

main();
