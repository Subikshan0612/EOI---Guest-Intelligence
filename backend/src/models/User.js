import mongoose from "mongoose";

const USER_STATUSES = ["active", "disabled"];

/** The issuer recorded on a User that EOI itself created for an email + password account (no external provider vouches for it). */
export const EOI_LOCAL_ISSUER = "eoi:account";

/**
 * A person known to EOI - ONE record per person, however they sign in (Phase 46).
 *
 *   identity key   issuer + subject (unique together): who vouched for the identity and the id it gave. For an operator-provisioned or Google-created
 *                  user this is the provider's issuer + subject. For an email + password account EOI itself vouches: issuer EOI_LOCAL_ISSUER and the
 *                  subject is the user's own id. A further Google identity linked to an existing account lives in AuthIdentity.
 *   email          an ATTRIBUTE as the provider gave it; `emailNormalized` (trimmed, NFC, lower-cased) is what uniqueness of password accounts uses.
 *                  Neither is ever the authorization key: authorization is the membership of the user id.
 *   emailVerified  true only when the owner PROVED the address (a verification link, a password-reset link, or the provider's verified-email claim).
 *   passwordHash   scrypt hash (auth/passwordHasher.js). `select: false`: it is never loaded by a normal query, so it cannot leak into a response by accident.
 *
 * A User has no role and no workspace: those live on WorkspaceMembership.
 */
const userSchema = new mongoose.Schema(
  {
    issuer: { type: String, required: true, trim: true },
    subject: { type: String, required: true, trim: true },
    name: { type: String, trim: true, maxlength: 120, default: undefined },
    email: { type: String, trim: true, lowercase: true, default: undefined },
    emailNormalized: { type: String, trim: true, lowercase: true, default: undefined },
    emailVerified: { type: Boolean, default: false },
    passwordHash: { type: String, select: false, default: undefined },
    passwordChangedAt: { type: Date, default: undefined },
    status: { type: String, enum: USER_STATUSES, default: "active" },
  },
  { timestamps: true },
);

userSchema.index({ issuer: 1, subject: 1 }, { unique: true });
// One PASSWORD account per address. (A provider-created user without a password does not occupy the address: linking is a deliberate, proven step.)
userSchema.index({ emailNormalized: 1 }, { unique: true, partialFilterExpression: { passwordHash: { $exists: true } } });

export const User = mongoose.model("User", userSchema);
export { USER_STATUSES };
