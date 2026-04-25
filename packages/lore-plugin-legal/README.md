# @groundfloor/lore-plugin-legal

Featherweight legal-domain plugin for Lore. Adds vocabulary for
**contracts, clauses, parties, and jurisdictions** so the LLM can
reason about regulated documents in your knowledge graph.

This plugin is the exemplar that proves a domain plugin can cost a day,
not a week: schema + prompt only, no custom tools, no interpretation
rules. The LLM uses core's generic `store_node` / `store_edge` with the
legal schema types; everything else is just vocabulary + instructions.

## What it adds

| Type           | Purpose                                                   |
|----------------|-----------------------------------------------------------|
| `Contract`     | The agreement itself — title, jurisdiction, dates, body.  |
| `Clause`       | A single clause — kind (indemnity / liability / etc.), section ref, text. |
| `Party`        | A signatory or counterparty.                              |
| `Jurisdiction` | The legal regime that governs a contract.                 |

Plus three relationship tables: `ContractContainsClause`,
`ContractInvolvesParty`, `ContractGovernedBy`.

## When to use

Lawyers, contract managers, anyone dealing with regulated documents.
Ingest contracts as text (a PDF extractor can produce the raw), then
ask Lore questions about them. The system-prompt hook teaches the LLM
the legal conventions: distinguish information vs. advice, cite clauses
by section reference, never claim to be giving legal counsel.

## Manifest

`plugin.json` declares the bundle-level surface the Lore shell loads
when this plugin is active:

- 4 inspectors over Legal-plugin entities:
  - **Contracts** (`Contract`) — table sorted by `effectiveDate` desc
  - **Clauses** (`Clause`) — table filtered by clause `kind`
    (indemnity / liability / termination / confidentiality / ip / payment)
  - **Parties** (`Party`) — table of signatories and counterparties
  - **Contract graph** — graph traversal over the three rel tables
- Permissions: `fs:read:.`
- `engines.lore: ">=2.0.0"`

Validate it against the spec:

```bash
npm run test:manifest:reference
```

## Status

Shipping in Phase 6 of Lore V2.2. Featherweight tier; no roadmap of
custom tools planned — by design.
