/**
 * The credential endpoints of the unified EOI session (Phase 46): email + password sign-up / sign-in, email verification, password reset and the Google link step.
 * They are the browser's ONLY way to obtain or end a session besides the Google redirect (oidcSession.js) and, like that module, they use `fetch` with an injectable
 * implementation so the flows can be tested without a browser.
 *
 * Every function resolves `{ ok: true, data }` or `{ ok: false, message, field?, code? }` - it never throws and never returns raw server text: the `message` is
 * ALWAYS fixed, plain product wording chosen here from the response's status and stable code (the server's own validation sentences for a bad field are plain
 * by construction and are passed through for that one case). Nothing about HOW a request failed (status, code, stack, provider) is ever shown.
 *
 * The password is sent over HTTPS to the EOI server only, held in no store, never logged and never placed in a URL. The access token that comes back is handed to the
 * caller (which keeps it in memory); the refresh token never reaches JavaScript at all (HttpOnly cookie).
 */
const TIMEOUT_MS = 15_000;

const NETWORK = "We couldn't reach EOI. Check your connection and try again.";
const GENERIC = "Something went wrong. Please try again.";

function messageFor(status, code, serverMessage) {
  if (code === "INVALID_FIELD") return serverMessage || "Please check what you entered and try again.";
  if (code === "INVALID_CREDENTIALS") return "Invalid email or password.";
  if (code === "EMAIL_NOT_VERIFIED") return "Please verify your email address to continue. We can send the link again.";
  if (code === "USER_DISABLED") return "Your EOI account is currently unavailable. Please contact your administrator.";
  if (code === "INVALID_LINK") return "This link is invalid or has expired.";
  if (code === "LINK_FAILED") return "We couldn't connect your Google account. Please check your password and try again.";
  if (code === "EMAIL_DELIVERY_UNAVAILABLE" || code === "EMAIL_DELIVERY_FAILED") return "We can't send email right now. Please try again in a few minutes.";
  if (status === 429) return "Too many attempts. Please wait a few minutes and try again.";
  return GENERIC;
}

export function createEoiAuthApi({ apiBase, fetchImpl = (...args) => globalThis.fetch(...args) }) {
  const url = (route) => `${String(apiBase).replace(/\/+$/, "")}/auth/${route}`;

  async function post(route, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetchImpl(url(route), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json", "X-KOI-Request": "1" },
        body: JSON.stringify(body ?? {}),
        signal: controller.signal,
      });
      let parsed = null;
      try {
        parsed = await response.json();
      } catch {
        /* an empty or non-JSON body: handled by the status below */
      }
      if (response.ok) return { ok: true, data: parsed?.data ?? {} };
      const code = parsed?.details?.code;
      return { ok: false, status: response.status, code, field: parsed?.details?.field, message: messageFor(response.status, code, parsed?.message) };
    } catch {
      return { ok: false, status: 0, code: "NETWORK", message: NETWORK };
    } finally {
      clearTimeout(timer);
    }
  }

  const session = (result) => {
    if (!result.ok) return result;
    const { access_token: accessToken, expires_in: expiresIn } = result.data;
    if (typeof accessToken !== "string" || !accessToken) return { ok: false, status: 0, code: "MALFORMED", message: GENERIC };
    return { ok: true, grant: { accessToken, expiresInSeconds: Number(expiresIn) > 0 ? Number(expiresIn) : 300 } };
  };

  return {
    signUp: ({ name, email, password, passwordConfirm }) => post("signup", { name, email, password, passwordConfirm }),
    signIn: async ({ email, password }) => session(await post("signin", { email, password })),
    verifyEmail: (token) => post("verify-email", { token }),
    resendVerification: (email) => post("resend-verification", { email }),
    forgotPassword: (email) => post("forgot-password", { email }),
    resetPassword: ({ token, password, passwordConfirm }) => post("reset-password", { token, password, passwordConfirm }),
    linkGoogle: async ({ linkTicket, password }) => session(await post("google/link", { linkTicket, password })),
  };
}

export const NETWORK_MESSAGE = NETWORK;
