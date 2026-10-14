/**
 * Validates the development token tool (scripts/issue-dev-token.mjs). No database,
 * no server, no network: it runs the CLI as a child process and inspects its output.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STUB_ISSUER, createStubTokenVerifier } from "../src/auth/stubTokenVerifier.js";

const TOOL = path.join(path.dirname(fileURLToPath(import.meta.url)), "issue-dev-token.mjs");
const SECRET = "dev-token-tool-secret-not-real-0123456789";
let passed = 0;
let failed = 0;
const check = (name, condition, detail = "") => {
  if (condition) {
    passed += 1;
    console.log(`PASS  ${name}${detail ? ` - ${detail}` : ""}`);
  } else {
    failed += 1;
    console.error(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
  }
};
const run = (args, env = {}) =>
  spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8", env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, AUTH_STUB_SECRET: SECRET, ...env } });

const ok = run(["--subject", "dev-frontend", "--email", "Dev@Example.test", "--ttl-minutes", "5"]);
const token = ok.stdout.trim();
check("T1: issues a token (exit 0, ONLY the token on stdout)", ok.status === 0 && token.split(".").length === 3 && ok.stdout.trim() === token && !ok.stdout.includes("injected"));
const identity = await createStubTokenVerifier({ secret: SECRET })(token);
check("T2: the token verifies through the stub verifier with the fixed dev issuer", identity.issuer === STUB_ISSUER && identity.subject === "dev-frontend" && identity.email === "Dev@Example.test");
const ttlSeconds = (identity.expiresAt.getTime() - Date.now()) / 1000;
check("T3: short-lived (about 5 minutes)", ttlSeconds > 250 && ttlSeconds <= 300, `${Math.round(ttlSeconds)}s`);
const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
check("T4: the token carries no role, permission, workspace or level claim", JSON.stringify(Object.keys(payload).sort()) === JSON.stringify(["email", "exp", "iss", "sub"]));
check("T5: the secret is never printed", !ok.stdout.includes(SECRET) && !ok.stderr.includes(SECRET));
const defaultPayload = JSON.parse(Buffer.from(run(["--subject", "s"]).stdout.trim().split(".")[1], "base64url").toString());
check("T6: the default lifetime is one hour", Math.round((defaultPayload.exp - Date.now() / 1000) / 60) === 60);

const prod = run(["--subject", "dev-frontend"], { NODE_ENV: "production" });
check("T7: refuses to run when NODE_ENV=production (no token)", prod.status !== 0 && prod.stdout.trim() === "" && /production/.test(prod.stderr));
check("T8: --subject is required", run([]).status !== 0);
check("T9: an empty --subject is refused", run(["--subject", "  "]).status !== 0);
check("T10: a missing secret is refused", run(["--subject", "s"], { AUTH_STUB_SECRET: "" }).status !== 0);
check("T11: a short secret is refused", run(["--subject", "s"], { AUTH_STUB_SECRET: "short" }).status !== 0);
check("T12: a lifetime over 8 hours is refused", run(["--subject", "s", "--ttl-minutes", "481"]).status !== 0);
check("T13: a zero / negative / non-numeric lifetime is refused", ["0", "-5", "abc"].every((v) => run(["--subject", "s", "--ttl-minutes", v]).status !== 0));
check("T14: role / workspace / permission arguments do not exist", ["--role", "--workspace", "--permission", "--knowledge-level", "--issuer"].every((flag) => run(["--subject", "s", flag, "admin"]).status !== 0));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
