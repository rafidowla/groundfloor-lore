# Atlas WASM Grammars

Pre-built tree-sitter WASM grammar binaries vendored into the developer
plugin. Loaded at runtime by `web-tree-sitter` via the parser foundation
under `packages/lore-plugin-developer/src/parser/grammars.ts`.

## Languages (v1)

| File | Language | Used by walker |
|---|---|---|
| `tree-sitter-typescript.wasm` | TypeScript (`.ts`) | `walkers/typescript.ts` |
| `tree-sitter-tsx.wasm` | TSX / TypeScript-React (`.tsx`) | `walkers/typescript.ts` |
| `tree-sitter-javascript.wasm` | JavaScript / JSX (`.js`, `.jsx`, `.mjs`, `.cjs`) | `walkers/typescript.ts` |
| `tree-sitter-python.wasm` | Python (`.py`) | `walkers/python.ts` |
| `tree-sitter-go.wasm` | Go (`.go`) | `walkers/go.ts` |
| `tree-sitter-rust.wasm` | Rust (`.rs`) | `walkers/rust.ts` |
| `tree-sitter-java.wasm` | Java (`.java`) | `walkers/java.ts` |
| `tree-sitter-c_sharp.wasm` | C# (`.cs`) | `walkers/csharp.ts` |
| `tree-sitter-c.wasm` | C (`.c`, `.h`) | `walkers/cpp.ts` |
| `tree-sitter-cpp.wasm` | C++ (`.cpp`, `.cc`, `.cxx`, `.hpp`) | `walkers/cpp.ts` |
| `tree-sitter-ruby.wasm` | Ruby (`.rb`) | `walkers/ruby.ts` |

## Provenance

- **Source:** [Gregoor/tree-sitter-wasms](https://github.com/Gregoor/tree-sitter-wasms) v0.1.13.
- **License:** Unlicense (public-domain-equivalent).
- **Build process:** the `tree-sitter-wasms` package is installed as a build-time
  `devDependency` of the root `package.json`. After install, the WASM blobs
  are copied from `node_modules/tree-sitter-wasms/out/*.wasm` into this
  directory and committed.
- **License compatibility:** Unlicense permits redistribution, modification,
  and commercial use without restriction. Compatible with Lore's proprietary
  commercial license. The original tree-sitter grammar source repos are MIT-licensed
  individually; the WASM compilation by `tree-sitter-wasms` re-licenses the
  output under Unlicense.

## Why vendor instead of loading from `node_modules` at runtime?

- **Reproducibility:** the grammar bytes are pinned in our git history; no
  surprise updates from upstream.
- **Smaller install footprint:** `tree-sitter-wasms` ships 30+ languages
  (~50 MB). We use 11 of them (~16 MB).
- **Offline-friendly:** the daemon never needs to look in `node_modules`
  for grammars; works in air-gapped environments.

## Updating

Run from the repo root:

```bash
npm install                               # ensure tree-sitter-wasms dep is current
node scripts/atlas-vendor-grammars.mjs    # (Phase 1+) re-copy WASM blobs
```

The vendor script will be added in Phase 1; for now grammars were copied
manually during the Phase 1 carry-in.
