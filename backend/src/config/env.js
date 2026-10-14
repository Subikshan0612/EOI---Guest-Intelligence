import "./mongoSafety.js"; // FIRST: marks validation / rehearsal processes (KOI_NO_DOTENV) and installs the database-safety guard
import dotenv from "dotenv";
import os from "node:os";
import path from "node:path";
import { getRuntimeMode, isDevelopmentOrTestMode } from "./runtimeMode.js";

// backend/.env is the ONE runtime file and holds real settings. A validation suite or rehearsal tool (scripts/validate-*.mjs, scripts/phaseNN/*; marked by mongoSafety.js) must
// never pick them up - neither itself nor the servers it spawns (they inherit KOI_NO_DOTENV) - so dotenv is pointed at a file that does not exist. The real server is unaffected.
dotenv.config(process.env.KOI_NO_DOTENV === "1" ? { path: path.join(os.tmpdir(), "koi-no-dotenv-for-validation"), quiet: true } : undefined);

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "",
  // development | test | production | unknown (unset/unrecognised = "unknown", treated like production for dev features).
  mode: getRuntimeMode(),
  port: Number(required("PORT", "5000")),
  clientUrl: required("CLIENT_URL", "http://localhost:5173"),
  mongodbUri: process.env.MONGODB_URI ?? "",
  isProduction: getRuntimeMode() === "production",
  // Error internals (name/message/stack) are returned ONLY with this EXPLICIT flag, and never in production.
  // Being "not production" is not enough, and an omitted variable means hidden (fail closed).
  exposeErrorDetails: process.env.KOI_EXPOSE_ERROR_DETAILS === "true" && isDevelopmentOrTestMode(),
};
