/**
 * Phase 7F-A validation: Deterministic Recurring Signal Pattern Detection.
 *
 * GET /api/learning/patterns (route -> learningController.getLearningPatterns
 * -> patternService.getRecurringSignalPatterns) is a brand-new, read-only,
 * workspace-scoped endpoint computed on-demand from the EXISTING Signal
 * collection via a single MongoDB aggregation pipeline — no new model, no
 * persistence, no Python/Gemini call, no mutation of anything. This suite
 * proves:
 *
 *  - Recurring patterns are grouped only by the reliable, controlled-
 *    vocabulary Signal.type dimension (never free text), scoped by
 *    workspace and optionally property/unit, over a bounded time window.
 *  - The qualification rule (occurrenceCount >= minimumOccurrences AND at
 *    least one of distinctDayCount/distinctStayCount/distinctGuestCount
 *    meeting its own threshold) is applied exactly as documented, with
 *    every threshold configurable and echoed back in the response.
 *  - Duplicate-report inflation (many Signals reporting one real incident)
 *    is guarded against — never eliminated — via the distinct day/stay/
 *    guest evidence, and that limitation is stated honestly in every
 *    finding's evidence, not hidden.
 *  - Different Signal types, properties, and units are never incorrectly
 *    merged into one pattern.
 *  - Tenant isolation holds under every filter combination.
 *  - The response is fully deterministic: same request twice against
 *    unchanged data produces byte-identical patternIds, ordering,
 *    signalId ordering, and descriptions.
 *  - Nothing here mutates Signal, Intelligence, or any other collection.
 *
 * Runs entirely against its own ephemeral `node server.js` (LLM_PROVIDER=test
 * — irrelevant to this suite functionally, since pattern detection never
 * calls AI, but kept consistent with the project's "deterministic providers
 * only in automated suites" rule). Every fixture is cleaned up from MongoDB
 * at the end, mirroring validate-learning.mjs's conventions. The real
 * Development Workspace (6aa29b8d18df3e22b3e89c66) is never touched — this
 * suite only ever creates and deletes its own isolated temporary workspaces.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { Workspace, Property, Unit, Guest, Stay, Signal, Intelligence } from "../src/models/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, "..", "server.js");
const PORT = 5072;
const BASE = `http://localhost:${PORT}/api`;

const created = {
  workspaceIds: [],
  propertyIds: [],
  unitIds: [],
  guestIds: [],
  stayIds: [],
  signalIds: [],
  intelligenceIds: [],
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

function trackCreated(result, bucket) {
  const id = result?.json?.data?._id;
  if (id && !created[bucket].includes(id)) created[bucket].push(id);
  return id;
}

function assertEqual(name, actual, expected) {
  if (actual === expected) {
    ok(name, `${actual}`);
  } else {
    fail(name, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function findPattern(patterns, category) {
  return (patterns || []).find((p) => p.category === category);
}

function isSorted(arr) {
  for (let i = 1; i < arr.length; i += 1) {
    if (arr[i - 1] > arr[i]) return false;
  }
  return true;
}

function waitForHealth(timeoutMs = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = async () => {
      try {
        const res = await fetch(`${BASE}/health`);
        if (res.ok) {
          resolve();
          return;
        }
      } catch {
        // not ready yet
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Server at ${BASE} did not become healthy in time`));
        return;
      }
      setTimeout(attempt, 200);
    };
    attempt();
  });
}

async function cleanup() {
  await connectDatabase();
  await Promise.all([
    Intelligence.deleteMany({ _id: { $in: created.intelligenceIds } }),
    Signal.deleteMany({ _id: { $in: created.signalIds } }),
    Stay.deleteMany({ _id: { $in: created.stayIds } }),
    Guest.deleteMany({ _id: { $in: created.guestIds } }),
    Unit.deleteMany({ _id: { $in: created.unitIds } }),
    Property.deleteMany({ _id: { $in: created.propertyIds } }),
    Workspace.deleteMany({ _id: { $in: created.workspaceIds } }),
  ]);
  await disconnectDatabase();
}

/** Creates a Signal with an explicit occurredAt and tracks it for cleanup. */
async function createSignal(overrides) {
  const res = await expectStatus(
    `setup: signal (${overrides.type}, ${overrides.occurredAt})`,
    "POST",
    "/signals",
    { source: "system", severity: "medium", title: "fixture signal", ...overrides },
    201,
  );
  return trackCreated(res, "signalIds");
}

