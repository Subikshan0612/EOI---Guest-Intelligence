/**
 * Test helper for suites written BEFORE Phase 13: gives their `fetch` calls to the
 * now-authenticated routes a REAL bearer token, so the suites keep testing what they
 * were written to test (chunking, retrieval, visibility, import semantics...) through
 * an authorized caller. Importing this module patches `globalThis.fetch` once.
 *
 * It signs nothing itself: it asks authFixtures.mjs for a stored User with an ACTIVE
 * WorkspaceMembership (a real role) in the workspace the request names, exactly as a
 * suite written for the new policy would. No header, query parameter or environment
 * level authenticates anything.
 *
 * Which routes: the Phase 13 set (and only those) -
 *   POST /intelligence/analyze/:id (the one generation route since Phase 24) -> operator by default
 *   GET  /signals/:id/knowledge-retrieval                            -> admin (only admin may)
 *   knowledge management (POST/PATCH/DELETE /knowledge-documents..., /upload, /chunks, /embeddings) -> admin
 *   POST /imports/operational                                        -> admin
 * Phase 14 adds the raw READS (GET /intelligence[/:id], GET /knowledge-documents..., GET /imports/:id)
 * - admin by default, or the role of a level-registered server - and RETIRES `POST /intelligence`:
 * the route no longer exists, so suites that used it only as a FIXTURE writer get the record created
 * in-process through the service (the same validation), with a synthetic response of the old shape.
 * Phase 15 adds Property/Unit/Guest/Stay/Signal (all methods) -> admin of the named workspace.
 * Phase 16 adds: POST /workspaces (retired -> in-process fixture), GET /workspaces/:id, legacy POST/PATCH /decisions,
 * GET /actions, /outcomes, /learning -> admin of the named workspace.
 * A request that already carries an Authorization header is left alone.
 *
 * Role for generation: a suite can call `setGenerationRole(role)` (default "admin", the
 * highest ceiling, so behaviour tests are not artificially limited). Under the new policy
 * no role with a GUEST ceiling may generate, so a guest-level analysis can no longer be
 * produced over HTTP at all.
 */
import { actorFor, sweepStaleAuthFixtures } from "./authFixtures.mjs";
import { connectDatabase } from "../../src/config/database.js";
import { createIntelligence } from "../../src/services/intelligenceService.js";
import { createWorkspace } from "../../src/services/workspaceService.js";
import { createAction, updateAction } from "../../src/services/actionService.js";
import { createOutcome, updateOutcome } from "../../src/services/outcomeService.js";
import { createServerMessage } from "../../src/services/messageService.js";
import { isDuplicateKeyError, duplicateKeyMessage } from "../../src/services/queryHelpers.js";
import { AppError } from "../../src/utils/AppError.js";
import mongoose from "mongoose";

// Suites using this helper cannot clean their own fixture users, so remove STALE ones from earlier runs.
await sweepStaleAuthFixtures().catch(() => {});

const realFetch = globalThis.fetch.bind(globalThis);
let generationRole = "admin";
export const setGenerationRole = (role) => {
  generationRole = role;
};

// Suites that spawn one server per KNOWLEDGE LEVEL (guest / staff / restricted / unset / invalid)
// register each base URL so generation and retrieval on it are made by the role whose CEILING is
// that level: guest -> viewer, staff -> operator, restricted -> admin, unset/invalid -> viewer.
// Under the Phase 13 policy a viewer may not generate or retrieve at all, and retrieval is
// admin-only, so checks that need a guest- or staff-ceiling caller there are OBSOLETE by policy.
const levelByBase = new Map();
const ROLE_FOR_LEVEL = { guest: "viewer", staff: "operator", restricted: "admin" };
export function registerServerLevel(base, level) {
  levelByBase.set(String(base).replace(/\/api\/?$/, ""), ROLE_FOR_LEVEL[level] ?? "viewer");
}
const roleForBase = (url) => levelByBase.get(url.origin) ?? null;

