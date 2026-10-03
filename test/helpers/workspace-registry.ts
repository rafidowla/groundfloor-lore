/**
 * workspace-registry.ts — a mutable stand-in for an instance's Lore-workspace registry
 * (production: mcp/cloudBootConfig.ts `createWorkspaceRegistry`, a view over workspaces.json).
 *
 * The Dataplane stores and the sync adapter REQUIRE a registry (cloud parity C item 7: no
 * wildcard, no default). Tests register exactly the workspaces they use; tests that are
 * about binding itself add and remove names mid-run to prove a change takes effect with
 * no restart.
 */
import type { LoreWorkspaceRegistry } from '../../packages/lore/src/engines/dataplaneScopeFilter.js';

export interface TestWorkspaceRegistry extends LoreWorkspaceRegistry {
    /** Register names; each gets the permanent id === its name (so existing assertions on stored rows keep reading naturally). */
    add(...names: string[]): TestWorkspaceRegistry;
    /** Register `name` with an explicit permanent id (used to prove rows key on the id, not the name). */
    addWithId(name: string, id: string): TestWorkspaceRegistry;
    /** Register `alias` as another name for `target`'s entry (same id). */
    alias(alias: string, target: string): TestWorkspaceRegistry;
    /** Rename an entry: the id travels with it, the old name stops resolving. */
    rename(oldName: string, newName: string): TestWorkspaceRegistry;
    remove(...names: string[]): TestWorkspaceRegistry;
    names(): string[];
}

export function testRegistry(...names: string[]): TestWorkspaceRegistry {
    const ids = new Map<string, string>(names.map((n) => [n, n]));
    const reg: TestWorkspaceRegistry = {
        has: (ws) => ids.has(ws),
        resolveId: (ws) => ids.get(ws),
        add: (...n) => { n.forEach((x) => ids.set(x, x)); return reg; },
        addWithId: (n, id) => { ids.set(n, id); return reg; },
        alias: (a, t) => { const id = ids.get(t); if (id === undefined) throw new Error(`alias target ${t} not registered`); ids.set(a, id); return reg; },
        rename: (o, n) => { const id = ids.get(o); if (id === undefined) throw new Error(`${o} not registered`); ids.delete(o); ids.set(n, id); return reg; },
        remove: (...n) => { n.forEach((x) => ids.delete(x)); return reg; },
        names: () => [...ids.keys()],
    };
    return reg;
}

/**
 * A registry that accepts any workspace. ONLY for unit tests of store MECHANICS (row shapes,
 * query building, schema push) where Lore-workspace binding is not what is under test; binding
 * is covered by test/cloud-workspace-binding-unit.ts and the isolation suites, which register
 * workspaces explicitly. Never use it in a test that asserts a rejection.
 */
export function registryAcceptingAny(): LoreWorkspaceRegistry {
    return { has: () => true, resolveId: (n) => n };
}
