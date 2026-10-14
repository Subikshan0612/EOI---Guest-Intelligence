/**
 * Starts the Node backend after checking the Google sign-in configuration (Phase 45B.4):
 *
 *   npm run dev:google            (or: node scripts/start-google-dev.mjs)
 *
 * Configuration cleanup: there is ONE runtime environment file per service. The Google settings (client id AND client secret, issuer, redirect URIs) live in
 * backend/.env - the same file `node server.js` reads - and the PUBLIC values the browser needs live in frontend/.env. The former backend/.env.google and
 * frontend/.env.google no longer exist. The secret never leaves this process: it is not printed, not logged, and not sent anywhere but the provider's token endpoint.
 *
 * Phase 45B.4.1: before starting it checks that frontend/.env (PUBLIC values) agrees with backend/.env (same issuer / client id / redirect URI / CORS origin, and a
 * frontend API base that points at THIS backend's port) and refuses to start with a clear message if not.
 *
 * Pair it with the frontend:  cd frontend && npm run dev:google   (http://localhost:5175)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { checkGoogleProfile } from "./lib/googleProfile.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const backendFile = path.join(here, "..", ".env");
const frontendFile = path.join(here, "..", "..", "frontend", ".env");
for (const [label, file] of [["backend/.env", backendFile], ["frontend/.env", frontendFile]]) {
  if (!fs.existsSync(file)) {
    console.error(`start-google-dev: ${label} not found (see backend/docs/GOOGLE_OIDC_PHASE45B4.md)`);
    process.exit(1);
  }
}
const values = dotenv.parse(fs.readFileSync(backendFile));
const problems = checkGoogleProfile(values, dotenv.parse(fs.readFileSync(frontendFile)));
if (problems.length > 0) {
  console.error("start-google-dev: the Google profile is not consistent:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
if ((process.env.NODE_ENV ?? "").toLowerCase() === "production") {
  console.error("start-google-dev: this launcher is for local development only");
  process.exit(1);
}
// backend/.env is read by server.js itself (src/config/env.js); nothing is layered over it here.
process.env.AI_SERVICE_URL ??= "http://localhost:8000"; // only if backend/.env does not name the AI service
console.log(`[start-google-dev] backend/.env read (${Object.keys(values).length} settings; values not shown); frontend/.env consistent`);
await import("../server.js");
