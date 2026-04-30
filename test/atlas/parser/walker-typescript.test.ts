/**
 * test/atlas/parser/walker-typescript.test.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * TS walker extracts the expected ParsedSymbol set on a synthetic source.
 *
 * Phase: 1 (parser foundation).
 *
 * License-compliance note: original work; see
 * `docs/PLAN_replace_gitnexus_in_developer_plugin.md` section 10.
 *
 * Runs as a plain `tsx` script — no test framework. Each `assert.*`
 * throws on failure with a useful message; success exits 0. Hooked
 * into `npm test` in a follow-up commit.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as assert from 'node:assert/strict';
import { parseFile } from '../../../packages/lore-plugin-developer/src/parser/index.js';

async function withTempFile<T>(name: string, content: string, fn: (p: string) => Promise<T>): Promise<T> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-test-'));
    const filePath = path.join(dir, name);
    await fs.writeFile(filePath, content, 'utf-8');
    try {
        return await fn(filePath);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}

async function testTopLevelFunction(): Promise<void> {
    const source = `
export function greet(name: string): string {
    if (name) return 'hello ' + name;
    return 'hello world';
}
`;
    const result = await withTempFile('greet.ts', source, (p) => parseFile(p));
    assert.ok(result, 'parseFile returned null');
    assert.equal(result.language, 'typescript');
    const fn = result.symbols.find((s) => s.name === 'greet');
    assert.ok(fn, `expected to find 'greet' function. Got: ${result.symbols.map((s) => s.name).join(', ')}`);
    assert.equal(fn.kind, 'function');
    assert.equal(fn.qualifiedName, 'greet');
    assert.ok(fn.complexity >= 2, `complexity should be >=2 for if + base, got ${fn.complexity}`);
    assert.ok(fn.signature.includes('greet'), `signature should include 'greet': ${fn.signature}`);
    console.log('✓ top-level function extraction');
}

async function testClassWithMethods(): Promise<void> {
    const source = `
export class Greeter {
    private prefix: string;

    constructor(prefix: string) {
        this.prefix = prefix;
    }

    greet(name: string): string {
        if (!name) return this.prefix;
        return this.prefix + ' ' + name;
    }

    static create(p: string): Greeter {
        return new Greeter(p);
    }
}
`;
    const result = await withTempFile('greeter.ts', source, (p) => parseFile(p));
    assert.ok(result);
    const cls = result.symbols.find((s) => s.kind === 'class' && s.name === 'Greeter');
    assert.ok(cls, 'expected to find Greeter class');
    const methods = result.symbols.filter((s) => s.kind === 'method' && s.parentSymbolId === cls.id);
    const methodNames = methods.map((m) => m.name).sort();
    assert.deepEqual(
        methodNames,
        ['constructor', 'create', 'greet'].sort(),
        `expected methods constructor/greet/create, got ${JSON.stringify(methodNames)}`,
    );
    const greetMethod = methods.find((m) => m.name === 'greet');
    assert.ok(greetMethod);
    assert.equal(greetMethod.qualifiedName, 'Greeter.greet');
    console.log('✓ class with methods + parent chain');
}

async function testInterfaceAndTypeAlias(): Promise<void> {
    const source = `
export interface User {
    id: string;
    name: string;
    email?: string;
}

export type UserId = string;

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
`;
    const result = await withTempFile('user.ts', source, (p) => parseFile(p));
    assert.ok(result);
    const iface = result.symbols.find((s) => s.name === 'User');
    assert.ok(iface, 'expected to find User interface');
    assert.equal(iface.kind, 'interface');
    const aliases = result.symbols.filter((s) => s.kind === 'type');
    const aliasNames = aliases.map((a) => a.name).sort();
    assert.deepEqual(aliasNames, ['Result', 'UserId']);
    console.log('✓ interface + type aliases');
}

async function testImports(): Promise<void> {
    const source = `
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import defaultExport from './local-module';

export function noop(): void {}
`;
    const result = await withTempFile('imports.ts', source, (p) => parseFile(p));
    assert.ok(result);
    assert.equal(result.imports.length, 3, `expected 3 imports, got ${result.imports.length}`);
    const specifiers = result.imports.map((i) => i.moduleSpecifier).sort();
    assert.deepEqual(specifiers, ['./local-module', 'node:fs/promises', 'node:path']);
    const wildcardImport = result.imports.find((i) => i.moduleSpecifier === 'node:path');
    assert.ok(wildcardImport);
    assert.ok(wildcardImport.names.includes('*'), `wildcard import should have '*' in names: ${JSON.stringify(wildcardImport.names)}`);
    console.log('✓ imports (named, wildcard, default)');
}

async function testEnum(): Promise<void> {
    const source = `
export enum Severity {
    Info = 'info',
    Warn = 'warn',
    Error = 'error',
}
`;
    const result = await withTempFile('enum.ts', source, (p) => parseFile(p));
    assert.ok(result);
    const en = result.symbols.find((s) => s.name === 'Severity');
    assert.ok(en, 'expected to find Severity enum');
    assert.equal(en.kind, 'enum');
    console.log('✓ enum extraction');
}

async function testCyclomaticComplexity(): Promise<void> {
    const source = `
export function complex(x: number, y: number): string {
    if (x > 0) {
        if (y > 0) {
            for (let i = 0; i < x; i++) {
                if (i % 2) return 'a';
            }
        }
    } else if (x < 0) {
        return y > 0 ? 'b' : 'c';
    }
    return 'd';
}
`;
    const result = await withTempFile('complex.ts', source, (p) => parseFile(p));
    assert.ok(result);
    const fn = result.symbols.find((s) => s.name === 'complex');
    assert.ok(fn);
    // 1 (entry) + if (1) + if (1) + for (1) + if (1) + else_clause (1) + ternary (1) = 7-ish.
    // Tree-sitter may also count else_clause separately; we accept 5–10 range.
    assert.ok(fn.complexity >= 5 && fn.complexity <= 12, `complexity ${fn.complexity} out of expected range [5, 12]`);
    console.log(`✓ cyclomatic complexity (got ${fn.complexity})`);
}

async function main(): Promise<void> {
    console.log('Running TS walker tests...\n');
    await testTopLevelFunction();
    await testClassWithMethods();
    await testInterfaceAndTypeAlias();
    await testImports();
    await testEnum();
    await testCyclomaticComplexity();
    console.log('\n✓ All TS walker tests passed.');
}

main().catch((err: unknown) => {
    console.error('\n✗ Test failed:', err);
    process.exit(1);
});
