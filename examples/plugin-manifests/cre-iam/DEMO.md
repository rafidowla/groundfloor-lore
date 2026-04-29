# CRE IAM — End-to-End Demo Runbook

The customer pitch in five minutes. Demonstrates the full Tier 1 plugin
platform: declarative schema, CSV ingest, auto-generated MCP tools,
named query templates, and stock query patterns — all from one YAML
file with **zero TypeScript**.

## Prereqs

- Lore daemon running locally (`launchctl list | grep com.groundfloor.lore`).
- This bundle copied into the data home:
  ```bash
  cp -r examples/plugin-manifests/cre-iam ~/Downloads/AiDev/BitBucket/lore-workspace/manifests/
  launchctl kickstart -k gui/$(id -u)/com.groundfloor.lore
  ```
- Auth token handy: `cat ~/Downloads/AiDev/BitBucket/lore-workspace/auth.token`

## The 5-step demo

### 1. Show the manifest (30s)

Open `examples/plugin-manifests/cre-iam/plugin.yaml`. Point out:
- 3 node types declared (employee, application, role)
- 3 edge relations (has_role, grants_access_to, belongs_to)
- 3 ingest specs (one per CSV)
- A mix of stock-pattern queries (no Cypher) and one raw-Cypher multi-hop query
- **No TypeScript anywhere**

### 2. Bulk-ingest the sample data (10s)

Via Claude Code or any MCP client:
```
lore_plugin_ingest({plugin: "cre-iam"})
```
→ 5 employees + 8 applications + 4 roles ingested in <300ms.

### 3. Show the auto-generated MCP tools (15s)

Run `tools/list` in your MCP client. Filter to plugin: `cre-iam_*` and
plugin-typed tools (`store_employee`, `list_employee`, `connect_has_role`, etc.).
Point out: every node type and edge relation got two-to-three MCP tools
auto-generated. The plugin author wrote zero registration code.

### 4. Wire role → app access (1m)

For demo realism, connect a few roles to applications via the auto-tool
`connect_grants_access_to`. Sample wiring (Leasing Analyst → Yardi + Salesforce + M365):
```
connect_grants_access_to({sourceId: "r001", targetId: "a002"})
connect_grants_access_to({sourceId: "r001", targetId: "a003"})
connect_grants_access_to({sourceId: "r001", targetId: "a005"})
```

### 5. The flagship query (15s)

```
cre-iam_apps_for_role({role: "Leasing Analyst", dept: "Brokerage"})
```

Result:
```json
{
  "rows": [
    { "app_name": "Microsoft 365",  "criticality": "critical" },
    { "app_name": "Salesforce",     "criticality": "high" },
    { "app_name": "Yardi Voyager",  "criticality": "critical" }
  ]
}
```

**This is what the customer asked for** — given a role + department, return
the apps the new hire should get. Multi-hop graph query traversed
employee → role → application; pure declarative manifest; zero plugin code.

## What this proves

| Claim | Evidence |
|---|---|
| Local-first | The whole demo runs offline. No cloud. |
| AI-native | Every operation is an MCP tool an AI assistant can call. |
| Multi-workspace | This plugin lives next to `developer` and `family` in the same workspace tree. |
| Plugin-extensible without code | One YAML file. No build step. No engineering involvement. |

## Where to take it next (talking points)

- **Connect to your real systems** via Tier 2 connectors (MCP-as-connector + HTTP fetcher primitive — planned).
- **Custom UI per plugin** via declarative inspectors (table/graph/timeline/document — already in the manifest spec; renderer kinds expand as needed).
- **Layer agents on top** (DEF runtime — a separate primitive that reads/writes through this same Lore graph).
- **Private to your data home** — no telemetry of your data unless you opt in.

## Resetting the demo

```bash
# Drop just the cre-iam ingested nodes (other plugins untouched):
# (Reach for delete_node in MCP, or restart daemon and re-run lore_plugin_ingest
#  — id strategy: column means re-ingest is idempotent.)

# Drop the plugin entirely:
rm -rf ~/Downloads/AiDev/BitBucket/lore-workspace/manifests/cre-iam
launchctl kickstart -k gui/$(id -u)/com.groundfloor.lore
```
