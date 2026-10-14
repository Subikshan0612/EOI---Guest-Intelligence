/**
 * OPERATOR tool: register an OIDC identity as an EOI User and (optionally) give it a workspace membership.
 *
 *   node scripts/provision-user.mjs --subject <oidc sub> [--issuer <iss>] [--email <address>]
 *                                   [--workspace <id|slug> --role viewer|operator|reviewer|admin [--update-role]]
 *
 * Authentication never provisions anything: a verified token whose issuer + subject match no User gets 403
 * IDENTITY_NOT_REGISTERED, and a User with no membership gets no workspace access. This tool is the deliberate, human step.
 *
 *   - The identity is (issuer, subject). `--issuer` defaults to OIDC_ISSUER (it must equal the token's `iss` EXACTLY).
 *   - `--email` is an attribute for display only; it is never used to identify or match a user.
 *   - Idempotent: running it again changes nothing (the User is found by issuer + subject; the membership is created once).
 *     Changing an existing membership's role requires the explicit `--update-role` flag.
 *   - A role is never assumed: `--workspace` without `--role` is refused. Nothing is printed except what was done.
 */
import { requireLoopbackDatabase } from "../src/config/mongoSafety.js";
requireLoopbackDatabase("provision-user"); // never silently operate on a remote database (see src/config/mongoSafety.js)
import mongoose from "mongoose";
import "../src/config/env.js";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { ROLES } from "../src/auth/roles.js";
import { User, Workspace, WorkspaceMembership } from "../src/models/index.js";

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const fail = (message) => {
  console.error(`provision-user: ${message}`);
  process.exitCode = 1;
};

try {
  const issuer = (arg("issuer") ?? process.env.OIDC_ISSUER ?? "").trim();
  const subject = (arg("subject") ?? "").trim();
  const email = arg("email")?.trim().toLowerCase();
  const workspaceRef = arg("workspace");
  const role = arg("role");
  if (!issuer || !subject) fail("--subject is required, and --issuer (or OIDC_ISSUER)");
  else if (workspaceRef && !ROLES.includes(role)) fail(`--role must be one of ${ROLES.join(", ")} when --workspace is given`);
  else if (!workspaceRef && role) fail("--role needs --workspace");
  else {
    await connectDatabase();
    let workspace = null;
    if (workspaceRef) {
      workspace = /^[0-9a-fA-F]{24}$/.test(workspaceRef) ? await Workspace.findById(workspaceRef) : await Workspace.findOne({ slug: workspaceRef.toLowerCase() });
      if (!workspace) throw new Error("workspace not found");
    }
    let user = await User.findOne({ issuer, subject });
    if (user) console.log(`user exists (status ${user.status}); nothing changed`);
    else {
      user = await User.create({ issuer, subject, ...(email ? { email } : {}) });
      console.log("user created");
    }
    if (workspace) {
      const existing = await WorkspaceMembership.findOne({ userId: user._id, workspaceId: workspace._id });
      if (!existing) {
        await WorkspaceMembership.create({ userId: user._id, workspaceId: workspace._id, role });
        console.log(`membership created: ${role} in ${workspace.slug}`);
      } else if (existing.role === role && existing.status === "active") console.log("membership exists; nothing changed");
      else if (argv.includes("--update-role")) {
        await WorkspaceMembership.updateOne({ _id: existing._id }, { $set: { role, status: "active" } });
        console.log(`membership updated: ${role} in ${workspace.slug}`);
      } else throw new Error(`a membership already exists (role ${existing.role}, status ${existing.status}); pass --update-role to change it`);
    }
  }
} catch (error) {
  fail(error?.message ?? "failed");
} finally {
  if (mongoose.connection.readyState === 1) await disconnectDatabase();
}
