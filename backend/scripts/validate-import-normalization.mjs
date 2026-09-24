/**
 * Phase 7F-F2 validation: pure row-normalization behavior of the CSV
 * importer — dates (incl. 12-hour AM/PM and property time zones), Pax,
 * guest names, status mapping, mapping-profile conflicts, and the pure
 * dry-run helper (previewCsv).
 *
 * No server, no MongoDB, no files outside the repo: everything here runs
 * in-process on synthetic fixtures. (Persistence-backed behavior of the same
 * features is covered in validate-import.mjs.)
 */
import {
  assertNoDuplicateHeaders,
  buildDateParser,
  mapRow,
  resolveStatus,
  validateMappingProfile,
  validateStatusMapping,
} from "../src/services/import/columnMapping.js";
import { RowError, assertNewStayComplete, normalizeRow, previewCsv, splitAdultsChildren, splitFullName } from "../src/services/import/rowNormalizer.js";

let passed = 0;
let failed = 0;
const ok = (name) => { passed += 1; console.log(`PASS  ${name}`); };
const fail = (name, detail = "") => { failed += 1; console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`); };
const eq = (name, actual, expected) =>
  JSON.stringify(actual) === JSON.stringify(expected) ? ok(name) : fail(name, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
function throwsWith(name, fn, ErrorType, pattern) {
  try {
    fn();
    fail(name, "did not throw");
  } catch (error) {
    if (error instanceof ErrorType && pattern.test(error.message)) ok(name);
    else fail(name, `threw ${error?.constructor?.name}: ${error?.message}`);
  }
}
const iso = (d) => (d ? d.toISOString() : null);

// ---------------- dates ----------------
const kolkata = buildDateParser("DD/MM/YYYY hh:mm A", "Asia/Kolkata");
eq("date: 24/09/2026 12:00 PM (Asia/Kolkata) -> 12:00 IST = 06:30Z", iso(kolkata("24/09/2026 12:00 PM")), "2026-09-24T06:30:00.000Z");
eq("date: 27/09/2026 11:00 AM (Asia/Kolkata) -> 11:00 IST = 05:30Z", iso(kolkata("27/09/2026 11:00 AM")), "2026-09-27T05:30:00.000Z");
eq("date: 01/10/2026 11:00 AM is 1 October (day-first), 05:30Z", iso(kolkata("01/10/2026 11:00 AM")), "2026-10-01T05:30:00.000Z");
eq("date: 12:00 AM is midnight (previous UTC day in IST)", iso(kolkata("24/09/2026 12:00 AM")), "2026-09-23T18:30:00.000Z");
eq("date: 01:05 PM is 13:05 IST", iso(kolkata("24/09/2026 01:05 PM")), "2026-09-24T07:35:00.000Z");
eq("date: lower-case am/pm accepted", iso(kolkata("24/09/2026 11:00 am")), "2026-09-24T05:30:00.000Z");
eq("date: surrounding whitespace tolerated", iso(kolkata("  24/09/2026 12:00 PM  ")), "2026-09-24T06:30:00.000Z");
for (const bad of ["24/09/2026 13:00 PM", "24/09/2026 00:30 AM", "24/09/2026 12:60 PM", "31/02/2026 11:00 AM", "32/09/2026 11:00 AM", "24/13/2026 11:00 AM", "24/09/2026 12:00", "24/09/2026 12:00 XM", "2026-09-24 12:00 PM", "24/09/26 12:00 PM", "", "not a date"]) {
  eq(`date: invalid ${JSON.stringify(bad)} -> null`, kolkata(bad), null);
}
const utcSame = buildDateParser("DD/MM/YYYY hh:mm A");
eq("date: default time zone is UTC (wall-clock == instant)", iso(utcSame("24/09/2026 12:00 PM")), "2026-09-24T12:00:00.000Z");
eq("date: existing YYYY-MM-DD unchanged (UTC)", iso(buildDateParser("YYYY-MM-DD")("2026-04-01")), "2026-04-01T00:00:00.000Z");
eq("date: existing DD/MM/YYYY unchanged (UTC)", iso(buildDateParser("DD/MM/YYYY")("24/09/2026")), "2026-09-24T00:00:00.000Z");
eq("date: existing 24-hour HH:mm unchanged (UTC)", iso(buildDateParser("YYYY-MM-DD HH:mm")("2026-04-01 13:45")), "2026-04-01T13:45:00.000Z");
eq("date: existing 24-hour HH:mm:ss unchanged (UTC)", iso(buildDateParser("MM-DD-YYYY HH:mm:ss")("04-01-2026 23:59:58")), "2026-04-01T23:59:58.000Z");
eq("date: date-only format at a Kolkata property is local midnight", iso(buildDateParser("DD/MM/YYYY", "Asia/Kolkata")("24/09/2026")), "2026-09-23T18:30:00.000Z");
eq("date: DST zone resolves offset at the converted instant (New York summer)", iso(buildDateParser("YYYY-MM-DD HH:mm", "America/New_York")("2026-07-01 12:00")), "2026-07-01T16:00:00.000Z");
eq("date: DST zone resolves offset at the converted instant (New York winter)", iso(buildDateParser("YYYY-MM-DD HH:mm", "America/New_York")("2026-01-01 12:00")), "2026-01-01T17:00:00.000Z");
throwsWith("date: hh without A rejected", () => buildDateParser("DD/MM/YYYY hh:mm"), Error, /together with "A"/);
throwsWith("date: A without hh rejected", () => buildDateParser("DD/MM/YYYY HH:mm A"), Error, /together with "A"/);
throwsWith("date: mixing HH and hh rejected", () => buildDateParser("DD/MM/YYYY HH:mm hh A"), Error, /cannot mix/);
throwsWith("date: format missing DD rejected", () => buildDateParser("MM/YYYY hh:mm A"), Error, /must include YYYY, MM, and DD/);
throwsWith("date: duplicate tokens rejected", () => buildDateParser("DD/DD/YYYY MM"), Error, /duplicate tokens/);
throwsWith("date: invalid IANA time zone rejected", () => buildDateParser("DD/MM/YYYY", "Not/AZone"), Error, /not a valid IANA time zone/);
throwsWith("date: missing format rejected", () => buildDateParser(""), Error, /dateFormat is required/);

// ---------------- Pax ----------------
eq("pax: 2/0 -> 2 adults, 0 children", splitAdultsChildren("2/0"), { adults: 2, children: 0 });
eq("pax: 1/2", splitAdultsChildren("1/2"), { adults: 1, children: 2 });
eq("pax: 10/3", splitAdultsChildren("10/3"), { adults: 10, children: 3 });
eq("pax: whitespace around parts tolerated", splitAdultsChildren(" 2 / 1 "), { adults: 2, children: 1 });
for (const bad of ["2", "2/", "/0", "2-0", "2/0/1", "a/b", "2/x", "-1/0", "2/-1", "2.5/0", "2/0.5", "", "20000/0", "2 0"]) {
  throwsWith(`pax: malformed ${JSON.stringify(bad)} rejected`, () => splitAdultsChildren(bad), RowError, /Invalid stay\.adultsChildren value/);
}
{
  const row = (extra) => ({ "stay.reservationId": "R1", "guest.externalId": "G1", ...extra });
  const ctx = { parseDate: buildDateParser("YYYY-MM-DD"), statusMapping: validateStatusMapping({ Confirmed: "confirmed" }) };
  const n = normalizeRow(row({ "stay.adultsChildren": "2/0" }), ctx);
  eq("pax: normalizeRow applies stay.adultsChildren", [n.adults, n.children], [2, 0]);
  const sep = normalizeRow(row({ "stay.adults": "3", "stay.children": "1" }), ctx);
  eq("pax: separate numeric adults/children columns still work", [sep.adults, sep.children], [3, 1]);
  const none = normalizeRow(row({}), ctx);
  eq("pax: absent pax leaves adults/children undefined (schema defaults / retention apply)", [none.adults, none.children], [undefined, undefined]);
  const blank = normalizeRow(row({ "stay.adultsChildren": "" }), ctx);
  eq("pax: blank cell leaves adults/children undefined (blank-cell retention)", [blank.adults, blank.children], [undefined, undefined]);
  throwsWith("pax: separate columns still reject non-numeric adults", () => normalizeRow(row({ "stay.adults": "two" }), ctx), RowError, /Invalid stay\.adults value/);
  throwsWith("pax: separate columns still reject negative children", () => normalizeRow(row({ "stay.children": "-1" }), ctx), RowError, /Invalid stay\.children value/);
  throwsWith("pax: separate columns still reject decimals", () => normalizeRow(row({ "stay.adults": "1.5" }), ctx), RowError, /Invalid stay\.adults value/);
}

// ---------------- guest names ----------------
eq("name: Mr. Alpha Testone", splitFullName("Mr. Alpha Testone"), { firstName: "Alpha", lastName: "Testone" });
eq("name: Ms. Beta Testtwo", splitFullName("Ms. Beta Testtwo"), { firstName: "Beta", lastName: "Testtwo" });
eq("name: Mrs. Gamma Testthree", splitFullName("Mrs. Gamma Testthree"), { firstName: "Gamma", lastName: "Testthree" });
eq("name: honorific without period", splitFullName("Mr Alpha Testone"), { firstName: "Alpha", lastName: "Testone" });
eq("name: honorific case-insensitive", splitFullName("MRS. lakshmi devi"), { firstName: "lakshmi", lastName: "devi" });
eq("name: no honorific is split the same way", splitFullName("Alpha Testone"), { firstName: "Alpha", lastName: "Testone" });
eq("name: single token -> firstName only", splitFullName("Alpha"), { firstName: "Alpha" });
eq("name: honorific + single token -> firstName only", splitFullName("Mr. Alpha"), { firstName: "Alpha" });
eq("name: three tokens -> first token / rest (deterministic, no inference)", splitFullName("Mr. Delta Testfour Testfive"), { firstName: "Delta", lastName: "Testfour Testfive" });
eq("name: extra whitespace collapsed", splitFullName("  Ms.   Beta    Testtwo  "), { firstName: "Beta", lastName: "Testtwo" });
eq("name: only ONE leading honorific is stripped", splitFullName("Mr. Mr. Alpha"), { firstName: "Mr.", lastName: "Alpha" });
eq("name: an honorific-like token in the middle is kept", splitFullName("Alpha Mr. Testone"), { firstName: "Alpha", lastName: "Mr. Testone" });
eq("name: unlisted title (Dr.) is not treated as an honorific", splitFullName("Dr. Alpha Testone"), { firstName: "Dr.", lastName: "Alpha Testone" });
throwsWith("name: honorific only is invalid", () => splitFullName("Mr."), RowError, /Invalid guest\.fullName value/);
{
  const ctx = { parseDate: buildDateParser("YYYY-MM-DD"), statusMapping: validateStatusMapping({ Confirmed: "confirmed" }) };
  const base = { "stay.reservationId": "R1", "guest.externalId": "G1" };
  eq("name: normalizeRow maps guest.fullName to firstName/lastName", normalizeRow({ ...base, "guest.fullName": "Mr. Alpha Testone" }, ctx).guest, { firstName: "Alpha", lastName: "Testone" });
  eq("name: existing separate firstName/lastName columns still work", normalizeRow({ ...base, "guest.firstName": "Jane", "guest.lastName": "Roe" }, ctx).guest, { firstName: "Jane", lastName: "Roe" });
  eq("name: existing email/phone columns still work and phone is NOT derived from anything else", normalizeRow({ ...base, "guest.email": "a@b.example" }, ctx).guest, { email: "a@b.example" });
  eq("name: blank fullName contributes nothing (blank-cell retention)", normalizeRow({ ...base, "guest.fullName": "" }, ctx).guest, {});
  {
    const noKey = normalizeRow({ "stay.reservationId": "R1", "guest.fullName": "Mr. Alpha Testone" }, ctx);
    eq("identity: a row with no guest.externalId mapped is valid (externalId undefined)", [noKey.externalId, noKey.guest], [undefined, { firstName: "Alpha", lastName: "Testone" }]);
    eq("identity: a blank guest.externalId cell is treated as absent, not an error", normalizeRow({ ...base, "guest.externalId": "" }, ctx).externalId, undefined);
    eq("identity: a present guest.externalId is passed through unchanged", normalizeRow({ ...base, "guest.externalId": "EXT-1" }, ctx).externalId, "EXT-1");
    throwsWith("identity: stay.reservationId is still required per row", () => normalizeRow({ "stay.reservationId": "", "guest.fullName": "Mr. A B" }, ctx), RowError, /Missing required stay\.reservationId/);
  }
  eq("guest externalId is never copied into phone", normalizeRow({ ...base, "guest.externalId": "1000000001" }, ctx).guest.phone, undefined);
}

// ---------------- status mapping ----------------
{
  const map = validateStatusMapping({ "Confirm Booking": "confirmed" });
  eq('status: "Confirm Booking" -> confirmed', resolveStatus(map, "Confirm Booking"), "confirmed");
  eq("status: case-insensitive", resolveStatus(map, "CONFIRM BOOKING"), "confirmed");
  eq("status: surrounding whitespace ignored", resolveStatus(map, "  Confirm Booking  "), "confirmed");
  eq("status: unmapped value -> undefined (never defaulted)", resolveStatus(map, "Tentative"), undefined);
  eq("status: blank -> undefined", resolveStatus(map, ""), undefined);
  eq("status: prototype-chain text -> undefined", resolveStatus(map, "constructor"), undefined);
  throwsWith("status: non-enum target rejected", () => validateStatusMapping({ "Confirm Booking": "confirm_booking" }), Error, /not a valid stay status/);
  throwsWith("status: 'reserved' is only used if explicitly mapped (empty mapping rejected)", () => validateStatusMapping({}), Error, /non-empty object/);
  const ctx = { parseDate: buildDateParser("YYYY-MM-DD"), statusMapping: map };
  eq("status: normalizeRow maps Confirm Booking", normalizeRow({ "stay.reservationId": "R1", "guest.externalId": "G1", "stay.status": " confirm booking " }, ctx).status, "confirmed");
  throwsWith("status: unknown value is a row error", () => normalizeRow({ "stay.reservationId": "R1", "guest.externalId": "G1", "stay.status": "Tentative" }, ctx), RowError, /Unknown status value/);
}

// ---------------- mapping-profile rules ----------------
{
  const header = ["Res. No.", "Guest Ref", "Guest", "First", "Pax", "Adults", "Room No."];
  const base = { "stay.reservationId": "Res. No." };
  eq("mapping: reservationId alone is a valid profile (guest.externalId is optional)", Object.keys(validateMappingProfile(base, header)), ["stay.reservationId"]);
  eq("mapping: guest.externalId is still accepted when a profile chooses to supply one", Object.keys(validateMappingProfile({ ...base, "guest.externalId": "Guest Ref" }, header)).sort(), ["guest.externalId", "stay.reservationId"]);
  throwsWith("mapping: stay.reservationId is still required", () => validateMappingProfile({ "guest.fullName": "Guest" }, header), Error, /must map "stay\.reservationId"/);
  throwsWith("mapping: a profile with only guest.externalId (no reservationId) is rejected", () => validateMappingProfile({ "guest.externalId": "Guest Ref" }, header), Error, /must map "stay\.reservationId"/);
  eq("mapping: new guest.fullName / stay.adultsChildren targets accepted", Object.keys(validateMappingProfile({ ...base, "guest.fullName": "Guest", "stay.adultsChildren": "Pax" }, header)).sort(), ["guest.fullName", "stay.adultsChildren", "stay.reservationId"]);
  throwsWith("mapping: fullName together with firstName rejected", () => validateMappingProfile({ ...base, "guest.fullName": "Guest", "guest.firstName": "First" }, header), Error, /cannot map "guest\.fullName" together/);
  throwsWith("mapping: adultsChildren together with adults rejected", () => validateMappingProfile({ ...base, "stay.adultsChildren": "Pax", "stay.adults": "Adults" }, header), Error, /cannot map "stay\.adultsChildren" together/);
  throwsWith("mapping: unknown target still rejected", () => validateMappingProfile({ ...base, "stay.rate": "Pax" }, header), Error, /unknown target field/);
  throwsWith("mapping: Business Source style target (stay.source) is not accepted in this phase", () => validateMappingProfile({ ...base, "stay.source": "Pax" }, header), Error, /unknown target field/);
  eq("mapping: no column name is hard-coded — any header can carry Pax", Object.keys(validateMappingProfile({ ...base, "stay.adultsChildren": "Guest" }, header)).includes("stay.adultsChildren"), true);
  eq("mapping: separate adults/children targets still accepted", Object.keys(validateMappingProfile({ ...base, "stay.adults": "Adults" }, header)).includes("stay.adults"), true);
  throwsWith("mapping: duplicate headers still rejected", () => assertNoDuplicateHeaders(["A", "a "]), Error, /duplicate column header/);
  eq("mapping: mapRow reads only own string cells", mapRow(Object.assign(Object.create(null), { "Res. No.": " R1 " }), { "stay.reservationId": "Res. No." }), { "stay.reservationId": "R1" });
}

// ---------------- new-stay completeness ----------------
{
  const full = { status: "confirmed", roomNumber: "1A-R1", checkIn: new Date(), checkOut: new Date() };
  eq("new stay: complete row passes", (() => { assertNewStayComplete(full); return true; })(), true);
  for (const missing of ["status", "roomNumber", "checkIn", "checkOut"]) {
    throwsWith(`new stay: missing ${missing} rejected`, () => assertNewStayComplete({ ...full, [missing]: undefined }), RowError, new RegExp(`Missing required stay\\.${missing}`));
  }
}

// ---------------- previewCsv (pure dry run) ----------------
{
  const csv =
    "﻿Res. No.,Guest No.,Guest,Room No.,Arrival,Departure,Pax,Res. Type,Extra\r\n" +
    "S-1,1000000001,Mr. Test Alpha,1A-R1,24/09/2026 12:00 PM,27/09/2026 11:00 AM,2/0,Confirm Booking,x\r\n" +
    "S-2,1000000002,Ms. Test Beta,1A-R2,24/09/2026 12:00 PM,26/09/2026 11:00 AM,1/1,confirm booking,y\r\n" +
    "S-3,1000000003,Mrs. Test Gamma,1A-R3,26/09/2026 12:00 PM,24/09/2026 11:00 AM,2/0,Confirm Booking,z\r\n" +
    "S-4,1000000004,Mr. Test Delta,1A-R1,24/09/2026 12:00 PM,27/09/2026 11:00 AM,two,Confirm Booking,z\r\n" +
    "S-5,1000000005,Mr. Test Eps,1A-R1,24/09/2026 12:00 PM,27/09/2026 11:00 AM,2/0,Tentative,z\r\n" +
    "S-1,1000000001,Mr. Test Alpha,1A-R1,24/09/2026 12:00 PM,27/09/2026 11:00 AM,2/0,Confirm Booking,dup\r\n" +
    "S-6,1000000006,,1A-R1,24/09/2026 12:00 PM,27/09/2026 11:00 AM,2/0,Confirm Booking,nameless\r\n" +
    ",,,,,,,,\r\n";
  const config = {
    buffer: Buffer.from(csv),
    mappingProfile: { "guest.fullName": "Guest", "stay.reservationId": "Res. No.", "stay.roomNumber": "Room No.", "stay.checkIn": "Arrival", "stay.checkOut": "Departure", "stay.adultsChildren": "Pax", "stay.status": "Res. Type" },
    dateFormat: "DD/MM/YYYY hh:mm A",
    statusMapping: { "Confirm Booking": "confirmed" },
    timeZone: "Asia/Kolkata",
  };
  const r = previewCsv(config);
  eq("preview: rows examined (BOM + CRLF handled)", r.rowsExamined, 8);
  eq("preview: valid rows (S-1, S-2, duplicate S-1)", r.rowsValid, 3);
  eq("preview: invalid rows (inverted range, bad pax, unknown status, nameless keyless guest, blank)", r.rowsInvalid, 5);
  eq("preview: first payload is fully normalized", r.rows[0].payload, { reservationId: "S-1", guestExternalId: null, guest: { firstName: "Test", lastName: "Alpha" }, roomNumber: "1A-R1", checkIn: "2026-09-24T06:30:00.000Z", checkOut: "2026-09-27T05:30:00.000Z", status: "confirmed", adults: 2, children: 0 });
  eq("preview: second payload pax and status", [r.rows[1].payload.adults, r.rows[1].payload.children, r.rows[1].payload.status], [1, 1, "confirmed"]);
  eq("preview: inverted range reported", r.rows[2].error, "checkOut must be after checkIn");
  eq("preview: bad pax reported", r.rows[3].error, "Invalid stay.adultsChildren value");
  eq("preview: unknown status reported", r.rows[4].error.startsWith("Unknown status value"), true);
  eq("preview: duplicate reservationId is a warning", r.warnings.length, 1);
  eq("preview: Guest No. is intentionally unmapped and reported as unresolved (never used as identity or phone)", r.unresolvedColumns, ["Guest No.", "Extra"]);
  eq("preview: no payload carries a guest identifier or phone derived from Guest No.", r.rows.filter((x) => x.valid).every((x) => x.payload.guestExternalId === null && x.payload.guest.phone === undefined), true);
  eq("preview: a new reservation with no guest details and no externalId is invalid", r.rows[6].error, "Missing guest details for a new reservation without guest.externalId");
  throwsWith("preview: mapping to a missing column is a file-level error", () => previewCsv({ ...config, mappingProfile: { ...config.mappingProfile, "stay.status": "No Such" } }), Error, /not found in the CSV header/);
  throwsWith("preview: duplicate header is a file-level error", () => previewCsv({ ...config, buffer: Buffer.from("A,a\n1,2\n"), mappingProfile: { "stay.reservationId": "a" } }), Error, /duplicate column header/);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
