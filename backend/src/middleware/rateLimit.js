import crypto from "node:crypto";
import { getAuthRateLimitConfig, getRateLimitConfig } from "../config/runtimeConfig.js";
import { AppError } from "../utils/AppError.js";

/**
 * Rate limiting (Phase 21).
 *
 * DESIGN
 *   - A small fixed-window counter behind a `RateLimitStore` interface: `hit(key, windowMs, now) -> { count, resetAt }`
 *     (may be async). No dependency was added.
 *   - The only store shipped is `MemoryRateLimitStore`, which is PROCESS-LOCAL. That is correct for a single process and for
 *     development/tests, and it is NOT production-grade for a deployment with more than one instance: each instance keeps its
 *     own counters, so the effective limit multiplies by the instance count and a restart resets it. A production deployment
 *     must implement `RateLimitStore` over a shared store (e.g. Redis INCR + PEXPIRE) and pass it to `setRateLimitStore`.
 *     A warning is logged at startup in production so this is never mistaken for a distributed limiter.
 *
 * KEYS (what an attacker can and cannot change)
 *   - anon / ip : the client address (`req.ip`; X-Forwarded-For is NOT trusted unless KOI_TRUST_PROXY is set).
 *   - user      : the VERIFIED identity `issuer|subject` from the token. Changing a workspace id, a body id, a query value or a
 *                 header changes nothing; a token cannot be forged; rotating identities requires provisioned users.
 *   - workspace : the membership-VERIFIED workspace id (never the caller-supplied selector).
 *
 * RESPONSE: 429 in the existing error contract `{ success:false, message:"Too many requests", details:{ code:"RATE_LIMITED",
 * retryAfterSeconds } }` plus a `Retry-After` header. Nothing about the limiter's internals is exposed.
 */

export class MemoryRateLimitStore {
  constructor({ maxKeys = 200_000 } = {}) {
    this.maxKeys = maxKeys;
    this.entries = new Map();
    this.sweeper = setInterval(() => this.sweep(Date.now()), 30_000);
    this.sweeper.unref?.();
  }

  hit(key, windowMs, now = Date.now()) {
    let entry = this.entries.get(key);
    if (!entry || entry.resetAt <= now) {
      // Memory guard: when full, drop expired entries first; if still full, evict the oldest (Map keeps insertion order).
      if (!entry && this.entries.size >= this.maxKeys) {
        this.sweep(now);
        if (this.entries.size >= this.maxKeys) this.entries.delete(this.entries.keys().next().value);
      }
      entry = { count: 0, resetAt: now + windowMs };
      this.entries.set(key, entry);
    }
    entry.count += 1;
    return { count: entry.count, resetAt: entry.resetAt };
  }

  sweep(now) {
    for (const [key, entry] of this.entries) if (entry.resetAt <= now) this.entries.delete(key);
  }

  get size() {
    return this.entries.size;
  }
}

let store = null;
export function getRateLimitStore() {
  if (!store) store = new MemoryRateLimitStore({ maxKeys: getRateLimitConfig().maxKeys });
  return store;
}
/** Installs a shared store (production) or a fresh one (tests). */
export function setRateLimitStore(next) {
  store = next;
}

/**
 * @param {string} name        limiter name (part of the key; also the middleware's function name, for inventory checks)
 * @param {(cfg) => number} maxOf  reads the maximum from the config on every request
 * @param {(req) => string|null} keyOf  null/undefined = do not limit this request (e.g. no verified identity)
 */
export function rateLimit(name, maxOf, keyOf, { windowOf } = {}) {
  async function limiter(req, res, next) {
    try {
      const cfg = getRateLimitConfig();
      if (!cfg.enabled) return next();
      const key = keyOf(req);
      if (!key) return next();
      const max = maxOf(cfg, req);
      const windowMs = windowOf ? windowOf(cfg, req) : cfg.windowMs;
      const { count, resetAt } = await getRateLimitStore().hit(`${name}:${key}`, windowMs);
      const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
      res.set("RateLimit-Limit", String(max));
      res.set("RateLimit-Remaining", String(Math.max(0, max - count)));
      res.set("RateLimit-Reset", String(retryAfterSeconds));
      if (count > max) {
        res.set("Retry-After", String(retryAfterSeconds));
        return next(new AppError("Too many requests", 429, { code: "RATE_LIMITED", retryAfterSeconds }));
      }
      return next();
    } catch (error) {
      return next(error);
    }
  }
  Object.defineProperty(limiter, "name", { value: `rateLimit_${name}` });
  return limiter;
}

