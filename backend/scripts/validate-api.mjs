import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import {
  Workspace,
  Property,
  Unit,
  Guest,
  Stay,
  Signal,
  Conversation,
  Message,
  Intelligence,
  Decision,
  Action,
  Outcome,
} from "../src/models/index.js";

const BASE = process.env.API_BASE || "http://localhost:5002/api";
const created = {
  workspaceIds: [],
  propertyIds: [],
  unitIds: [],
  guestIds: [],
  stayIds: [],
  signalIds: [],
  conversationIds: [],
  messageIds: [],
  intelligenceIds: [],
  decisionIds: [],
  actionIds: [],
  outcomeIds: [],
};

let passed = 0;
let failed = 0;

function ok(name, detail = "") {
  passed += 1;
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
}

function fail(name, detail = "") {
  failed += 1;
  console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function request(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  let json = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }

  return { status: response.status, json };
}

async function expectStatus(name, method, path, body, expectedStatus) {
  const result = await request(method, path, body);
  if (result.status === expectedStatus) {
    ok(name, `HTTP ${result.status}`);
  } else {
    fail(name, `expected ${expectedStatus}, got ${result.status}: ${JSON.stringify(result.json)}`);
  }
  return result;
}

async function expectStatusOneOf(name, method, path, body, expectedStatuses) {
  const result = await request(method, path, body);
  if (expectedStatuses.includes(result.status)) {
    ok(name, `HTTP ${result.status}`);
  } else {
    fail(
      name,
      `expected one of [${expectedStatuses.join(", ")}], got ${result.status}: ${JSON.stringify(
        result.json,
      )}`,
    );
  }
  return result;
}

/**
 * Defensive cleanup tracking: if an isolation guard is broken and a
 * cross-workspace write unexpectedly succeeds, still capture the id so the
 * document is removed during cleanup.
 */
function trackCreated(result, bucket) {
  const id = result?.json?.data?._id;
  if (id && !created[bucket].includes(id)) created[bucket].push(id);
  return id;
}

function assertListExcludes(name, result, forbiddenId) {
  const rows = result?.json?.data || [];
  if (rows.some((row) => String(row?._id) === String(forbiddenId))) {
    fail(name, `list leaked foreign id ${forbiddenId}`);
  } else {
    ok(name, `${rows.length} row(s), no foreign data`);
  }
}

async function cleanup() {
  await connectDatabase();
  await Promise.all([
    Outcome.deleteMany({ _id: { $in: created.outcomeIds } }),
    Action.deleteMany({ _id: { $in: created.actionIds } }),
    Decision.deleteMany({ _id: { $in: created.decisionIds } }),
    Intelligence.deleteMany({ _id: { $in: created.intelligenceIds } }),
    Message.deleteMany({ _id: { $in: created.messageIds } }),
    Conversation.deleteMany({ _id: { $in: created.conversationIds } }),
    Signal.deleteMany({ _id: { $in: created.signalIds } }),
    Stay.deleteMany({ _id: { $in: created.stayIds } }),
    Guest.deleteMany({ _id: { $in: created.guestIds } }),
    Unit.deleteMany({ _id: { $in: created.unitIds } }),
    Property.deleteMany({ _id: { $in: created.propertyIds } }),
    Workspace.deleteMany({ _id: { $in: created.workspaceIds } }),
  ]);
  await disconnectDatabase();
}