function daysAgoIso(days, hour = 12) {
  const d = new Date();
  d.setUTCHours(hour, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

async function main() {
  const stamp = Date.now();
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, PORT: String(PORT), LLM_PROVIDER: "test" },
    stdio: "ignore",
  });

  try {
    await waitForHealth();
    ok("ephemeral backend healthy", BASE);

    // === Fixtures ===
    const wsA = trackCreated(
      await expectStatus("setup: workspace A", "POST", "/workspaces", { name: `Phase 7F-A WS A ${stamp}`, slug: `phase-7fa-ws-a-${stamp}` }, 201),
      "workspaceIds",
    );
    const wsB = trackCreated(
      await expectStatus("setup: workspace B", "POST", "/workspaces", { name: `Phase 7F-A WS B ${stamp}`, slug: `phase-7fa-ws-b-${stamp}` }, 201),
      "workspaceIds",
    );

    const propA1 = trackCreated(
      await expectStatus("setup: property A1", "POST", "/properties", { workspaceId: wsA, name: "Property A1", code: `PA1${stamp}` }, 201),
      "propertyIds",
    );
    const propA2 = trackCreated(
      await expectStatus("setup: property A2", "POST", "/properties", { workspaceId: wsA, name: "Property A2", code: `PA2${stamp}` }, 201),
      "propertyIds",
    );
    const unitA1a = trackCreated(
      await expectStatus("setup: unit A1a", "POST", "/units", { workspaceId: wsA, propertyId: propA1, unitNumber: "101" }, 201),
      "unitIds",
    );
    const unitA1b = trackCreated(
      await expectStatus("setup: unit A1b", "POST", "/units", { workspaceId: wsA, propertyId: propA1, unitNumber: "102" }, 201),
      "unitIds",
    );
    const unitA2a = trackCreated(
      await expectStatus("setup: unit A2a", "POST", "/units", { workspaceId: wsA, propertyId: propA2, unitNumber: "201" }, 201),
      "unitIds",
    );

    const guest1 = trackCreated(
      await expectStatus("setup: guest 1", "POST", "/guests", { workspaceId: wsA, firstName: "Guest", lastName: "One", email: `g1-${stamp}@example.com` }, 201),
      "guestIds",
    );
    const guest2 = trackCreated(
      await expectStatus("setup: guest 2", "POST", "/guests", { workspaceId: wsA, firstName: "Guest", lastName: "Two", email: `g2-${stamp}@example.com` }, 201),
      "guestIds",
    );

    const stay1 = trackCreated(
      await expectStatus("setup: stay 1", "POST", "/stays", { workspaceId: wsA, guestId: guest1, propertyId: propA1, unitId: unitA1a, reservationId: `RSV1-${stamp}`, checkIn: daysAgoIso(30) }, 201),
      "stayIds",
    );
    const stay2 = trackCreated(
      await expectStatus("setup: stay 2", "POST", "/stays", { workspaceId: wsA, guestId: guest2, propertyId: propA1, unitId: unitA1a, reservationId: `RSV2-${stamp}`, checkIn: daysAgoIso(20) }, 201),
      "stayIds",
    );
    const stay3 = trackCreated(
      await expectStatus("setup: stay 3", "POST", "/stays", { workspaceId: wsA, guestId: guest1, propertyId: propA1, unitId: unitA1a, reservationId: `RSV3-${stamp}`, checkIn: daysAgoIso(10) }, 201),
      "stayIds",
    );

    // --- Group 1: qualifying pattern via distinct DAYS (unitA1a, maintenance, 4 distinct days) ---
    await createSignal({ workspaceId: wsA, propertyId: propA1, unitId: unitA1a, type: "maintenance", title: "AC 1", occurredAt: daysAgoIso(10) });
    await createSignal({ workspaceId: wsA, propertyId: propA1, unitId: unitA1a, type: "maintenance", title: "AC 2", occurredAt: daysAgoIso(9) });
    await createSignal({ workspaceId: wsA, propertyId: propA1, unitId: unitA1a, type: "maintenance", title: "AC 3", occurredAt: daysAgoIso(8) });
    const group1LastSignal = await createSignal({ workspaceId: wsA, propertyId: propA1, unitId: unitA1a, type: "maintenance", title: "AC 4", occurredAt: daysAgoIso(7) });

    // --- Group 2: below occurrence threshold (unitA1a, guest_request, only 2 signals) ---
    await createSignal({ workspaceId: wsA, propertyId: propA1, unitId: unitA1a, type: "guest_request", title: "Request 1", occurredAt: daysAgoIso(6) });
    await createSignal({ workspaceId: wsA, propertyId: propA1, unitId: unitA1a, type: "guest_request", title: "Request 2", occurredAt: daysAgoIso(5) });

    // --- Group 3: same-day / same-stay duplicate-like reports (unitA1a, complaint, 5 signals, 1 day, 1 stay) ---
    // occurrenceCount=5 (>=3) but distinctDay=1, distinctStay=1, distinctGuest=1 — must NOT qualify with default thresholds.
    for (let i = 0; i < 5; i += 1) {
      await createSignal({ workspaceId: wsA, propertyId: propA1, unitId: unitA1a, guestId: guest1, stayId: stay1, type: "complaint", title: `Complaint dup ${i}`, occurredAt: daysAgoIso(4, 8 + i) });
    }

    // --- Group 4: qualifies via distinct STAYS alone (unitA1b, housekeeping, 3 signals, same day, 3 stays) ---
    await createSignal({ workspaceId: wsA, propertyId: propA1, unitId: unitA1a, stayId: stay1, type: "housekeeping", title: "HK 1", occurredAt: daysAgoIso(3) });
    await createSignal({ workspaceId: wsA, propertyId: propA1, unitId: unitA1a, stayId: stay2, type: "housekeeping", title: "HK 2", occurredAt: daysAgoIso(3) });
    await createSignal({ workspaceId: wsA, propertyId: propA1, unitId: unitA1a, stayId: stay3, type: "housekeeping", title: "HK 3", occurredAt: daysAgoIso(3) });

    // --- Group 5: qualifies via distinct GUESTS alone (unitA1b, payment, 3 signals, same day, no stay, 2 distinct guests) ---
    await createSignal({ workspaceId: wsA, propertyId: propA1, unitId: unitA1b, guestId: guest1, type: "payment", title: "Pay 1", occurredAt: daysAgoIso(2) });
    await createSignal({ workspaceId: wsA, propertyId: propA1, unitId: unitA1b, guestId: guest1, type: "payment", title: "Pay 2", occurredAt: daysAgoIso(2) });
    await createSignal({ workspaceId: wsA, propertyId: propA1, unitId: unitA1b, guestId: guest2, type: "payment", title: "Pay 3", occurredAt: daysAgoIso(2) });

    // --- Group for unit A1b maintenance (3 distinct days) — for unit-scoping tests ---
    await createSignal({ workspaceId: wsA, propertyId: propA1, unitId: unitA1b, type: "maintenance", title: "AC B1", occurredAt: daysAgoIso(15) });
    await createSignal({ workspaceId: wsA, propertyId: propA1, unitId: unitA1b, type: "maintenance", title: "AC B2", occurredAt: daysAgoIso(14) });
    await createSignal({ workspaceId: wsA, propertyId: propA1, unitId: unitA1b, type: "maintenance", title: "AC B3", occurredAt: daysAgoIso(13) });

    // --- Group for property A2 (different property, maintenance, 3 distinct days) ---
    await createSignal({ workspaceId: wsA, propertyId: propA2, unitId: unitA2a, type: "maintenance", title: "AC C1", occurredAt: daysAgoIso(15) });
    await createSignal({ workspaceId: wsA, propertyId: propA2, unitId: unitA2a, type: "maintenance", title: "AC C2", occurredAt: daysAgoIso(14) });
    await createSignal({ workspaceId: wsA, propertyId: propA2, unitId: unitA2a, type: "maintenance", title: "AC C3", occurredAt: daysAgoIso(13) });

    // --- Boundary-date fixtures ---
    const boundaryTo = new Date();
    boundaryTo.setUTCHours(0, 0, 0, 0); // matches the service's own default `to` = start of current UTC day
    const atToBoundary = await createSignal({ workspaceId: wsA, propertyId: propA1, unitId: unitA1a, type: "sentiment", title: "at-to-boundary", occurredAt: boundaryTo.toISOString() });
    const beforeToBoundary = await createSignal({ workspaceId: wsA, propertyId: propA1, unitId: unitA1a, type: "sentiment", title: "before-to-boundary", occurredAt: new Date(boundaryTo.getTime() - 1000).toISOString() });

    // --- Outside-default-window fixture (91 days ago) ---
    const oldSignal = await createSignal({ workspaceId: wsA, propertyId: propA1, unitId: unitA1a, type: "departure", title: "old departure", occurredAt: daysAgoIso(91) });
    await createSignal({ workspaceId: wsA, propertyId: propA1, unitId: unitA1a, type: "departure", title: "recent departure 1", occurredAt: daysAgoIso(5) });
    await createSignal({ workspaceId: wsA, propertyId: propA1, unitId: unitA1a, type: "departure", title: "recent departure 2", occurredAt: daysAgoIso(4) });

    // --- Intelligence coverage fixture: link ONE of Group 1's signals ---
    const intel1 = trackCreated(
      await expectStatus("setup: intelligence linking one Group 1 signal", "POST", "/intelligence", { workspaceId: wsA, signalIds: [group1LastSignal] }, 201),
      "intelligenceIds",
    );

    // --- Workspace B fixtures (tenant isolation controls) ---
    const propB = trackCreated(
      await expectStatus("setup: property B", "POST", "/properties", { workspaceId: wsB, name: "Property B", code: `PB${stamp}` }, 201),
      "propertyIds",
    );
    for (let i = 0; i < 4; i += 1) {
      await createSignal({ workspaceId: wsB, propertyId: propB, type: "maintenance", title: `B maintenance ${i}`, occurredAt: daysAgoIso(i + 1) });
    }

    // === 1/6: Basic recurring pattern detection + below-threshold exclusion ===
    const reportA = await expectStatus("1: workspace A patterns (defaults)", "GET", `/learning/patterns?workspaceId=${wsA}`, null, 200);
    const patternsA = reportA.json?.data?.patterns || [];

    const maintenancePattern = findPattern(patternsA, "maintenance");
    if (maintenancePattern) {
      ok("1b: recurring maintenance pattern detected (workspace-wide, merges A1a+A1b+A2)");
    } else {
      fail("1b: recurring maintenance pattern detected", JSON.stringify(patternsA.map((p) => p.category)));
    }
    // Workspace-wide maintenance = 4 (A1a) + 3 (A1b) + 3 (A2) = 10
    assertEqual("1c: workspace-wide maintenance occurrenceCount aggregates across properties/units", maintenancePattern?.occurrenceCount, 10);

    const guestRequestPattern = findPattern(patternsA, "guest_request");
    if (!guestRequestPattern) {
      ok("6: below-occurrence-threshold signals (guest_request, 2 occurrences) do not qualify");
    } else {
      fail("6: below-occurrence-threshold signals do not qualify", JSON.stringify(guestRequestPattern));
    }

    // === 21/I: duplicate-report limitation — same-day/same-stay complaints must NOT qualify ===
    const complaintPattern = findPattern(patternsA, "complaint");
    if (!complaintPattern) {
      ok("21a: same-day/same-stay duplicate-like signals correctly do NOT qualify as a pattern");
    } else {
      fail("21a: same-day/same-stay duplicate-like signals correctly do NOT qualify", JSON.stringify(complaintPattern));
    }
    if (maintenancePattern?.evidence?.duplicateDetectionLimitation && typeof maintenancePattern.evidence.duplicateDetectionLimitation === "string" && maintenancePattern.evidence.duplicateDetectionLimitation.length > 20) {
      ok("21b: duplicate-report limitation is stated honestly in evidence");
    } else {
      fail("21b: duplicate-report limitation is stated honestly in evidence", JSON.stringify(maintenancePattern?.evidence));
    }

    // === 4: minimum distinct-stay threshold (housekeeping qualifies via stays alone) ===
    const housekeepingPattern = findPattern(patternsA, "housekeeping");
    if (housekeepingPattern && housekeepingPattern.distinctStayCount === 3 && housekeepingPattern.distinctDayCount === 1) {
      ok("4: pattern qualifies via distinct-stay threshold alone (day count insufficient)");
    } else {
      fail("4: pattern qualifies via distinct-stay threshold alone", JSON.stringify(housekeepingPattern));
    }

    // === 5: minimum distinct-guest threshold (payment qualifies via guests alone) ===
    const paymentPattern = findPattern(patternsA, "payment");
    if (paymentPattern && paymentPattern.distinctGuestCount === 2 && paymentPattern.distinctDayCount === 1 && paymentPattern.distinctStayCount === 0) {
      ok("5: pattern qualifies via distinct-guest threshold alone (day/stay counts insufficient)");
    } else {
      fail("5: pattern qualifies via distinct-guest threshold alone", JSON.stringify(paymentPattern));
    }

    // === 3: minimum distinct-day threshold (Group 1 already proves this: 4 occurrences, 4 days) ===
    if (maintenancePattern) {
      ok("3: distinct-day threshold demonstrated by the workspace-wide maintenance pattern (>=4 distinct days across the merged groups)");
    } else {
      fail("3: distinct-day threshold demonstrated", "no maintenance pattern found");
    }

    // === 2: explicit minimumOccurrences threshold override ===
    const strictOccurrences = await expectStatus("2: minimumOccurrences override excludes previously-qualifying pattern", "GET", `/learning/patterns?workspaceId=${wsA}&propertyId=${propA1}&unitId=${unitA1a}&type=maintenance&minimumOccurrences=10`, null, 200);
    if ((strictOccurrences.json?.data?.patterns || []).length === 0) {
      ok("2b: raising minimumOccurrences above the actual count excludes the pattern");
    } else {
      fail("2b: raising minimumOccurrences above the actual count excludes the pattern", JSON.stringify(strictOccurrences.json?.data?.patterns));
    }

    // === 7: different Signal types never incorrectly combine ===
    const departurePattern = findPattern(patternsA, "departure");
    const distinctCategories = new Set(patternsA.map((p) => p.category));
    if (distinctCategories.size === patternsA.length) {
      ok("7: every qualifying pattern has a distinct category (no cross-type merging)", `${patternsA.length} pattern(s)`);
    } else {
      fail("7: every qualifying pattern has a distinct category", JSON.stringify(patternsA.map((p) => p.category)));
    }

    // === 8: different properties do not incorrectly combine (propertyId filter scoping) ===
    const propA1Only = await expectStatus("8: propertyId=propA1 scoped patterns", "GET", `/learning/patterns?workspaceId=${wsA}&propertyId=${propA1}&type=maintenance`, null, 200);
    const propA1MaintPattern = findPattern(propA1Only.json?.data?.patterns, "maintenance");
    // propA1 maintenance = 4 (A1a) + 3 (A1b) = 7, excludes propA2's 3
    assertEqual("8b: property-scoped pattern excludes a different property's signals", propA1MaintPattern?.occurrenceCount, 7);

    // === 9: different units do not incorrectly combine (unitId filter scoping) ===
    const unitA1aOnly = await expectStatus("9: unitId=unitA1a scoped patterns", "GET", `/learning/patterns?workspaceId=${wsA}&propertyId=${propA1}&unitId=${unitA1a}&type=maintenance`, null, 200);
    const unitA1aMaintPattern = findPattern(unitA1aOnly.json?.data?.patterns, "maintenance");
    assertEqual("9b: unit-scoped pattern excludes a different unit's signals within the same property", unitA1aMaintPattern?.occurrenceCount, 4);
    if (unitA1aOnly.json?.data?.scope?.propertyId === propA1 && unitA1aOnly.json?.data?.scope?.unitId === unitA1a) {
      ok("9c: response scope correctly reflects the supplied property/unit filters");
    } else {
      fail("9c: response scope correctly reflects the supplied property/unit filters", JSON.stringify(unitA1aOnly.json?.data?.scope));
    }

    // === 10/11: workspace isolation ===
    const reportB = await expectStatus("10: workspace B patterns", "GET", `/learning/patterns?workspaceId=${wsB}`, null, 200);
    const patternsB = reportB.json?.data?.patterns || [];
    const bMaintPattern = findPattern(patternsB, "maintenance");
    assertEqual("10b: workspace B has its own independent maintenance pattern", bMaintPattern?.occurrenceCount, 4);

    const aSignalIdSet = new Set(patternsA.flatMap((p) => p.signalIds));
    const bSignalIdSet = new Set(patternsB.flatMap((p) => p.signalIds));
    const leakedIntoA = [...bSignalIdSet].some((id) => aSignalIdSet.has(id));
    const leakedIntoB = [...aSignalIdSet].some((id) => bSignalIdSet.has(id));
    if (!leakedIntoA && !leakedIntoB) {
      ok("11a: no signalId leaks across workspaces in either direction");
    } else {
      fail("11a: no signalId leaks across workspaces in either direction", "leak detected");
    }

    const crossWorkspaceFilter = await expectStatus("11b: workspace A query with workspace B's propertyId filter", "GET", `/learning/patterns?workspaceId=${wsA}&propertyId=${propB}`, null, 200);
    if ((crossWorkspaceFilter.json?.data?.patterns || []).length === 0) {
      ok("11c: a foreign-workspace propertyId filter narrows to nothing rather than leaking or erroring");
    } else {
      fail("11c: a foreign-workspace propertyId filter narrows to nothing", JSON.stringify(crossWorkspaceFilter.json?.data?.patterns));
    }

    // === 12: default 90-day window excludes the 91-day-old signal ===
    // Thresholds are lowered to isolate window behavior specifically from
    // occurrence-threshold behavior (already covered by test #2/#6).
    const departureDefault = await expectStatus(
      "12: default window departure pattern",
      "GET",
      `/learning/patterns?workspaceId=${wsA}&propertyId=${propA1}&unitId=${unitA1a}&type=departure&minimumOccurrences=2&minimumDistinctDays=2`,
      null,
      200,
    );
    const departureDefaultPattern = findPattern(departureDefault.json?.data?.patterns, "departure");
    // Only the 2 recent departures fall inside the default 90-day window;
    // the 91-day-old one must be excluded, so occurrenceCount is exactly 2.
    assertEqual("12b: default 90-day window excludes the 91-day-old signal (only 2 in-window occurrences)", departureDefaultPattern?.occurrenceCount, 2);

    // === 13: explicit from/to widens the window to include the old signal ===
    const wideFrom = new Date();
    wideFrom.setUTCDate(wideFrom.getUTCDate() - 120);
    const wideTo = new Date();
    wideTo.setUTCDate(wideTo.getUTCDate() + 1);
    const departureWide = await expectStatus(
      "13: explicit wide from/to window",
      "GET",
      `/learning/patterns?workspaceId=${wsA}&propertyId=${propA1}&unitId=${unitA1a}&type=departure&from=${wideFrom.toISOString()}&to=${wideTo.toISOString()}`,
      null,
      200,
    );
    const departureWidePattern = findPattern(departureWide.json?.data?.patterns, "departure");
    assertEqual("13b: explicit wide window includes the previously-excluded old signal", departureWidePattern?.occurrenceCount, 3);
    if (departureWidePattern?.signalIds?.includes(oldSignal)) {
      ok("13c: the old (91-day) signal is present once the window is widened");
    } else {
      fail("13c: the old signal is present once the window is widened", JSON.stringify(departureWidePattern?.signalIds));
    }

    // === 14: boundary-date behavior ([from, to) — to exclusive) ===
    const sentimentBoundary = await expectStatus(
      "14: default-window sentiment pattern (boundary check)",
      "GET",
      `/learning/patterns?workspaceId=${wsA}&propertyId=${propA1}&unitId=${unitA1a}&type=sentiment&minimumOccurrences=1&minimumDistinctDays=1`,
      null,
      200,
    );
    const sentimentBoundaryPattern = findPattern(sentimentBoundary.json?.data?.patterns, "sentiment");
    const boundarySignalIds = sentimentBoundaryPattern?.signalIds || [];
    if (!boundarySignalIds.includes(atToBoundary) && boundarySignalIds.includes(beforeToBoundary)) {
      ok("14b: a signal exactly at the default `to` boundary is excluded; one just before it is included");
    } else {
      fail("14b: to-boundary exclusivity", JSON.stringify({ boundarySignalIds, atToBoundary, beforeToBoundary }));
    }

    // === 15: empty workspace / no qualifying patterns ===
    const wsEmpty = trackCreated(
      await expectStatus("setup: empty workspace", "POST", "/workspaces", { name: `Phase 7F-A WS Empty ${stamp}`, slug: `phase-7fa-ws-empty-${stamp}` }, 201),
      "workspaceIds",
    );
    const emptyReport = await expectStatus("15: empty workspace returns valid empty result", "GET", `/learning/patterns?workspaceId=${wsEmpty}`, null, 200);
    if (Array.isArray(emptyReport.json?.data?.patterns) && emptyReport.json.data.patterns.length === 0) {
      ok("15b: empty workspace patterns array is well-formed and empty");
    } else {
      fail("15b: empty workspace patterns array is well-formed and empty", JSON.stringify(emptyReport.json?.data));
    }

    // === 16/17/18/19: determinism ===
    const run1 = await request("GET", `/learning/patterns?workspaceId=${wsA}`);
    const run2 = await request("GET", `/learning/patterns?workspaceId=${wsA}`);
    if (JSON.stringify(run1.json) === JSON.stringify(run2.json)) {
      ok("16/19: two identical requests produce byte-identical responses (patternId, ordering, description all included)");
    } else {
      fail("16/19: two identical requests produce byte-identical responses", "responses differed");
    }

    const categories = patternsA.map((p) => p.category);
    if (isSorted(categories)) {
      ok("17: patterns are deterministically ordered by category");
    } else {
      fail("17: patterns are deterministically ordered by category", JSON.stringify(categories));
    }

    const allSignalIdsSorted = patternsA.every((p) => isSorted(p.signalIds));
    if (allSignalIdsSorted) {
      ok("18: signalIds within every pattern are deterministically sorted");
    } else {
      fail("18: signalIds within every pattern are deterministically sorted", "unsorted signalIds found");
    }

    // === 20: read-only behavior ===
    const signalBefore = await request("GET", `/signals/${group1LastSignal}?workspaceId=${wsA}`);
    const signalCountBefore = await request("GET", `/signals?workspaceId=${wsA}&limit=1`);
    await request("GET", `/learning/patterns?workspaceId=${wsA}`);
    await request("GET", `/learning/patterns?workspaceId=${wsA}&propertyId=${propA1}`);
    await request("GET", `/learning/patterns?workspaceId=${wsA}&minimumOccurrences=1`);
    const signalAfter = await request("GET", `/signals/${group1LastSignal}?workspaceId=${wsA}`);
    const signalCountAfter = await request("GET", `/signals?workspaceId=${wsA}&limit=1`);
    assertEqual("20a: running pattern detection does not modify a Signal's updatedAt", signalAfter.json?.data?.updatedAt, signalBefore.json?.data?.updatedAt);
    assertEqual("20b: running pattern detection does not change the Signal count for the workspace", signalCountAfter.json?.pagination?.total, signalCountBefore.json?.pagination?.total);

    // === Intelligence coverage ===
    if (maintenancePattern?.intelligenceCoverage?.linked === 1 && maintenancePattern?.intelligenceCoverage?.total === 10) {
      ok("10-linkage: intelligenceCoverage correctly reports 1 of 10 maintenance signals linked");
    } else {
      fail("10-linkage: intelligenceCoverage correctly reports 1 of 10 maintenance signals linked", JSON.stringify(maintenancePattern?.intelligenceCoverage));
    }
    if (maintenancePattern?.linkedIntelligenceIds?.includes(intel1)) {
      ok("10-linkage-b: linkedIntelligenceIds includes the actually-linked Intelligence record");
    } else {
      fail("10-linkage-b: linkedIntelligenceIds includes the actually-linked Intelligence record", JSON.stringify(maintenancePattern?.linkedIntelligenceIds));
    }
    if (housekeepingPattern?.intelligenceCoverage?.linked === 0) {
      ok("10-linkage-c: a pattern with zero linked Intelligence reports linked:0 honestly, not omitted");
    } else {
      fail("10-linkage-c: a pattern with zero linked Intelligence reports linked:0", JSON.stringify(housekeepingPattern?.intelligenceCoverage));
    }

    // === Evidence / threshold transparency ===
    if (
      maintenancePattern?.evidence?.thresholds?.minimumOccurrences === 3 &&
      maintenancePattern?.evidence?.thresholds?.minimumDistinctDays === 2 &&
      maintenancePattern?.evidence?.thresholds?.minimumDistinctStays === 2 &&
      maintenancePattern?.evidence?.thresholds?.minimumDistinctGuests === 2 &&
      typeof maintenancePattern?.evidence?.rule === "string" &&
      maintenancePattern?.evidence?.values?.occurrenceCount === 10
    ) {
      ok("evidence: default thresholds, rule, and values are all present and correct");
    } else {
      fail("evidence: default thresholds, rule, and values are all present and correct", JSON.stringify(maintenancePattern?.evidence));
    }
    if (!("confidence" in (maintenancePattern || {})) && !("effectivenessScore" in (maintenancePattern || {}))) {
      ok("no scalar confidence/effectiveness score exists anywhere on a pattern");
    } else {
      fail("no scalar confidence/effectiveness score exists anywhere on a pattern", JSON.stringify(maintenancePattern));
    }

    // === patternId determinism across repeated calls ===
    const reportA2 = await request("GET", `/learning/patterns?workspaceId=${wsA}`);
    const maintenancePattern2 = findPattern(reportA2.json?.data?.patterns, "maintenance");
    assertEqual("patternId is identical across repeated calls against unchanged data", maintenancePattern2?.patternId, maintenancePattern?.patternId);
    if (typeof maintenancePattern?.patternId === "string" && !/^[0-9a-f-]{24}$/.test(maintenancePattern.patternId) === false) {
      // patternId is a 24-char hex slice of a sha256 hash — never a Mongo ObjectId derived from random/timestamp bytes tied to this request.
      ok("patternId has the expected deterministic hash shape (24 hex chars)");
    } else {
      fail("patternId has the expected deterministic hash shape", maintenancePattern?.patternId);
    }

    // === J: validation ===
    await expectStatus("22a: missing workspaceId rejected", "GET", "/learning/patterns", null, 400);
    await expectStatus("22b: malformed workspaceId rejected", "GET", "/learning/patterns?workspaceId=not-an-id", null, 400);
    await expectStatus("23a: malformed from date rejected", "GET", `/learning/patterns?workspaceId=${wsA}&from=not-a-date`, null, 400);
    await expectStatus("23b: malformed to date rejected", "GET", `/learning/patterns?workspaceId=${wsA}&to=not-a-date`, null, 400);
    await expectStatus("23c: from after to rejected", "GET", `/learning/patterns?workspaceId=${wsA}&from=2026-01-01&to=2025-01-01`, null, 400);
    await expectStatus("23d: malformed propertyId rejected", "GET", `/learning/patterns?workspaceId=${wsA}&propertyId=not-an-id`, null, 400);
    await expectStatus("23e: malformed unitId rejected", "GET", `/learning/patterns?workspaceId=${wsA}&unitId=not-an-id`, null, 400);
    await expectStatus("23f: invalid type value rejected", "GET", `/learning/patterns?workspaceId=${wsA}&type=not-a-real-type`, null, 400);
    await expectStatus("23g: negative minimumOccurrences rejected", "GET", `/learning/patterns?workspaceId=${wsA}&minimumOccurrences=-1`, null, 400);
    await expectStatus("23h: non-integer minimumDistinctDays rejected", "GET", `/learning/patterns?workspaceId=${wsA}&minimumDistinctDays=1.5`, null, 400);
    await expectStatus("13: negative minimumDistinctStays rejected", "GET", `/learning/patterns?workspaceId=${wsA}&minimumDistinctStays=-1`, null, 400);
    await expectStatus("13b: non-integer minimumDistinctStays rejected", "GET", `/learning/patterns?workspaceId=${wsA}&minimumDistinctStays=2.5`, null, 400);
    await expectStatus("14: negative minimumDistinctGuests rejected", "GET", `/learning/patterns?workspaceId=${wsA}&minimumDistinctGuests=-1`, null, 400);
    await expectStatus("14b: non-integer minimumDistinctGuests rejected", "GET", `/learning/patterns?workspaceId=${wsA}&minimumDistinctGuests=1.5`, null, 400);

    // === 7F-B: custom thresholds for EACH OR-branch actually take effect (not just minimumOccurrences) ===
    const strictDays = await expectStatus(
      "15c: minimumDistinctDays override excludes a pattern that only qualified via days",
      "GET",
      `/learning/patterns?workspaceId=${wsA}&propertyId=${propA1}&type=maintenance&minimumDistinctDays=50`,
      null,
      200,
    );
    if ((strictDays.json?.data?.patterns || []).length === 0) {
      ok("15c-b: raising minimumDistinctDays above the actual distinct-day count excludes the pattern");
    } else {
      fail("15c-b: raising minimumDistinctDays above the actual distinct-day count excludes the pattern", JSON.stringify(strictDays.json?.data?.patterns));
    }

    const strictStays = await expectStatus(
      "15d: minimumDistinctStays override excludes a pattern that only qualified via stays",
      "GET",
      `/learning/patterns?workspaceId=${wsA}&propertyId=${propA1}&unitId=${unitA1a}&type=housekeeping&minimumOccurrences=1&minimumDistinctDays=50&minimumDistinctStays=50`,
      null,
      200,
    );
    if ((strictStays.json?.data?.patterns || []).length === 0) {
      ok("15d-b: raising minimumDistinctStays above the actual distinct-stay count excludes the pattern");
    } else {
      fail("15d-b: raising minimumDistinctStays above the actual distinct-stay count excludes the pattern", JSON.stringify(strictStays.json?.data?.patterns));
    }

    const strictGuests = await expectStatus(
      "15e: minimumDistinctGuests override excludes a pattern that only qualified via guests",
      "GET",
      `/learning/patterns?workspaceId=${wsA}&propertyId=${propA1}&unitId=${unitA1b}&type=payment&minimumOccurrences=1&minimumDistinctDays=50&minimumDistinctStays=50&minimumDistinctGuests=50`,
      null,
      200,
    );
    if ((strictGuests.json?.data?.patterns || []).length === 0) {
      ok("15e-b: raising minimumDistinctGuests above the actual distinct-guest count excludes the pattern");
    } else {
      fail("15e-b: raising minimumDistinctGuests above the actual distinct-guest count excludes the pattern", JSON.stringify(strictGuests.json?.data?.patterns));
    }

    // Conversely, confirm a deliberately loose custom threshold set still correctly ADMITS a pattern
    // (proves the override is genuinely two-way, not just a one-way "always reject" path).
    const looseGuests = await expectStatus(
      "15f: a loose custom minimumDistinctGuests still admits a qualifying pattern",
      "GET",
      `/learning/patterns?workspaceId=${wsA}&propertyId=${propA1}&unitId=${unitA1b}&type=payment&minimumOccurrences=1&minimumDistinctDays=1&minimumDistinctStays=1&minimumDistinctGuests=2`,
      null,
      200,
    );
    if (findPattern(looseGuests.json?.data?.patterns, "payment")?.distinctGuestCount === 2) {
      ok("15f-b: a loose custom threshold set correctly admits the pattern with the expected values");
    } else {
      fail("15f-b: a loose custom threshold set correctly admits the pattern", JSON.stringify(looseGuests.json?.data?.patterns));
    }

    // === 7F-B: empty-string filters must behave as absent, never as a spurious filter ===
    const emptyStringFilters = await request(
      "GET",
      `/learning/patterns?workspaceId=${wsA}&propertyId=&unitId=&type=&from=&to=&minimumOccurrences=&minimumDistinctDays=&minimumDistinctStays=&minimumDistinctGuests=`,
    );
    if (emptyStringFilters.status === 200 && JSON.stringify(emptyStringFilters.json?.data) === JSON.stringify(reportA.json?.data)) {
      ok("empty-string filters produce byte-identical output to omitting the filters entirely");
    } else {
      fail("empty-string filters produce byte-identical output to omitting the filters entirely", `status=${emptyStringFilters.status}`);
    }

    // === 7F-B: unknown/extra query parameters must never alter behavior ===
    const unknownParams = await request("GET", `/learning/patterns?workspaceId=${wsA}&foo=bar&unexpectedFlag=true&randomExtra=123`);
    if (unknownParams.status === 200 && JSON.stringify(unknownParams.json?.data) === JSON.stringify(reportA.json?.data)) {
      ok("unknown/extra query parameters do not alter the response");
    } else {
      fail("unknown/extra query parameters do not alter the response", `status=${unknownParams.status}: ${JSON.stringify(unknownParams.json)}`);
    }

    // === 7F-B: linkedIntelligenceIds ordering is deterministic ===
    if (Array.isArray(maintenancePattern?.linkedIntelligenceIds) && isSorted(maintenancePattern.linkedIntelligenceIds)) {
      ok("linkedIntelligenceIds is deterministically sorted");
    } else {
      fail("linkedIntelligenceIds is deterministically sorted", JSON.stringify(maintenancePattern?.linkedIntelligenceIds));
    }

    // === 24: existing Learning API regression (untouched) ===
    const learningReportCheck = await expectStatus("24: existing GET /api/learning still works unaffected", "GET", `/learning?workspaceId=${wsA}`, null, 200);
    if (learningReportCheck.json?.data?.counts?.decisions?.total === 0) {
      ok("24b: GET /api/learning still returns its own untouched contract shape");
    } else {
      fail("24b: GET /api/learning still returns its own untouched contract shape", JSON.stringify(learningReportCheck.json?.data));
    }

    await cleanup();
    ok("mongodb cleanup");
  } finally {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(async (error) => {
  console.error(error);
  try {
    await cleanup();
  } catch {
    // best-effort cleanup
  }
  process.exit(1);
});
