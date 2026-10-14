/**
 * Registry of named corpus profiles.
 *
 * A profile binds a reviewed section mapping (corpusClassification.js) and a
 * default visibility to an explicit identity - `KnowledgeDocument.corpusProfile`
 * - that is set when the document is created/uploaded. Chunking then applies
 * the profile automatically, so nobody has to remember to pass a classifier.
 *
 * The identity is deliberately NOT derived from a filename, title, or any
 * content pattern: those are editable, guessable, and shared by unrelated
 * documents. A document without a `corpusProfile` gets no classification at
 * all (every chunk at the document's own default visibility), and a profile
 * that names an unregistered id is refused rather than ignored.
 *
 * Safety of a wrongly-tagged document: a profile's mapping fails closed, so a
 * section it does not recognise is held back (never stored), never exposed.
 */
import { createChunkClassifier } from "./corpusClassification.js";
import { KOLAM_GANDHI_V2_MAPPING } from "./mappings/kolamGandhiV2.js";

export const CORPUS_PROFILES = Object.freeze({
  "kolam-gandhi-v2": Object.freeze({
    id: "kolam-gandhi-v2",
    description: "Kolam Gandhi SOP v2 - Business Knowledge (approved section classification).",
    defaultVisibility: "staff",
    mapping: KOLAM_GANDHI_V2_MAPPING,
  }),
});

/** The registered profile for an id, or undefined (own keys only - never a prototype property). */
export function getCorpusProfile(id) {
  return typeof id === "string" && Object.prototype.hasOwnProperty.call(CORPUS_PROFILES, id)
    ? CORPUS_PROFILES[id]
    : undefined;
}

/** A `classify(piece)` function for a registered profile, or null for an unknown/absent id. */
export function classifierForProfile(id) {
  const profile = getCorpusProfile(id);
  return profile ? createChunkClassifier(profile.mapping) : null;
}
