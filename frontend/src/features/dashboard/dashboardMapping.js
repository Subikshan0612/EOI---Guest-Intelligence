import { SIGNAL_SEVERITIES, SIGNAL_STATUSES, SIGNAL_TYPES, formatStatusLabel } from "../operations/operationsMapping";
import { presentAnalysisProse, presentText } from "../intelligence/presentation";
import { mapSafety } from "../intelligence/safetyMapping";

/**
 * Translation between the dashboard read-model responses
 * (`GET /dashboard/signals[/:id]`) and what the UI renders. The backend
 * already whitelists these shapes (no guest name/email/phone, no reservation
 * id, no provider/model/prompt), so this only normalises values and keeps
 * three concepts apart: recorded facts (`observed`), stored AI interpretation
 * (`intelligence`) and retrieval provenance. Nothing here is inferred.
 */

export { SIGNAL_SEVERITIES, SIGNAL_STATUSES, SIGNAL_TYPES, formatStatusLabel };

export const CONFIDENCE_LEVELS = {
  high: { label: "High", explanation: "Strongly supported by the available evidence." },
  medium: {
    label: "Medium",
    explanation: "Grounded, but material facts may be unavailable or ambiguous.",
  },
  low: { label: "Low", explanation: "Evidence is limited." },
};

export function confidenceInfo(confidence) {
  return CONFIDENCE_LEVELS[confidence] || null;
}

export function formatLabel(value) {
  if (!value) return "";
  const text = formatStatusLabel(String(value));
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function mapProperty(p) {
  return p ? { id: p.id, code: p.code || "", name: p.name || "" } : null;
}

function mapUnit(u) {
  return u ? { id: u.id, unitNumber: u.unitNumber || "" } : null;
}

function mapStay(s) {
  return s ? { status: s.status || "", checkIn: s.checkIn || null, checkOut: s.checkOut || null } : null;
}

export function mapDashboardSignalItem(item) {
  const intel = item.intelligence;
  return {
    id: item.id,
    title: item.title,
    type: item.type,
    severity: item.severity,
    status: item.status,
    source: item.source,
    occurredAt: item.occurredAt,
    description: item.description || "",
    synthetic: Boolean(item.synthetic),
    property: mapProperty(item.property),
    unit: mapUnit(item.unit),
    stay: mapStay(item.stay),
    hasGuest: Boolean(item.hasGuest),
    analysis: intel
      ? {
          id: intel.id,
          confidence: intel.confidence,
          createdAt: intel.createdAt,
          evidenceCount: intel.evidenceCount ?? 0,
        }
      : null,
  };
}

export function mapDashboardDetail(data) {
  const { signal, observed, intelligence } = data;
  return {
    signal: {
      id: signal.id,
      title: signal.title,
      type: signal.type,
      severity: signal.severity,
      status: signal.status,
      source: signal.source,
      occurredAt: signal.occurredAt,
      description: signal.description || "",
      synthetic: Boolean(signal.synthetic),
    },
    observed: {
      property: mapProperty(observed?.property),
      unit: mapUnit(observed?.unit),
      stay: mapStay(observed?.stay),
      hasGuest: Boolean(observed?.hasGuest),
    },
    analysis: intelligence ? mapStoredAnalysis(intelligence) : null,
  };
}

/** Phase 43A: the stored prose may repeat internal evidence references; the dashboard shows natural language (presentation only, see presentation.js). */
function mapStoredAnalysis(intelligence) {
  const provenance = (intelligence.knowledgeProvenance || []).map((p) => ({
    chunkId: p.chunkId,
    section: p.section || "",
    sectionPath: Array.isArray(p.sectionPath) ? p.sectionPath : [],
    visibility: p.visibility || "",
    retrievalScore: typeof p.retrievalScore === "number" ? p.retrievalScore : null,
  }));
  return {
    id: intelligence.id,
    ...presentAnalysisProse(
      {
        situation: intelligence.situation || "",
        evidence: Array.isArray(intelligence.evidence) ? intelligence.evidence : [],
        impact: intelligence.impact || "",
        recommendation: intelligence.recommendation || "",
      },
      provenance,
    ),
    confidence: intelligence.confidence,
    safety: mapSafety(intelligence.safety), // Phase 43B.1: carried unchanged; null = not recorded (not "normal")
    createdAt: intelligence.createdAt,
    provenance,
  };
}

/** Empty filter values are omitted from the request. */
export function toDashboardParams(filters, page, limit) {
  const params = { page, limit };
  for (const key of ["propertyId", "status", "severity", "type", "hasIntelligence"]) {
    if (filters[key]) params[key] = filters[key];
  }
  return params;
}

export const EMPTY_FILTERS = {
  propertyId: "",
  status: "",
  severity: "",
  type: "",
  hasIntelligence: "",
};

export function hasActiveFilters(filters) {
  return Object.values(filters).some(Boolean);
}

/* ---------------------------------------------------------------------- *
 * Decision V1 (read-only). A Decision is a PROPOSAL; approval is not action.
 * Only records marked decision-v1 are shown; anything else the API returns
 * (legacy Decisions) is ignored, never reinterpreted.
 * ---------------------------------------------------------------------- */

export const DECISION_STATUS_LABELS = { proposed: "Proposed", approved: "Approved", rejected: "Rejected" };

export function mapDecisionV1(view) {
  if (!view || view.decisionVersion !== "decision-v1") return null;
  if (!Object.prototype.hasOwnProperty.call(DECISION_STATUS_LABELS, view.status)) return null;
  return {
    id: view._id,
    intelligenceId: view.intelligenceId,
    status: view.status,
    priority: view.priority,
    confidence: view.confidence,
    // The Decision's description is a snapshot of the stored recommendation, so it can carry the same internal references (Phase 43A: presentation only).
    description: presentText(view.description || ""),
    reviewedAt: view.review?.reviewedAt || null,
    reviewNote: view.review?.reviewNote || null,
  };
}

/**
 * What the dashboard may honestly say about the Decision for one Intelligence.
 *   na          - no stored Intelligence, so no Decision concept applies
 *   loading     - not known yet
 *   unavailable - the Decision read failed or was incomplete: never claim "not proposed".
 *                 `reason` says why when known: "unauthenticated" | "forbidden" | "error"
 *   none        - the read succeeded and there is no Decision V1
 *   found       - { decision }
 */
export function resolveDecision(source, intelligenceId) {
  if (!intelligenceId) return { state: "na" };
  if (source.status === "loading") return { state: "loading" };
  if (source.status !== "ready") return { state: "unavailable", reason: source.status };
  const decision = source.byIntelligenceId.get(String(intelligenceId));
  if (decision) return { state: "found", decision };
  return source.partial ? { state: "unavailable" } : { state: "none" };
}
