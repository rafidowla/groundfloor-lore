/**
 * test/atlas/resolver/symbol-table.test.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * Symbol-table builder smoke test on synthetic ParsedFile inputs.
 *
 * Phase: 2 (cross-file resolution — fallback path).
 *
 * License-compliance note: original work; see
 * `docs/PLAN_replace_gitnexus_in_developer_plugin.md` section 10.
 */

import * as assert from 'node:assert/strict';
import { buildSymbolTable, lookupByQualifiedName, lookupInFile } from '../../../packages/lore-plugin-developer/src/resolver/symbolTable.js';
import type { ParsedFile, ParsedSymbol } from '../../../packages/lore-plugin-developer/src/parser/types.js';

function mkSymbol(file: string, name: string, qualifiedName: string, kind: ParsedSymbol['kind'] = 'function'): ParsedSymbol {
    return {
        id: `${file}:${qualifiedName}:${kind}`,
        name,
        qualifiedName,
        kind,
        file,
        byteRange: { start: 0, end: 0, startLine: 1, endLine: 1 },
        signature: `${kind} ${qualifiedName}`,
        complexity: 1,
        parentSymbolId: null,
        parsedAt: '2026-04-30T00:00:00.000Z',
    };
}

function mkFile(path: string, symbols: ParsedSymbol[]): ParsedFile {
    return {
        path,
        language: 'typescript',
        symbols,
        imports: [],
        sizeBytes: 0,
        loc: 0,
        parsedAt: '2026-04-30T00:00:00.000Z',
    };
}

async function main() {
    const fileA = mkFile('a.ts', [
        mkSymbol('a.ts', 'foo', 'foo'),
        mkSymbol('a.ts', 'bar', 'bar'),
    ]);
    const fileB = mkFile('b.ts', [
        mkSymbol('b.ts', 'Greeter', 'Greeter', 'class'),
        mkSymbol('b.ts', 'greet', 'Greeter.greet', 'method'),
    ]);

    const table = buildSymbolTable([fileA, fileB]);

    assert.equal(table.all.length, 4, `expected 4 total symbols, got ${table.all.length}`);

    const foo = lookupByQualifiedName(table, 'foo');
    assert.ok(foo, 'expected to find foo by qualified name');
    assert.equal(foo.file, 'a.ts');

    const greet = lookupByQualifiedName(table, 'Greeter.greet');
    assert.ok(greet);
    assert.equal(greet.kind, 'method');

    const localFoo = lookupInFile(table, 'a.ts', 'foo');
    assert.equal(localFoo.length, 1);
    const localGreet = lookupInFile(table, 'b.ts', 'greet');
    assert.equal(localGreet.length, 1);
    const missing = lookupInFile(table, 'a.ts', 'doesNotExist');
    assert.equal(missing.length, 0);

    const fooById = table.byId.get('a.ts:foo:function');
    assert.ok(fooById);
    assert.equal(fooById.name, 'foo');

    console.log('✓ symbol-table builder + lookups');
}

main().catch((err) => { console.error('✗ symbol-table:', err); process.exit(1); });