const identityKey = (req) => (req.actor?.issuer && req.actor?.subject ? `${req.actor.issuer}|${req.actor.subject}` : null);
const workspaceKey = (req) => req.actor?.workspaceId ?? null;
const clientKey = (req) => req.ip || req.socket?.remoteAddress || "unknown";

/** App-level, BEFORE authentication and body parsing. */
export const anonymousLimiter = rateLimit("anon", (cfg) => cfg.anonMax, (req) => (req.headers.authorization === undefined ? clientKey(req) : null));
export const clientAddressLimiter = rateLimit("ip", (cfg) => cfg.ipMax, clientKey);

/** Route-level, AFTER authenticate (they key on the verified identity). */
/** The public OIDC code-exchange endpoint (Phase 45B.4): per client address, far below the general limit - a person signs in rarely. */
export const oidcExchangeLimiter = rateLimit("oidc_exchange", (cfg) => Math.max(1, Math.min(cfg.ipMax, 30)), clientKey);
const identityOnlyKey = (req) => (req.identity?.issuer && req.identity?.subject ? `${req.identity.issuer}|${req.identity.subject}` : null);
/** Phase 45C account endpoints (identity-only authentication): per VERIFIED identity - reading the session, and (far stricter) setting up an account. */
export const accountSessionLimiter = rateLimit("account_session", (cfg) => Math.min(cfg.userMax, 120), identityOnlyKey);
export const accountRegisterLimiter = rateLimit("account_register", (cfg) => Math.max(1, Math.min(cfg.writeMax, 10)), identityOnlyKey);

// ---- Phase 46: authentication endpoints. Public (no identity yet), so they key on the client address and, once the JSON body is parsed, on the email. ----
const authWindow = () => getAuthRateLimitConfig().windowMs;
const emailKey = (req) => {
  const email = req.body?.email;
  if (typeof email !== "string" || email.length === 0 || email.length > 320) return null;
  return crypto.createHash("sha256").update(email.normalize("NFC").trim().toLowerCase()).digest("hex").slice(0, 32); // a hash: the address itself never becomes a key or a log value
};
export const signinIpLimiter = rateLimit("auth_signin_ip", () => getAuthRateLimitConfig().signinPerIp, clientKey, { windowOf: authWindow });
export const signinEmailLimiter = rateLimit("auth_signin_email", () => getAuthRateLimitConfig().signinPerEmail, emailKey, { windowOf: authWindow });
export const signupIpLimiter = rateLimit("auth_signup_ip", () => getAuthRateLimitConfig().signupPerIp, clientKey, { windowOf: authWindow });
export const resetIpLimiter = rateLimit("auth_reset_ip", () => getAuthRateLimitConfig().resetPerIp, clientKey, { windowOf: authWindow });
export const resetEmailLimiter = rateLimit("auth_reset_email", () => getAuthRateLimitConfig().resetPerEmail, emailKey, { windowOf: authWindow });
export const verifyIpLimiter = rateLimit("auth_verify_ip", () => getAuthRateLimitConfig().verifyPerIp, clientKey, { windowOf: authWindow });
export const refreshIpLimiter = rateLimit("auth_refresh_ip", () => getAuthRateLimitConfig().refreshPerIp, clientKey, { windowOf: authWindow });
export const userLimiter = rateLimit("user", (cfg) => cfg.userMax, identityKey);
export const writeLimiter = rateLimit("write", (cfg) => cfg.writeMax, identityKey);
export const aiLimiter = rateLimit("ai", (cfg) => cfg.aiMax, identityKey);
export const importLimiter = rateLimit("import", (cfg) => cfg.importMax, identityKey);
/** Route-level, AFTER membership and permission (keys on the verified workspace; only PERMITTED requests count). */
export const aiWorkspaceLimiter = rateLimit("ai_workspace", (cfg) => cfg.aiWorkspaceMax, workspaceKey);

const isRead = (method) => method === "GET" || method === "HEAD" || method === "OPTIONS";

/** The identity-keyed limiters for a route, in order. `tier`: "standard" | "ai" | "import". */
export function identityLimiters({ tier = "standard" } = {}) {
  const chain = [userLimiter];
  const tiered = tier === "ai" ? aiLimiter : tier === "import" ? importLimiter : null;
  if (tiered) chain.push(tiered);
  chain.push(function writeTier(req, res, next) {
    return isRead(req.method) || tier !== "standard" ? next() : writeLimiter(req, res, next);
  });
  return chain;
}
