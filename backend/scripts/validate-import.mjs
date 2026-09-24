/**
 * Phase 7F-E validation: POST /api/imports/operational (eZee CSV
 * operational data import) and GET /api/imports/:id (ImportBatch lookup).
 *
 * IMPORTANT: no real eZee export exists in this repository. Every mapping
 * profile, date format, and status vocabulary used below is clearly
 * synthetic test fixture data ("Test Guest ID", "Test Reservation ID", ...)
 * invented for this test suite only — it must never be read as a canonical
 * or production eZee column/status mapping. A real export would supply its
 * own real headers/statuses/date format through the same configurable
 * mappingProfile/statusMapping/dateFormat mechanism this suite exercises.
 *
 * Requires a running backend server reachable at API_BASE (same convention
 * as validate-api.mjs) and MongoDB reachable via the backend's own config.
 */
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { importOperationalCsv } from "../src/services/import/importService.js";
import {
  Workspace,
  Property,
  Unit,
  Guest,
  Stay,
  ImportBatch,
  KnowledgeDocument,
  KnowledgeChunk,
} from "../src/models/index.js";

const BASE = process.env.API_BASE || "http://localhost:5002/api";

const created = {
  workspaceIds: [],
  propertyIds: [],
  unitIds: [],
  guestIds: [],
  stayIds: [],
  importBatchIds: [],
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
  if (result.status === expectedStatus) ok(name, `HTTP ${result.status}`);
  else fail(name, `expected ${expectedStatus}, got ${result.status}: ${JSON.stringify(result.json)}`);
  return result;
}

function trackCreated(result, bucket) {
  const id = result?.json?.data?._id;
  if (id && !created[bucket].includes(id)) created[bucket].push(id);
  return id;
}

/** Import result contract's id field is importBatchId, not _id. */
function trackImportBatch(result) {
  const id = result?.json?.data?.importBatchId;
  if (id && !created.importBatchIds.includes(id)) created.importBatchIds.push(id);
  return id;
}

/**
 * Synthetic, clearly test-only CSV header set — NOT real eZee column
 * names. See the file-level comment above.
 */
const HEADERS = [
  "Test Guest ID",
  "Test First Name",
  "Test Last Name",
  "Test Email",
  "Test Phone",
  "Test Reservation ID",
  "Test Room Number",
  "Test Check In",
  "Test Check Out",
  "Test Status",
  "Test Adults",
  "Test Children",
];

const MAPPING_PROFILE = {
  "guest.externalId": "Test Guest ID",
  "guest.firstName": "Test First Name",
  "guest.lastName": "Test Last Name",
  "guest.email": "Test Email",
  "guest.phone": "Test Phone",
  "stay.reservationId": "Test Reservation ID",
  "stay.roomNumber": "Test Room Number",
  "stay.checkIn": "Test Check In",
  "stay.checkOut": "Test Check Out",
  "stay.status": "Test Status",
  "stay.adults": "Test Adults",
  "stay.children": "Test Children",
};

const DATE_FORMAT = "YYYY-MM-DD";
const STATUS_MAPPING = {
  Confirmed: "confirmed",
  "Checked In": "checked_in",
  "Checked Out": "checked_out",
  Cancelled: "cancelled",
};

function buildCsv(rows, { headers = HEADERS, lineEnding = "\n", bom = false, extraHeader } = {}) {
  const headerRow = extraHeader ? [...headers, extraHeader] : headers;
  const lines = [
    headerRow.join(","),
    ...rows.map((row) => headerRow.map((h) => (row[h] !== undefined ? String(row[h]) : "")).join(",")),
  ];
  const text = lines.join(lineEnding) + lineEnding;
  return bom ? `﻿${text}` : text;
}

async function uploadImport({ fields = {}, fileBytes, filename = "import.csv", mimeType = "text/csv", omitFile = false }) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    form.append(key, typeof value === "string" ? value : JSON.stringify(value));
  }
  if (!omitFile) {
    const blob = new Blob([fileBytes], { type: mimeType });
    form.append("file", blob, filename);
  }
  const response = await fetch(`${BASE}/imports/operational`, { method: "POST", body: form });
  let json = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

async function expectImportStatus(name, options, expectedStatus) {
  const result = await uploadImport(options);
  if (result.status === expectedStatus) ok(name, `HTTP ${result.status}`);
  else fail(name, `expected ${expectedStatus}, got ${result.status}: ${JSON.stringify(result.json)}`);
  return result;
}

async function cleanup() {
  await connectDatabase();
  // Workspace-scoped backstop (test workspaces only) in addition to tracked ids.
  await ImportBatch.deleteMany({ workspaceId: { $in: created.workspaceIds } });
  await Stay.deleteMany({ workspaceId: { $in: created.workspaceIds } });
  await Guest.deleteMany({ workspaceId: { $in: created.workspaceIds } });
  await ImportBatch.deleteMany({ _id: { $in: created.importBatchIds } });
  await Stay.deleteMany({ _id: { $in: created.stayIds } });
  await Guest.deleteMany({ _id: { $in: created.guestIds } });
  await Unit.deleteMany({ _id: { $in: created.unitIds } });
  await Property.deleteMany({ _id: { $in: created.propertyIds } });
  await Workspace.deleteMany({ _id: { $in: created.workspaceIds } });
  await disconnectDatabase();
}

