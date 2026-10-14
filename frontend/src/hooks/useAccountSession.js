import { useCallback, useEffect, useRef, useState } from "react";
import { BUILD_WORKSPACE_ID, setActiveWorkspace } from "../config/workspace";
import { completeSetUp, resolveAccount } from "../features/auth/accountSession";
import { getAccountSession, registerAccount } from "../services/api";
import { AUTH_REASON, AUTH_STATUS, blockApp, getAuthState } from "../services/auth/authSession";
import { isAuthEnabled } from "../services/auth/oidc/oidcSession";
import { useAuthSession } from "./useAuthSession";

/**
 * The post-sign-in account step (Phase 45C). With real sign-in in use, after the provider has said who the person is, this asks the server what EOI knows about
 * them and moves the app to the right place:
 *
 *   'checking'    a short wait (the app shows a loading screen)
 *   'ready'       they belong to a workspace: the active workspace is set to one of THEIR OWN, and the app renders
 *   'needsSetup'  a new person and self-service setup is allowed: the onboarding screen (`setUp(name)` creates their own workspace)
 *   'failed'      the answer could not be obtained: a retry screen (`retry`); `unreachable` says it was a connection problem
 *
 * "Administrator must grant access" and "account disabled" block the app behind the sign-in screens. Without real sign-in (development) it is 'ready' at once
 * and the build-time workspace is used. The server remains the authority on everything; nothing here grants access.
 */
// The account check in flight, shared: React StrictMode (development) runs an effect twice, and a quick unmount/mount must not send two identical requests.
let checkInFlight = null;
const resolveOnce = () => {
  checkInFlight ??= resolveAccount({ getAccountSession, preferredId: BUILD_WORKSPACE_ID }).finally(() => {
    checkInFlight = null;
  });
  return checkInFlight;
};

export function useAccountSession() {
  const { status } = useAuthSession();
  const active = isAuthEnabled && status === AUTH_STATUS.READY;
  const [state, setState] = useState(active ? "checking" : "ready");
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [unreachable, setUnreachable] = useState(false);
  const submitting = useRef(null); // the setup request in flight: a second click, Enter or a re-render can never start another

  const apply = useCallback((result) => {
    if (result.kind === "ready") {
      setActiveWorkspace(result.workspaceId, result.workspaces?.find((w) => w?.id === result.workspaceId)?.role);
      setState("ready");
    } else if (result.kind === "needsSetup") setState("needsSetup");
    else if (result.kind === "restricted") blockApp(AUTH_REASON.ACCESS_RESTRICTED);
    else if (result.kind === "disabled") blockApp(AUTH_REASON.ACCOUNT_DISABLED);
    else if (result.kind === "ended") setState("ready"); // the session-ended screen takes over
    else {
      setUnreachable(result.kind === "unreachable");
      setState("failed");
    }
  }, []);

  useEffect(() => {
    if (!active) {
      setState("ready");
      return undefined;
    }
    let cancelled = false;
    setState("checking");
    resolveOnce().then((result) => {
      if (!cancelled && getAuthState().status === AUTH_STATUS.READY) apply(result);
    });
    return () => {
      cancelled = true;
      if (isAuthEnabled) setActiveWorkspace(""); // never leave a workspace selected when the session is gone
    };
  }, [active, attempt, apply]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const runSetUp = useCallback(
    async (workspaceName) => {
      setBusy(true);
      try {
        // Safe to repeat: an "already set up" answer enters the existing workspace (accountSession.js completeSetUp); a second workspace is never created.
        const outcome = await completeSetUp({ registerAccount, getAccountSession, workspaceName, preferredId: BUILD_WORKSPACE_ID });
        if (outcome.ok) {
          apply(outcome.result);
          return { ok: outcome.result.kind === "ready" || outcome.result.kind === "needsSetup", message: outcome.result.kind === "failed" ? "We couldn't set up your workspace. Please try again." : "" };
        }
        if (outcome.restricted) apply({ kind: "restricted" });
        else if (outcome.disabled) apply({ kind: "disabled" });
        return { ok: false, message: outcome.message, ended: outcome.ended };
      } finally {
        setBusy(false);
      }
    },
    [apply],
  );

  // One setup request at a time, whatever calls this (double click, Enter held down, StrictMode): a second call shares the first one's result.
  const setUp = useCallback(
    (workspaceName) => {
      if (submitting.current) return submitting.current;
      const running = runSetUp(workspaceName).finally(() => {
        submitting.current = null;
      });
      submitting.current = running;
      return running;
    },
    [runSetUp],
  );

  return { state, busy, unreachable, retry, setUp };
}
