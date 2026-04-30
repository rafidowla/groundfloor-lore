# Phase 1 Output — Atlas (parser foundation, partial)

> **Status:** Phase 1 partially complete. Foundation + TypeScript walker shipped; 7 remaining walkers (Python, Go, Rust, Java, C#, C/C++, Ruby) carried over to a continuation session.
>
> **Branch:** `feat/dev-plugin-phase-1` (off `main` at `552d8f9`).
> **PR:** opened against `main` (titled `atlas: Phase 1 — parser foundation (TypeScript walker + 7 carry-overs)`).

## What landed (4 commits)

| # | Commit | Summary |
|---|---|---|
| 1 | Carry-ins | Disabled `scripts/hooks/post-commit` (renamed to `.disabled-during-atlas`). Vendored 11 WASM grammars (TS+TSX+JS, Python, Go, Rust, Java, C#, C+CPP, Ruby) under `packages/lore-plugin-developer/grammars/` from `tree-sitter-wasms` v0.1.13 (Unlicense). Added `web-tree-sitter` (runtime) and `tree-sitter-wasms` (build-time) to root `package.json`. |
| 2 | `parser/types.ts` | ParsedSymbol / ParsedFile / ParsedRelation / ParsedImport / ParseDiagnostic / ParseRepoResult contracts. ID strategy locked: `<file>:<qualifiedName>:<kind>`. Output shape decoupled from Kùzu storage shape. |
| 3 | `parser/grammars.ts` + `parser/walkers/_base.ts` | Singleton WASM loader with per-language caching. Walker utilities: cyclomaticComplexity, byteRangeFromNode, buildSymbolId, countLoc, buildSignature, makeParsedSymbol. WalkerFn contract every per-language walker must conform to. |
| 4 | `parser/walkers/typescript.ts` + `parser/index.ts` + `test/atlas/parser/walker-typescript.test.ts` | TypeScript walker (handles `.ts`/`.tsx`/`.jsx`/`.js`). Parser public API: `parseFile`, `parseRepo`, `getLanguageFor`. 6 walker tests, all pass. End-to-end smoke test against `packages/lore/src/mcp/server.ts` succeeds (93 symbols, 55 imports, 76 ms). |

## Acceptance status against plan §3 Phase 1

| Acceptance criterion | Status | Notes |
|---|---|---|
| All 8 walker tests pass | **1 of 8** (TypeScript only) | Python / Go / Rust / Java / C# / C-CPP / Ruby walkers carried over. |
| Parsing `packages/lore/src/mcp/server.ts` returns within 5% of GitNexus baseline | **Partial** | 93 symbols extracted; performance is great (76 ms vs 500 ms target). Per-file gitnexus baseline number isn't recorded in `docs/internal/gitnexus_audit.md` — only repo-wide totals. The next session should run `npx gitnexus analyze` once on the lore repo (with the post-commit hook still disabled), grab the per-file count for `server.ts`, and either confirm parity within 5% or document divergence. |
| Representative repo per language parses without crash (psf/requests, gin-gonic/gin, spring-projects/spring-petclinic) | **Pending** | Requires walkers for Python, Go, Java to be implemented. |
| No native binaries loaded; only WASM | ✅ | Confirmed — `web-tree-sitter` + vendored `.wasm` only. |
| `tsc --noEmit` clean on every commit | ✅ | All 4 Phase 1 commits clean. |
| `npm run test:arch` clean on every commit | ✅ | All 4 Phase 1 commits clean. (Architecture lint + Atlas license-check.) |
| All commits authored as Rafi Dowla, no Co-Authored-By | ✅ | `git log --format='%aN <%aE>' feat/dev-plugin-phase-1 ^main` shows only Rafi Dowla. |

## Carry-overs for the next Phase 1 session

A continuation session should pick up here. Each item is independent and committable.

### 1. Implement the 7 remaining walkers (~1 day each)

For each language, follow the TypeScript walker as a template:

| Language | File | Tree-sitter node types to map | Notes |
|---|---|---|---|
| Python | `parser/walkers/python.ts` | `function_definition`, `class_definition`, `decorated_definition` | Decorators wrap definitions; unwrap. Module-level assignments → `constant` or `variable`. `import_statement` + `import_from_statement`. |
| Go | `parser/walkers/go.ts` | `function_declaration`, `method_declaration`, `type_declaration` (struct/interface/alias), `const_declaration`, `var_declaration` | Receiver types in method declarations form qualified name. `import_declaration` parses spec list. |
| Rust | `parser/walkers/rust.ts` | `function_item`, `impl_item`, `struct_item`, `enum_item`, `trait_item`, `mod_item`, `type_item`, `const_item`, `static_item` | Methods inside `impl` blocks attribute to the impl's target type. `use_declaration` for imports. |
| Java | `parser/walkers/java.ts` | `class_declaration`, `interface_declaration`, `enum_declaration`, `method_declaration`, `constructor_declaration`, `record_declaration` | Annotations are decorators. Package + qualified name handling. `import_declaration`. |
| C# | `parser/walkers/csharp.ts` | `class_declaration`, `interface_declaration`, `struct_declaration`, `record_declaration`, `method_declaration`, `constructor_declaration`, `property_declaration`, `enum_declaration` | Namespaces nest. Attributes are decorators. `using_directive` for imports. |
| C / C++ | `parser/walkers/cpp.ts` | `function_definition`, `function_declarator`, `class_specifier`, `struct_specifier`, `union_specifier`, `enum_specifier`, `namespace_definition`, `template_declaration` | Single walker handles both. Header / implementation file split: extract from both equally. `preproc_include` for imports. |
| Ruby | `parser/walkers/ruby.ts` | `method`, `class`, `module`, `singleton_method`, `assignment` (when target is constant) | Modules nest; qualified name uses `::`. `require` / `require_relative` calls for imports. |

For each walker, also add `test/atlas/parser/walker-<lang>.test.ts` mirroring the TS test shape: 5–6 cases covering the main symbol kinds, complexity, imports.

Update `WALKERS` registry in `parser/index.ts` as each walker lands.

### 2. Per-file gitnexus baseline for `packages/lore/src/mcp/server.ts`

The audit doc has repo-wide gitnexus totals but not per-file. To validate the 5% acceptance bar:

```bash
# Re-enable gitnexus temporarily
mv scripts/hooks/post-commit.disabled-during-atlas scripts/hooks/post-commit-temp
npx gitnexus analyze .

# Query the per-file count from gitnexus's output
# (form depends on gitnexus CLI flags; check `npx gitnexus --help`)

# Then re-disable
mv scripts/hooks/post-commit-temp scripts/hooks/post-commit.disabled-during-atlas
```

Record the number in `docs/internal/gitnexus_audit.md` § baseline addendum.

### 3. `scripts/atlas-baseline.mjs`

Phase 1 carry-in #5 from the original prompt: add a baseline-capture script. Runs `parseRepo` against the lore monorepo + the 3 pinned public repos, captures parse time per language, symbol/edge counts, memory peak. Appends new numbers to `docs/internal/gitnexus_audit.md`.

### 4. Vendor-grammars script

The grammars were copied manually during this session. Add `scripts/atlas-vendor-grammars.mjs` that reads from `node_modules/tree-sitter-wasms/out/*.wasm` and copies the v1 set into `packages/lore-plugin-developer/grammars/`. Lets future updates be one-command.

### 5. Other notes

- **Stack Graphs binding for Phase 2:** still unresolved. Phase 0 documented "deferred — Rust sidecar default plan." Phase 2 kickoff session needs to actually pick a binding.
- **Post-commit hook:** still disabled (renamed `.disabled-during-atlas`). Phase 7 deletes it; do NOT restore during 1–6.
- **Filtering parity vs gitnexus:** `parseRepo` uses `git ls-files --cached --others --exclude-standard`. Documented as the v1 filter. If a Phase 1 follow-up finds that gitnexus filters differently (e.g. binary-file detection, size cap difference), document the divergence here.

## Hand-off note for the next session

**Branch:** `feat/dev-plugin-phase-1`. PR opened against `main`.

**Where to start:**
1. Don't merge yet — the PR is a checkpoint, not a complete Phase 1.
2. Either branch a follow-up off `feat/dev-plugin-phase-1` (stack), or wait for Rafi to merge this PR first then branch fresh off `main`.
3. First task: implement `parser/walkers/python.ts` — Python is the next-highest-value language after TS for the lore monorepo and DEF (which is Python).
4. Follow the same pattern as the TS walker: SYMBOL_NODE_TYPES set, kindFor mapping, extractName, recursive descent into class bodies, imports.
5. Add Python to the `WALKERS` registry in `parser/index.ts`.
6. Land `walker-python.test.ts` mirroring the TS test shape.
7. Iterate through the remaining 6 walkers in order: Go → Rust → Java → C# → C/C++ → Ruby.
8. Each walker is its own commit. After all 8, open PR for the full Phase 1 if branching off `feat/dev-plugin-phase-1`, or merge into Phase 1 PR if continuing on the same branch.

**Phase 2 prerequisites:**
- All 8 walkers landed.
- `scripts/atlas-baseline.mjs` captured ms-precision baseline.
- Per-file gitnexus baseline recorded in audit.

Phase 2 spawn should NOT happen until Phase 1 is complete. The continuation session takes ownership of Phase 1's full acceptance bar before chaining.
