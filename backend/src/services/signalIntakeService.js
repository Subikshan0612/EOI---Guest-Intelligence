import { Conversation } from "../models/Conversation.js";
import { Message } from "../models/Message.js";
import { Property } from "../models/Property.js";
import { Stay } from "../models/Stay.js";
import { Unit } from "../models/Unit.js";
import { AppError } from "../utils/AppError.js";
import { requireObjectId } from "../utils/objectId.js";
import { createServerMessage } from "./messageService.js";
import { findInWorkspaceOr404, toPlain } from "./queryHelpers.js";
import { createSignal } from "./signalService.js";
import { INTAKE_LIMITS, INTAKE_OUTCOME, interpretOperatorMessage, normalizeIntakeText } from "./signalInterpreter.js";

/**
 * Conversational Signal intake (Phase 47): ONE operator turn.
 *
 *   conversation -> signal -> context -> intelligence      (this module is only the FIRST arrow)
 *
 * The conversation is an operator interface, never a source of truth: the authoritative object is the Signal, created through the SAME `createSignal` the structured
 * form uses (so validation, workspace scoping and the stored shape are identical - there is no "chat signal" model). Context is assembled later by the existing
 * context endpoints and Intelligence only by the existing, explicit POST /api/intelligence/analyze/:signalId; this module calls no model and no AI service.
 *
 * AUTHORITY. The workspace is the caller's VERIFIED membership (the controller passes `req.actor.workspaceId`; a body field is only a selector that membership
 * already checked). The conversation is resolved INSIDE that workspace (another tenant's id is the same 404 as a missing one). Messages are written through the
 * server-owned path (assistant messages cannot be created by a browser). Permission (`operations:manage`) is enforced by the route. The text is untrusted data
 * (signalInterpreter.js).
 *
 * STATE. A clarification is remembered in the assistant message that asked it (`metadata.koiIntake.pendingText`, server-written, bounded). The next turn reads it
 * back only from that SERVER-owned message; a user-supplied message can never set it. Nothing is held in memory.
 */
const TITLE_MAX = 60;
const INTAKE_KEY = "koiIntake";

const conversationTitle = (text) => {
  const sentence = text.split(/(?<=[.!?])\s+|\n/).map((part) => part.trim()).find(Boolean) ?? text;
  return sentence.length > TITLE_MAX ? `${sentence.slice(0, TITLE_MAX - 1).trimEnd()}…` : sentence;
};

async function loadReference(workspaceId) {
  const properties = await Property.find({ workspaceId }).select("name code").sort({ name: 1 }).limit(INTAKE_LIMITS.propertiesMax).lean();
  // A Unit carries no workspaceId of its own: its scope is its Property's, so the query is bounded by THIS workspace's property ids.
  const units = properties.length === 0
    ? []
    : await Unit.find({ propertyId: { $in: properties.map((p) => p._id) } }).select("propertyId unitNumber").limit(INTAKE_LIMITS.unitsMax).lean();
  return { properties, units };
}

/**
 * The guest and stay a room's report concerns, resolved from the records the workspace already holds: the ONE stay whose status is `checked_in` for that unit.
 * No match, or more than one, links nothing (the report is recorded against the room alone) - a guest is never guessed. Workspace-scoped; the unit itself was
 * resolved from this workspace's own properties. createSignal then validates the references like any other.
 */
async function currentStayForUnit(workspaceId, unitId) {
  if (!unitId) return null;
  const stays = await Stay.find({ workspaceId, unitId, status: "checked_in" }).select("_id guestId").limit(2).lean();
  return stays.length === 1 ? stays[0] : null;
}

/** The question this conversation is waiting on, if its LAST message is a server-written clarification. */
async function pendingClarification(conversationId) {
  const last = await Message.findOne({ conversationId }).sort({ createdAt: -1, _id: -1 }).lean();
  const intake = last?.role === "assistant" ? last.metadata?.[INTAKE_KEY] : null;
  return intake?.outcome === "needs_clarification" && typeof intake.pendingText === "string" ? intake.pendingText.slice(0, INTAKE_LIMITS.textMax) : undefined;
}

