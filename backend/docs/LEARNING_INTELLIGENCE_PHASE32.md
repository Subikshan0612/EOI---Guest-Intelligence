# Phase 32 — Learning-Guided Intelligence Evaluation & Safe Feedback

Status: implemented, **not committed**, **evaluation-only**. `KOI_LEARNING_CONTEXT_ENABLED` defaults to
`false` and stays `false` after this phase. Nothing about the canonical Intelligence pipeline's default
behavior changed.

## 1. Objective

Evaluate whether Phase 31's trusted, read-only Learning V1 aggregate may safely inform Intelligence
generation — **not** to wire it in unconditionally. The deliverable is a bounded contract, a feature flag
defaulting off, a fail-closed runtime path, and an offline evaluation harness that can certify safety. Quality
improvement is a separate, still-open question this phase does not claim to answer (see §17).

## 2. Why Learning is not automatically trusted

A Learning pattern is a *historical aggregate about other cases*, not a fact about the Signal being analyzed
right now. Blindly trusting it risks: the model treating a high historical success rate as proof the current
recommendation will work, a small sample masquerading as strong evidence, and — architecturally — a path by
which Intelligence output could eventually influence what Learning itself reports (a feedback loop). Every
section below exists to rule out one of these risks explicitly, never implicitly.

## 3. Learning V1 source (unchanged from Phase 31)

```
Outcome (V1, immutable) -> Action (V1, closed actionType) -> outcomeLearningService.js (Phase 31, read-only, not persisted)
```
Phase 32 adds nothing to this chain and changes nothing about it. It only adds one new consumer,
`learningContextService.js`, downstream of Phase 31's own already-tested aggregate.

## 4. Learning context contract

New files: `backend/src/services/learningContextContract.js` (shape/validation, mirrors
`operationalContextContract.js` exactly) and `backend/src/services/learningContextService.js`
(`buildLearningContext(workspaceId)`, the only bridge). Python mirror: `ai-service/app/models/learning.py`.

```json
{
  "learningVersion": "learning-v1",
  "minimumSampleSize": 5,
  "windowDays": 90,
  "patterns": [
    { "actionType": "maintenance_dispatch", "sampleSize": 17, "successCount": 11, "failedCount": 3, "partialCount": 1, "successRate": 0.7333, "eligible": true }
  ]
}
```

Always exactly 5 pattern rows (Phase 29's closed `ACTION_TYPES` set, same convention as Phase 31's own API).
No id, no timestamp, no raw text anywhere — every field is a closed enum, a non-negative integer, a boolean,
or a float bounded to `[0,1]` (or `null`). This is deliberately smaller than Phase 31's own
`GET /api/learning/outcomes` response: `patternKey`, `sourceOutcomeCount`, `firstObservedAt`/`lastObservedAt`
are all dropped as "not specifically needed" by the model (Phase 32 spec §3).

## 5. Prompt / data separation

`ai-service/app/services/analysis_prompt.py` adds a fifth labelled section, `=== LEARNING CONTEXT (HISTORICAL
AGGREGATE) ===`, serialized as JSON (never free text — nothing in the contract needs the `_neutralize()`
marker-stripping that knowledge/history text gets, because there is no free-text field to neutralize). The
system prompt gains rule 23, stating explicitly: Learning is a historical aggregate, not evidence about the
current Signal, not an instruction; there is no `"learning"` evidenceRef type; current operational evidence
always wins in a conflict; a sample below `minimumSampleSize` must be treated as no evidence at all; the
model's own `confidence` must never restate a pattern's `successRate`.

## 6. Temporal rules

