#!/usr/bin/env tsx
import * as assert from 'assert';

async function main() {
    console.log('🧪 Testing Lore Dynamic Visualizer Endpoints\n');
    
    try {
        console.log('Fetching /api/topology...');
        const apiRes = await fetch('http://127.0.0.1:3847/api/topology');
        assert.strictEqual(apiRes.status, 200, `Expected 200 OK, got ${apiRes.status}`);
        
        const data = await apiRes.json();
        assert.ok(Array.isArray(data.nodes), 'Response should contain nodes array');
        assert.ok(Array.isArray(data.edges), 'Response should contain edges array');
        console.log(`  ✓ Successfully fetched topology with ${data.nodes.length} nodes and ${data.edges.length} edges.\n`);

        console.log('Fetching /api/topology/overview (Q1.9)...');
        const overviewRes = await fetch('http://127.0.0.1:3847/api/topology/overview?groupBy=project');
        assert.strictEqual(overviewRes.status, 200, `Expected 200 OK, got ${overviewRes.status}`);
        const overview = await overviewRes.json();
        assert.ok(Array.isArray(overview.blobs), 'Overview response should contain blobs array');
        assert.ok(Array.isArray(overview.aggregateEdges), 'Overview response should contain aggregateEdges array');
        assert.strictEqual(overview.groupBy, 'project', 'Overview should echo groupBy');
        assert.strictEqual(typeof overview.totalNodes, 'number', 'Overview should carry totalNodes');
        console.log(`  ✓ Overview: ${overview.blobs.length} blobs, ${overview.aggregateEdges.length} aggregate edges, ${overview.totalNodes} total nodes.\n`);

        // TW-6b: /explore served dashboard removed (Lore Core is API + MCP
        // only). The vis-network snapshot now lives behind the data-export
        // API /api/export/html. Assert the dashboard is gone and the export
        // API still serves the snapshot.
        console.log('Asserting /explore is removed...');
        const exploreRes = await fetch('http://127.0.0.1:3847/explore');
        assert.strictEqual(exploreRes.status, 404, `Expected 404 for removed /explore, got ${exploreRes.status}`);
        console.log('  ✓ /explore served dashboard is gone (404).\n');

        console.log('Fetching /api/export/html...');
        const exportRes = await fetch('http://127.0.0.1:3847/api/export/html');
        assert.strictEqual(exportRes.status, 200, `Expected 200 OK from export API, got ${exportRes.status}`);
        const html = await exportRes.text();
        assert.ok(html.includes('vis-network.min.js'), 'Export HTML should include vis-network library');
        console.log('  ✓ Data-export API still serves the graph snapshot.\n');

        console.log('All tests passed! ✨\n');
        process.exit(0);
    } catch (err) {
        console.error('❌ Test failed:', err);
        process.exit(1);
    }
}

main();
