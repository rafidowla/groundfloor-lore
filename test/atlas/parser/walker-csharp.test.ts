/**
 * test/atlas/parser/walker-csharp.test.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * C# walker smoke test on synthetic source.
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
using System;
using System.Collections.Generic;

namespace Example
{
    public interface IGreeter
    {
        string Greet(string name);
    }

    public class HelloGreeter : IGreeter
    {
        private readonly string prefix;

        public HelloGreeter(string p)
        {
            prefix = p;
        }

        public string Greet(string name)
        {
            if (string.IsNullOrEmpty(name))
            {
                return prefix;
            }
            return $"{prefix} {name}";
        }

        public static HelloGreeter Create(string p) => new HelloGreeter(p);
    }

    public enum Severity { Info, Warn, Error }
}
`;

async function main() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-cs-'));
    const file = path.join(dir, 'HelloGreeter.cs');
    await fs.writeFile(file, SOURCE, 'utf-8');
    try {
        const result = await parseFile(file);
        assert.ok(result);
        assert.equal(result.language, 'csharp');

        const ns = result.symbols.find((s) => s.name === 'Example');
        assert.ok(ns, 'expected Example namespace');
        assert.equal(ns.kind, 'module');

        const iface = result.symbols.find((s) => s.name === 'IGreeter');
        assert.ok(iface);
        assert.equal(iface.kind, 'interface');

        const cls = result.symbols.find((s) => s.name === 'HelloGreeter');
        assert.ok(cls);
        assert.equal(cls.kind, 'class');
        assert.equal(cls.qualifiedName, 'Example.HelloGreeter');

        const en = result.symbols.find((s) => s.name === 'Severity');
        assert.ok(en);
        assert.equal(en.kind, 'enum');

        const usingSystem = result.imports.find((i) => i.moduleSpecifier === 'System');
        assert.ok(usingSystem, `expected using System. Got: ${result.imports.map((i) => i.moduleSpecifier).join(', ')}`);

        console.log('✓ csharp walker smoke test');
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}

main().catch((err) => { console.error('✗ csharp walker:', err); process.exit(1); });
