import http from "node:http";
import app from "./app.js";
import { getHttpTimeouts } from "./src/config/runtimeConfig.js";
import { clientUrlProblems, externalAiViolationsForTestMode, mongoConfigProblems, productionAiConfigProblems, runtimeWarnings, timeoutBudgetProblems, trustProxyProblems } from "./src/config/startupChecks.js";
import { authStartupProblems } from "./src/auth/authConfig.js";
import { resolveExchangeConfig } from "./src/auth/oidcExchangeConfig.js";
import { emailStartupProblems } from "./src/config/emailConfig.js";
import { emailDeliveryMode, verifySmtpConnection } from "./src/services/emailService.js";
import { env } from "./src/config/env.js";
import { connectDatabase, disconnectDatabase } from "./src/config/database.js";
import { abandonInFlightAnalyses } from "./src/services/intelligenceAnalysisService.js";

let server;
let isShuttingDown = false;

async function start() {
  try {
    // Phase 38: judge the MongoDB URI BEFORE connecting to it (never printed): outside development/test it must name a database.
    const mongoCfg = mongoConfigProblems(env.mongodbUri);
    if (mongoCfg.fatal.length > 0) {
      console.error(`[KOI API] Refusing to start: invalid database configuration: ${mongoCfg.fatal.join("; ")}`);
      process.exit(1);
    }
    for (const warning of mongoCfg.warnings) console.warn(`[KOI API] WARNING: ${warning}`);

    // Release hardening: CLIENT_URL must be an exact origin and KOI_TRUST_PROXY a real hop count (a bad value passes everything else yet breaks every browser request / every rate limit).
    const exactConfig = [clientUrlProblems(env.clientUrl), trustProxyProblems()];
    const exactFatal = exactConfig.flatMap((c) => c.fatal);
    if (exactFatal.length > 0) {
      console.error(`[KOI API] Refusing to start: invalid deployment configuration: ${exactFatal.join("; ")}`);
      process.exit(1);
    }
    for (const warning of exactConfig.flatMap((c) => c.warnings)) console.warn(`[KOI API] WARNING: ${warning}`);
    await connectDatabase();

    // Test-provider isolation: an explicit NODE_ENV=test must not be able to reach an external AI provider.
    const violations = externalAiViolationsForTestMode();
    if (violations.length > 0) {
      console.error(`[KOI API] Refusing to start: ${violations.join("; ")}`);
      await disconnectDatabase();
      process.exit(1);
    }
    for (const warning of runtimeWarnings()) console.warn(`[KOI API] WARNING: ${warning}`);

    // Phase 35: the internal analysis time budget must fit inside the socket timeout (fatal), and the absolute worst case is reported.
    const budget = timeoutBudgetProblems();
    if (budget.fatal.length > 0) {
      console.error(`[KOI API] Refusing to start: invalid timeout configuration: ${budget.fatal.join("; ")}`);
      await disconnectDatabase();
      process.exit(1);
    }
    for (const warning of budget.warnings) console.warn(`[KOI API] WARNING: ${warning}`);

    // Authentication configuration fails CLOSED: production refuses to start without a valid OIDC configuration (and never with the
    // development verifier). Elsewhere the same problems are warnings and authenticated requests answer 503 until fixed.
    const auth = authStartupProblems();
    if (auth.fatal.length > 0) {
      console.error(`[KOI API] Refusing to start: invalid authentication configuration: ${auth.fatal.join("; ")}`);
      await disconnectDatabase();
      process.exit(1);
    }
    for (const problem of auth.warnings) console.warn(`[KOI API] WARNING: authentication configuration: ${problem}`);
    console.log(`[KOI API] Authentication provider: ${auth.config.provider ?? "none"}${auth.config.provider === "oidc" && auth.config.oidc ? ` (issuer ${auth.config.oidc.issuer})` : ""}`);

    // Phase 46 / 46.1: the unified EOI session depends on real email delivery (verification + password reset). Outside an explicit development/test environment a
    // missing or invalid SMTP configuration, or a non-https / localhost CLIENT_URL, is FATAL: the server never starts pretending it can send email. In development
    // the same findings are warnings and the email endpoints answer 503. Nothing printed here contains a secret.
    if (auth.config.provider === "eoi") {
      const mail = emailStartupProblems({ clientUrl: env.clientUrl });
      if (mail.fatal.length > 0) {
        console.error(`[KOI API] Refusing to start: invalid email configuration: ${mail.fatal.join("; ")}`);
        await disconnectDatabase();
        process.exit(1);
      }
      for (const problem of mail.warnings) console.warn(`[KOI API] WARNING: email configuration: ${problem}`);
      console.log(`[KOI API] EOI session: access ${auth.config.eoi?.accessTtlSeconds ?? "?"}s, refresh ${auth.config.eoi?.refreshTtlDays ?? "?"} days; email delivery: ${emailDeliveryMode()}`);
      if (emailDeliveryMode() === "none") console.warn("[KOI API] WARNING: no email transport is configured: email + password sign-up, email verification and password reset answer 503 (set KOI_EMAIL_TRANSPORT=resend with RESEND_API_KEY and MAIL_FROM, or SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD and MAIL_FROM; see docs/UNIFIED_AUTH_PHASE46.md).");
      if (emailDeliveryMode() === "smtp") {
        // A connectivity probe, never fatal (a mail-server blip must not stop the API): it reports only reachable/unreachable and an error class.
        const probe = await verifySmtpConnection();
        console.log(probe.ok ? `[KOI API] SMTP connection verified (credentials accepted; transport security: ${probe.tls}${probe.tls === "none" ? " - development/test only" : ""})` : `[KOI API] WARNING: SMTP connection could not be verified (class ${probe.errorClass ?? "UNKNOWN"}); sends will fail until it is reachable.`);
      }
    }

    // Phase 45B.4: the optional server-side code exchange (providers that need a client secret). Partly configured is a problem (fatal in
    // production); the secret itself is never printed.
    const exchange = resolveExchangeConfig();
    if (exchange.problems.length > 0 && env.isProduction) {
      console.error(`[KOI API] Refusing to start: invalid OIDC code-exchange configuration: ${exchange.problems.join("; ")}`);
      await disconnectDatabase();
      process.exit(1);
    }
    for (const problem of exchange.problems) console.warn(`[KOI API] WARNING: OIDC code-exchange configuration: ${problem}`);
    if (exchange.enabled) console.log("[KOI API] OIDC code exchange: enabled (server-side client secret)");

    // Phase 36: the AI configuration the server owns (no deterministic provider outside development/test; a valid AI service URL).
    const aiConfig = productionAiConfigProblems();
    if (aiConfig.fatal.length > 0) {
      console.error(`[KOI API] Refusing to start: invalid AI configuration: ${aiConfig.fatal.join("; ")}`);
      await disconnectDatabase();
      process.exit(1);
    }
    for (const warning of aiConfig.warnings) console.warn(`[KOI API] WARNING: ${warning}`);

    // Explicit HTTP timeouts (Node's defaults leave the socket idle timeout OFF and check timeouts only every 30 s).
    const timeouts = getHttpTimeouts();
    server = http.createServer(
      {
        headersTimeout: timeouts.headersTimeoutMs,
        requestTimeout: Math.max(timeouts.requestTimeoutMs, timeouts.headersTimeoutMs),
        keepAliveTimeout: timeouts.keepAliveTimeoutMs,
        connectionsCheckingInterval: timeouts.checkIntervalMs,
      },
      app,
    );
    server.setTimeout(timeouts.socketTimeoutMs);
    server.listen(env.port);

    server.on("listening", () => {
      console.log(`[KOI API] Listening on http://localhost:${env.port}`);
      console.log(`[KOI API] Environment: ${env.nodeEnv}`);
      console.log(`[KOI API] CORS origin: ${env.clientUrl}`);
    });

    server.on("error", async (error) => {
      console.error("[KOI API] Failed to start server:", error.message);
      try {
        await disconnectDatabase();
      } catch (disconnectError) {
        console.error("[KOI API] Failed to close MongoDB after listen error:", disconnectError.message);
      }
      process.exit(1);
    });
  } catch (error) {
    console.error("[KOI API] Startup failed:", error.message);
    process.exit(1);
  }
}

async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`[KOI API] Received ${signal}. Shutting down...`);

  try {
    if (server) {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      console.log("[KOI API] HTTP server closed");
    }

    // Workstream 5A: an analysis attempt that continues after its HTTP response cannot finish once this process ends; mark the ones this process owns as interrupted now
    // instead of leaving them "in progress" until the staleness horizon. Best-effort (a crash or SIGKILL cannot do this; those markers expire by age).
    try {
      const abandoned = await abandonInFlightAnalyses();
      if (abandoned > 0) console.log(`[KOI API] ${abandoned} in-flight analysis attempt(s) marked interrupted`);
    } catch {
      /* best effort */
    }

    await disconnectDatabase();
    process.exit(0);
  } catch (error) {
    console.error("[KOI API] Shutdown error:", error.message);
    process.exit(1);
  }
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

void start();
