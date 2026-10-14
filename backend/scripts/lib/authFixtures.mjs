/**
 * Shared test helper: real users, real memberships, real (stub-signed) tokens.
 *
 * The Decision V1 endpoints are authenticated, so suites that call them must
 * present a bearer token. This helper builds one the honest way: a User and an
 * ACTIVE WorkspaceMembership are stored in MongoDB, and a token is signed with the
 * DEVELOPMENT stub verifier. No header, role override or environment level is
 * used to bypass authentication.
 *
 * Importing this module sets AUTH_TOKEN_VERIFIER=stub and a suite secret in
 * process.env (unless already set), so every backend a suite spawns afterwards
 * inherits them. A suite that talks to an ALREADY RUNNING backend (API_BASE) needs
 * that backend started with the same two variables:
 *
 *   AUTH_TOKEN_VERIFIER=stub AUTH_STUB_SECRET=<same secret> node server.js
 *
 * Fixtures are tracked here and removed by `cleanupAuthFixtures()`.
 */
import { connectDatabase } from "../../src/config/database.js";
import { STUB_ISSUER, signStubToken } from "../../src/auth/stubTokenVerifier.js";
import { AnalysisAdmission, AnalysisAttempt, User, Workspace, WorkspaceMembership } from "../../src/models/index.js";
import mongoose from "mongoose";

export const SUITE_STUB_SECRET = "eoi-suite-stub-secret-not-real-0123456789";
// Phase 21: the development verifier needs an EXPLICIT development/test NODE_ENV, so the test harness declares one (children the
// suites spawn inherit it). Test mode also makes a spawned server refuse any external AI provider. Rate limiting is switched OFF
// for the legacy harnesses that fire thousands of requests from one address; validate-phase21-runtime-hardening proves the
// limiter with it ON, and starts its own servers with explicit limits.
process.env.NODE_ENV = "test";
process.env.KOI_RATE_LIMIT_ENABLED ??= "false";
// Phase 25: the deterministic TEST embeddings are hash-based (unrelated texts score about N(0, 0.18); nothing is semantic), so the
// production relevance floor would reject fixtures at random. The legacy suites, which test everything EXCEPT the floor, therefore
// run their servers with the floor disabled (-1: every cosine is >= -1). validate-phase25-retrieval-hardening.mjs sets its own values.
process.env.KOI_RETRIEVAL_MIN_SIMILARITY ??= "-1";
// The provider is chosen EXPLICITLY (Phase 23): the development stub, for the test harness only.
process.env.AUTH_PROVIDER = "stub";
process.env.AUTH_TOKEN_VERIFIER ??= "stub";
process.env.AUTH_STUB_SECRET ??= SUITE_STUB_SECRET;

const tracked = { users: [], memberships: [] };
const pending = new Map();
let counter = 0;
const run = `${Date.now()}-${process.pid}`;

async function ensureConnected() {
  if (mongoose.connection.readyState !== 1) await connectDatabase();
}

export function tokenFor(user, claims = {}, ttlSeconds = 3600) {
  return signStubToken(
    { iss: STUB_ISSUER, sub: user.subject, email: user.email, exp: Math.floor(Date.now() / 1000) + ttlSeconds, ...claims },
    process.env.AUTH_STUB_SECRET,
  );
}

export const bearer = (token) => ({ authorization: `Bearer ${token}` });

/** A user with an ACTIVE membership (role) in `workspaceId`; or no membership when it is omitted. */
export async function createActor({ role, workspaceId, label = "actor" }) {
  await ensureConnected();
  counter += 1;
  const user = await User.create({ issuer: STUB_ISSUER, subject: `${label}-${role ?? "none"}-${run}-${counter}`, email: `${label}-${counter}@example.invalid` });
  tracked.users.push(user._id);
  let membership = null;
  if (role && workspaceId) {
    membership = await WorkspaceMembership.create({ userId: user._id, workspaceId, role });
    tracked.memberships.push(membership._id);
  }
  return { user, membership, token: tokenFor(user), headers: bearer(tokenFor(user)) };
}

/** Cached per (role, workspace); safe under concurrent callers. */
export function actorFor(role, workspaceId, label = "shared") {
  const key = `${label}|${role}|${workspaceId ?? ""}`;
  if (!pending.has(key)) pending.set(key, createActor({ role, workspaceId, label }));
  return pending.get(key);
}

