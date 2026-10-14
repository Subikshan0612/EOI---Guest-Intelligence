/**
 * Validates scripts/provision-dev-identity.mjs against real MongoDB using an
 * ISOLATED throwaway workspace and a throwaway subject, so the real development
 * identity is never created or touched by this suite. No server, no network.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import * as Models from "../src/models/index.js";
import { User, Workspace, WorkspaceMembership } from "../src/models/index.js";
import { STUB_ISSUER } from "../src/auth/stubTokenVerifier.js";
import { DEV_ROLE, DEV_SUBJECT, DEV_WORKSPACE_SLUG, provisionDevIdentity } from "./provision-dev-identity.mjs";

const TOOL = path.join(path.dirname(fileURLToPath(import.meta.url)), "provision-dev-identity.mjs");
let passed = 0;
let failed = 0;
const check = (name, condition, detail = "") => {
  if (condition) {
    passed += 1;
    console.log(`PASS  ${name}${detail ? ` - ${detail}` : ""}`);
  } else {
    failed += 1;
    console.error(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
  }
};
const rejects = async (fn) => {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
};

const stamp = Date.now();
const OPERATIONAL = ["Guest", "Stay", "ImportBatch", "Property", "Unit", "Signal", "KnowledgeDocument", "KnowledgeChunk", "Intelligence", "Decision", "Action", "Outcome", "Conversation", "Message"];
const ownWorkspaces = [];
const counts = async () => ({
  ...Object.fromEntries(await Promise.all(OPERATIONAL.map(async (name) => [name, await Models[name].countDocuments({})]))),
  Workspace: await Workspace.countDocuments({ _id: { $nin: ownWorkspaces } }),
});

async function main() {
  // Production refusal first: needs no database at all.
  const prod = spawnSync(process.execPath, [TOOL], { encoding: "utf8", env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_ENV: "production" } });
  check("S1: the CLI refuses to run when NODE_ENV=production (exit non-zero, nothing printed to stdout)", prod.status !== 0 && prod.stdout.trim() === "" && /production/.test(prod.stderr));

  check("S2: the fixed development identity is the specified one", DEV_SUBJECT === "eoi-dev-dashboard" && DEV_ROLE === "operator" && DEV_WORKSPACE_SLUG === "dev-workspace" && STUB_ISSUER === "eoi-dev-stub");

  await connectDatabase();
  await Promise.all([User.init(), WorkspaceMembership.init()]);
  const workspace = await Workspace.create({ name: `Provision test ${stamp}`, slug: `provision-test-${stamp}` });
  ownWorkspaces.push(workspace._id);
  const subject = `provision-test-subject-${stamp}`;
  const before = await counts();
  const usersBefore = await User.countDocuments({});
  const membershipsBefore = await WorkspaceMembership.countDocuments({});
  const created = { users: [], memberships: [] };

  try {
    const first = await provisionDevIdentity({ workspaceId: workspace._id, subject });
    created.users.push(first.user._id);
    created.memberships.push(first.membership._id);
    check("P1: first run creates the user and the membership", first.userCreated && first.membershipCreated);
    check("P2: the user is issuer + subject, active, no other identity", first.user.issuer === STUB_ISSUER && first.user.subject === subject && first.user.status === "active" && first.user.email === undefined);
    check("P3: the membership is operator, active, in the given workspace", first.membership.role === "operator" && first.membership.status === "active" && String(first.membership.workspaceId) === String(workspace._id) && String(first.membership.userId) === String(first.user._id));
    check("P4: no problems reported on a clean run", first.problems.length === 0);

    const second = await provisionDevIdentity({ workspaceId: workspace._id, subject });
    const third = await provisionDevIdentity({ workspaceId: workspace._id, subject });
    check("I1: a re-run creates nothing", !second.userCreated && !second.membershipCreated && !third.userCreated && !third.membershipCreated);
    check("I2: it resolves the SAME user and membership every time", String(second.user._id) === String(first.user._id) && String(third.membership._id) === String(first.membership._id));
    check("I3: exactly one user and one membership exist for it", (await User.countDocuments({ issuer: STUB_ISSUER, subject })) === 1 && (await WorkspaceMembership.countDocuments({ userId: first.user._id })) === 1);
    const parallel = await Promise.all(Array.from({ length: 6 }, () => provisionDevIdentity({ workspaceId: workspace._id, subject }).catch((error) => ({ error }))));
    check("I4: concurrent runs still leave exactly one of each", (await User.countDocuments({ issuer: STUB_ISSUER, subject })) === 1 && (await WorkspaceMembership.countDocuments({ userId: first.user._id })) === 1 && parallel.every((r) => r.error === undefined || r.error?.code === 11000), parallel.filter((r) => r.error).length + " raced");

    // existing-but-different records are reported, never rewritten
    await User.updateOne({ _id: first.user._id }, { $set: { status: "disabled" } });
    await WorkspaceMembership.updateOne({ _id: first.membership._id }, { $set: { role: "admin", status: "revoked" } });
    const drift = await provisionDevIdentity({ workspaceId: workspace._id, subject });
    check("D1: a disabled user / different role / revoked membership is REPORTED", drift.problems.length === 3, drift.problems.join(" | "));
    const stored = await WorkspaceMembership.findById(first.membership._id).lean();
    const storedUser = await User.findById(first.user._id).lean();
    check("D2: ...and left exactly as it was (never silently rewritten)", storedUser.status === "disabled" && stored.role === "admin" && stored.status === "revoked");

    check("R1: it refuses when NODE_ENV=production", await (async () => {
      const original = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";
      const refused = await rejects(() => provisionDevIdentity({ workspaceId: workspace._id, subject: `${subject}-prod` }));
      process.env.NODE_ENV = original;
      return refused && (await User.countDocuments({ subject: `${subject}-prod` })) === 0;
    })());
    check("R2: it never creates a workspace (an unknown workspace id is refused)", (await rejects(() => provisionDevIdentity({ workspaceId: "64b64c4f2f1c2e0012345678", subject: `${subject}-x` }))) && (await Workspace.countDocuments({ _id: { $nin: ownWorkspaces } })) === before.Workspace);
    check("R3: a missing workspaceId is refused", await rejects(() => provisionDevIdentity({ subject: `${subject}-y` })));

    const after = await counts();
    const changed = Object.keys(before).filter((key) => before[key] !== after[key]);
    check("O1: no operational collection changed", changed.length === 0, changed.join(","));
    check("O2: only this suite's own user and membership were added", (await User.countDocuments({})) === usersBefore + 1 && (await WorkspaceMembership.countDocuments({})) === membershipsBefore + 1);
  } finally {
    await WorkspaceMembership.deleteMany({ workspaceId: workspace._id });
    await User.deleteMany({ subject: { $regex: `${stamp}` } });
    await Workspace.deleteMany({ _id: workspace._id });
    check("C1: every fixture was removed", (await User.countDocuments({})) === usersBefore && (await WorkspaceMembership.countDocuments({})) === membershipsBefore && (await Workspace.countDocuments({ _id: workspace._id })) === 0);
    await disconnectDatabase();
  }
  void created;

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
