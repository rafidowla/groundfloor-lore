# Lore Intelligence Protocol

> This file is the **single source of truth** for the Lore Protocol.
> `lore setup` auto-formats and installs this into each detected IDE.
>
> Lore is a **knowledge database for Agentic AI** — a general-purpose memory
> layer for any domain (software, IT/security, real estate, sales, legal,
> personal). The examples below use software terms because that is one common
> workspace, but the same protocol applies to a workspace of leases, contracts,
> customer accounts, IAM roles, household records, or anything else. Read
> "decision / convention / pattern" as domain-neutral, not code-only.

## Auto-Consult on Conversation Start (MANDATORY)

At the START of every conversation, before doing any work:

1. Call `recall({topic: "<current project or task>"})` to check for
   existing context — decisions, conventions, entities, patterns, and
   prior history relevant to this workspace's domain.
2. Call `stats()` to verify the knowledge graph is accessible.
3. Use the recalled knowledge to inform your approach — do NOT
   start from scratch when institutional knowledge already exists.

If groundfloor-lore is unavailable (connection refused, timeout),
note it to the user and proceed without Lore.

## Knowledge Modeling Protocol (MANDATORY)

When introducing or modifying a structured entity type — a database table or ORM entity in a software workspace, but equally a lease, contract, account, role, property, or person in any other workspace:
1. You MUST check the existing workspace schemas via `recall({topic: "schemas"})` or `list_nodes({type: "schema"})`.
2. Do NOT arbitrarily spin up an isolated entity type (like `UserProfile`, `Organization`, or `Tenant`) in a silo unless absolutely required.
3. Proactively ask the user: *"I see there is an existing schema context for X in this workspace. Do you want to map this to the shared model to ensure reusability, or does this require a strict, separate structure?"*
4. Any new baseline schemas agreed upon MUST be captured immediately using `store_node(..., type="schema")`. You MUST place the exact field definitions (names, types, required status) inside a strict JSON object passed into the `metadata` parameter of the node, rather than loosely describing them in the textual content. Example metadata: `{"fields": [{"name":"_id", "type":"string", "required":true}]}`.

## Auto-Store After Significant Work (MANDATORY)

After completing ANY of the following, store a knowledge node. The node
types below are the schema-agnostic defaults; read them broadly — a
"decision" is any choice-with-rationale (architectural, commercial, legal,
personal), a "convention" is any agreed practice, a "bug_pattern" is any
recurring problem + root cause + fix. A workspace may also define its own
domain types (e.g. `lease`, `account`, `role`):

- A decision made between options, with rationale → type: "decision"
  (e.g. a design choice, a vendor selection, a renewal-vs-renegotiate call)
- An agreed-upon pattern or practice → type: "convention"
- A recurring problem + root cause + fix → type: "bug_pattern"
- Documentation of a system, structure, or entity → type: "architecture"
- Step-by-step recovery for a known failure → type: "troubleshooting"
- A general fact, observation, or context → type: "note"

Use `store_node()` with:
- Descriptive `id` (kebab-case, e.g., "auth-jwt-rotation-fix")
- Clear `label` that summarizes the learning
- Detailed `content` that captures the WHY, not just the WHAT
- Relevant `tags` for discoverability
- Correct `project` scope (auto-detected if omitted)

Create `store_edge()` relationships to connect related nodes.

## Raw Document Ingestion (via MCP)

When asked to "ingest" a document, text file, or requirements spec:
1. Use the `read_document_for_ingestion(filePath)` MCP tool to read the raw text.
2. Read the systemic instructions returned along with the file content.
3. Automatically analyze and chunk the document into logical concepts (decisions, conventions, entities, obligations, facts — whatever the document's domain calls for).
4. For each chunk/concept, call `store_node()` with the appropriate type and tags.
5. If the extracted concepts relate to each other, use `store_edge()` to connect them in the graph.

## Knowledge Capture Triggers

You MUST store knowledge when:
- A problem took more than one attempt to resolve (a bug, a process failure, a stuck deal)
- A decision was made between multiple options
- A new pattern, integration, or relationship was established
- A workaround was applied for a tool/system/process limitation
- The user explicitly says "remember this" or "store this"

You SHOULD store knowledge when:
- Completing a multi-step piece of work (a refactor, a migration, a portfolio review)
- Establishing a convention or standard practice
- Documenting a contract, an API, an obligation, or any durable commitment

## Prohibited Patterns

Do NOT:
- Skip Lore recall and rely only on context window
- Store trivial information (simple variable renames, typo fixes)
- Store knowledge without proper tagging and project scope
- Ignore existing Lore nodes when making decisions that contradict them
