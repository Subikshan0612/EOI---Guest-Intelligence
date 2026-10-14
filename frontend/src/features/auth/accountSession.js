/**
 * "Signed in" is not "set up": the sign-in provider only says WHO the person is. Right after sign-in the app asks the server what it knows about that person
 * (GET /api/auth/session) and turns the answer into the next screen. Nothing here grants or decides anything - the server enforces membership and role on every
 * request regardless; this only picks the screen and the workspace the person's own requests will name.
 *
 *   { kind: 'ready', workspaceId, workspaces }   the person belongs to at least one workspace: enter the app in one of THEIR workspaces
 *   { kind: 'needsSetup' }                       a new person and the deployment allows self-service setup: show the short onboarding
 *   { kind: 'restricted' }                       a new person and an administrator must grant access
 *   { kind: 'disabled' }                         the account has been disabled
 *   { kind: 'ended' }                            the session itself ended while asking (the sign-in-again path handles it; show nothing new)
 *   { kind: 'unreachable' }                      EOI could not be reached at all (no network / timeout): a recoverable error, never a guess
 *   { kind: 'failed' }                           the answer could not be obtained (5xx, a malformed answer): a recoverable error, never a guess
 */
const ID = /^[0-9a-fA-F]{24}$/;

/** One of the person's OWN workspaces: the development build-time one if they belong to it, otherwise their first. */
export function chooseWorkspace(workspaces, preferredId = "") {
  const own = (Array.isArray(workspaces) ? workspaces : []).filter((w) => w && typeof w.id === "string" && ID.test(w.id));
  if (own.length === 0) return "";
  const preferred = own.find((w) => w.id === preferredId);
  return (preferred ?? own[0]).id;
}

export function interpretSession(session, preferredId = "") {
  const state = session?.state;
  if (state === "member") {
    const workspaceId = chooseWorkspace(session.workspaces, preferredId);
    return workspaceId ? { kind: "ready", workspaceId, workspaces: session.workspaces } : { kind: "failed" };
  }
  if (state === "needs_setup") return { kind: "needsSetup" };
  if (state === "access_restricted") return { kind: "restricted" };
  return { kind: "failed" };
}

export async function resolveAccount({ getAccountSession, preferredId = "" }) {
  try {
    return interpretSession(await getAccountSession(), preferredId);
  } catch (error) {
    if (error?.status === 403 && error.code === "USER_DISABLED") return { kind: "disabled" };
    if (error?.status === 401) return { kind: "ended" };
    if (error?.status === 0) return { kind: "unreachable" };
    return { kind: "failed" };
  }
}

/**
 * Sets up the person's own account. Returns { ok: true, result } (the resolved new state) or { ok: false, message } with a plain-language message.
 * Only the server's own validation wording (a bad workspace name) is passed through; everything else is a fixed sentence.
 */
export async function setUpAccount({ registerAccount, workspaceName, preferredId = "" }) {
  try {
    return { ok: true, result: interpretSession(await registerAccount(workspaceName), preferredId) };
  } catch (error) {
    if (error?.status === 400 && error.code === "INVALID_FIELD") return { ok: false, message: error.message || "Please check the workspace name and try again." };
    // 409: the setup already happened (an earlier click, a retry after a lost response, another tab) or is happening right now. The caller asks the server
    // what exists and enters the app if the person now has a workspace; it never creates a second one.
    if (error?.status === 409) return { ok: false, conflict: true, inProgress: error.code === "SETUP_IN_PROGRESS", message: "Your workspace is still being set up. Please try again in a moment." };
    if (error?.status === 403 && error.code === "SELF_REGISTRATION_DISABLED") return { ok: false, restricted: true, message: "Account setup isn't available here." };
    if (error?.status === 403 && error.code === "USER_DISABLED") return { ok: false, disabled: true, message: "This account has been disabled." };
    if (error?.status === 401) return { ok: false, ended: true, message: "Your session has expired. Please sign in again." };
    if (error?.status === 0) return { ok: false, message: "We couldn't reach EOI. Check your connection and try again." };
    return { ok: false, message: "We couldn't set up your workspace. Please try again." };
  }
}

/**
 * The whole "create my workspace" step, safe to repeat: sets the account up and, when the server says it already exists (an earlier click, a retry after a
 * lost response, a refresh during creation, another tab) or is being created right now, asks the server what exists - at most twice, never a loop - and enters
 * the existing workspace instead. It never creates a second one: the server allows exactly one setup per identity, and this only ever READS after a conflict.
 * Returns { ok: true, result } with the resolved state, or { ok: false, message, ... } exactly as setUpAccount does.
 */
export async function completeSetUp({ registerAccount, getAccountSession, workspaceName, preferredId = "", wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const outcome = await setUpAccount({ registerAccount, workspaceName, preferredId });
  if (outcome.ok || !outcome.conflict) return outcome;
  for (let check = 0; check < 2; check += 1) {
    if (check > 0) await wait(1500);
    const result = await resolveAccount({ getAccountSession, preferredId });
    if (result.kind === "ready") return { ok: true, result };
    if (!outcome.inProgress) break;
  }
  return outcome;
}