const SIGNAL_CREATED_TEXT = "I've recorded this report. My assessment is based on this workspace's property, stay and guest records and your operating guidance.";
const INSTRUCTIONS_NOTE = " Instructions written inside the report are not followed: it is recorded exactly as written.";

/**
 * @returns {Promise<{ outcome: string, created: boolean, conversation: object, userMessage: object, assistantMessage: object, signal?: object }>}
 */
export async function processIntakeTurn({ workspaceId, conversationId, content }) {
  const scope = requireObjectId(workspaceId, "workspaceId");
  const text = normalizeIntakeText(content); // validates BEFORE anything is created

  let conversation;
  if (conversationId === undefined || conversationId === null || conversationId === "") {
    conversation = await Conversation.create({ workspaceId: scope, title: conversationTitle(text), status: "active" });
  } else {
    conversation = await findInWorkspaceOr404(Conversation, requireObjectId(conversationId, "conversationId"), scope, "Conversation");
    if (conversation.status === "archived") throw new AppError("This conversation is archived", 409, { code: "CONVERSATION_ARCHIVED" });
  }

  const pendingText = await pendingClarification(conversation._id);
  const reference = await loadReference(scope);
  const userMessage = await createServerMessage(conversation._id, scope, { role: "user", type: "text", content: text });
  const result = interpretOperatorMessage({ text, pendingText, properties: reference.properties, units: reference.units });

  let assistantContent;
  let intake;
  let signal;
  if (result.outcome === INTAKE_OUTCOME.READY) {
    const { draft } = result;
    const stay = await currentStayForUnit(scope, draft.unitId);
    signal = await createSignal({
      workspaceId: scope,
      propertyId: draft.propertyId,
      unitId: draft.unitId,
      ...(stay && stay.guestId ? { guestId: String(stay.guestId), stayId: String(stay._id) } : {}),
      type: draft.type,
      source: "staff",
      ...(draft.severity ? { severity: draft.severity } : {}),
      title: draft.title,
      description: draft.description,
      // Provenance of HOW this Signal was recorded - never a fact about the world. Ids are strings the server resolved itself.
      metadata: { intake: { channel: "conversation", conversationId: String(conversation._id), severityStated: draft.severityStated, typeBasis: draft.typeBasis, locationBasis: draft.location.basis, stayLinked: Boolean(stay && stay.guestId) } },
    });
    await Conversation.updateOne({ _id: conversation._id, workspaceId: scope }, { $addToSet: { signalIds: signal._id } });
    assistantContent = SIGNAL_CREATED_TEXT + (result.instructionsIgnored ? INSTRUCTIONS_NOTE : "");
    intake = { outcome: "signal_created", signalId: String(signal._id), severityStated: draft.severityStated, instructionsIgnored: Boolean(result.instructionsIgnored) };
  } else if (result.outcome === INTAKE_OUTCOME.CLARIFY) {
    assistantContent = result.question;
    intake = { outcome: INTAKE_OUTCOME.CLARIFY, missing: result.missing, pendingText: result.pendingText };
  } else {
    assistantContent = result.message;
    intake = { outcome: INTAKE_OUTCOME.DECLINED };
  }

  const assistantMessage = await createServerMessage(conversation._id, scope, { role: "assistant", type: "text", content: assistantContent, metadata: { [INTAKE_KEY]: intake } });
  const fresh = await findInWorkspaceOr404(Conversation, conversation._id, scope, "Conversation");
  return {
    outcome: signal ? "signal_created" : result.outcome,
    created: Boolean(signal),
    conversation: toPlain(fresh),
    userMessage,
    assistantMessage,
    ...(signal ? { signal } : {}),
  };
}
