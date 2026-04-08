const path = require('path');
const os = require('os');
async function run() {
    try {
        const { LocalGraph } = await import('../dist/engines/localGraph.js');
        const basePath = path.join(os.homedir(), '.groundfloor');
        const graph = new LocalGraph(basePath);
        await graph.initialize();
        console.log("Initialized Graph.");
        
        const schemas = [
            { id: 'schema-appdocument', type: 'schema', label: 'AppDocument (Base)', content: 'Core BaaS base entity...', tags: 'baas,core,base', project: 'core', ecosystem: 'groundfloor' },
            { id: 'schema-property', type: 'schema', label: 'Property', content: 'The top-level real estate entity...', tags: 'real-estate,core', project: 'core', ecosystem: 'groundfloor' },
            { id: 'schema-building', type: 'schema', label: 'Building', content: 'A physical building belonging to a Property.', tags: 'real-estate', project: 'core', ecosystem: 'groundfloor' },
            { id: 'schema-floor', type: 'schema', label: 'Floor', content: 'A floor belonging to a Building.', tags: 'real-estate', project: 'core', ecosystem: 'groundfloor' },
            { id: 'schema-suite', type: 'schema', label: 'Suite', content: 'A specific leasable unit on a floor.', tags: 'real-estate', project: 'core', ecosystem: 'groundfloor' },
            { id: 'schema-verticaltenant', type: 'schema', label: 'VerticalTenant', content: 'Business or individual occupying a Suite.', tags: 'crm,leasing', project: 'core', ecosystem: 'groundfloor' },
            { id: 'schema-verticallease', type: 'schema', label: 'VerticalLease', content: 'Lease contract tying a VerticalTenant to a Suite.', tags: 'leasing,finance', project: 'core', ecosystem: 'groundfloor' }
        ];

        for (const s of schemas) {
            await graph.upsertNode({ ...s, metadata: '{}' });
            console.log("Stored node: " + s.id);
        }

        const edges = [
            { sourceId: 'schema-appdocument', targetId: 'schema-property', relation: 'extends' },
            { sourceId: 'schema-appdocument', targetId: 'schema-building', relation: 'extends' },
            { sourceId: 'schema-appdocument', targetId: 'schema-floor', relation: 'extends' },
            { sourceId: 'schema-appdocument', targetId: 'schema-suite', relation: 'extends' },
            { sourceId: 'schema-appdocument', targetId: 'schema-verticaltenant', relation: 'extends' },
            { sourceId: 'schema-appdocument', targetId: 'schema-verticallease', relation: 'extends' },
            { sourceId: 'schema-property', targetId: 'schema-building', relation: 'owns' },
            { sourceId: 'schema-building', targetId: 'schema-floor', relation: 'contains' },
            { sourceId: 'schema-floor', targetId: 'schema-suite', relation: 'contains' },
            { sourceId: 'schema-verticaltenant', targetId: 'schema-suite', relation: 'occupies' },
            { sourceId: 'schema-verticaltenant', targetId: 'schema-verticallease', relation: 'holds' },
            { sourceId: 'schema-verticallease', targetId: 'schema-suite', relation: 'applies_to' }
        ];

        for (const e of edges) {
            await graph.addEdge(e);
            console.log("Added edge: " + e.sourceId + " -> " + e.targetId);
        }
        
        console.log("DONE SEEDING");
    } catch(err) {
        console.error("FATAL ERROR", err);
    }
}
run();
