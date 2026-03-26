# BaaS ↔ Lore Integration Guide

> How Groundfloor BaaS 2.5 consumes `@groundfloor/lore` and exposes it as a platform service for tenant developers.

## Overview

`@groundfloor/lore` is a standalone npm package providing code intelligence and institutional knowledge. BaaS consumes it as a **dependency** and wraps it as a **platform service** — tenant developers get intelligence through Studio Builder, Cloud IDE, and API without installing anything themselves.

```
@groundfloor/lore (standalone package)
        ↓ npm dependency
groundfloor-v2.5 (BaaS platform)
        ↓ exposes as service
Tenant developers (Studio Builder / Cloud IDE / API)
```

---

## Dependency Setup

### Development (local)

```bash
# Symlink for instant changes during co-development
cd ~/AiDev/BitBucket/groundfloor-lore && npm link
cd ~/AiDev/BitBucket/v2.5/groundfloor-v2.5 && npm link @groundfloor/lore
```

### Production

```jsonc
// groundfloor-v2.5/package.json
{
  "dependencies": {
    "@groundfloor/lore": "git+ssh://git@bitbucket.org/codementeam/groundfloor-lore.git#v1.0.0"
    // or from private npm registry:
    // "@groundfloor/lore": "^1.0.0"
  }
}
```

---

## Integration Architecture

### Per-Tenant Graph Isolation

Each tenant app gets its own isolated Kùzu graph. The BaaS platform manages creation and lifecycle.

```typescript
// platform/shell/src/services/loreService.ts
import { LocalGraph } from '@groundfloor/lore/engines';

/**
 * LoreService — Platform service wrapping @groundfloor/lore.
 *
 * Purpose: Provides per-tenant code intelligence and knowledge
 *   management via the Lore graph engine.
 *
 * Inputs: tenantId from authenticated session.
 * Outputs: Knowledge query results, code context.
 *
 * Side Effects: Creates/reads tenant graph directories.
 * Error Behavior: Returns structured error responses.
 */
class LoreService {
    private graphs = new Map<string, LocalGraph>();

    /**
     * Get or create a tenant-scoped graph instance.
     *
     * @param tenantId - Authenticated tenant identifier.
     * @returns Initialized LocalGraph for this tenant.
     */
    async getGraph(tenantId: string): Promise<LocalGraph> {
        if (!this.graphs.has(tenantId)) {
            // Each tenant gets isolated storage
            const graph = new LocalGraph(`/data/tenants/${tenantId}`);
            await graph.initialize();
            this.graphs.set(tenantId, graph);
        }
        return this.graphs.get(tenantId)!;
    }
}
```

### BaaS API Endpoints

Expose Lore capabilities as REST endpoints under the BaaS API:

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/v1/lore/knowledge` | POST | Store a knowledge node |
| `/api/v1/lore/knowledge/:id` | GET | Retrieve a knowledge node |
| `/api/v1/lore/search` | GET | Search tenant knowledge |
| `/api/v1/lore/recall` | GET | Recall + traverse (AI-friendly) |
| `/api/v1/lore/graph/stats` | GET | Tenant graph statistics |

All endpoints are **tenant-scoped** via JWT — each tenant only sees their own graph.

### Studio Builder Integration

Studio Builder embeds Lore intelligence directly into the no-code experience:

```typescript
// Studio Builder hook
async function getAIContext(tenantId: string, componentType: string) {
    const graph = await loreService.getGraph(tenantId);

    // Search for relevant conventions for this component type
    const conventions = await graph.search(componentType, 5);

    // Recall related architecture decisions
    const architecture = await graph.search('architecture', 5);

    return { conventions, architecture };
}
```

### Cloud IDE Integration

For tenant developers using the Cloud IDE, Lore runs as an MCP server per session:

```typescript
// Each Cloud IDE session gets its own MCP connection
// backed by the tenant's graph
const tenantGraph = await loreService.getGraph(tenantId);
const mcpServer = createMcpServer(tenantGraph);
// Connect to the IDE session's stdio
```

---

## Published Knowledge (Platform → Tenants)

The platform team can publish **read-only** knowledge packs that all tenant graphs inherit:

| Pack | Contents | Example |
|---|---|---|
| `platform-conventions` | API patterns, naming rules | "Use `AppDataAdapter` for CRUD" |
| `security-guidelines` | Auth, CORS, input validation | "Always validate with Pydantic/Zod" |
| `component-patterns` | UI best practices | "Use `DataTable` for list views" |

### Publishing mechanism

```typescript
// Platform admin publishes a knowledge pack
await loreService.publishPack('platform-conventions', [
    { id: 'conv-appdataadapter', type: 'convention', label: 'Use AppDataAdapter for data access', ... },
    { id: 'conv-baasclient', type: 'convention', label: 'Use BaaSClient for HTTP calls', ... },
]);

// On tenant graph init, inject published packs as read-only nodes
await tenantGraph.injectPack('platform-conventions', { readOnly: true });
```

---

## Migration Path

| Phase | Backend | Hosting |
|---|---|---|
| **Now** | `@groundfloor/lore` CLI + MCP server | Local Kùzu + SurrealDB (your machine) |
| **BaaS 2.5 Alpha** | `@groundfloor/lore` as npm dep in platform | BaaS `AppDocuments` replaces SurrealDB |
| **BaaS 2.5 GA** | Full platform service | Managed per-tenant, no tenant install needed |

### The adapter swap

```typescript
// Current: SurrealDB adapter (interim)
const syncEngine = new SyncEngine(localGraph, surrealAdapter);

// Future: BaaS AppDocuments adapter (one-line swap)
const syncEngine = new SyncEngine(localGraph, baasAppDocumentsAdapter);
```

Both adapters implement the same `SyncAdapter` interface:

```typescript
interface SyncAdapter {
    push(nodes: LoreNode[], edges: LoreEdge[]): Promise<SyncResult>;
    pull(since: string): Promise<{ nodes: LoreNode[]; edges: LoreEdge[] }>;
    heartbeat(activity: DevActivity): Promise<void>;
}
```

---

## Security Considerations

- **Tenant isolation**: Each tenant's graph is physically separate (different Kùzu directory).
- **No cross-tenant access**: API endpoints enforce tenant scope via JWT.
- **Published packs are read-only**: Tenants cannot modify platform-published knowledge.
- **Sync credentials**: Each tenant gets scoped SurrealDB/BaaS tokens, never root access.

---

## Files to implement (when ready)

| File | Purpose |
|---|---|
| `platform/shell/src/services/loreService.ts` | [NEW] Platform service wrapping Lore |
| `backend/api/routes/lore.ts` | [NEW] REST API endpoints |
| `packages/common/engine/LoreSyncAdapter.ts` | [NEW] BaaS AppDocuments sync adapter |
| `platform/shell/src/hooks/useLoreContext.ts` | [NEW] React hook for Studio Builder |
