/**
 * DEVELOPMENT-ONLY: issue a short-lived access token for the DEVELOPMENT stub
 * verifier, so a local frontend can call the authenticated endpoints.
 *
 *   AUTH_STUB_SECRET=<16+ chars> node scripts/issue-dev-token.mjs --subject <dev-subject> [--email <e>] [--ttl-minutes <n>]
 *
 * (AUTH_STUB_SECRET is read from the environment / backend/.env. It is the SAME
 * secret the backend runs with when AUTH_TOKEN_VERIFIER=stub. It is never printed
 * and never leaves this process.)
 *
 * What this does NOT do:
 *   - it does not create a User or a WorkspaceMembership (nothing touches MongoDB).
 *     The token only names an identity (issuer eoi-dev-stub + subject); the backend
 *     accepts it only if a User with that exact issuer + subject already exists and
 *     has an ACTIVE membership in the workspace being used. Provisioning is an
 *     operator step, not something a token can do.
 *   - it accepts no role, permission, workspace or knowledge-level claim: role and
 *     workspace come from the membership, and are never inside the token.
 *   - it is a CLI, not an endpoint: nothing is exposed over HTTP.
 *   - it refuses to run when NODE_ENV=production.
 *
 * Prints ONLY the token to stdout (so it can be pasted into VITE_DEV_ACCESS_TOKEN).
 */
import dotenv from "dotenv";
import { STUB_ISSUER, signStubToken } from "../src/auth/stubTokenVerifier.js";

// quiet: dotenv must not write to stdout, which carries ONLY the token.
dotenv.config({ quiet: true });

const MAX_TTL_MINUTES = 480;
const DEFAULT_TTL_MINUTES = 60;

function fail(message) {
  console.error(`issue-dev-token: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!["--subject", "--email", "--ttl-minutes"].includes(flag)) fail(`unknown argument: ${flag}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) fail(`${flag} needs a value`);
    args[flag.slice(2)] = value;
    i += 1;
  }
  return args;
}

if (!["development", "test"].includes((process.env.NODE_ENV ?? "").trim().toLowerCase())) fail("refusing to run when NODE_ENV=production");

const args = parseArgs(process.argv.slice(2));
const subject = (args.subject ?? "").trim();
if (!subject) fail("--subject is required (the dev identity's subject; it must match an existing backend User)");
if (subject.length > 256) fail("--subject is too long");

const ttl = args["ttl-minutes"] === undefined ? DEFAULT_TTL_MINUTES : Number(args["ttl-minutes"]);
if (!Number.isFinite(ttl) || ttl <= 0 || ttl > MAX_TTL_MINUTES) fail(`--ttl-minutes must be between 1 and ${MAX_TTL_MINUTES}`);

const secret = process.env.AUTH_STUB_SECRET ?? "";
if (!secret) fail("AUTH_STUB_SECRET is not set in the environment (backend/.env or the shell)");

let token;
try {
  token = signStubToken(
    {
      iss: STUB_ISSUER,
      sub: subject,
      ...(args.email ? { email: args.email.trim() } : {}),
      exp: Math.floor(Date.now() / 1000) + Math.round(ttl * 60),
    },
    secret,
  );
} catch (error) {
  fail(error.message);
}

console.error(
  `issue-dev-token: token for ${STUB_ISSUER} / ${subject}, valid ${ttl} minute(s). It only works if a backend User with this issuer+subject and an ACTIVE workspace membership exists.`,
);
console.log(token);
