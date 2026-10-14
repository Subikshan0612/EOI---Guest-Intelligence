import crypto from "node:crypto";
import mongoose from "mongoose";
import { checkPasswordPolicy, hashPassword, needsRehash, verifyAgainstDummy, verifyPassword } from "../auth/passwordHasher.js";
import { AuthError } from "../auth/tokenContract.js";
import { AuthToken } from "../models/AuthToken.js";
import { EOI_LOCAL_ISSUER, User } from "../models/User.js";
import { AppError } from "../utils/AppError.js";
import { buildLink, emailAvailable, sendEmail } from "./emailService.js";
import { accountExistsMessage, resetPasswordMessage, verifyEmailMessage } from "./emailTemplates.js";
import { createSession, revokeAllForUser } from "./authSessionService.js";

/**
 * Email + password accounts (Phase 46). They produce the SAME EOI user and the SAME EOI session as Google sign-in (authSessionService.js); nothing downstream
 * knows or cares how the person proved who they are.
 *
 * ACCOUNT ENUMERATION: sign-up, sign-in, resend-verification and forgot-password answer identically whether or not an address has an account, take
 * comparable time (a password is hashed / verified either way) and say nothing about whether the account uses Google. The only differences a caller can see
 * come from things they themselves supplied (a malformed email, a weak password) or have just proved (the right password on an unverified account).
 *
 * TOKENS (email verification, password reset): 32 random bytes, base64url; only SHA-256 is stored; single use (an atomic `usedAt`); expiring; never logged.
 */
const VERIFY_TTL_MS = 24 * 3600 * 1000;
const RESET_TTL_MS = 30 * 60 * 1000;
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

/** Matches a user by address: the normalised field, or the plain `email` attribute of a user created before `emailNormalized` existed (it is already lower-case). */
const byEmail = (email) => ({ $or: [{ emailNormalized: email }, { email }] });
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const newToken = () => crypto.randomBytes(32).toString("base64url");

export const normalizeEmail = (value) => (typeof value === "string" ? value.normalize("NFC").trim().toLowerCase() : "");
const validEmail = (email) => email.length > 0 && email.length <= 254 && EMAIL_RE.test(email);

const invalidField = (field, message) => new AppError(message, 400, { code: "INVALID_FIELD", field });
const invalidCredentials = () => new AuthError("Invalid email or password.", 401, "INVALID_CREDENTIALS");
const invalidLink = () => new AppError("This link is invalid or has expired.", 400, { code: "INVALID_LINK" });

function cleanName(value) {
  const name = typeof value === "string" ? value.normalize("NFC").replace(/\s+/g, " ").trim() : "";
  if (name.length < 2 || name.length > 100 || /[\u0000-\u001f\u007f<>]/.test(name)) throw invalidField("name", "Please enter your full name.");
  return name;
}

function cleanEmailField(value) {
  const email = normalizeEmail(value);
  if (!validEmail(email)) throw invalidField("email", "Please enter a valid email address.");
  return email;
}

function cleanNewPassword(password, passwordConfirm, { email, name }) {
  if (passwordConfirm !== undefined && passwordConfirm !== password) throw invalidField("passwordConfirm", "The two passwords do not match.");
  const verdict = checkPasswordPolicy(password, { email, name });
  if (!verdict.ok) throw invalidField("password", verdict.message);
  return password;
}

/**
 * Creates a one-time token and DELIVERS it through `deliver(token)` (true = the transport accepted the message). Only after a successful delivery are the older
 * unused links of the same kind retired (only the newest link works). If delivery fails the new token is deleted and the older link is left exactly as it was, so
 * a failed send neither strands the person nor consumes anything. The raw token exists only in this call's memory and in the link handed to `deliver`.
 */
