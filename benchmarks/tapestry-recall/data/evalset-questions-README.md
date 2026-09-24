# Lore accuracy eval set (half A) — v2

Synthetic Tapestry-style personal/work memory corpus + eval questions, for
testing Lore's recall accuracy. This is one author's half of a two-author
set: `questions.jsonl` contains only the fields the task specifies
(qid/question/gold/kind) — no alternative phrasings, aliases, or "questions
this memory answers" notes were written anywhere, so a second author can
write a companion set independently without seeing how these questions are
worded.

**v2 supersedes v1** after a review found the v1 corpus was dominated by
templated families that differed only in a date/number/name (e.g. many
"Sleep tracker showed `<N>` hours... week of `<date>`... Ivy's early
wake-ups" copies, or repeated "`<bill>` jumped to `$<N>`/month starting
`<date>`" entries) — effectively a date/number-matching test rather than a
realistic memory-recall test. v1's files are kept as `memories.v1.jsonl` /
`questions.v1.jsonl` for comparison; do not use them for scoring.

## What changed in v2

1. **Skeleton cap, enforced at generation time, not just checked after the
   fact.** A memory's *skeleton* = its text with numbers, dates, money, and
   capitalized names masked out (vocabulary-based masking for all the
   corpus's people/orgs/places/months, plus a generic "2+ consecutive
   TitleCase words" rule for anything else, e.g. randomly generated full
   names). `add_memory()` computes the skeleton of every candidate and
   silently rejects it once 3 memories already share that skeleton — so the
   cap isn't a hope backed by variety, it's a hard gate.
2. **Volume comes mostly from hand-authored, structurally unique prose**, not
   slot-filled templates. Of 415 memories: 80 are the distractor clusters,
   ~150 are one-off hand-written memories (each with its own sentence
   structure, several 3+ sentence, some third-person), ~55 are "memory-only"
   padding entries with no attached question (realistic — most stored
   memories are never queried), and the rest come from a curated set of
   *low-volume* "rich" families (standups, decisions, meetings, hires, reno
   tasks, workouts, kid milestones, trip planning, recipes, savings goals,
   bills...) capped at 3–5 instances each and rendered from 2–4 structurally
   different phrasings, so no family floods the corpus.
3. **The flagged "sleep" and "bill" patterns were redesigned, not just
   capped.** Sleep memories no longer share the same constant cause
   ("Ivy's early wake-ups") across many date-differentiated copies — each of
   the 4 sleep entries has a *different, narratively distinct cause*
   (Ivy's wake-ups, a head cold, jet-lag after a trip, a pre-demo crunch), so
   a natural question about "the week I was fighting off that cold" is
   unambiguous without needing an exact date. Bills and savings goals are
   capped at one memory per bill-type / goal (the type itself is the natural,
   memorable anchor — not a repeating monthly tracker).
4. **Paraphrase questions were rewritten for naturalness and to stop
   restating the memory's literal distinguishing date/number.** A first pass
   of hand-authored questions still echoed too much of the memory's own
   wording (mean content-word overlap 0.39); ~105 of them were rewritten to
   ask indirectly (e.g. "What went wrong at first when Lucas and I tried
   making pasta from scratch?" instead of quoting the memory's own "flour
   everywhere, dough too dry" phrase) while keeping exactly one disambiguating
   anchor (a name, place, or rare noun) so the question stays answerable from
   only its gold memory.
5. **A few genuine cross-memory ambiguities were found and fixed** (see
   "Ambiguity pass" below) — these were real bugs, not heuristic
   false-positives: a "meeting" family duplicate, and several "keyword"-style
   families (reno task cost, recipe tweak, trip activity, workout feeling,
   garden bed planting, standup topic, reno delay, decision subject) that
   could otherwise generate two memories sharing the same natural anchor
   (task name, dish, place, activity...) with *different* answers, making
   the one surviving question genuinely ambiguous even though only one
   literal question string existed. Each such family now dedups its anchor
   at generation time.

## How it was authored

One Python script, fixed random seed (`gen_evalset_v2.py`, kept alongside
this README's source run, not shipped in this folder):

- **Part B — ~40 hand-authored distractor clusters** (80 memories, reused
  from v1 essentially unchanged — they were already structurally varied
  enough to get a distinct skeleton per memory). Pairs/triples about the same
  person/place/topic differing in one key detail. Full list below.
- **Part C — hand-authored one-off memories** (~150, across all 8 projects):
  unique prose, 1–4 sentences, mixed first/third person (many are about
  Renata, Lucas, Ivy, or coworkers rather than "I"), each paired with its
  own natural paraphrase/keyword/mixed question.
- **Part D — low-volume "rich" families** (~14 families, capped at 3–5
  instances each, 2–4 phrasing variants per family, anchor-deduped): the
  realistic *recurring* fact types (you really do have more than one standup
  blocker or more than one meeting over a career) — kept small on purpose so
  no single family's skeleton — even varied — comes to dominate the corpus.
- **Padding**: ~90 additional hand-written one-off memories with no attached
  question, for corpus realism and to comfortably clear the 400-memory /
  380-skeleton bar with margin.

`createdAt` dates are spread across 2025-01-01 through 2026-09-18 (205 in
2025, 210 in 2026).

### Distractor clusters (40)

1. Dentist appointments for Lucas (routine cleaning vs. cavity filling, different dentists)
2. Superseded decision: Aurora Health DB choice (Postgres → CockroachDB)
3. Two flights/trips to the same city, client visit vs. family wedding
4. Two performance reviews (a report's Q1 review vs. my own self-review)
5. Two mortgage/loan due dates (mortgage vs. car loan)
6. Two recipes: original vs. dairy-free modification
7. Two doctor appointments: annual physical vs. dermatology referral
8. Two laptops purchased (kid's schoolwork vs. work expense)
9. Two birthdays in the same month (friend vs. daughter)
10. Two contractor bids for the kitchen remodel
11. Two vet visits for the dog (routine booster vs. limp)
12. Two salary/comp decisions: starting salary, then a later raise
13. Anniversary dinner/gift vs. a separate birthday gift, same spouse
14. Garden Tracker infra decision, superseded (SQLite → Turso)
15. Two insurance claims (hail damage vs. a fender-bender)
16. Two school events for the kids (science fair vs. spring concert)
17. Two trips to the same city, conference vs. personal visit
18. Two credit cards (new travel card opened vs. old cashback card closed)
19. Superseded architecture decision: embeddings inline vs. isolated worker
20. Two gifts for the spouse, different occasions (Mother's Day vs. anniversary)
21. Two travel incidents (flight delay voucher vs. lost luggage)
22. Two family medical notes: kid's allergy vs. my own allergy panel
23. Two restaurant recommendations, different dish, one better for bringing a kid
24. Two garden plant records (tomatoes blooming vs. aphids on the basil)
25. Two mortgage refinance quotes, one declined, one later accepted
26. Two health metrics check-ins (resting heart rate vs. blood pressure)
27. Two meetings in the same week with different coworkers/topics
28. Two storage/moving decisions during the renovation
29. Two electrician visits, different scope (kitchen circuit vs. patio outlets)
30. Two "decided against" infra choices (vector DB SaaS, then bare metal)
31. Two subscription cancellations (coworking desk vs. meal-kit box)
32. Two souvenirs bought abroad for two different friends
33. Two accountant/tax filings, different years/entities
34. Two fitness commitments (half-marathon training vs. cycling club)
35. Two home repair emergencies (burst pipe vs. water heater replacement)
36. Two old-rental notes (security deposit history vs. a renovation-time sublet)
37. Two friends' moves, one across town, one across the country
38. Superseded metric target (original OKR vs. revised OKR)
39. Two travel visa/document notes (Croatia visa vs. Banff passport rule)
40. Two kids' extracurricular commitments (soccer vs. piano)

## Counts

- **Memories**: 415 (target ≥ 400)
- **Distinct skeletons**: 413 (target ≥ 380) — **max memories sharing any one
  skeleton: 2** (cap allowed 3; nothing hit the cap)
- **Questions**: 295 (target ≥ 220)
- **Projects** (8): Aurora Health App 83, Family Logistics 63, Riverside Home
  Reno 55, Finance & Admin 54, Personal Wellness 54, Travel & Trips 44,
  Kitchen & Recipes 34, Garden Tracker Side Project 28

**Questions per kind:**

| kind       | count | % of total | target |
|------------|------:|-----------:|--------|
| paraphrase |   179 |      60.7% | ≥ 60%  |
| keyword    |    62 |      21.0% | ~20%   |
| mixed      |    54 |      18.3% | ~20%   |

## Self-check (per task's hard rules)

- **(a) Every gold id exists**: verified programmatically — 0 missing.
- **(b) Content-word overlap** (question vs. its gold memory; lowercased,
  stopwords removed, crude suffix-stripping on `'s`/`ing`/`ed`/`es`/`s`):

  | kind       | mean overlap | n   |
  |------------|-------------:|----:|
  | paraphrase |        0.209 | 179 |
  | keyword    |        0.587 |  62 |
  | mixed      |        0.477 |  54 |

  Paraphrase is well under the 0.25 target (down from 0.39 in an
  intermediate hand-authored draft before the naturalness rewrite pass);
  keyword is high, as expected (it's supposed to share the distinctive rare
  terms/numbers/names); mixed sits between the two.
- **(c) No duplicate questions**: verified — 295 unique question strings, 295
  unique qids. Also verified: 415 unique memory texts, 415 unique ids.
- **(d) Every line parses as JSON**: verified for both files; every memory
  object has exactly the 6 specified fields, every question object exactly
  the 4 specified fields.
- **Skeleton cap**: verified programmatically that no skeleton is shared by
  more than 3 memories (actual max observed: 2).

### Ambiguity pass

Beyond the required self-checks, an anchor-overlap heuristic (any question
whose capitalized-name/number tokens all appear together in some other
memory) was run against the full corpus as a second-layer sanity check. It
flags a lot of harmless false positives (e.g. "Lucas" alone appears in ~35
memories, "Priya Ramaswamy" in many work notes — neither makes a *specific*
question ambiguous once its full wording is considered). But it also caught
real bugs, all fixed before finalizing:

- A "meeting" family draw that generated two near-identical memories ("Sat
  down with Bianca Ostrowski to discuss Q3 hiring plan" / "Met with Bianca
  Ostrowski to go over Q3 hiring plan") — the family's (person, subject)
  pair wasn't deduplicated, so it could (and once did) repeat.
- Several "keyword"-style families whose question text depends only on a
  natural anchor (task name, dish, destination, activity, plant, standup
  topic, decision subject) but whose *memory* generator wasn't deduplicated
  on that anchor — e.g. two "Crossed sealing the deck off the list" memories
  at two different costs would have made "How much did it cost to finish
  sealing the deck?" genuinely ambiguous even though only one such question
  string ended up in the file. Fixed by deduplicating the anchor at
  generation time for: reno task, reno delay, recipe dish, trip destination,
  workout activity, garden bed planting, standup topic, and decision
  subject.

After these fixes, every remaining heuristic flag was manually inspected and
confirmed to be a harmless shared-name false positive, not a real ambiguity.

## What wasn't done / known limitations

- The ambiguity pass is a heuristic (proper-noun/number token overlap), not
  a full semantic verifier — it can't formally prove all 295 questions are
  unanswerable from all 414 non-gold memories. It did catch and fix real
  bugs (above), and a full manual review of its remaining flags found only
  false positives, but an exhaustive semantic audit was out of scope for the
  time available.
- Per the task's hard rule, no alternative phrasings/aliases/leakage notes
  were written into either file, and no internal notes cross-link which
  distractor a given question is meant to rule out beyond the cluster
  structure documented above.
- The skeleton-masking function is vocabulary-based for this corpus's known
  entities (people/orgs/places/months) plus a generic "2+ consecutive
  TitleCase words" rule for anything else; it isn't a general-purpose NER
  system, but it covers every name-generating mechanism actually used here
  (fixed cast of characters, plus randomly combined first+last names for
  new-hire memories).