function roleFor(method, pathname, url) {
  const p = pathname.replace(/^.*?\/api/, "");
  if (method === "GET" && (/^\/intelligence(\/[^/]+)?$/.test(p) || /^\/knowledge-documents(\/[^/]+(\/chunks)?)?$/.test(p) || /^\/imports\/[^/]+$/.test(p))) return roleForBase(url) ?? "admin";
  if (method === "POST" && /^\/intelligence\/analyze\/[^/]+$/.test(p)) return roleForBase(url) ?? generationRole;
  if (method === "GET" && /^\/signals\/[^/]+\/knowledge-retrieval$/.test(p)) return roleForBase(url) ?? "admin";
  if (method === "POST" && (p === "/knowledge-documents" || p === "/knowledge-documents/upload" || /^\/knowledge-documents\/[^/]+\/(chunks|embeddings)$/.test(p))) return "admin";
  if ((method === "PATCH" || method === "DELETE") && /^\/knowledge-documents\/[^/]+$/.test(p)) return "admin";
  if (method === "POST" && p === "/imports/operational") return "admin";
  // Phase 15: the operational data routes (Property/Unit/Signal/Guest/Stay) are authenticated. Suites written
  // before that only set up or read fixtures, so they act as an ADMIN of the workspace they name (every
  // operation allowed); the role matrix itself is tested in validate-phase15-operational-authorization.
  if (/^\/(properties|units|guests|stays|signals)(\/|$)/.test(p)) return "admin";
  // Phase 16: workspace reads, the legacy generic Decision POST/PATCH, and the Action/Outcome/Learning reads
  // (reviewer/admin / admin only) - an ADMIN of the workspace they name.
  if (method === "GET" && /^\/workspaces(\/[^/]+)?$/.test(p)) return "admin";
  // Phase 18: Conversations and their Messages (all methods) -> admin of the named workspace.
  if (/^\/conversations(\/|$)/.test(p)) return "admin";
  if ((method === "POST" && p === "/decisions") || (method === "PATCH" && /^\/decisions\/[^/]+$/.test(p))) return "admin";
  if (method === "GET" && /^\/(actions|outcomes)(\/[^/]+)?$|^\/learning(\/patterns)?$/.test(p)) return "admin";
  return null;
}

function workspaceOf(url, body) {
  const inPath = /\/workspaces\/([0-9a-fA-F]{24})$/.exec(url.pathname);
  if (inPath) return inPath[1];
  const fromQuery = url.searchParams.get("workspaceId");
  if (fromQuery) return fromQuery;
  try {
    if (typeof body === "string") return JSON.parse(body)?.workspaceId;
    if (body && typeof body.get === "function") return body.get("workspaceId") ?? undefined; // FormData
  } catch {
    // not JSON
  }
  return undefined;
}

/** POST /intelligence was retired over HTTP: create the FIXTURE in-process, answering like the old route did. */
async function fixtureCreateIntelligence(init) {
  if (mongoose.connection.readyState !== 1) await connectDatabase();
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  try {
    const record = await createIntelligence(JSON.parse(typeof init.body === "string" ? init.body : "{}"));
    return reply(201, { success: true, data: JSON.parse(JSON.stringify(record)) });
  } catch (err) {
    let status = Number(err.statusCode) || 500;
    let message = err.message;
    if (err.name === "ValidationError") {
      status = 400;
      message = Object.values(err.errors || {}).map((item) => item.message).join("; ") || "Validation failed";
    } else if (err.name === "CastError") {
      status = 400;
      message = `Invalid ${err.path || "value"}`;
    } else if (!(err instanceof AppError) && status < 400) status = 500;
    return reply(status, { success: false, message });
  }
}

/** POST /workspaces was retired over HTTP (Phase 16): create the FIXTURE in-process, answering like the old route did. */
async function fixtureCreateWorkspace(init) {
  if (mongoose.connection.readyState !== 1) await connectDatabase();
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  try {
    const record = await createWorkspace(JSON.parse(typeof init.body === "string" ? init.body : "{}"));
    return reply(201, { success: true, data: JSON.parse(JSON.stringify(record)) });
  } catch (err) {
    let status = Number(err.statusCode) || 500;
    let message = err.message;
    if (err.name === "ValidationError") {
      status = 400;
      message = Object.values(err.errors || {}).map((item) => item.message).join("; ") || "Validation failed";
    } else if (err.name === "CastError") {
      status = 400;
      message = `Invalid ${err.path || "value"}`;
    } else if (isDuplicateKeyError(err)) {
      status = 409;
      message = duplicateKeyMessage(err);
    } else if (!(err instanceof AppError) && status < 400) status = 500;
    return reply(status, { success: false, message });
  }
}

