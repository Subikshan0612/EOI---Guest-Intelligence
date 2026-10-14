import { AnalysisAttempt } from "../models/AnalysisAttempt.js";
import { Signal } from "../models/Signal.js";
import { getAnalysisAttemptStaleAfterMs } from "../config/runtimeConfig.js";
import { requireObjectId } from "../utils/objectId.js";
import { classifyFailure } from "./ai/analysisFailureTaxonomy.js";
import { findAnalysisIntelligence } from "./intelligenceService.js";
import { findInWorkspaceOr404 } from "./queryHelpers.js";
import { normalizeCallerLevel } from "./knowledge/visibility.js";
import { logEvent } from "../utils/logEvent.js";

/**
 * ANALYSIS ATTEMPT LIFECYCLE (Workstream 5A). It WRAPS the existing analysis pipeline (intelligenceAnalysisService.js: retrieval -> AI service -> validation -> sanitiser ->
 * persistence); it does not reimplement any of it. It records, durably, whether an attempt is in progress / succeeded / failed (models/AnalysisAttempt.js), and answers the
 * one question a client needs while an analysis outlives its HTTP response: "what is the state now?".
 *
 * WHAT IT GUARANTEES, AND WHAT IT DOES NOT (stated plainly, because restart behaviour is the part that is easy to over-claim):
 *   - ONE in-flight attempt per (workspace, Signal, level), across processes: the partial unique index makes a second claim fail while one is in progress, so no second
 *     provider call is started for it by any request, however many arrive.
 *   - A stored Intelligence is the source of truth for "succeeded": the state is derived from it first, so a completed analysis is never re-run because a client
 *     reconnects or polls.
 *   - There is NO recovery. If the process that owns an in-progress attempt ends (crash, SIGKILL, deploy) the attempt is lost: the pipeline cannot be resumed, nothing is
 *     persisted for it, and the marker is left behind. Such a marker is treated as in progress until it is older than getAnalysisAttemptStaleAfterMs() (no second call is
 *     started meanwhile, because the provider call may still be running elsewhere) and as failed ("ATTEMPT_INTERRUPTED") afterwards, when an EXPLICIT new request may start
 *     a new attempt. A graceful shutdown marks the attempts it owns as interrupted at once. Resuming or re-running automatically would need a durable queue and a worker,
 *     which this phase deliberately does not build (deferred).
 *   - It never grants anything: the marker holds no analysis, and a Decision or Action can only be proposed from a stored Intelligence.
 *
 * The state view carries only identifiers, timestamps and the already-public failure vocabulary (details.code, failure class, HTTP status): no prompt, output, message,
 * Signal text or secret, ever.
 */

export const INTERRUPTED_CODE = "ATTEMPT_INTERRUPTED";
const CODE = /^[A-Z0-9_]{1,64}$/;
const UUID_36 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const asCode = (value) => (typeof value === "string" && CODE.test(value) ? value : undefined);

/** PURE. The public representation of an attempt (or of "no attempt"). */
export function toAttemptView(attempt, { status, intelligenceId } = {}) {
  if (!attempt) return { status: status ?? "not_started" };
  const view = { status: status ?? attempt.status, attemptId: attempt.attemptId, startedAt: attempt.startedAt };
  if (attempt.finishedAt) view.finishedAt = attempt.finishedAt;
  const stored = intelligenceId ?? attempt.intelligenceId;
  if (view.status === "succeeded" && stored) view.intelligenceId = String(stored);
  if (view.status === "failed") view.failure = { code: attempt.failureCode ?? "INTERNAL_ERROR", class: attempt.failureClass ?? "internal", ...(Number.isInteger(attempt.httpStatus) ? { httpStatus: attempt.httpStatus } : {}) };
  return view;
}

/** PURE. A marker older than the staleness horizon belongs to a process that no longer exists. */
export function isStaleAttempt(attempt, now = Date.now()) {
  return attempt?.status === "in_progress" && now - new Date(attempt.startedAt).getTime() >= getAnalysisAttemptStaleAfterMs();
}

const scoped = (workspaceId, signalId, level) => ({ workspaceId: requireObjectId(workspaceId, "workspaceId"), signalId: requireObjectId(signalId, "signalId"), analysisLevel: level });

/**
 * Tries to become THE in-flight attempt. { claimed: true, attempt } when this caller now owns it; { claimed: false, attempt } with the existing in-progress marker when
 * another process (or a process that has since died) already holds it. A stale marker is first expired (compare-and-set, so only one caller does it) and the claim retried once.
 */
