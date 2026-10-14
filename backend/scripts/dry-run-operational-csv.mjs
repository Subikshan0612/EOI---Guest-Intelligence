/**
 * Phase 7F-F2 — dry-run a real operational CSV through the importer's pure
 * transformation (previewCsv). Reads the file, applies a mapping, and prints
 * what each row WOULD become. Never calls the persistence/import function and
 * never writes anything: no Guest, no Stay, no ImportBatch.
 *
 * THE MAPPING BELOW IS A CANDIDATE, not an approved or official eZee mapping.
 * It reflects the 7F-F1 inspection of kolam_gandhi_dummy_guests.csv and the
 * 7F-F2 decisions ("Guest No." is a contact number and is intentionally NOT
 * mapped — not to externalId, not to phone; guest identity comes from the
 * reservation; "Confirm Booking" -> confirmed; Pax read as adults/children).
 * Columns with no importer target are reported as unresolved on purpose.
 *
 * Usage:
 *   node scripts/dry-run-operational-csv.mjs [path-to.csv]
 *   node scripts/dry-run-operational-csv.mjs [path-to.csv] --check-units
 * --check-units performs READ-ONLY lookups (find) to report whether each
 * room number matches an existing Unit of the Kolam Gandhi property.
 */
import { requireLoopbackDatabase } from "../src/config/mongoSafety.js";
requireLoopbackDatabase("dry-run-operational-csv"); // never silently operate on a remote database (see src/config/mongoSafety.js)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { previewCsv } from "../src/services/import/rowNormalizer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILE = path.join(__dirname, "..", "..", "data", "Operational data", "kolam_gandhi_dummy_guests.csv");
const file = process.argv.slice(2).find((arg) => !arg.startsWith("--")) || DEFAULT_FILE;
const CHECK_UNITS = process.argv.includes("--check-units");

const CANDIDATE_CONFIG = {
  mappingProfile: {
    "guest.fullName": "Guest",
    "stay.reservationId": "Res. No.",
    "stay.roomNumber": "Room No.",
    "stay.checkIn": "Arrival",
    "stay.checkOut": "Departure",
    "stay.adultsChildren": "Pax",
    "stay.status": "Res. Type",
  },
  dateFormat: "DD/MM/YYYY hh:mm A",
  statusMapping: { "Confirm Booking": "confirmed" },
};
const TIME_ZONE = "Asia/Kolkata"; // the Kolam Gandhi – Adyar property's zone

const buffer = fs.readFileSync(file);
const report = previewCsv({ buffer, ...CANDIDATE_CONFIG, timeZone: TIME_ZONE });

console.log(`file: ${file}`);
console.log(`mode: DRY RUN — pure transformation, nothing persisted`);
console.log(`time zone applied: ${TIME_ZONE}`);
console.log(`rows examined: ${report.rowsExamined} | valid: ${report.rowsValid} | invalid: ${report.rowsInvalid}`);
console.log(`mapped columns: ${JSON.stringify(report.mappedColumns)}`);
console.log(`unresolved (no importer target, intentionally not imported): ${JSON.stringify(report.unresolvedColumns)}`);
console.log(`warnings: ${JSON.stringify(report.warnings)}`);

let unitNumbers = null;
if (CHECK_UNITS) {
  const { connectDatabase, disconnectDatabase } = await import("../src/config/database.js");
  const { Property, Unit, Workspace } = await import("../src/models/index.js");
  await connectDatabase();
  const workspace = await Workspace.findOne({ slug: process.env.KOI_DEV_WORKSPACE_SLUG || "dev-workspace" });
  const property = workspace && (await Property.findOne({ workspaceId: workspace._id, code: "KG01" }));
  unitNumbers = property ? new Set((await Unit.find({ propertyId: property._id }).select("unitNumber")).map((u) => u.unitNumber)) : new Set();
  console.log(`unit check (read-only): property KG01 ${property ? `found, timezone=${property.timezone}, ${unitNumbers.size} units` : "NOT FOUND"}`);
  await disconnectDatabase();
}

console.log("\nrow | reservationId | guest (first / last) | guest identity | room | checkIn (UTC) | checkOut (UTC) | adults/children | status" + (CHECK_UNITS ? " | unit exists" : ""));
for (const r of report.rows) {
  if (!r.valid) {
    console.log(`${r.row} | INVALID: ${r.error}`);
    continue;
  }
  const p = r.payload;
  console.log(
    `${r.row} | ${p.reservationId} | ${p.guest.firstName ?? ""} / ${p.guest.lastName ?? ""} | ${p.guestExternalId ?? "from reservation (no externalId)"} | ${p.roomNumber} | ${p.checkIn} | ${p.checkOut} | ${p.adults}/${p.children} | ${p.status}` +
      (CHECK_UNITS ? ` | ${unitNumbers.has(p.roomNumber) ? "yes" : "NO"}` : ""),
  );
}
const failures = report.rows.filter((r) => !r.valid).length;
console.log(`\nresult: ${failures === 0 ? "ALL ROWS VALID" : `${failures} INVALID ROW(S)`}`);
if (failures > 0) process.exitCode = 1;
