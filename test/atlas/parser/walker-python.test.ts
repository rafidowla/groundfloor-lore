/**
 * test/atlas/parser/walker-python.test.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * Python walker smoke test on synthetic source.
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
import os
from typing import List, Optional

API_VERSION = "v1"

def helper(x: int) -> int:
    if x > 0:
        return x * 2
    return 0

class Greeter:
    def __init__(self, prefix: str):
        self.prefix = prefix

    @staticmethod
    def factory(p: str) -> "Greeter":
        return Greeter(p)

    def greet(self, name: str) -> str:
        if not name:
            return self.prefix
        return f"{self.prefix} {name}"
`;

async function main() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-py-'));
    const file = path.join(dir, 'sample.py');
    await fs.writeFile(file, SOURCE, 'utf-8');
    try {
        const result = await parseFile(file);
        assert.ok(result, 'parseFile returned null');
        assert.equal(result.language, 'python');

        const fn = result.symbols.find((s) => s.name === 'helper');
        assert.ok(fn, `expected 'helper'. Got: ${result.symbols.map((s) => s.name).join(', ')}`);
        assert.equal(fn.kind, 'function');

        const cls = result.symbols.find((s) => s.name === 'Greeter');
        assert.ok(cls, "expected 'Greeter' class");
        assert.equal(cls.kind, 'class');

        const methods = result.symbols.filter((s) => s.kind === 'method' && s.parentSymbolId === cls.id);
        const methodNames = methods.map((m) => m.name).sort();
        assert.deepEqual(methodNames, ['__init__', 'factory', 'greet']);

        const c = result.symbols.find((s) => s.name === 'API_VERSION');
        assert.ok(c, 'expected API_VERSION constant');
        assert.equal(c.kind, 'constant');

        const importedFrom = result.imports.find((i) => i.moduleSpecifier === 'typing');
        assert.ok(importedFrom, 'expected from typing import');
        assert.ok(importedFrom.names.includes('List'));

        console.log('✓ python walker smoke test');
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}

main().catch((err) => { console.error('✗ python walker:', err); process.exit(1); });
