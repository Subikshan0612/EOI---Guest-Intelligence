/**
 * Resend email transport (HTTPS API) - deterministic, LOCAL ONLY: a loopback fake of the Resend API (the SDK is pointed at it with RESEND_BASE_URL), no real Resend call,
 * no real address, no database, no SMTP, no Gemini. Proves the new transport is a clean addition behind the existing seam:
 *
 *   A  configuration: KOI_EMAIL_TRANSPORT=resend needs RESEND_API_KEY + MAIL_FROM and nothing SMTP; production accepts it; the old transports behave as before
 *   B  delivery: the SDK request (URL, bearer key, from / to / subject / text / HTML) and the real verification-email template pass through unchanged
 *   C  no SMTP is used in resend mode (a listener on the configured SMTP port sees no connection); the start-up probe does not apply
 *   D  failures: every Resend error shape becomes `false` from sendEmail (never a throw), with a log line that holds no key, address, link or token
 *   E  the key and the one-time token never leave the process in any other way (static checks)
 */
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(here, "..");
let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => { if (ok) { passed += 1; console.log(`PASS  ${name}`); } else { failed += 1; console.error(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`); } };
const read = (p) => fs.readFileSync(p, "utf8");

const KEY = "re_TestKeyNotReal_0123456789abcdef";
const OTHER_KEY = "re_AnotherFakeKey_9876543210zyxwvu";
const EMAIL_VARS = ["KOI_EMAIL_TRANSPORT", "RESEND_API_KEY", "MAIL_FROM", "SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USER", "SMTP_PASSWORD", "SMTP_REQUIRE_TLS", "RESEND_BASE_URL"];
const setEnv = (values) => { for (const k of EMAIL_VARS) delete process.env[k]; Object.assign(process.env, values); };
process.env.NODE_ENV = "test";
process.env.CLIENT_URL = "https://app.example.invalid";

const { resolveEmailConfig, emailStartupProblems } = await import("../src/config/emailConfig.js");
const svc = await import("../src/services/emailService.js");
const { verifyEmailMessage } = await import("../src/services/emailTemplates.js");

// ---------------------------------------------------------------------------------------------------------------- the fake Resend API
const requests = [];
let mode = "ok";
const fake = http.createServer((req, res) => {
  const chunks = []; req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    let body = null; try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* not json */ }
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });
    const send = (status, json, type = "application/json") => { res.writeHead(status, { "content-type": type }); res.end(typeof json === "string" ? json : JSON.stringify(json)); };
    if (mode === "ok") return send(200, { id: "00000000-0000-4000-8000-000000000000" });
    if (mode === "invalid_key") return send(401, { name: "invalid_api_key", message: "API key is invalid", statusCode: 401 });
    if (mode === "unverified_domain") return send(403, { name: "validation_error", message: `The example.test domain is not verified. Please add and verify your domain. Sent to victim@example.test using ${KEY} see https://resend.com/domains/abcdefghijklmnopqrstuvwxyz0123456789`, statusCode: 403 });
    if (mode === "rate") return send(429, { name: "rate_limit_exceeded", message: "Too many requests. You can only make 2 requests per second.", statusCode: 429 });
    if (mode === "html500") return send(500, "<html><body>Bad gateway</body></html>", "text/html");
    if (mode === "weird_name") return send(422, { name: "Some Weird Name!", message: "x", statusCode: 422 });
    if (mode === "hang") return undefined; // never answers
    return send(500, {});
  });
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${fake.address().port}`;

// a listener standing in for an SMTP server: it must never be contacted in resend mode
let smtpHits = 0;
const smtpTrap = net.createServer((socket) => { smtpHits += 1; socket.destroy(); });
await new Promise((r) => smtpTrap.listen(0, "127.0.0.1", r));
const SMTP_PORT = String(smtpTrap.address().port);

const withLogs = async (fn) => {
  const lines = []; const saved = { warn: console.warn, log: console.log, error: console.error };
  console.warn = (...a) => lines.push(a.join(" ")); console.log = (...a) => lines.push(a.join(" ")); console.error = (...a) => lines.push(a.join(" "));
  try { return { result: await fn(), lines }; } finally { Object.assign(console, saved); }
};
const RESEND_ENV = { KOI_EMAIL_TRANSPORT: "resend", RESEND_API_KEY: KEY, MAIL_FROM: "EOI <no-reply@mail.example.test>", RESEND_BASE_URL: BASE };

try {
  // ============================================================================================================ A. configuration
  setEnv({ KOI_EMAIL_TRANSPORT: "resend", RESEND_API_KEY: KEY, MAIL_FROM: "EOI <no-reply@mail.example.test>" });
  const ok = resolveEmailConfig();
  check("A1 resend is selected ONLY by KOI_EMAIL_TRANSPORT=resend; with RESEND_API_KEY + MAIL_FROM it resolves to a complete resend config with no problems and no SMTP", ok.transport === "resend" && ok.problems.length === 0 && ok.smtp === null && ok.resend?.from?.address === "no-reply@mail.example.test" && ok.resend.from.display === "EOI");
  check("A2 the API key is held out of enumeration: JSON.stringify / spread / Object.keys of the resolved config never show it", !JSON.stringify(ok).includes(KEY) && !Object.keys(ok.resend).includes("apiKey") && !JSON.stringify({ ...ok.resend }).includes(KEY) && ok.resend.apiKey === KEY);
  setEnv({ KOI_EMAIL_TRANSPORT: "resend", MAIL_FROM: "EOI <no-reply@mail.example.test>" });
  const noKey = resolveEmailConfig();
  check("A3 a missing key is a problem (no transport, never a half-configured one)", noKey.problems.some((p) => /RESEND_API_KEY is required/.test(p)) && noKey.resend === null);
  setEnv({ KOI_EMAIL_TRANSPORT: "resend", RESEND_API_KEY: "hunter2-not-a-resend-key", MAIL_FROM: "no-reply@mail.example.test" });
  const badKey = resolveEmailConfig();
  check("A4 a value that is not a Resend key (for example a pasted Gmail password) is refused, and the message never echoes it", badKey.problems.some((p) => /not a Resend API key/.test(p)) && !JSON.stringify(badKey).includes("hunter2"));
  setEnv({ KOI_EMAIL_TRANSPORT: "resend", RESEND_API_KEY: KEY });
  check("A5 a missing or invalid MAIL_FROM is a problem", resolveEmailConfig().problems.some((p) => /MAIL_FROM/.test(p)));
  setEnv({ KOI_EMAIL_TRANSPORT: "resend", RESEND_API_KEY: KEY, MAIL_FROM: "bad\r\nBcc: x@y.test" });
  check("A6 a MAIL_FROM with a header-injection attempt is refused", resolveEmailConfig().problems.some((p) => /MAIL_FROM/.test(p)));
  setEnv({ KOI_EMAIL_TRANSPORT: "resend", RESEND_API_KEY: KEY, MAIL_FROM: "no-reply@mail.example.test", SMTP_HOST: "smtp.example.invalid", SMTP_PORT: "587", SMTP_USER: "u" });
  check("A7 an explicit resend wins over leftover SMTP variables (the old Gmail settings need not be removed), and no SMTP problem is raised", resolveEmailConfig().transport === "resend" && resolveEmailConfig().problems.length === 0);
  setEnv({ SMTP_HOST: "smtp.example.invalid", SMTP_PORT: "587", SMTP_USER: "u", SMTP_PASSWORD: "p", MAIL_FROM: "no-reply@mail.example.test", RESEND_API_KEY: KEY });
  check("A8 UNCHANGED: with no KOI_EMAIL_TRANSPORT, SMTP_HOST still implies smtp (a RESEND_API_KEY alone never switches the transport)", resolveEmailConfig().transport === "smtp");
  setEnv({ RESEND_API_KEY: KEY, MAIL_FROM: "no-reply@mail.example.test" });
  check("A9 UNCHANGED: nothing configured means no transport", resolveEmailConfig().transport === "none");
  setEnv({ KOI_EMAIL_TRANSPORT: "carrier-pigeon" });
  check("A10 an unknown transport name is a problem naming the three valid ones", resolveEmailConfig().problems.some((p) => /smtp, resend or outbox/.test(p)));
  setEnv({ KOI_EMAIL_TRANSPORT: "outbox" });
  check("A11 UNCHANGED: the development outbox exists only in development/test", resolveEmailConfig().transport === "outbox");

  const savedNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    setEnv({ KOI_EMAIL_TRANSPORT: "resend", RESEND_API_KEY: KEY, MAIL_FROM: "EOI <no-reply@mail.example.test>" });
    check("A12 PRODUCTION accepts a complete resend configuration without any SMTP variable (and still requires an https, non-localhost CLIENT_URL)", emailStartupProblems({ clientUrl: "https://app.example.com" }).fatal.length === 0 && emailStartupProblems({ clientUrl: "http://app.example.com" }).fatal.some((m) => /https/.test(m)) && emailStartupProblems({ clientUrl: "https://localhost" }).fatal.some((m) => /localhost/.test(m)));
    setEnv({ KOI_EMAIL_TRANSPORT: "resend", MAIL_FROM: "no-reply@mail.example.test" });
    check("A13 PRODUCTION refuses to start on resend without the key", emailStartupProblems({ clientUrl: "https://app.example.com" }).fatal.some((m) => /RESEND_API_KEY is required/.test(m)));
    setEnv({ MAIL_FROM: "no-reply@mail.example.test" });
    const none = emailStartupProblems({ clientUrl: "https://app.example.com" }).fatal;
    check("A14 PRODUCTION with no transport still refuses to start, and the message now names both real options", none.some((m) => /requires KOI_EMAIL_TRANSPORT=smtp/.test(m) && /KOI_EMAIL_TRANSPORT=resend/.test(m)));
    setEnv({ KOI_EMAIL_TRANSPORT: "outbox" });
    check("A15 UNCHANGED: the outbox is still refused in production", emailStartupProblems({ clientUrl: "https://app.example.com" }).fatal.length > 0 && resolveEmailConfig().transport === "none");
    setEnv({ SMTP_HOST: "smtp.example.invalid", SMTP_PORT: "587", SMTP_USER: "u", SMTP_PASSWORD: "p", MAIL_FROM: "no-reply@mail.example.test" });
    check("A16 UNCHANGED: a complete SMTP configuration is still accepted in production", emailStartupProblems({ clientUrl: "https://app.example.com" }).fatal.length === 0);
  } finally { process.env.NODE_ENV = savedNodeEnv; }

  // ============================================================================================================ B. delivery through the SDK
  setEnv({ ...RESEND_ENV, SMTP_HOST: "127.0.0.1", SMTP_PORT, SMTP_USER: "u", SMTP_PASSWORD: "p" }); // SMTP variables present on purpose: they must be ignored
  svc.resetEmailTransport();
  check("B1 delivery mode is reported as resend and the service is available", svc.emailDeliveryMode() === "resend" && svc.emailAvailable() === true);
  const link = svc.buildLink("/verify-email", "TOKEN_abc123-_XYZ");
  const message = verifyEmailMessage({ name: "Priya Sharma", link });
  requests.length = 0; mode = "ok";
  const sent = await svc.sendEmail({ to: "person@example.test", kind: "verify_email", link, ...message });
  const req = requests[0];
  check("B2 sendEmail resolves true and makes exactly one HTTPS-API request: POST /emails with the bearer key", sent === true && requests.length === 1 && req.method === "POST" && req.url === "/emails" && req.headers.authorization === `Bearer ${KEY}`, JSON.stringify({ sent, n: requests.length, url: req?.url }));
  check("B3 the payload is the existing message unchanged: from (name + address), to, the same subject, the same plain text AND the same HTML", req.body.from === "EOI <no-reply@mail.example.test>" && JSON.stringify(req.body.to) === JSON.stringify(["person@example.test"]) && req.body.subject === message.subject && req.body.text === message.text && req.body.html === message.html);
  check("B4 the verification link (token inside it) reaches the recipient in both bodies, and nowhere else in the request (no header, no extra field)", req.body.html.includes(encodeURIComponent("TOKEN_abc123-_XYZ")) && req.body.text.includes("TOKEN_abc123-_XYZ") && !JSON.stringify(req.headers).includes("TOKEN_abc123") && Object.keys(req.body).sort().join() === "from,html,subject,text,to");
  setEnv({ ...RESEND_ENV, MAIL_FROM: "EOI, Guest Intelligence <no-reply@mail.example.test>" });
  svc.resetEmailTransport(); requests.length = 0;
  await svc.sendEmail({ to: "person@example.test", kind: "verify_email", link, ...message });
  check("B5 a sender name with punctuation is quoted so it cannot be read as two addresses", requests[0]?.body?.from === '"EOI, Guest Intelligence" <no-reply@mail.example.test>', requests[0]?.body?.from);
  setEnv({ ...RESEND_ENV, MAIL_FROM: "no-reply@mail.example.test" });
  svc.resetEmailTransport(); requests.length = 0;
  await svc.sendEmail({ to: "person@example.test", kind: "verify_email", link, ...message });
  check("B6 a bare-address sender is sent as a bare address", requests[0]?.body?.from === "no-reply@mail.example.test");
  setEnv({ ...RESEND_ENV, RESEND_API_KEY: OTHER_KEY });
  svc.resetEmailTransport(); requests.length = 0;
  await svc.sendEmail({ to: "person@example.test", kind: "verify_email", link, ...message });
  check("B7 changing the key in the environment is picked up on the next send (client cache is keyed on the key)", requests[0]?.headers?.authorization === `Bearer ${OTHER_KEY}`);
  setEnv(RESEND_ENV); svc.resetEmailTransport();
  const reset = await svc.sendEmail({ to: "person@example.test", kind: "reset_password", link: svc.buildLink("/reset-password", "T2"), ...(await import("../src/services/emailTemplates.js")).resetPasswordMessage({ name: "Priya", link: svc.buildLink("/reset-password", "T2") }) });
  const exists = await svc.sendEmail({ to: "person@example.test", kind: "account_exists", link: svc.buildLink("/forgot-password", ""), ...(await import("../src/services/emailTemplates.js")).accountExistsMessage({ link: svc.buildLink("/forgot-password", "") }) });
  check("B8 the other two transactional emails (password reset, account-exists) go through the same transport", reset === true && exists === true);

  // ============================================================================================================ C. no SMTP in resend mode
  check("C1 with SMTP_HOST/SMTP_PORT present and a listener on that port, the sends above opened ZERO SMTP connections", smtpHits === 0, `hits ${smtpHits}`);
  const probe = await svc.verifySmtpConnection();
  check("C2 the start-up SMTP probe does not apply to resend (checked: false) and still makes no connection", probe.checked === false && smtpHits === 0);

  // ============================================================================================================ D. failures
  const failureCase = async (label, m, expectStatus, expectClass) => {
    mode = m; requests.length = 0;
    const { result, lines } = await withLogs(() => svc.sendEmail({ to: "victim@example.test", kind: "verify_email", link, ...message }));
    const text = lines.join("\n");
    check(`D ${label}: sendEmail resolves false (never throws); the log line names the transport, class and status; it holds no key, address, link, token or page text`,
      result === false && /transport resend/.test(text) && text.includes(expectClass) && (expectStatus === null || text.includes(`status ${expectStatus}`)) && !text.includes(KEY) && !text.includes("victim@example.test") && !text.includes("TOKEN_abc123") && !/verify-email/.test(text) && !/<html/i.test(text) && !/Bearer/i.test(text), text.slice(0, 300));
    return text;
  };
  setEnv(RESEND_ENV); svc.resetEmailTransport();
  await failureCase("invalid API key (401)", "invalid_key", 401, "INVALID_API_KEY");
  const unverified = await failureCase("unverified domain (403) with an address, a URL and the key echoed in the provider's message", "unverified_domain", 403, "VALIDATION_ERROR");
  check("D1 the provider's message is kept ONLY in redacted form (domain-not-verified stays diagnosable; address, URL and key are replaced)", /not verified/.test(unverified) && /\[address\]/.test(unverified) && /\[url\]/.test(unverified) && /\[key\]/.test(unverified) && !unverified.includes("resend.com/domains/abcdef"));
  await failureCase("rate limit (429)", "rate", 429, "RATE_LIMIT_EXCEEDED");
  const html500 = await failureCase("HTML error page (500)", "html500", null, "");
  check("D2 a non-JSON error body does not crash the transport or leak the page", !/Bad gateway/.test(html500));
  await failureCase("an error name that is not an identifier", "weird_name", 422, "SOME_WEIRD_NAME_");
  setEnv({ ...RESEND_ENV, RESEND_BASE_URL: "http://127.0.0.1:1" }); svc.resetEmailTransport();
  const { result: refused, lines: refusedLines } = await withLogs(() => svc.sendEmail({ to: "victim@example.test", kind: "verify_email", link, ...message }));
  check("D3 an unreachable API (connection refused) also resolves false without a throw or a leak", refused === false && !refusedLines.join("\n").includes(KEY) && !refusedLines.join("\n").includes("victim@example.test"));
  setEnv(RESEND_ENV); svc.resetEmailTransport(); svc.setResendTimeoutForTests(400); mode = "hang";
  const started = Date.now();
  const { result: timedOut, lines: timeoutLines } = await withLogs(() => svc.sendEmail({ to: "victim@example.test", kind: "verify_email", link, ...message }));
  svc.setResendTimeoutForTests(0);
  check("D4 an API that never answers is cut off by the timeout (sendEmail resolves false, class ETIMEDOUT) instead of holding the sign-up request", timedOut === false && Date.now() - started < 5000 && timeoutLines.join("\n").includes("ETIMEDOUT"), `${Date.now() - started} ms`);
  mode = "ok";
  setEnv({ KOI_EMAIL_TRANSPORT: "resend", MAIL_FROM: "no-reply@mail.example.test" }); svc.resetEmailTransport();
  check("D5 a half-configured resend (no key) is NO transport: nothing is sent, emailAvailable() is false, the delivery mode is none", svc.emailAvailable() === false && svc.emailDeliveryMode() === "none" && (await svc.sendEmail({ to: "x@example.test", kind: "verify_email", link, ...message })) === false);

  // ============================================================================================================ E. static
  const svcSrc = read(path.join(BACKEND, "src", "services", "emailService.js"));
  const cfgSrc = read(path.join(BACKEND, "src", "config", "emailConfig.js"));
  const code = (s) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  check("E1 no API key or credential is hard-coded anywhere in the email code, config or template (no re_ literal, no secret-shaped string)", ![svcSrc, cfgSrc, read(path.join(BACKEND, "src", "services", "emailTemplates.js"))].some((s) => /re_[A-Za-z0-9]{12,}/.test(code(s)) || /AIza|GOCSPX|-----BEGIN/.test(s)));
  check("E2 the code never logs the key, a body, an address or a link: the only log call in sendEmail prints the kind, transport, class, status and the redacted detail", !/console\.\w+\([^)]*(apiKey|resend\.apiKey|html|text|link|to\b)/.test(code(svcSrc).split("export async function sendEmail")[1]?.split("export async function verifySmtpConnection")[0] ?? "x") && /redactDetail/.test(svcSrc));
  check("E3 SMTP/Nodemailer is retained for development and other hosts (the SMTP transport and the start-up probe are still there)", /nodemailer\.createTransport/.test(svcSrc) && /export async function verifySmtpConnection/.test(svcSrc));
  const pkg = JSON.parse(read(path.join(BACKEND, "package.json")));
  check("E4 `resend` is a dependency of the backend, alongside the retained nodemailer", /^\^?6\./.test(pkg.dependencies.resend ?? "") && Boolean(pkg.dependencies.nodemailer));
  const envExample = read(path.join(BACKEND, ".env.example"));
  check("E5 .env.example documents KOI_EMAIL_TRANSPORT=resend, RESEND_API_KEY and MAIL_FROM with NO value for the key", /KOI_EMAIL_TRANSPORT=resend/.test(envExample) && /^# RESEND_API_KEY=\s/m.test(envExample) && !/RESEND_API_KEY=re_/.test(envExample));
  const contract = read(path.join(BACKEND, "docs", "PRODUCTION_ENVIRONMENT_CONTRACT.md"));
  check("E6 the production environment contract classifies RESEND_API_KEY (a secret) and the resend transport", /`RESEND_API_KEY`/.test(contract) && /secret/i.test(contract.split("`RESEND_API_KEY`")[1]?.slice(0, 900) ?? ""));
} finally {
  fake.close(); smtpTrap.close();
}
console.log(`\nResend email transport validation: ${passed} passed, ${failed} failed (loopback fake of the Resend API; no real email, no SMTP, no database, no external network)`);
process.exit(failed ? 1 : 0);
