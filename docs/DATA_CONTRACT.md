# Lore Core — Data Contract: what Lore does with your text

> Audience: anyone calling Lore — Atlas, Loom/DEF, the SDK, a direct MCP or
> REST caller. This document states one thing plainly, because it has been
> asked often enough to need a canonical answer: **Lore is a database. It
> persists the text you give it. It does not sanitize, redact, or filter
> free-text fields on your behalf**, with one narrow, best-effort exception
> described in §3. Every claim below cites the source file that backs it.

Companion documents: [`SECURITY_MODEL.md`](./SECURITY_MODEL.md) (auth,
network exposure, isolation) and [`COMPLIANCE.md`](./COMPLIANCE.md) (audit
logging, retention, encryption posture) — both cover the surrounding
security posture; this document covers content handling specifically.

---

## 1. The contract

**Lore persists `content`, `evidence`, `tags`, `metadata`, and a
`supersede_node` / `POST /api/node/supersede` `reason` exactly as given, on
every substrate it writes to** — the graph store, collection rows, the
outbox, and sync/replication. There is no redaction, PII scrubbing, or
profanity/secret filtering applied to these fields anywhere in that path.

**Callers sanitize before calling.** If a value must not be persisted
verbatim — a customer's SSN, an API key pasted into a decision's `content`,
a credential embedded in a `reason` string — the caller (Atlas, Loom,
an SDK consumer, a direct MCP/REST client) is responsible for removing or
masking it before the write reaches Lore. Lore has no way to distinguish
"this looks like a secret" from "this is a legitimate example of a secret
shape in a decision node" reliably enough to strip it silently — see §3 for
why the one filter that does exist is deliberately narrow.

This is a design decision, not a gap awaiting a fix: Lore's job is durable,
faithful recall of what it was told. A database that silently mutates what
you asked it to store is a worse database for that purpose, even if the
mutation is well-intentioned.

## 2. Where raw text is persisted

Confirmed write paths that persist free-text fields with no redaction
applied (paths relative to `packages/lore/src/`):

- **Graph substrate, generally.** `core/nodeService.ts` never redacts
  `content` (or any other node field) before writing to the graph engine.
- **`supersede_node` / `POST /api/node/supersede` `reason`** — persisted raw
  in all three graph engines: `engines/surreal/surrealGraphWrites.ts:432`,
  `engines/arcade/arcadeMaintenance.ts:60`,
  `engines/dataplaneGraphMaintenance.ts:47`. Also copied raw into the audit
  record by both entry points
  (`mcp/tools/memory/supersedeNode.ts:121`,
  `mcp/http/routes/nodes/supersede.ts:130`).
- **`embed.batch` outbox dispatch** — `outbox/dispatcher.ts:372`,
  `outbox/wiring.ts:312,341-397` (→ `bulkUpsertPrebuiltRows` at `:397`).
  Producers: `mcp/http/routes/bulkEmbedFlush.ts:85-90`,
  `storage/loadJobsRunner.ts:365-370`, `embed/reEmbedJob.ts:210-219`,
  `mcp/server.ts:585-591`. The raw text sits in `outbox.sqlite` until
  dispatched.
- **`bulkIngest` sync mode** — `mcp/bulkIngest.ts:477-538` (embed calls at
  `:530`/`:538`, persisted at `:177`).
- **Prebuilt-row batch paths** — `engines/verbatimBatch.ts:185-214`
  (`bulkUpsertPrebuiltRows`) and the bulk loader's
  `bulkLoader/lanceAdapter.ts:232` (`bulkAddPrebuiltRows`).
- **Arcade vector store** — `engines/arcade/arcadeVectorStore.ts:97-117`
  (`store()`) and `:173-200` (`storePrebuilt()`).
- **Sync/replication** — `sync/walPushBridge.ts:45-56` and
  `engines/tsSdkAdapter.ts:99-125`.

## 3. The one exception: vector-layer secret masking is best-effort, not a guarantee

`src/security/secretScan.ts` (`redactSecrets()`) replaces a small,
deliberately narrow set of high-signal vendor secret **shapes** — OpenAI/
generic `sk-…` keys, AWS `AKIA…` access key IDs, GitHub `gh[pousr]_…`
tokens, Slack `xox[baprs]-…` tokens, and PEM private key blocks — with a
`[REDACTED]` marker. It is applied at exactly three call sites, all on the
**vector/embed layer only**: `engines/verbatimStore.ts:731` (`store`),
`:881` (`storeBatch`), and `engines/verbatimSearchWorkerProxy.ts:161-170`
(the parent-embeds branch).

This does **not** cover the sinks listed in §2 — the outbox, `bulkIngest`
sync mode, the Arcade vector store, sync/replication, or the graph
substrate itself all persist text unfiltered. Even where it does apply, it
only matches five specific vendor token shapes; a generic
`api_key: <value>` assignment or a customer secret in an unrecognized
format passes through untouched (a prior, broader generic-assignment rule
was deliberately dropped — see the comment at the top of
`secretScan.ts` for why it caused more harm via false positives than it
prevented).

**Treat this as a courtesy that catches an accidental well-known-shape
credential in the vector layer, not as a security boundary.** Sanitize
before calling regardless of whether your write path happens to cross one
of the three sites above.

## 4. What is length-capped, and what that is (and isn't) for

Several free-text node fields (`content`, `label`, `metadata`, `evidence`,
`anchors`) are capped at `MAX_NODE_FIELD_BYTES` (256 KB —
`engines/nodeFieldLimits.ts`) to bound per-request memory/storage cost, not
to filter content. The `supersede_node` / `POST /api/node/supersede`
`reason` field carries the same cap for the same reason, enforced at every
entry point that can set it: the `supersede_node` MCP tool
(`mcp/tools/memory/supersedeNode.ts`), the `POST /api/node/supersede` REST
route (`mcp/http/routes/nodes/supersede.ts`), the `lore supersede` CLI's
no-daemon fallback (`cli/commands/supersede.ts`), and the
`POST /api/nodes/bulk` / `lore.bulkIngest()` write paths reject the field
outright rather than accepting an uncapped value
(`mcp/http/routes/bulkWrite.ts`, `core/nodeService.ts`). The cap is
**UTF-8 bytes**, not `.length` (UTF-16 code units) — `MAX_NODE_FIELD_BYTES`
and `exceedsNodeFieldCap()` (`engines/nodeFieldLimits.ts`) are the shared
byte-counting helpers every one of those sites calls, so a multi-byte
(CJK/emoji) reason cannot pass a character-count check while its persisted
UTF-8 form runs over the limit. A capped field still stores whatever text is
under the limit **verbatim** — the cap is a size guard, not a sanitizer.

## 5. Out of scope here

Caller-side scrubbing before Lore is called (e.g. Atlas redacting a value
before issuing `knowledge_store` or `knowledge_supersede`) is each caller's
own responsibility and is tracked in that caller's own repository, not
here.
