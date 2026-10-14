import crypto from "node:crypto";
import { resolveAuthConfig } from "../auth/authConfig.js";
import { signAccessToken } from "../auth/eoiTokens.js";
import { AuthError } from "../auth/tokenContract.js";
import { AuthSession } from "../models/AuthSession.js";
import { User } from "../models/User.js";
import { AppError } from "../utils/AppError.js";

/**
 * The EOI session (Phase 46): what every sign-in method ends in.
 *
 *   createSession   after a method has PROVEN who the person is (password, Google): a server-side session + a refresh token + the first access token.
 *   refresh         the browser's refresh cookie -> a new short-lived access token, and a NEW refresh token (rotation). The old one is remembered for a few
 *                   seconds so two tabs refreshing at once do not sign each other out; presenting it AFTER that is treated as theft and revokes the session.
 *   revoke*         logout, a password reset, a disabled user: the session stops working at once (every access token carries its `sid`).
 *   verifyLive      per-request check used by the access-token verifier: the session exists, is not revoked and has not expired.
 *
 * Refresh token = "<session id>.<32 random bytes, base64url>". Only SHA-256 of the secret part is stored. Everything here fails with ONE generic 401: whether a
 * session never existed, expired, was revoked or was reused is not revealed.
 */
const ROTATION_GRACE_MS = 10_000;
const PURGE_AFTER_MS = 7 * 24 * 3600 * 1000;
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const equal = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const invalid = () => new AuthError("Your session is no longer valid", 401, "SESSION_INVALID");

function requireConfig() {
  const { eoi } = resolveAuthConfig();
  if (!eoi) throw new AppError("Authentication is not configured on this server", 503, { code: "AUTH_NOT_CONFIGURED" });
  return eoi;
}

export const sessionCookieConfig = () => requireConfig();

async function issueAccess(config, userId, sessionId, now) {
  const accessToken = await signAccessToken({ secret: config.secret, userId, sessionId, ttlSeconds: config.accessTtlSeconds, now });
  return { accessToken, expiresIn: config.accessTtlSeconds };
}

const newRefreshSecret = () => crypto.randomBytes(32).toString("base64url");

/** @returns {{ accessToken, expiresIn, refreshToken, refreshMaxAgeSeconds }} */
export async function createSession({ userId, method, now = Date.now() }) {
  const config = requireConfig();
  const secret = newRefreshSecret();
  const expiresAt = new Date(now + config.refreshTtlDays * 24 * 3600 * 1000);
  const session = await AuthSession.create({ userId, method, currentHash: sha256(secret), lastUsedAt: new Date(now), expiresAt, purgeAt: new Date(expiresAt.getTime() + PURGE_AFTER_MS) });
  const access = await issueAccess(config, userId, session._id, now);
  return { ...access, refreshToken: `${session._id}.${secret}`, refreshMaxAgeSeconds: Math.floor((expiresAt.getTime() - now) / 1000) };
}

function split(raw) {
  if (typeof raw !== "string") return null;
  const dot = raw.indexOf(".");
  if (dot !== 24) return null;
  const id = raw.slice(0, dot);
  const secret = raw.slice(dot + 1);
  return /^[0-9a-f]{24}$/.test(id) && secret.length >= 20 ? { id, secret } : null;
}

/**
 * Rotates the refresh token. @returns {{ accessToken, expiresIn, refreshToken?, refreshMaxAgeSeconds?, userId }} - `refreshToken` is absent in the short
 * grace window (the browser already received the rotated cookie from the request that won the race).
 */
export async function refreshSession(rawRefresh, { now = Date.now() } = {}) {
  const config = requireConfig();
  const parts = split(rawRefresh);
  if (!parts) throw invalid();
  const presented = sha256(parts.secret);
  const at = new Date(now);

  const nextSecret = newRefreshSecret();
  // Atomic rotation: only the request that presents the CURRENT secret of a live session wins.
  const rotated = await AuthSession.findOneAndUpdate(
    { _id: parts.id, currentHash: presented, revokedAt: { $exists: false }, expiresAt: { $gt: at } },
    { $set: { previousHash: presented, currentHash: sha256(nextSecret), rotatedAt: at, lastUsedAt: at } },
    { new: true },
  ).lean();

  if (rotated) {
    const user = await User.findById(rotated.userId, { status: 1 }).lean();
    if (!user || user.status !== "active") {
      await revokeSession(parts.id, "user_disabled");
      throw invalid();
    }
    const access = await issueAccess(config, rotated.userId, rotated._id, now);
    return { ...access, userId: String(rotated.userId), refreshToken: `${rotated._id}.${nextSecret}`, refreshMaxAgeSeconds: Math.max(1, Math.floor((rotated.expiresAt.getTime() - now) / 1000)) };
  }

  const session = await AuthSession.findById(parts.id).lean();
  if (!session || session.revokedAt || session.expiresAt <= at) throw invalid();
  if (equal(session.previousHash, presented)) {
    if (session.rotatedAt && now - session.rotatedAt.getTime() <= ROTATION_GRACE_MS) {
      // Two requests raced with the same cookie: the first rotated it and its response already carries the new cookie. This one only gets an access token.
      const user = await User.findById(session.userId, { status: 1 }).lean();
      if (!user || user.status !== "active") throw invalid();
      const access = await issueAccess(config, session.userId, session._id, now);
      return { ...access, userId: String(session.userId) };
    }
    await revokeSession(parts.id, "reuse_detected"); // an old refresh token came back later: treat the whole session as stolen
  }
  throw invalid();
}

export async function revokeSession(sessionId, reason) {
  await AuthSession.updateOne({ _id: sessionId, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date(), revokedReason: reason } });
}

/** Logout: revokes the session behind a refresh cookie (idempotent; an unknown or malformed cookie is simply nothing to revoke). */
export async function revokeByRefreshToken(rawRefresh) {
  const parts = split(rawRefresh);
  if (!parts) return false;
  const session = await AuthSession.findById(parts.id).lean();
  if (!session || (!equal(session.currentHash, sha256(parts.secret)) && !equal(session.previousHash, sha256(parts.secret)))) return false;
  await revokeSession(parts.id, "logout");
  return true;
}

export async function revokeAllForUser(userId, reason) {
  await AuthSession.updateMany({ userId, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date(), revokedReason: reason } });
}

/** Per-request liveness of the session an access token belongs to. */
export async function isSessionLive(sessionId, userId, now = Date.now()) {
  if (!/^[0-9a-f]{24}$/.test(String(sessionId))) return false;
  const session = await AuthSession.findOne({ _id: sessionId, userId }, { revokedAt: 1, expiresAt: 1 }).lean();
  return Boolean(session && !session.revokedAt && session.expiresAt.getTime() > now);
}