async function issueAndDeliver(userId, purpose, ttlMs, deliver) {
  const token = newToken();
  const created = await AuthToken.create({ userId, purpose, tokenHash: sha256(token), expiresAt: new Date(Date.now() + ttlMs) });
  let delivered = false;
  try {
    delivered = await deliver(token);
  } finally {
    if (!delivered) await AuthToken.deleteOne({ _id: created._id }).catch(() => {});
  }
  if (delivered) await AuthToken.updateMany({ userId, purpose, usedAt: { $exists: false }, _id: { $ne: created._id } }, { $set: { usedAt: new Date() } });
  return delivered;
}

async function redeemToken(token, purpose) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{40,64}$/.test(token)) return null;
  return AuthToken.findOneAndUpdate(
    { tokenHash: sha256(token), purpose, usedAt: { $exists: false }, expiresAt: { $gt: new Date() } },
    { $set: { usedAt: new Date() } },
    { new: true },
  ).lean();
}

/** @returns {Promise<boolean>} true only when the transport accepted the verification email. */
const mailVerification = (user) =>
  issueAndDeliver(user._id, "verify_email", VERIFY_TTL_MS, (token) => {
    const link = buildLink("/verify-email", token);
    return sendEmail({ to: user.email, kind: "verify_email", link, ...verifyEmailMessage({ name: user.name, link }) });
  });

const mailPasswordReset = (user, email) =>
  issueAndDeliver(user._id, "reset_password", RESET_TTL_MS, (token) => {
    const link = buildLink("/reset-password", token);
    return sendEmail({ to: user.email ?? email, kind: "reset_password", link, ...resetPasswordMessage({ name: user.name, link }) });
  });

function mailAccountExists(email) {
  const link = buildLink("/forgot-password", "");
  return sendEmail({ to: email, kind: "account_exists", link, ...accountExistsMessage({ link }) });
}

/** Email delivery is a GLOBAL condition (no/invalid transport configured), so saying so reveals nothing about any address. */
const assertEmailTransport = () => {
  if (!emailAvailable()) throw new AppError("We can't send email right now. Please try again later.", 503, { code: "EMAIL_DELIVERY_UNAVAILABLE" });
};
const deliveryFailed = () => new AppError("We couldn't send the email. Please try again in a moment.", 503, { code: "EMAIL_DELIVERY_FAILED" });

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
export async function signUp(body) {
  assertEmailTransport();
  const name = cleanName(body?.name);
  const email = cleanEmailField(body?.email);
  cleanNewPassword(body?.password, body?.passwordConfirm, { email, name });
  const passwordHash = await hashPassword(body.password); // the cost is paid for every valid request, so timing does not reveal an existing account

  const existing = await User.findOne(byEmail(email), { _id: 1 }).lean();
  if (existing) {
    // Same answer as success. A Google-created user, an unverified password account and a verified one are all "already exists": nothing is merged or replaced here.
    if (!(await mailAccountExists(email))) throw deliveryFailed(); // identical to the failure of a new address below: a delivery outage reveals nothing
    return { status: "verification_sent" };
  }
  const id = new mongoose.Types.ObjectId();
  let user;
  try {
    user = await User.create({ _id: id, issuer: EOI_LOCAL_ISSUER, subject: String(id), name, email, emailNormalized: email, emailVerified: false, passwordHash });
  } catch (error) {
    if (error?.code === 11000) {
      if (!(await mailAccountExists(email))) throw deliveryFailed();
      return { status: "verification_sent" };
    }
    throw error;
  }
  // Compensation: an account whose verification email was NOT delivered can never be activated, so it is removed again (nothing unusable is left behind, the
  // address is free to retry, nothing was claimed as sent). Only this still-unverified, just-created record is removed.
  let delivered = false;
  try {
    delivered = await mailVerification(user);
  } finally {
    if (!delivered) {
      await User.deleteOne({ _id: user._id, emailVerified: false }).catch(() => {});
      await AuthToken.deleteMany({ userId: user._id }).catch(() => {});
    }
  }
  if (!delivered) throw deliveryFailed();
  return { status: "verification_sent" };
}

