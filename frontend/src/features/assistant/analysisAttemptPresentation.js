/**
 * The words for the states of an analysis attempt that is still running, could not be checked, or ended without an analysis (Workstream 5B). A CLOSED set of constants:
 * nothing from the server is ever echoed, and nothing here decides anything - the backend owns the attempt's state, the page only says it.
 *
 * What these words must NOT do (and do not):
 *   - say or imply the analysis has failed while it is still running (the HTTP response ending is not a failure);
 *   - promise a time, show a percentage or progress bar, or name a provider, a model or any internal detail;
 *   - ask for the same request to be submitted again while the first is still running.
 *
 * SAFETY WORDING. Only the existing, SERVER-derived classification is used: the report's hazard flag (`serverHazard`, read by the Signal mapping from the structured issue the server
 * derived) is set exactly when the server's own safety policy (safetyPolicy.js) judged the report a life-safety hazard (it is never inferred from words in the browser). For such a report the page adds one
 * sentence so that a missing or late assessment is never read as "wait for the AI before acting on the hazard". The sentence reuses the posture the page already states when a
 * hazard assessment exists ("the hazard needs immediate attention either way", DecisionPanel.jsx). It names no procedure, role, deadline, contact or escalation path.
 */
export const IN_PROGRESS_TITLE = "Still preparing this assessment";
export const IN_PROGRESS_BODY = "This request is still being worked on, so you don't need to send it again. This page will show the assessment as soon as it is ready.";
export const STALLED_BODY = "This is taking longer than expected. The assessment may still arrive; you can check again, and nothing needs to be sent again.";
export const STATUS_UNAVAILABLE_BODY = "The current state couldn't be checked just now. The request may still be running; you can check again.";
export const CHECK_AGAIN_LABEL = "Check again";

/** Added, for a report the server classified as a safety hazard, to the in-progress and failed states. Reuses the page's existing hazard posture; invents nothing. */
export const HAZARD_NOTE = "This report is marked as a safety hazard. The hazard needs immediate attention either way, whether or not the assessment has arrived.";

/** Whether the server classified this report as a safety hazard (the structured, server-derived `serverHazard` flag of the mapped Signal). Never derived from text. */
export const isServerHazard = (signal) => signal?.serverHazard === true;
