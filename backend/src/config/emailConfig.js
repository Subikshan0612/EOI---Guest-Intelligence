import { isDevelopmentOrTestMode } from "./runtimeMode.js";

/**
 * Email transport configuration (Phase 46.1). Read from the environment on demand; nothing is hard-coded and nothing here is ever logged or returned.
 *
 *   KOI_EMAIL_TRANSPORT   smtp | resend | outbox | (unset)
 *                         smtp    real delivery through Nodemailer over SMTP
 *                         resend  real delivery through Resend's HTTPS API (no SMTP port is used: required where outbound SMTP is blocked, for example Render Free). Needs
 *                                 RESEND_API_KEY (a SECRET: server side only, never logged or returned) and MAIL_FROM (an address on a domain verified in Resend).
 *                         outbox  DEVELOPMENT / TEST ONLY: one-time links are written to a git-ignored file instead of being sent (refused in production)
 *                         unset   smtp when SMTP_HOST is set, otherwise NO transport (email-dependent features answer 503). `resend` is only ever selected explicitly.
 *   SMTP_HOST             required for smtp. The mail server's host name.
 *   SMTP_PORT             default 587. Common: 465 (implicit TLS), 587 (STARTTLS).
 *   SMTP_SECURE           true = TLS from the first byte (port 465); false = a plain connection that MUST upgrade with STARTTLS (port 587). Default: true on port 465, else false.
 *   SMTP_USER, SMTP_PASSWORD   both or neither. SMTP_PASSWORD is a SECRET: server side only, never a VITE_* variable, never logged or returned.
 *   MAIL_FROM             required for smtp and resend. The sender: "address@example.com" or "EOI <address@example.com>".
 *   RESEND_API_KEY        required for resend. The SMTP_* variables are not read by the resend transport.
 *   SMTP_REQUIRE_TLS      "false" allows a plaintext connection to a LOCAL capture server in development/test only. Production refuses it. Certificates are ALWAYS verified:
 *                         there is no setting that disables verification.
 *
 * Production (and an unknown NODE_ENV) accepts only a valid smtp or resend configuration.
 */
