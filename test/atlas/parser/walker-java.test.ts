/**
 * test/atlas/parser/walker-java.test.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * Java walker smoke test on synthetic source.
 *
 * Phase: 1 (parser foundation).
 *
 * License-compliance note: original work; see
 * `docs/PLAN_replace_gitnexus_in_developer_plugin.md` section 10.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as assert from 'node:assert/strict';
import { parseFile } from '../../../packages/lore-plugin-developer/src/parser/index.js';

const SOURCE = `
package com.example;

import java.util.List;
import java.util.Map;

public interface Greeter {
    String greet(String name);
}

public class HelloGreeter implements Greeter {
    private final String prefix;

    public HelloGreeter(String prefix) {
        this.prefix = prefix;
    }

    @Override
    public String greet(String name) {
        if (name == null || name.isEmpty()) {
            return prefix;
        }
        return prefix + " " + name;
    }

    public static HelloGreeter create(String p) {
        return new HelloGreeter(p);
    }
}

enum Severity {
    INFO, WARN, ERROR;
}
`;

async function main() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-java-'));
    const file = path.join(dir, 'HelloGreeter.java');
    await fs.writeFile(file, SOURCE, 'utf-8');
    try {
        const result = await parseFile(file);
        assert.ok(result);
        assert.equal(result.language, 'java');

        const iface = result.symbols.find((s) => s.name === 'Greeter');
        assert.ok(iface);
        assert.equal(iface.kind, 'interface');

        const cls = result.symbols.find((s) => s.name === 'HelloGreeter');
        assert.ok(cls);
        assert.equal(cls.kind, 'class');

        const en = result.symbols.find((s) => s.name === 'Severity');
        assert.ok(en);
        assert.equal(en.kind, 'enum');

        const methods = result.symbols.filter((s) => s.kind === 'method' && s.parentSymbolId === cls.id);
        const methodNames = methods.map((m) => m.name).sort();
        assert.deepEqual(methodNames, ['HelloGreeter', 'create', 'greet']);

        const javaUtilImport = result.imports.find((i) => i.moduleSpecifier === 'java.util.List');
        assert.ok(javaUtilImport, 'expected java.util.List import');

        // Phase 2.1 — call extraction.
        // greet body:  name.isEmpty()  → method_invocation, callee=isEmpty
        // create body: new HelloGreeter(p) → object_creation_expression
        const callees = result.calls.map((c) => c.calleeName).sort();
        assert.ok(callees.includes('isEmpty'), `expected isEmpty; got ${callees.join(',')}`);
        assert.ok(callees.includes('HelloGreeter'), `expected HelloGreeter constructor call; got ${callees.join(',')}`);

        console.log(`✓ java walker smoke test (${result.calls.length} calls)`);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}

main().catch((err) => { console.error('✗ java walker:', err); process.exit(1); });
