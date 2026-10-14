# Phase 31 — Learning & Feedback: Trusted Outcome-Based Learning

Status: implemented, **not committed**. Scope: one new, read-only, derived aggregate over trusted Outcome V1
records. **Nothing is persisted. Nothing downstream consumes it. The canonical Intelligence pipeline is
provably unchanged.**

## 1. Purpose

Transform trusted historical Outcomes into a bounded, auditable, inspectable observation — not to make the
AI autonomous, and not to close any loop back into generation, retrieval, or execution.

## 2. Domain definition

> Learning is an aggregated, derived observation from trusted historical Outcomes, Actions, Decisions, and
> related operational context.

It is **not**: a user opinion, an arbitrary feedback comment, an LLM memory, a new Outcome, a Decision, an
Action, an approval, a prediction, a policy, a prompt, or a model weight update. Phase 31 adds no feedback
submission endpoint of any kind — doing so would create a second, unauthoritative Outcome source, which is
explicitly forbidden (see §4).

## 3. Source-of-truth hierarchy

```
Outcome (V1, immutable, Phase 30)
  -> Action (V1, closed actionType, Phase 29)
    -> Decision (V1, Phase 29) -> Intelligence -> Signal
```

Phase 31 reads **only** `Action.actionType` (the closed enum) and `Outcome.status`/`recordedAt` — the
aggregation query never touches a Decision, Intelligence, or Signal field. Learning is strictly downstream;
nothing here can manufacture an Outcome, and nothing here is itself treated as one.

## 4. Why there is no feedback-submission endpoint

A generic `POST /feedback` (or similar) accepting `{actionId, success: true}` from a human would create a
**second Outcome authority**, directly undermining Phase 30's trusted-boundary design. None was built. If a
genuinely separate, explicitly-provenanced human-feedback domain is ever needed, it must never be allowed to
masquerade as an execution Outcome — that is future-phase work, not implemented here.

## 5. Learning V1 contract (`GET /api/learning/outcomes`)

```json
{
  "workspaceId": "...",
  "learningVersion": "learning-v1",
  "sourceVersions": { "actionVersion": "action-v1", "outcomeVersion": "outcome-v1" },
  "window": { "from": "ISO", "to": "ISO" },
  "minimumSampleSize": 5,
  "patterns": [
    {
      "patternKey": "<sha256, truncated>",
      "actionType": "escalation",
      "outcomeCounts": { "success": 0, "failed": 0, "partial": 0, "unknown": 0 },
      "totalOutcomes": 0,
      "determinedOutcomeCount": 0,
      "successRate": null,
      "eligible": false,
      "sourceOutcomeCount": 0,
      "firstObservedAt": null,
      "lastObservedAt": null
    }
  ]
}
```

Exactly **5** pattern rows are always returned — one per `ACTION_TYPES` value (`maintenance_dispatch,
guest_communication, escalation, inspection, other`), always in that order, even when a type has zero data.
This is the entire bounded shape: nothing else is ever added to it, and no client input changes which fields
appear (see §19).

