/**
 * Evidence reference authorization index (Phase 28).
 *
 * Pure, deterministic, no I/O. Given the SAME context, operationalHistory and retrieved-knowledge chunk ids
 * Node already built and sent to the AI service (see operationalContextService.js / knowledgeRetrievalService.js
 * - unchanged), this builds the set of references the model's analysis is allowed to cite as evidence.
 *
 * This is the backend control behind the evidence contract: a reference the model invents that is not in this
 * index is a fabrication, never something we "helpfully" try to resolve. There is no database lookup here -
 * only a membership check against data Node already has in hand from the request it itself assembled.
 */

/** @returns {{operational: Map<string, Set<string>>, historical: {prior_ai_analysis: Set<string>, human_reviewed_decision: Set<string>}, knowledge: Set<string>}} */
export function buildEvidenceReferenceIndex(context, operationalHistory, knowledgeChunkIds) {
  const operational = new Map([
    ["signal", new Set(context?.signal?.id ? [context.signal.id] : [])],
    ["property", new Set(context?.property?.available ? [context.property.id] : [])],
    ["unit", new Set(context?.unit?.available ? [context.unit.id] : [])],
    ["guest", new Set(context?.guest?.available ? [context.guest.id] : [])],
    ["stay", new Set(context?.stay?.available ? [context.stay.id] : [])],
    ["historySignal", new Set((context?.history?.signals || []).map((s) => s.id))],
  ]);

  const historical = {
    prior_ai_analysis: new Set((operationalHistory?.intelligence || []).map((h) => h.signalId)),
    human_reviewed_decision: new Set((operationalHistory?.decisions || []).map((h) => h.signalId)),
  };

  const knowledge = new Set(knowledgeChunkIds || []);

  return { operational, historical, knowledge };
}

/** True only when `ref`'s shape-appropriate identifier is actually present in `index`. Never partial credit. */
export function evidenceRefIsAuthorized(ref, index) {
  if (!ref || typeof ref !== "object") return false;
  if (ref.type === "operational") return index.operational.get(ref.field)?.has(ref.refId) ?? false;
  if (ref.type === "historical") return index.historical[ref.kind]?.has(ref.signalId) ?? false;
  if (ref.type === "knowledge") return index.knowledge.has(ref.chunkId);
  return false;
}