const ADDRESS = /^[^\s@<>()[\]\\,;:"]{1,64}@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

/** "a@b.co" or `Name <a@b.co>` -> { address, display } | null. CR, LF and angle-bracket tricks are refused (header injection). */
export function parseMailFrom(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw || raw.length > 200 || /[\r\n\u0000]/.test(raw)) return null;
  const named = /^([^<>"\r\n]{1,100})<([^<>\s]+)>$/.exec(raw);
  const address = named ? named[2] : raw;
  if (!ADDRESS.test(address)) return null;
  return { address, display: named ? named[1].trim() : "" };
}

/** @returns {{ transport: "smtp"|"resend"|"outbox"|"none", problems: string[], smtp: object|null, resend: object|null }} */
export function resolveEmailConfig(environment = process.env) {
  const problems = [];
  const requested = (environment.KOI_EMAIL_TRANSPORT ?? "").trim().toLowerCase();
  const host = (environment.SMTP_HOST ?? "").trim();
  let transport = "none";
  if (requested === "smtp" || (requested === "" && host)) transport = "smtp";
  else if (requested === "resend") transport = "resend";
  else if (requested === "outbox") transport = "outbox";
  else if (requested !== "") problems.push("KOI_EMAIL_TRANSPORT must be smtp, resend or outbox");

  if (transport === "outbox" && !isDevelopmentOrTestMode()) {
    problems.push("the development outbox is refused outside development/test: configure KOI_EMAIL_TRANSPORT=smtp");
    transport = "none";
  }

  let smtp = null;
  if (transport === "smtp") {
    const cfg = {};
    if (!host || /\s|\/|@/.test(host)) problems.push("SMTP_HOST is required (a host name, no scheme or path)");
    else cfg.host = host;
    const portRaw = (environment.SMTP_PORT ?? "").trim();
    const port = portRaw === "" ? 587 : Number(portRaw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push("SMTP_PORT must be an integer from 1 to 65535");
    else cfg.port = port;
    const secureRaw = (environment.SMTP_SECURE ?? "").trim().toLowerCase();
    if (secureRaw !== "" && secureRaw !== "true" && secureRaw !== "false") problems.push("SMTP_SECURE must be true or false");
    cfg.secure = secureRaw === "" ? cfg.port === 465 : secureRaw === "true";
    if (cfg.port === 465 && !cfg.secure) problems.push("port 465 is implicit TLS: set SMTP_SECURE=true (or use port 587 with STARTTLS)");
    const requireTlsRaw = (environment.SMTP_REQUIRE_TLS ?? "").trim().toLowerCase();
    // STARTTLS is MANDATORY on a plain connection (no silent downgrade to plaintext); only a local development capture server may opt out.
    cfg.requireTLS = !cfg.secure && !(requireTlsRaw === "false" && isDevelopmentOrTestMode());
    if (requireTlsRaw === "false" && !isDevelopmentOrTestMode()) problems.push("SMTP_REQUIRE_TLS=false is refused outside development/test");
    const user = environment.SMTP_USER ?? "";
    const password = environment.SMTP_PASSWORD ?? "";
    if ((user && !password) || (!user && password)) problems.push("SMTP_USER and SMTP_PASSWORD must be set together");
    if (user) {
      cfg.user = user;
      Object.defineProperty(cfg, "password", { value: password, enumerable: false }); // out of enumeration: a stray JSON.stringify / spread / log cannot print it
    }
    const from = parseMailFrom(environment.MAIL_FROM);
    if (!from) problems.push("MAIL_FROM is required and must be an address or `Name <address>`");
    else cfg.from = from;
    smtp = problems.length === 0 ? Object.freeze(cfg) : null;
  }

  // Resend (HTTPS API). The key is held out of enumeration exactly like the SMTP password, so a stray JSON.stringify / spread / log cannot print it.
  let resend = null;
  if (transport === "resend") {
    const apiKey = (environment.RESEND_API_KEY ?? "").trim();
    if (!apiKey) problems.push("RESEND_API_KEY is required for the resend transport");
    else if (!/^re_[A-Za-z0-9_-]{8,}$/.test(apiKey)) problems.push("RESEND_API_KEY is not a Resend API key (they start with re_)");
    const from = parseMailFrom(environment.MAIL_FROM);
    if (!from) problems.push("MAIL_FROM is required and must be an address or `Name <address>`");
    if (problems.length === 0) {
      const cfg = { from };
      Object.defineProperty(cfg, "apiKey", { value: apiKey, enumerable: false });
      resend = Object.freeze(cfg);
    }
  }
  return { transport, problems, smtp: problems.length === 0 ? smtp : null, resend: problems.length === 0 ? resend : null };
}

/**
 * Start-up verdict for a deployment that depends on email (AUTH_PROVIDER=eoi). Anything that is not an explicit development/test environment (production AND an
 * unset/unknown NODE_ENV) must have a complete, valid SMTP configuration and an https CLIENT_URL (the public link base of every email), or the server refuses
 * to start. Elsewhere the same findings are warnings and email-dependent endpoints answer 503. Never contains a secret.
 */
export function emailStartupProblems({ clientUrl, environment = process.env } = {}) {
  const config = resolveEmailConfig(environment);
  const problems = [...config.problems];
  const strict = !isDevelopmentOrTestMode();
  if (strict && config.transport !== "smtp" && config.transport !== "resend") problems.push("this environment requires KOI_EMAIL_TRANSPORT=smtp (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, MAIL_FROM) or KOI_EMAIL_TRANSPORT=resend (RESEND_API_KEY, MAIL_FROM); the development outbox is never a production transport");
  if (strict) {
    let parsed = null;
    try { parsed = new URL(clientUrl ?? ""); } catch { /* reported below */ }
    if (!parsed || parsed.protocol !== "https:") problems.push("CLIENT_URL must be an explicit https:// URL: it is the base of every verification and reset link");
    else if (/^(localhost|127\.|\[::1\])/i.test(parsed.hostname)) problems.push("CLIENT_URL must not be a localhost address: it is the base of every verification and reset link");
  }
  return { fatal: strict ? problems : [], warnings: strict ? [] : problems, config };
}
