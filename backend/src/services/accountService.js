import crypto from "node:crypto";
import { ROLES } from "../auth/roles.js";
import { User } from "../models/User.js";
import { Workspace } from "../models/Workspace.js";
import { WorkspaceMembership } from "../models/WorkspaceMembership.js";
import { AppError } from "../utils/AppError.js";

/**
 * Account state and self-service account setup (Phase 45C).
 *
 * The model, unchanged: Identity (issuer + subject, from the VERIFIED token) -> User -> WorkspaceMembership -> role -> permissions.
 * Authentication says WHO; this module only reports what EOI knows about that identity and, where a deployment allows it, lets a person
 * set up their OWN account:
 *
 *   getAccountSession   READ-ONLY. Never creates anything. The workspaces this identity belongs to (its own active memberships) and what it
 *                       can do next: 'member' | 'needs_setup' (self-registration is on) | 'access_restricted' (it is off).
 *   registerAccount    KOI_SELF_REGISTRATION=true only. Creates the User if it does not exist, then a NEW workspace named by the person and
 *                       an ADMIN membership in THAT workspace only. It can never create or widen a membership in any EXISTING workspace, so
 *                       nobody gains access to anyone else's data: a new workspace is a new tenant with exactly one member.
 *
 * The identity ALWAYS comes from the verified token (req.identity); a user id, issuer, subject, role or workspace id in a request body is never
 * read. Email is stored as a display attribute from the verified token and is never used to find or match a user. The role is fixed here
 * ("admin" of the person's own new workspace - workspace administration is what every operational write requires); it is never a parameter.
 *
 * Joining an EXISTING workspace is deliberately not offered: that remains an administrator decision (membership is created by an operator
 * or, in future, by a workspace admin). There is no invitation by email, because email is not an identity.
 */
export const selfRegistrationEnabled = () => String(process.env.KOI_SELF_REGISTRATION ?? "").trim().toLowerCase() === "true";

const NAME_MIN = 2;
const NAME_MAX = 80;
const inFlight = new Map(); // one setup at a time per identity (this process); the post-checks below cover other processes

function cleanWorkspaceName(value) {
  if (typeof value !== "string") throw new AppError("Please enter a name for your workspace.", 400, { code: "INVALID_FIELD", field: "workspaceName" });
  const name = value.normalize("NFC").replace(/\s+/g, " ").trim();
  // Plain text only: no control characters, no angle brackets (it is rendered back in the UI and used to make a URL-safe slug).
  if (name.length < NAME_MIN || name.length > NAME_MAX || /[\u0000-\u001f\u007f<>]/.test(name)) {
    throw new AppError(`Please enter a workspace name of ${NAME_MIN} to ${NAME_MAX} characters.`, 400, { code: "INVALID_FIELD", field: "workspaceName" });
  }
  return name;
}

function slugFor(name) {
  const base = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "workspace";
  return `${base}-${crypto.randomBytes(4).toString("hex")}`;
}

async function userFor(identity) {
  // An EOI session identity names the user directly; a provider identity is matched by issuer + subject. Never by email.
  if (identity.userId) return User.findById(identity.userId).lean();
  return User.findOne({ issuer: identity.issuer, subject: identity.subject }).lean();
}

/** The caller's OWN active workspaces (active membership with a known role in an active workspace), with their role in each. */
async function workspacesOf(userId) {
  const memberships = await WorkspaceMembership.find({ userId, status: "active", role: { $in: ROLES } }).lean();
  if (memberships.length === 0) return [];
  const roleOf = new Map(memberships.map((m) => [String(m.workspaceId), m.role]));
  const workspaces = await Workspace.find({ _id: { $in: memberships.map((m) => m.workspaceId) }, status: "active" }).sort({ createdAt: 1, _id: 1 }).lean();
  return workspaces.map((w) => ({ id: String(w._id), name: w.name, role: roleOf.get(String(w._id)) }));
}

function describe(workspaces) {
  const registration = selfRegistrationEnabled();
  return { state: workspaces.length > 0 ? "member" : registration ? "needs_setup" : "access_restricted", selfRegistration: registration, workspaces };
}

const gone = () => new AppError("Your session is no longer valid", 401, { code: "SESSION_INVALID" });

export async function getAccountSession(identity) {
  const user = await userFor(identity);
  if (!user && identity.userId) throw gone(); // an EOI session whose user no longer exists is not a "new person"
  if (user && user.status !== "active") throw new AppError("This user is disabled", 403, { code: "USER_DISABLED" });
  return describe(user ? await workspacesOf(user._id) : []);
}

export async function registerAccount(identity, body) {
  if (!selfRegistrationEnabled()) throw new AppError("Account setup is not available", 403, { code: "SELF_REGISTRATION_DISABLED" });
  const name = cleanWorkspaceName(body?.workspaceName); // the ONLY thing read from the body

  const key = `${identity.issuer}|${identity.subject}`;
  if (inFlight.has(key)) throw new AppError("Your account is already being set up", 409, { code: "SETUP_IN_PROGRESS" });
  inFlight.set(key, true);
  try {
    let user = await userFor(identity);
    if (!user && identity.userId) throw gone();
    if (user && user.status !== "active") throw new AppError("This user is disabled", 403, { code: "USER_DISABLED" });
    if (user && (await workspacesOf(user._id)).length > 0) throw new AppError("Your account is already set up", 409, { code: "ALREADY_SET_UP" });

    if (!user) {
      try {
        user = (await User.create({ issuer: identity.issuer, subject: identity.subject, ...(identity.email ? { email: identity.email } : {}) })).toObject();
      } catch (error) {
        if (error?.code !== 11000) throw error; // a concurrent first call created it: use that one
        user = await userFor(identity);
      }
    }

    let workspace = null;
    for (let attempt = 0; attempt < 3 && !workspace; attempt += 1) {
      try {
        workspace = await Workspace.create({ name, slug: slugFor(name), status: "active" });
      } catch (error) {
        if (error?.code !== 11000) throw error; // slug collision (random suffix): try another
      }
    }
    if (!workspace) throw new AppError("We could not set up your workspace. Please try again.", 503, { code: "SETUP_FAILED" });
    try {
      await WorkspaceMembership.create({ userId: user._id, workspaceId: workspace._id, role: "admin" });
    } catch (error) {
      await Workspace.deleteOne({ _id: workspace._id }).catch(() => {}); // never leave a workspace nobody belongs to
      throw error;
    }
    // Another process may have set this identity up at the same moment: keep the EARLIEST workspace, remove this one.
    const own = await workspacesOf(user._id);
    if (own.length > 1) {
      const mine = String(workspace._id);
      if (own[0].id !== mine) {
        await WorkspaceMembership.deleteOne({ userId: user._id, workspaceId: workspace._id });
        await Workspace.deleteOne({ _id: workspace._id });
        throw new AppError("Your account is already set up", 409, { code: "ALREADY_SET_UP" });
      }
    }
    return describe(await workspacesOf(user._id));
  } finally {
    inFlight.delete(key);
  }
}