async function main() {
  const stamp = Date.now();

  // Baseline snapshot: this is a shared, persistent dev database that may
  // already hold real KnowledgeChunk data from unrelated, prior knowledge-
  // ingestion work — assert this suite creates none of its own via a
  // before/after delta, not an assumed-empty global count.
  await connectDatabase();
  const knowledgeChunkCountBefore = await KnowledgeChunk.countDocuments({});
  // Same idea for operational data: this database may hold REAL imported
  // Guests/Stays/ImportBatches (e.g. the Kolam Gandhi evaluation import).
  // Fingerprint every pre-existing document (id + updatedAt) before the suite
  // creates anything, and compare it at the end — instead of assuming the
  // database is empty.
  const outsideFingerprint = async (excludeWorkspaceIds = []) => {
    const scoped = excludeWorkspaceIds.length ? { workspaceId: { $nin: excludeWorkspaceIds } } : {};
    const rows = [];
    for (const [label, Model, filter] of [
      ["ImportBatch", ImportBatch, scoped],
      ["Guest", Guest, scoped],
      ["Stay", Stay, scoped],
      ["Property", Property, scoped],
      ["Workspace", Workspace, excludeWorkspaceIds.length ? { _id: { $nin: excludeWorkspaceIds } } : {}],
    ]) {
      for (const doc of await Model.find(filter).select("_id updatedAt").lean()) {
        rows.push(label + ":" + String(doc._id) + ":" + new Date(doc.updatedAt).getTime());
      }
    }
    return rows.sort();
  };
  const outsideBefore = await outsideFingerprint();
  await disconnectDatabase();

  const wsA = trackCreated(
    await expectStatus("7FE: workspace A create", "POST", "/workspaces", { name: `Phase7FE WS A ${stamp}`, slug: `phase7fe-ws-a-${stamp}` }, 201),
    "workspaceIds",
  );
  const wsB = trackCreated(
    await expectStatus("7FE: workspace B create", "POST", "/workspaces", { name: `Phase7FE WS B ${stamp}`, slug: `phase7fe-ws-b-${stamp}` }, 201),
    "workspaceIds",
  );
  const propA = trackCreated(
    await expectStatus("7FE: property A create", "POST", "/properties", { workspaceId: wsA, name: "Kolam Residency", code: `KRE${stamp}` }, 201),
    "propertyIds",
  );
  const propB = trackCreated(
    await expectStatus("7FE: property B create", "POST", "/properties", { workspaceId: wsB, name: "B Residency", code: `KRB${stamp}` }, 201),
    "propertyIds",
  );
  trackCreated(await expectStatus("7FE: unit 101 create", "POST", "/units", { workspaceId: wsA, propertyId: propA, unitNumber: "101" }, 201), "unitIds");
  trackCreated(await expectStatus("7FE: unit 102 create", "POST", "/units", { workspaceId: wsA, propertyId: propA, unitNumber: "102" }, 201), "unitIds");

  const FULL = { "Test Room Number": "101", "Test Check In": "2026-04-01", "Test Check Out": "2026-04-05" };

  const baseFields = {
    workspaceId: wsA,
    propertyId: propA,
    mappingProfile: MAPPING_PROFILE,
    dateFormat: DATE_FORMAT,
    statusMapping: STATUS_MAPPING,
  };

  // =========================================================
  // 1/2: valid CSV, first import creates Guest + Stay
  // =========================================================
  const guestExtId1 = `G1-${stamp}`;
  const resId1 = `R1-${stamp}`;
  const guestExtId2 = `G2-${stamp}`;
  const resId2 = `R2-${stamp}`;

  const csv1 = buildCsv([
    {
      "Test Guest ID": guestExtId1,
      "Test First Name": "John",
      "Test Last Name": "Doe",
      "Test Email": "john.doe@test.example",
      "Test Phone": "555-0100",
      "Test Reservation ID": resId1,
      "Test Room Number": "101",
      "Test Check In": "2026-01-10",
      "Test Check Out": "2026-01-15",
      "Test Status": "Confirmed",
      "Test Adults": "2",
      "Test Children": "0",
    },
    {
      "Test Guest ID": guestExtId2,
      "Test First Name": "Jane",
      "Test Last Name": "Roe",
      "Test Email": "jane.roe@test.example",
      "Test Phone": "555-0200",
      "Test Reservation ID": resId2,
      "Test Room Number": "102",
      "Test Check In": "2026-01-11",
      "Test Check Out": "2026-01-16",
      "Test Status": "Confirmed",
      "Test Adults": "1",
      "Test Children": "1",
    },
  ]);

  const firstImportRes = await expectImportStatus("7FE.1: valid CSV import succeeds", { fields: baseFields, fileBytes: csv1 }, 201);
  const firstBatchId = trackImportBatch(firstImportRes);
  const firstData = firstImportRes.json?.data;
  if (firstData?.rowsRead === 2 && firstData?.rowsCreated === 2 && firstData?.rowsUpdated === 0 && firstData?.rowsFailed === 0) {
    ok("7FE.2: first import creates exactly 2 Guest+Stay pairs (rowsCreated=2)");
  } else {
    fail("7FE.2: first import creates exactly 2 Guest+Stay pairs (rowsCreated=2)", JSON.stringify(firstData));
  }

  await connectDatabase();
  const guest1 = await Guest.findOne({ workspaceId: wsA, externalId: guestExtId1 });
  const stay1 = await Stay.findOne({ workspaceId: wsA, reservationId: resId1 });
  await disconnectDatabase();
  if (guest1) created.guestIds.push(String(guest1._id));
  if (stay1) created.stayIds.push(String(stay1._id));
  const guest2Doc = await (async () => {
    await connectDatabase();
    const g = await Guest.findOne({ workspaceId: wsA, externalId: guestExtId2 });
    const s = await Stay.findOne({ workspaceId: wsA, reservationId: resId2 });
    await disconnectDatabase();
    if (g) created.guestIds.push(String(g._id));
    if (s) created.stayIds.push(String(s._id));
    return { g, s };
  })();

  if (guest1 && stay1 && String(stay1.guestId) === String(guest1._id) && String(stay1.propertyId) === String(propA)) {
    ok("7FE.2b: created Stay correctly references the created Guest and the import's Property");
  } else {
    fail("7FE.2b: created Stay correctly references the created Guest and the import's Property", JSON.stringify({ guest1, stay1 }));
  }
  if (stay1?.status === "confirmed" && stay1?.adults === 2 && stay1?.children === 0) {
    ok("7FE.2c: status mapping and adults/children normalized correctly on create");
  } else {
    fail("7FE.2c: status mapping and adults/children normalized correctly on create", JSON.stringify(stay1));
  }

  // =========================================================
  // 3/4/5/6: repeated import — no duplicates, correct updates
  // =========================================================
  const csv2 = buildCsv([
    {
      "Test Guest ID": guestExtId1,
      "Test First Name": "John",
      "Test Last Name": "Doe",
      "Test Email": "john.doe.updated@test.example",
      "Test Phone": "555-0199",
      "Test Reservation ID": resId1,
      "Test Room Number": "101",
      "Test Check In": "2026-01-10",
      "Test Check Out": "2026-01-15",
      "Test Status": "Checked In",
      "Test Adults": "2",
      "Test Children": "0",
    },
  ]);
  const secondImportRes = await expectImportStatus("7FE.3: repeated import of an existing reservation succeeds", { fields: baseFields, fileBytes: csv2 }, 201);
  trackImportBatch(secondImportRes);
  const secondData = secondImportRes.json?.data;
  if (secondData?.rowsCreated === 0 && secondData?.rowsUpdated === 1) {
    ok("7FE.3b: repeated import updates in place, creates no duplicate (rowsCreated=0, rowsUpdated=1)");
  } else {
    fail("7FE.3b: repeated import updates in place, creates no duplicate", JSON.stringify(secondData));
  }

  await connectDatabase();
  const stayCountAfterRepeat = await Stay.countDocuments({ workspaceId: wsA, reservationId: resId1 });
  const guestCountAfterRepeat = await Guest.countDocuments({ workspaceId: wsA, externalId: guestExtId1 });
  const updatedGuest = await Guest.findOne({ workspaceId: wsA, externalId: guestExtId1 });
  const updatedStay = await Stay.findOne({ workspaceId: wsA, reservationId: resId1 });
  await disconnectDatabase();

  if (stayCountAfterRepeat === 1 && guestCountAfterRepeat === 1) {
    ok("7FE.4: exactly one Guest and one Stay exist for the natural key after re-import (no duplicates)");
  } else {
    fail("7FE.4: exactly one Guest and one Stay exist after re-import", `stays=${stayCountAfterRepeat} guests=${guestCountAfterRepeat}`);
  }
  if (updatedGuest?.email === "john.doe.updated@test.example" && updatedGuest?.phone === "555-0199") {
    ok("7FE.5: guest fields (email/phone) updated correctly by repeated import");
  } else {
    fail("7FE.5: guest fields updated correctly by repeated import", JSON.stringify(updatedGuest));
  }
  if (updatedStay?.status === "checked_in") {
    ok("7FE.6: reservation status update applied correctly");
  } else {
    fail("7FE.6: reservation status update applied correctly", JSON.stringify(updatedStay));
  }

  // =========================================================
  // 7: cancellation
  // =========================================================
  const csvCancel = buildCsv([
    {
      "Test Guest ID": guestExtId1,
      "Test Reservation ID": resId1,
      "Test Room Number": "101",
      "Test Status": "Cancelled",
    },
  ]);
  const cancelImportRes = await expectImportStatus("7FE.7: cancellation import succeeds", { fields: baseFields, fileBytes: csvCancel }, 201);
  trackImportBatch(cancelImportRes);
  await connectDatabase();
  const cancelledStay = await Stay.findOne({ workspaceId: wsA, reservationId: resId1 });
  await disconnectDatabase();
  if (cancelledStay?.status === "cancelled") ok("7FE.7b: cancellation maps explicitly to status=\"cancelled\"");
  else fail("7FE.7b: cancellation maps explicitly to status=\"cancelled\"", JSON.stringify(cancelledStay));

  // =========================================================
  // 8/9/10/11/12/17: row-level validation failures (partial import)
  // =========================================================
  const rowFailureCsv = buildCsv([
    // 8: missing required stay.reservationId
    { "Test Guest ID": `GX1-${stamp}`, "Test Reservation ID": "", "Test Room Number": "101", "Test Status": "Confirmed" },
    // 9: invalid date
    { "Test Guest ID": `GX2-${stamp}`, "Test Reservation ID": `RX2-${stamp}`, "Test Check In": "not-a-date", "Test Status": "Confirmed" },
    // 10: checkOut <= checkIn
    { "Test Guest ID": `GX3-${stamp}`, "Test Reservation ID": `RX3-${stamp}`, "Test Room Number": "101", "Test Check In": "2026-02-10", "Test Check Out": "2026-02-05", "Test Status": "Confirmed" },
    // 11: unknown status
    { "Test Guest ID": `GX4-${stamp}`, "Test Reservation ID": `RX4-${stamp}`, "Test Status": "SomeUnmappedStatus" },
    // 12: unknown unit/room
    { "Test Guest ID": `GX5-${stamp}`, "Test Reservation ID": `RX5-${stamp}`, "Test Room Number": "999-does-not-exist", "Test Status": "Confirmed" },
    // 17: NEW reservation with no guest.externalId AND no guest details (an empty keyless guest is not created)
    { "Test Guest ID": "", "Test Reservation ID": `RX6-${stamp}`, ...FULL, "Test Status": "Confirmed" },
    // one valid row so the batch also produces a success
    { "Test Guest ID": `GX7-${stamp}`, "Test Reservation ID": `RX7-${stamp}`, ...FULL, "Test Status": "Confirmed" },
  ]);
  const rowFailureRes = await expectImportStatus("7FE.8-12/17: partial-failure CSV import still succeeds at file level (207-style 201)", { fields: baseFields, fileBytes: rowFailureCsv }, 201);
  const rowFailureBatchId = trackImportBatch(rowFailureRes);
  const rf = rowFailureRes.json?.data;
  if (rf?.rowsFailed === 6 && rf?.rowsCreated === 1) {
    ok("7FE.8-17: exactly 6 rows fail validation and 1 row still succeeds (partial import, not fail-atomic)");
  } else {
    fail("7FE.8-17: exactly 6 rows fail validation and 1 row still succeeds", JSON.stringify(rf));
  }
  const errorMessages = (rf?.errors || []).map((e) => e.message).join(" | ");
  if (/reservationId/i.test(errorMessages)) ok("7FE.8: missing reservationId produced a row error");
  else fail("7FE.8: missing reservationId produced a row error", errorMessages);
  if (/checkIn/i.test(errorMessages)) ok("7FE.9: invalid date produced a row error");
  else fail("7FE.9: invalid date produced a row error", errorMessages);
  if (/checkOut must be after checkIn/i.test(errorMessages)) ok("7FE.10: checkOut<=checkIn produced a row error");
  else fail("7FE.10: checkOut<=checkIn produced a row error", errorMessages);
  if (/Unknown status/i.test(errorMessages)) ok("7FE.11: unknown status produced a row error");
  else fail("7FE.11: unknown status produced a row error", errorMessages);
  if (/Unit not found/i.test(errorMessages)) ok("7FE.12: unknown unit produced a row error");
  else fail("7FE.12: unknown unit produced a row error", errorMessages);
  if (/Missing guest details for a new reservation without guest\.externalId/.test(errorMessages)) ok("7FE.17: a new reservation with no externalId and no guest details produced a row error");
  else fail("7FE.17: a new reservation with no externalId and no guest details produced a row error", errorMessages);

  // track the one successful row's Guest/Stay for cleanup
  await connectDatabase();
  const rx7Stay = await Stay.findOne({ workspaceId: wsA, reservationId: `RX7-${stamp}` });
  const rx7Guest = await Guest.findOne({ workspaceId: wsA, externalId: `GX7-${stamp}` });
  await disconnectDatabase();
  if (rx7Stay) created.stayIds.push(String(rx7Stay._id));
  if (rx7Guest) created.guestIds.push(String(rx7Guest._id));

  // =========================================================
  // 13/14: invalid Property / invalid Workspace (file-level rejection)
  // =========================================================
  await expectImportStatus("7FE.14: invalid/unknown workspaceId rejected at file level", { fields: { ...baseFields, workspaceId: "64b64c4f2f1c2e0012345678" }, fileBytes: csv1 }, 404);
  await expectImportStatus("7FE.13: invalid/unknown propertyId rejected at file level", { fields: { ...baseFields, propertyId: "64b64c4f2f1c2e0012345678" }, fileBytes: csv1 }, 404);

  // =========================================================
  // 15: cross-workspace isolation
  // =========================================================
  await expectImportStatus("7FE.15: propertyId belonging to a different workspace is rejected", { fields: { ...baseFields, propertyId: propB }, fileBytes: csv1 }, 404);
  await expectStatus("7FE.15b: ImportBatch from workspace A is not visible under workspace B", "GET", `/imports/${firstBatchId}?workspaceId=${wsB}`, null, 404);

  // =========================================================
  // 16: duplicate reservation rows within one file
  // =========================================================
  const dupResId = `RDUP-${stamp}`;
  const dupCsv = buildCsv([
    { "Test Guest ID": `GDUP-${stamp}`, "Test Reservation ID": dupResId, ...FULL, "Test Status": "Confirmed", "Test Adults": "1" },
    { "Test Guest ID": `GDUP-${stamp}`, "Test Reservation ID": dupResId, ...FULL, "Test Status": "Checked In", "Test Adults": "3" },
  ]);
  const dupRes = await expectImportStatus("7FE.16: duplicate reservationId within one file still succeeds (partial-failure architecture)", { fields: baseFields, fileBytes: dupCsv }, 201);
  trackImportBatch(dupRes);
  const dupData = dupRes.json?.data;
  if (dupData?.rowsCreated === 1 && dupData?.rowsUpdated === 1 && (dupData?.warnings || []).length >= 1) {
    ok("7FE.16b: duplicate reservationId in file resolves to 1 created + 1 updated (last row wins), with a warning recorded");
  } else {
    fail("7FE.16b: duplicate reservationId in file resolves correctly with a warning", JSON.stringify(dupData));
  }
  await connectDatabase();
  const dupStayCount = await Stay.countDocuments({ workspaceId: wsA, reservationId: dupResId });
  const dupStay = await Stay.findOne({ workspaceId: wsA, reservationId: dupResId });
  const dupGuest = await Guest.findOne({ workspaceId: wsA, externalId: `GDUP-${stamp}` });
  await disconnectDatabase();
  if (dupStayCount === 1) ok("7FE.16c: only one Stay document exists for the duplicated reservationId");
  else fail("7FE.16c: only one Stay document exists for the duplicated reservationId", `count=${dupStayCount}`);
  if (dupStay?.status === "checked_in" && dupStay?.adults === 3) ok("7FE.16d: last row's values won (sequential processing)");
  else fail("7FE.16d: last row's values won", JSON.stringify(dupStay));
  if (dupStay) created.stayIds.push(String(dupStay._id));
  if (dupGuest) created.guestIds.push(String(dupGuest._id));

  // =========================================================
  // 18: malformed CSV (file-level rejection)
  // =========================================================
  const malformedCsv = 'Test Guest ID,Test Reservation ID\n"unterminated,value\n';
  await expectImportStatus("7FE.18: malformed CSV (unclosed quote) rejected at file level", { fields: baseFields, fileBytes: malformedCsv }, 400);

  // =========================================================
  // 19: unsupported extension
  // =========================================================
  await expectImportStatus("7FE.19: unsupported file extension (.txt) rejected", { fields: baseFields, fileBytes: csv1, filename: "import.txt" }, 400);
  await expectImportStatus("7FE.19b: unsupported file extension (.xlsx) rejected — XLSX is explicitly deferred this phase", { fields: baseFields, fileBytes: csv1, filename: "import.xlsx" }, 400);

  // =========================================================
  // 20: oversized upload -> 413
  // =========================================================
  const oversized = `${"a".repeat(10 * 1024 * 1024 + 1024)}`;
  await expectImportStatus("7FE.20: file exceeding 10 MB rejected", { fields: baseFields, fileBytes: oversized, filename: "huge.csv" }, 413);

  // =========================================================
  // 21: empty CSV
  // =========================================================
  await expectImportStatus("7FE.21: zero-byte file rejected as empty", { fields: baseFields, fileBytes: "" }, 400);
  const headerOnlyCsv = buildCsv([]);
  const headerOnlyRes = await expectImportStatus("7FE.21b: header-only CSV (zero data rows) is accepted and completes with rowsRead=0", { fields: baseFields, fileBytes: headerOnlyCsv }, 201);
  trackImportBatch(headerOnlyRes);
  if (headerOnlyRes.json?.data?.rowsRead === 0 && headerOnlyRes.json?.data?.status === "completed") {
    ok("7FE.21c: header-only CSV produces a completed ImportBatch with all counts at zero");
  } else {
    fail("7FE.21c: header-only CSV produces a completed ImportBatch with all counts at zero", JSON.stringify(headerOnlyRes.json?.data));
  }

  // =========================================================
  // 22: extra unmapped columns
  // =========================================================
  const extraColCsv = buildCsv(
    [
      {
        "Test Guest ID": `GEX-${stamp}`,
        "Test Reservation ID": `REX-${stamp}`,
        ...FULL,
        "Test Status": "Confirmed",
        "Unmapped Extra Column": "should be ignored",
      },
    ],
    { extraHeader: "Unmapped Extra Column" },
  );
  const extraColRes = await expectImportStatus("7FE.22: CSV with an extra column not present in mappingProfile still imports successfully", { fields: baseFields, fileBytes: extraColCsv }, 201);
  trackImportBatch(extraColRes);
  if (extraColRes.json?.data?.rowsCreated === 1) ok("7FE.22b: the extra unmapped column is ignored, not an error");
  else fail("7FE.22b: the extra unmapped column is ignored", JSON.stringify(extraColRes.json?.data));
  await connectDatabase();
  const extraColGuest = await Guest.findOne({ workspaceId: wsA, externalId: `GEX-${stamp}` });
  const extraColStay = await Stay.findOne({ workspaceId: wsA, reservationId: `REX-${stamp}` });
  await disconnectDatabase();
  if (extraColGuest) created.guestIds.push(String(extraColGuest._id));
  if (extraColStay) created.stayIds.push(String(extraColStay._id));

  // =========================================================
  // 23: BOM CSV
  // =========================================================
  const bomCsv = buildCsv(
    [{ "Test Guest ID": `GBOM-${stamp}`, "Test Reservation ID": `RBOM-${stamp}`, ...FULL, "Test Status": "Confirmed" }],
    { bom: true },
  );
  const bomRes = await expectImportStatus("7FE.23: CSV with a leading UTF-8 BOM parses correctly", { fields: baseFields, fileBytes: bomCsv }, 201);
  trackImportBatch(bomRes);
  if (bomRes.json?.data?.rowsCreated === 1) ok("7FE.23b: BOM does not corrupt header matching or row parsing");
  else fail("7FE.23b: BOM does not corrupt header matching or row parsing", JSON.stringify(bomRes.json?.data));
  await connectDatabase();
  const bomGuest = await Guest.findOne({ workspaceId: wsA, externalId: `GBOM-${stamp}` });
  const bomStay = await Stay.findOne({ workspaceId: wsA, reservationId: `RBOM-${stamp}` });
  await disconnectDatabase();
  if (bomGuest) created.guestIds.push(String(bomGuest._id));
  if (bomStay) created.stayIds.push(String(bomStay._id));

  // =========================================================
  // 24: CRLF handling
  // =========================================================
  const crlfCsv = buildCsv(
    [{ "Test Guest ID": `GCRLF-${stamp}`, "Test Reservation ID": `RCRLF-${stamp}`, ...FULL, "Test Status": "Confirmed" }],
    { lineEnding: "\r\n" },
  );
  const crlfRes = await expectImportStatus("7FE.24: CRLF line endings parse correctly", { fields: baseFields, fileBytes: crlfCsv }, 201);
  trackImportBatch(crlfRes);
  if (crlfRes.json?.data?.rowsCreated === 1) ok("7FE.24b: CRLF-delimited CSV imports the same as LF");
  else fail("7FE.24b: CRLF-delimited CSV imports the same as LF", JSON.stringify(crlfRes.json?.data));
  await connectDatabase();
  const crlfGuest = await Guest.findOne({ workspaceId: wsA, externalId: `GCRLF-${stamp}` });
  const crlfStay = await Stay.findOne({ workspaceId: wsA, reservationId: `RCRLF-${stamp}` });
  await disconnectDatabase();
  if (crlfGuest) created.guestIds.push(String(crlfGuest._id));
  if (crlfStay) created.stayIds.push(String(crlfStay._id));

  // =========================================================
  // 25/26/27/28: ImportBatch creation, counts, errors, tenant scoping
  // =========================================================
  const batchGetRes = await expectStatus("7FE.25: created ImportBatch is retrievable", "GET", `/imports/${rowFailureBatchId}?workspaceId=${wsA}`, null, 200);
  if (batchGetRes.json?.data?.status === "completed") ok("7FE.25b: retrieved ImportBatch has status completed");
  else fail("7FE.25b: retrieved ImportBatch has status completed", JSON.stringify(batchGetRes.json?.data));
  if (batchGetRes.json?.data?.rowsFailed === 6 && batchGetRes.json?.data?.rowsCreated === 1) {
    ok("7FE.26: persisted ImportBatch counts match the returned result contract");
  } else {
    fail("7FE.26: persisted ImportBatch counts match the returned result contract", JSON.stringify(batchGetRes.json?.data));
  }
  if (Array.isArray(batchGetRes.json?.data?.errors) && batchGetRes.json.data.errors.length === 6) {
    ok("7FE.27: persisted ImportBatch.errors[] has one entry per failed row");
  } else {
    fail("7FE.27: persisted ImportBatch.errors[] has one entry per failed row", JSON.stringify(batchGetRes.json?.data?.errors));
  }
  await expectStatus("7FE.28: tenant-scoped ImportBatch lookup rejects a cross-workspace request", "GET", `/imports/${rowFailureBatchId}?workspaceId=${wsB}`, null, 404);
  await expectStatus("7FE.28b: ImportBatch lookup without workspaceId is rejected", "GET", `/imports/${rowFailureBatchId}`, null, 400);

  // =========================================================
  // 7F-E review hardening
  // =========================================================
  const propA2 = trackCreated(
    await expectStatus("7FE.R: second property in workspace A", "POST", "/properties", { workspaceId: wsA, name: "Second", code: "KRE2" + stamp }, 201),
    "propertyIds",
  );
  const cell = (obj) => buildCsv([obj]);
  const lookup = async (guestExt, resId) => {
    await connectDatabase();
    const guest = guestExt ? await Guest.findOne({ workspaceId: wsA, externalId: guestExt }) : null;
    const stay = resId ? await Stay.findOne({ workspaceId: wsA, reservationId: resId }) : null;
    await disconnectDatabase();
    return { guest, stay };
  };

  // --- mapping validation: only approved targets, columns are only CSV headers ---
  const badProfile = (extra, label) =>
    expectImportStatus("7FE.R.map: " + label + " rejected", { fields: { ...baseFields, mappingProfile: { ...MAPPING_PROFILE, ...extra } }, fileBytes: csv1 }, 400);
  await badProfile({ "guest.preferences": "Test Guest ID" }, "non-approved Guest field target (guest.preferences)");
  await badProfile({ "stay.metadata": "Test Guest ID" }, "non-approved Stay field target (stay.metadata)");
  await badProfile({ "stay.guestId": "Test Guest ID" }, "immutable-field target (stay.guestId)");
  await badProfile({ $where: "Test Guest ID" }, "Mongo operator key ($where)");
  await badProfile({ ["__proto__"]: "Test Guest ID" }, "__proto__ key");
  await badProfile({ "guest.email": "No Such Column" }, "source column absent from CSV header");
  await badProfile({ "guest.email": "" }, "empty source column name");
  await badProfile({ "guest.email": { $ne: null } }, "non-string source column value");
  await badProfile({ "guest.email": "x".repeat(300) }, "over-long source column name");
  const noRequired = { ...MAPPING_PROFILE };
  delete noRequired["stay.reservationId"];
  await expectImportStatus("7FE.R.map: profile missing required stay.reservationId rejected", { fields: { ...baseFields, mappingProfile: noRequired }, fileBytes: csv1 }, 400);
  await expectImportStatus("7FE.R.map: mappingProfile that is not valid JSON rejected", { fields: { ...baseFields, mappingProfile: "{not json" }, fileBytes: csv1 }, 400);
  await expectImportStatus("7FE.R.map: mappingProfile as JSON array rejected", { fields: { ...baseFields, mappingProfile: "[]" }, fileBytes: csv1 }, 400);
  await expectImportStatus("7FE.R.map: statusMapping with a non-enum target rejected", { fields: { ...baseFields, statusMapping: { Confirmed: "vip" } }, fileBytes: csv1 }, 400);
  await expectImportStatus("7FE.R.map: missing statusMapping rejected", { fields: { ...baseFields, statusMapping: undefined }, fileBytes: csv1 }, 400);
  await expectImportStatus("7FE.R.map: missing dateFormat rejected", { fields: { ...baseFields, dateFormat: undefined }, fileBytes: csv1 }, 400);
  await expectImportStatus("7FE.R.map: dateFormat without YYYY/MM/DD rejected", { fields: { ...baseFields, dateFormat: "DD/MM" }, fileBytes: csv1 }, 400);

  // A header literally named "__proto__" is just a column name, never a path.
  const protoHeaderCsv = "__proto__,Test Reservation ID,Test Status,Test Room Number,Test Check In,Test Check Out\n" + ("GPROTO-" + stamp) + "," + ("RPROTO-" + stamp) + ",Confirmed,101,2026-04-01,2026-04-05\n";
  const protoRes = await expectImportStatus(
    "7FE.R.map: a CSV header named __proto__ is treated as a plain column name",
    { fields: { ...baseFields, mappingProfile: { "guest.externalId": "__proto__", "stay.reservationId": "Test Reservation ID", "stay.status": "Test Status", "stay.roomNumber": "Test Room Number", "stay.checkIn": "Test Check In", "stay.checkOut": "Test Check Out" } }, fileBytes: protoHeaderCsv },
    201,
  );
  trackImportBatch(protoRes);
  if (protoRes.json?.data?.rowsCreated === 1) ok("7FE.R.map: __proto__-named column imported as an ordinary value");
  else fail("7FE.R.map: __proto__-named column imported as an ordinary value", JSON.stringify(protoRes.json?.data));

  // Prototype-chain status values must not resolve as statuses.
  const protoStatusRes = await expectImportStatus(
    "7FE.R.map: prototype-chain status text ('constructor') is an unknown status",
    { fields: baseFields, fileBytes: cell({ "Test Guest ID": "GCTOR-" + stamp, "Test Reservation ID": "RCTOR-" + stamp, "Test Status": "constructor" }) },
    201,
  );
  trackImportBatch(protoStatusRes);
  if (protoStatusRes.json?.data?.rowsFailed === 1 && /Unknown status/.test(protoStatusRes.json?.data?.errors?.[0]?.message || "")) {
    ok("7FE.R.map: 'constructor' status fails cleanly as Unknown status (not via prototype lookup)");
  } else {
    fail("7FE.R.map: 'constructor' status fails cleanly as Unknown status", JSON.stringify(protoStatusRes.json?.data));
  }

  // --- blank mapped cells never erase existing values ---
  await connectDatabase();
  const beforeBlank = await Stay.findOne({ workspaceId: wsA, reservationId: resId2 });
  await disconnectDatabase();
  const blankRes = await expectImportStatus(
    "7FE.R.blank: re-import with blank optional cells succeeds",
    { fields: baseFields, fileBytes: cell({ "Test Guest ID": guestExtId2, "Test Reservation ID": resId2, "Test Status": "Confirmed" }) },
    201,
  );
  trackImportBatch(blankRes);
  await connectDatabase();
  const afterBlankGuest = await Guest.findOne({ workspaceId: wsA, externalId: guestExtId2 });
  const afterBlankStay = await Stay.findOne({ workspaceId: wsA, reservationId: resId2 });
  await disconnectDatabase();
  if (afterBlankGuest?.email === "jane.roe@test.example" && afterBlankGuest?.phone === "555-0200" && afterBlankGuest?.firstName === "Jane" && afterBlankGuest?.lastName === "Roe") {
    ok("7FE.R.blank: blank guest cells did not erase existing firstName/lastName/email/phone");
  } else {
    fail("7FE.R.blank: blank guest cells did not erase existing guest values", JSON.stringify(afterBlankGuest));
  }
  if (
    afterBlankStay?.adults === 1 && afterBlankStay?.children === 1 &&
    String(afterBlankStay?.checkIn) === String(beforeBlank?.checkIn) && String(afterBlankStay?.checkOut) === String(beforeBlank?.checkOut) &&
    String(afterBlankStay?.unitId) === String(beforeBlank?.unitId) && afterBlankStay?.unitId
  ) {
    ok("7FE.R.blank: blank stay cells did not erase existing adults/children/dates/unit");
  } else {
    fail("7FE.R.blank: blank stay cells did not erase existing stay values", JSON.stringify({ before: beforeBlank, after: afterBlankStay }));
  }

  // --- imported stays do NOT use the manual-entry overlap guard ---
  const overlapCsv = buildCsv([
    { "Test Guest ID": "GOV1-" + stamp, "Test Reservation ID": "ROV1-" + stamp, "Test Room Number": "102", "Test Check In": "2026-03-01", "Test Check Out": "2026-03-10", "Test Status": "Confirmed" },
    { "Test Guest ID": "GOV2-" + stamp, "Test Reservation ID": "ROV2-" + stamp, "Test Room Number": "102", "Test Check In": "2026-03-05", "Test Check Out": "2026-03-12", "Test Status": "Confirmed" },
  ]);
  const overlapRes = await expectImportStatus("7FE.R.overlap: two overlapping stays for the same unit both import", { fields: baseFields, fileBytes: overlapCsv }, 201);
  trackImportBatch(overlapRes);
  if (overlapRes.json?.data?.rowsCreated === 2 && overlapRes.json?.data?.rowsFailed === 0) {
    ok("7FE.R.overlap: manual-entry overlap/double-booking guard is intentionally not applied to imports");
  } else {
    fail("7FE.R.overlap: manual-entry overlap guard is not applied to imports", JSON.stringify(overlapRes.json?.data));
  }

  // --- failed rows leave no partial writes; immutable guest/property ---
  const propMismatchRes = await expectImportStatus(
    "7FE.R.immutable: existing reservationId imported under a different property",
    { fields: { ...baseFields, propertyId: propA2 }, fileBytes: cell({ "Test Guest ID": "GNEWP-" + stamp, "Test Reservation ID": resId2, "Test Status": "Confirmed" }) },
    201,
  );
  trackImportBatch(propMismatchRes);
  const guestMismatchRes = await expectImportStatus(
    "7FE.R.immutable: existing reservationId imported with a different guest",
    { fields: baseFields, fileBytes: cell({ "Test Guest ID": "GNEWG-" + stamp, "Test Reservation ID": resId2, "Test Status": "Checked In" }) },
    201,
  );
  trackImportBatch(guestMismatchRes);
  const noStatusRes = await expectImportStatus(
    "7FE.R.status: a NEW reservation without a status",
    { fields: baseFields, fileBytes: cell({ "Test Guest ID": "GNOST-" + stamp, "Test Reservation ID": "RNOST-" + stamp }) },
    201,
  );
  trackImportBatch(noStatusRes);
  const badRangeRes = await expectImportStatus(
    "7FE.R.range: a row supplying only checkOut earlier than the stored checkIn",
    { fields: baseFields, fileBytes: cell({ "Test Guest ID": guestExtId2, "Test Reservation ID": resId2, "Test Check Out": "2026-01-05", "Test Status": "Confirmed" }) },
    201,
  );
  trackImportBatch(badRangeRes);
  for (const [label, res, pattern] of [
    ["different property", propMismatchRes, /different property/],
    ["different guest", guestMismatchRes, /different guest/],
    ["new reservation without status", noStatusRes, /Missing required stay\.status/],
    ["merged date range inverted", badRangeRes, /checkOut must be after checkIn/],
  ]) {
    if (res.json?.data?.rowsFailed === 1 && pattern.test(res.json?.data?.errors?.[0]?.message || "")) ok("7FE.R: row fails safely - " + label);
    else fail("7FE.R: row fails safely - " + label, JSON.stringify(res.json?.data));
  }
  await connectDatabase();
  const leakedGuests = await Guest.countDocuments({ workspaceId: wsA, externalId: { $in: ["GNEWP-" + stamp, "GNEWG-" + stamp, "GNOST-" + stamp] } });
  const leakedStay = await Stay.countDocuments({ workspaceId: wsA, reservationId: "RNOST-" + stamp });
  const stayAfterConflicts = await Stay.findOne({ workspaceId: wsA, reservationId: resId2 });
  await disconnectDatabase();
  if (leakedGuests === 0 && leakedStay === 0) ok("7FE.R: failed rows leave no partial Guest/Stay writes");
  else fail("7FE.R: failed rows leave no partial Guest/Stay writes", "guests=" + leakedGuests + " stays=" + leakedStay);
  if (
    String(stayAfterConflicts?.guestId) === String(afterBlankStay?.guestId) &&
    String(stayAfterConflicts?.propertyId) === String(propA) &&
    stayAfterConflicts?.status === "confirmed" &&
    String(stayAfterConflicts?.checkOut) === String(beforeBlank?.checkOut)
  ) {
    ok("7FE.R: existing Stay guestId/propertyId/status/dates unchanged after all conflicting rows");
  } else {
    fail("7FE.R: existing Stay unchanged after conflicting rows", JSON.stringify(stayAfterConflicts));
  }

  // --- diagnostics are bounded ---
  const longStatusRes = await expectImportStatus(
    "7FE.R.errors: a 500-character status cell",
    { fields: baseFields, fileBytes: cell({ "Test Guest ID": "GLONG-" + stamp, "Test Reservation ID": "RLONG-" + stamp, "Test Status": "S".repeat(500) }) },
    201,
  );
  trackImportBatch(longStatusRes);
  const longMsg = longStatusRes.json?.data?.errors?.[0]?.message || "";
  if (longStatusRes.json?.data?.rowsFailed === 1 && longMsg.length < 100 && !longMsg.includes("S".repeat(60))) {
    ok("7FE.R.errors: echoed cell content in errors[] is truncated (no full raw cell values)");
  } else {
    fail("7FE.R.errors: echoed cell content in errors[] is truncated", String(longMsg.length));
  }
  const manyRows = [];
  for (let i = 0; i < 1100; i += 1) {
    manyRows.push({ "Test Guest ID": "GMANY" + i + "-" + stamp, "Test Reservation ID": "RMANY" + i + "-" + stamp, "Test Status": "NoSuchStatus" });
  }
  const manyRes = await expectImportStatus("7FE.R.errors: 1100 failing rows", { fields: baseFields, fileBytes: buildCsv(manyRows) }, 201);
  const manyBatchId = trackImportBatch(manyRes);
  const manyData = manyRes.json?.data;
  if (manyData?.rowsFailed === 1100 && manyData?.errors?.length === 1000 && (manyData?.warnings || []).some((w) => /first 1000 of 1100/.test(w))) {
    ok("7FE.R.errors: recorded errors are capped at 1000 while rowsFailed stays exact, with a warning");
  } else {
    fail("7FE.R.errors: recorded errors are capped at 1000", JSON.stringify({ failed: manyData?.rowsFailed, errs: manyData?.errors?.length, warnings: manyData?.warnings }));
  }
  const manyBatch = await request("GET", "/imports/" + manyBatchId + "?workspaceId=" + wsA);
  if (manyBatch.json?.data?.errors?.length === 1000 && manyBatch.json?.data?.rowsFailed === 1100) ok("7FE.R.errors: persisted ImportBatch.errors is bounded too");
  else fail("7FE.R.errors: persisted ImportBatch.errors is bounded", String(manyBatch.json?.data?.errors?.length));

  // --- ImportBatch content, lifecycle, and scoping ---
  const evilNameRes = await expectImportStatus("7FE.R.batch: import with a path-like filename", { fields: baseFields, fileBytes: headerOnlyCsv, filename: "../../evil.csv" }, 201);
  const evilBatchId = trackImportBatch(evilNameRes);
  const evilBatch = await request("GET", "/imports/" + evilBatchId + "?workspaceId=" + wsA);
  if (evilBatch.json?.data?.filename === "evil.csv") ok("7FE.R.batch: stored filename is a sanitized basename");
  else fail("7FE.R.batch: stored filename is a sanitized basename", JSON.stringify(evilBatch.json?.data?.filename));
  const persistedProfile = evilBatch.json?.data?.mappingProfile || {};
  if (JSON.stringify(persistedProfile) === JSON.stringify(MAPPING_PROFILE) && Object.keys(persistedProfile).length <= 12) {
    ok("7FE.R.batch: persisted mappingProfile is the validated/normalized profile (approved keys only, bounded)");
  } else {
    fail("7FE.R.batch: persisted mappingProfile is the validated/normalized profile", JSON.stringify(persistedProfile));
  }
  if (evilBatch.json?.data?.completedAt && evilBatch.json?.data?.status === "completed" && new Date(evilBatch.json.data.completedAt) >= new Date(evilBatch.json.data.startedAt)) {
    ok("7FE.R.batch: completed batch always has completedAt >= startedAt");
  } else {
    fail("7FE.R.batch: completed batch has completedAt", JSON.stringify(evilBatch.json?.data));
  }
  await expectStatus("7FE.R.batch: repeated workspaceId query param rejected", "GET", "/imports/" + evilBatchId + "?workspaceId=" + wsA + "&workspaceId=" + wsB, null, 400);

  // Fatal (non-row) failure -> failed + completedAt. Service is called
  // in-process so the finalizing write can be forced to fail once.
  await connectDatabase();
  const realUpdateOne = ImportBatch.updateOne;
  let updateCalls = 0;
  ImportBatch.updateOne = function patched(...args) {
    updateCalls += 1;
    if (updateCalls === 1) return Promise.reject(new Error("simulated fatal failure"));
    return realUpdateOne.apply(this, args);
  };
  let fatalThrown = false;
  try {
    await importOperationalCsv({
      workspaceId: wsA,
      propertyId: propA,
      filename: "fatal-test.csv",
      buffer: Buffer.from(cell({ "Test Guest ID": "GFATAL-" + stamp, "Test Reservation ID": "RFATAL-" + stamp, ...FULL, "Test Status": "Confirmed" })),
      mappingProfile: MAPPING_PROFILE,
      dateFormat: DATE_FORMAT,
      statusMapping: STATUS_MAPPING,
    });
  } catch {
    fatalThrown = true;
  } finally {
    ImportBatch.updateOne = realUpdateOne;
  }
  const failedBatch = await ImportBatch.findOne({ workspaceId: wsA, filename: "fatal-test.csv" });
  const pendingCount = await ImportBatch.countDocuments({ workspaceId: wsA, status: "pending" });
  await disconnectDatabase();
  if (failedBatch) created.importBatchIds.push(String(failedBatch._id));
  if (fatalThrown && failedBatch?.status === "failed" && failedBatch?.completedAt) ok("7FE.R.lifecycle: unexpected fatal failure marks the batch failed with completedAt, and the error propagates");
  else fail("7FE.R.lifecycle: unexpected fatal failure marks the batch failed with completedAt", JSON.stringify({ fatalThrown, failedBatch }));
  if (pendingCount === 0) ok("7FE.R.lifecycle: no ImportBatch is left in pending after processing");
  else fail("7FE.R.lifecycle: no ImportBatch is left in pending", "pending=" + pendingCount);

  // --- concurrent identical imports: no duplicates, no uncontrolled 500 ---
  // 5 rounds x 4 simultaneous uploads of the same brand-new guest+reservation.
  let raceBad = null;
  for (let round = 1; round <= 5 && !raceBad; round += 1) {
    const raceGuestId = "GRACE" + round + "-" + stamp;
    const raceResId = "RRACE" + round + "-" + stamp;
    const raceCsv = cell({ "Test Guest ID": raceGuestId, "Test Reservation ID": raceResId, ...FULL, "Test Status": "Confirmed" });
    const raceResults = await Promise.all([1, 2, 3, 4].map(() => uploadImport({ fields: baseFields, fileBytes: raceCsv })));
    raceResults.forEach((r) => trackImportBatch(r));
    const raceFailedRows = raceResults.reduce((n, r) => n + (r.json?.data?.rowsFailed || 0), 0);
    const raceFound = await lookup(raceGuestId, raceResId);
    await connectDatabase();
    const raceGuests = await Guest.countDocuments({ workspaceId: wsA, externalId: raceGuestId });
    const raceStays = await Stay.countDocuments({ workspaceId: wsA, reservationId: raceResId });
    await disconnectDatabase();
    if (!raceResults.every((r) => r.status === 201) || raceFailedRows !== 0 || raceGuests !== 1 || raceStays !== 1 || !raceFound.stay) {
      raceBad = { round, statuses: raceResults.map((r) => r.status), raceFailedRows, raceGuests, raceStays, errors: raceResults.map((r) => r.json?.data?.errors) };
    }
  }
  if (!raceBad) ok("7FE.R.race: 5 rounds of 4 concurrent identical imports - all 201, zero failed rows, exactly one Guest and one Stay each (duplicate-key races are retried)");
  else fail("7FE.R.race: concurrent identical imports complete cleanly with no duplicates", JSON.stringify(raceBad));

  // =========================================================
  // 7F-E pre-commit hardening: new-Stay requirements, duplicate headers,
  // partial-write behavior
  // =========================================================
  const countBatches = async () => {
    await connectDatabase();
    const n = await ImportBatch.countDocuments({ workspaceId: wsA });
    await disconnectDatabase();
    return n;
  };

  // --- NEW Stay: room + checkIn + checkOut required, checkIn < checkOut ---
  const newStayCases = [
    ["missing checkIn", { "Test Check In": "" }, /Missing required stay\.checkIn/],
    ["missing checkOut", { "Test Check Out": "" }, /Missing required stay\.checkOut/],
    ["missing room/unit", { "Test Room Number": "" }, /Missing required stay\.roomNumber/],
    ["invalid checkIn", { "Test Check In": "nope" }, /Invalid stay\.checkIn/],
    ["invalid checkOut", { "Test Check Out": "2026-13-45" }, /Invalid stay\.checkOut/],
    ["checkIn equal to checkOut", { "Test Check Out": "2026-04-01" }, /checkOut must be after checkIn/],
    ["checkIn after checkOut", { "Test Check Out": "2026-03-01" }, /checkOut must be after checkIn/],
  ];
  for (const [label, override, pattern] of newStayCases) {
    const tag = label.replace(/[^a-z]/gi, "");
    const res = await expectImportStatus(
      "7FE.S.new: NEW stay with " + label,
      { fields: baseFields, fileBytes: cell({ "Test Guest ID": "GNEW" + tag + "-" + stamp, "Test Reservation ID": "RNEW" + tag + "-" + stamp, ...FULL, "Test Status": "Confirmed", ...override }) },
      201,
    );
    trackImportBatch(res);
    const { guest, stay } = await lookup("GNEW" + tag + "-" + stamp, "RNEW" + tag + "-" + stamp);
    if (res.json?.data?.rowsFailed === 1 && res.json?.data?.rowsCreated === 0 && pattern.test(res.json?.data?.errors?.[0]?.message || "") && !guest && !stay) {
      ok("7FE.S.new: row fails (" + label + ") and writes neither Guest nor Stay");
    } else {
      fail("7FE.S.new: row fails (" + label + ") and writes nothing", JSON.stringify({ data: res.json?.data, guest: !!guest, stay: !!stay }));
    }
  }

  // --- EXISTING Stay: blank dates retain; invalid supplied date fails; merged range validated ---
  const reqGuest = "GREQ-" + stamp;
  const reqRes = "RREQ-" + stamp;
  trackImportBatch(await expectImportStatus("7FE.S.existing: fixture stay created", { fields: baseFields, fileBytes: cell({ "Test Guest ID": reqGuest, "Test Reservation ID": reqRes, ...FULL, "Test Status": "Confirmed" }) }, 201));
  const fixture = await lookup(reqGuest, reqRes);
  trackImportBatch(await expectImportStatus(
    "7FE.S.existing: blank dates and room on an existing stay",
    { fields: baseFields, fileBytes: cell({ "Test Guest ID": reqGuest, "Test Reservation ID": reqRes, "Test Status": "Checked In" }) },
    201,
  ));
  const retained = await lookup(reqGuest, reqRes);
  if (
    retained.stay?.status === "checked_in" &&
    String(retained.stay?.checkIn) === String(fixture.stay?.checkIn) &&
    String(retained.stay?.checkOut) === String(fixture.stay?.checkOut) &&
    String(retained.stay?.unitId) === String(fixture.stay?.unitId)
  ) {
    ok("7FE.S.existing: blank checkIn/checkOut/room retain the stored values while other fields update");
  } else {
    fail("7FE.S.existing: blank dates retain the stored values", JSON.stringify({ fixture: fixture.stay, retained: retained.stay }));
  }
  const invalidExisting = await expectImportStatus(
    "7FE.S.existing: supplied invalid date on an existing stay",
    { fields: baseFields, fileBytes: cell({ "Test Guest ID": reqGuest, "Test Reservation ID": reqRes, "Test Check In": "31/12/2026", "Test Status": "Checked Out" }) },
    201,
  );
  trackImportBatch(invalidExisting);
  const afterInvalid = await lookup(reqGuest, reqRes);
  if (
    invalidExisting.json?.data?.rowsFailed === 1 && /Invalid stay\.checkIn/.test(invalidExisting.json?.data?.errors?.[0]?.message || "") &&
    afterInvalid.stay?.status === "checked_in" && String(afterInvalid.stay?.checkIn) === String(fixture.stay?.checkIn)
  ) {
    ok("7FE.S.existing: a supplied invalid date fails the row and the stored stay is unchanged");
  } else {
    fail("7FE.S.existing: supplied invalid date fails the row", JSON.stringify({ data: invalidExisting.json?.data, after: afterInvalid.stay }));
  }
  const mergedBad = await expectImportStatus(
    "7FE.S.existing: only checkIn supplied, later than the stored checkOut",
    { fields: baseFields, fileBytes: cell({ "Test Guest ID": reqGuest, "Test Reservation ID": reqRes, "Test Check In": "2026-05-01", "Test Status": "Checked In" }) },
    201,
  );
  trackImportBatch(mergedBad);
  if (mergedBad.json?.data?.rowsFailed === 1 && /checkOut must be after checkIn/.test(mergedBad.json?.data?.errors?.[0]?.message || "")) ok("7FE.S.existing: merged final date range is validated");
  else fail("7FE.S.existing: merged final date range is validated", JSON.stringify(mergedBad.json?.data));
  const extendRes = await expectImportStatus(
    "7FE.S.existing: valid supplied checkOut extends the stay",
    { fields: baseFields, fileBytes: cell({ "Test Guest ID": reqGuest, "Test Reservation ID": reqRes, "Test Check Out": "2026-04-09" }) },
    201,
  );
  trackImportBatch(extendRes);
  const extended = await lookup(reqGuest, reqRes);
  if (extendRes.json?.data?.rowsUpdated === 1 && extended.stay?.checkOut?.toISOString().startsWith("2026-04-09") && String(extended.stay?.checkIn) === String(fixture.stay?.checkIn)) ok("7FE.S.existing: valid supplied date updates only that date");
  else fail("7FE.S.existing: valid supplied date updates only that date", JSON.stringify(extended.stay));

  // --- duplicate CSV headers reject the entire file ---
  const dupHeaderCase = async (label, headerLine, guestExt) => {
    const before = await countBatches();
    const csv = headerLine + "\n" + guestExt + ",RDH-" + guestExt + ",Confirmed,Confirmed,101,2026-04-01,2026-04-05\n";
    const res = await uploadImport({
      fields: { ...baseFields, mappingProfile: { "guest.externalId": "Test Guest ID", "stay.reservationId": "Test Reservation ID", "stay.status": "Test Status", "stay.roomNumber": "Test Room Number", "stay.checkIn": "Test Check In", "stay.checkOut": "Test Check Out" } },
      fileBytes: csv,
    });
    const after = await countBatches();
    const found = await lookup(guestExt, "RDH-" + guestExt);
    if (res.status === 400 && /duplicate column header/i.test(res.json?.message || "") && /Test Status/i.test(res.json?.message || "") && before === after && !found.guest && !found.stay) {
      ok("7FE.D: duplicate headers (" + label + ") reject the whole file with a clear 400, no ImportBatch, no Guest, no Stay");
    } else {
      fail("7FE.D: duplicate headers (" + label + ")", JSON.stringify({ status: res.status, message: res.json?.message, before, after, guest: !!found.guest, stay: !!found.stay }));
    }
  };
  await dupHeaderCase("exact", "Test Guest ID,Test Reservation ID,Test Status,Test Status,Test Room Number,Test Check In,Test Check Out", "GDH1-" + stamp);
  await dupHeaderCase("differing only by case", "Test Guest ID,Test Reservation ID,Test Status,test STATUS,Test Room Number,Test Check In,Test Check Out", "GDH2-" + stamp);
  await dupHeaderCase("differing only by surrounding whitespace", "Test Guest ID,Test Reservation ID,Test Status,  Test Status  ,Test Room Number,Test Check In,Test Check Out", "GDH3-" + stamp);
  await dupHeaderCase("case and leading whitespace combined", "Test Guest ID,Test Reservation ID,Test Status, test status,Test Room Number,Test Check In,Test Check Out", "GDH4-" + stamp);

  // duplicate among columns the profile never maps is still ambiguous file-wide -> rejected
  const beforeUnmapped = await countBatches();
  const unmappedDup = await uploadImport({
    fields: { ...baseFields, mappingProfile: { "guest.externalId": "Test Guest ID", "stay.reservationId": "Test Reservation ID" } },
    fileBytes: "Test Guest ID,Test Reservation ID,Notes,notes\nGDH5-" + stamp + ",RDH5-" + stamp + ",a,b\n",
  });
  if (unmappedDup.status === 400 && /duplicate column header/i.test(unmappedDup.json?.message || "") && (await countBatches()) === beforeUnmapped) ok("7FE.D: a duplicate among unmapped columns also rejects the file");
  else fail("7FE.D: a duplicate among unmapped columns also rejects the file", JSON.stringify({ status: unmappedDup.status, body: unmappedDup.json }));

  // Multiple EMPTY header cells are exempt (unmappable), and mapping columns are matched case-insensitively.
  const emptyHeaderRes = await uploadImport({
    fields: {
      ...baseFields,
      mappingProfile: { "guest.externalId": "TEST guest id", "stay.reservationId": " test reservation id ", "stay.status": "Test Status", "stay.roomNumber": "Test Room Number", "stay.checkIn": "Test Check In", "stay.checkOut": "Test Check Out" },
    },
    fileBytes: "Test Guest ID,Test Reservation ID,Test Status,Test Room Number,Test Check In,Test Check Out,,\nGEH-" + stamp + ",REH-" + stamp + ",Confirmed,101,2026-04-01,2026-04-05,x,y\n",
  });
  trackImportBatch(emptyHeaderRes);
  const ehBatch = await request("GET", "/imports/" + emptyHeaderRes.json?.data?.importBatchId + "?workspaceId=" + wsA);
  if (emptyHeaderRes.status === 201 && emptyHeaderRes.json?.data?.rowsCreated === 1 && ehBatch.json?.data?.mappingProfile?.["guest.externalId"] === "Test Guest ID") {
    ok("7FE.D: empty header cells are exempt, and mapping resolves columns case/whitespace-insensitively (persisting the file's actual header text)");
  } else {
    fail("7FE.D: empty header cells exempt + case-insensitive mapping", JSON.stringify({ status: emptyHeaderRes.status, body: emptyHeaderRes.json, profile: ehBatch.json?.data?.mappingProfile }));
  }

  // --- partial-write behavior: Guest saved, Stay save fails, retry is idempotent ---
  await connectDatabase();
  const realStaySave = Stay.prototype.save;
  let stayFailuresLeft = 1;
  const pwReservation = "RPW-" + stamp;
  Stay.prototype.save = function patchedSave(...args) {
    if (stayFailuresLeft > 0 && this.reservationId === pwReservation) {
      stayFailuresLeft -= 1;
      return Promise.reject(new Error("simulated stay save failure"));
    }
    return realStaySave.apply(this, args);
  };
  const pwInput = {
    workspaceId: wsA,
    propertyId: propA,
    filename: "partial-write.csv",
    buffer: Buffer.from(cell({ "Test Guest ID": "GPW-" + stamp, "Test Reservation ID": pwReservation, ...FULL, "Test Status": "Confirmed" })),
    mappingProfile: MAPPING_PROFILE,
    dateFormat: DATE_FORMAT,
    statusMapping: STATUS_MAPPING,
  };
  let firstAttempt;
  let secondAttempt;
  try {
    firstAttempt = await importOperationalCsv(pwInput);
  } finally {
    Stay.prototype.save = realStaySave;
  }
  await disconnectDatabase();
  const midState = await lookup("GPW-" + stamp, pwReservation);
  await connectDatabase();
  secondAttempt = await importOperationalCsv(pwInput);
  await disconnectDatabase();
  const endState = await lookup("GPW-" + stamp, pwReservation);
  await connectDatabase();
  const pwGuestCount = await Guest.countDocuments({ workspaceId: wsA, externalId: "GPW-" + stamp });
  const pwStayCount = await Stay.countDocuments({ workspaceId: wsA, reservationId: pwReservation });
  await disconnectDatabase();
  if (firstAttempt?.rowsFailed === 1 && firstAttempt?.errors?.[0]?.message === "Row could not be processed" && midState.guest && !midState.stay) {
    ok("7FE.P: when the Stay save fails after validation, the row is reported failed; the already-saved Guest remains and no Stay exists (documented behavior)");
  } else {
    fail("7FE.P: Guest saved / Stay save failed behavior", JSON.stringify({ firstAttempt, guest: !!midState.guest, stay: !!midState.stay }));
  }
  if (secondAttempt?.rowsCreated === 1 && secondAttempt?.rowsFailed === 0 && endState.stay && String(endState.stay.guestId) === String(midState.guest?._id)) {
    ok("7FE.P: retry succeeds and the Stay links to the Guest saved by the failed attempt");
  } else {
    fail("7FE.P: retry succeeds and reuses the earlier Guest", JSON.stringify({ secondAttempt, stay: endState.stay }));
  }
  if (pwGuestCount === 1 && pwStayCount === 1) ok("7FE.P: retry is idempotent - exactly one Guest and one Stay, no duplicate Guest");
  else fail("7FE.P: retry is idempotent", "guests=" + pwGuestCount + " stays=" + pwStayCount);

  // =========================================================
  // 7F-F2: real-format support (12-hour AM/PM dates at a property time zone,
  // combined Pax, full guest name), verified through the persistence path.
  // Fixtures are synthetic values in the evaluation file's column layout —
  // NOT the real evaluation data and NOT an official eZee mapping.
  // =========================================================
  const propK = trackCreated(
    await expectStatus("7FE.F2: Asia/Kolkata property create", "POST", "/properties", { workspaceId: wsA, name: "F2 Kolkata Property", code: "KF2" + stamp, timezone: "Asia/Kolkata" }, 201),
    "propertyIds",
  );
  trackCreated(await expectStatus("7FE.F2: unit 1A-R1 create", "POST", "/units", { workspaceId: wsA, propertyId: propK, unitNumber: "1A-R1", type: "room" }, 201), "unitIds");
  trackCreated(await expectStatus("7FE.F2: unit 1A-R2 create", "POST", "/units", { workspaceId: wsA, propertyId: propK, unitNumber: "1A-R2", type: "room" }, 201), "unitIds");
  // Guest No. (a contact number) is deliberately NOT in this profile: not an identity key, not a phone.
  const lookupByReservation = async (resId) => {
    await connectDatabase();
    const stay = await Stay.findOne({ workspaceId: wsA, reservationId: resId });
    const guest = stay ? await Guest.findOne({ _id: stay.guestId, workspaceId: wsA }) : null;
    await disconnectDatabase();
    return { stay, guest };
  };
  const F2_HEADERS = ["Res. No.", "Guest No.", "Guest", "Room No.", "Arrival", "Departure", "Pax", "Res. Type"];
  const F2_PROFILE = {
    "guest.fullName": "Guest",
    "stay.reservationId": "Res. No.",
    "stay.roomNumber": "Room No.",
    "stay.checkIn": "Arrival",
    "stay.checkOut": "Departure",
    "stay.adultsChildren": "Pax",
    "stay.status": "Res. Type",
  };
  const f2Fields = { workspaceId: wsA, propertyId: propK, mappingProfile: F2_PROFILE, dateFormat: "DD/MM/YYYY hh:mm A", statusMapping: { "Confirm Booking": "confirmed" } };
  const f2Csv = (rows) => buildCsv(rows, { headers: F2_HEADERS });
  const countUnits = async () => {
    await connectDatabase();
    const n = await Unit.countDocuments({ propertyId: propK });
    await disconnectDatabase();
    return n;
  };

  const unitsBefore = await countUnits();
  const f2Ok = await expectImportStatus(
    "7FE.F2: real-format rows (DD/MM/YYYY hh:mm A, Pax, full name, Confirm Booking) import",
    {
      fields: f2Fields,
      fileBytes: f2Csv([
        { "Res. No.": "F2R1-" + stamp, "Guest No.": "F2G1-" + stamp, Guest: "Mr. Test Alpha", "Room No.": "1A-R1", Arrival: "24/09/2026 12:00 PM", Departure: "27/09/2026 11:00 AM", Pax: "2/0", "Res. Type": "Confirm Booking" },
        { "Res. No.": "F2R2-" + stamp, "Guest No.": "F2G2-" + stamp, Guest: "Mrs. Test Beta Gamma", "Room No.": "1A-R2", Arrival: "01/10/2026 12:00 PM", Departure: "05/10/2026 11:00 AM", Pax: "3/1", "Res. Type": " confirm booking " },
      ]),
    },
    201,
  );
  trackImportBatch(f2Ok);
  if (f2Ok.json?.data?.rowsCreated === 2 && f2Ok.json?.data?.rowsFailed === 0) ok("7FE.F2: both real-format rows were created");
  else fail("7FE.F2: both real-format rows were created", JSON.stringify(f2Ok.json?.data));
  const f2a = await lookupByReservation("F2R1-" + stamp);
  const f2b = await lookupByReservation("F2R2-" + stamp);
  if (f2a.stay?.checkIn?.toISOString() === "2026-09-24T06:30:00.000Z" && f2a.stay?.checkOut?.toISOString() === "2026-09-27T05:30:00.000Z") {
    ok("7FE.F2: 12:00 PM / 11:00 AM at an Asia/Kolkata property are stored as 06:30Z / 05:30Z (wall-clock time preserved, not reinterpreted as UTC)");
  } else {
    fail("7FE.F2: property time zone applied to stored dates", JSON.stringify(f2a.stay));
  }
  if (f2b.stay?.checkOut?.toISOString() === "2026-10-05T05:30:00.000Z" && f2b.stay?.checkIn?.toISOString() === "2026-10-01T06:30:00.000Z") ok("7FE.F2: 01/10/2026 is read day-first (1 October)");
  else fail("7FE.F2: 01/10/2026 is read day-first", JSON.stringify(f2b.stay));
  if (f2a.guest?.firstName === "Test" && f2a.guest?.lastName === "Alpha" && f2b.guest?.firstName === "Test" && f2b.guest?.lastName === "Beta Gamma") {
    ok("7FE.F2: honorific stripped and name split into firstName/lastName");
  } else {
    fail("7FE.F2: honorific stripped and name split", JSON.stringify({ a: f2a.guest, b: f2b.guest }));
  }
  if (f2a.guest && f2a.guest.externalId === undefined && f2a.guest.phone === undefined && !JSON.stringify(f2a.guest).includes("F2G1-" + stamp)) {
    ok("7FE.F2: Guest No. is ignored - it is stored nowhere (not externalId, not phone, not metadata)");
  } else {
    fail("7FE.F2: Guest No. is ignored", JSON.stringify(f2a.guest));
  }
  if (f2a.stay && f2a.guest && String(f2a.stay.guestId) === String(f2a.guest._id)) ok("7FE.F2: guest identity comes through the reservation - Stay.guestId links the keyless Guest");
  else fail("7FE.F2: Stay.guestId links the keyless Guest", JSON.stringify({ stay: f2a.stay, guest: f2a.guest }));
  if (f2a.stay?.adults === 2 && f2a.stay?.children === 0 && f2b.stay?.adults === 3 && f2b.stay?.children === 1) ok("7FE.F2: Pax 2/0 and 3/1 stored as adults/children");
  else fail("7FE.F2: Pax stored as adults/children", JSON.stringify({ a: f2a.stay, b: f2b.stay }));
  if (f2a.stay?.status === "confirmed" && f2b.stay?.status === "confirmed") ok("7FE.F2: explicit statusMapping maps Confirm Booking (case/whitespace-insensitive) to confirmed");
  else fail("7FE.F2: explicit statusMapping applied", JSON.stringify({ a: f2a.stay?.status, b: f2b.stay?.status }));
  await connectDatabase();
  const unitA = await Unit.findOne({ propertyId: propK, unitNumber: "1A-R1" });
  await disconnectDatabase();
  if (unitA && String(f2a.stay?.unitId) === String(unitA._id) && String(f2a.stay?.propertyId) === String(propK)) ok("7FE.F2: Room No. resolves to the existing Unit of the import's Property");
  else fail("7FE.F2: Room No. resolves to the existing Unit", JSON.stringify(f2a.stay));

  // Row-level failures for the new formats (partial-import architecture)
  const f2Bad = await expectImportStatus(
    "7FE.F2: invalid Pax / dates / unknown Unit rows",
    {
      fields: f2Fields,
      fileBytes: f2Csv([
        { "Res. No.": "F2B1-" + stamp, "Guest No.": "F2GB1-" + stamp, Guest: "Mr. Bad One", "Room No.": "1A-R1", Arrival: "24/09/2026 12:00 PM", Departure: "27/09/2026 11:00 AM", Pax: "2-0", "Res. Type": "Confirm Booking" },
        { "Res. No.": "F2B2-" + stamp, "Guest No.": "F2GB2-" + stamp, Guest: "Mr. Bad Two", "Room No.": "1A-R1", Arrival: "24/09/2026 13:00 PM", Departure: "27/09/2026 11:00 AM", Pax: "2/0", "Res. Type": "Confirm Booking" },
        { "Res. No.": "F2B3-" + stamp, "Guest No.": "F2GB3-" + stamp, Guest: "Mr. Bad Three", "Room No.": "9Z-R9", Arrival: "24/09/2026 12:00 PM", Departure: "27/09/2026 11:00 AM", Pax: "2/0", "Res. Type": "Confirm Booking" },
        { "Res. No.": "F2B4-" + stamp, "Guest No.": "F2GB4-" + stamp, Guest: "Mr. Bad Four", "Room No.": "1A-R1", Arrival: "27/09/2026 12:00 PM", Departure: "27/09/2026 11:00 AM", Pax: "2/0", "Res. Type": "Confirm Booking" },
        { "Res. No.": "F2B5-" + stamp, "Guest No.": "F2GB5-" + stamp, Guest: "Mr. Bad Five", "Room No.": "1A-R1", Arrival: "24/09/2026 12:00 PM", Departure: "27/09/2026 11:00 AM", Pax: "2/0", "Res. Type": "Tentative" },
      ]),
    },
    201,
  );
  trackImportBatch(f2Bad);
  const f2BadMsgs = (f2Bad.json?.data?.errors || []).map((e) => e.message);
  if (f2Bad.json?.data?.rowsFailed === 5 && f2Bad.json?.data?.rowsCreated === 0) ok("7FE.F2: all 5 invalid new-format rows fail individually");
  else fail("7FE.F2: all 5 invalid new-format rows fail", JSON.stringify(f2Bad.json?.data));
  const has = (re) => f2BadMsgs.some((m) => re.test(m));
  if (has(/Invalid stay\.adultsChildren/) && has(/Invalid stay\.checkIn/) && has(/Unit not found/) && has(/checkOut must be after checkIn/) && has(/Unknown status/)) {
    ok("7FE.F2: errors identify malformed Pax, invalid 12-hour time, unknown Unit, inverted range, unknown status");
  } else {
    fail("7FE.F2: expected error messages present", JSON.stringify(f2BadMsgs));
  }
  const badStays = await lookupByReservation("F2B3-" + stamp);
  await connectDatabase();
  const badGuestCount = await Guest.countDocuments({ workspaceId: wsA, firstName: "Bad" });
  await disconnectDatabase();
  if (!badStays.stay && badGuestCount === 0) ok("7FE.F2: failed rows wrote neither Guest nor Stay (no orphan keyless Guests either)");
  else fail("7FE.F2: failed rows wrote neither Guest nor Stay", JSON.stringify({ stay: !!badStays.stay, badGuestCount }));
  const unitsAfter = await countUnits();
  if (unitsBefore === 2 && unitsAfter === 2) ok("7FE.F2: the importer never creates Units (still exactly the 2 pre-created, even with an unknown room)");
  else fail("7FE.F2: importer never creates Units", "before=" + unitsBefore + " after=" + unitsAfter);

  // blank full name / pax never erase; re-import updates in place
  const f2Blank = await expectImportStatus(
    "7FE.F2: re-import with blank name and blank Pax",
    { fields: f2Fields, fileBytes: f2Csv([{ "Res. No.": "F2R1-" + stamp, "Guest No.": "F2G1-" + stamp, Guest: "", "Room No.": "", Arrival: "", Departure: "", Pax: "", "Res. Type": "Confirm Booking" }]) },
    201,
  );
  trackImportBatch(f2Blank);
  const f2c = await lookupByReservation("F2R1-" + stamp);
  if (f2Blank.json?.data?.rowsUpdated === 1 && f2c.guest?.firstName === "Test" && f2c.guest?.lastName === "Alpha" && f2c.stay?.adults === 2 && f2c.stay?.children === 0 && String(f2c.stay?.checkIn) === String(f2a.stay?.checkIn)) {
    ok("7FE.F2: blank full name / Pax / dates / room retain existing values on re-import");
  } else {
    fail("7FE.F2: blank cells retain existing values", JSON.stringify({ data: f2Blank.json?.data, guest: f2c.guest, stay: f2c.stay }));
  }

  // profile-level rules (file-level 400s) and tenant/property isolation with the new formats
  const withProfile = (extra) => ({ ...f2Fields, mappingProfile: { ...F2_PROFILE, ...extra } });
  await expectImportStatus("7FE.F2: guest.fullName together with guest.firstName rejected", { fields: withProfile({ "guest.firstName": "Guest" }), fileBytes: f2Csv([]) }, 400);
  await expectImportStatus("7FE.F2: stay.adultsChildren together with stay.adults rejected", { fields: withProfile({ "stay.adults": "Pax" }), fileBytes: f2Csv([]) }, 400);
  await expectImportStatus("7FE.F2: stay.source (Business Source) is not an accepted target this phase", { fields: withProfile({ "stay.source": "Res. Type" }), fileBytes: f2Csv([]) }, 400);
  await expectImportStatus("7FE.F2: dateFormat using hh without A rejected", { fields: { ...f2Fields, dateFormat: "DD/MM/YYYY hh:mm" }, fileBytes: f2Csv([]) }, 400);
  await expectImportStatus("7FE.F2: propertyId from another workspace still rejected with the new formats", { fields: { ...f2Fields, propertyId: propB }, fileBytes: f2Csv([]) }, 404);
  await expectImportStatus("7FE.F2: unknown workspace still rejected with the new formats", { fields: { ...f2Fields, workspaceId: "64b64c4f2f1c2e0012345678" }, fileBytes: f2Csv([]) }, 404);
  const propBadTz = trackCreated(
    await expectStatus("7FE.F2: property with an invalid IANA time zone create", "POST", "/properties", { workspaceId: wsA, name: "F2 Bad TZ", code: "KF2X" + stamp, timezone: "Not/AZone" }, 201),
    "propertyIds",
  );
  await expectImportStatus("7FE.F2: import into a property with an invalid time zone is rejected at file level (never guessed as UTC)", { fields: { ...f2Fields, propertyId: propBadTz }, fileBytes: f2Csv([]) }, 400);

  // existing UTC behavior is unchanged for properties left at the default zone (see 7FE.S / 7FE.R tests above, all on a "UTC" property)
  const utcProp = await request("GET", "/properties/" + propA + "?workspaceId=" + wsA);
  if (utcProp.json?.data?.timezone === "UTC") ok("7FE.F2: the pre-existing tests ran against a default-UTC property, so their date expectations still prove unchanged UTC behavior");
  else fail("7FE.F2: baseline property is default UTC", JSON.stringify(utcProp.json?.data));

  // =========================================================
  // 7F-F2 option A: guest.externalId is OPTIONAL. Guest identity comes from
  // the reservation (Stay.guestId); Stay identity is still (workspace, reservationId).
  // =========================================================
  const ID_HEADERS = ["Res. No.", "First", "Last", "Room No.", "Arrival", "Departure", "Res. Type"];
  const ID_PROFILE = {
    "stay.reservationId": "Res. No.",
    "guest.firstName": "First",
    "guest.lastName": "Last",
    "stay.roomNumber": "Room No.",
    "stay.checkIn": "Arrival",
    "stay.checkOut": "Departure",
    "stay.status": "Res. Type",
  };
  const idFields = { workspaceId: wsA, propertyId: propK, mappingProfile: ID_PROFILE, dateFormat: "DD/MM/YYYY hh:mm A", statusMapping: { "Confirm Booking": "confirmed" } };
  const idRow = (resId, extra = {}) => ({ "Res. No.": resId, First: "Ida", Last: "Keyless", "Room No.": "1A-R1", Arrival: "10/11/2026 12:00 PM", Departure: "12/11/2026 11:00 AM", "Res. Type": "Confirm Booking", ...extra });
  const idCsv = (rows) => buildCsv(rows, { headers: ID_HEADERS });
  const guestsInWs = async (filter = {}) => {
    await connectDatabase();
    const n = await Guest.countDocuments({ workspaceId: wsA, ...filter });
    await disconnectDatabase();
    return n;
  };
  const idRes1 = "IDR1-" + stamp;

  const idFirst = await expectImportStatus("7FE.ID: new reservation with NO guest.externalId mapped imports", { fields: idFields, fileBytes: idCsv([idRow(idRes1)]) }, 201);
  trackImportBatch(idFirst);
  const idG0 = await guestsInWs({ firstName: "Ida" });
  const idS1 = await lookupByReservation(idRes1);
  if (idFirst.json?.data?.rowsCreated === 1 && idFirst.json?.data?.rowsFailed === 0 && idG0 === 1 && idS1.stay && idS1.guest && idS1.guest.externalId === undefined) {
    ok("7FE.ID: creates one Stay and one Guest that has no externalId, linked via Stay.guestId");
  } else {
    fail("7FE.ID: creates one keyless Guest + Stay", JSON.stringify({ data: idFirst.json?.data, guests: idG0, guest: idS1.guest }));
  }
  const idGuestId = String(idS1.guest?._id);

  const idAgain = await expectImportStatus("7FE.ID: re-import of the same reservation", { fields: idFields, fileBytes: idCsv([idRow(idRes1)]) }, 201);
  trackImportBatch(idAgain);
  const idS2 = await lookupByReservation(idRes1);
  if (idAgain.json?.data?.rowsUpdated === 1 && idAgain.json?.data?.rowsCreated === 0 && (await guestsInWs({ firstName: "Ida" })) === 1 && String(idS2.guest?._id) === idGuestId) {
    ok("7FE.ID: re-import updates in place - no duplicate Guest, same Guest id, same Stay");
  } else {
    fail("7FE.ID: re-import is idempotent without an externalId", JSON.stringify(idAgain.json?.data));
  }

  const idRename = await expectImportStatus("7FE.ID: re-import with a changed name and blank name fields elsewhere", { fields: idFields, fileBytes: idCsv([idRow(idRes1, { First: "Ida", Last: "Renamed" })]) }, 201);
  trackImportBatch(idRename);
  const idS3 = await lookupByReservation(idRes1);
  if (idS3.guest?.lastName === "Renamed" && String(idS3.guest?._id) === idGuestId && (await guestsInWs({ firstName: "Ida" })) === 1) ok("7FE.ID: changed guest fields update the reservation's linked Guest (still one Guest)");
  else fail("7FE.ID: changed guest fields update the linked Guest", JSON.stringify(idS3.guest));
  const idBlank = await expectImportStatus("7FE.ID: re-import with blank guest cells", { fields: idFields, fileBytes: idCsv([idRow(idRes1, { First: "", Last: "" })]) }, 201);
  trackImportBatch(idBlank);
  const idS4 = await lookupByReservation(idRes1);
  if (idBlank.json?.data?.rowsUpdated === 1 && idS4.guest?.firstName === "Ida" && idS4.guest?.lastName === "Renamed") ok("7FE.ID: blank guest cells never erase existing guest values (also without an externalId)");
  else fail("7FE.ID: blank cells retain guest values", JSON.stringify({ data: idBlank.json?.data, guest: idS4.guest }));

  // A second reservation for the same-looking person is a separate Guest (documented: no cross-reservation merge without a real identifier)
  const idRes2 = "IDR2-" + stamp;
  trackImportBatch(await expectImportStatus("7FE.ID: second reservation, same name", { fields: idFields, fileBytes: idCsv([idRow(idRes2, { "Room No.": "1A-R2" })]) }, 201));
  if ((await guestsInWs({ firstName: "Ida" })) === 2) ok("7FE.ID: identical names on two reservations stay two Guests (no fuzzy/name-based merging)");
  else fail("7FE.ID: identical names are not merged", String(await guestsInWs({ firstName: "Ida" })));

  // New reservation with nothing to describe the guest -> row error, nothing written
  const idNoDetail = await expectImportStatus("7FE.ID: new reservation with no guest details at all", { fields: idFields, fileBytes: idCsv([idRow("IDR3-" + stamp, { First: "", Last: "" })]) }, 201);
  trackImportBatch(idNoDetail);
  const idS5 = await lookupByReservation("IDR3-" + stamp);
  if (idNoDetail.json?.data?.rowsFailed === 1 && /Missing guest details/.test(idNoDetail.json?.data?.errors?.[0]?.message || "") && !idS5.stay) ok("7FE.ID: an empty keyless Guest is never created (row fails, no Stay)");
  else fail("7FE.ID: empty keyless Guest rejected", JSON.stringify(idNoDetail.json?.data));

  // Optional, not forbidden: a profile that DOES map an externalId still uses it; a blank cell falls back to the reservation
  const ID_PROFILE_KEYED = { ...ID_PROFILE, "guest.externalId": "Ref" };
  const keyedFields = { ...idFields, mappingProfile: ID_PROFILE_KEYED };
  const keyedRow = (resId, ref, extra = {}) => ({ ...idRow(resId, extra), Ref: ref });
  const keyedCsv = (rows) => buildCsv(rows, { headers: [...ID_HEADERS, "Ref"] });
  const idKeyed = await expectImportStatus("7FE.ID: profile that maps an externalId still uses it", { fields: keyedFields, fileBytes: keyedCsv([keyedRow("IDK1-" + stamp, "KEY-" + stamp, { First: "Kay", Last: "Keyed" })]) }, 201);
  trackImportBatch(idKeyed);
  const idK1 = await lookupByReservation("IDK1-" + stamp);
  if (idKeyed.json?.data?.rowsCreated === 1 && idK1.guest?.externalId === "KEY-" + stamp) ok("7FE.ID: a supplied externalId is still stored and is still the Guest's natural key");
  else fail("7FE.ID: supplied externalId still stored", JSON.stringify(idK1.guest));
  const idKeyedBlank = await expectImportStatus("7FE.ID: keyed profile, blank externalId cell on the existing reservation", { fields: keyedFields, fileBytes: keyedCsv([keyedRow("IDK1-" + stamp, "", { First: "Kay", Last: "Keyed2" })]) }, 201);
  trackImportBatch(idKeyedBlank);
  const idK2 = await lookupByReservation("IDK1-" + stamp);
  if (idKeyedBlank.json?.data?.rowsUpdated === 1 && String(idK2.guest?._id) === String(idK1.guest?._id) && idK2.guest?.externalId === "KEY-" + stamp && idK2.guest?.lastName === "Keyed2") ok("7FE.ID: blank externalId falls back to the reservation's linked Guest (which keeps its externalId)");
  else fail("7FE.ID: blank externalId falls back to the linked Guest", JSON.stringify({ data: idKeyedBlank.json?.data, guest: idK2.guest }));
  const idKeyedMismatch = await expectImportStatus("7FE.ID: existing reservation re-imported with a DIFFERENT externalId", { fields: keyedFields, fileBytes: keyedCsv([keyedRow("IDK1-" + stamp, "OTHER-" + stamp)]) }, 201);
  trackImportBatch(idKeyedMismatch);
  if (idKeyedMismatch.json?.data?.rowsFailed === 1 && /different guest/.test(idKeyedMismatch.json?.data?.errors?.[0]?.message || "")) ok("7FE.ID: Stay.guestId stays immutable - a conflicting externalId fails the row");
  else fail("7FE.ID: conflicting externalId fails the row", JSON.stringify(idKeyedMismatch.json?.data));
  if ((await guestsInWs({ externalId: "OTHER-" + stamp })) === 0) ok("7FE.ID: the conflicting row created no Guest");
  else fail("7FE.ID: the conflicting row created no Guest");

  // Property immutability still applies on the keyless path
  trackCreated(await expectStatus("7FE.ID: unit 1A-R1 on the other property (so the room resolves and the property check is what fires)", "POST", "/units", { workspaceId: wsA, propertyId: propA, unitNumber: "1A-R1", type: "room" }, 201), "unitIds");
  const idOtherProp = await expectImportStatus("7FE.ID: existing reservation imported under a different property", { fields: { ...idFields, propertyId: propA }, fileBytes: idCsv([idRow(idRes1)]) }, 201);
  trackImportBatch(idOtherProp);
  if (idOtherProp.json?.data?.rowsFailed === 1 && /different property/.test(idOtherProp.json?.data?.errors?.[0]?.message || "")) ok("7FE.ID: reservation identity still pins the Stay to its property");
  else fail("7FE.ID: property immutability on the keyless path", JSON.stringify(idOtherProp.json?.data));

  // Tenant isolation: the same reservationId in another workspace is a separate Stay + Guest; nothing crosses over
  const propBK = trackCreated(
    await expectStatus("7FE.ID: workspace B property (Kolkata)", "POST", "/properties", { workspaceId: wsB, name: "B ID Prop", code: "KIDB" + stamp, timezone: "Asia/Kolkata" }, 201),
    "propertyIds",
  );
  trackCreated(await expectStatus("7FE.ID: workspace B unit 1A-R1", "POST", "/units", { workspaceId: wsB, propertyId: propBK, unitNumber: "1A-R1", type: "room" }, 201), "unitIds");
  const idB = await expectImportStatus(
    "7FE.ID: same reservationId imported into workspace B",
    { fields: { ...idFields, workspaceId: wsB, propertyId: propBK }, fileBytes: idCsv([idRow(idRes1, { First: "Bee", Last: "Other" })]) },
    201,
  );
  trackImportBatch(idB);
  await connectDatabase();
  const bStay = await Stay.findOne({ workspaceId: wsB, reservationId: idRes1 });
  const bGuest = bStay ? await Guest.findOne({ _id: bStay.guestId, workspaceId: wsB }) : null;
  await disconnectDatabase();
  const idS6 = await lookupByReservation(idRes1);
  if (idB.json?.data?.rowsCreated === 1 && bStay && bGuest?.firstName === "Bee" && String(bStay._id) !== String(idS6.stay?._id) && idS6.guest?.firstName === "Ida" && idS6.guest?.lastName === "Renamed") {
    ok("7FE.ID: keyless identity is tenant-scoped - workspace B created its own Stay/Guest and workspace A's records are untouched");
  } else {
    fail("7FE.ID: tenant isolation on the keyless path", JSON.stringify({ data: idB.json?.data, a: idS6.guest }));
  }

  // Concurrent identical imports of a NEW keyless reservation: exactly one Stay, one Guest, no orphans, no 5xx
  let idRaceBad = null;
  for (let round = 1; round <= 5 && !idRaceBad; round += 1) {
    const raceRes = "IDRACE" + round + "-" + stamp;
    const raceCsv2 = idCsv([idRow(raceRes, { First: "Race" + round, Last: "Keyless", "Room No.": "1A-R2" })]);
    const results = await Promise.all([1, 2, 3, 4].map(() => uploadImport({ fields: idFields, fileBytes: raceCsv2 })));
    results.forEach((r) => trackImportBatch(r));
    const failedRows = results.reduce((n, r) => n + (r.json?.data?.rowsFailed || 0), 0);
    const guestCount = await guestsInWs({ firstName: "Race" + round });
    const found = await lookupByReservation(raceRes);
    await connectDatabase();
    const stayCount = await Stay.countDocuments({ workspaceId: wsA, reservationId: raceRes });
    await disconnectDatabase();
    if (!results.every((r) => r.status === 201) || failedRows !== 0 || guestCount !== 1 || stayCount !== 1 || !found.guest) {
      idRaceBad = { round, statuses: results.map((r) => r.status), failedRows, guestCount, stayCount, errors: results.map((r) => r.json?.data?.errors) };
    }
  }
  if (!idRaceBad) ok("7FE.ID: 5 rounds of 4 concurrent identical keyless imports - exactly one Guest and one Stay each, no orphan Guests");
  else fail("7FE.ID: concurrent keyless imports leave no orphans/duplicates", JSON.stringify(idRaceBad));

  // Stay save fails after the keyless Guest was saved -> the just-created Guest is removed; retry starts clean
  await connectDatabase();
  const realStaySave2 = Stay.prototype.save;
  let stayFailsLeft = 1;
  const idPw = "IDPW-" + stamp;
  Stay.prototype.save = function patchedKeylessSave(...args) {
    if (stayFailsLeft > 0 && this.reservationId === idPw) {
      stayFailsLeft -= 1;
      return Promise.reject(new Error("simulated stay save failure"));
    }
    return realStaySave2.apply(this, args);
  };
  const idPwInput = {
    workspaceId: wsA,
    propertyId: propK,
    filename: "keyless-partial-write.csv",
    buffer: Buffer.from(idCsv([idRow(idPw, { First: "Pw", Last: "Keyless" })])),
    mappingProfile: ID_PROFILE,
    dateFormat: "DD/MM/YYYY hh:mm A",
    statusMapping: { "Confirm Booking": "confirmed" },
  };
  let pwFirst;
  try {
    pwFirst = await importOperationalCsv(idPwInput);
  } finally {
    Stay.prototype.save = realStaySave2;
  }
  const pwGuestsMid = await Guest.countDocuments({ workspaceId: wsA, firstName: "Pw" });
  const pwStayMid = await Stay.countDocuments({ workspaceId: wsA, reservationId: idPw });
  const pwSecond = await importOperationalCsv(idPwInput);
  const pwGuestsEnd = await Guest.countDocuments({ workspaceId: wsA, firstName: "Pw" });
  const pwStayEnd = await Stay.countDocuments({ workspaceId: wsA, reservationId: idPw });
  await disconnectDatabase();
  if (pwFirst?.rowsFailed === 1 && pwGuestsMid === 0 && pwStayMid === 0) ok("7FE.ID: when the Stay save fails, the just-created keyless Guest is removed (no orphan)");
  else fail("7FE.ID: keyless Guest removed when Stay save fails", JSON.stringify({ pwFirst, pwGuestsMid, pwStayMid }));
  if (pwSecond?.rowsCreated === 1 && pwGuestsEnd === 1 && pwStayEnd === 1) ok("7FE.ID: retry after that failure is clean - exactly one Guest and one Stay");
  else fail("7FE.ID: clean retry", JSON.stringify({ pwSecond, pwGuestsEnd, pwStayEnd }));

  // =========================================================
  // 29: operational rows never create KnowledgeDocuments/KnowledgeChunks
  // =========================================================
  await connectDatabase();
  const knowledgeDocCount = await KnowledgeDocument.countDocuments({ workspaceId: wsA });
  const knowledgeChunkCountAfter = await KnowledgeChunk.countDocuments({});
  await disconnectDatabase();
  if (knowledgeDocCount === 0) ok("7FE.29: no KnowledgeDocument was created by any operational import in this suite");
  else fail("7FE.29: no KnowledgeDocument was created by any operational import", `count=${knowledgeDocCount}`);
  if (knowledgeChunkCountAfter === knowledgeChunkCountBefore) {
    ok("7FE.29b: no KnowledgeChunk was created as a side effect of operational import (before/after delta, tolerant of pre-existing real chunk data)");
  } else {
    fail("7FE.29b: no KnowledgeChunk was created as a side effect of operational import", `before=${knowledgeChunkCountBefore} after=${knowledgeChunkCountAfter}`);
  }

  // =========================================================
  // 30: real development workspace remains isolated from test data
  // =========================================================
  await connectDatabase();
  const outsideAfter = await outsideFingerprint(created.workspaceIds);
  await disconnectDatabase();
  const addedOutside = outsideAfter.filter((row) => !outsideBefore.includes(row));
  const removedOrChangedOutside = outsideBefore.filter((row) => !outsideAfter.includes(row));
  if (addedOutside.length === 0) {
    ok("7FE.30: no ImportBatch/Guest/Stay/Property/Workspace was created or modified outside this suite's own stamped test workspaces (baseline comparison, tolerant of real data)");
  } else {
    fail("7FE.30: nothing created or modified outside the test workspaces", JSON.stringify(addedOutside.slice(0, 5)));
  }
  if (removedOrChangedOutside.length === 0) {
    ok("7FE.30b: every pre-existing document (incl. any real imported data) is present and unmodified - none deleted");
  } else {
    fail("7FE.30b: pre-existing documents deleted or modified", JSON.stringify(removedOrChangedOutside.slice(0, 5)));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error("Fatal error running validate-import.mjs:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
  });