export async function verifyEmail(token) {
  const redeemed = await redeemToken(token, "verify_email");
  if (!redeemed) throw invalidLink();
  await User.updateOne({ _id: redeemed.userId }, { $set: { emailVerified: true } });
  return { status: "verified" };
}

export async function resendVerification(body) {
  assertEmailTransport(); // a global condition: it is the same answer for every address
  const email = normalizeEmail(body?.email);
  if (validEmail(email)) {
    const user = await User.findOne({ emailNormalized: email, passwordHash: { $exists: true }, emailVerified: false, status: "active" }, { email: 1, name: 1 }).lean();
    if (user) await mailVerification(user); // a per-message failure is logged as a class and still answers the same generic "accepted" (it must not reveal the account)
  }
  return { status: "accepted" };
}

export async function signIn(body) {
  const email = normalizeEmail(body?.email);
  const password = typeof body?.password === "string" ? body.password : "";
  const user = validEmail(email) ? await User.findOne({ emailNormalized: email, passwordHash: { $exists: true } }).select("+passwordHash").lean() : null;
  if (!user) {
    await verifyAgainstDummy(password);
    throw invalidCredentials();
  }
  if (!(await verifyPassword(password, user.passwordHash))) throw invalidCredentials();
  // From here on the person has PROVED the password, so the state of the account may be stated plainly.
  if (user.status !== "active") throw new AuthError("This account is not available", 403, "USER_DISABLED");
  if (!user.emailVerified) throw new AuthError("Please verify your email address to continue", 403, "EMAIL_NOT_VERIFIED");
  if (needsRehash(user.passwordHash)) await User.updateOne({ _id: user._id }, { $set: { passwordHash: await hashPassword(password) } });
  return createSession({ userId: user._id, method: "password" });
}

export async function forgotPassword(body) {
  assertEmailTransport(); // a global condition: it is the same answer for every address
  const email = normalizeEmail(body?.email);
  if (validEmail(email)) {
    const candidates = await User.find({ ...byEmail(email), status: "active" }, { email: 1, name: 1, passwordHash: 1 }).lean();
    const user = candidates.find((u) => u.passwordHash) ?? candidates[0];
    // A failed send deletes the new token and leaves any earlier link untouched (issueAndDeliver); the answer is still the generic one.
    if (user) await mailPasswordReset(user, email);
  }
  return { status: "accepted" }; // whether or not an account exists, and whether or not this one message could be handed to the mail server
}

export async function resetPassword(body) {
  const token = body?.token;
  // The password is checked FIRST, so a rejected password does not use up the link.
  const probe = typeof token === "string" ? await AuthToken.findOne({ tokenHash: sha256(token), purpose: "reset_password" }, { userId: 1 }).lean() : null;
  const person = probe ? await User.findById(probe.userId, { email: 1, name: 1 }).lean() : null;
  cleanNewPassword(body?.password, body?.passwordConfirm, { email: person?.email, name: person?.name });
  const passwordHash = await hashPassword(body.password);

  const redeemed = await redeemToken(token, "reset_password");
  if (!redeemed) throw invalidLink();
  const user = await User.findById(redeemed.userId, { email: 1, status: 1 }).lean();
  if (!user || user.status !== "active") throw invalidLink();
  try {
    await User.updateOne(
      { _id: user._id },
      { $set: { passwordHash, passwordChangedAt: new Date(), emailVerified: true, ...(user.email ? { emailNormalized: normalizeEmail(user.email) } : {}) } },
    );
  } catch (error) {
    if (error?.code === 11000) throw invalidLink(); // another password account already owns this address: nothing is changed
    throw error;
  }
  await revokeAllForUser(user._id, "password_reset"); // every signed-in browser of this person must sign in again with the new password
  return { status: "password_changed" };
}
