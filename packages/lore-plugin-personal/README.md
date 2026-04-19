# @groundfloor/lore-plugin-personal

Personal knowledge graph for Lore. Makes the substrate remember **you** —
the people in your life, places you go, events coming up, memories worth
keeping.

Private by default. Everything stays on your machine. Content is embedded
locally with Qwen; the graph is persisted in Kùzu.

## What it ships

### Schema

Four node types:

| Type | Purpose |
|---|---|
| `Person` | Family, friends, colleagues, doctors, teachers, anyone |
| `Place` | Home, work, schools, favorite spots, travel destinations |
| `PersonalEvent` | Birthdays, anniversaries, meetings, appointments, trips |
| `Memory` | A moment — photo, voice memo, journal entry, chat snippet |

Five relationship types:

| From → To | Relation |
|---|---|
| `Person → Place` | `PersonLivesAt` (since?) |
| `PersonalEvent → Person` | `PersonInvolves` (role?) |
| `Memory → Person` | `MemoryInvolves` |
| `Memory → Place` | `MemoryOccurredAt` |
| `Person → Person` | `PersonRelatedTo` (relation: parent_of, sibling_of, …) |

### Prompt hook

Registers a system-prompt fragment that teaches the LLM:

- Warm tone, first-name basis
- Privacy-strict (never suggest sharing personal details externally)
- Time-aware (ground "upcoming" / "next week" in today's date)
- Tool-preferred (`recall_person` over guessing from chat context)
- Cite node IDs so the user can navigate back to sources

### Tools

Three MVP tools cover the central flows:

| Tool | What it does |
|---|---|
| `recall_person(name)` | 360° view of a Person: places, upcoming events, recent memories, relationships |
| `memory_search(query, limit?)` | Find Memory nodes by text, ordered by `occurredAt` |
| `upcoming(days?, limit?)` | PersonalEvents within the next N days (default 14), with attendees |

### Retention policy

Everything is kept forever by default. The Personal plugin is the one
domain where "archive old stuff" is actively wrong — memories get more
valuable with time, not less.

## Activation

Add `personal` to your workspace config:

```
~/.groundfloor/.lore/config.json
  "plugins": ["developer", "personal"]
```

Restart the Lore daemon. Personal schema registers on boot; the three
tools become available over MCP alongside whatever else is active.

## What's NOT in the MVP (deferred)

- **Write tools** — `add_person`, `add_event`, `add_memory`,
  `link_people`. The LLM can use core `store_node` with `type="Person"`
  etc. in the meantime. Plugin-owned write tools land when interpretation
  rules (below) need them.

- **Interpretation rules** — photo EXIF → Memory with occurred_at/
  occurred_at linked to a Place by geotag; email → Communication node
  with `PersonInvolves` edges derived from From/To headers. This is the
  automation layer that turns "ingested file" into "connected graph."

- **Additional node types** — `Communication`, `Task`, `Routine`,
  `Interest`, `Document`. Each waits for a real-use signal; shipping
  them ahead of demand creates dead surface.

- **Birthday / anniversary surfacing** — a scheduled job that emits
  reminders for PersonalEvents with `kind='birthday'` and others.
  Natural follow-on once the event corpus is real.

- **Timeline tool** — chronological view for a Person or Place. Simple
  composition of `memory_search` + `upcoming`, packaged as one call.

## Scope philosophy

The Personal plugin is the flagship. Every addition needs to pass
"does this make Lore materially more useful for one user's life today?"
The three tools above pass that bar. Anything else can wait for a signal.

## Safety posture

- Every tool call goes through the C6 audit log. You can tail
  `~/.groundfloor/audit.jsonl` to see what the LLM has asked this
  plugin to do.
- Destructive tools (none in the MVP; coming with write tools) will
  go through the C6 consent gate.
- S6 encryption primitives exist for the Personal plugin to opt its
  Memory content into when we flip the opt-in on (Phase 6).
- S7 prompt-injection defense wraps any Memory/Person content
  retrieved into a chat prompt with `<data>` delimiters and scans for
  injection patterns.

## Status

Shipping **MVP** in Phase 5 of Lore V2.2. Real-user feedback drives
follow-on priorities — the post-MVP items above are not a roadmap
they're an opt-in catalog.
