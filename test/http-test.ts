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

        console.log('Fetching /explore...');
        const exploreRes = await fetch('http://127.0.0.1:3847/explore');
        assert.strictEqual(exploreRes.status, 200, `Expected 200 OK, got ${exploreRes.status}`);
        
        const html = await exploreRes.text();
        assert.ok(html.includes('vis-network.min.js'), 'HTML should include vis-network library');
        console.log('  ✓ Successfully loaded the Explorer Dashboard HTML.\n');

        console.log('All tests passed! ✨\n');
        process.exit(0);
    } catch (err) {
        console.error('❌ Test failed:', err);
        process.exit(1);
    }
}

main();
