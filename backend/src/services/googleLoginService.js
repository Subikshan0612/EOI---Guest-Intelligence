import { resolveAuthConfig } from "../auth/authConfig.js";
import { signLinkTicket, verifyLinkTicket } from "../auth/eoiTokens.js";
import { verifyPassword, verifyAgainstDummy } from "../auth/passwordHasher.js";
import { AuthError } from "../auth/tokenContract.js";
import { AuthIdentity } from "../models/AuthIdentity.js";
import { User } from "../models/User.js";
import { AppError } from "../utils/AppError.js";
import { selfRegistrationEnabled } from "./accountService.js";
import { createSession } from "./authSessionService.js";

/**
 * Google sign-in under the unified EOI session (Phase 46). The Google code exchange (oidcExchangeService.js) has ALREADY verified the ID token - issuer,
 * audience, signature, algorithm, exp, iat, sub - so what arrives here is a verified { issuer, subject, email?, emailVerified }. This module decides which EOI
 * user that is, and never trusts anything else.
 *
 * RESOLUTION, in this order (the email is NEVER the identity key):
 *   1. a LINKED identity (AuthIdentity: issuer + subject)                -> that user
 *   2. a user whose own issuer + subject match (Google-created, or an operator-provisioned one: scripts/provision-user.mjs)   -> that user
 *   3. unknown identity, the provider vouches for the address (email_verified) and an account already uses it:
 *        - a PASSWORD account with a VERIFIED email   -> LINK REQUIRED. Never merged silently: the person must also prove the account's password.
 *        - a PASSWORD account whose email was NEVER verified -> its password was never proven to belong to the address's owner, whereas Google just proved it
 *          does: the unproven password is DROPPED and the Google identity becomes the account's way in (defeats "pre-registering someone else's address").
 *   4. otherwise a new person: with KOI_SELF_REGISTRATION=true a new EOI user is created (and sets up their own workspace next); without it nothing is created
 *      and the person is told an administrator must grant access.
 * A disabled user is refused at every step. Nothing here reads a workspace, a role or a permission: those come from membership, later, from the database.
 */
const normalize = (email) => (typeof email === "string" ? email.normalize("NFC").trim().toLowerCase() : "");

function requireEoi() {
  const { eoi } = resolveAuthConfig();
  if (!eoi) throw new AppError("Authentication is not configured on this server", 503, { code: "AUTH_NOT_CONFIGURED" });
  return eoi;
}

const disabled = () => new AuthError("This account is not available", 403, "USER_DISABLED");

/**
 * @returns {Promise<{ kind: "user", user: object } | { kind: "link_required", userId: string } | { kind: "access_restricted" }>}
 */
export async function resolveGoogleLogin(identity) {
  const link = await AuthIdentity.findOne({ issuer: identity.issuer, subject: identity.subject }).lean();
  const known = link ? await User.findById(link.userId).lean() : await User.findOne({ issuer: identity.issuer, subject: identity.subject }).lean();
  if (known) {
    if (known.status !== "active") throw disabled();
    return { kind: "user", user: known };
  }

  const email = normalize(identity.email);
  if (email && identity.emailVerified === true) {
    const owners = await User.find({ $or: [{ emailNormalized: email }, { email }], passwordHash: { $exists: true } }, { status: 1, emailVerified: 1 }).lean();
    const owner = owners[0];
    if (owner) {
      if (owner.status !== "active") throw disabled();
      if (owner.emailVerified) return { kind: "link_required", userId: String(owner._id) };
      // Unverified password account: Google's verified address outranks an unproven password. Adopt the account, remove the unproven credential.
      // ORDER matters (race safety): the Google identity is reserved FIRST (its unique index makes two concurrent first sign-ins converge on one account and can
      // never leave a second user behind), and the credential is dropped by a CONDITIONAL update that only matches a still-unverified account. If the address was
      // verified in the meantime (its real owner clicked the link), nothing is adopted: the reservation is released and the normal proof-of-password path applies.
      let reserved = false;
      try {
        await AuthIdentity.create({ userId: owner._id, provider: "google", issuer: identity.issuer, subject: identity.subject, email });
        reserved = true;
      } catch (error) {
        if (error?.code !== 11000) throw error;
        const existing = await AuthIdentity.findOne({ issuer: identity.issuer, subject: identity.subject }, { userId: 1 }).lean();
        if (!existing || String(existing.userId) !== String(owner._id)) throw error; // that Google account belongs to someone else: never silently re-pointed
      }
      const adopted = await User.updateOne(
        { _id: owner._id, emailVerified: false, passwordHash: { $exists: true } },
        { $set: { emailVerified: true }, $unset: { passwordHash: 1, passwordChangedAt: 1 } },
      );
      if (adopted.modifiedCount === 0) {
        const now = await User.findById(owner._id).select("+passwordHash").lean();
        if (now?.passwordHash) {
          if (reserved) await AuthIdentity.deleteOne({ issuer: identity.issuer, subject: identity.subject, userId: owner._id }).catch(() => {});
          return { kind: "link_required", userId: String(owner._id) };
        }
        // otherwise a concurrent identical sign-in already adopted it: carry on with the same account
      }
      return { kind: "user", user: await User.findById(owner._id).lean() };
    }
  }

  if (!selfRegistrationEnabled()) return { kind: "access_restricted" };
  let created;
  try {
    created = await User.create({
      issuer: identity.issuer,
      subject: identity.subject,
      ...(email ? { email, emailNormalized: email } : {}),
      emailVerified: Boolean(email) && identity.emailVerified === true,
    });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    created = await User.findOne({ issuer: identity.issuer, subject: identity.subject }); // a concurrent first sign-in created it
  }
  return { kind: "user", user: created.toObject ? created.toObject() : created };
}

/** The ticket handed to the browser when linking is required (see eoiTokens.js: it proves only "this browser completed that Google sign-in"). */
export async function issueLinkTicket(identity, userId) {
  const config = requireEoi();
  return signLinkTicket({ secret: config.secret, userId, googleIssuer: identity.issuer, googleSubject: identity.subject, googleEmail: normalize(identity.email) || undefined });
}

/**
 * POST /api/auth/google/link - the person holds a link ticket (a genuine Google sign-in) AND supplies the account's password. Only both together link the
 * Google identity to the existing account. One generic failure for every wrong, expired, forged or mismatched input.
 */
export async function linkGoogleIdentity(body) {
  const config = requireEoi();
  const fail = () => new AuthError("We couldn't connect your Google account. Please check your password and try again.", 401, "LINK_FAILED");
  const password = typeof body?.password === "string" ? body.password : "";
  let ticket;
  try {
    ticket = await verifyLinkTicket(String(body?.linkTicket ?? ""), { secret: config.secret });
  } catch {
    await verifyAgainstDummy(password);
    throw fail();
  }
  const user = /^[0-9a-f]{24}$/.test(ticket.sub) ? await User.findById(ticket.sub).select("+passwordHash").lean() : null;
  if (!user || !user.passwordHash || !(await verifyPassword(password, user.passwordHash))) {
    if (!user?.passwordHash) await verifyAgainstDummy(password);
    throw fail();
  }
  if (user.status !== "active") throw disabled();
  try {
    await AuthIdentity.create({ userId: user._id, provider: "google", issuer: ticket.gi, subject: ticket.gs, email: ticket.ge });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const existing = await AuthIdentity.findOne({ issuer: ticket.gi, subject: ticket.gs }, { userId: 1 }).lean();
    if (!existing || String(existing.userId) !== String(user._id)) throw fail(); // that Google account already belongs to someone else
  }
  return createSession({ userId: user._id, method: "google" });
}
