<!-- Lore node: lore-artifact-policy-layer-2026-05-07 -->

# Lore generated-artifact policy layer — watermark/DLP/audit/retention travel with the artifact

Locked 2026-05-07.

## Decision
Generated artifacts (PDFs, exports, documents) are the user's work product but contain embedded enterprise data. Workspace policy travels with the artifact:

- **Watermarking** — user identity + workspace + timestamp embedded in document
- **DLP scan on export** — enterprise can require pre-export content review
- **Audit log** — file-level audit (what was exported, by whom, when) in addition to query-level audit
- **Encryption at rest** — optional, with enterprise key (e.g., for regulated industries)
- **Retention policy** — optional auto-delete after N days

## Where this lives
In the workspace schema as a policy section, distinct from the data schema. Authored same as everything else: AI proposes / human approves / sandbox + commit.

Example shape:
```
artifactPolicy:
  watermark: required
  dlpScan: required
  encryptAtRest: optional
  retentionDays: 90
  auditLevel: file-export
```

## Implementation phasing
- V2.5: schema slot for artifactPolicy declared; not enforced yet
- V3.0-Enterprise: enforcement (watermark insert, DLP hook, file-export audit log)
- V3.5+: encryption-at-rest, retention sweeper