/**
 * Action / Outcome WRITES are blocked over HTTP for every role (Phase 17: `action:execute` is held by nobody), so suites
 * that only need such a record as a FIXTURE - or that test the data invariants of the service - call the service in-process,
 * with the same validation, and get a synthetic response of the old shape. A request carrying its own Authorization header
 * is NOT intercepted (that is how the authorization itself is tested).
 */
async function fixtureActionOutcomeWrite(method, url, init) {
  if (mongoose.connection.readyState !== 1) await connectDatabase();
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const body = JSON.parse(typeof init.body === "string" ? init.body : "{}");
  const isAction = url.pathname.startsWith("/api/actions");
  const id = url.pathname.split("/")[3];
  try {
    const record =
      method === "POST"
        ? await (isAction ? createAction : createOutcome)(body)
        : await (isAction ? updateAction : updateOutcome)(id, body, url.searchParams.get("workspaceId"));
    return reply(method === "POST" ? 201 : 200, { success: true, data: JSON.parse(JSON.stringify(record)) });
  } catch (err) {
    let status = Number(err.statusCode) || 500;
    let message = err.message;
    if (err.name === "ValidationError") {
      status = 400;
      message = Object.values(err.errors || {}).map((item) => item.message).join("; ") || "Validation failed";
    } else if (err.name === "CastError") {
      status = 400;
      message = `Invalid ${err.path || "value"}`;
    } else if (!(err instanceof AppError) && status < 400) status = 500;
    return reply(status, { success: false, message });
  }
}

/**
 * Phase 20: assistant / system / intelligence messages are SERVER-OWNED (a browser cannot create them). Suites that need such a
 * message as a FIXTURE create it through the server-side function, with the same conversation-in-workspace resolution.
 */
async function fixtureServerMessage(url, init) {
  if (mongoose.connection.readyState !== 1) await connectDatabase();
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const conversationId = url.pathname.split("/")[3];
  try {
    const record = await createServerMessage(conversationId, url.searchParams.get("workspaceId"), JSON.parse(typeof init.body === "string" ? init.body : "{}"));
    return reply(201, { success: true, data: JSON.parse(JSON.stringify(record)) });
  } catch (err) {
    return reply(Number(err.statusCode) || 500, { success: false, message: err.message });
  }
}

const isServerOwnedMessageBody = (body) => {
  try {
    const parsed = JSON.parse(typeof body === "string" ? body : "{}");
    return (parsed.role !== undefined && parsed.role !== "user") || (parsed.type !== undefined && parsed.type !== "text") || Boolean(parsed.metadata && Object.prototype.hasOwnProperty.call(parsed.metadata, "koiIntelligence"));
  } catch {
    return false;
  }
};

globalThis.fetch = async function authAwareFetch(input, init = {}) {
  const url = new URL(typeof input === "string" ? input : input.url);
  const method = (init.method ?? "GET").toUpperCase();
  if (method === "POST" && /^\/api\/intelligence\/?$/.test(url.pathname)) return fixtureCreateIntelligence(init);
  if (method === "POST" && /^\/api\/workspaces\/?$/.test(url.pathname)) return fixtureCreateWorkspace(init);
  if (method === "POST" && /^\/api\/conversations\/[^/]+\/messages\/?$/.test(url.pathname) && !new Headers(init.headers ?? {}).has("authorization") && isServerOwnedMessageBody(init.body)) return fixtureServerMessage(url, init);
  if (!new Headers(init.headers ?? {}).has("authorization") && ((method === "POST" && /^\/api\/(actions|outcomes)\/?$/.test(url.pathname)) || (method === "PATCH" && /^\/api\/(actions|outcomes)\/[^/]+$/.test(url.pathname)))) return fixtureActionOutcomeWrite(method, url, init);
  const role = roleFor(method, url.pathname, url);
  if (!role) return realFetch(input, init);
  const existing = new Headers(init.headers ?? {});
  if (existing.has("authorization")) return realFetch(input, init);
  const workspaceId = workspaceOf(url, init.body);
  const valid = typeof workspaceId === "string" && /^[0-9a-fA-F]{24}$/.test(workspaceId);
  const actor = await actorFor(valid ? role : null, valid ? workspaceId : undefined, "authfetch");
  for (const [key, value] of Object.entries(actor.headers)) existing.set(key, value);
  return realFetch(input, { ...init, headers: existing });
};
