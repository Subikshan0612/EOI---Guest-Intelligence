import { Conversation } from "../models/Conversation.js";
import { Guest } from "../models/Guest.js";
import { ACTION_TYPES } from "../models/Action.js";
import { ANALYSIS_VERSION, Intelligence, SAFETY_RULE_CODES, SAFETY_STATES } from "../models/Intelligence.js";
import { Signal } from "../models/Signal.js";
import { Stay } from "../models/Stay.js";
import { Workspace } from "../models/Workspace.js";
import { AppError } from "../utils/AppError.js";
import { allowedVisibilities, canAccess } from "./knowledge/visibility.js";
import { URGENCY_LEVELS } from "./ai/safetyPolicy.js";
import { parseObjectId, requireObjectId } from "../utils/objectId.js";
import { parsePagination, parseSort } from "../utils/pagination.js";
import { knowledgeTitles, sanitizeAnalysisProse, sanitizeContradictions, sanitizeProse } from "./ai/proseReferenceSanitizer.js";
import {
  assertExists,
  assertSameWorkspace,
  findByIdOr404,
  findInWorkspaceOr404,
  paginateQuery,
  requireFields,
  toPlain,
} from "./queryHelpers.js";

async function validateIntelligenceRefs(workspaceId, refs) {
  if (refs.conversationId) {
    const conversation = await findByIdOr404(Conversation, refs.conversationId, "Conversation");
    assertSameWorkspace(conversation, workspaceId, "Conversation");
  }
  if (refs.guestId) {
    const guest = await findByIdOr404(Guest, refs.guestId, "Guest");
    assertSameWorkspace(guest, workspaceId, "Guest");
  }
  if (refs.stayId) {
    const stay = await findByIdOr404(Stay, refs.stayId, "Stay");
    assertSameWorkspace(stay, workspaceId, "Stay");
  }
  if (Array.isArray(refs.signalIds) && refs.signalIds.length > 0) {
    const signals = await Signal.find({ _id: { $in: refs.signalIds } });
    if (signals.length !== refs.signalIds.length) {
      throw new AppError("One or more signals were not found", 404);
    }
    for (const signal of signals) {
      assertSameWorkspace(signal, workspaceId, "Signal");
    }
  }
}

/**
 * RETIRED FROM HTTP (Phase 14): there is no POST /api/intelligence route any more. A caller must not be
 * able to store arbitrary Intelligence; Intelligence comes only from the grounded generation paths
 * (analyzeSignal / generateSignalIntelligence). This function remains ONLY as an in-process fixture
 * factory for the validation suites; nothing in the application calls it.
 */
export async function createIntelligence(body) {
  requireFields(body, ["workspaceId"]);
  const workspaceId = requireObjectId(body.workspaceId, "workspaceId");
  await assertExists(Workspace, workspaceId, "Workspace");

  const conversationId = parseObjectId(body.conversationId, "conversationId");
  const guestId = parseObjectId(body.guestId, "guestId");
  const stayId = parseObjectId(body.stayId, "stayId");
  const signalIds = Array.isArray(body.signalIds)
    ? body.signalIds.map((id, index) => requireObjectId(id, `signalIds[${index}]`))
    : [];

  await validateIntelligenceRefs(workspaceId, { conversationId, guestId, stayId, signalIds });

  if (body.confidence !== undefined) {
    const confidence = Number(body.confidence);
    if (Number.isNaN(confidence) || confidence < 0 || confidence > 1) {
      throw new AppError("confidence must be a number between 0 and 1", 400);
    }
  }

  const intelligence = await Intelligence.create({
    workspaceId,
    conversationId,
    guestId,
    stayId,
    signalIds,
    signal: body.signal,
    context: body.context,
    intelligence: body.intelligence,
    risk: body.risk,
    decision: body.decision,
    action: body.action,
    outcome: body.outcome,
    confidence: body.confidence,
    generatedBy: body.generatedBy,
    model: body.model,
  });

  return toPlain(intelligence);
}

