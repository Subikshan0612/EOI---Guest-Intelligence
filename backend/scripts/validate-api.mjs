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
    { propertyId, unitNumber: "402", type: "apartment" },
    201,
  );
  const unitId = unit.json?.data?._id;
  created.unitIds.push(unitId);
  await expectStatus("unit list", "GET", `/units?propertyId=${propertyId}`, null, 200);

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
    `/conversations/${conversationId}/messages`,
    { role: "user", type: "text", content: "Guest says AC is not cooling." },
    201,
  );
  created.messageIds.push(message.json?.data?._id);
  await expectStatus(
    "message list",
    "GET",
    `/conversations/${conversationId}/messages`,
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
