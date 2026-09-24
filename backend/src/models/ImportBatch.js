import mongoose from "mongoose";

const IMPORT_SOURCE_TYPES = ["csv"];
const IMPORT_BATCH_STATUSES = ["pending", "completed", "failed"];

const importRowErrorSchema = new mongoose.Schema(
  {
    row: { type: Number, required: true },
    message: { type: String, required: true, trim: true },
  },
  { _id: false },
);

/**
 * Phase 7F-E — audit record for one eZee operational CSV import run.
 *
 * Deliberately holds only aggregate outcome data (counts + row-level error
 * messages), never the original file bytes, raw parsed rows, or normalized
 * row bodies — see the phase's own design report ("do not persist the
 * original file or raw rows"). `mappingProfile` stores the resolved
 * column-mapping configuration that was actually applied, for audit
 * traceability, not the imported data itself.
 */
const importBatchSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    propertyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Property",
      required: true,
      index: true,
    },
    filename: {
      type: String,
      trim: true,
      default: "",
    },
    sourceType: {
      type: String,
      enum: IMPORT_SOURCE_TYPES,
      default: "csv",
    },
    status: {
      type: String,
      enum: IMPORT_BATCH_STATUSES,
      default: "pending",
    },
    startedAt: {
      type: Date,
      default: Date.now,
    },
    completedAt: {
      type: Date,
      default: undefined,
    },
    rowsRead: { type: Number, default: 0 },
    rowsCreated: { type: Number, default: 0 },
    rowsUpdated: { type: Number, default: 0 },
    rowsSkipped: { type: Number, default: 0 },
    rowsFailed: { type: Number, default: 0 },
    errors: { type: [importRowErrorSchema], default: () => [] },
    mappingProfile: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },
  },
  {
    timestamps: true,
    // `errors` is the approved field name; Mongoose reserves it for the
    // document's own validation errors. The importer only ever writes it via
    // a scoped updateOne and reads it via toObject(), never doc.errors.
    suppressReservedKeysWarning: true,
  },
);

importBatchSchema.index({ workspaceId: 1, createdAt: -1 });
importBatchSchema.index({ workspaceId: 1, propertyId: 1 });

export const ImportBatch = mongoose.model("ImportBatch", importBatchSchema);
export { IMPORT_SOURCE_TYPES, IMPORT_BATCH_STATUSES };
