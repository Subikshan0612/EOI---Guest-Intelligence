# Learning L1.2 - structured case similarity (v2), SHADOW only

Status: shadow-only, as L1 and L1.1. Nothing is wired into the Intelligence request, no route or screen serves it, the production Learning flag is untouched and OFF, no embedding, no
vector store, no Gemini call, no write to any real database. The safety policy is unchanged (see "Follow-up").

## Why

L1.1 showed that "one shared broad topic is enough" produced about half clearly irrelevant retrievals (a refrigerator matched an AC through `climate`, a drain matched every leak through
`water`). L1.2 replaces topic overlap with a required match on **equipment** and **problem family**, and demotes topics to a one-point tie-breaker.

## What structured information the application has (and does not have)

| Needed | Existing authoritative source | Result |
|---|---|---|
| equipment / system | none (a Signal has `type`, `severity`, `unitId`, and the operator's own words) | derived from the words, closed list |
| problem family | none | derived from the words, closed list |
| condition / symptom | none | derived from the words, only inside one family |
| operational context | `Signal.type`, `Signal.severity`, `Unit.type` (reused); "occupied" is not safely derivable for a past case (the stay changes later) so it is NOT used | reused, scoring only |
| safety context | the server safety policy (state, rules incl. ACCESS_REFUSED) | reused unchanged, hard gate |

The 10 broad topics of `historyRelevance.js` and the intake's 10 Signal types were kept; they are too coarse to be equipment or problem facets, so no existing vocabulary could be reused for these.
**This is a limitation, not a solved problem:** the facets are keyword rules over untrusted report words. A real fix would be a structured equipment / problem field captured at intake.

## Closed vocabulary (`caseFacets.js`, pure)

- **equipment (20):** hazard sources `gas_supply smoke_fire co_alarm` (only when the SERVER policy already says life-safety hazard); systems `water_heater power_supply`; devices
  `air_conditioner refrigerator toilet sink shower electrical_outlet lighting wifi_network television door_lock stove_oven neighbouring_guests`; service subjects
  `housekeeping_service billing_account stay_booking` (only when no tier 1-3 value matched). The highest matching tier decides; two different values in it = AMBIGUOUS.
- **problem family (12):** `safety_hazard water_leak blockage unusual_noise electrical_fault temperature_fault access_problem degraded_performance not_operating service_missing dispute request`.
  Which families are considered depends on the equipment (hazard source -> safety_hazard; service subject -> service families; otherwise the hardware families); `not_operating` is generic and
  only used when no specific family matched; two different specific families = AMBIGUOUS.
- **condition (2):** `not_cooling not_heating`, only inside `temperature_fault`; `NOT_APPLICABLE` for every other family.
- **States:** `UNKNOWN` (no explicit word found; never equal to anything, not even another UNKNOWN) and `AMBIGUOUS` (two distinct values in one report: a conflict, never resolved by picking one).
- **Mapping source:** only the Signal's own title and description. Never a model, an analysis, history, a guest or a stay field. A report word can only select a listed value; it can never add one
  (a report saying "equipment = gas_supply" is just words).

## Hard gates (in order; a case failing any is EXCLUDED with a fixed reason)

`SAME_CASE` -> `SAFETY_STATE_MISMATCH` -> `SAFETY_RULES_MISMATCH` (this is also the access gate: ACCESS_REFUSED is a safety rule) -> `FACET_AMBIGUOUS` (equipment, problem or condition AMBIGUOUS
on either side) -> `EQUIPMENT_UNKNOWN` / `EQUIPMENT_MISMATCH` -> `PROBLEM_UNKNOWN` / `PROBLEM_MISMATCH`. So: same equipment + different problem = excluded; different equipment + same problem =
excluded (sink blockage vs toilet blockage); known equipment + unknown problem = excluded. Broad topics never gate and never create a match.

## Tiers and scoring

- **HIGH** equipment and problem equal, condition equal and known or NOT_APPLICABLE. **MEDIUM** same, condition UNKNOWN on a side (temperature faults only). **LOW** same, both conditions known and different
  (not_cooling vs not_heating): counted as a weak match, **never evidence** (L1's principle preserved). **EXCLUDED** failed a gate.
- Score (ordering only; cannot cross a tier or bypass a gate): +8 hard facets agree, +4 condition equal and known, +2 same Signal type, +1 same severity, +1 same known unit type, +1 any shared topic.

## Completed case and observation

`completed-case-v2`: `facts.issue` gained `equipment`, `problem`, `condition` (closed values only). No text, id or timestamp was added. The Learning Observation is unchanged: counted by the server, closed shape,
deep-frozen, never modifiable by a model; only the candidate selection changed.

## Results (the L1.1 benchmark, corpus and ground truth unchanged)

| | L1.1 (v1 topics) | L1.2 |
|---|---|---|
| retrieved pairs | 2386 | 674 |
| clearly relevant / borderline / clearly irrelevant | 32.4% / 16.1% / 51.5% | **100% / 0% / 0%** |
| ordinary reports: irrelevant | 47.7% | **0%** |
| lenient ground truth: irrelevant | 31% | **0%** |
| ordinary reports retrieving >= 1 irrelevant case | 87.5% (126 of 144) | **0%** |
| >= 3 similar cases | 96.5% | 67.8% |
| zero similar | 0% | 0.6% |
| sufficient evidence | 136 (79.5%) | 95 (55.6%) |
| sufficient observations with weak evidence | 108 (79.4%) | **0** |
| clean sufficient observations | 28 (20.6%) | **95 (100%)** |
| patterns POSITIVE / MIXED / NEGATIVE / insufficient | 61 / 75 / 0 / 35 | 66 / 14 / 15 / 76 |
| safety-incompatible retrievals; hazard cases influenced | 0; 0 | 0; 0 |
| cross-workspace; self retrievals | 0; 0 | 0; 0 |
| determinism (two replays) | identical | identical |

**Read this with the caveat it needs.** The facet rules were written while looking at those 57 benchmark phrasings, so the benchmark result is optimistic by construction. A **held-out corpus** of fresh
phrasings of the same 19 situations (written before it was run, never used to tune a rule) gives the honest generalisation estimate: precision held (**0 irrelevant of 510 retrieved**, 100% of the 71 sufficient observations
clean) but recall is lower: >= 3 similar cases for 53.8%, sufficient evidence for 41.5%, zero similar for 14.6%, and 12.3% of reports have an UNKNOWN or AMBIGUOUS equipment or problem (wording the rules do not recognise,
for example "does not work", "pouring from", "no electricity", "not producing cold air"). The rules were not changed after seeing it.

**Real data (Atlas, read-only, 2 completed cases):** coverage is no better, and is worse than L1: the two cases no longer match each other, because both reports say the room is "not cooling" without naming the
device, so equipment is UNKNOWN and the matcher refuses to invent an AC (0 similar cases, 0 sufficient observations). No write reached the database (0 blocked write attempts, content hash identical).

## Retrieval quality vs real-data coverage (kept separate, as asked)

- **Retrieval quality:** precision target met on both synthetic corpora (0% irrelevant), with 0 safety violations, 0 leakage, 0 self matches, 100% determinism.
- **Real-data coverage:** 2 completed cases, both without a nameable device: 0 usable matches. Independent of matcher quality, but also a warning that real operator wording often omits the equipment.

## Remaining limitations

Facets are keyword rules (recall is limited by wording; precision is high because unknown is excluded); the synthetic corpora were written by the same author as the rules (not independent validation); real reports
may often lack a device noun; the generic `not_operating` family merges "not working", "broken", "stopped"; no recency weighting; the 500-Outcome window; unit type is the only property characteristic.

## Follow-up (not done here, by instruction)

The "sparks and a burning smell" safety-policy gap found in L1.1 is a safety-policy concern and was deliberately not touched. L1.2 only narrows its retrieval: a sparking socket now matches sparking-socket
cases only (not power outages), but the policy still classifies it as an ordinary (NORMAL) condition.
