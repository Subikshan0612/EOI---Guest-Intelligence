import { Router } from "express";
import multer from "multer";
import { authenticatedPrelude, requireAccess, requirePermission } from "../auth/authorize.js";
import { requireWorkspaceMembership } from "../auth/membership.js";
import { AppError } from "../utils/AppError.js";
import { getImportBatch, importOperationalData } from "../controllers/importController.js";

const importRoutes = Router();

// Memory storage only, same as knowledgeDocumentRoutes.js's upload — the
// raw file is never written to disk or a blob store (see ImportBatch.js
// and the phase's own design report: only aggregate outcome data is
// persisted, never the original file). Same 10 MB ceiling as every other
// upload endpoint in this codebase.
const upload = multer({
  storage: multer.memoryStorage(),
  // fileSize 10 MB; one file; a few small text fields (workspaceId, propertyId, mappingProfile JSON...), each <= 100 KB.
  limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 20, fieldSize: 100 * 1024, parts: 30 },
  fileFilter: (_req, file, cb) => {
    if (!/\.csv$/i.test(file.originalname)) {
      return cb(new AppError("Only .csv files are supported", 400));
    }
    cb(null, true);
  },
});

/** Same thin multer-error adapter knowledgeDocumentRoutes.js already uses. */
function handleUpload(req, res, next) {
  upload.single("file")(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return next(new AppError("File exceeds the maximum upload size of 10 MB", 413));
      }
      return next(new AppError("File upload failed", 400));
    }
    if (err) return next(err);
    next();
  });
}

// IMPORTS are ADMIN-ONLY (they upsert Guest/Stay records and can overwrite existing PII).
// bearer -> authenticate BEFORE the multipart parser runs -> the workspace field inside the form
// is only a SELECTION validated against the caller's active membership -> workspace:admin. The
// controller then imports into the verified workspace, never into a form-supplied one.
importRoutes.post(
  "/operational",
  ...authenticatedPrelude({ tier: "import" }),
  handleUpload,
  requireWorkspaceMembership((req) => req.body?.workspaceId),
  requirePermission("workspace:admin"),
  importOperationalData,
);
// Reading an import batch (counts and row errors): authenticated, operations:view, the verified workspace.
importRoutes.get("/:id", ...requireAccess("operations:view"), getImportBatch);

export { importRoutes };
