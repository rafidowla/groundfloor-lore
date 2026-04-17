import { LocalGraph } from './dist/engines/localGraph.js';
import { VerbatimStore, buildVerbatimText } from './dist/engines/verbatimStore.js';
import os from 'os';
import path from 'path';

async function ingest() {
  const graphBasePath = path.join(os.homedir(), '.groundfloor');
  const graph = new LocalGraph(graphBasePath);
  const verbatimStore = new VerbatimStore(graphBasePath);

  await graph.initialize();
  await verbatimStore.initialize();

  const nodes = [
    {
      id: 'surrealdb-v2-ast-rules',
      type: 'bug_pattern',
      label: 'SurrealDB v2 AST Compiler Rules',
      content: 'SurrealDB v2 strictly enforces explicit distance calculation aliases in Vector SELECT queries. You must alias Euclidean distance functions `AS _dist` in the SELECT clause before using them in an ORDER BY block. Furthermore, deprecated syntax like `..=depth` has been strictly removed in v2; recursive edge traversals must instead use the node wildcard expansion `->?.{min..max}` operator.',
      tags: 'surrealdb, rust, compiler, ast, vector_search',
      project: 'groundfloor-dataplane-oss',
      ecosystem: 'groundfloor'
    },
    {
      id: 'dataplane-port-fallback-fix',
      type: 'bug_pattern',
      label: 'Dataplane Connector Port Fallbacks',
      content: 'When constructing dynamic fallback ports inside the Dataplane connection factory (`get_default_connector_config`), do not use a universal fallback layer binding connections to `5432`. Connectors like Redis or Qdrant attempting to establish HTTP/Multiplex handshakes over the PostgreSQL port will crash and close sockets rapidly. Use specific matching blocks explicitly assigning internal ports (e.g. `redis` -> `6379`, `surrealdb` -> `8000`).',
      tags: 'dataplane, rust, database, engine, redis, ports',
      project: 'groundfloor-dataplane-oss',
      ecosystem: 'groundfloor'
    }
  ];

  for (const node of nodes) {
    console.log(`Ingesting into Graph: ${node.id}`);
    const upserted = await graph.upsertNode({
      id: node.id,
      type: node.type,
      label: node.label,
      content: node.content,
      tags: node.tags,
      project: node.project,
      ecosystem: node.ecosystem,
      metadata: '{}'
    });

    console.log(`Ingesting into Verbatim Memory (LanceDB Vector): ${node.id}`);
    await verbatimStore.store({
      id: node.id,
      text: buildVerbatimText(node.label, node.content, node.tags),
      metadata: {
        type: node.type,
        label: node.label,
        tags: node.tags,
        project: node.project,
        ecosystem: node.ecosystem,
        updatedAt: upserted.updatedAt
      }
    });

    // Hot cache injection natively handled by upsertNode
  }

  console.log("Memory successfully injected.");
  process.exit(0);
}

ingest().catch(e => {
  console.error(e);
  process.exit(1);
});
