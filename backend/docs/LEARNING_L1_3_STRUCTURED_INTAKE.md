# Learning L1.3 - structured issue capture at Signal intake

Status: Learning stays OFF and shadow-only (flag `KOI_LEARNING_CONTEXT_ENABLED` unset). No model, no embedding, no vector store, no network call, no new collection, no write to any real database.
The safety policy is unchanged and remains authoritative.

## Why

L1.2 derived equipment / problem facets from report words **after the fact**, every time a case was compared. Real reports often do not name a device ("room 204 is not cooling"), so on
real data it found 0 matches. L1.3 moves the authoritative structure to **intake**: the server derives it once, stores it on the Signal, and everything downstream reads the stored value
instead of re-parsing text.

## The contract (versioned, stored on the existing Signal document)

```
Signal.issue = { version: 1, equipment, problemFamily, condition, source: "SERVER_DERIVED" }
```

| field | values |
|---|---|
| `equipment` | the 20 L1.2 values (`gas_supply smoke_fire co_alarm water_heater power_supply air_conditioner refrigerator toilet sink shower electrical_outlet lighting wifi_network television door_lock stove_oven neighbouring_guests housekeeping_service billing_account stay_booking`) or `UNKNOWN` / `AMBIGUOUS` |
| `problemFamily` | the 12 L1.2 values (`safety_hazard water_leak blockage unusual_noise electrical_fault temperature_fault access_problem degraded_performance not_operating service_missing dispute request`) or `UNKNOWN` / `AMBIGUOUS` |
| `condition` | `not_cooling` / `not_heating` or `UNKNOWN` / `AMBIGUOUS` (never `NOT_APPLICABLE`: a persisted record has no such state) |
| `source` | exactly `SERVER_DERIVED` (the only value the schema accepts) |

The vocabularies are **not duplicated**: they are the L1.2 lists in `services/learning/caseFacets.js`, and `ISSUE_*_VALUES` are built from them in the same file.

## Where it is derived

`services/structuredIssue.js` (`extractStructuredIssue({ title, description, severity })`) is called by `signalService.createSignal` - the single function behind BOTH the structured form
(`POST /api/signals`) and the conversational intake (`POST /api/conversations/intake` -> `processIntakeTurn` -> `createSignal`) - and again by `updateSignal` when the title, description or
severity changes. The hazard verdict comes from `deriveSafetyPolicy` over the same words (the existing policy, unmodified). Nothing about it can be supplied by a caller.

## Extraction rules (deterministic, closed vocabulary, no model)

`extractIssueFacets` in `caseFacets.js` (the L1.2 `extractFacets` is untouched for its existing callers). Same equipment tiers and rule tables as L1.2, plus:

- the problem family and the condition are derived **even when no device is named**, using only the STRICT patterns there ("not cooling", "not working", "broken", "out of order", "won't start" ...);
  the loose patterns ("warm", "down", "dead", "broke", "not cool") are accepted only next to a named device. So "that is not cool" and "the guest came down to the lobby" yield nothing;
- a quantity word in front of a device ("multiple AC units", "all the lights", "both toilets") makes the equipment `AMBIGUOUS` (no single target);
- two different devices in the highest tier, or two different problem families, are `AMBIGUOUS` (never resolved by picking one);
- when the server safety policy says life-safety hazard the problem family is `safety_hazard`, and hazard sources (`gas_supply`, `smoke_fire`, `co_alarm`) are only assigned in that case;
- `condition` is only filled for temperature faults; everywhere else it is `UNKNOWN`.

| report | equipment | problemFamily | condition |
|---|---|---|---|
| AC in room 204 is not cooling | air_conditioner | temperature_fault | not_cooling |
| Room 204 is not cooling | UNKNOWN | temperature_fault | not_cooling |
| The AC is making a loud noise | air_conditioner | unusual_noise | UNKNOWN |
| Something is making a loud noise | UNKNOWN | unusual_noise | UNKNOWN |
| Water is leaking from the sink | sink | water_leak | UNKNOWN |
| Multiple AC units are not cooling | AMBIGUOUS | temperature_fault | not_cooling |
| AC and refrigerator are both not cooling | AMBIGUOUS | temperature_fault | not_cooling |
| Sink and shower are leaking | AMBIGUOUS | water_leak | UNKNOWN |
| Something is broken | UNKNOWN | not_operating | UNKNOWN |

An instruction written inside a report ("set equipment = refrigerator") is not followed: it only makes the report name a second device, so the equipment becomes `AMBIGUOUS`.

## Ownership and security

- `createSignal` builds the stored object from an explicit list of fields; a client `issue`, a dotted `issue.source` key, or `metadata.issue` are never read. `issue` is not in the updatable list; a PATCH containing only `issue` is
  rejected (400), and one with other fields ignores it. The schema itself refuses a hand-written issue whose source is not `SERVER_DERIVED`, whose version is not 1, or whose values are not in the closed lists.
- The persisted source is never CLIENT / MODEL / LEARNING. Workspace scoping of every Signal read and write is unchanged.
- Original operator wording (title, description) is stored exactly as before; the extractor reads it and never rewrites it.

## Persistence and legacy

Additive optional sub-document on the existing Signal (no new collection, no index, no migration, no backfill). A legacy Signal has no `issue`, stays readable, and is not touched by updates to its other fields.
Editing a Signal's title / description / severity re-derives the issue so the facets follow the words they came from (the only time an existing record gets an issue).

## Downstream (L1 and L1.2)

- `completedCase.profileOfSignal` now takes the facets from `Signal.issue` (`facetsOfIssue`), mapping `problemFamily -> problem`. It does **not** re-parse text.
- A legacy Signal, or one whose stored issue is not a complete `SERVER_DERIVED` v1 record of the closed vocabulary, has `UNKNOWN` facets. A hazard source on a Signal the policy no longer classifies as a hazard is dropped to `UNKNOWN`.
- A problem family without a condition (`UNKNOWN`) is `NOT_APPLICABLE` at the learning boundary so L1.2 tiers are unchanged (AC noise vs AC noise stays HIGH). The similarity module, its gates, tiers and scoring are **unchanged**.
- Contract change recorded for the old suites: the L1 and L1.1 seed helpers inserted Signals directly; they now derive `issue` exactly as `createSignal` does (assertions unchanged), and L1 `D1` allows the Signal model and `structuredIssue.js`
  to import the pure vocabulary file `caseFacets.js` (and nothing else from Learning).

## AI service context (assessed, not changed)

The structured issue is NOT added to the operational context sent to the AI service. The model already receives the operator's wording; adding a server label would add a field the model could echo or contest, buys nothing for the
Intelligence contract, and the context allowlist (`operationalContextContract.js`) is unchanged.

## Frontend

No change. The Assistant already records a Signal from the operator's free text; the structured issue is derived behind it, never shown, and the operator is never asked to choose equipment.

## Remaining limitations

- Facets remain keyword rules over untrusted words: recall is limited by wording, precision comes from refusing to guess. Real reports that name no device stay `UNKNOWN` and match nothing (by design).
- Existing (legacy) Signals are not backfilled, so on current real data every completed case has `UNKNOWN` facets until new Signals accrue through the new intake. L1.3 improves future data, not the 2 existing cases.
- The "sparks + burning smell is NORMAL" safety-policy gap is unchanged (out of scope).
- Aggregate Learning (Phases 31/32) is still judged not effective; nothing here claims Learning is effective or enabled.