/**
 * Phase 7F-C — persists an already-validated, already-trusted AI-generated
 * Intelligence result. Formerly called by the retired legacy generator; now a persistence entry point used only by test fixtures,
 * after Node's own validateIntelligenceResult + provenance re-filtering has
 * already run — never with raw Python/Gemini output.
 *
 * Distinct from createIntelligence above (the Phase-2 CRUD entry point for
 * manually-created records, reached via POST /api/intelligence with an
 * arbitrary request body): this function takes trusted, already-shaped
 * arguments, not a request body, and performs no body-shaped field
 * validation of its own — every value it receives has already been proven
 * to belong to the caller's own workspace by the AI generation pipeline
 * (assembleSignalContext's workspace-scoped Guest/Stay/Signal lookups), so
 * re-validating those references here would be redundant, not safer.
 *
 * generatedBy is always "llm" here — this is how a persisted record is
 * distinguished from a manually-created one (createIntelligence defaults to
 * "system" unless a caller overrides it).
 */
export async function createGeneratedIntelligence({
  workspaceId,
  signalId,
  guestId,
  stayId,
  signal,
  result,
  provider,
  model,
  knowledgeVisibility,
}) {
  const intelligence = await Intelligence.create({
    workspaceId,
    signalIds: signalId ? [signalId] : [],
    guestId,
    stayId,
    signal,
    intelligence: { summary: result.summary, findings: result.findings },
    risk: result.risk,
    decision: { recommendation: result.decision.recommendation, rationale: result.decision.rationale },
    action: { label: result.action.label, recommended: result.action.recommended },
    outcome: { expected: result.outcome.expected },
    confidence: result.confidence,
    generatedBy: "llm",
    provider,
    model,
    knowledgeProvenance: result.knowledgeProvenance?.length ? result.knowledgeProvenance : undefined,
    knowledgeVisibility,
  });

  return toPlain(intelligence);
}

/**
 * Intelligence V1 - persists an already-validated analysis. Called only from
 * intelligenceAnalysisService.js, after the LLM output has been validated and
 * every provenance chunk checked against the retrieved set; the LLM itself
 * never persists anything. Legacy fields are filled ONLY by deterministic
 * mapping from facts (never from a guess): risk.level is the Signal's own
 * recorded severity. The numeric legacy `confidence` is deliberately left
 * unset - V1 confidence is the enum in `analysis.confidence`.
 *
 * Idempotent per (workspace, Signal, level): the partial unique index makes a
 * concurrent duplicate fail with a duplicate-key error, which is resolved to
 * the existing record instead of creating a second one.
 */
export async function createAnalysisIntelligence({
  workspaceId, signal, guestId, stayId, propertyId, level, analysis, provider, model, knowledgeProvenance, knowledgeVisibility,
  evidenceRefs, contradictions, safety,
}) {
  // Phase 53D - the server-side prose boundary: the admitted analysis's human-readable prose is stored WITHOUT the internal evidence references / record ids the model repeated in it. Runs after every
  // validator (nothing they read is changed); the structured evidenceRefs, contradictions' evidenceRefs and knowledge provenance below are passed through untouched.
  analysis = sanitizeAnalysisProse(analysis, knowledgeProvenance);
  contradictions = sanitizeContradictions(contradictions, knowledgeProvenance);
  try {
    const intelligence = await Intelligence.create({
      workspaceId,
      signalIds: [signal.id],
      propertyId,
      guestId,
      stayId,
      signal: { summary: signal.title, type: signal.type, severity: signal.severity },
      intelligence: { summary: analysis.situation, findings: analysis.evidence, operationalImpact: analysis.impact },
      risk: { level: signal.severity, reason: `Signal severity is recorded as '${signal.severity}'.` },
      decision: { recommendation: analysis.recommendation },
      generatedBy: "llm",
      provider,
      model,
      analysis: {
        situation: analysis.situation,
        evidence: analysis.evidence,
        impact: analysis.impact,
        recommendation: analysis.recommendation,
        confidence: analysis.confidence,
      },
      analysisVersion: ANALYSIS_VERSION,
      analysisLevel: level,
      knowledgeProvenance: knowledgeProvenance?.length ? knowledgeProvenance : undefined,
      knowledgeVisibility,
      // Phase 43B.1: the safety result Node validated for THIS analysis (see the model). Absent when the caller supplied none; never fabricated.
      safety: safety?.state ? { state: safety.state, urgency: safety.urgency, recommendedActionType: safety.recommendedActionType, rules: Array.isArray(safety.rules) && safety.rules.length ? safety.rules.filter((r) => SAFETY_RULE_CODES.includes(r)) : undefined } : undefined,
      // Phase 28: additive, absent (never an empty array) when there was nothing to report - matches the
      // existing knowledgeProvenance convention just above.
      evidenceRefs: evidenceRefs?.length ? evidenceRefs : undefined,
      contradictions: contradictions?.length ? contradictions : undefined,
    });
    return { record: toPlain(intelligence), created: true };
  } catch (error) {
    if (error?.code === 11000 || error?.code === 11001) {
      const existing = await findAnalysisIntelligence(workspaceId, signal.id, level);
      if (existing) return { record: existing, created: false };
    }
    throw error;
  }
}

