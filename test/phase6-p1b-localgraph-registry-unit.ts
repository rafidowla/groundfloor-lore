/**
 * test/phase6-p1b-localgraph-registry-unit.ts
 *
 * Phase 6 P1.B — LocalGraphRegistry + HTTP write-handler routing.
 *
 * Scope (this file):
 *   - Registry behavior: lazy getGraphHandle/caching, closeAll, error semantics
 *   - Workspace-not-found error semantics
 *   - End-to-end: POST /api/node with workspace: arg routes to the right
 *     physical store (the spec's T1)
 *   - POST /api/node with unknown workspace returns 400 (T2)
 *   - POST /api/node without workspace falls back to active (T3)
 *
 * Tests T1-T3 use the registry + nodes.ts route handler directly via a
 * synthetic IncomingMessage/ServerResponse pair — full daemon spin-up
 * is out of scope for a unit test. The registry is exercised end-to-end
 * (real SurrealGraph engines writing to per-workspace .lore stores).
 *
 * Run:
 *   LORE_HOME=$(mktemp -d) npx tsx test/phase6-p1b-localgraph-registry-unit.ts
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";

const TEST_HOME = process.env["LORE_HOME"];
if (!TEST_HOME || TEST_HOME === path.join(process.env["HOME"] ?? "", ".groundfloor")) {
    console.error(
        "ERROR: LORE_HOME must be set to a fresh temp dir before running this test.\n" +
            "Use: LORE_HOME=$(mktemp -d) npx tsx test/phase6-p1b-localgraph-registry-unit.ts",
    );
    process.exit(2);
}

function seedWorkspacesJson(home: string, active: string, names: string[]): void {
    // Explicit 'surreal': getGraphHandle resolves the workspace's DECLARED
    // engine, so both the write path (the route handler) and the test's
    // verification reads go through the same SurrealGraph per workspace.
    const workspaces = names.map((name) => ({
        name,
        path: path.join(home, "workspaces", name),
        createdAt: "2026-05-21T00:00:00.000Z",
        graphEngine: "surreal" as const,
    }));
    fs.mkdirSync(home, { recursive: true });
    for (const w of workspaces) {
        fs.mkdirSync(path.join(w.path, ".lore"), { recursive: true });
    }
    fs.writeFileSync(
        path.join(home, "workspaces.json"),
        JSON.stringify({ active, workspaces }, null, 2),
    );
}

seedWorkspacesJson(TEST_HOME, "alpha", ["alpha", "beta", "gamma"]);

const { LocalGraphRegistry, WorkspaceNotFoundError } = await import(
    "../packages/lore/src/engines/localGraphRegistry.js"
);

// ── Registry unit behavior ─────────────────────────────────────────────────

async function testRegistryGetGraphHandleLazy(): Promise<void> {
    const reg = new LocalGraphRegistry();
    assert.deepEqual(reg.openedNames(), [], "no entries before first open");
    const graphA = await reg.getGraphHandle("alpha");
    assert.ok(graphA, "getGraphHandle returns a graph handle for alpha");
    assert.deepEqual(reg.openedNames(), ["alpha"], "alpha is cached after open");
    const graphA2 = await reg.getGraphHandle("alpha");
    assert.equal(graphA2, graphA, "repeated open returns the same instance");
    reg.closeAll();
    assert.deepEqual(reg.openedNames(), [], "closeAll drops all entries");
    // closeAll is a reference-drop only; physically close the Surreal handle
    // (as the daemon's shutdown drain does for the boot graph) so later
    // tests can re-open alpha without contending on the surrealkv lock.
    await graphA.close();
    console.log("  ✓ registry lazy-open + caching works");
}

async function testRegistryUnknownWorkspace(): Promise<void> {
    const reg = new LocalGraphRegistry();
    let thrown: unknown = null;
    try {
        await reg.getGraphHandle("does-not-exist");
    } catch (err) {
        thrown = err;
    }
    assert.ok(
        thrown instanceof WorkspaceNotFoundError,
        "unknown workspace throws WorkspaceNotFoundError",
    );
    const wnfe = thrown as InstanceType<typeof WorkspaceNotFoundError>;
    assert.equal(wnfe.requested, "does-not-exist");
    assert.ok(
        wnfe.known.includes("alpha") && wnfe.known.includes("beta"),
        "error carries known workspace names",
    );
    console.log("  ✓ unknown workspace throws WorkspaceNotFoundError with names");
}

async function testRegistryActiveNameFallback(): Promise<void> {
    const reg = new LocalGraphRegistry();
    assert.equal(reg.activeName(), "alpha", "activeName reads from workspaces.json");
    console.log("  ✓ activeName resolves the workspaces.json active field");
}

// ── HTTP route handler — T1, T2, T3 ─────────────────────────────────────────

class MockRequest extends EventEmitter {
    public method = "POST";
    public url = "/api/node";
    public headers: Record<string, string> = {};
    constructor(public bodyJson: object) {
        super();
        setImmediate(() => {
            this.emit("data", Buffer.from(JSON.stringify(bodyJson)));
            this.emit("end");
        });
    }
}

interface MockResponse {
    statusCode: number;
    headers: Record<string, string>;
    body: string;
    writeHead(code: number, h?: Record<string, string>): void;
    end(chunk: string): void;
}

function mockResponse(): MockResponse {
    const r: MockResponse = {
        statusCode: 200,
        headers: {},
        body: "",
        writeHead(code, h = {}) {
            this.statusCode = code;
            this.headers = h;
        },
        end(chunk) {
            this.body = String(chunk);
        },
    };
    return r;
}

async function testT1_workspaceRoutesToTargetStore(): Promise<void> {
    // Daemon active=alpha. POST /api/node with workspace="beta" must land in beta.
    const { tryNodesRoutes } = await import(
        "../packages/lore/src/mcp/http/routes/nodes.js"
    );
    const reg = new LocalGraphRegistry();
    // Pre-open both so the test doesn't race on first-open mid-handler.
    const alphaGraph = await reg.getGraphHandle("alpha");
    const betaGraph = await reg.getGraphHandle("beta");

    // Synthetic deps — only fields the POST /api/node path actually uses.
    const deps: any = {
        store: {
            loreGraph: alphaGraph,
            loreVerbatim: {
                store: async () => undefined,
            },
        },
        auditLog: { log: () => undefined },
        deploymentMode: "local",
        dataplane: null,
        graphRegistry: reg,
    };
    const req = new MockRequest({
        id: "phase6-p1b-t1",
        type: "decision",
        label: "P1.B T1 routing test",
        workspace: "beta",
    });
    const res = mockResponse();
    const handled = await tryNodesRoutes(
        req as any,
        res as any,
        "/api/node",
        "/api/node",
        deps,
    );
    assert.equal(handled, true, "POST /api/node route was matched");
    // First-create returns 201 (NW-7f / api-006: isNew→201); was stale 200.
    assert.equal(res.statusCode, 201, `expected 201 first-create, got ${res.statusCode} body=${res.body}`);

    // Verify the node landed physically in beta's graph, NOT alpha's.
    const inBeta = await betaGraph.getNode("phase6-p1b-t1");
    const inAlpha = await alphaGraph.getNode("phase6-p1b-t1");
    assert.ok(inBeta, "node found in beta workspace's graph");
    assert.equal(inAlpha, null, "node NOT in alpha workspace's graph");
    console.log("  ✓ T1: workspace: arg routes physical write to the target store");
    await reg.disposeAll();
}

async function testT2_unknownWorkspaceReturns400(): Promise<void> {
    const { tryNodesRoutes } = await import(
        "../packages/lore/src/mcp/http/routes/nodes.js"
    );
    const reg = new LocalGraphRegistry();
    const alphaGraph = await reg.getGraphHandle("alpha");
    const deps: any = {
        store: {
            loreGraph: alphaGraph,
            loreVerbatim: { store: async () => undefined },
        },
        auditLog: { log: () => undefined },
        deploymentMode: "local",
        dataplane: null,
        graphRegistry: reg,
    };
    const req = new MockRequest({
        id: "phase6-p1b-t2",
        type: "decision",
        label: "P1.B T2 unknown workspace",
        workspace: "does-not-exist",
    });
    const res = mockResponse();
    await tryNodesRoutes(req as any, res as any, "/api/node", "/api/node", deps);
    assert.equal(res.statusCode, 404, "unknown workspace returns 404");
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.code, "workspace_not_found");
    assert.equal(parsed.requested, "does-not-exist");
    assert.ok(Array.isArray(parsed.known) && parsed.known.length > 0, "known names listed");
    console.log("  ✓ T2: unknown workspace returns 404 workspace_not_found");
    await reg.disposeAll();
}

async function testT3_omittedWorkspaceReturns400(): Promise<void> {
    // Sprint L1c — silent fallback to active workspace has been removed
    // from POST /api/node. Omitted workspace now returns 400
    // workspace_required (no fallback). Test asserts the new contract.
    const { tryNodesRoutes } = await import(
        "../packages/lore/src/mcp/http/routes/nodes.js"
    );
    const reg = new LocalGraphRegistry();
    const alphaGraph = await reg.getGraphHandle("alpha");
    const betaGraph = await reg.getGraphHandle("beta");
    const deps: any = {
        store: {
            loreGraph: alphaGraph,
            loreVerbatim: { store: async () => undefined },
        },
        auditLog: { log: () => undefined },
        deploymentMode: "local",
        dataplane: null,
        graphRegistry: reg,
    };
    const req = new MockRequest({
        id: "phase6-p1b-t3",
        type: "decision",
        label: "P1.B T3 omitted workspace → 400 after L1c",
        // no workspace field
    });
    const res = mockResponse();
    await tryNodesRoutes(req as any, res as any, "/api/node", "/api/node", deps);
    assert.equal(res.statusCode, 400, `expected 400 workspace_required, got ${res.statusCode} body=${res.body}`);
    const parsed = JSON.parse(res.body);
    // Wave 5: canonical {code, message} envelope (was {error, hint}).
    assert.equal(parsed.code, "workspace_required");
    // Verify nothing landed anywhere.
    const inAlpha = await alphaGraph.getNode("phase6-p1b-t3");
    const inBeta = await betaGraph.getNode("phase6-p1b-t3");
    assert.equal(inAlpha, null, "no-workspace request must NOT land anywhere");
    assert.equal(inBeta, null, "no-workspace request must NOT land anywhere");
    console.log("  ✓ T3: omitted workspace → 400 workspace_required (L1c)");
    await reg.disposeAll();
}

// ── Runner ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    console.log("phase6-p1b-localgraph-registry-unit.ts");
    await testRegistryGetGraphHandleLazy();
    await testRegistryUnknownWorkspace();
    await testRegistryActiveNameFallback();
    await testT1_workspaceRoutesToTargetStore();
    await testT2_unknownWorkspaceReturns400();
    await testT3_omittedWorkspaceReturns400();
    console.log("All P1.B tests passed.");
}

await main();