Unlike the existing Phase 7D learning report (`GET /api/learning`, arbitrary Decision/Action/Outcome ids and
text) and Phase 7F-A patterns (`GET /api/learning/patterns`, Signal-type recurrence), this is specifically
Outcome→actionType success/failure learning and was added as a **new sibling route** rather than folded into
either existing one, to keep each service small and single-purpose (consistent with CLAUDE.md's "prefer
small, domain-oriented service modules").

## 6. Aggregation formula and "unknown" semantics

```
determinedOutcomeCount = success + failed + partial     (unknown is EXCLUDED)
successRate = determinedOutcomeCount > 0 ? success / determinedOutcomeCount : null
```

`unknown` is excluded from **both** the numerator and the denominator — an outcome whose result could not be
determined is neither a success nor a failure. `successRate` is `null` (never `0` or `1`) when there is
nothing determined to compute it from. This value is never called "confidence" anywhere in the code or this
document: it is a plain, historical success proportion, not a statistical confidence interval or a
probability of future success.

## 7. Minimum sample size

`MINIMUM_SAMPLE_SIZE = 5`, applied to `determinedOutcomeCount` (not raw `totalOutcomes`, so a pile of
`unknown` outcomes can never make a pattern falsely "eligible"). This is a **documented, conservative
placeholder** — not statistically derived — chosen to be large enough that one anomalous Outcome cannot look
authoritative, and small enough to be reachable at this system's current, low operational volume. A pattern
below this threshold is returned (never hidden) with `eligible: false`: the raw aggregate is honestly
descriptive, and callers must not treat it as a reliable signal.

## 8. Time window

Default: the trailing 90 days ending at the **start of the current UTC day** — the exact convention
`patternService.js` already established, and reused for the identical reason: a request repeated twice within
the same day returns a byte-identical result (`startOfUtcDay` truncation), which matters for §14's
recomputability requirement. Both `from` and `to` are overridable via query parameters (validated, never
trusted blindly).

**Documented limitation**: because `to` defaults to start-of-today, an Outcome recorded *today* does not
appear in the default window until the following day. A caller that needs same-day visibility must pass an
explicit `to`. This is the same trade-off `patternService.js` already makes, not a new one.

## 9. Provenance

Every response carries `learningVersion`, `sourceVersions` (the exact Action/Outcome contract versions it
read), the resolved `window`, and `minimumSampleSize` — explaining **how** each row was computed without
needing anything else. Each row carries `sourceOutcomeCount` (identical to `totalOutcomes`) and
`firstObservedAt`/`lastObservedAt`. No raw Outcome id list is exposed (nothing in the existing UI/API needs
one) and no Decision/Intelligence/Signal text ever reaches this response at all (see §3).

## 10. Workspace isolation

`workspaceId` is `req.actor.workspaceId` only — never a request-body or query selector, identical to every
other Phase 16 read. The aggregation's `$match` carries it as the first condition on `Action`, and the nested
`$lookup` pipeline carries it again on `Outcome` — two independent workspace checks, not one, exactly the
"carry it on every query" convention `learningService.js`/`patternService.js` already use.

## 11. Authorization

Reuses the **existing** `workspace:admin` permission unchanged — the exact gate `GET /api/learning` and
`GET /api/learning/patterns` already use (Phase 16). No new permission was created. Viewer, operator, and
reviewer remain denied; this phase does not broaden Learning visibility in any way.

## 12. PII policy

The aggregation query reads exactly two fields of meaning: `Action.actionType` (a closed enum) and
`Outcome.status`/`recordedAt`. It never reads `Signal`, `Guest`, `Decision`, or `Intelligence` text, so there
is no code path through which a guest name, email, phone, address, reservation detail, free-form message,
model prompt, model response, credential, or token could reach a Learning response — verified by a static
scan and by marker-injection regression tests (letters Y/Z in the Phase 31 suite).

## 13. Recomputation model

Every `GET /api/learning/outcomes` call recomputes the result from scratch from `Action`/`Outcome` — there is
**no persisted `LearningPattern` collection**. Calling the derivation twice against the same database state
produces a semantically identical result (tested directly). This trivially satisfies "recomputable" and "no
double counting": there is no stored counter to double-increment, and no materialized row to regenerate
unsafely.

## 14. Duplicate handling

Phase 30 already guarantees at most one Outcome per Action; the aggregation's `$lookup` additionally matches
on `actionId` (plus workspace and `outcomeVersion`), so even a hypothetical second Outcome for the same Action
would be counted at most once per document it actually is (there is no row-multiplication path in this
pipeline).

## 15. Lifecycle / deletion behavior

Because nothing is persisted, Phase 22's workspace deletion needs no new cleanup step for Learning: once a
workspace's Actions/Outcomes are deleted, the very next `GET /api/learning/outcomes` call for that workspace
(if it could still be reached, which it cannot — the workspace itself is gone) would recompute to all-zero
rows. There is no orphaned Learning record to leave behind, by construction.

## 16. Runtime isolation — why Learning does not affect Intelligence yet

`outcomeLearningService.js` is imported by exactly one controller function
(`getOutcomeLearningPatterns` in `learningController.js`) and nothing else. Grepped and confirmed: it is
**not** imported by `intelligenceAnalysisService.js`, `operationalContextService.js`,
`analysisContextService.js`, `signalContextService.js`, any `services/ai/*` file, or any `ai-service/app/*`
file. The canonical `POST /api/intelligence/analyze/:signalId` pipeline (context assembly, retrieval, the AI
request, response validation) is untouched: no new prompt section, no new retrieval source, no confidence
adjustment, no threshold change, no model-selection change. A regression test captures the exact AI request
body for a canonical analysis both with and without rich Outcome/Learning-relevant data present in the
workspace and asserts the two are identical in shape and content.

## 17. Future integration boundary (not implemented)

If a future phase wants Learning to influence Intelligence, it would need its own explicit, reviewed design —
likely surfaced as one more clearly-labelled, bounded section of the operational context contract (mirroring
how Phase 27 added `operationalHistory`), never as a silent change to the prompt or the retrieval query. Phase
31 deliberately stops short of that: this is an evaluation boundary, not a wiring project.

## 18. Known limitations

- The default time window hides same-day Outcomes until the next UTC day (see §8).
- `MINIMUM_SAMPLE_SIZE = 5` is a placeholder, not a statistically justified threshold.
- Only Action V1 / Outcome V1 records are included; legacy (pre-V1) Actions/Outcomes have no `actionType`
  closed enum to group by and are excluded entirely, exactly as Phase 29/30 already treat legacy records as a
  separate, untouched lifecycle.
- No historical trend / time-series view exists — one snapshot per call, bounded to one window.

## 19. Phase 32 prerequisites (if Learning is ever wired into Intelligence)

Any future phase doing so must, at minimum: (a) define exactly which fields of a Learning pattern may cross
into a prompt and under what visibility ceiling; (b) prove the model still cannot alter risk, approval, or
permissions from that data (mirroring Phase 28's evidence-reference authorization model); (c) re-run this
phase's runtime-isolation regression test and show it now *intentionally* fails for a documented reason,
rather than silently start passing differently.

## 20. Files

Created: `backend/src/services/outcomeLearningService.js`,
`backend/scripts/validate-phase31-learning-feedback.mjs`, this document.
Modified: `backend/src/controllers/learningController.js`, `backend/src/routes/learningRoutes.js` (one new
GET route, same permission as the existing two).
Not modified: `backend/src/services/learningService.js`, `backend/src/services/patternService.js`,
Intelligence/Decision/Action/Outcome write paths, retrieval, evidence validation, the frontend, `.claude/`,
`CLAUDE.md`.
