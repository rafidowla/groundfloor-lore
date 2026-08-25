<!-- Lore node: lore-sync-architecture-corrected-2026-05-07 -->

# Lore sync architecture — user-with-enterprise conversations live in enterprise cloud, not the user's personal-scope Lore

Locked 2026-05-07. **Supersedes `lore-sync-architecture-2026-05-07`** which had a security hole.

## Correction
Earlier framing put user-with-enterprise conversations in the user's personal-scope Lore. **Wrong.** The moment the AI quotes a tenant name, a record amount, or any enterprise record, the conversation contains embedded enterprise data — it becomes enterprise material, not personal. Putting it in the user's personal-scope Lore (which syncs to user's personal cloud) leaks enterprise data out of enterprise control. Security hole, audit gap, compliance violation.

## Three categories, two patterns

| Category | Lives in | Pattern | Owner |
|---|---|---|---|
| Personal data + personal interactions | The user's personal-scope Lore (local + user's cloud) | Local-First | User |
| Enterprise data | Enterprise cloud | Cloud-Only | Enterprise |
| **User's interactions with enterprise data** (queries + AI responses + full thread) | **Enterprise cloud, scoped to user identity** | Cloud-Only | **Enterprise (audit-grade)** |

The user has two parallel Lore experiences as an enterprise employee: their personal-scope Lore, and the enterprise Lore they have access to. When they cross over (talking to enterprise Lore from the local app), they operate in enterprise scope. The conversation goes up to enterprise cloud, never personal cloud.

## Local app behavior on enterprise conversations

| Phase | Allowed |
|---|---|
| Active session — show conversation in UI | Yes (data-in-flight) |
| Stream conversation to enterprise cloud as it happens | Yes (the sync) |
| Persist conversation to local disk after session | No by default. Workspace policy can opt in to encrypted-at-rest offline cache. |
| Push to user's personal cloud | **Never** |
| Search conversation history | Goes to enterprise cloud with user identity; results in-flight |

## Two patterns still cover everything

| | Local-First | Cloud-Only |
|---|---|---|
| Examples | Personal, Developer, Social Media Manager | Enterprise verticals |
| Source of truth | Local | Cloud (private or public) |
| Sync up | Yes — personal cloud | Yes for things originating locally, to **enterprise cloud** |
| Sync down | Yes between user's devices | **Never persist** to local disk |
| User-with-enterprise conversations | n/a | Lives in enterprise cloud, not the user's personal-scope Lore |
| Local compute on data-in-flight | Yes | Yes — RAM only |
| Local persist of generated artifacts | User's discretion | User's discretion + workspace policy (DLP, watermark, audit) |

## Hard rule
**Anything containing embedded enterprise data lives in enterprise cloud, not the user's personal-scope Lore.** No exceptions, no shortcuts. Sync engine enforces this directionality.

## What this rules out
- Bidirectional sync between local and cloud for enterprise workspaces.
- Storing user-with-enterprise conversations in the user's personal-scope Lore.
- Cross-cloud sync (user's personal cloud ↔ enterprise cloud).
- Schema divergence per substrate.
- Substrate-specific node IDs.
