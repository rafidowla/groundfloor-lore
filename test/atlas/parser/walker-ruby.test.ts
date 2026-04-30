/**
 * test/atlas/parser/walker-ruby.test.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * Ruby walker smoke test on synthetic source.
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
require 'json'
require_relative 'helper'

VERSION = 'v1'

module Greeting
  class Greeter
    def initialize(prefix)
      @prefix = prefix
    end

    def greet(name)
      if name.nil? || name.empty?
        return @prefix
      end
      "#{@prefix} #{name}"
    end

    def self.create(p)
      Greeter.new(p)
    end
  end
end
`;

async function main() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-rb-'));
    const file = path.join(dir, 'sample.rb');
    await fs.writeFile(file, SOURCE, 'utf-8');
    try {
        const result = await parseFile(file);
        assert.ok(result);
        assert.equal(result.language, 'ruby');

        const mod = result.symbols.find((s) => s.name === 'Greeting');
        assert.ok(mod, `expected Greeting module. Got: ${result.symbols.map((s) => `${s.kind} ${s.name}`).join(', ')}`);
        assert.equal(mod.kind, 'module');

        const cls = result.symbols.find((s) => s.name === 'Greeter');
        assert.ok(cls);
        assert.equal(cls.kind, 'class');
        assert.equal(cls.qualifiedName, 'Greeting::Greeter');

        const methods = result.symbols.filter((s) => s.kind === 'method' && s.parentSymbolId === cls.id);
        const methodNames = methods.map((m) => m.name).sort();
        // 'create' is a singleton_method (class method) which is also kind 'method'.
        // 'greet' and 'initialize' are instance methods.
        assert.ok(methodNames.includes('greet'));
        assert.ok(methodNames.includes('initialize'));

        const c = result.symbols.find((s) => s.name === 'VERSION');
        assert.ok(c);
        assert.equal(c.kind, 'constant');

        const jsonImp = result.imports.find((i) => i.moduleSpecifier === 'json');
        assert.ok(jsonImp, 'expected require json import');

        // Phase 2.1 — call extraction.
        // greet body:  name.nil?, name.empty?  → both via `call` node
        // create body: Greeter.new(p)  → call (qualified)
        // require/require_relative are filtered (already imports).
        const callees = result.calls.map((c) => c.calleeName).sort();
        assert.ok(callees.includes('nil?'), `expected nil? call; got ${callees.join(',')}`);
        assert.ok(callees.includes('empty?'), `expected empty? call; got ${callees.join(',')}`);
        assert.ok(callees.includes('new'), `expected Greeter.new call; got ${callees.join(',')}`);
        // Ensure require/require_relative were NOT included as call edges.
        assert.ok(!callees.includes('require'), `require should be filtered; got ${callees.join(',')}`);
        assert.ok(!callees.includes('require_relative'), `require_relative should be filtered; got ${callees.join(',')}`);

        console.log(`✓ ruby walker smoke test (${result.calls.length} calls)`);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}

main().catch((err) => { console.error('✗ ruby walker:', err); process.exit(1); });
