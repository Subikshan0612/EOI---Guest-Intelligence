import mongoose from "mongoose";

const REVOKE_REASONS = ["logout", "reuse_detected", "password_reset", "password_changed", "user_disabled", "admin"];

/**
 * One signed-in browser (Phase 46): the server-side record behind the refresh cookie. The REFRESH TOKEN itself is never stored - only SHA-256 hashes of the
 * current token and of the immediately previous one (for rotation and reuse detection). The id of this document is the `sid` claim of the access tokens
 * issued from it, so revoking it (logout, reuse, password reset, disabled user) makes every access token of that browser fail on its next request.
 *
 *   method     how the person signed in: "password" | "google" (informational; authorization never depends on it)
 *   expiresAt  absolute end of the session; the TTL index below removes the document a week later (kept briefly for auditing)
 */
const authSessionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    method: { type: String, enum: ["password", "google"], required: true },
    currentHash: { type: String, required: true },
    previousHash: { type: String, default: undefined },
    rotatedAt: { type: Date, default: undefined },
    lastUsedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: undefined },
    revokedReason: { type: String, enum: REVOKE_REASONS, default: undefined },
    purgeAt: { type: Date, required: true },
  },
  { timestamps: true },
);

authSessionSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

export const AuthSession = mongoose.model("AuthSession", authSessionSchema);
export { REVOKE_REASONS };
