/**
 * test/atlas/parser/walker-cpp.test.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * C / C++ walker smoke test on synthetic source.
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
#include <string>
#include <vector>

namespace example {

class Greeter {
public:
    Greeter(std::string p) : prefix(p) {}

    std::string greet(const std::string& name) {
        if (name.empty()) {
            return prefix;
        }
        return prefix + " " + name;
    }

private:
    std::string prefix;
};

enum class Mode { Friendly, Formal };

int main() {
    Greeter g("hello");
    return 0;
}

} // namespace example
`;

async function main() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-cpp-'));
    const file = path.join(dir, 'sample.cpp');
    await fs.writeFile(file, SOURCE, 'utf-8');
    try {
        const result = await parseFile(file);
        assert.ok(result);
        assert.equal(result.language, 'cpp');

        const ns = result.symbols.find((s) => s.name === 'example');
        assert.ok(ns, 'expected example namespace');
        assert.equal(ns.kind, 'module');

        const cls = result.symbols.find((s) => s.name === 'Greeter');
        assert.ok(cls);
        assert.equal(cls.kind, 'class');

        const en = result.symbols.find((s) => s.name === 'Mode');
        assert.ok(en);
        assert.equal(en.kind, 'enum');

        const stringInclude = result.imports.find((i) => i.moduleSpecifier === 'string');
        assert.ok(stringInclude, `expected #include <string>. Got: ${result.imports.map((i) => i.moduleSpecifier).join(', ')}`);

        console.log('✓ cpp walker smoke test');
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}

main().catch((err) => { console.error('✗ cpp walker:', err); process.exit(1); });