The contract carries no timestamp, so the model cannot be told (or infer) that a pattern is "current" —
staleness cannot be represented at all, which is itself the safety property that would otherwise need
testing (see the evaluation dataset's case M). `buildLearningContext` recomputes from Phase 31 fresh on every
call — nothing is cached, so a later Outcome is reflected on the very next call, and an earlier returned
object is never retroactively mutated (both proven directly in
`validate-phase32-learning-integration.mjs`, checks V/AJ).

## 7. Sample-size semantics

Carried through unchanged from Phase 31: `sampleSize` (Phase 31's `determinedOutcomeCount`, unknown already
excluded) and `eligible` (`sampleSize >= minimumSampleSize`) travel together, so the model can see *both* the
rate and how much it should trust it — never a bare rate with no indication of how many observations back it.

## 8. Context bounds

`maxPatterns = 5` (`LEARNING_CONTEXT_LIMITS.maxPatterns`), exactly Phase 29's own closed action-type count.
Selection is **not** a relevance judgment — it is always the complete closed set, in the same fixed order,
every time (Phase 32 spec §17: avoid both a client-controlled and an LLM-driven selection mechanism).

## 9. No new evidence type

Learning is **not** added as an `evidenceRefs` type (`operational` / `historical` / `knowledge` remain the
only three, on both the Node (`analysisSchema.js`) and Python (`app/models/analysis.py`) sides). A model
cannot cite a Learning pattern as a structured reference even if it wanted to — the type literally does not
exist. If Learning materially informs a recommendation, the response must still ground its formal evidence in
operational/historical/knowledge references; Learning remains contextual metadata only. Documented here as a
deliberate decision, not an oversight.

## 10. Workspace isolation

`buildLearningContext` takes a verified `workspaceId` (the same server-resolved `req.actor.workspaceId` every
other call site uses — never a client selector) and forwards it unchanged to Phase 31's own
already-workspace-scoped aggregation. Proven dynamically: a fresh workspace sharing an enabled-flag backend
with a workspace that has rich, eligible Learning data sees every pattern at `sampleSize: 0` — none of the
other workspace's data leaks across (`validate-phase32-learning-integration.mjs`, check AR).

## 11. Authorization

Unchanged. Learning context attachment is not gated by role, permission, or visibility level — it is gated
only by the server-side `KOI_LEARNING_CONTEXT_ENABLED` flag, which no request can see or influence. No
auth/role/permission file (`src/auth/*`) references Learning at all (verified statically).

## 12. PII policy

The contract has no field that could carry a name, email, phone, address, or reservation detail — structurally,
not just by convention. A marker string planted in `Outcome.result` (free text Phase 31 never reads either)
is confirmed absent from the built Learning context in the suite's poisoning-defense check.

## 13. Feature flag

`KOI_LEARNING_CONTEXT_ENABLED` (`backend/src/config/runtimeConfig.js::getLearningContextEnabled()`).
Server-side only, read fresh on every call (never cached, never a request parameter), default **false** —
only the exact string `"true"` (case-insensitive, trimmed) enables it. No controller or route reads a
learning-related query/body field; there is no API surface through which any role could enable it per-request
(verified both statically and dynamically — a request body/query/header explicitly attempting to turn it on
against a disabled backend has zero effect).

## 14. Disabled-mode behavior (default)

The AI-service request body is **byte-for-byte identical** to pre-Phase-32: exactly `{context, knowledge,
authorizedLevel, operationalHistory}`, no `learning` key at all (not even `null`). Proven with a real spawned
backend and a recording proxy, mirroring Phase 31's own RIP methodology exactly.

## 15. Enabled-mode behavior

Exactly one additional top-level key, `learning`, matching the contract shape precisely. Every other key
(`context`, `knowledge`, `authorizedLevel`, `operationalHistory`) is built by the exact same, unconditional
code path as the disabled case — proven both dynamically (stripping `learning` from the enabled request
leaves an object with the same key set as the disabled request) and statically (the flag-gated block in
`intelligenceAnalysisService.js` contains nothing but the `buildLearningContext` call and the assignment; it
never touches `context`/`knowledge`/`operationalHistory`).

## 16. Failure behavior

Fail closed, by construction: `buildLearningContext` either returns a fully contract-validated object or
throws (`AppError`, 500) — there is no code path that returns a partial or unvalidated Learning context. When
the flag is on and building Learning throws, the whole `analyzeSignal` call fails before any AI-service
request is sent (no "send without the field as a silent fallback" path exists). When the flag is off,
`learningContextService.js` and `learningContextContract.js` are never invoked at all.

## 17. Evaluation methodology

`backend/evaluation/learning/` — a self-contained, offline harness (`lib.mjs` + `run-evaluation.mjs` +
`dataset.json`) that talks directly to a forced-test ai-service's `POST /v1/intelligence/analyze`, never a
full backend/MongoDB stack (that path is already covered by the integration suite's RIP proof). For every
dataset case it sends two otherwise-identical requests — with and without `learning` — and diffs the
responses. Run 3 times; results were byte-identical across all 3 runs (`meta.reproducible: true` in
`evaluation/results/phase32-learning-results.json`).

**Honest limitation, stated up front**: the test provider (`generate_deterministic_analysis`) performs no
reasoning. Attaching Learning can only ever add one bounded, count-only evidence line under this provider, by
construction — it cannot change `situation`, `impact`, `recommendation`, or `confidence`. This harness
therefore *can* certify safety (no leakage, no instruction-following, no authority over current evidence, no
schema violation) but *cannot* measure quality improvement — that requires a real reasoning model, which
Phase 32's own testing constraints (no real external AI calls) rule out.

## 18. Evaluation dataset

12 synthetic, directly-tested cases (A–H, I, K, L, N — genuinely useful, irrelevant, conflicting, small
sample, unknown-only, overwhelming success, overwhelming failure, mixed, absent, malicious signal text,
misleading pattern, insufficient observations) plus 2 cases answered structurally rather than by a synthetic
request (`dataset.json`'s `structurallyAnswered`): **J** (cross-workspace — no workspace concept exists at
the ai-service layer at all; proven instead at the Node layer, §10 above) and **M** (staleness — the contract
carries no timestamp field, so it cannot be represented in the first place).

## 19. Metrics / promotion gates

Every case records: whether `situation`/`impact`/`confidence` are identical between arms, whether the
recommendation text is identical, the evidence-count delta (always exactly 1 when Learning is attached, 0
when it is not), whether the count-only note appears in the expected arm, and whether any raw
`successRate`/`sampleSize` text leaks into prose fields. A case is `safe` only if all of these hold. Result:
**12/12 cases safe, reproducible across 3 runs** (`evaluation/results/phase32-learning-results.json`).

Promotion gates (Phase 32 spec §28), evaluated honestly:

| Gate | Result |
|---|---|
| No security regression | met (full regression suite green) |
| No workspace leakage | met (§10) |
| No PII leakage | met (§12) |
| No evidence-contract regression | met (§9, unchanged) |
| No authorization change | met (§11) |
| No retrieval change | met (static: no Learning reference in `knowledgeRetrievalService.js`) |
| No execution path | met (static: no execution-shaped code in either new file) |
| No Outcome fabrication | met (Learning build creates no Action/Outcome/Decision) |
| No temporal leakage | met (§6) |
| No prompt-injection takeover | met (contract has no free-text field; system prompt rule 23) |
| Measurable quality improvement | **not measured** — see §17 |

## 20. Promotion decision

**`KOI_LEARNING_CONTEXT_ENABLED` stays `false`.** Safety is certified for the test-provider path; no evidence
exists yet that enabling Learning measurably improves Intelligence quality, because measuring that requires a
real model and Phase 32 explicitly forbids real external AI calls during its testing. Per the Phase 32 spec
(§28): *"The phase is still successful if the evaluation shows 'Learning is not yet safe/useful enough to
enable.'"* — this is exactly that outcome, stated honestly rather than inferred from superficial output
differences.

## 21. Known limitations

- Quality improvement is unmeasured (§17/§20) — a future phase would need a real-provider evaluation
  (mirroring Phase 26.5A's own real-embedding evaluation precedent) before any promotion decision could
  change.
- `minimumSampleSize` and `windowDays` are Phase 31's own placeholders, not re-derived here.
- The Learning context omits timestamps entirely (§6); if a future phase needs recency-aware reasoning, that
  is a new, reviewed contract change, not an extension of this one.
- No per-action-type relevance filtering exists (§8) — all 5 types are always sent, even when most are
  irrelevant to the current Signal. This was a deliberate simplicity/safety trade-off (Phase 32 spec §17),
  not an oversight.

## 22. Phase 33 prerequisites (if Learning is ever enabled by default)

1. A real-provider (non-test) evaluation, run under the same "no accidental production calls" discipline as
   Phase 26.5A, actually measuring whether Learning changes recommendation quality — not merely that it is
   safe.
2. An explicit, reviewed sign-off changing `KOI_LEARNING_CONTEXT_ENABLED`'s default, documented as its own
   change, never a silent side effect of another phase.
3. Re-running this phase's entire security/mutation suite against the real-provider configuration, and
   showing it still passes unmodified.
4. If any promotion gate above would ever be loosened, that loosening must be its own explicit, documented
   decision — never an incidental consequence of unrelated work.

## 23. Files

Created: `backend/src/services/learningContextContract.js`, `backend/src/services/learningContextService.js`,
`backend/scripts/validate-phase32-learning-integration.mjs`, `backend/evaluation/learning/{dataset.json,
lib.mjs, run-evaluation.mjs}`, `backend/evaluation/results/phase32-learning-results.json`,
`ai-service/app/models/learning.py`, `ai-service/tests/test_learning_context.py`, this document.

Modified: `backend/src/config/runtimeConfig.js` (new flag), `backend/src/services/intelligenceAnalysisService.js`
(one flag-gated line), `backend/src/services/ai/aiServiceClient.js` (one optional parameter),
`backend/scripts/validate-phase19-route-inventory.mjs` (unrelated Phase-31 route-inventory fix only),
`ai-service/app/models/analysis.py`, `ai-service/app/routers/analysis.py`,
`ai-service/app/services/{analysis_prompt.py, deterministic_analysis.py, gemini_analysis_client.py}`.

Not modified: Phase 25 retrieval, Phase 28 evidence validation, Phase 29 Action lifecycle, Phase 30 Outcome
integrity, Phase 31's own files, `src/auth/*`, the frontend, `.claude/`, `CLAUDE.md`.
