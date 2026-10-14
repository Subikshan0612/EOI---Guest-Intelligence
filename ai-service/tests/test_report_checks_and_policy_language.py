"""
Phase 52 - two prompt-level pins (no provider is called; tests/conftest.py's network guard is on).

1. RAG-miss policy language: with no business guidance the model may reason generally but must present it as its own suggestion, never as the business's policy / protocol /
   procedure / SOP / "standard practice". (The server also enforces this on real-provider output: backend/scripts/validate-phase52-correctness.mjs.)
2. Report checks: when Node finds that the operator's own words conflict with a current record, it sends `reportChecks`; the analysis is told the record is authoritative, to say
   plainly that the two differ and to leave it unresolved. An absent `reportChecks` (the usual case) does not appear in the prompt at all.
"""

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.models.context import SignalContext
from app.models.operational_history import OperationalHistory
from app.services.analysis_prompt import ANALYSIS_SYSTEM_PROMPT, build_analysis_prompt

INPUT = json.loads((Path(__file__).parent / "fixtures" / "evidence_catalog_parity.json").read_text(encoding="utf-8"))["input"]
CHECK = {"kind": "stay_checkout_date", "reported": "tomorrow (2026-10-11)", "recorded": "2026-10-12"}


def context(report_checks=None):
    data = json.loads(json.dumps(INPUT["context"]))
    if report_checks is not None:
        data["reportChecks"] = report_checks
    return SignalContext(**data)


def test_system_prompt_says_general_reasoning_is_not_policy():
    assert "GENERAL REASONING IS NOT POLICY" in ANALYSIS_SYSTEM_PROMPT
    assert 'Never describe it as the business\'s or property\'s policy, protocol, procedure, SOP, guideline, rule or "standard practice"' in ANALYSIS_SYSTEM_PROMPT
    assert "Do not invent deadlines, fees, entry or notice procedures, escalation chains or roles." in ANALYSIS_SYSTEM_PROMPT


def test_system_prompt_makes_the_record_authoritative_over_a_conflicting_report():
    assert "REPORT CHECKS" in ANALYSIS_SYSTEM_PROMPT
    assert "The recorded value is the authoritative current fact; the report is an unverified statement." in ANALYSIS_SYSTEM_PROMPT
    assert "do not decide which one is right" in ANALYSIS_SYSTEM_PROMPT
    assert "never present the discrepancy as resolved" in ANALYSIS_SYSTEM_PROMPT


@pytest.mark.parametrize("history", [None, "with-history"])
def test_report_checks_reach_the_prompt_only_when_present(history):
    operational_history = OperationalHistory(**INPUT["operationalHistory"]) if history else None
    _, plain = build_analysis_prompt(context(), [], operational_history)
    assert "reportChecks" not in plain
    _, checked = build_analysis_prompt(context([CHECK]), [], operational_history)
    assert "reportChecks" in checked and "tomorrow (2026-10-11)" in checked and "2026-10-12" in checked


def test_report_checks_have_a_closed_shape():
    with pytest.raises(ValidationError):
        context([{**CHECK, "extra": "x"}])
    with pytest.raises(ValidationError):
        context([{"kind": "stay_checkout_date"}])