async function main() {
  const stamp = Date.now();

  const health = await expectStatus("health", "GET", "/health", null, 200);
  if (health.json?.database !== "connected") {
    fail("health database field", JSON.stringify(health.json));
  } else {
    ok("health database connected");
  }

  await expectStatus("unknown route", "GET", "/does-not-exist", null, 404);
  await expectStatus("invalid object id", "GET", "/workspaces/not-an-id", null, 400);

  const workspaceMissing = await expectStatus(
    "workspace missing required",
    "POST",
    "/workspaces",
    { name: "Incomplete" },
    400,
  );
  if (!workspaceMissing.json?.success === false) {
    // already checked via status
  }

  const workspace = await expectStatus(
    "workspace create",
    "POST",
    "/workspaces",
    {
      name: `Phase 2D WS ${stamp}`,
      slug: `phase-2d-ws-${stamp}`,
    },
    201,
  );
  const workspaceId = workspace.json?.data?._id;
  created.workspaceIds.push(workspaceId);

  await expectStatus(
    "workspace duplicate slug",
    "POST",
    "/workspaces",
    { name: "Dup", slug: `phase-2d-ws-${stamp}` },
    409,
  );

  await expectStatus("workspace list", "GET", `/workspaces?page=1&limit=5`, null, 200);
  await expectStatus("workspace get", "GET", `/workspaces/${workspaceId}`, null, 200);
  await expectStatus(
    "workspace update",
    "PATCH",
    `/workspaces/${workspaceId}`,
    { name: `Phase 2D WS Updated ${stamp}` },
    200,
  );

  const property = await expectStatus(
    "property create",
    "POST",
    "/properties",
    {
      workspaceId,
      name: "Harbour Residences",
      code: `HR${stamp}`,
      timezone: "Asia/Kolkata",
    },
    201,
  );
  const propertyId = property.json?.data?._id;
  created.propertyIds.push(propertyId);

  await expectStatus(
    "property missing workspace",
    "POST",
    "/properties",
    { workspaceId: "64b64c4f2f1c2e0012345678", name: "X", code: "X1" },
    404,
  );

  await expectStatus(
    "property list filtered",
    "GET",
    `/properties?workspaceId=${workspaceId}&page=1&limit=10`,
    null,
    200,
  );

  const unit = await expectStatus(
    "unit create",
    "POST",
    "/units",
    { workspaceId, propertyId, unitNumber: "402", type: "apartment" },
    201,
  );
  const unitId = unit.json?.data?._id;
  created.unitIds.push(unitId);
  await expectStatus(
    "unit list",
    "GET",
    `/units?workspaceId=${workspaceId}&propertyId=${propertyId}`,
    null,
    200,
  );

  const guest = await expectStatus(
    "guest create",
    "POST",
    "/guests",
    {
      workspaceId,
      firstName: "Evan",
      lastName: "Chen",
      email: `evan-${stamp}@example.com`,
    },
    201,
  );
  const guestId = guest.json?.data?._id;
  created.guestIds.push(guestId);
  await expectStatus("guest list", "GET", `/guests?workspaceId=${workspaceId}`, null, 200);

  const stay = await expectStatus(
    "stay create",
    "POST",
    "/stays",
    {
      workspaceId,
      guestId,
      propertyId,
      unitId,
      reservationId: `RSV-${stamp}`,
      status: "checked_in",
      checkIn: new Date().toISOString(),
    },
    201,
  );
  const stayId = stay.json?.data?._id;
  created.stayIds.push(stayId);
  await expectStatus(
    "stay list",
    "GET",
    `/stays?workspaceId=${workspaceId}&status=checked_in`,
    null,
    200,
  );

  const signal = await expectStatus(
    "signal create",
    "POST",
    "/signals",
    {
      workspaceId,
      propertyId,
      unitId,
      guestId,
      stayId,
      type: "maintenance",
      severity: "high",
      title: "AC not cooling",
      description: "Warm air since last night",
    },
    201,
  );
  const signalId = signal.json?.data?._id;
  created.signalIds.push(signalId);

  const signalList = await expectStatus(
    "signal list filtered",
    "GET",
    `/signals?workspaceId=${workspaceId}&severity=high&status=new`,
    null,
    200,
  );
  if ((signalList.json?.data || []).length >= 1) ok("signal filter returned rows");
  else fail("signal filter returned rows");

  const conversation = await expectStatus(
    "conversation create",
    "POST",
    "/conversations",
    {
      workspaceId,
      guestId,
      stayId,
      signalIds: [signalId],
      title: "AC issue — Apartment 402",
    },
    201,
  );
  const conversationId = conversation.json?.data?._id;
  created.conversationIds.push(conversationId);
  await expectStatus(
    "conversation list",
    "GET",
    `/conversations?workspaceId=${workspaceId}`,
    null,
    200,
  );

  const message = await expectStatus(
    "message create",
    "POST",
    `/conversations/${conversationId}/messages?workspaceId=${workspaceId}`,
    { role: "user", type: "text", content: "Guest says AC is not cooling." },
    201,
  );
  created.messageIds.push(message.json?.data?._id);
  await expectStatus(
    "message list",
    "GET",
    `/conversations/${conversationId}/messages?workspaceId=${workspaceId}`,
    null,
    200,
  );

  const intelligence = await expectStatus(
    "intelligence create",
    "POST",
    "/intelligence",
    {
      workspaceId,
      conversationId,
      guestId,
      stayId,
      signalIds: [signalId],
      signal: { summary: "AC warm air", type: "maintenance", severity: "high" },
      intelligence: { summary: "Comfort-critical in-stay issue" },
      risk: { level: "high", reason: "In-house comfort" },
      confidence: 0.8,
      generatedBy: "system",
    },
    201,
  );
  const intelligenceId = intelligence.json?.data?._id;
  created.intelligenceIds.push(intelligenceId);
  await expectStatus(
    "intelligence list",
    "GET",
    `/intelligence?workspaceId=${workspaceId}&signalId=${signalId}`,
    null,
    200,
  );

  const decision = await expectStatus(
    "decision create",
    "POST",
    "/decisions",
    {
      workspaceId,
      intelligenceId,
      type: "service_recovery",
      description: "Prioritize recovery",
      priority: "high",
    },
    201,
  );
  const decisionId = decision.json?.data?._id;
  created.decisionIds.push(decisionId);
  await expectStatus(
    "decision list",
    "GET",
    `/decisions?workspaceId=${workspaceId}&intelligenceId=${intelligenceId}`,
    null,
    200,
  );

  const action = await expectStatus(
    "action create",
    "POST",
    "/actions",
    {
      workspaceId,
      intelligenceId,
      decisionId,
      type: "maintenance_dispatch",
      description: "Send technician to 402",
      status: "pending",
      assignedTo: "ops-desk",
    },
    201,
  );
  const actionId = action.json?.data?._id;
  created.actionIds.push(actionId);
  await expectStatus(
    "action list",
    "GET",
    `/actions?workspaceId=${workspaceId}&status=pending`,
    null,
    200,
  );

  const outcome = await expectStatus(
    "outcome create",
    "POST",
    "/outcomes",
    {
      workspaceId,
      intelligenceId,
      actionId,
      status: "unknown",
      result: { summary: "Awaiting completion" },
    },
    201,
  );
  created.outcomeIds.push(outcome.json?.data?._id);
  await expectStatus(
    "outcome list",
    "GET",
    `/outcomes?workspaceId=${workspaceId}`,
    null,
    200,
  );

  const paged = await expectStatus(
    "pagination",
    "GET",
    `/signals?workspaceId=${workspaceId}&page=1&limit=1`,
    null,
    200,
  );
  if (paged.json?.pagination?.limit === 1) ok("pagination shape");
  else fail("pagination shape", JSON.stringify(paged.json?.pagination));

  // ============================================================
  // Tenant / workspace isolation
  // ============================================================
  console.log("\n--- tenant isolation ---");

  const wsA = workspaceId;
  const CROSS = [403, 404];

  const wsBRes = await expectStatus(
    "iso: workspace B create",
    "POST",
    "/workspaces",
    { name: `Phase 2D WS B ${stamp}`, slug: `phase-2d-ws-b-${stamp}` },
    201,
  );
  const wsB = trackCreated(wsBRes, "workspaceIds");

  const propBRes = await expectStatus(
    "iso: property B create",
    "POST",
    "/properties",
    { workspaceId: wsB, name: "B Residences", code: `BR${stamp}` },
    201,
  );
  const propB = trackCreated(propBRes, "propertyIds");

  const unitBRes = await expectStatus(
    "iso: unit B create",
    "POST",
    "/units",
    { workspaceId: wsB, propertyId: propB, unitNumber: "B1" },
    201,
  );
  const unitB = trackCreated(unitBRes, "unitIds");

  const guestBRes = await expectStatus(
    "iso: guest B create",
    "POST",
    "/guests",
    { workspaceId: wsB, firstName: "Bianca", lastName: "Bauer" },
    201,
  );
  const guestB = trackCreated(guestBRes, "guestIds");

  const stayBRes = await expectStatus(
    "iso: stay B create",
    "POST",
    "/stays",
    { workspaceId: wsB, guestId: guestB, propertyId: propB, unitId: unitB, status: "reserved" },
    201,
  );
  const stayB = trackCreated(stayBRes, "stayIds");

  const signalBRes = await expectStatus(
    "iso: signal B create",
    "POST",
    "/signals",
    { workspaceId: wsB, type: "maintenance", title: "B signal" },
    201,
  );
  const signalB = trackCreated(signalBRes, "signalIds");

  const convBRes = await expectStatus(
    "iso: conversation B create",
    "POST",
    "/conversations",
    { workspaceId: wsB, title: "B conversation" },
    201,
  );
  const convB = trackCreated(convBRes, "conversationIds");

  const intelBRes = await expectStatus(
    "iso: intelligence B create",
    "POST",
    "/intelligence",
    { workspaceId: wsB, intelligence: { summary: "B" } },
    201,
  );
  const intelB = trackCreated(intelBRes, "intelligenceIds");

  const decisionBRes = await expectStatus(
    "iso: decision B create",
    "POST",
    "/decisions",
    { workspaceId: wsB, intelligenceId: intelB, description: "B decision" },
    201,
  );
  const decisionB = trackCreated(decisionBRes, "decisionIds");

  const actionBRes = await expectStatus(
    "iso: action B create",
    "POST",
    "/actions",
    { workspaceId: wsB, intelligenceId: intelB, description: "B action" },
    201,
  );
  const actionB = trackCreated(actionBRes, "actionIds");

  const outcomeBRes = await expectStatus(
    "iso: outcome B create",
    "POST",
    "/outcomes",
    { workspaceId: wsB, intelligenceId: intelB },
    201,
  );
  const outcomeB = trackCreated(outcomeBRes, "outcomeIds");

  // --- By-id reads scoped to the caller's workspace (A) ---
  await expectStatusOneOf("A: A cannot GET B property", "GET", `/properties/${propB}?workspaceId=${wsA}`, null, CROSS);
  await expectStatusOneOf("B: A cannot PATCH B property", "PATCH", `/properties/${propB}?workspaceId=${wsA}`, { name: "hijack" }, CROSS);
  await expectStatusOneOf("D: A cannot GET B guest", "GET", `/guests/${guestB}?workspaceId=${wsA}`, null, CROSS);
  await expectStatusOneOf("E: A cannot GET B stay", "GET", `/stays/${stayB}?workspaceId=${wsA}`, null, CROSS);
  await expectStatusOneOf("F: A cannot GET B conversation", "GET", `/conversations/${convB}?workspaceId=${wsA}`, null, CROSS);
  await expectStatusOneOf("F2: A cannot GET B unit (via property)", "GET", `/units/${unitB}?workspaceId=${wsA}`, null, CROSS);
  await expectStatusOneOf("F3: A cannot GET B intelligence", "GET", `/intelligence/${intelB}?workspaceId=${wsA}`, null, CROSS);
  await expectStatusOneOf("F4: A cannot GET B decision", "GET", `/decisions/${decisionB}?workspaceId=${wsA}`, null, CROSS);
  await expectStatusOneOf("F5: A cannot GET B action", "GET", `/actions/${actionB}?workspaceId=${wsA}`, null, CROSS);
  await expectStatusOneOf("F6: A cannot GET B outcome", "GET", `/outcomes/${outcomeB}?workspaceId=${wsA}`, null, CROSS);
  await expectStatusOneOf("F7: A cannot LIST B messages", "GET", `/conversations/${convB}/messages?workspaceId=${wsA}`, null, CROSS);
  await expectStatusOneOf("F8: A cannot POST message into B conversation", "POST", `/conversations/${convB}/messages?workspaceId=${wsA}`, { role: "user", content: "leak" }, CROSS);

  // --- Cross-workspace references rejected on create ---
  trackCreated(await expectStatus("G: stay A !ref guest B", "POST", "/stays", { workspaceId: wsA, guestId: guestB, propertyId }, 400), "stayIds");
  trackCreated(await expectStatus("H: stay A !ref property B", "POST", "/stays", { workspaceId: wsA, guestId, propertyId: propB }, 400), "stayIds");
  trackCreated(await expectStatus("I: stay A !ref unit B", "POST", "/stays", { workspaceId: wsA, guestId, propertyId, unitId: unitB }, 400), "stayIds");

  trackCreated(await expectStatus("J: signal A !ref guest B", "POST", "/signals", { workspaceId: wsA, type: "maintenance", title: "x", guestId: guestB }, 400), "signalIds");
  trackCreated(await expectStatus("K: signal A !ref stay B", "POST", "/signals", { workspaceId: wsA, type: "maintenance", title: "x", stayId: stayB }, 400), "signalIds");
  trackCreated(await expectStatus("L: signal A !ref property B", "POST", "/signals", { workspaceId: wsA, type: "maintenance", title: "x", propertyId: propB }, 400), "signalIds");
  trackCreated(await expectStatus("M: signal A !ref unit B", "POST", "/signals", { workspaceId: wsA, type: "maintenance", title: "x", unitId: unitB }, 400), "signalIds");

  trackCreated(await expectStatus("N: conversation A !ref signal B", "POST", "/conversations", { workspaceId: wsA, signalIds: [signalB] }, 400), "conversationIds");

  trackCreated(await expectStatus("O: intelligence A !ref conversation B", "POST", "/intelligence", { workspaceId: wsA, conversationId: convB }, 400), "intelligenceIds");
  trackCreated(await expectStatus("P: intelligence A !ref signal B", "POST", "/intelligence", { workspaceId: wsA, signalIds: [signalB] }, 400), "intelligenceIds");

  trackCreated(await expectStatus("Q: decision A !ref intelligence B", "POST", "/decisions", { workspaceId: wsA, intelligenceId: intelB, description: "x" }, 400), "decisionIds");

  trackCreated(await expectStatus("R1: action A !ref intelligence B", "POST", "/actions", { workspaceId: wsA, intelligenceId: intelB, description: "x" }, 400), "actionIds");
  trackCreated(await expectStatus("R2: action A !ref decision B", "POST", "/actions", { workspaceId: wsA, intelligenceId, decisionId: decisionB, description: "x" }, 400), "actionIds");

  trackCreated(await expectStatus("S1: outcome A !ref intelligence B", "POST", "/outcomes", { workspaceId: wsA, intelligenceId: intelB }, 400), "outcomeIds");
  trackCreated(await expectStatus("S2: outcome A !ref action B", "POST", "/outcomes", { workspaceId: wsA, intelligenceId, actionId: actionB }, 400), "outcomeIds");

  // --- T: list endpoints never return another workspace's rows ---
  assertListExcludes("T: properties list scoped", await request("GET", `/properties?workspaceId=${wsA}&limit=100`), propB);
  assertListExcludes("T: units list scoped", await request("GET", `/units?workspaceId=${wsA}&limit=100`), unitB);
  assertListExcludes("T: guests list scoped", await request("GET", `/guests?workspaceId=${wsA}&limit=100`), guestB);
  assertListExcludes("T: stays list scoped", await request("GET", `/stays?workspaceId=${wsA}&limit=100`), stayB);
  assertListExcludes("T: signals list scoped", await request("GET", `/signals?workspaceId=${wsA}&limit=100`), signalB);
  assertListExcludes("T: conversations list scoped", await request("GET", `/conversations?workspaceId=${wsA}&limit=100`), convB);
  assertListExcludes("T: intelligence list scoped", await request("GET", `/intelligence?workspaceId=${wsA}&limit=100`), intelB);
  assertListExcludes("T: decisions list scoped", await request("GET", `/decisions?workspaceId=${wsA}&limit=100`), decisionB);
  assertListExcludes("T: actions list scoped", await request("GET", `/actions?workspaceId=${wsA}&limit=100`), actionB);
  assertListExcludes("T: outcomes list scoped", await request("GET", `/outcomes?workspaceId=${wsA}&limit=100`), outcomeB);

  // --- T: tenant-owned list without workspaceId -> clean 400, never a full dump ---
  await expectStatus("T: properties list requires workspaceId", "GET", "/properties", null, 400);
  await expectStatus("T: units list requires workspaceId", "GET", "/units", null, 400);
  await expectStatus("T: guests list requires workspaceId", "GET", "/guests", null, 400);
  await expectStatus("T: stays list requires workspaceId", "GET", "/stays", null, 400);
  await expectStatus("T: signals list requires workspaceId", "GET", "/signals", null, 400);
  await expectStatus("T: conversations list requires workspaceId", "GET", "/conversations", null, 400);
  await expectStatus("T: intelligence list requires workspaceId", "GET", "/intelligence", null, 400);
  await expectStatus("T: decisions list requires workspaceId", "GET", "/decisions", null, 400);
  await expectStatus("T: actions list requires workspaceId", "GET", "/actions", null, 400);
  await expectStatus("T: outcomes list requires workspaceId", "GET", "/outcomes", null, 400);

  // --- U: PATCH cannot move a resource to another workspace ---
  await expectStatus("U: PATCH cannot change workspaceId", "PATCH", `/properties/${propertyId}?workspaceId=${wsA}`, { workspaceId: wsB, name: "still A" }, 400);
  const uCheck = await request("GET", `/properties/${propertyId}?workspaceId=${wsA}`);
  if (String(uCheck.json?.data?.workspaceId) === String(wsA)) ok("U: property A still in workspace A");
  else fail("U: property A still in workspace A", JSON.stringify(uCheck.json?.data?.workspaceId));

  // --- Regression: generic validation behavior is unchanged ---
  await expectStatus("reg: malformed id still 400", "GET", `/properties/not-an-id?workspaceId=${wsA}`, null, 400);
  await expectStatus("reg: unknown reference still 404", "GET", `/properties/64b64c4f2f1c2e0012345678?workspaceId=${wsA}`, null, 404);
  await expectStatus("reg: duplicate constraint still 409", "POST", "/properties", { workspaceId: wsB, name: "Dupe", code: `BR${stamp}` }, 409);
  await expectStatus("reg: in-workspace CRUD still works", "GET", `/properties/${propertyId}?workspaceId=${wsA}`, null, 200);

  // --- C & V: destructive cross-workspace attempts, run last; targets must survive ---
  await expectStatusOneOf("C: A cannot DELETE B property", "DELETE", `/properties/${propB}?workspaceId=${wsA}`, null, CROSS);
  await expectStatus("C: B property survived", "GET", `/properties/${propB}?workspaceId=${wsB}`, null, 200);
  await expectStatusOneOf("V: A cannot DELETE B guest", "DELETE", `/guests/${guestB}?workspaceId=${wsA}`, null, CROSS);
  await expectStatus("V: B guest survived", "GET", `/guests/${guestB}?workspaceId=${wsB}`, null, 200);

  await cleanup();
  ok("mongodb cleanup");

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(async (error) => {
  console.error("Test runner failed:", error);
  try {
    await cleanup();
  } catch {
    // ignore cleanup errors
  }
  process.exit(1);
});
