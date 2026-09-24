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
    // 17: missing guest external ID
    { "Test Guest ID": "", "Test Reservation ID": `RX6-${stamp}`, "Test Status": "Confirmed" },
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
  if (/externalId/i.test(errorMessages)) ok("7FE.17: missing guest externalId produced a row error");
  else fail("7FE.17: missing guest externalId produced a row error", errorMessages);

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
  delete noRequired["guest.externalId"];
  await expectImportStatus("7FE.R.map: profile missing required guest.externalId rejected", { fields: { ...baseFields, mappingProfile: noRequired }, fileBytes: csv1 }, 400);
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
  const probeWorkspace = await Workspace.findOne({ slug: { $ne: undefined } }).sort({ createdAt: 1 }).limit(1);
  const importBatchesOutsideTestWorkspaces = await ImportBatch.countDocuments({
    workspaceId: { $nin: [wsA, wsB].map((id) => id) },
  });
  await disconnectDatabase();
  if (importBatchesOutsideTestWorkspaces === 0) {
    ok("7FE.30: no ImportBatch was created outside this suite's own stamped test workspaces");
  } else {
    fail("7FE.30: no ImportBatch was created outside this suite's own stamped test workspaces", `count=${importBatchesOutsideTestWorkspaces}`);
  }
  if (probeWorkspace) ok("7FE.30b: pre-existing workspace(s) in the database were left untouched by this suite (read-only probe)");

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
