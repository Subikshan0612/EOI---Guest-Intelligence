/**
 * Phase 37 - turns the backend's safe `[KOI EVENT]` lines into the six operational rates. This is the INTEGRATION BOUNDARY, not a metrics
 * platform: the application writes structured events to stdout; whatever collects stdout (a log shipper, a cloud log service, `docker logs`,
 * a file) can apply exactly these counting rules, or pipe a log through this script.
 *
 *   <log source> | node scripts/phase37/summarize-events.mjs
 *
 * Counting rules (every one uses fields the event allowlist guarantees; none needs a prompt, an output, an id or any content):
 *   accepted rate            analysis.accepted / (analysis.accepted + analysis.rejected)
 *   provider failure rate    analysis.rejected with failureClass in {configuration, authentication, invalid_request, rate_limit,
 *                            provider_unavailable, malformed_response, safety_block}  (a failure of the model call or its response)
 *   timeout rate             analysis.rejected with failureClass = provider_timeout   (provider, AI-service or retrieval-budget timeout)
 *   validation rejection     analysis.rejected with failureClass = validation_failure (schema/identity/claims/safety/prose/identifier - split by decidedAt)
 *   audit failure rate       analysis.audit_write_failed / (accepted + rejected)      (attempts whose durable row could not be written)
 *   coalescing rate          analysis.coalesced / (accepted + rejected + coalesced)   (requests that joined an in-flight analysis)
 *   governance rejection     governance.rejected                                      (count, and per code)
 *   authorization denials    authz.denied                                             (count, and per code)
 * Lines that are not `[KOI EVENT]` JSON are ignored; a malformed event line is counted, never thrown on.
 */
const PROVIDER_FAILURE = new Set(["configuration", "authentication", "invalid_request", "rate_limit", "provider_unavailable", "malformed_response", "safety_block"]);

export function summarizeEvents(lines) {
  const c = { accepted: 0, rejected: 0, coalesced: 0, auditFailed: 0, governance: 0, authz: 0, malformed: 0, providerFailure: 0, timeout: 0, validation: 0, internal: 0 };
  const byDecidedAt = {}; const governanceCodes = {}; const authzCodes = {}; const reasonCodes = {}; const ruleCodes = {};
  const bump = (m, k) => { if (k) m[k] = (m[k] || 0) + 1; };
  for (const line of lines) {
    if (typeof line !== "string" || !line.startsWith("[KOI EVENT] ")) continue;
    let e; try { e = JSON.parse(line.slice("[KOI EVENT] ".length)); } catch { c.malformed += 1; continue; }
    switch (e.event) {
      case "analysis.accepted": c.accepted += 1; break;
      case "analysis.rejected":
        c.rejected += 1; bump(byDecidedAt, e.decidedAt); bump(reasonCodes, e.reasonCode); bump(ruleCodes, e.ruleCode);
        if (PROVIDER_FAILURE.has(e.failureClass)) c.providerFailure += 1; else if (e.failureClass === "provider_timeout") c.timeout += 1; else if (e.failureClass === "validation_failure") c.validation += 1; else c.internal += 1;
        break;
      case "analysis.coalesced": c.coalesced += 1; break;
      case "analysis.audit_write_failed": c.auditFailed += 1; break;
      case "governance.rejected": c.governance += 1; bump(governanceCodes, e.code); break;
      case "authz.denied": c.authz += 1; bump(authzCodes, e.code); break;
      default: break;
    }
  }
  const attempts = c.accepted + c.rejected;
  const rate = (n, d) => (d > 0 ? Math.round((n / d) * 10000) / 10000 : null);
  return {
    attempts, counts: c,
    rates: {
      acceptedRate: rate(c.accepted, attempts), providerFailureRate: rate(c.providerFailure, attempts), timeoutRate: rate(c.timeout, attempts),
      validationRejectionRate: rate(c.validation, attempts), internalFailureRate: rate(c.internal, attempts), auditFailureRate: rate(c.auditFailed, attempts),
      coalescingRate: rate(c.coalesced, attempts + c.coalesced),
    },
    governanceRejections: { count: c.governance, byCode: governanceCodes }, authorizationDenials: { count: c.authz, byCode: authzCodes },
    rejectionsByStage: byDecidedAt, rejectionsByReasonCode: reasonCodes, rejectionsByRuleCode: ruleCodes,
  };
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href) {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => { data += d; });
  process.stdin.on("end", () => console.log(JSON.stringify(summarizeEvents(data.split(/\r?\n/)), null, 2)));
}
