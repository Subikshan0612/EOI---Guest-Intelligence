import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import nodemailer from "nodemailer";
import { Resend } from "resend";
import { env } from "../config/env.js";
import { resolveEmailConfig } from "../config/emailConfig.js";
import { isDevelopmentOrTestMode } from "../config/runtimeMode.js";

/**
 * Email delivery (Phase 46 seam, Phase 46.1 real transport). The ONLY module that knows how a message leaves the process; the auth services call `sendEmail()`
 * and never see Nodemailer, SMTP or a credential:
 *
 *   passwordAuthService -> emailService.sendEmail -> Nodemailer SMTP transport -> SMTP server -> recipient
 *                                                  -> Resend HTTPS API transport -> Resend -> recipient
 *
 *   smtp        (KOI_EMAIL_TRANSPORT=smtp, or implied by SMTP_HOST) Nodemailer. Port 465 = TLS from the first byte; 587 = a plain connection that MUST upgrade with
 *               STARTTLS (`requireTLS`: no silent downgrade to plaintext). Server certificates are ALWAYS verified: this file contains no `rejectUnauthorized`
 *               override and no setting can add one. The SMTP password lives only in the process environment; it is handed to Nodemailer once and never logged,
 *               returned or placed in an error.
 *   resend      (KOI_EMAIL_TRANSPORT=resend) the official `resend` SDK over HTTPS (port 443), for hosts that block outbound SMTP (Render Free blocks 25/465/587). No SMTP
 *               connection is ever opened in this mode. RESEND_API_KEY lives only in the process environment: it is handed to the SDK once and never logged,
 *               returned or placed in an error. The SDK reports API failures as a value, not an exception; they are converted to a thrown error carrying only an
 *               allow-listed class, the HTTP status and a REDACTED short detail (no address, URL or key), so the shared failure path below behaves the same.
 *   dev outbox  (KOI_EMAIL_TRANSPORT=outbox) DEVELOPMENT / TEST ONLY, refused in production and in an unknown NODE_ENV: each message is appended as one JSON line
 *               to backend/.dev-outbox/outbox.jsonl (git-ignored) so a developer or test can open the link. Nothing is sent. It is never a fallback: it only
 *               exists when explicitly requested, and `resolveEmailConfig` turns it off outside development/test.
 *   injected    `setEmailTransport(fn)`: a test seam (or a deployment adapter). Takes precedence over the above.
 *   none        nothing configured: `emailAvailable()` is false and nothing pretends to be sent.
 *
 * The one-time token appears ONLY inside `link`. This module never logs a message body, an address or a link; a delivery failure is logged as an error CLASS only
 * (an allow-listed code such as ECONNECTION / EAUTH), never the provider's message (which can echo server responses).
 */
let injected = null;
let smtpCache = null; // { key, transporter }
let resendCache = null; // { key, client }
let resendTimeoutMs = 15_000; // an unanswered HTTPS call must not hold a sign-up request open (the SMTP transport has 10 s connect / 20 s socket limits)

/** Test helper: shorten the Resend call timeout. */
export function setResendTimeoutForTests(ms) {
  resendTimeoutMs = Number.isInteger(ms) && ms > 0 ? ms : 15_000;
}

export function setEmailTransport(fn) {
  if (fn !== null && typeof fn !== "function") throw new TypeError("An email transport must be a function");
  injected = fn;
}

/** Test helper: forget the cached Nodemailer transporter so the next send re-reads the environment. */
export function resetEmailTransport() {
  try { smtpCache?.transporter.close(); } catch { /* nothing to close */ }
  smtpCache = null;
  resendCache = null;
}

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEV_OUTBOX_FILE = path.join(here, "..", "..", ".dev-outbox", "outbox.jsonl");

/** The outbox file: KOI_EMAIL_OUTBOX_FILE (an absolute path) may redirect it so parallel test runs do not share one - honoured in development/test only. */
const outboxFile = () => {
  const override = (process.env.KOI_EMAIL_OUTBOX_FILE ?? "").trim();
  return override && path.isAbsolute(override) && isDevelopmentOrTestMode() ? override : DEV_OUTBOX_FILE;
};

