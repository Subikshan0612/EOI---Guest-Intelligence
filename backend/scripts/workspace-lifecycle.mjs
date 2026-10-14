/**
 * OPERATOR tool for the workspace lifecycle (Phase 22). Not an HTTP endpoint: suspending and reactivating a tenant is an operator
 * action (a workspace administrator cannot do it through the API), and an interrupted deletion is resumed here.
 *
 *   node scripts/workspace-lifecycle.mjs inventory  --workspace <id|slug>
 *   node scripts/workspace-lifecycle.mjs set-status --workspace <id|slug> --status active|inactive|suspended
 *   node scripts/workspace-lifecycle.mjs delete     --workspace <id|slug> --confirm <slug> [--resume]
 *
 * `inventory` is a dry run (counts only, no record content is printed). `delete` is PERMANENT (see
 * docs/WORKSPACE_LIFECYCLE_POLICY_PHASE22.md) and requires --confirm to equal the slug; --resume finishes a deletion that was
 * interrupted (the workspace is `inactive` with partial data). Nothing here prints a secret or any personal data.
 */
import { requireLoopbackDatabase } from "../src/config/mongoSafety.js";
requireLoopbackDatabase("workspace-lifecycle"); // never silently operate on a remote database (see src/config/mongoSafety.js)
import mongoose from "mongoose";
import "../src/config/env.js";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { Workspace, WORKSPACE_STATUSES } from "../src/models/index.js";
import { countWorkspaceData, deleteWorkspaceCascade, supportsTransactions } from "../src/services/workspaceLifecycleService.js";

const [command, ...rest] = process.argv.slice(2);
const arg = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const fail = (message) => {
  console.error(`workspace-lifecycle: ${message}`);
  process.exitCode = 1;
};

async function resolveWorkspace(reference) {
  if (!reference) return null;
  return /^[0-9a-fA-F]{24}$/.test(reference) ? Workspace.findById(reference) : Workspace.findOne({ slug: String(reference).toLowerCase() });
}

try {
  if (!["inventory", "set-status", "delete"].includes(command ?? "")) {
    fail("usage: inventory | set-status | delete  (see the header of this file)");
  } else {
    await connectDatabase();
    const workspace = await resolveWorkspace(arg("workspace"));
    if (!workspace) fail("workspace not found");
    else if (command === "inventory") {
      console.log(JSON.stringify({ workspaceId: String(workspace._id), slug: workspace.slug, status: workspace.status, transactions: supportsTransactions(), owned: await countWorkspaceData(workspace._id) }, null, 2));
    } else if (command === "set-status") {
      const status = arg("status");
      if (!WORKSPACE_STATUSES.includes(status)) fail(`--status must be one of ${WORKSPACE_STATUSES.join(", ")}`);
      else {
        await Workspace.updateOne({ _id: workspace._id }, { $set: { status } });
        console.log(`workspace ${workspace.slug}: status ${workspace.status} -> ${status}`);
      }
    } else {
      const result = await deleteWorkspaceCascade(workspace._id, { confirm: arg("confirm"), resume: rest.includes("--resume") });
      console.log(JSON.stringify({ deleted: result.workspace.slug, removed: result.deleted, transactions: supportsTransactions() }, null, 2));
    }
  }
} catch (error) {
  fail(error?.message ?? "failed");
} finally {
  if (mongoose.connection.readyState === 1) await disconnectDatabase();
}
