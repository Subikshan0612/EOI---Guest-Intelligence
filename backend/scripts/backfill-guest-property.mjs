/**
 * Operator helper - give guests created BEFORE guests belonged to a property (Guest.propertyId) their property, where the records already prove it.
 *
 *   node scripts/backfill-guest-property.mjs              # DRY RUN (default): reports what it would do, changes nothing
 *   node scripts/backfill-guest-property.mjs --apply      # writes the unambiguous assignments
 *   (a remote database needs the explicit --allow-remote-db opt-in; see src/config/mongoSafety.js)
 *
 * A guest WITHOUT a propertyId is assigned only when every Stay and every Signal of that guest points at exactly ONE property. A guest with no stays or reports, or whose
 * records span several properties, is LISTED and left alone: it is assigned in the application (Guests -> the guest -> Edit), which refuses a property that would
 * contradict the guest's existing stays or reports. Nothing is deleted and nothing else is touched.
 */
import { requireLoopbackDatabase } from "../src/config/mongoSafety.js";
requireLoopbackDatabase("backfill-guest-property");
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { Guest, Signal, Stay } from "../src/models/index.js";

const apply = process.argv.includes("--apply");

async function main() {
  await connectDatabase();
  const guests = await Guest.find({ propertyId: { $exists: false } }).select("_id workspaceId firstName lastName").lean();
  const totals = { assigned: 0, noEvidence: 0, ambiguous: 0 };
  for (const guest of guests) {
    const [stayProps, signalProps] = await Promise.all([
      Stay.distinct("propertyId", { workspaceId: guest.workspaceId, guestId: guest._id }),
      Signal.distinct("propertyId", { workspaceId: guest.workspaceId, guestId: guest._id, propertyId: { $exists: true, $ne: null } }),
    ]);
    const properties = [...new Set([...stayProps, ...signalProps].map(String))];
    const label = `guest ${guest._id} (workspace ${guest.workspaceId})`;
    if (properties.length === 1) {
      totals.assigned += 1;
      console.log(`${apply ? "ASSIGN" : "would assign"}  ${label} -> property ${properties[0]}`);
      if (apply) await Guest.updateOne({ _id: guest._id, workspaceId: guest.workspaceId, propertyId: { $exists: false } }, { $set: { propertyId: properties[0] } });
    } else if (properties.length === 0) {
      totals.noEvidence += 1;
      console.log(`NEEDS A PROPERTY  ${label}: no stay or report to infer it from - assign it in the application`);
    } else {
      totals.ambiguous += 1;
      console.log(`AMBIGUOUS  ${label}: stays/reports at ${properties.length} properties (${properties.join(", ")}) - assign it in the application`);
    }
  }
  console.log(`\n${guests.length} guest(s) without a property: ${totals.assigned} ${apply ? "assigned" : "assignable (dry run, nothing written)"}, ${totals.noEvidence} need a property, ${totals.ambiguous} ambiguous.`);
  await disconnectDatabase();
}

main().catch(async (error) => {
  console.error("[backfill-guest-property] failed:", error.message);
  try {
    await disconnectDatabase();
  } catch {
    // ignore
  }
  process.exit(1);
});
