import { createHash } from "node:crypto";

/**
 * Compact, deterministic audit metadata for one admission decision (Phase 35). PURE: no I/O, no environment, no model call.
 *
 * It is built only from objects Node already holds for the request (the evidence envelope, the retrieved knowledge, the validated
 * claims). It produces identifiers and COUNTS - never claim text, evidence text, prompts, raw output or reference ids - so the audit
 * record is a second copy of nothing sensitive and cannot become a cross-tenant information channel.
 */

const increment = (counts, key) => {
  counts[key] = (counts[key] ?? 0) + 1;
};

/** `{ [key]: count }` of `items.map(pick)`, skipping falsy keys. Keys are the closed vocabularies of this pipeline (claim types, evidence classes). */
export function countBy(items, pick) {
  const counts = {};
  for (const item of Array.isArray(items) ? items : []) {
    const key = pick(item);
    if (typeof key === "string" && key) increment(counts, key);
  }
  return counts;
}

/**
 * Deterministic identifier of the exact evidence set a request offered the model: SHA-256 over the sorted `ref|class` lines of the
 * envelope plus the sorted `chunkId@version` of the retrieved knowledge. Two requests with the same evidence get the same id; a
 * changed chunk version, an added history item or a different workspace record changes it. The workspace id is mixed in so the
 * same ids in two workspaces can never collide into one identifier (and an id is never comparable across tenants).
 * The hash is one-way: the references themselves are not recoverable from it.
 */
export function evidenceSetId(envelope, knowledge, workspaceId) {
  const lines = envelope.catalog().map(({ ref, evidenceClass }) => `${ref}|${evidenceClass}`).sort();
  const chunks = (Array.isArray(knowledge) ? knowledge : []).map((chunk) => `${chunk?.chunkId}@${chunk?.version ?? "?"}`).sort();
  return createHash("sha256").update(JSON.stringify({ workspaceId: String(workspaceId), lines, chunks })).digest("hex");
}

/** How many references the envelope holds per evidence class. */
export function evidenceCounts(envelope) {
  return countBy(envelope.catalog(), (entry) => entry.evidenceClass);
}

/** How many claim source references fall in each evidence class (unknown references are not counted: claim validation rejects them first). */
export function citedClassCounts(claims, envelope) {
  const counts = {};
  for (const claim of Array.isArray(claims) ? claims : []) {
    for (const ref of Array.isArray(claim?.sourceRefs) ? claim.sourceRefs : []) {
      const evidenceClass = envelope.classOf(ref);
      if (evidenceClass) increment(counts, evidenceClass);
    }
  }
  return counts;
}

/** How many retrieved chunks have the finite, floor-meeting `similarityScore` the confidence policy requires of a grounding chunk. */
export function relevantKnowledgeCount(knowledge, floor) {
  return (Array.isArray(knowledge) ? knowledge : []).filter((chunk) => Number.isFinite(chunk?.similarityScore) && chunk.similarityScore >= floor).length;
}

/** A bounded, printable rendering of an untrusted identity string (the AI service's self-report). */
export function boundedIdentity(value, limit = 64) {
  return typeof value === "string" ? value.replace(/[^\x20-\x7e]/g, "?").slice(0, limit) : undefined;
}
