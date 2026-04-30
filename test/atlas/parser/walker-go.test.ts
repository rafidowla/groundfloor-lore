/**
 * test/atlas/parser/walker-go.test.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * Go walker smoke test on synthetic source.
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

const SOURCE = `package main

import (
    "fmt"
    "strings"
)

const Version = "v1"

type Greeter struct {
    Prefix string
}

type Greeting interface {
    Greet(name string) string
}

func (g *Greeter) Greet(name string) string {
    if name == "" {
        return g.Prefix
    }
    return strings.Join([]string{g.Prefix, name}, " ")
}

func New(prefix string) *Greeter {
    return &Greeter{Prefix: prefix}
}

func main() {
    fmt.Println(New("hello").Greet("world"))
}
`;

async function main() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-go-'));
    const file = path.join(dir, 'sample.go');
    await fs.writeFile(file, SOURCE, 'utf-8');
    try {
        const result = await parseFile(file);
        assert.ok(result);
        assert.equal(result.language, 'go');

        const cls = result.symbols.find((s) => s.name === 'Greeter');
        assert.ok(cls, "expected Greeter type");
        assert.equal(cls.kind, 'class');

        const iface = result.symbols.find((s) => s.name === 'Greeting');
        assert.ok(iface, "expected Greeting interface");
        assert.equal(iface.kind, 'interface');

        const method = result.symbols.find((s) => s.qualifiedName === 'Greeter.Greet');
        assert.ok(method, `expected Greeter.Greet method. Got: ${result.symbols.map((s) => s.qualifiedName).join(', ')}`);
        assert.equal(method.kind, 'method');

        const fn = result.symbols.find((s) => s.name === 'New');
        assert.ok(fn);
        assert.equal(fn.kind, 'function');

        const c = result.symbols.find((s) => s.name === 'Version');
        assert.ok(c, 'expected Version constant');
        assert.equal(c.kind, 'constant');

        const fmtImp = result.imports.find((i) => i.moduleSpecifier === 'fmt');
        assert.ok(fmtImp, 'expected fmt import');

        // Phase 2.1 — call extraction.
        // main() body calls fmt.Println, New, Greet → at least 3 calls in main.
        // Greeter.Greet calls strings.Join → 1 call.
        const callsByCallee = result.calls.map((c) => c.calleeName).sort();
        assert.ok(callsByCallee.includes('Println'), `expected fmt.Println call; got ${callsByCallee.join(',')}`);
        assert.ok(callsByCallee.includes('New'), `expected New call; got ${callsByCallee.join(',')}`);
        assert.ok(callsByCallee.includes('Greet'), `expected Greet call; got ${callsByCallee.join(',')}`);
        assert.ok(callsByCallee.includes('Join'), `expected strings.Join call; got ${callsByCallee.join(',')}`);

        console.log(`✓ go walker smoke test (${result.calls.length} calls)`);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}

main().catch((err) => { console.error('✗ go walker:', err); process.exit(1); });
