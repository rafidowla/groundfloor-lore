import { LocalGraph } from '../src/engines/localGraph.ts';
import { VerbatimStore, buildVerbatimText } from '../src/engines/verbatimStore.ts';

const graph = new LocalGraph('/tmp/lore-integration-test');
const verbatim = new VerbatimStore('/tmp/lore-integration-test');

await graph.initialize();
await verbatim.initialize();

const node = await graph.upsertNode({
  id: 'clerk-auth-decision',
  type: 'decision',
  label: 'Use Clerk for authentication',
  content: 'We chose Clerk over Auth0 because of better developer experience and pricing at our scale.',
  tags: 'auth,clerk,decision',
  project: 'groundfloor',
  ecosystem: 'groundfloor',
  metadata: '{}'
});

await verbatim.store({
  id: node.id,
  text: buildVerbatimText(node.label, node.content, node.tags),
  metadata: { type: node.type, label: node.label, tags: node.tags, project: node.project, ecosystem: node.ecosystem, updatedAt: node.updatedAt }
});

console.log('store_node: OK');

const verbatimCount = await verbatim.count();
const semanticResults = await verbatim.search('authentication provider', 10);
const seedNodeIds = semanticResults.map(r => r.id);
const seedNodes = (await Promise.all(seedNodeIds.map(id => graph.getNode(id)))).filter(Boolean);

console.log('verbatimCount:', verbatimCount);
console.log('semantic hits:', semanticResults.length, 'top score:', semanticResults[0]?.score?.toFixed(3));
console.log('seedNodes loaded:', seedNodes.length);
console.log('searchMode:', verbatimCount > 0 ? 'semantic' : 'keyword');

const stats = await graph.getStats();
const vCount = await verbatim.count();
console.log('stats - nodeCount:', stats.nodeCount, 'verbatimDocuments:', vCount, 'engine: kuzu + lancedb');

await graph.close();
await verbatim.close();
