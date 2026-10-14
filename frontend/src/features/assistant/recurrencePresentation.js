import { formatStayDate } from "../../utils/formatDate";

/**
 * How the page states the server's RECURRENCE answer (safety/context hardening, P2-B). The only input is `context.recurrence`, derived by the server from the structured issue of this report and of
 * earlier reports of the same room (backend/src/services/recurrence.js). This module chooses WORDS for what the server already decided; it does not decide anything, reads no report text, and
 * asserts nothing the server did not send:
 *   - it says only that an earlier report about the same kind of problem is ON RECORD for this room (a record match) - never a cause, never "this room always...", never what will work;
 *   - the equipment / problem / condition words come from exact-match tables over the closed vocabulary; a value it does not know is left out, never guessed;
 *   - a recorded Outcome of the earlier report (only sent to roles that may read Outcomes) is shown as what a PERSON reported, with their words, and nothing is inferred from it.
 * Returns null when there is nothing to state (no recurrence, or an answer this view does not recognise).
 */
const EQUIPMENT = Object.freeze({
  gas_supply: "gas supply", smoke_fire: "smoke or fire", co_alarm: "carbon monoxide alarm", water_heater: "water heater", power_supply: "power supply", air_conditioner: "air conditioner",
  refrigerator: "refrigerator", toilet: "toilet", sink: "sink", shower: "shower", electrical_outlet: "electrical outlet", lighting: "lighting", wifi_network: "Wi-Fi", television: "television",
  door_lock: "door lock", stove_oven: "stove or oven", neighbouring_guests: "neighbouring guests", housekeeping_service: "housekeeping", billing_account: "billing", stay_booking: "stay or booking",
});
const PROBLEM = Object.freeze({
  safety_hazard: "safety hazard", water_leak: "water leak", blockage: "blockage", unusual_noise: "unusual noise", electrical_fault: "electrical fault", temperature_fault: "temperature fault",
  access_problem: "access problem", degraded_performance: "degraded performance", not_operating: "not operating", service_missing: "missing service", dispute: "dispute", request: "request",
});
const CONDITION = Object.freeze({ not_cooling: "not cooling", not_heating: "not heating" });
const OUTCOME = Object.freeze({ success: "Success", partial: "Partial", failed: "Failed", unknown: "Unknown", blocked: "Blocked" });

const known = (table, key) => typeof key === "string" && Object.prototype.hasOwnProperty.call(table, key);

export function describeRecurrence(recurrence) {
  if (!recurrence || typeof recurrence !== "object" || recurrence.detected !== true || !Array.isArray(recurrence.matches) || recurrence.matches.length === 0) return null;
  const newest = recurrence.matches[0];
  if (!newest || !known(EQUIPMENT, newest.issue?.equipment) || !known(PROBLEM, newest.issue?.problem)) return null;
  const kind = [EQUIPMENT[newest.issue.equipment], PROBLEM[newest.issue.problem], newest.condition === "same" && known(CONDITION, newest.issue.condition) ? CONDITION[newest.issue.condition] : null].filter(Boolean).join(" · ");
  const when = newest.reportedAt ? formatStayDate(newest.reportedAt) : "";
  const count = recurrence.matches.length;
  const lines = [
    `An earlier report about the same kind of problem (${kind}) is on record for this room${when ? `, reported ${when}` : ""}.${count > 1 ? ` ${count - 1} more earlier report${count - 1 === 1 ? "" : "s"} of the same kind ${count - 1 === 1 ? "is" : "are"} on record.` : ""}`,
  ];
  if (newest.condition !== "same") lines.push("The condition (for example not cooling) was not recorded on one of the two reports, so only the equipment and kind of problem were compared.");
  // The most recent earlier report that has an Outcome a person recorded (the server sends it only to roles that may read Outcomes).
  const withOutcome = recurrence.matches.find((m) => m?.outcome && known(OUTCOME, m.outcome.status));
  if (withOutcome) {
    const said = typeof withOutcome.outcome.summary === "string" && withOutcome.outcome.summary.trim() ? ` ${withOutcome.outcome.summary.trim()}` : "";
    const on = withOutcome.reportedAt ? formatStayDate(withOutcome.reportedAt) : "";
    lines.push(`What a person recorded for the earlier report${on ? ` of ${on}` : ""}: ${OUTCOME[withOutcome.outcome.status]}.${said}`);
  }
  return { headline: "This looks like a repeat of an earlier report for this room.", lines, caveat: "This is a match between records only. It does not say why it happened or what will work this time." };
}
