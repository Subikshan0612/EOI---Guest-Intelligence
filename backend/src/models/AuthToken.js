import mongoose from "mongoose";

const TOKEN_PURPOSES = ["verify_email", "reset_password"];

/**
 * A single-use, expiring token that is mailed to an address (email verification, password reset) - Phase 46. The token itself exists only in the email;
 * here there is only its SHA-256 hash, so a database read cannot be turned into a working link. Single use: `usedAt` is set atomically by the one request
 * that redeems it. The TTL index removes the document after it expires.
 */
const authTokenSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    purpose: { type: String, enum: TOKEN_PURPOSES, required: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: undefined },
  },
  { timestamps: true },
);

authTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 });

export const AuthToken = mongoose.model("AuthToken", authTokenSchema);
export { TOKEN_PURPOSES };
