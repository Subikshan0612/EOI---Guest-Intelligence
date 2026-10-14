/**
 * Phase 7F-F2 — prepare the Kolam Gandhi – Adyar evaluation Property and its
 * 18 Units (idempotent, create-only).
 *
 * Follows the convention of create-dev-workspace.mjs (idempotent script, never
 * deletes) and creates records through the existing createProperty /
 * createUnit services — the same validation, unique indexes and tenant checks
 * the REST API uses. Nothing here touches Guests, Stays, ImportBatches,
 * Knowledge documents, or any other Property (Kerala Residency is left alone).
 *
 * Structure source: Kolam_Gandhi_SOP.docx §3 — 3 floors x 2 apartments
 * (1A 1B 2A 2B 3A 3B) x 3 rooms (R1 King, R2 Queen, R3 Twin) = 18 rooms.
 * Unit numbers follow "<apartment>-<room>" (e.g. 1A-R1). Bed types are NOT
 * stored (no supported Unit field; the source reservation file calls R1
 * "Master" while the SOP says King — that naming decision is left open).
 *
 * Property code KG01 is a PLACEHOLDER chosen only because Property.code is
 * required and unique; it follows the existing KR01 (Kerala Residency)
 * pattern. It is not a confirmed business code.
 *
 * Usage (dry run by default — prints the plan, writes nothing):
 *   node scripts/seed-kolam-gandhi-property.mjs
 *   node scripts/seed-kolam-gandhi-property.mjs --apply
 * The target workspace must already exist (KOI_DEV_WORKSPACE_SLUG, default
 * "dev-workspace"); this script never creates one.
 */
import { requireLoopbackDatabase } from "../src/config/mongoSafety.js";
requireLoopbackDatabase("seed-kolam-gandhi-property"); // never silently operate on a remote database (see src/config/mongoSafety.js)
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { Property, Unit, Workspace } from "../src/models/index.js";
import { createProperty } from "../src/services/propertyService.js";
import { createUnit } from "../src/services/unitService.js";

const APPLY = process.argv.includes("--apply");
const WORKSPACE_SLUG = process.env.KOI_DEV_WORKSPACE_SLUG || "dev-workspace";

const PROPERTY = { name: "Kolam Gandhi – Adyar", code: "KG01", timezone: "Asia/Kolkata" };
const UNIT_TYPE = "room"; // each R1/R2/R3 is one room of a 3BHK apartment
const UNIT_NUMBERS = ["1A", "1B", "2A", "2B", "3A", "3B"].flatMap((apartment) =>
  ["R1", "R2", "R3"].map((room) => `${apartment}-${room}`),
);

async function main() {
  await connectDatabase();
  console.error(`[seed-kolam-gandhi] mode: ${APPLY ? "APPLY (writes enabled)" : "DRY RUN (no writes)"}`);

  const workspace = await Workspace.findOne({ slug: WORKSPACE_SLUG });
  if (!workspace) throw new Error(`Workspace "${WORKSPACE_SLUG}" does not exist — refusing to create one`);

  // Never adopt or alter an existing record that doesn't match exactly.
  const byCode = await Property.findOne({ workspaceId: workspace._id, code: PROPERTY.code });
  const byName = await Property.findOne({ workspaceId: workspace._id, name: PROPERTY.name });
  const existing = byCode || byName;
  if (existing && (existing.code !== PROPERTY.code || existing.name !== PROPERTY.name || existing.timezone !== PROPERTY.timezone)) {
    throw new Error(
      `A Property already exists that conflicts with this seed (name="${existing.name}", code="${existing.code}", timezone="${existing.timezone}") — not modifying it`,
    );
  }

  let propertyId = existing?._id;
  console.error(`[seed-kolam-gandhi] property: ${existing ? "exists (reusing)" : "missing -> will create"} ${PROPERTY.code} "${PROPERTY.name}" tz=${PROPERTY.timezone}`);
  if (!existing && APPLY) {
    const created = await createProperty({ workspaceId: String(workspace._id), ...PROPERTY });
    propertyId = created._id;
  }

  const existingUnits = propertyId ? await Unit.find({ propertyId }).select("unitNumber") : [];
  const have = new Set(existingUnits.map((u) => u.unitNumber));
  const missing = UNIT_NUMBERS.filter((n) => !have.has(n));
  console.error(`[seed-kolam-gandhi] units: ${UNIT_NUMBERS.length - missing.length}/${UNIT_NUMBERS.length} exist, ${missing.length} to create`);

  if (APPLY) {
    for (const unitNumber of missing) {
      await createUnit({ workspaceId: String(workspace._id), propertyId: String(propertyId), unitNumber, type: UNIT_TYPE });
    }
  }
  console.error(`[seed-kolam-gandhi] ${APPLY ? "done" : "dry run complete — re-run with --apply to write"}`);
  console.log(propertyId ? String(propertyId) : "(property not created — dry run)");
  await disconnectDatabase();
}

main().catch(async (error) => {
  console.error("[seed-kolam-gandhi] failed:", error.message);
  try {
    await disconnectDatabase();
  } catch {
    // ignore
  }
  process.exit(1);
});
