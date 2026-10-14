/**
 * Deterministic evidence envelope (Phase 34C).
 *
 * Node owns facts, provenance, trust and tenant boundaries; Gemini interprets and recommends; Node then decides whether
 * what Gemini returned is ADMISSIBLE. This module is the "Node owns facts, provenance and trust" half: for ONE request it
 * classifies every item the model may cite and records, outside any prompt, how much authority that class carries.
 *
 * Pure: no I/O, no database. It is built only from the objects intelligenceAnalysisService.js already assembled for this
 * request from workspace-verified data (context, operationalHistory, knowledge, optional Learning), so an item that is not
 * in this request's data does not exist here - a reference to another workspace's record is simply UNKNOWN.
 *
 * The model never decides whether a source is trusted and never creates a reference: references are minted here (and
 * mirrored, display-only, by ai-service/app/services/evidence_envelope.py so the prompt can list them; a parity fixture is
 * checked by both test suites). Whatever the model returns is validated against THIS envelope, never against the mirror.
 *
 * Authority, highest first (rank 1..5):
 *   CURRENT_OPERATIONAL_FACT   the recorded Signal and its resolved Property / Unit / Guest / Stay. Establishes current state.
 *   BUSINESS_KNOWLEDGE         approved, authorized guidance. Never establishes current state.
 *   OPERATIONAL_HISTORY        earlier related Signals, prior AI analyses, reviewed decisions. Context only.
 *   LEARNING_CONTEXT           aggregate outcome statistics (only when the Learning flag is on). Advisory only.
 *   UNTRUSTED_SIGNAL           the free text typed into the Signal. Potentially adversarial. Lowest authority.
 *
 * Reference scheme:
 *   current:signal:<id>  current:property:<id>  current:unit:<id>  current:guest:<id>  current:stay:<id>
 *   untrusted:signal:<id>
 *   history:signal:<id>  history:analysis:<signalId>  history:decision:<signalId>
 *   knowledge:<chunkId>
 *   learning:<actionType>
 */
export const CURRENT_OPERATIONAL_FACT = "CURRENT_OPERATIONAL_FACT";
export const BUSINESS_KNOWLEDGE = "BUSINESS_KNOWLEDGE";
export const OPERATIONAL_HISTORY = "OPERATIONAL_HISTORY";
export const LEARNING_CONTEXT = "LEARNING_CONTEXT";
export const UNTRUSTED_SIGNAL = "UNTRUSTED_SIGNAL";

/** What each class IS, as data - the hierarchy is enforced from this table, not from prompt wording. */
export const EVIDENCE_CLASSES = Object.freeze({
  [CURRENT_OPERATIONAL_FACT]: Object.freeze({ rank: 1, establishesCurrentState: true, historical: false, advisory: false, untrusted: false }),
  [BUSINESS_KNOWLEDGE]: Object.freeze({ rank: 2, establishesCurrentState: false, historical: false, advisory: false, untrusted: false }),
  [OPERATIONAL_HISTORY]: Object.freeze({ rank: 3, establishesCurrentState: false, historical: true, advisory: false, untrusted: false }),
  [LEARNING_CONTEXT]: Object.freeze({ rank: 4, establishesCurrentState: false, historical: false, advisory: true, untrusted: false }),
  [UNTRUSTED_SIGNAL]: Object.freeze({ rank: 5, establishesCurrentState: false, historical: false, advisory: false, untrusted: true }),
});

/** Highest authority first. Mirrors EVIDENCE_PRECEDENCE in ai-service/app/services/evidence_envelope.py. */
export const EVIDENCE_PRECEDENCE = Object.freeze(Object.keys(EVIDENCE_CLASSES).sort((a, b) => EVIDENCE_CLASSES[a].rank - EVIDENCE_CLASSES[b].rank));

const isClass = (name) => typeof name === "string" && Object.prototype.hasOwnProperty.call(EVIDENCE_CLASSES, name);

/** Rank of a class (1 = most authoritative). An unknown class is a programming error, never a default. */
export function authorityRank(evidenceClass) {
  if (!isClass(evidenceClass)) throw new TypeError(`Unknown evidence class: ${String(evidenceClass)}`);
  return EVIDENCE_CLASSES[evidenceClass].rank;
}

