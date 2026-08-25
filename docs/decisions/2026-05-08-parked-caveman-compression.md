<!-- Lore node: parked-caveman-compression-recall-pipeline-2026-05-08 -->

# Parked: caveman-compression — core recall-pipeline candidate ("surgical" tier of two-tier principle)

PARKED 2026-05-08. Reference + future direction; not active work.

## Source
https://github.com/wilpel/caveman-compression — "Strip grammar, keep facts" semantic compression for LLM context. Removes predictable grammar, preserves unpredictable factual content. Python 3.8+, MIT license. Example: 70-token English → 50-token compressed (~29% reduction), reconstructed by the LLM at read time.

## Why this is Core, not the developer plugin
The compression need is universal: every workspace feeds context to an LLM. Family / finance / domain-vertical / developer recall all want token-efficient context. The boundary test (`arch-core-vs-dev-plugin-canonical-mapping-2026-04-27`) places this in Core. Putting it in the developer plugin would be the same category error postmortem'd in `bug-v2.1-plugin-concepts-leaked-into-core`.

## Aligns with existing Lore principles
- **Two-tier principle** (`project_lore_two_tier_principle.md`): full fidelity at rest, surgical at AI-feed time. Caveman is one mechanical implementation of "surgical."
- **Byte-cap test** in `npm run test:arch` already enforces token-cost discipline on tool outputs. Caveman extends the same discipline to LLM inputs.

## Placement (when picked up)
- New core engine module: `packages/lore/src/engines/compression.ts` (or `recall-compression.ts`)
- Integration points:
  - `recall` engine — compress retrieved nodes' content before stitching the response
  - `chat` context-build path — compress prior turns when context window pressure hits a threshold
  - `summary` mode of recall — mechanical alternative / fallback to LLM-summarization
- Optional Atlas-side specialization (developer plugin): code-aware compression layer (drop comments, keep types/signatures). Specialization on top of the core base, not a replacement.

## Build vs lift
- **Use as-is (Python subprocess):** fastest path. Keep caveman's Python lib running; Lore daemon shells out for compression. Latency cost.
- **Reimplement minimal (TS):** port the core algorithm into Lore's TS codebase. Preferred long-term — no subprocess, no Python dep, fits Lore's distribution model. Caveman's spec is documented; should be a few hundred lines.
- **Recommendation when unparked:** read their SPEC.md, evaluate decompression quality with a test set (does the LLM reliably reconstruct the original facts?), then port a minimal TS version. Skip the parts that don't reliably round-trip.

## Risks to validate before adopting
- **Information loss at the edges:** compression that LLMs can usually-but-not-always reconstruct silently degrades quality. Need an evaluation harness comparing recall-with-compression vs recall-without on a held-out set.
- **Audit trail:** when content is compressed before going into a chat or memory, the audit log should record both forms. Plumb through provenance the same way `provenance.transformChain[]` already records pipeline steps.
- **Permission boundaries:** compressed content shouldn't change ReBAC scoping. Ensure the compression step is post-permission-filter, not pre.

## Trigger to unpark
Any of:
- Recall response sizes hit byte-cap limits frequently (signal in `test:arch` byte-caps test)
- Chat context window pressure becomes a chat-quality issue
- A workspace template explicitly needs to feed long documents into LLMs (e.g. long leases, legal contracts)

## Cross-references
- `arch-core-vs-dev-plugin-canonical-mapping-2026-04-27` (placement test)
- `bug-v2.1-plugin-concepts-leaked-into-core` (same bug class, opposite direction — do NOT put in developer plugin)
- `project_lore_two_tier_principle.md` memory — two-tier framing this fits into
- `memory-improvements-shipped-2026-05-07` — hybrid retrieval / RRF / auto-escalate already shipped; caveman would extend the surgical-tier story
