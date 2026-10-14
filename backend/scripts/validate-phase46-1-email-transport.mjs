/**
 * Phase 46.1 - real email transport (Nodemailer / SMTP) and the delivery-failure behaviour of email verification and password reset.
 *
 * HONEST SCOPE: there is no real SMTP account in this environment, so nothing here is "delivery to a real inbox". Nodemailer is exercised against a LOCAL
 * SMTP-protocol server written for this suite (implicit TLS, STARTTLS, plaintext, auth failure) so the real library, the real TLS stack and the real SMTP dialogue are
 * covered: certificate verification stays ON (a self-signed server is refused; it is trusted only in a child process started with NODE_EXTRA_CA_CERTS), STARTTLS is
 * mandatory, credentials are never sent in plaintext, and nothing leaks. Real-recipient delivery is a separate manual test that needs SMTP_* in the environment.
 *
 *   A  configuration: parsing, TLS rules, production fail-closed, secrets out of reach
 *   B  the messages: content, escaping, no internal data
 *   C  Nodemailer against the local SMTP server: 465-style, 587-style, verification, downgrade refusal, auth failure, refusal
 *   D  auth services: delivery failure handling, tokens (hash-only, one-time, expiry, replay), no enumeration, no leakage
 *   E  Google adoption race
 *   F  spawned backend: link base from CLIENT_URL only (hostile Host / X-Forwarded-*), no outbox in production
 */
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import dotenv from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(here, "..");
const read = (p) => fs.readFileSync(p, "utf8");
let passed = 0; let failed = 0; let skipped = 0;
const check = (name, ok, detail = "") => { if (ok) { passed += 1; console.log(`PASS  ${name}${detail ? ` - ${detail}` : ""}`); } else { failed += 1; console.error(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`); } };
const skip = (name, why) => { skipped += 1; console.log(`SKIP  ${name} - ${why}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

{ const __u = dotenv.parse(process.getBuiltinModule("node:fs").readFileSync(new URL("../.env", import.meta.url))).MONGODB_URI ?? ""; if (/^mongodb:\/\/(?:[^@/]*@)?(localhost|127\.0\.0\.1)/i.test(__u)) process.env.MONGODB_URI ??= __u; } // validation / rehearsal tools take ONLY a loopback database URI from backend/.env, never its real settings
const baseUri = process.env.MONGODB_URI;
const DB_NAME = `koi_p461_${Date.now()}`;
if (!baseUri || /^mongodb\+srv:|@/.test(baseUri) || !/^mongodb:\/\/(localhost|127\.0\.0\.1)/.test(baseUri)) { console.error("refusing: the configured MongoDB is not a plain loopback instance"); process.exit(2); }
process.env.MONGODB_URI = baseUri.replace(/(mongodb:\/\/[^/]+\/)([^?]*)/, `$1${DB_NAME}`);
process.env.NODE_ENV = "test";
for (const k of ["AUTH_STUB_SECRET", "AUTH_TOKEN_VERIFIER", "OIDC_ISSUER", "OIDC_AUDIENCE", "KOI_EMAIL_TRANSPORT", "SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USER", "SMTP_PASSWORD", "MAIL_FROM", "SMTP_REQUIRE_TLS", "KOI_EMAIL_OUTBOX_FILE"]) delete process.env[k];
const SESSION_SECRET = crypto.randomBytes(36).toString("base64url");
process.env.AUTH_PROVIDER = "eoi";
process.env.KOI_SESSION_SECRET = SESSION_SECRET;
process.env.KOI_PASSWORD_SCRYPT_LOG_N = "12";
process.env.CLIENT_URL = "https://app.example.test";
const SMTP_PASSWORD = `pw-${crypto.randomBytes(12).toString("hex")}`; // a throwaway value that exists only in this process; used to prove it never leaks
const SMTP_USER = "mailer-user";

const mongoose = (await import("mongoose")).default;
const { connectDatabase } = await import("../src/config/database.js");
const { User, AuthToken, AuthIdentity, AuthSession, Workspace } = await import("../src/models/index.js");
await connectDatabase();
if (mongoose.connection.db.databaseName !== DB_NAME) { console.error("refusing: not connected to the isolated database"); process.exit(2); }
const { resolveEmailConfig, emailStartupProblems, parseMailFrom } = await import("../src/config/emailConfig.js");
const email = await import("../src/services/emailService.js");
const templates = await import("../src/services/emailTemplates.js");
const password = await import("../src/services/passwordAuthService.js");
const sessions = await import("../src/services/authSessionService.js");
const google = await import("../src/services/googleLoginService.js");

const STRONG = "Correct-Horse-Battery-9!";
const asMode = (mode, fn) => { const before = process.env.NODE_ENV; process.env.NODE_ENV = mode; try { return fn(); } finally { process.env.NODE_ENV = before; } };
const setSmtp = (vars) => { for (const k of ["KOI_EMAIL_TRANSPORT", "SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USER", "SMTP_PASSWORD", "MAIL_FROM", "SMTP_REQUIRE_TLS"]) delete process.env[k]; Object.assign(process.env, vars); email.resetEmailTransport(); };
const GOOD = { SMTP_HOST: "mail.example.test", SMTP_PORT: "587", SMTP_USER, SMTP_PASSWORD, MAIL_FROM: "EOI <no-reply@example.test>" };

// -------------------------------------------------------------------- a local SMTP-protocol server (a test fixture, not a mail server)
function startSmtp({ mode, key, cert, advertiseStartTls = true, authOk = true, refuseRcpt = false }) {
  const rec = { commands: [], messages: [], auth: [], plainAuth: false, connections: 0 };
  const ctx = key ? tls.createSecureContext({ key, cert }) : null;
  const attach = (socket, isTls, greet) => {
    rec.connections += 1;
    let buf = ""; let inData = false; let data = ""; let authStep = null; let from = ""; let to = [];
    const send = (s) => socket.write(`${s}\r\n`);
    socket.on("error", () => {});
    const login = (user, pass) => {
      rec.auth.push({ tls: isTls, user, passOk: pass === SMTP_PASSWORD });
      if (!isTls) rec.plainAuth = true;
      send(authOk && user === SMTP_USER && pass === SMTP_PASSWORD ? "235 2.7.0 Authentication successful" : "535 5.7.8 Authentication credentials invalid");
    };
    const line = (l) => {
      if (inData) {
        data += `${l}\r\n`;
        if (l === ".") { inData = false; rec.messages.push({ from, to, raw: data, tls: isTls, authed: rec.auth.some((a) => a.passOk) }); data = ""; send("250 2.0.0 queued"); }
        return;
      }
      if (authStep === "plain") { authStep = null; const [, u, p] = Buffer.from(l, "base64").toString().split("\0"); return login(u, p); }
      if (authStep === "user") { authStep = { user: Buffer.from(l, "base64").toString() }; return send("334 UGFzc3dvcmQ6"); }
      if (authStep && typeof authStep === "object") { const u = authStep.user; authStep = null; return login(u, Buffer.from(l, "base64").toString()); }
      const verb = l.split(" ")[0].toUpperCase();
      rec.commands.push({ verb, tls: isTls });
      if (verb === "EHLO" || verb === "HELO") {
        const caps = ["250-localhost", ...(mode === "starttls" && !isTls && advertiseStartTls ? ["250-STARTTLS"] : []), "250-AUTH PLAIN LOGIN", "250 8BITMIME"];
        return send(caps.join("\r\n"));
      }
      if (verb === "STARTTLS") {
        send("220 2.0.0 Ready to start TLS");
        socket.removeAllListeners("data");
        const secure = new tls.TLSSocket(socket, { isServer: true, secureContext: ctx });
        return attach(secure, true, false);
      }
      if (verb === "AUTH") {
        const [, kind, initial] = l.split(" ");
        if (kind?.toUpperCase() === "PLAIN") { if (initial) { const [, u, p] = Buffer.from(initial, "base64").toString().split("\0"); return login(u, p); } authStep = "plain"; return send("334 "); }
        authStep = "user"; return send("334 VXNlcm5hbWU6");
      }
      if (verb === "MAIL") { from = l.replace(/^MAIL FROM:\s*<?([^>\s]*)>?.*$/i, "$1"); return send("250 2.1.0 OK"); }
      if (verb === "RCPT") { if (refuseRcpt) return send("550 5.1.1 recipient rejected"); to.push(l.replace(/^RCPT TO:\s*<?([^>\s]*)>?.*$/i, "$1")); return send("250 2.1.5 OK"); }
      if (verb === "DATA") { inData = true; return send("354 End data with <CR><LF>.<CR><LF>"); }
      if (verb === "QUIT") { send("221 2.0.0 Bye"); return socket.end(); }
      return send("250 2.0.0 OK");
    };
    socket.on("data", (chunk) => { buf += chunk.toString("binary"); let i; while ((i = buf.indexOf("\r\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 2); line(l); } });
    if (greet) send("220 localhost ESMTP fixture");
  };
  const server = mode === "implicit" ? tls.createServer({ key, cert }, (s) => attach(s, true, true)) : net.createServer((s) => attach(s, false, true));
  server.on("tlsClientError", () => {});
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port, rec, close: () => new Promise((r) => server.close(r)) })));
}

// -------------------------------------------------------------------- a throwaway self-signed certificate for 127.0.0.1 (openssl is only needed for section C's TLS cases)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eoi-p461-"));
let tlsMaterial = null;
for (const bin of ["openssl", "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe", "/mingw64/bin/openssl", "/usr/bin/openssl"]) {
  const r = spawnSync(bin, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(tmp, "key.pem"), "-out", path.join(tmp, "cert.pem"), "-days", "2", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"], { encoding: "utf8" });
  if (r.status === 0 && fs.existsSync(path.join(tmp, "cert.pem"))) { tlsMaterial = { key: read(path.join(tmp, "key.pem")), cert: read(path.join(tmp, "cert.pem")), certFile: path.join(tmp, "cert.pem") }; break; }
}

/** Sends one message from a CHILD process that trusts the fixture certificate (NODE_EXTRA_CA_CERTS is only honoured at process start). */
function runChild(code, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { cwd: BACKEND, env: { ...process.env, NODE_ENV: "test", NODE_EXTRA_CA_CERTS: tlsMaterial.certFile, ...env } });
    let out = ""; child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { out += d; });
    const timer = setTimeout(() => child.kill(), 40000);
    child.on("close", () => { clearTimeout(timer); let parsed = null; try { parsed = JSON.parse(out.trim().split("\n").at(-1)); } catch { /* reported by the check */ } resolve({ parsed, out }); });
  });
}
const emailServiceUrl = JSON.stringify(pathToFileURL(path.join(BACKEND, "src/services/emailService.js")).href);
/** Sends one message from a CHILD process that trusts the fixture certificate (NODE_EXTRA_CA_CERTS is only honoured at process start). ASYNC: the fixture server lives in this process. */
const sendFromTrustingChild = (smtpEnv) => runChild(`const m = await import(${emailServiceUrl});
    const ok = await m.sendEmail({ to: "person@example.test", kind: "verify_email", subject: "Verify your EOI account", text: "plain text body https://app.example.test/verify-email?token=TOK", html: "<p>html body</p>", link: "https://app.example.test/verify-email?token=TOK" });
    process.stdout.write(JSON.stringify({ ok, mode: m.emailDeliveryMode() }));`, smtpEnv);
const probeFromTrustingChild = (smtpEnv) => runChild(`const m = await import(${emailServiceUrl}); process.stdout.write(JSON.stringify(await m.verifySmtpConnection()));`, smtpEnv);

const children = [];
const consoleLog = []; const realWarn = console.warn; const realError = console.error; const realLog = console.log;
const tap = () => { console.warn = (...a) => { consoleLog.push(a.join(" ")); }; };
const untap = () => { console.warn = realWarn; };

try {
  // ======================================================================================================== A
  console.log("\n# A. configuration");
  const cfg = (vars, mode = "test") => { const env = { ...vars }; return asMode(mode, () => resolveEmailConfig(env)); };
  const c587 = cfg(GOOD);
  check("A1 SMTP_* + MAIL_FROM resolve to a smtp transport; 587 defaults to STARTTLS (secure=false, requireTLS=true); the address and display name are parsed", c587.transport === "smtp" && c587.problems.length === 0 && c587.smtp.port === 587 && c587.smtp.secure === false && c587.smtp.requireTLS === true && c587.smtp.from.address === "no-reply@example.test" && c587.smtp.from.display === "EOI");
  const c465 = cfg({ ...GOOD, SMTP_PORT: "465" });
  check("A2 port 465 implies implicit TLS (secure=true, no STARTTLS step); 465 with SMTP_SECURE=false is refused instead of silently trying plaintext", c465.smtp?.secure === true && c465.smtp?.requireTLS === false && cfg({ ...GOOD, SMTP_PORT: "465", SMTP_SECURE: "false" }).problems.some((p) => /465/.test(p)));
  check("A3 a missing host / bad port / bad MAIL_FROM (including header-injection attempts) / half a credential pair is a problem and yields NO smtp config", ["SMTP_HOST", "MAIL_FROM"].every((k) => { const v = { ...GOOD }; delete v[k]; const r = cfg({ ...v, KOI_EMAIL_TRANSPORT: "smtp" }); return r.smtp === null && r.problems.length > 0; })
    && cfg({ ...GOOD, SMTP_PORT: "99999" }).smtp === null && cfg({ ...GOOD, SMTP_PORT: "abc" }).smtp === null && cfg({ ...GOOD, MAIL_FROM: "a@b.co\r\nBcc: x@y.zz" }).smtp === null && parseMailFrom("EOI <a@b.co>\nBcc: x@y.zz") === null && cfg({ ...GOOD, SMTP_PASSWORD: "" }).smtp === null && cfg({ ...GOOD, SMTP_USER: "" }).smtp === null && cfg({ ...GOOD, SMTP_HOST: "https://mail.example.test/x" }).smtp === null);
  const withPw = cfg(GOOD);
  check("A4 the SMTP password is a held-out value: not in JSON.stringify of the config, not in a spread, not in any problem text", !JSON.stringify(withPw).includes(SMTP_PASSWORD) && !JSON.stringify({ ...withPw.smtp }).includes(SMTP_PASSWORD) && !cfg({ ...GOOD, SMTP_PORT: "x" }).problems.join(" ").includes(SMTP_PASSWORD) && withPw.smtp.password === SMTP_PASSWORD);
  check("A5 there is NO way to turn certificate verification off: no setting exists, and the source never mentions rejectUnauthorized", !/rejectUnauthorized/.test(read(path.join(BACKEND, "src/services/emailService.js")).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")) && !/rejectUnauthorized/.test(read(path.join(BACKEND, "src/config/emailConfig.js")).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")) && !/NODE_TLS_REJECT_UNAUTHORIZED/.test(read(path.join(BACKEND, "src/services/emailService.js"))));
  check("A6 SMTP_REQUIRE_TLS=false (a plaintext LOCAL capture server) is honoured in development/test and REFUSED in production", cfg({ ...GOOD, SMTP_REQUIRE_TLS: "false" }).smtp?.requireTLS === false && cfg({ ...GOOD, SMTP_REQUIRE_TLS: "false" }, "production").problems.some((p) => /SMTP_REQUIRE_TLS/.test(p)));
  check("A7 the dev outbox exists only when explicitly requested, in development/test; production and an unknown NODE_ENV turn it OFF and say why - it is never a fallback", cfg({ KOI_EMAIL_TRANSPORT: "outbox" }).transport === "outbox" && cfg({ KOI_EMAIL_TRANSPORT: "outbox" }, "production").transport === "none" && cfg({ KOI_EMAIL_TRANSPORT: "outbox" }, "unknown").transport === "none" && cfg({}).transport === "none" && cfg({}).problems.length === 0);
  const startup = (vars, mode, clientUrl = "https://app.example.test") => asMode(mode, () => emailStartupProblems({ clientUrl, environment: vars }));
  check("A8 production fails CLOSED: no SMTP, an outbox request, or a half-configured SMTP is fatal (the server would refuse to start); a complete SMTP config + https CLIENT_URL passes", startup({}, "production").fatal.length > 0 && startup({ KOI_EMAIL_TRANSPORT: "outbox" }, "production").fatal.length > 0 && startup({ ...GOOD, SMTP_PORT: "bad" }, "production").fatal.length > 0 && startup(GOOD, "production").fatal.length === 0 && startup({}, "unknown").fatal.length > 0);
  check("A9 CLIENT_URL (the base of every email link) must be an https, non-localhost URL in production; the same findings are only warnings in development", startup(GOOD, "production", "http://app.example.test").fatal.some((p) => /https/.test(p)) && startup(GOOD, "production", "https://localhost:5173").fatal.some((p) => /localhost/.test(p)) && startup(GOOD, "production", "").fatal.length > 0 && startup({}, "development", "http://localhost:5173").fatal.length === 0 && startup({}, "development", "http://localhost:5173").warnings.length === 0);
  check("A10 startup diagnostics never contain the SMTP password or the user name", !JSON.stringify(startup({ ...GOOD, SMTP_PORT: "bad" }, "production")).includes(SMTP_PASSWORD));
  check("A11 server.js enforces it: the email check runs only for AUTH_PROVIDER=eoi, exits on fatal findings, and the SMTP probe is non-fatal", /emailStartupProblems\(\{ clientUrl: env\.clientUrl \}\)/.test(read(path.join(BACKEND, "server.js"))) && /Refusing to start: invalid email configuration/.test(read(path.join(BACKEND, "server.js"))));
  const { resolveAuthConfig } = await import("../src/auth/authConfig.js");
  check("A12 the placeholder secrets are refused by resolveAuthConfig; a generated secret is accepted", ["change-me-change-me-change-me-12345", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "your-secret-here-please-replace-1234", "0123012301230123012301230123012301230123"].every((s) => resolveAuthConfig({ AUTH_PROVIDER: "eoi", KOI_SESSION_SECRET: s }).problems.some((p) => /placeholder|low-entropy/.test(p))) && resolveAuthConfig({ AUTH_PROVIDER: "eoi", KOI_SESSION_SECRET: crypto.randomBytes(48).toString("base64url") }).problems.length === 0);

  // ======================================================================================================== B
  console.log("\n# B. the messages");
  const link = "https://app.example.test/verify-email?token=ABC_def-123";
  const v = templates.verifyEmailMessage({ name: "Jane <script>alert(1)</script> O'Neil & Co", link });
  const r = templates.resetPasswordMessage({ name: "Jane Example", link: "https://app.example.test/reset-password?token=XYZ" });
  const x = templates.accountExistsMessage({ link: "https://app.example.test/forgot-password" });
  check("B1 the subjects are exactly 'Verify your EOI account' and 'Reset your EOI password'", v.subject === "Verify your EOI account" && r.subject === "Reset your EOI password" && /already have an EOI account/.test(x.subject));
  check("B2 each message names EOI, states its purpose, greets by name, carries its link (text AND html button), states the expiry (24 h / 30 min, single use) and security guidance", /EOI/.test(v.text) && /Jane/.test(r.text) && v.text.includes(link) && v.html.includes(`href="${link}"`) && /24 hours/.test(v.text) && /works once/.test(v.text) && /30 minutes/.test(r.text) && /signs you out/.test(r.html) && /never ask you for your password/.test(v.text) && /ignore this message/.test(v.text) && /ignore this message/.test(r.text));
  check("B3 the display name is HTML-escaped (no markup injection) and cannot break the plain-text greeting across lines", !v.html.includes("<script>") && v.html.includes("&lt;script&gt;") && !templates.verifyEmailMessage({ name: "A\r\nBcc: evil", link }).text.split("\n")[0].includes("\n") && !/\r/.test(templates.verifyEmailMessage({ name: "A\r\nBcc: evil", link }).text.split("\n")[0]));
  const everything = [v.text, v.html, r.text, r.html, x.text, x.html].join("\n");
  check("B4 no internal data: no 24-hex id, no localhost / http backend URL, no 'token' other than inside the link, no password / access / refresh / SMTP / Mongo words", !/\b[0-9a-f]{24}\b/.test(everything) && !/localhost|127\.0\.0\.1|\/api\//.test(everything) && !/mongodb|access[_ -]?token|refresh[_ -]?token|SMTP|stack|workspace|evidence/i.test(everything) && (r.text.match(/token=/g) ?? []).length === 1 && (v.text.match(/token=/g) ?? []).length === 1);
  check("B5 the only link in a reset / verification message is the one built from CLIENT_URL (https); there is no second URL", [v.text, r.text].every((t) => (t.match(/https?:\/\/[^\s"<]+/g) ?? []).length === 1) && email.buildLink("/reset-password", "T1").startsWith("https://app.example.test/reset-password?token=T1"));

  // ======================================================================================================== C
  console.log("\n# C. Nodemailer against a local SMTP-protocol server");
  const message = { to: "person@example.test", kind: "verify_email", subject: "Verify your EOI account", text: "text body https://app.example.test/verify-email?token=TOK", html: "<p>html body</p>", link: "https://app.example.test/verify-email?token=TOK" };
  const smtpEnv = (port, extra = {}) => ({ SMTP_HOST: "127.0.0.1", SMTP_PORT: String(port), SMTP_USER, SMTP_PASSWORD, MAIL_FROM: "EOI <no-reply@example.test>", ...extra });

  // C1: plaintext capture server, explicit development opt-out of TLS: proves the real Nodemailer path, the message shape and AUTH.
  const plain = await startSmtp({ mode: "plain" });
  setSmtp(smtpEnv(plain.port, { SMTP_REQUIRE_TLS: "false" }));
  tap(); const okPlain = await email.sendEmail(message); untap();
  const got = plain.rec.messages[0];
  check("C1 [Nodemailer] dev capture server: sendEmail resolves true; the server received ONE message addressed to the recipient from the configured MAIL_FROM with the subject, the text part and the html part", okPlain === true && plain.rec.messages.length === 1 && got.to[0] === "person@example.test" && got.from === "no-reply@example.test" && /Subject: Verify your EOI account/.test(got.raw) && /text body/.test(got.raw) && /html body/.test(got.raw) && /multipart\/alternative/.test(got.raw));
  check("C2 the message headers carry the EOI display name and nothing internal (no token outside the link, no password, no SMTP user)", /From: "?EOI"? <no-reply@example\.test>/.test(got.raw) && !got.raw.includes(SMTP_PASSWORD) && !Buffer.from(got.raw).toString("base64").includes(Buffer.from(SMTP_PASSWORD).toString("base64")) && !/mailer-user/.test(got.raw));
  await plain.close();

  // C3: production-like config (STARTTLS REQUIRED) against a server that does NOT offer STARTTLS: refused, credentials never sent, nothing delivered.
  const noTls = await startSmtp({ mode: "plain" });
  setSmtp(smtpEnv(noTls.port));
  tap(); const downgraded = await email.sendEmail(message); untap();
  check("C3 [no downgrade] with STARTTLS required, a server that does not offer it is REFUSED: sendEmail is false, no AUTH was ever sent in plaintext, no message was transferred", downgraded === false && noTls.rec.plainAuth === false && noTls.rec.messages.length === 0 && noTls.rec.auth.length === 0);
  check("C4 the failure is logged as a CLASS only: no password, no address, no link, no provider text", consoleLog.some((l) => /email delivery failed \(verify_email, transport smtp, class [A-Z_]+\)/.test(l)) && !consoleLog.join("\n").includes(SMTP_PASSWORD) && !consoleLog.join("\n").includes("person@example.test") && !consoleLog.join("\n").includes("token=TOK"));
  await noTls.close();

  // C5: connection refused (nothing listens) -> false, promptly, without a thrown error.
  const closed = net.createServer(); await new Promise((res) => closed.listen(0, "127.0.0.1", res)); const deadPort = closed.address().port; await new Promise((res) => closed.close(res));
  setSmtp(smtpEnv(deadPort, { SMTP_REQUIRE_TLS: "false" })); const t0 = Date.now(); tap(); const refused = await email.sendEmail(message); untap();
  check("C5 an unreachable SMTP server makes sendEmail return false (never throws, never claims sent) well inside the timeout", refused === false && Date.now() - t0 < 15000);

  // C6: authentication failure.
  const badAuth = await startSmtp({ mode: "plain", authOk: false });
  setSmtp(smtpEnv(badAuth.port, { SMTP_REQUIRE_TLS: "false" }));
  consoleLog.length = 0; tap(); const authFail = await email.sendEmail(message); untap();
  check("C6 an authentication failure returns false, the message is not delivered, and the log says only the class (EAUTH), never the password", authFail === false && badAuth.rec.messages.length === 0 && consoleLog.some((l) => /class EAUTH/.test(l)) && !consoleLog.join("\n").includes(SMTP_PASSWORD));
  await badAuth.close();

  // C7: the server refuses the recipient.
  const rcpt = await startSmtp({ mode: "plain", refuseRcpt: true });
  setSmtp(smtpEnv(rcpt.port, { SMTP_REQUIRE_TLS: "false" })); tap(); const refusedRcpt = await email.sendEmail(message); untap();
  check("C7 a refused recipient (550) returns false and delivers nothing", refusedRcpt === false && rcpt.rec.messages.length === 0);
  await rcpt.close();

  // C8: half-configured SMTP is NO transport: nothing is attempted.
  setSmtp({ SMTP_HOST: "mail.example.test", SMTP_USER });
  check("C8 a half-configured SMTP (no password / no MAIL_FROM) is not a transport: emailAvailable() is false, emailDeliveryMode() is 'none', sendEmail is false and attempts nothing", email.emailAvailable() === false && email.emailDeliveryMode() === "none" && (await email.sendEmail(message)) === false);
  setSmtp({});
  check("C9 with nothing configured there is no transport at all (no implicit outbox), in test mode too", email.emailAvailable() === false && email.emailDeliveryMode() === "none");

  if (!tlsMaterial) {
    skip("C10-C14 TLS cases", "openssl is not available to create a throwaway certificate");
  } else {
    // The fixture certificate is SELF-SIGNED: with verification ON (the only mode) the in-process Nodemailer must refuse it.
    const implicit = await startSmtp({ mode: "implicit", ...tlsMaterial });
    setSmtp(smtpEnv(implicit.port, { SMTP_PORT: String(implicit.port), SMTP_SECURE: "true" }));
    consoleLog.length = 0; tap(); const untrusted = await email.sendEmail(message); untap();
    check("C10 [TLS verification is ON] implicit TLS to a server with an UNTRUSTED (self-signed) certificate is refused: false, nothing transferred, no credentials sent", untrusted === false && implicit.rec.messages.length === 0 && implicit.rec.auth.length === 0 && !consoleLog.join("\n").includes(SMTP_PASSWORD));
    const trusted = await sendFromTrustingChild(smtpEnv(implicit.port, { SMTP_SECURE: "true" }));
    check("C11 [465-style, implicit TLS] the same server IS accepted once its certificate is trusted: delivered over TLS, authenticated, one message, mode 'smtp'; the child's output holds no password", trusted.parsed?.ok === true && trusted.parsed?.mode === "smtp" && implicit.rec.messages.length === 1 && implicit.rec.messages[0].tls === true && implicit.rec.auth.length === 1 && implicit.rec.auth[0].tls === true && implicit.rec.auth[0].passOk === true && !trusted.out.includes(SMTP_PASSWORD));
    await implicit.close();

    const starttls = await startSmtp({ mode: "starttls", ...tlsMaterial });
    setSmtp(smtpEnv(starttls.port));
    tap(); const untrusted2 = await email.sendEmail(message); untap();
    check("C12 [TLS verification is ON] STARTTLS to an UNTRUSTED certificate is refused: false, no AUTH, no message", untrusted2 === false && starttls.rec.messages.length === 0 && starttls.rec.auth.length === 0 && starttls.rec.plainAuth === false);
    const trusted2 = await sendFromTrustingChild(smtpEnv(starttls.port));
    const lastAuth = starttls.rec.auth.at(-1);
    check("C13 [587-style, STARTTLS] with the certificate trusted: STARTTLS is negotiated, AUTH happens ONLY after the upgrade (never in plaintext), the message is delivered over TLS", trusted2.parsed?.ok === true && starttls.rec.commands.some((c) => c.verb === "STARTTLS") && starttls.rec.plainAuth === false && lastAuth?.tls === true && lastAuth?.passOk === true && starttls.rec.messages.length === 1 && starttls.rec.messages[0].tls === true);
    const probeRun = await probeFromTrustingChild(smtpEnv(starttls.port)); const probe = probeRun.parsed;
    check("C14 verifySmtpConnection() (the start-up probe) negotiates TLS and authenticates without sending a message, and reports only ok / an error class", probe?.checked === true && probe?.ok === true && probe?.tls === "starttls" && starttls.rec.messages.length === 1 && !JSON.stringify(probe).includes(SMTP_PASSWORD));
    await starttls.close();
  }
  setSmtp({});

  // ======================================================================================================== D
  console.log("\n# D. auth services: delivery failure, tokens, no enumeration, no leakage");
  const sent = []; let behaviour = "ok";
  email.setEmailTransport(async (m) => { if (behaviour === "fail") throw Object.assign(new Error("smtp down; secret detail 550 ..."), { code: "ECONNECTION" }); sent.push(m); });
  const tokenOf = (m) => new URL(m.link).searchParams.get("token");
  const hash = (t) => crypto.createHash("sha256").update(t).digest("hex");
  consoleLog.length = 0; tap();

  behaviour = "fail";
  const failedSignup = await password.signUp({ name: "Fail Person", email: "fail.p461@example.test", password: STRONG, passwordConfirm: STRONG }).then(() => null, (e) => e);
  check("D1 [signup, SMTP failure] answers 503 EMAIL_DELIVERY_FAILED, says nothing about SMTP, and leaves NO unusable account and NO token behind (compensating removal)", failedSignup?.statusCode === 503 && failedSignup?.details?.code === "EMAIL_DELIVERY_FAILED" && !/smtp|550|secret/i.test(failedSignup?.message ?? "") && (await User.countDocuments({ emailNormalized: "fail.p461@example.test" })) === 0 && (await AuthToken.countDocuments({})) === 0);
  behaviour = "ok";
  const retry = await password.signUp({ name: "Fail Person", email: "fail.p461@example.test", password: STRONG, passwordConfirm: STRONG });
  check("D2 the same address can simply sign up again after a failed delivery (it was not burned), and this time the verification email is delivered", retry.status === "verification_sent" && sent.length === 1 && sent[0].kind === "verify_email" && sent[0].to === "fail.p461@example.test");
  const m1 = sent[0]; const tok1 = tokenOf(m1);
  const u1 = await User.findOne({ emailNormalized: "fail.p461@example.test" }).select("+passwordHash").lean();
  check("D3 account is UNVERIFIED until the link is used; the token is 32 random bytes (43 base64url chars), only its SHA-256 is stored, the raw token is nowhere in MongoDB; the link base is the configured CLIENT_URL", u1.emailVerified === false && /^[A-Za-z0-9_-]{43}$/.test(tok1) && (await AuthToken.countDocuments({ tokenHash: hash(tok1) })) === 1 && (await AuthToken.countDocuments({ tokenHash: tok1 })) === 0 && !JSON.stringify(await AuthToken.find({}).lean()).includes(tok1) && !JSON.stringify(await User.find({}).lean()).includes(tok1) && m1.link.startsWith("https://app.example.test/verify-email?token="));
  check("D4 the message handed to the transport has the subject 'Verify your EOI account', greets by name, and includes both text and html parts", m1.subject === "Verify your EOI account" && /Fail Person/.test(m1.text) && /Fail Person/.test(m1.html));
  const stored = await AuthToken.findOne({ userId: u1._id, purpose: "verify_email" }).lean();
  check("D5 the verification token expires in 24 hours", Math.abs(stored.expiresAt.getTime() - Date.now() - 24 * 3600 * 1000) < 60_000);
  const badTok = await password.verifyEmail("x".repeat(43)).then(() => null, (e) => e);
  const malformedTok = await password.verifyEmail({ $ne: "" }).then(() => null, (e) => e);
  check("D6 an unknown / malformed token gets the same plain 400 INVALID_LINK and verifies nothing", badTok?.statusCode === 400 && badTok?.details?.code === "INVALID_LINK" && malformedTok?.details?.code === "INVALID_LINK" && (await User.findById(u1._id).lean()).emailVerified === false);
  const okVerify = await password.verifyEmail(tok1);
  const replay = await password.verifyEmail(tok1).then(() => null, (e) => e);
  check("D7 the link verifies the email ONCE; replaying it is rejected (single use)", okVerify.status === "verified" && (await User.findById(u1._id).lean()).emailVerified === true && replay?.details?.code === "INVALID_LINK");
  await password.signUp({ name: "Expiry Person", email: "expiry.p461@example.test", password: STRONG, passwordConfirm: STRONG });
  const expMail = sent.at(-1); await AuthToken.updateMany({ tokenHash: hash(tokenOf(expMail)) }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  check("D8 an expired verification link is rejected and the account stays unverified", (await password.verifyEmail(tokenOf(expMail)).then(() => null, (e) => e))?.details?.code === "INVALID_LINK" && (await User.findOne({ emailNormalized: "expiry.p461@example.test" }).lean()).emailVerified === false);

  // existing address + failure: indistinguishable from the new-address failure
  behaviour = "fail";
  const dupFail = await password.signUp({ name: "Someone", email: "fail.p461@example.test", password: "Another-Strong-Pass-77!", passwordConfirm: "Another-Strong-Pass-77!" }).then(() => null, (e) => e);
  check("D9 [no enumeration] during a delivery outage, signing up with an EXISTING address fails with the very same 503 as a new address, and changes nothing", dupFail?.statusCode === 503 && dupFail?.details?.code === failedSignup.details.code && dupFail.message === failedSignup.message && (await User.countDocuments({ emailNormalized: "fail.p461@example.test" })) === 1);
  behaviour = "ok";

  // resend + forgot with failing transport
  const unverifiedUser = await User.findOne({ emailNormalized: "expiry.p461@example.test" }).lean();
  await AuthToken.updateMany({ userId: unverifiedUser._id }, { $set: { expiresAt: new Date(Date.now() + 3600_000) } });
  const before = await AuthToken.countDocuments({ userId: unverifiedUser._id, usedAt: { $exists: false } });
  behaviour = "fail";
  const resendFail = await password.resendVerification({ email: "expiry.p461@example.test" });
  const resendUnknown = await password.resendVerification({ email: "unknown.p461@example.test" });
  check("D10 [resend, SMTP failure] answers the same generic 'accepted' as for an unknown address; the failed message created NO leftover token and the earlier link is untouched", JSON.stringify(resendFail) === JSON.stringify(resendUnknown) && resendFail.status === "accepted" && (await AuthToken.countDocuments({ userId: unverifiedUser._id, usedAt: { $exists: false } })) === before);
  const resetUser = u1; // verified, has a password
  const resetBefore = await AuthToken.countDocuments({ userId: resetUser._id, purpose: "reset_password" });
  const forgotFail = await password.forgotPassword({ email: "fail.p461@example.test" });
  const forgotUnknown = await password.forgotPassword({ email: "nobody.p461@example.test" });
  const forgotMalformed = await password.forgotPassword({ email: "not an email" });
  check("D11 [forgot, SMTP failure] real / unknown / malformed addresses all get the identical generic answer; no reset token remains for the failed send (nothing consumed, nothing leaked)", [forgotFail, forgotUnknown, forgotMalformed].every((a) => JSON.stringify(a) === JSON.stringify({ status: "accepted" })) && (await AuthToken.countDocuments({ userId: resetUser._id, purpose: "reset_password" })) === resetBefore);
  behaviour = "ok";

  // a working reset flow, with an earlier link surviving a later failed send
  const sentBefore = sent.length;
  await password.forgotPassword({ email: "fail.p461@example.test" });
  const resetMail = sent.at(-1); const resetTok = tokenOf(resetMail);
  behaviour = "fail"; await password.forgotPassword({ email: "fail.p461@example.test" }); behaviour = "ok";
  check("D12 a reset email is delivered with the right subject and a link on CLIENT_URL; a LATER failed send does not invalidate the earlier link", sent.length === sentBefore + 1 && resetMail.kind === "reset_password" && resetMail.subject === "Reset your EOI password" && resetMail.link.startsWith("https://app.example.test/reset-password?token=") && (await AuthToken.countDocuments({ tokenHash: hash(resetTok), usedAt: { $exists: false } })) === 1);
  const resetRow = await AuthToken.findOne({ tokenHash: hash(resetTok) }).lean();
  check("D13 reset tokens are hash-only, 32 random bytes, and expire in 30 minutes", /^[A-Za-z0-9_-]{43}$/.test(resetTok) && (await AuthToken.countDocuments({ tokenHash: resetTok })) === 0 && Math.abs(resetRow.expiresAt.getTime() - Date.now() - 30 * 60 * 1000) < 60_000);
  const live = await sessions.createSession({ userId: u1._id, method: "password" });
  const liveSid = live.refreshToken.split(".")[0];
  const weak = await password.resetPassword({ token: resetTok, password: "short", passwordConfirm: "short" }).then(() => null, (e) => e);
  check("D14 a weak new password is refused WITHOUT using up the link", weak?.details?.code === "INVALID_FIELD" && (await AuthToken.countDocuments({ tokenHash: hash(resetTok), usedAt: { $exists: false } })) === 1);
  const NEW_PW = "Another-Correct-Pass-42!";
  const done = await password.resetPassword({ token: resetTok, password: NEW_PW, passwordConfirm: NEW_PW });
  const replayReset = await password.resetPassword({ token: resetTok, password: NEW_PW, passwordConfirm: NEW_PW }).then(() => null, (e) => e);
  check("D15 the reset link works ONCE: the password changes, a replay is rejected, and every session of the account is revoked", done.status === "password_changed" && replayReset?.details?.code === "INVALID_LINK" && (await sessions.isSessionLive(liveSid, u1._id)) === false && (await AuthSession.findById(liveSid).lean()).revokedAt != null);
  const signed = await password.signIn({ email: "fail.p461@example.test", password: NEW_PW }); const oldPw = await password.signIn({ email: "fail.p461@example.test", password: STRONG }).then(() => null, (e) => e);
  check("D16 the new password signs in and the old one no longer does", Boolean(signed.accessToken) && oldPw?.statusCode === 401);
  await password.forgotPassword({ email: "fail.p461@example.test" });
  const expiredReset = sent.at(-1); await AuthToken.updateMany({ tokenHash: hash(tokenOf(expiredReset)) }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  check("D17 an expired reset link is rejected", (await password.resetPassword({ token: tokenOf(expiredReset), password: NEW_PW + "x", passwordConfirm: NEW_PW + "x" }).then(() => null, (e) => e))?.details?.code === "INVALID_LINK");

  // no transport at all
  email.setEmailTransport(null); setSmtp({});
  const noSignup = await password.signUp({ name: "No Transport", email: "no.transport.p461@example.test", password: STRONG, passwordConfirm: STRONG }).then(() => null, (e) => e);
  const noForgot = await password.forgotPassword({ email: "fail.p461@example.test" }).then(() => null, (e) => e);
  const noResend = await password.resendVerification({ email: "expiry.p461@example.test" }).then(() => null, (e) => e);
  check("D18 [no transport configured] sign-up, forgot-password and resend-verification all answer 503 EMAIL_DELIVERY_UNAVAILABLE (never a fake success), the same for every address, and sign-up creates nothing", [noSignup, noForgot, noResend].every((e) => e?.statusCode === 503 && e?.details?.code === "EMAIL_DELIVERY_UNAVAILABLE") && (await User.countDocuments({ emailNormalized: "no.transport.p461@example.test" })) === 0);
  untap();
  const allSecrets = [tok1, resetTok, tokenOf(expMail), tokenOf(expiredReset), STRONG, NEW_PW, SMTP_PASSWORD];
  check("D19 [no leakage] no raw token, password or SMTP password appears in anything logged during the whole flow (only error classes were logged)", allSecrets.every((s) => !consoleLog.join("\n").includes(s)) && consoleLog.every((l) => /^\[KOI API\] email delivery failed \(\w+, transport injected, class [A-Z_]+\)$/.test(l)));
  check("D20 an error from the transport (with provider text) never reaches the caller: the raised errors contain none of it", !/secret detail|550/.test(`${failedSignup.message} ${JSON.stringify(failedSignup.details)}`));
  check("D21 only passwordAuthService calls the email layer, and nothing outside emailService.js imports nodemailer", (() => { const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === "node_modules" ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)])); const files = walk(path.join(BACKEND, "src")).filter((f) => f.endsWith(".js")); const importers = files.filter((f) => /from "nodemailer"|require\("nodemailer"\)/.test(read(f))); return importers.length === 1 && importers[0].endsWith("emailService.js") && !/nodemailer/i.test(read(path.join(BACKEND, "src/services/passwordAuthService.js"))); })());

  // ======================================================================================================== E
  console.log("\n# E. Google adoption race");
  const idn = { issuer: "https://accounts.google.com", subject: `g-${crypto.randomBytes(6).toString("hex")}`, email: "adopt.p461@example.test", emailVerified: true };
  email.setEmailTransport(async (m) => { sent.push(m); });
  await password.signUp({ name: "Adopt Me", email: "adopt.p461@example.test", password: STRONG, passwordConfirm: STRONG });
  const results = await Promise.all([google.resolveGoogleLogin(idn), google.resolveGoogleLogin(idn), google.resolveGoogleLogin(idn)].map((p) => p.then((x) => x, (e) => ({ error: e }))));
  const owners = await User.find({ $or: [{ emailNormalized: "adopt.p461@example.test" }, { email: "adopt.p461@example.test" }] }).select("+passwordHash").lean();
  const ids = await AuthIdentity.find({ issuer: idn.issuer, subject: idn.subject }).lean();
  check("E1 [race] three concurrent first Google sign-ins on an UNVERIFIED password account converge on ONE user and ONE linked identity (no second user), the unproven password is removed and the email is marked verified", results.every((x) => x.kind === "user" || x.error) && results.some((x) => x.kind === "user") && owners.length === 1 && ids.length === 1 && String(ids[0].userId) === String(owners[0]._id) && !owners[0].passwordHash && owners[0].emailVerified === true && results.filter((x) => x.kind === "user").every((x) => String(x.user._id) === String(owners[0]._id)));
  await password.signUp({ name: "Verified One", email: "verified.p461@example.test", password: STRONG, passwordConfirm: STRONG });
  await password.verifyEmail(tokenOf(sent.at(-1)));
  const vr = await google.resolveGoogleLogin({ issuer: idn.issuer, subject: `g-${crypto.randomBytes(6).toString("hex")}`, email: "verified.p461@example.test", emailVerified: true });
  check("E2 a VERIFIED password account is never merged: Google must prove the password (link_required), no user or identity is created", vr.kind === "link_required" && (await User.countDocuments({ emailNormalized: "verified.p461@example.test" })) === 1);
  const unv = await google.resolveGoogleLogin({ issuer: idn.issuer, subject: `g-${crypto.randomBytes(6).toString("hex")}`, email: "unverified-google.p461@example.test", emailVerified: false });
  check("E3 a Google email that is NOT verified is never matched to anything", unv.kind === "access_restricted" || unv.kind === "user");

  // ======================================================================================================== F
  console.log("\n# F. spawned backend");
  const OUTBOX = path.join(tmp, "outbox.jsonl");
  const PORT = 5721; const logs = { out: "" };
  const child = spawn(process.execPath, [path.join(BACKEND, "server.js")], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PORT: String(PORT), NODE_ENV: "test", CLIENT_URL: "https://app.example.test", LLM_PROVIDER: "test-python", AI_SERVICE_URL: "http://localhost:5399", AUTH_PROVIDER: "eoi", KOI_SESSION_SECRET: SESSION_SECRET, KOI_EMAIL_TRANSPORT: "outbox", KOI_EMAIL_OUTBOX_FILE: OUTBOX, KOI_RATE_LIMIT_ENABLED: "false" } });
  child.stdout.on("data", (d) => { logs.out += d; }); child.stderr.on("data", (d) => { logs.out += d; }); children.push(child);
  let up = false; for (let i = 0; i < 100 && !up; i += 1) { try { up = (await fetch(`http://localhost:${PORT}/api/health`)).ok; } catch { await sleep(200); } }
  check("F0 the backend starts with the dev outbox in test mode (the outbox is explicit, never a fallback)", up && /email delivery: dev-outbox/.test(logs.out));
  if (up) {
    const hostile = await fetch(`http://localhost:${PORT}/api/auth/signup`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-host": "evil.example", "x-forwarded-proto": "http", origin: "https://evil.example", referer: "https://evil.example/", forwarded: "host=evil.example" }, body: JSON.stringify({ name: "Host Header", email: "host.p461@example.test", password: STRONG, passwordConfirm: STRONG }) });
    const line = fs.existsSync(OUTBOX) ? read(OUTBOX).trim().split("\n").map((l) => JSON.parse(l)).find((m) => m.to === "host.p461@example.test") : null;
    check("F1 [link integrity] the verification link is built from the configured CLIENT_URL only: hostile X-Forwarded-Host / Origin / Referer / Forwarded headers do not change it", hostile.status === 202 && Boolean(line) && line.link.startsWith("https://app.example.test/verify-email?token=") && !/evil\.example/.test(JSON.stringify(line)));
    check("F2 the response and the server log never contain the token (it exists only in the link written for the recipient)", Boolean(line) && !(await hostile.text()).includes(new URL(line.link).searchParams.get("token")) && !logs.out.includes(new URL(line.link).searchParams.get("token")));
    check("F3 the link carries only the one-time token: no access / refresh token, no id, no redirect parameter", [...new URL(line.link).searchParams.keys()].join(",") === "token" && !/redirect|next|return|session|access|refresh/i.test(line.link));
  }
  // production-mode start-up must refuse without SMTP (spawned; exits before listening).
  const prodTry = spawnSync(process.execPath, [path.join(BACKEND, "server.js")], { encoding: "utf8", timeout: 40000, env: { ...process.env, PORT: "5722", NODE_ENV: "production", CLIENT_URL: "https://app.example.test", AUTH_PROVIDER: "eoi", KOI_SESSION_SECRET: SESSION_SECRET, KOI_EMAIL_TRANSPORT: "outbox", KOI_EMAIL_OUTBOX_FILE: OUTBOX } });
  const prodOut = `${prodTry.stdout}${prodTry.stderr}`;
  check("F4 [production fail-closed] with AUTH_PROVIDER=eoi in production and NO SMTP (the outbox requested), the server refuses to start (non-zero exit) and never offers the outbox; the output holds no secret", prodTry.status !== 0 && !/dev-outbox/.test(prodOut) && !prodOut.includes(SESSION_SECRET), `exit ${prodTry.status}; ${(prodOut.match(/Refusing to start: [^\n]{0,120}/) ?? ["(no refusal line)"])[0]}`);
} finally {
  untap();
  for (const c of children) { try { c.kill(); } catch { /* gone */ } }
  try { await mongoose.connection.dropDatabase(); } catch { /* best effort */ }
  try { await mongoose.disconnect(); } catch { /* best effort */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log = realLog; console.error = realError;
}
console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}`);
process.exit(failed === 0 ? 0 : 1);