/** The class that prevails when two disagree: the one with the lower rank. Equal classes return that class. */
export function higherAuthority(a, b) {
  return authorityRank(a) <= authorityRank(b) ? a : b;
}

/** True only when `a` is STRICTLY more authoritative than `b`. */
export function outranks(a, b) {
  return authorityRank(a) < authorityRank(b);
}

// An id that cannot be quoted safely inside a reference is skipped, never reshaped. Real ids are ObjectIds.
const SAFE_ID = /^[A-Za-z0-9_.-]{1,64}$/;
const OBJECT_ID_TOKEN = /\b[0-9a-f]{24}\b/gi;

function mint(prefix, id) {
  return typeof id === "string" && SAFE_ID.test(id) ? `${prefix}:${id}` : null;
}

/**
 * @param {object} input
 * @param {string} input.workspaceId   the membership-verified workspace this request belongs to
 * @param {object} input.context       the bounded operational context sent to the model
 * @param {object} [input.operationalHistory]
 * @param {object[]} [input.knowledge] retrieved, authorized chunks ({chunkId, text, ...})
 * @param {object} [input.learning]    the Learning context, only when the flag is on (undefined otherwise)
 * @returns an immutable envelope bound to `workspaceId`
 */
export function buildEvidenceEnvelope({ workspaceId, context, operationalHistory, knowledge = [], learning } = {}) {
  if (typeof workspaceId !== "string" || workspaceId.trim() === "") throw new TypeError("An evidence envelope requires the verified workspaceId");
  const workspace = String(workspaceId);
  const items = new Map();

  const add = (ref, evidenceClass) => {
    if (!ref || items.has(ref)) return;
    items.set(ref, Object.freeze({ ref, evidenceClass, ...EVIDENCE_CLASSES[evidenceClass], workspaceId: workspace }));
  };

  add(mint("current:signal", context?.signal?.id), CURRENT_OPERATIONAL_FACT);
  for (const [prefix, record] of [["current:property", context?.property], ["current:unit", context?.unit], ["current:guest", context?.guest], ["current:stay", context?.stay]]) {
    if (record?.available) add(mint(prefix, record.id), CURRENT_OPERATIONAL_FACT);
  }
  add(mint("untrusted:signal", context?.signal?.id), UNTRUSTED_SIGNAL);
  for (const related of context?.history?.signals || []) add(mint("history:signal", related?.id), OPERATIONAL_HISTORY);
  for (const prior of operationalHistory?.intelligence || []) add(mint("history:analysis", prior?.signalId), OPERATIONAL_HISTORY);
  for (const decision of operationalHistory?.decisions || []) add(mint("history:decision", decision?.signalId), OPERATIONAL_HISTORY);
  for (const chunk of knowledge) add(mint("knowledge", chunk?.chunkId), BUSINESS_KNOWLEDGE);
  for (const pattern of learning?.patterns || []) add(mint("learning", pattern?.actionType), LEARNING_CONTEXT);

  // Every 24-hex identifier the model was actually shown. Anything of that shape in its output that is NOT in this set was
  // never supplied for this request (another record, another workspace, or invented): see outputGuard.js.
  const shown = JSON.stringify({
    context,
    operationalHistory,
    knowledge: knowledge.map((k) => ({ chunkId: k?.chunkId, section: k?.section, text: k?.text })),
  });
  const suppliedIds = new Set((shown.match(OBJECT_ID_TOKEN) || []).map((token) => token.toLowerCase()));

  return Object.freeze({
    workspaceId: workspace,
    items,
    suppliedIds,
    has: (ref) => typeof ref === "string" && items.has(ref),
    get: (ref) => (typeof ref === "string" ? items.get(ref) : undefined),
    classOf: (ref) => (typeof ref === "string" ? items.get(ref)?.evidenceClass : undefined),
    refsOfClass: (evidenceClass) => [...items.values()].filter((item) => item.evidenceClass === evidenceClass).map((item) => item.ref),
    /** The ordered {ref, evidenceClass} list - exactly what the prompt lists for the model. */
    catalog: () => [...items.values()].map(({ ref, evidenceClass }) => ({ ref, evidenceClass })),
    get size() {
      return items.size;
    },
  });
}
