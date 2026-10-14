import { presentAnalysisProse } from "./presentation";
import { mapSafety } from "./safetyMapping";

/**
 * Translation between the public Intelligence V1 representation returned by
 * `POST /api/intelligence/analyze/:signalId` (identical to `GET /api/intelligence/:id`) and what the
 * Intelligence page renders. The backend already whitelists this shape - no provider/model, no guest or
 * stay ids, no internal knowledge ids or scores - so this only normalises values. It produces the same
 * `analysis` shape the dashboard's `mapDashboardDetail` produces, so the page reuses the dashboard's
 * AnalysisBlock / RecommendationBlock / ProvenanceList.
 */
export function mapIntelligenceAnalysis(view) {
  const analysis = view?.analysis;
  // A V1 analysis always has these text fields (the model requires them). A record that does not is malformed: it must fail loudly, never render as a blank analysis.
  if (!analysis || typeof analysis !== "object" || Array.isArray(analysis) || typeof analysis.situation !== "string" || typeof analysis.recommendation !== "string") {
    throw new Error("The server returned an unexpected intelligence response.");
  }
  const provenance = (view.knowledgeProvenance || []).map((p) => ({
    chunkId: p.chunkId,
    section: p.section || "",
    sectionPath: Array.isArray(p.sectionPath) ? p.sectionPath : [],
    visibility: p.visibility || "",
    retrievalScore: typeof p.retrievalScore === "number" ? p.retrievalScore : null,
  }));
  // Phase 43A: the model's prose may repeat internal evidence references. The server stores and returns the text as written (and keeps the references for
  // validation and provenance); the page shows natural language. Presentation only - see presentation.js.
  const prose = presentAnalysisProse(
    {
      situation: analysis.situation || "",
      evidence: Array.isArray(analysis.evidence) ? analysis.evidence : [],
      impact: analysis.impact || "",
      recommendation: analysis.recommendation || "",
    },
    provenance,
  );
  return {
    id: view._id,
    ...prose,
    confidence: analysis.confidence,
    safety: mapSafety(view.safety), // Phase 43B.1: the server-validated safety result, carried unchanged; null = not recorded (not "normal")
    createdAt: view.createdAt,
    provenance,
  };
}

// The knowledge levels, lowest to highest - the backend's visibility.js RANK (validate-phase43c-persisted-intelligence.mjs ties this table to it).
const LEVEL_RANK = Object.freeze({ guest: 0, staff: 1, restricted: 2 });
const V1 = "intelligence-v1";

/**
 * From the Intelligence records the server returned for ONE Signal, the stored V1 analysis to show - or null when there is none. The server has already
 * filtered the list to what this caller may see; this applies the dashboard read model's own tie-break (dashboardService.js pickVisibleAnalysis: only V1
 * records with a valid level, the highest level, then the newest, then the larger id), so the Intelligence page and the dashboard always show the same
 * analysis. Pre-V1 / legacy records are not analyses and are ignored. It only chooses; the chosen record is then mapped by mapIntelligenceAnalysis.
 */
export function selectStoredAnalysis(items) {
  if (!Array.isArray(items)) throw new Error("The server returned an unexpected intelligence response.");
  const candidates = items.filter(
    (record) => record && typeof record === "object" && record.analysisVersion === V1 && Object.prototype.hasOwnProperty.call(LEVEL_RANK, record.analysisLevel),
  );
  candidates.sort(
    (a, b) =>
      LEVEL_RANK[b.analysisLevel] - LEVEL_RANK[a.analysisLevel] ||
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() ||
      (String(b._id) < String(a._id) ? -1 : String(b._id) > String(a._id) ? 1 : 0),
  );
  return candidates[0] ?? null;
}
