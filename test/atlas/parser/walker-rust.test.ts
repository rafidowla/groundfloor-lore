/**
 * test/atlas/parser/walker-rust.test.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * Rust walker smoke test on synthetic source.
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
use std::collections::HashMap;

const VERSION: &str = "v1";

pub trait Greeting {
    fn greet(&self, name: &str) -> String;
}

pub struct Greeter {
    prefix: String,
}

impl Greeter {
    pub fn new(prefix: String) -> Self {
        Greeter { prefix }
    }
}

impl Greeting for Greeter {
    fn greet(&self, name: &str) -> String {
        if name.is_empty() {
            return self.prefix.clone();
        }
        format!("{} {}", self.prefix, name)
    }
}

pub enum Mode {
    Friendly,
    Formal,
}

fn main() {
    let g = Greeter::new("hello".to_string());
    println!("{}", g.greet("world"));
}
`;

async function main() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-rs-'));
    const file = path.join(dir, 'sample.rs');
    await fs.writeFile(file, SOURCE, 'utf-8');
    try {
        const result = await parseFile(file);
        assert.ok(result);
        assert.equal(result.language, 'rust');

        const trait = result.symbols.find((s) => s.name === 'Greeting');
        assert.ok(trait, 'expected Greeting trait');
        assert.equal(trait.kind, 'interface');

        const struct = result.symbols.find((s) => s.name === 'Greeter');
        assert.ok(struct, 'expected Greeter struct');
        assert.equal(struct.kind, 'class');

        const en = result.symbols.find((s) => s.name === 'Mode');
        assert.ok(en);
        assert.equal(en.kind, 'enum');

        const c = result.symbols.find((s) => s.name === 'VERSION');
        assert.ok(c);
        assert.equal(c.kind, 'constant');

        // Methods inside impl blocks should be qualified by the impl target.
        const newMethod = result.symbols.find((s) => s.name === 'new' && s.kind === 'method' && s.qualifiedName === 'Greeter::new');
        assert.ok(newMethod, `expected Greeter::new method. Got: ${result.symbols.map((s) => `${s.kind} ${s.qualifiedName}`).join(', ')}`);

        const useImport = result.imports.find((i) => i.moduleSpecifier.includes('std::collections'));
        assert.ok(useImport, 'expected use std::collections::HashMap');

        // Phase 2.1 — call extraction.
        // main() body has: Greeter::new (call_expression on scoped_identifier),
        // "hello".to_string() (method_call_expression), and println!(g.greet(...))
        // — but macro contents are opaque token trees in tree-sitter-rust,
        // so g.greet() inside println! is NOT extracted (known limitation,
        // same as gitnexus). What we DO extract from this fixture:
        //   Greeter::greet body: name.is_empty(), self.prefix.clone()
        //   main body:           Greeter::new, "hello".to_string()
        const callees = result.calls.map((c) => c.calleeName).sort();
        assert.ok(callees.includes('new'), `expected Greeter::new call; got ${callees.join(',')}`);
        assert.ok(callees.includes('to_string'), `expected to_string call; got ${callees.join(',')}`);
        assert.ok(callees.includes('is_empty'), `expected is_empty call; got ${callees.join(',')}`);
        assert.ok(callees.includes('clone'), `expected clone call; got ${callees.join(',')}`);

        console.log(`✓ rust walker smoke test (${result.calls.length} calls)`);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}

main().catch((err) => { console.error('✗ rust walker:', err); process.exit(1); });