/**
 * For suites written before authentication existed: attaches a VIEWER token for
 * the workspace named in a /decisions request, so their existing GET checks keep
 * meaning what they meant (a guest-ceiling reader). Creating that viewer needs the
 * workspace to exist. Legacy generic POST /decisions and PATCH are unauthenticated
 * and get no header.
 */
export async function decisionAuthHeaders(method, path, headers) {
  // Workspace administration (PATCH / DELETE /workspaces/:id) needs an ADMIN of that workspace.
  const admin = /^\/workspaces\/([0-9a-fA-F]{24})(?:$|\?)/.exec(path);
  if (admin && (method === "PATCH" || method === "DELETE")) {
    await ensureConnected();
    const workspaceExists = await Workspace.exists({ _id: admin[1] });
    const actor = await actorFor(workspaceExists ? "admin" : null, workspaceExists ? admin[1] : undefined, "legacy-workspace-admin");
    return { ...(headers ?? {}), ...actor.headers };
  }
  if (!path.startsWith("/decisions")) return headers;
  if (method === "PATCH" || (method === "POST" && path === "/decisions")) return headers;
  const match = /[?&]workspaceId=([0-9a-fA-F]{24})/.exec(path);
  let role = null;
  if (match) {
    await ensureConnected();
    if (await Workspace.exists({ _id: match[1] })) role = "viewer";
  }
  const actor = await actorFor(role, role ? match[1] : undefined, "legacy-reader");
  return { ...(headers ?? {}), ...actor.headers };
}

/**
 * Phase 35: every successful or rejected analysis writes a metadata-only AnalysisAdmission row, and the older suites remove their
 * throwaway workspaces by hand without knowing that collection. A row whose WORKSPACE NO LONGER EXISTS is unreachable (every read is
 * workspace-scoped) and cannot occur in production, where workspace deletion removes it (workspaceLifecycleService). This removes exactly
 * those rows and nothing else: a row of any workspace that still exists is never touched.
 */
export async function sweepOrphanAdmissions() {
  await ensureConnected();
  // Workstream 5A: the same applies to the metadata-only analysis ATTEMPT markers (workspaceLifecycleService removes both with a real workspace).
  let removed = 0;
  for (const Model of [AnalysisAdmission, AnalysisAttempt]) {
    const referenced = await Model.distinct("workspaceId");
    if (!referenced.length) continue;
    const alive = new Set((await Workspace.find({ _id: { $in: referenced } }, { _id: 1 }).lean()).map((w) => String(w._id)));
    const orphaned = referenced.filter((id) => !alive.has(String(id)));
    if (orphaned.length) removed += (await Model.deleteMany({ workspaceId: { $in: orphaned } })).deletedCount;
  }
  return removed;
}

export async function cleanupAuthFixtures() {
  await sweepOrphanAdmissions().catch(() => {});
  if (!tracked.users.length && !tracked.memberships.length) return;
  await ensureConnected();
  await WorkspaceMembership.deleteMany({ _id: { $in: tracked.memberships } });
  await User.deleteMany({ _id: { $in: tracked.users } });
  tracked.users.length = 0;
  tracked.memberships.length = 0;
  pending.clear();
}

/**
 * Removes test users (and their memberships) left by suites that cannot call cleanupAuthFixtures()
 * themselves (the ones that use authFetch.mjs). ONLY subjects with these exact test prefixes are
 * touched - never a real identity such as the provisioned development user - and only rows older than
 * `olderThanMs`, so a concurrently running suite keeps its fixtures.
 */
export const SWEEPABLE_SUBJECT_PREFIXES = ["authfetch-", "vis-nonadmin-"];
export async function sweepStaleAuthFixtures(olderThanMs = 15 * 60 * 1000) {
  await ensureConnected();
  await sweepOrphanAdmissions().catch(() => {});
  const cutoff = new Date(Date.now() - olderThanMs);
  const pattern = new RegExp(`^(${SWEEPABLE_SUBJECT_PREFIXES.map((p) => p.replace(/[-/\^$*+?.()|[\]{}]/g, "\$&")).join("|")})`);
  const stale = await User.find({ issuer: STUB_ISSUER, subject: pattern, createdAt: { $lt: cutoff } }, { _id: 1 }).lean();
  if (!stale.length) return { users: 0, memberships: 0 };
  const userIds = stale.map((u) => u._id);
  const memberships = await WorkspaceMembership.deleteMany({ userId: { $in: userIds } });
  const users = await User.deleteMany({ _id: { $in: userIds } });
  return { users: users.deletedCount, memberships: memberships.deletedCount };
}
