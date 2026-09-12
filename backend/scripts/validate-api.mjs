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

  // ============================================================
  // Phase 3B — Guest + Stay CRUD completeness, cross-reference,
  // date validation, and overlap rules
  // ============================================================
  console.log("\n--- phase 3B: guest + stay ---");

  // --- Guest CRUD completeness (create/list already covered above) ---
  await expectStatus("3B guest get", "GET", `/guests/${guestId}?workspaceId=${wsA}`, null, 200);
  await expectStatus(
    "3B guest update",
    "PATCH",
    `/guests/${guestId}?workspaceId=${wsA}`,
    { phone: "+1 415 555 0100" },
    200,
  );

  const disposableGuestRes = await expectStatus(
    "3B disposable guest create",
    "POST",
    "/guests",
    { workspaceId: wsA, firstName: "Temp", lastName: "Guest" },
    201,
  );
  const disposableGuestId = trackCreated(disposableGuestRes, "guestIds");
  await expectStatus(
    "3B guest delete",
    "DELETE",
    `/guests/${disposableGuestId}?workspaceId=${wsA}`,
    null,
    200,
  );
  await expectStatus(
    "3B guest delete confirmed gone",
    "GET",
    `/guests/${disposableGuestId}?workspaceId=${wsA}`,
    null,
    404,
  );

  // --- Stay CRUD completeness ---
  await expectStatus("3B stay get", "GET", `/stays/${stayId}?workspaceId=${wsA}`, null, 200);
  await expectStatus(
    "3B stay update",
    "PATCH",
    `/stays/${stayId}?workspaceId=${wsA}`,
    { adults: 2 },
    200,
  );

  // --- Stay cross-workspace PATCH/DELETE (completes isolation coverage for Stay) ---
  await expectStatusOneOf(
    "3B: A cannot PATCH B stay",
    "PATCH",
    `/stays/${stayB}?workspaceId=${wsA}`,
    { status: "cancelled" },
    CROSS,
  );
  await expectStatusOneOf(
    "3B: A cannot DELETE B stay",
    "DELETE",
    `/stays/${stayB}?workspaceId=${wsA}`,
    null,
    CROSS,
  );
  await expectStatus("3B: B stay survived", "GET", `/stays/${stayB}?workspaceId=${wsB}`, null, 200);

  // --- Unit/Property mismatch WITHIN the same workspace (distinct from the
  // cross-workspace case already covered by test "I") ---
  const propA2Res = await expectStatus(
    "3B second property in A",
    "POST",
    "/properties",
    { workspaceId: wsA, name: "Second Property", code: `SP${stamp}` },
    201,
  );
  const propA2 = trackCreated(propA2Res, "propertyIds");
  const unitA2Res = await expectStatus(
    "3B unit under second property",
    "POST",
    "/units",
    { workspaceId: wsA, propertyId: propA2, unitNumber: "A2-1" },
    201,
  );
  const unitA2 = trackCreated(unitA2Res, "unitIds");
  trackCreated(
    await expectStatus(
      "3B: unit/property mismatch same workspace rejected",
      "POST",
      "/stays",
      { workspaceId: wsA, guestId, propertyId, unitId: unitA2 },
      400,
    ),
    "stayIds",
  );

  // --- Date validation ---
  trackCreated(
    await expectStatus(
      "3B: checkOut before checkIn rejected",
      "POST",
      "/stays",
      {
        workspaceId: wsA,
        guestId,
        propertyId,
        checkIn: "2026-01-10T00:00:00.000Z",
        checkOut: "2026-01-05T00:00:00.000Z",
      },
      400,
    ),
    "stayIds",
  );
  trackCreated(
    await expectStatus(
      "3B: invalid date value rejected",
      "POST",
      "/stays",
      { workspaceId: wsA, guestId, propertyId, checkIn: "not-a-date" },
      400,
    ),
    "stayIds",
  );

  // --- Overlap rule ---
  // Occupying statuses: reserved, confirmed, checked_in. checked_out/cancelled/
  // no_show never conflict. Overlap is only checked when a stay has BOTH a
  // unit and a full [checkIn, checkOut) range — half-open, so a checkout the
  // same day as the next guest's checkin is NOT a conflict.
  const overlapUnitRes = await expectStatus(
    "3B overlap-test unit create",
    "POST",
    "/units",
    { workspaceId: wsA, propertyId, unitNumber: `OVL-${stamp}` },
    201,
  );
  const overlapUnitId = trackCreated(overlapUnitRes, "unitIds");

  const baseStayRes = await expectStatus(
    "3B: base stay for overlap create",
    "POST",
    "/stays",
    {
      workspaceId: wsA,
      guestId,
      propertyId,
      unitId: overlapUnitId,
      status: "confirmed",
      checkIn: "2026-03-01T00:00:00.000Z",
      checkOut: "2026-03-05T00:00:00.000Z",
    },
    201,
  );
  trackCreated(baseStayRes, "stayIds");

  trackCreated(
    await expectStatus(
      "3B: overlapping stay rejected",
      "POST",
      "/stays",
      {
        workspaceId: wsA,
        guestId,
        propertyId,
        unitId: overlapUnitId,
        status: "reserved",
        checkIn: "2026-03-03T00:00:00.000Z",
        checkOut: "2026-03-07T00:00:00.000Z",
      },
      409,
    ),
    "stayIds",
  );

  const backToBackRes = await expectStatus(
    "3B: non-overlapping back-to-back stay accepted",
    "POST",
    "/stays",
    {
      workspaceId: wsA,
      guestId,
      propertyId,
      unitId: overlapUnitId,
      status: "reserved",
      checkIn: "2026-03-05T00:00:00.000Z",
      checkOut: "2026-03-08T00:00:00.000Z",
    },
    201,
  );
  const backToBackId = trackCreated(backToBackRes, "stayIds");

  trackCreated(
    await expectStatus(
      "3B: cancelled stay does not block overlap",
      "POST",
      "/stays",
      {
        workspaceId: wsA,
        guestId,
        propertyId,
        unitId: overlapUnitId,
        status: "cancelled",
        checkIn: "2026-03-01T00:00:00.000Z",
        checkOut: "2026-03-05T00:00:00.000Z",
      },
      201,
    ),
    "stayIds",
  );

  await expectStatus(
    "3B: update into overlap rejected",
    "PATCH",
    `/stays/${backToBackId}?workspaceId=${wsA}`,
    { checkIn: "2026-03-04T00:00:00.000Z" },
    409,
  );

  // ============================================================
  // Phase 3C — Signal CRUD completeness, cross-workspace isolation,
  // relationship consistency, filters, and date validation
  // ============================================================
  console.log("\n--- phase 3C: signal ---");

  // --- Signal CRUD completeness (create/list already covered above) ---
  await expectStatus("3C signal get", "GET", `/signals/${signalId}?workspaceId=${wsA}`, null, 200);
  await expectStatus(
    "3C signal update",
    "PATCH",
    `/signals/${signalId}?workspaceId=${wsA}`,
    { status: "acknowledged" },
    200,
  );

  const disposableSignalRes = await expectStatus(
    "3C disposable signal create",
    "POST",
    "/signals",
    { workspaceId: wsA, type: "other", title: "Temp signal" },
    201,
  );
  const disposableSignalId = trackCreated(disposableSignalRes, "signalIds");
  await expectStatus(
    "3C signal delete",
    "DELETE",
    `/signals/${disposableSignalId}?workspaceId=${wsA}`,
    null,
    200,
  );
  await expectStatus(
    "3C signal delete confirmed gone",
    "GET",
    `/signals/${disposableSignalId}?workspaceId=${wsA}`,
    null,
    404,
  );

  // --- Cross-workspace Signal GET/PATCH/DELETE (signalB created earlier) ---
  await expectStatusOneOf(
    "3C: A cannot GET B signal",
    "GET",
    `/signals/${signalB}?workspaceId=${wsA}`,
    null,
    CROSS,
  );
  await expectStatusOneOf(
    "3C: A cannot PATCH B signal",
    "PATCH",
    `/signals/${signalB}?workspaceId=${wsA}`,
    { status: "resolved" },
    CROSS,
  );
  await expectStatusOneOf(
    "3C: A cannot DELETE B signal",
    "DELETE",
    `/signals/${signalB}?workspaceId=${wsA}`,
    null,
    CROSS,
  );
  await expectStatus("3C: B signal survived", "GET", `/signals/${signalB}?workspaceId=${wsB}`, null, 200);

  // --- Relationship consistency: same-workspace mismatches (distinct from
  // the cross-workspace J/K/L/M tests above, which cover a different tenant) ---
  trackCreated(
    await expectStatus(
      "3C: unit/property mismatch rejected",
      "POST",
      "/signals",
      { workspaceId: wsA, type: "maintenance", title: "x", propertyId, unitId: unitA2 },
      400,
    ),
    "signalIds",
  );

  const guestA2Res = await expectStatus(
    "3C second guest in A",
    "POST",
    "/guests",
    { workspaceId: wsA, firstName: "Second", lastName: "Guest" },
    201,
  );
  const guestA2 = trackCreated(guestA2Res, "guestIds");

  trackCreated(
    await expectStatus(
      "3C: stay/guest mismatch rejected",
      "POST",
      "/signals",
      { workspaceId: wsA, type: "maintenance", title: "x", stayId, guestId: guestA2 },
      400,
    ),
    "signalIds",
  );
  trackCreated(
    await expectStatus(
      "3C: stay/property mismatch rejected",
      "POST",
      "/signals",
      { workspaceId: wsA, type: "maintenance", title: "x", stayId, propertyId: propA2 },
      400,
    ),
    "signalIds",
  );
  trackCreated(
    await expectStatus(
      "3C: stay/unit mismatch rejected",
      "POST",
      "/signals",
      { workspaceId: wsA, type: "maintenance", title: "x", stayId, unitId: unitA2 },
      400,
    ),
    "signalIds",
  );

  // --- Operational filters (the main-flow signalId carries property, unit,
  // guest, stay, and type "maintenance" all at once) ---
  const typeFilterRes = await request("GET", `/signals?workspaceId=${wsA}&type=maintenance`);
  if ((typeFilterRes.json?.data || []).some((s) => s._id === signalId)) ok("3C: type filter includes signal");
  else fail("3C: type filter includes signal", JSON.stringify(typeFilterRes.json));

  const propertyFilterRes = await request(
    "GET",
    `/signals?workspaceId=${wsA}&propertyId=${propertyId}`,
  );
  if ((propertyFilterRes.json?.data || []).some((s) => s._id === signalId)) {
    ok("3C: property filter includes signal");
  } else {
    fail("3C: property filter includes signal", JSON.stringify(propertyFilterRes.json));
  }

  const unitFilterRes = await request("GET", `/signals?workspaceId=${wsA}&unitId=${unitId}`);
  if ((unitFilterRes.json?.data || []).some((s) => s._id === signalId)) ok("3C: unit filter includes signal");
  else fail("3C: unit filter includes signal", JSON.stringify(unitFilterRes.json));

  const guestFilterRes = await request("GET", `/signals?workspaceId=${wsA}&guestId=${guestId}`);
  if ((guestFilterRes.json?.data || []).some((s) => s._id === signalId)) ok("3C: guest filter includes signal");
  else fail("3C: guest filter includes signal", JSON.stringify(guestFilterRes.json));

  const stayFilterRes = await request("GET", `/signals?workspaceId=${wsA}&stayId=${stayId}`);
  if ((stayFilterRes.json?.data || []).some((s) => s._id === signalId)) ok("3C: stay filter includes signal");
  else fail("3C: stay filter includes signal", JSON.stringify(stayFilterRes.json));

  // --- Date validation ---
  trackCreated(
    await expectStatus(
      "3C: invalid occurredAt rejected",
      "POST",
      "/signals",
      { workspaceId: wsA, type: "other", title: "x", occurredAt: "not-a-date" },
      400,
    ),
    "signalIds",
  );

  // ============================================================
  // Phase 3D — Deterministic Operational Context Assembly
  // ============================================================
  console.log("\n--- phase 3D: context ---");

  // --- Valid retrieval: signalId (from the main flow) has property, unit,
  // guest and stay all set and mutually consistent. ---
  const ctxRes = await expectStatus(
    "3D: context retrieval",
    "GET",
    `/signals/${signalId}/context?workspaceId=${wsA}`,
    null,
    200,
  );
  const ctx = ctxRes.json?.data;

  if (ctx?.signal?.id === signalId) ok("3D: context.signal matches requested signal");
  else fail("3D: context.signal matches requested signal", JSON.stringify(ctx?.signal));

  if (ctx?.signal && !("__v" in ctx.signal) && !("_id" in ctx.signal)) {
    ok("3D: context.signal has no Mongo internals");
  } else {
    fail("3D: context.signal has no Mongo internals", JSON.stringify(ctx?.signal));
  }

  if (ctx?.guest?.available === true && ctx?.guest?.id === guestId) ok("3D: context.guest resolved");
  else fail("3D: context.guest resolved", JSON.stringify(ctx?.guest));

  if (Array.isArray(ctx?.guest?.recentStays) && ctx.guest.recentStays.some((s) => s.id === stayId)) {
    ok("3D: context.guest.recentStays includes current stay");
  } else {
    fail("3D: context.guest.recentStays includes current stay", JSON.stringify(ctx?.guest?.recentStays));
  }

  if (ctx?.stay?.available === true && ctx?.stay?.id === stayId) ok("3D: context.stay resolved");
  else fail("3D: context.stay resolved", JSON.stringify(ctx?.stay));

  if (ctx?.property?.available === true && ctx?.property?.id === propertyId) {
    ok("3D: context.property resolved");
  } else {
    fail("3D: context.property resolved", JSON.stringify(ctx?.property));
  }

  if (ctx?.unit?.available === true && ctx?.unit?.id === unitId) ok("3D: context.unit resolved");
  else fail("3D: context.unit resolved", JSON.stringify(ctx?.unit));

  if (Array.isArray(ctx?.history?.signals)) ok("3D: context.history.signals is an array");
  else fail("3D: context.history.signals is an array");

  await expectStatus("3D: context requires workspaceId", "GET", `/signals/${signalId}/context`, null, 400);
  await expectStatus(
    "3D: context 404 for unknown signal",
    "GET",
    `/signals/64b64c4f2f1c2e0012345678/context?workspaceId=${wsA}`,
    null,
    404,
  );

  // --- Read-only: fetching context must never mutate the Signal or its Guest. ---
  const beforeSignal = await request("GET", `/signals/${signalId}?workspaceId=${wsA}`);
  const beforeGuest = await request("GET", `/guests/${guestId}?workspaceId=${wsA}`);
  await request("GET", `/signals/${signalId}/context?workspaceId=${wsA}`);
  const afterSignal = await request("GET", `/signals/${signalId}?workspaceId=${wsA}`);
  const afterGuest = await request("GET", `/guests/${guestId}?workspaceId=${wsA}`);
  if (beforeSignal.json?.data?.updatedAt === afterSignal.json?.data?.updatedAt) {
    ok("3D: context fetch did not mutate the Signal");
  } else {
    fail("3D: context fetch did not mutate the Signal");
  }
  if (beforeGuest.json?.data?.updatedAt === afterGuest.json?.data?.updatedAt) {
    ok("3D: context fetch did not mutate the Guest");
  } else {
    fail("3D: context fetch did not mutate the Guest");
  }

  // --- Graceful degradation: deleted/missing optional references must never
  // crash the endpoint or fabricate data — only mark `available: false`. ---
  const ghostGuestRes = await expectStatus(
    "3D: ghost guest create",
    "POST",
    "/guests",
    { workspaceId: wsA, firstName: "Ghost", lastName: "Guest" },
    201,
  );
  const ghostGuestId = ghostGuestRes.json?.data?._id;
  const ghostSignalGRes = await expectStatus(
    "3D: ghost-guest signal create",
    "POST",
    "/signals",
    { workspaceId: wsA, type: "other", title: "Ghost guest signal", guestId: ghostGuestId },
    201,
  );
  const ghostSignalGId = trackCreated(ghostSignalGRes, "signalIds");
  await expectStatus("3D: delete ghost guest", "DELETE", `/guests/${ghostGuestId}?workspaceId=${wsA}`, null, 200);
  const ghostGuestCtxRes = await expectStatus(
    "3D: context survives deleted guest",
    "GET",
    `/signals/${ghostSignalGId}/context?workspaceId=${wsA}`,
    null,
    200,
  );
  const ghostGuestCtx = ghostGuestCtxRes.json?.data;
  if (ghostGuestCtx?.guest?.available === false && ghostGuestCtx?.guest?.id === ghostGuestId) {
    ok("3D: deleted guest reported unavailable, not fabricated");
  } else {
    fail("3D: deleted guest reported unavailable, not fabricated", JSON.stringify(ghostGuestCtx?.guest));
  }

  const ghostPropRes = await expectStatus(
    "3D: ghost property create",
    "POST",
    "/properties",
    { workspaceId: wsA, name: "Ghost Property", code: `GHP${stamp}` },
    201,
  );
  const ghostPropId = ghostPropRes.json?.data?._id;
  const ghostSignalPRes = await expectStatus(
    "3D: ghost-property signal create",
    "POST",
    "/signals",
    { workspaceId: wsA, type: "other", title: "Ghost property signal", propertyId: ghostPropId },
    201,
  );
  const ghostSignalPId = trackCreated(ghostSignalPRes, "signalIds");
  await expectStatus("3D: delete ghost property", "DELETE", `/properties/${ghostPropId}?workspaceId=${wsA}`, null, 200);
  const ghostPropCtxRes = await expectStatus(
    "3D: context survives deleted property",
    "GET",
    `/signals/${ghostSignalPId}/context?workspaceId=${wsA}`,
    null,
    200,
  );
  const ghostPropCtx = ghostPropCtxRes.json?.data;
  if (ghostPropCtx?.property?.available === false && ghostPropCtx?.property?.id === ghostPropId) {
    ok("3D: deleted property reported unavailable, not fabricated");
  } else {
    fail("3D: deleted property reported unavailable, not fabricated", JSON.stringify(ghostPropCtx?.property));
  }

  const ghostUnitPropRes = await expectStatus(
    "3D: ghost-unit host property create",
    "POST",
    "/properties",
    { workspaceId: wsA, name: "Ghost Unit Host", code: `GHU${stamp}` },
    201,
  );
  const ghostUnitPropId = ghostUnitPropRes.json?.data?._id;
  const ghostUnitRes = await expectStatus(
    "3D: ghost unit create",
    "POST",
    "/units",
    { workspaceId: wsA, propertyId: ghostUnitPropId, unitNumber: "GHOST-1" },
    201,
  );
  const ghostUnitId = ghostUnitRes.json?.data?._id;
  const ghostSignalURes = await expectStatus(
    "3D: ghost-unit signal create",
    "POST",
    "/signals",
    { workspaceId: wsA, type: "other", title: "Ghost unit signal", unitId: ghostUnitId },
    201,
  );
  const ghostSignalUId = trackCreated(ghostSignalURes, "signalIds");
  await expectStatus("3D: delete ghost unit", "DELETE", `/units/${ghostUnitId}?workspaceId=${wsA}`, null, 200);
  const ghostUnitCtxRes = await expectStatus(
    "3D: context survives deleted unit",
    "GET",
    `/signals/${ghostSignalUId}/context?workspaceId=${wsA}`,
    null,
    200,
  );
  const ghostUnitCtx = ghostUnitCtxRes.json?.data;
  if (ghostUnitCtx?.unit?.available === false && ghostUnitCtx?.unit?.id === ghostUnitId) {
    ok("3D: deleted unit reported unavailable, not fabricated");
  } else {
    fail("3D: deleted unit reported unavailable, not fabricated", JSON.stringify(ghostUnitCtx?.unit));
  }
  created.propertyIds.push(ghostUnitPropId);

  const ghostStayGuestRes = await expectStatus(
    "3D: ghost-stay guest create",
    "POST",
    "/guests",
    { workspaceId: wsA, firstName: "Stay", lastName: "Ghost" },
    201,
  );
  const ghostStayGuestId = trackCreated(ghostStayGuestRes, "guestIds");
  const ghostStayRes = await expectStatus(
    "3D: ghost stay create",
    "POST",
    "/stays",
    { workspaceId: wsA, guestId: ghostStayGuestId, propertyId, status: "reserved" },
    201,
  );
  const ghostStayId = ghostStayRes.json?.data?._id;
  const ghostSignalSRes = await expectStatus(
    "3D: ghost-stay signal create",
    "POST",
    "/signals",
    { workspaceId: wsA, type: "other", title: "Ghost stay signal", stayId: ghostStayId },
    201,
  );
  const ghostSignalSId = trackCreated(ghostSignalSRes, "signalIds");
  await expectStatus("3D: delete ghost stay", "DELETE", `/stays/${ghostStayId}?workspaceId=${wsA}`, null, 200);
  const ghostStayCtxRes = await expectStatus(
    "3D: context survives deleted stay",
    "GET",
    `/signals/${ghostSignalSId}/context?workspaceId=${wsA}`,
    null,
    200,
  );
  const ghostStayCtx = ghostStayCtxRes.json?.data;
  if (ghostStayCtx?.stay?.available === false && ghostStayCtx?.stay?.id === ghostStayId) {
    ok("3D: deleted stay reported unavailable, not fabricated");
  } else {
    fail("3D: deleted stay reported unavailable, not fabricated", JSON.stringify(ghostStayCtx?.stay));
  }

  // --- Historical signals: priority categories, dedup, self-exclusion, order ---
  const now = Date.now();
  const histStayRes = await expectStatus(
    "3D: history signal (same stay) create",
    "POST",
    "/signals",
    { workspaceId: wsA, type: "housekeeping", title: "Housekeeping — same stay", stayId, occurredAt: new Date(now - 4 * 60000).toISOString() },
    201,
  );
  const histStayId = trackCreated(histStayRes, "signalIds");

  const histGuestRes = await expectStatus(
    "3D: history signal (same guest) create",
    "POST",
    "/signals",
    { workspaceId: wsA, type: "complaint", title: "Complaint — same guest", guestId, occurredAt: new Date(now - 3 * 60000).toISOString() },
    201,
  );
  const histGuestId = trackCreated(histGuestRes, "signalIds");

  const histUnitRes = await expectStatus(
    "3D: history signal (same unit) create",
    "POST",
    "/signals",
    { workspaceId: wsA, type: "maintenance", title: "Maintenance — same unit", unitId, occurredAt: new Date(now - 2 * 60000).toISOString() },
    201,
  );
  const histUnitId = trackCreated(histUnitRes, "signalIds");

  const histPropertyRes = await expectStatus(
    "3D: history signal (same property) create",
    "POST",
    "/signals",
    { workspaceId: wsA, type: "arrival", title: "Arrival — same property", propertyId, occurredAt: new Date(now - 1 * 60000).toISOString() },
    201,
  );
  const histPropertyId = trackCreated(histPropertyRes, "signalIds");

  const histMultiRes = await expectStatus(
    "3D: history signal (guest + unit, dedup) create",
    "POST",
    "/signals",
    { workspaceId: wsA, type: "other", title: "Multi-match — guest and unit", guestId, unitId, occurredAt: new Date(now - 5 * 60000).toISOString() },
    201,
  );
  const histMultiId = trackCreated(histMultiRes, "signalIds");

  const histUnrelatedRes = await expectStatus(
    "3D: history signal (unrelated guest, must be excluded) create",
    "POST",
    "/signals",
    { workspaceId: wsA, type: "other", title: "Unrelated guest signal", guestId: guestA2, occurredAt: new Date(now - 6 * 60000).toISOString() },
    201,
  );
  const histUnrelatedId = trackCreated(histUnrelatedRes, "signalIds");

  const histCtxRes = await expectStatus(
    "3D: history context retrieval",
    "GET",
    `/signals/${signalId}/context?workspaceId=${wsA}`,
    null,
    200,
  );
  const histSignals = histCtxRes.json?.data?.history?.signals || [];
  const histById = new Map(histSignals.map((s) => [s.id, s]));

  if (!histById.has(signalId)) ok("3D: history never includes the current signal itself");
  else fail("3D: history never includes the current signal itself");

  if (histById.has(histStayId) && histById.get(histStayId).matchedBy.includes("stay")) {
    ok("3D: same-stay historical signal included and tagged");
  } else {
    fail("3D: same-stay historical signal included and tagged", JSON.stringify(histById.get(histStayId)));
  }

  if (histById.has(histGuestId) && histById.get(histGuestId).matchedBy.includes("guest")) {
    ok("3D: same-guest historical signal included and tagged");
  } else {
    fail("3D: same-guest historical signal included and tagged", JSON.stringify(histById.get(histGuestId)));
  }

  if (histById.has(histUnitId) && histById.get(histUnitId).matchedBy.includes("unit")) {
    ok("3D: same-unit historical signal included and tagged");
  } else {
    fail("3D: same-unit historical signal included and tagged", JSON.stringify(histById.get(histUnitId)));
  }

  if (histById.has(histPropertyId) && histById.get(histPropertyId).matchedBy.includes("property")) {
    ok("3D: same-property historical signal included and tagged");
  } else {
    fail("3D: same-property historical signal included and tagged", JSON.stringify(histById.get(histPropertyId)));
  }

  const multiEntries = histSignals.filter((s) => s.id === histMultiId);
  if (
    multiEntries.length === 1 &&
    multiEntries[0].matchedBy.includes("guest") &&
    multiEntries[0].matchedBy.includes("unit")
  ) {
    ok("3D: multi-category match deduplicated to a single entry tagged with both categories");
  } else {
    fail(
      "3D: multi-category match deduplicated to a single entry tagged with both categories",
      JSON.stringify(multiEntries),
    );
  }

  if (!histById.has(histUnrelatedId)) ok("3D: unrelated signal excluded from history");
  else fail("3D: unrelated signal excluded from history");

  const relevantOrder = [histPropertyId, histUnitId, histGuestId, histStayId, histMultiId].filter((id) =>
    histById.has(id),
  );
  const actualOrder = histSignals.map((s) => s.id).filter((id) => relevantOrder.includes(id));
  const expectedOrder = [histPropertyId, histUnitId, histGuestId, histStayId, histMultiId];
  if (JSON.stringify(actualOrder) === JSON.stringify(expectedOrder)) {
    ok("3D: history ordered by occurredAt descending");
  } else {
    fail("3D: history ordered by occurredAt descending", JSON.stringify({ actualOrder, expectedOrder }));
  }

  // --- Limit: history is capped even when far more candidates exist. ---
  const limitPropRes = await expectStatus(
    "3D: limit-test property create",
    "POST",
    "/properties",
    { workspaceId: wsA, name: "Limit Test Property", code: `LIM${stamp}` },
    201,
  );
  const limitPropertyId = trackCreated(limitPropRes, "propertyIds");

  const limitSignalIds = [];
  for (let i = 0; i < 22; i += 1) {
    const occurredAt = new Date(now - (100 - i) * 60000).toISOString();
    const res = await expectStatus(
      `3D: limit fixture signal ${i}`,
      "POST",
      "/signals",
      { workspaceId: wsA, type: "other", title: `Limit signal ${i}`, propertyId: limitPropertyId, occurredAt },
      201,
    );
    limitSignalIds.push(trackCreated(res, "signalIds"));
  }

  const limitCtxRes = await expectStatus(
    "3D: limit context retrieval",
    "GET",
    `/signals/${limitSignalIds[0]}/context?workspaceId=${wsA}`,
    null,
    200,
  );
  const limitHistory = limitCtxRes.json?.data?.history?.signals || [];
  if (limitHistory.length === 20) ok("3D: history capped at 20 entries");
  else fail("3D: history capped at 20 entries", `got ${limitHistory.length}`);

  const limitHistoryIds = new Set(limitHistory.map((s) => s.id));
  if (!limitHistoryIds.has(limitSignalIds[1])) ok("3D: history excludes the oldest signal beyond the cap");
  else fail("3D: history excludes the oldest signal beyond the cap");
  if (limitHistoryIds.has(limitSignalIds[21])) ok("3D: history includes the most recent signal within the cap");
  else fail("3D: history includes the most recent signal within the cap");

  // --- Priority: same-Stay matches must fill their slots before same-Property
  // matches, even when the property matches are individually more recent. ---
  const priPropRes = await expectStatus(
    "3D: priority-test property create",
    "POST",
    "/properties",
    { workspaceId: wsA, name: "Priority Test Property", code: `PRI${stamp}` },
    201,
  );
  const priPropertyId = trackCreated(priPropRes, "propertyIds");
  const priGuestRes = await expectStatus(
    "3D: priority-test guest create",
    "POST",
    "/guests",
    { workspaceId: wsA, firstName: "Priority", lastName: "Test" },
    201,
  );
  const priGuestId = trackCreated(priGuestRes, "guestIds");
  const priStayRes = await expectStatus(
    "3D: priority-test stay create",
    "POST",
    "/stays",
    { workspaceId: wsA, guestId: priGuestId, propertyId: priPropertyId, status: "checked_in" },
    201,
  );
  const priStayId = trackCreated(priStayRes, "stayIds");
  const priSubjectRes = await expectStatus(
    "3D: priority-test subject signal create",
    "POST",
    "/signals",
    { workspaceId: wsA, type: "other", title: "Priority subject", stayId: priStayId, propertyId: priPropertyId },
    201,
  );
  const priSubjectId = trackCreated(priSubjectRes, "signalIds");

  const priStayMatchIds = [];
  for (let i = 0; i < 12; i += 1) {
    const occurredAt = new Date(now - (100 - i) * 60000).toISOString();
    const res = await expectStatus(
      `3D: priority stay-match ${i}`,
      "POST",
      "/signals",
      { workspaceId: wsA, type: "other", title: `Priority stay match ${i}`, stayId: priStayId, occurredAt },
      201,
    );
    priStayMatchIds.push(trackCreated(res, "signalIds"));
  }

  const priPropertyMatchIds = [];
  for (let i = 0; i < 12; i += 1) {
    const occurredAt = new Date(now - (12 - i) * 60000).toISOString();
    const res = await expectStatus(
      `3D: priority property-match ${i}`,
      "POST",
      "/signals",
      { workspaceId: wsA, type: "other", title: `Priority property match ${i}`, propertyId: priPropertyId, occurredAt },
      201,
    );
    priPropertyMatchIds.push(trackCreated(res, "signalIds"));
  }

  const priCtxRes = await expectStatus(
    "3D: priority context retrieval",
    "GET",
    `/signals/${priSubjectId}/context?workspaceId=${wsA}`,
    null,
    200,
  );
  const priHistory = priCtxRes.json?.data?.history?.signals || [];
  const priHistoryIds = new Set(priHistory.map((s) => s.id));

  if (priHistory.length === 20) ok("3D: priority — total still capped at 20");
  else fail("3D: priority — total still capped at 20", `got ${priHistory.length}`);

  if (priStayMatchIds.every((id) => priHistoryIds.has(id))) {
    ok("3D: priority — all same-stay matches included ahead of same-property matches");
  } else {
    fail("3D: priority — all same-stay matches included ahead of same-property matches");
  }

  const excludedPropertyMatches = priPropertyMatchIds.slice(0, 4);
  const includedPropertyMatches = priPropertyMatchIds.slice(4);
  if (
    excludedPropertyMatches.every((id) => !priHistoryIds.has(id)) &&
    includedPropertyMatches.every((id) => priHistoryIds.has(id))
  ) {
    ok("3D: priority — only the most recent property matches fill remaining slots");
  } else {
    fail("3D: priority — only the most recent property matches fill remaining slots");
  }

  // --- Tenant isolation: 6 explicit cases ---
  await expectStatusOneOf(
    "3D iso 1: A cannot GET B signal's context",
    "GET",
    `/signals/${signalB}/context?workspaceId=${wsA}`,
    null,
    CROSS,
  );
  await expectStatus(
    "3D iso 2: B can GET its own signal's context",
    "GET",
    `/signals/${signalB}/context?workspaceId=${wsB}`,
    null,
    200,
  );
  if (ctx?.guest?.id !== guestB) ok("3D iso 3: A's context.guest is never B's guest");
  else fail("3D iso 3: A's context.guest is never B's guest");
  if (ctx?.property?.id !== propB) ok("3D iso 4: A's context.property is never B's property");
  else fail("3D iso 4: A's context.property is never B's property");
  if (ctx?.unit?.id !== unitB) ok("3D iso 5: A's context.unit is never B's unit");
  else fail("3D iso 5: A's context.unit is never B's unit");
  if (!histSignals.some((s) => s.id === signalB)) ok("3D iso 6: A's history never includes B's signal");
  else fail("3D iso 6: A's history never includes B's signal");

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
