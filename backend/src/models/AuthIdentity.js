import mongoose from "mongoose";

/**
 * An external-provider identity LINKED to an EOI user (Phase 46): the Google account that belongs to an account that was created with email + password.
 * Identity key = issuer + subject (never the email). A row exists only after the person PROVED both sides (the provider login and the account password).
 * Google users created by EOI keep their identity on the User itself (User.issuer / User.subject); this collection only holds additional links.
 */
const authIdentitySchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    provider: { type: String, enum: ["google"], required: true },
    issuer: { type: String, required: true, trim: true },
    subject: { type: String, required: true, trim: true },
    email: { type: String, trim: true, lowercase: true, default: undefined },
  },
  { timestamps: true },
);

authIdentitySchema.index({ issuer: 1, subject: 1 }, { unique: true });

export const AuthIdentity = mongoose.model("AuthIdentity", authIdentitySchema);
