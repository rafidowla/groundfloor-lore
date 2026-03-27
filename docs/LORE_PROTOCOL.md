# Lore Intelligence Protocol

> This file is the **single source of truth** for the Lore Protocol.
> `lore setup` auto-formats and installs this into each detected IDE.

## Auto-Consult on Conversation Start (MANDATORY)

At the START of every conversation, before doing any work:

1. Call `recall({topic: "<current project or task>"})` to check for
   existing architecture, decisions, conventions, and bug patterns.
2. Call `stats()` to verify the knowledge graph is accessible.
3. Use the recalled knowledge to inform your approach — do NOT
   start from scratch when institutional knowledge already exists.

If groundfloor-lore is unavailable (connection refused, timeout),
note it to the user and proceed without Lore.

## Auto-Store After Significant Work (MANDATORY)

After completing ANY of the following, store a knowledge node:

- Architectural decisions → type: "decision"
- New conventions or patterns → type: "convention"
- Bug fixes with root cause → type: "bug_pattern"
- Key file/module documentation → type: "architecture"
- Troubleshooting steps that resolved an issue → type: "troubleshooting"

Use `store_node()` with:
- Descriptive `id` (kebab-case, e.g., "auth-jwt-rotation-fix")
- Clear `label` that summarizes the learning
- Detailed `content` that captures the WHY, not just the WHAT
- Relevant `tags` for discoverability
- Correct `project` scope (auto-detected if omitted)

Create `store_edge()` relationships to connect related nodes.

## Knowledge Capture Triggers

You MUST store knowledge when:
- A bug took more than one attempt to fix
- A design decision was made between multiple options
- A new integration pattern was established
- A workaround was applied for a framework/library limitation
- The user explicitly says "remember this" or "store this"

You SHOULD store knowledge when:
- Completing a multi-file refactor
- Establishing a naming convention
- Documenting an API contract

## Prohibited Patterns

Do NOT:
- Skip Lore recall and rely only on context window
- Store trivial information (simple variable renames, typo fixes)
- Store knowledge without proper tagging and project scope
- Ignore existing Lore nodes when making decisions that contradict them
