import { AppError } from "../utils/AppError.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { sendSuccess } from "../utils/response.js";
import * as importService from "../services/import/importService.js";

function parseJsonField(value, fieldName) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new AppError(`${fieldName} must be valid JSON`, 400);
  }
}

export const importOperationalData = asyncHandler(async (req, res) => {
  if (!req.file) {
    throw new AppError("A CSV file is required", 400);
  }

  const mappingProfile = parseJsonField(req.body.mappingProfile, "mappingProfile");
  const statusMapping = parseJsonField(req.body.statusMapping, "statusMapping");

  const data = await importService.importOperationalCsv({
    workspaceId: req.body.workspaceId,
    propertyId: req.body.propertyId,
    filename: req.file.originalname,
    buffer: req.file.buffer,
    mappingProfile,
    dateFormat: req.body.dateFormat,
    statusMapping,
  });

  sendSuccess(res, data, 201);
});

export const getImportBatch = asyncHandler(async (req, res) => {
  const data = await importService.getImportBatchById(req.params.id, req.query.workspaceId);
  sendSuccess(res, data);
});