/** The V1 analysis already stored for this (workspace, Signal, level), or null. */
export async function findAnalysisIntelligence(workspaceId, signalId, level) {
  const existing = await Intelligence.findOne({
    workspaceId,
    signalIds: signalId,
    analysisVersion: ANALYSIS_VERSION,
    analysisLevel: level,
  });
  return existing ? toPlain(existing) : null;
}

/**
 * The ONLY public shape of a raw Intelligence record (GET /api/intelligence[/:id]). A whitelist, never
 * the stored document: it omits provider, model, guest/stay ids and the internal parts of the knowledge
 * provenance (document id, version, scope, chunk index, similarity score). The V1 analysis is shown as the
 * dashboard shows it (situation, evidence, impact, recommendation, confidence, analysisVersion,
 * analysisLevel, knowledgeVisibility) with the SAME limited provenance (chunk id, section, section path,
 * visibility, retrieval score) - never chunk text or embeddings. Legacy (pre-V1) content blocks are kept,
 * since they ARE the record's content.
 */
/** Phase 28: the public shape of one evidence reference - only the fields its `type` actually carries. */
function mapEvidenceRefView(ref) {
  return {
    type: ref.type,
    field: ref.field,
    refId: ref.refId,
    kind: ref.kind,
    signalId: ref.signalId,
    chunkId: ref.chunkId,
  };
}

/**
 * Phase 43B.1: the public shape of the stored safety result, or `undefined` when there is none. A record written before this phase has none, and
 * "no safety result recorded" is NOT "normal": it stays absent. Read-time guard: a lean read does not run schema validation, so a value outside
 * the known enums (corruption, a future writer) is omitted rather than reinterpreted - a state outside the closed set drops the whole object.
 */
export function toSafetyView(safety) {
  if (!safety || !SAFETY_STATES.includes(safety.state)) return undefined;
  return {
    state: safety.state,
    urgency: URGENCY_LEVELS.includes(safety.urgency) ? safety.urgency : undefined,
    recommendedActionType: ACTION_TYPES.includes(safety.recommendedActionType) ? safety.recommendedActionType : undefined,
    // The policy rule codes the server recorded (a closed list; anything else is dropped). Absent when none was recorded.
    rules: Array.isArray(safety.rules) && safety.rules.some((r) => SAFETY_RULE_CODES.includes(r)) ? safety.rules.filter((r) => SAFETY_RULE_CODES.includes(r)) : undefined,
  };
}

/** The mirror of the analysis prose kept in the legacy `intelligence` block (summary, findings, operationalImpact): the same boundary applies; any other block is returned as it is. */
function sanitizeLegacyBlock(block, provenance) {
  if (!block || typeof block !== "object") return block;
  const options = { titles: knowledgeTitles(provenance) };
  return { ...block, summary: sanitizeProse(block.summary, options), findings: Array.isArray(block.findings) ? block.findings.map((item) => sanitizeProse(item, options)) : block.findings, operationalImpact: sanitizeProse(block.operationalImpact, options) };
}

