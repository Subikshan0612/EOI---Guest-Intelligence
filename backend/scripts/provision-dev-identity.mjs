/**
 * DEVELOPMENT-ONLY: provision the development dashboard identity.
 *
 *   node scripts/provision-dev-identity.mjs
 *
 * Creates (or finds) EXACTLY:
 *   User                 issuer eoi-dev-stub + subject eoi-dev-dashboard, status active
 *   WorkspaceMembership  that user in the EXISTING development workspace,
 *                        role operator, status active
 *
 * The identity key is issuer + subject (never email). The operator role gives the
 * dashboard `intelligence:view` and `decision:propose` with a `staff` knowledge
 * ceiling, and no `action:execute`.
 *
 * Safe to run repeatedly: each record is upserted on its unique key, so a re-run
 * resolves the same User and membership and reports "already existed". An existing
 * record that does NOT match (a disabled user, another role, a revoked membership)
 * is REPORTED and left untouched - this script never silently rewrites identity.
 *
 * What it does not do: it does not create a workspace (the development workspace
 * must already exist - see create-dev-workspace.mjs), touches no operational
 * collection, and needs no signing secret. It is a CLI only, and refuses to run
 * when NODE_ENV=production.
 *
 * Get a token for the identity with:  node scripts/issue-dev-token.mjs --subject eoi-dev-dashboard
 */
import { requireLoopbackDatabase } from "../src/config/mongoSafety.js";
requireLoopbackDatabase("provision-dev-identity"); // never silently operate on a remote database (see src/config/mongoSafety.js)
import { pathToFileURL } from "node:url";
import { STUB_ISSUER } from "../src/auth/stubTokenVerifier.js";
import { User, Workspace, WorkspaceMembership } from "../src/models/index.js";

export const DEV_SUBJECT = "eoi-dev-dashboard";
export const DEV_ROLE = "operator";
export const DEV_WORKSPACE_SLUG = "dev-workspace";

/**
 * Upserts the User and the membership. `workspaceId` must be an existing workspace.
 * Assumes a connected mongoose. Never creates a workspace.
 * @returns {{ user, membership, userCreated: boolean, membershipCreated: boolean, problems: string[] }}
 */
export async function provisionDevIdentity({ workspaceId, issuer = STUB_ISSUER, subject = DEV_SUBJECT, role = DEV_ROLE } = {}) {
  if (!["development", "test"].includes((process.env.NODE_ENV ?? "").trim().toLowerCase())) throw new Error("refusing to run when NODE_ENV=production");
  if (!workspaceId) throw new Error("a workspaceId is required");
  const workspace = await Workspace.findById(workspaceId).lean();
  if (!workspace) throw new Error("the workspace does not exist; this script never creates one");

  const problems = [];

  // Upsert on the unique key (issuer + subject); only a NEW record gets defaults.
  const userResult = await User.findOneAndUpdate(
    { issuer, subject },
    { $setOnInsert: { issuer, subject, status: "active" } },
    { upsert: true, new: true, includeResultMetadata: true },
  );
  const user = userResult.value;
  const userCreated = userResult.lastErrorObject?.updatedExisting === false;
  if (user.status !== "active") problems.push(`the existing user is "${user.status}", not active (left unchanged)`);

  const membershipResult = await WorkspaceMembership.findOneAndUpdate(
    { userId: user._id, workspaceId: workspace._id },
    { $setOnInsert: { userId: user._id, workspaceId: workspace._id, role, status: "active" } },
    { upsert: true, new: true, includeResultMetadata: true },
  );
  const membership = membershipResult.value;
  const membershipCreated = membershipResult.lastErrorObject?.updatedExisting === false;
  if (membership.role !== role) problems.push(`the existing membership role is "${membership.role}", not "${role}" (left unchanged)`);
  if (membership.status !== "active") problems.push(`the existing membership is "${membership.status}", not active (left unchanged)`);

  return { user, membership, userCreated, membershipCreated, problems };
}

async function main() {
  if (!["development", "test"].includes((process.env.NODE_ENV ?? "").trim().toLowerCase())) {
    console.error("provision-dev-identity: refusing to run when NODE_ENV=production");
    process.exit(1);
  }
  const { default: dotenv } = await import("dotenv");
  dotenv.config({ quiet: true });
  const { connectDatabase, disconnectDatabase } = await import("../src/config/database.js");

  await connectDatabase();
  try {
    const slug = process.env.KOI_DEV_WORKSPACE_SLUG || DEV_WORKSPACE_SLUG;
    const workspaces = await Workspace.find({ slug }).lean();
    if (workspaces.length !== 1) {
      throw new Error(`expected exactly one workspace with slug "${slug}", found ${workspaces.length}. Create it first with create-dev-workspace.mjs.`);
    }
    const result = await provisionDevIdentity({ workspaceId: workspaces[0]._id });
    const say = (created) => (created ? "CREATED" : "already existed");
    console.log(`workspace   ${workspaces[0]._id}  (${workspaces[0].name}, slug ${slug}) - existing, not modified`);
    console.log(`user        ${result.user._id}  ${result.user.issuer} / ${result.user.subject}  status=${result.user.status}  [${say(result.userCreated)}]`);
    console.log(`membership  ${result.membership._id}  role=${result.membership.role}  status=${result.membership.status}  [${say(result.membershipCreated)}]`);
    if (result.problems.length) {
      for (const problem of result.problems) console.error(`WARNING: ${problem}`);
      process.exitCode = 2;
    }
  } finally {
    await disconnectDatabase();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`provision-dev-identity: ${error.message}`);
    process.exit(1);
  });
}
