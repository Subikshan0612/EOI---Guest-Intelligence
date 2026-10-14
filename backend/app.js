import cors from "cors";
import express from "express";
import { getTrustProxy } from "./src/config/runtimeConfig.js";
import { env } from "./src/config/env.js";
import { errorHandler } from "./src/middleware/errorHandler.js";
import { requestId } from "./src/middleware/requestId.js";
import { notFoundHandler } from "./src/middleware/notFound.js";
import { anonymousLimiter, clientAddressLimiter } from "./src/middleware/rateLimit.js";
import { securityHeaders } from "./src/middleware/securityHeaders.js";
import { apiRouter } from "./src/routes/index.js";

const app = express();

// Express hardening: no `X-Powered-By`, no ETag revalidation of sensitive responses, and the client address used for rate
// limiting is the socket address unless KOI_TRUST_PROXY names a proxy hop count (X-Forwarded-For is otherwise ignored).
app.disable("x-powered-by");
app.set("etag", false);
app.set("trust proxy", getTrustProxy());

app.use(
  cors({
    origin: env.clientUrl,
    credentials: true,
  }),
);
// Phase 36: a random per-request correlation id (X-Request-Id), first, so even 404/429/error responses carry one.
app.use(requestId);
// Security headers on EVERY response (including 404, 429 and error responses).
app.use(securityHeaders);
// Client-address rate limits run BEFORE any body handling or authentication: an unauthenticated flood is rejected cheaply.
// NOTE (Phase 21): there is deliberately NO app-level `express.json()`. The JSON body parser is part of each route's
// authenticated chain (see auth/authorize.js requireAccess), so a body is parsed only AFTER authentication succeeds.
app.use(anonymousLimiter);
app.use(clientAddressLimiter);

app.get("/", (_req, res) => {
  res.status(200).json({
    success: true,
    service: "KOI API",
    message: "Kolam Operational Intelligence API",
  });
});

app.use("/api", apiRouter);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