export function toIntelligenceView(record) {
  if (!record) return null;
  const idOrUndefined = (value) => (value ? String(value) : undefined);
  return {
    _id: String(record._id),
    workspaceId: String(record.workspaceId),
    signalIds: (record.signalIds || []).map(String),
    propertyId: idOrUndefined(record.propertyId),
    conversationId: idOrUndefined(record.conversationId),
    generatedBy: record.generatedBy,
    analysisVersion: record.analysisVersion,
    analysisLevel: record.analysisLevel,
    knowledgeVisibility: record.knowledgeVisibility,
    // Phase 53D: read-time guarantee for records stored before the persistence boundary existed - the API never returns an internal reference in AI prose (a record without one is returned unchanged).
    analysis: record.analysis
      ? {
          ...sanitizeAnalysisProse({ situation: record.analysis.situation, evidence: [...(record.analysis.evidence || [])], impact: record.analysis.impact, recommendation: record.analysis.recommendation }, record.knowledgeProvenance),
          confidence: record.analysis.confidence,
        }
      : undefined,
    safety: toSafetyView(record.safety),
    knowledgeProvenance: record.knowledgeProvenance
      ? record.knowledgeProvenance.map((p) => ({
          chunkId: p.chunkId,
          section: p.section,
          sectionPath: p.sectionPath ? [...p.sectionPath] : undefined,
          visibility: p.visibility,
          retrievalScore: p.retrievalScore,
        }))
      : undefined,
    // Phase 28: the same structural references already validated against the context/operationalHistory/
    // knowledge this analysis was given (analysisSchema.js) - no field here carries anything beyond what
    // already crosses this boundary elsewhere (a signal/guest/stay/property/unit id, a related-signal id, or
    // a knowledge chunk id already exposed via knowledgeProvenance above).
    evidenceRefs: record.evidenceRefs ? record.evidenceRefs.map(mapEvidenceRefView) : undefined,
    contradictions: record.contradictions
      ? record.contradictions.map((c) => ({
          type: c.type,
          description: sanitizeProse(c.description, { titles: knowledgeTitles(record.knowledgeProvenance) }),
          evidenceRefs: (c.evidenceRefs || []).map(mapEvidenceRefView),
        }))
      : undefined,
    signal: record.signal,
    context: record.context,
    intelligence: sanitizeLegacyBlock(record.intelligence, record.knowledgeProvenance),
    risk: record.risk,
    decision: record.decision && typeof record.decision === "object" ? { ...record.decision, recommendation: sanitizeProse(record.decision.recommendation, { titles: knowledgeTitles(record.knowledgeProvenance) }) } : record.decision,
    action: record.action,
    outcome: record.outcome,
    confidence: record.confidence,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** Mongo filter: a V1 analysis is visible only at or below its own analysisLevel (records without one are pre-V1). */
function analysisLevelFilter(authorizedLevel) {
  return {
    $or: [{ analysisLevel: { $exists: false } }, { analysisLevel: null }, { analysisLevel: { $in: allowedVisibilities(authorizedLevel) } }],
  };
}

export async function listIntelligence(query, authorizedLevel) {
  const workspaceId = requireObjectId(query.workspaceId, "workspaceId");
  const pagination = parsePagination(query);
  const sort = parseSort(query, ["createdAt", "updatedAt"], { createdAt: -1 });
  const filter = {
    workspaceId,
    // Hide records derived from knowledge above the caller's level. A record
    // with no knowledgeVisibility used no knowledge, so `null` (which also
    // matches an absent field) stays visible.
    knowledgeVisibility: { $in: [...allowedVisibilities(authorizedLevel), null] },
    ...analysisLevelFilter(authorizedLevel),
  };

  if (query.conversationId) {
    filter.conversationId = parseObjectId(query.conversationId, "conversationId");
  }
  if (query.guestId) filter.guestId = parseObjectId(query.guestId, "guestId");
  if (query.stayId) filter.stayId = parseObjectId(query.stayId, "stayId");
  if (query.signalId) filter.signalIds = parseObjectId(query.signalId, "signalId");

  const { items, pagination: page } = await paginateQuery(Intelligence, filter, pagination, sort);
  return { items: items.map(toIntelligenceView), pagination: page };
}

export async function getIntelligenceById(id, workspaceId, authorizedLevel) {
  const scope = requireObjectId(workspaceId, "workspaceId");
  const record = await findInWorkspaceOr404(Intelligence, requireObjectId(id), scope, "Intelligence");
  // Same 404 as a missing record: a record derived from higher-visibility
  // knowledge (its content and provenance) is not revealed to a lower caller.
  if (record.knowledgeVisibility && !canAccess(authorizedLevel, record.knowledgeVisibility)) {
    throw new AppError("Intelligence not found", 404);
  }
  // A V1 analysis is also gated by the level it was produced at (as the dashboard does), even when it
  // used no knowledge and so carries no knowledgeVisibility.
  if (record.analysisLevel && !canAccess(authorizedLevel, record.analysisLevel)) {
    throw new AppError("Intelligence not found", 404);
  }
  return toIntelligenceView(toPlain(record));
}