function outboxTransport() {
  return async ({ html: _html, ...message }) => {
    const file = outboxFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...message })}\n`, { mode: 0o600 });
  };
}

function smtpTransporter(smtp) {
  const key = crypto.createHash("sha256").update(JSON.stringify([smtp.host, smtp.port, smtp.secure, smtp.requireTLS, smtp.user ?? "", smtp.password ?? ""])).digest("hex");
  if (smtpCache?.key === key) return smtpCache.transporter;
  resetEmailTransport();
  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure, // true: implicit TLS (465)
    requireTLS: smtp.requireTLS, // false-secure: the STARTTLS upgrade is mandatory; if the server cannot do it the send FAILS (never plaintext)
    ...(smtp.user ? { auth: { user: smtp.user, pass: smtp.password } } : {}),
    tls: { minVersion: "TLSv1.2" }, // verification stays on (Nodemailer's default); deliberately NO rejectUnauthorized override
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    disableFileAccess: true, // a message can never embed a local file or fetch a URL
    disableUrlAccess: true,
    logger: false,
    debug: false,
  });
  smtpCache = { key, transporter };
  return transporter;
}

function resendClient(apiKey) {
  const key = crypto.createHash("sha256").update(apiKey).digest("hex");
  if (resendCache?.key === key) return resendCache.client;
  resendCache = { key, client: new Resend(apiKey) };
  return resendCache.client;
}

/** "Name <address>" for the API; a display name with punctuation is quoted so a comma or dot cannot be read as an address separator. */
const formatFrom = ({ display, address }) => (display ? (/[,.;:()@[\]\\]/.test(display) ? `"${display}" <${address}>` : `${display} <${address}>`) : address);

/** A short provider message that is safe for a log line: no address, URL, key or long token, one line, capped. */
const redactDetail = (message) =>
  String(message ?? "")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[address]")
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/\bre_[A-Za-z0-9_-]+/g, "[key]")
    .replace(/[A-Za-z0-9_-]{24,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);

/** The SDK returns { data, error } instead of throwing: turn `error` into an Error whose code/status/detail are all safe to log. */
function resendFailure(apiError) {
  const failure = new Error("Resend API error");
  const name = String(apiError?.name ?? "").toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  failure.code = /^[A-Z][A-Z0-9_]{2,30}$/.test(name) ? name : "RESEND_ERROR";
  if (Number.isInteger(apiError?.statusCode)) failure.status = apiError.statusCode;
  failure.detail = redactDetail(apiError?.message);
  return failure;
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("Resend request timed out"), { code: "ETIMEDOUT" })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** @returns {{ kind: "injected"|"smtp"|"resend"|"dev-outbox", send: Function, smtp?: object } | null} */
function activeTransport() {
  if (injected) return { kind: "injected", send: injected };
  const config = resolveEmailConfig();
  if (config.problems.length > 0) return null; // a half-configured transport is NO transport
  if (config.transport === "smtp" && config.smtp) {
    const smtp = config.smtp;
    return {
      kind: "smtp",
      smtp,
      send: async ({ to, subject, text, html }) => {
        await smtpTransporter(smtp).sendMail({ from: smtp.from.display ? { name: smtp.from.display, address: smtp.from.address } : smtp.from.address, to, subject, text, html });
      },
    };
  }
  if (config.transport === "resend" && config.resend) {
    const resend = config.resend;
    return {
      kind: "resend",
      send: async ({ to, subject, text, html }) => {
        const result = await withTimeout(resendClient(resend.apiKey).emails.send({ from: formatFrom(resend.from), to: [to], subject, text, html }), resendTimeoutMs);
        if (result?.error) throw resendFailure(result.error);
      },
    };
  }
  if (config.transport === "outbox") return { kind: "dev-outbox", send: outboxTransport() };
  return null;
}

/** True when a message can really be delivered (a valid transport is configured). Never true for a half-configured SMTP setup. */
export const emailAvailable = () => activeTransport() !== null;

/** Which delivery is active: "transport" (injected) | "smtp" | "resend" | "dev-outbox" | "none" (for start-up logs and tests; contains no secret). */
export function emailDeliveryMode() {
  const active = activeTransport();
  if (!active) return "none";
  return active.kind === "injected" ? "transport" : active.kind;
}

/**
 * The link the recipient opens. It is derived ONLY from the configured CLIENT_URL: no request header (Host, X-Forwarded-*, Origin, Referer) ever reaches it, so a
 * caller cannot steer an email to another site. The token is URL-safe; the page strips it from the address bar as soon as it loads.
 */
export const buildLink = (route, token) => `${env.clientUrl.replace(/\/+$/, "")}${route}${token ? `?token=${encodeURIComponent(token)}` : ""}`;

const safeClass = (error) => (typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{2,30}$/.test(error.code) ? error.code : "UNKNOWN");

/**
 * @returns {Promise<boolean>} true when the transport ACCEPTED the message; false (never throws) when there is no transport or the send failed. The caller decides
 * what to tell the person and what to clean up: this function neither claims success it did not get nor reveals why it failed.
 */
export async function sendEmail({ to, subject, text, html, kind, link }) {
  const active = activeTransport();
  if (!active) return false;
  try {
    await active.send({ to, subject, text, html, kind, link });
    return true;
  } catch (error) {
    const status = Number.isInteger(error?.status) ? `, status ${error.status}` : "";
    const detail = typeof error?.detail === "string" && error.detail ? `, detail: ${error.detail}` : "";
    console.warn(`[KOI API] email delivery failed (${kind ?? "message"}, transport ${active.kind}, class ${safeClass(error)}${status}${detail})`);
    return false;
  }
}

/**
 * Start-up connectivity probe for the SMTP transport (opens a connection, negotiates TLS/STARTTLS, authenticates, sends nothing). Never throws and never returns
 * detail beyond an error class. { checked: false } when SMTP is not the active transport.
 */
export async function verifySmtpConnection() {
  const active = activeTransport();
  if (!active || active.kind !== "smtp") return { checked: false, ok: false };
  try {
    await smtpTransporter(active.smtp).verify();
    // `tls` states what was configured and therefore enforced: "implicit" (465), "starttls" (mandatory upgrade) or "none" (development/test local capture only).
    return { checked: true, ok: true, tls: active.smtp.secure ? "implicit" : active.smtp.requireTLS ? "starttls" : "none" };
  } catch (error) {
    return { checked: true, ok: false, errorClass: safeClass(error) };
  }
}