export async function claimAttempt({ workspaceId, signalId, level, attemptId, requestId }) {
  const key = scoped(workspaceId, signalId, level);
  for (let round = 0; round < 2; round += 1) {
    try {
      // The correlation id is stored only when it is a canonical uuid (lower-cased), exactly as the admission row does; anything else is simply absent.
      const correlation = typeof requestId === "string" && UUID_36.test(requestId) ? requestId.toLowerCase() : undefined;
      const created = await AnalysisAttempt.create({ ...key, attemptId, requestId: correlation, status: "in_progress", startedAt: new Date() });
      return { claimed: true, attempt: created.toObject() };
    } catch (error) {
      if (error?.code !== 11000) throw error;
    }
    const existing = await AnalysisAttempt.findOne({ ...key, status: "in_progress" }).lean();
    if (!existing) continue; // it finished between the failed insert and this read: claim again
    if (!isStaleAttempt(existing)) return { claimed: false, attempt: existing };
    await expireAttempt(existing);
  }
  const existing = await AnalysisAttempt.findOne({ ...key, status: "in_progress" }).lean();
  return { claimed: false, attempt: existing ?? null };
}

/** Marks a stale in-progress marker failed. Compare-and-set on the status AND the attempt id: a marker that was meanwhile finished or replaced is left alone. */
async function expireAttempt(attempt) {
  await AnalysisAttempt.updateOne(
    { _id: attempt._id, status: "in_progress", attemptId: attempt.attemptId },
    { $set: { status: "failed", finishedAt: new Date(), failureCode: INTERRUPTED_CODE, failureClass: "internal" } },
  );
  logEvent("analysis.attempt_expired", { attemptId: attempt.attemptId, code: INTERRUPTED_CODE });
}

/** Best-effort state transition: a marker write problem is logged (error class only) and NEVER changes the outcome of the analysis. */
async function transition(attemptId, workspaceId, fields, event) {
  try {
    await AnalysisAttempt.updateOne({ workspaceId: requireObjectId(workspaceId, "workspaceId"), attemptId, status: "in_progress" }, { $set: { ...fields, finishedAt: new Date() } });
    logEvent(event, { attemptId });
  } catch (error) {
    logEvent("analysis.attempt_write_failed", { attemptId, errorClass: error?.name ?? "Error" });
  }
}

export const markAttemptSucceeded = (attemptId, workspaceId, intelligenceId) => transition(attemptId, workspaceId, { status: "succeeded", intelligenceId }, "analysis.attempt_succeeded");

export function markAttemptFailed(attemptId, workspaceId, error) {
  return transition(
    attemptId,
    workspaceId,
    { status: "failed", failureCode: asCode(error?.details?.code) ?? "INTERNAL_ERROR", failureClass: classifyFailure(error), httpStatus: Number.isInteger(error?.statusCode) ? error.statusCode : undefined },
    "analysis.attempt_failed",
  );
}

export const markAttemptInterrupted = (attemptId, workspaceId) =>
  transition(attemptId, workspaceId, { status: "failed", failureCode: INTERRUPTED_CODE, failureClass: "internal" }, "analysis.attempt_interrupted");

/**
 * The current state of the analysis of one Signal at one level, for the caller's workspace only. 404 for a Signal that is not in the workspace (the same answer as a
 * missing one, so nothing about another workspace is revealed). Read-only: it never starts anything and never writes.
 *   succeeded    a stored analysis exists (the source of truth) - { intelligenceId }
 *   in_progress  a fresh in-progress marker exists
 *   failed       the latest attempt failed, or its in-progress marker is stale (the owning process is gone: ATTEMPT_INTERRUPTED)
 *   not_started  nothing has been attempted
 */
export async function getAnalysisStatus(signalId, workspaceId, authorizedLevel) {
  const level = normalizeCallerLevel(authorizedLevel);
  const scope = requireObjectId(workspaceId, "workspaceId");
  const id = requireObjectId(signalId, "signalId");
  await findInWorkspaceOr404(Signal, id, scope, "Signal");
  const stored = await findAnalysisIntelligence(scope, id, level);
  if (stored) return { status: "succeeded", intelligenceId: String(stored._id), ...(stored.createdAt ? { finishedAt: stored.createdAt } : {}) };
  const latest = await AnalysisAttempt.findOne(scoped(scope, id, level)).sort({ startedAt: -1 }).lean();
  if (!latest) return { status: "not_started" };
  if (latest.status === "in_progress") return isStaleAttempt(latest) ? toAttemptView({ ...latest, failureCode: INTERRUPTED_CODE, failureClass: "internal" }, { status: "failed" }) : toAttemptView(latest);
  if (latest.status === "succeeded") return { status: "not_started" }; // its analysis no longer exists: nothing to report as done
  return toAttemptView(latest);
}
