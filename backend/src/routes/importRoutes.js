import { Router } from "express";
import multer from "multer";
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
  limits: { fileSize: 10 * 1024 * 1024 },
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

importRoutes.post("/operational", handleUpload, importOperationalData);
importRoutes.get("/:id", getImportBatch);

export { importRoutes };
