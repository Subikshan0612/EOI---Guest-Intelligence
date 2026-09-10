/**
 * Development helper — ensure a local KOI workspace exists and print its id.
 *
 * KOI has no authentication yet, so the frontend needs a real workspace
 * ObjectId for tenant scoping (VITE_KOI_WORKSPACE_ID). This script creates that
 * workspace once (idempotent by slug) against your local MongoDB and prints the
 * id to stdout so it can be pasted into frontend/.env.
 *
 * Usage:
 *   MONGODB_URI="mongodb://127.0.0.1:27017/koi" node scripts/create-dev-workspace.mjs
 *
 * It never deletes anything. Remove the workspace manually if you no longer
 * want it.
 */
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { Workspace } from "../src/models/index.js";

const slug = process.env.KOI_DEV_WORKSPACE_SLUG || "dev-workspace";
const name = process.env.KOI_DEV_WORKSPACE_NAME || "Development Workspace";

async function main() {
  await connectDatabase();
  let workspace = await Workspace.findOne({ slug });
  if (!workspace) {
    workspace = await Workspace.create({ name, slug });
    console.error(`[create-dev-workspace] created workspace "${name}" (${slug})`);
  } else {
    console.error(`[create-dev-workspace] reusing existing workspace "${slug}"`);
  }
  // stdout: just the id, so it can be captured in a script or .env
  console.log(workspace._id.toString());
  await disconnectDatabase();
}

main().catch(async (error) => {
  console.error("[create-dev-workspace] failed:", error.message);
  try {
    await disconnectDatabase();
  } catch {
    // ignore
  }
  process.exit(1);
});
