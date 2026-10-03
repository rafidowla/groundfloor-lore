#!/usr/bin/env tsx
/**
 * cloud-credential-rebuild-unit.ts — cloud parity A2 item 5.
 *
 * Boot builds the cloud stores with a 'pending-keychain' placeholder key; the keychain
 * upgrade must rebuild BOTH the graph and the vector store with the real key. Previously
 * only the graph was rebuilt, so vector/keyword requests kept the placeholder and 401'd.
 * The mock accepts only DP_KEY; the placeholder returns 401.
 */

import assert from 'node:assert/strict';
import { startMockDataplane } from './helpers/mock-dataplane.js';
import { createMockDataplaneClient } from './helpers/mock-dataplane-client.js';
import { bagOfWordsEmbedder, DP_KEY, DP_WORKSPACE, ORG_ID } from './helpers/cloud-stores-fixture.js';
import { buildCloudStores } from '../packages/lore/src/mcp/cloudStores.js';
import { maybeUpgradeAdapterFromKeychain, type LoreGraph } from '../packages/lore/src/mcp/services.js';
import { testRegistry } from './helpers/workspace-registry.js';
import { writeControl } from '../packages/lore/src/config/workspaces.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runWithWorkspace } from '../packages/lore/src/security/workspaceContext.js';
import type { DataplaneGraph } from '../packages/lore/src/engines/dataplaneGraph.js';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const PLACEHOLDER = 'pending-keychain';
const W = 'lore-ws-cred';
process.env['DATAPLANE_ORG_ID'] = ORG_ID;
process.env['DATAPLANE_TENANT_ID'] = DP_WORKSPACE;

// Data home whose workspaces.json registers W: the keychain upgrade builds its registry from it (production path).
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-cred-home-'));
writeControl({ active: W, workspaces: [{ name: W, id: W, path: path.join(home, W), createdAt: new Date().toISOString() }] }, home);

const mock = await startMockDataplane({ apiKeys: { [DP_KEY]: DP_WORKSPACE } });
process.env['DATAPLANE_URL'] = mock.url; // maybeUpgrade reads the base URL from env: never let it fall back to localhost:8080
const seen: string[] = [];
const factory = (baseUrl: string, apiKey: string) => { seen.push(apiKey); return createMockDataplaneClient(baseUrl, apiKey) as never; };
const as = <T>(fn: () => Promise<T>): Promise<T> => runWithWorkspace({ workspaceId: W }, fn);

try {
    console.log('cloud credential rebuild');

    await test('placeholder key is rejected (401) by the mock: the failure mode being fixed', async () => {
        const { vectorStore } = await buildCloudStores({ apiKey: PLACEHOLDER, baseUrl: mock.url, orgId: ORG_ID, embeddingProvider: bagOfWordsEmbedder(), clientFactory: factory, hasCapability: async () => null, workspaceRegistry: testRegistry(W) });
        await assert.rejects(() => as(() => vectorStore.store({ id: 'x', text: 'hello', metadata: {} })), /401|unauth|invalid|key/i);
    });

    await test('buildCloudStores gives BOTH stores the same real key', async () => {
        const { graph, vectorStore } = await buildCloudStores({ apiKey: DP_KEY, baseUrl: mock.url, orgId: ORG_ID, embeddingProvider: bagOfWordsEmbedder(), clientFactory: factory, hasCapability: async () => null, workspaceRegistry: testRegistry(W) });
        await as(() => graph.upsertNode({ id: 'n1', type: 'note', label: 'l', content: 'c', tags: [], project: 'p', ecosystem: 'e', metadata: '{}' } as never));
        await as(() => vectorStore.store({ id: 'v1', text: 'hello world', metadata: { type: 'note' } }));
        assert.equal((await as(() => vectorStore.search('hello', 5))).length, 1);
        assert.equal((await as(() => graph.getNode('n1')))?.id, 'n1');
    });

    await test('keychain upgrade rebuilds the vector store AND the graph with the upgraded key', async () => {
        // Boot stores, built with the placeholder.
        const boot = await buildCloudStores({ apiKey: PLACEHOLDER, baseUrl: mock.url, orgId: ORG_ID, embeddingProvider: bagOfWordsEmbedder(), clientFactory: factory, hasCapability: async () => null, workspaceRegistry: testRegistry(W) });
        let graph: LoreGraph = boot.graph as unknown as LoreGraph;
        const before = mock.requests.length;
        seen.length = 0;
        const source = await maybeUpgradeAdapterFromKeychain({
            deploymentMode: 'cloud',
            loreDir: '/nonexistent-lore-dir',
            home,
            getAdapter: () => null,
            getGraph: () => graph,
            verbatimStore: boot.vectorStore,
            embeddingProvider: bagOfWordsEmbedder(),
            setAdapter: () => {}, getSyncWorkspace: () => 'w', lockWorkspace: 'w', setSyncEngine: () => {}, setWal: () => {},
            setGraph: (g) => { graph = g; },
            cloud: { clientFactory: factory, getKeychainKey: async () => DP_KEY },
        });
        assert.equal(source, 'keychain');
        assert.deepEqual(seen, [DP_KEY], 'the rebuild must construct exactly one client, with the keychain key');
        // The BOOT vector store instance (captured by value elsewhere) now works with the real key.
        await as(() => boot.vectorStore.store({ id: 'after', text: 'upgraded key works', metadata: { type: 'note' } }));
        const hits = await as(() => boot.vectorStore.search('upgraded', 5));
        assert.ok(hits.some((h) => h.id === 'after'));
        await as(() => boot.vectorStore.bm25Search('upgraded', 5));
        // Every request after the upgrade carried the real key: the mock records workspace=null for a rejected (401) key.
        const after = mock.requests.slice(before);
        assert.ok(after.length > 0);
        assert.equal(after.filter((r) => r.workspace === null).length, 0, 'a request carried the placeholder key');
        // The rebuilt graph handed to setGraph and the old (adopted) graph both work.
        await as(() => (graph as unknown as DataplaneGraph).upsertNode({ id: 'g1', type: 'note', label: 'l', content: 'c', tags: [], project: 'p', ecosystem: 'e', metadata: '{}' } as never));
        assert.equal((await as(() => boot.graph.getNode('g1')))?.id, 'g1');
    });

    await test('no keychain credential -> nothing rebuilt', async () => {
        const boot = await buildCloudStores({ apiKey: PLACEHOLDER, baseUrl: mock.url, orgId: ORG_ID, embeddingProvider: bagOfWordsEmbedder(), clientFactory: factory, hasCapability: async () => null, workspaceRegistry: testRegistry(W) });
        seen.length = 0;
        const r = await maybeUpgradeAdapterFromKeychain({
            deploymentMode: 'cloud', loreDir: '/x', home, getAdapter: () => null, getGraph: () => boot.graph as unknown as LoreGraph,
            verbatimStore: boot.vectorStore, setAdapter: () => {}, getSyncWorkspace: () => 'w', lockWorkspace: 'w', setSyncEngine: () => {}, setWal: () => {}, setGraph: () => {},
            cloud: { clientFactory: factory, getKeychainKey: async () => null },
        });
        assert.equal(r, 'none');
        assert.deepEqual(seen, []);
    });
} finally { await mock.close(); fs.rmSync(home, { recursive: true, force: true }); }

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
