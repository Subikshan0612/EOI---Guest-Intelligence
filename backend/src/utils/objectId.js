import mongoose from "mongoose";
import { AppError } from "./AppError.js";

export function parseObjectId(value, fieldName = "id") {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (!mongoose.Types.ObjectId.isValid(value)) {
    throw new AppError(`Invalid ${fieldName}`, 400);
  }

  return value;
}

export function requireObjectId(value, fieldName = "id") {
  const parsed = parseObjectId(value, fieldName);
  if (!parsed) {
    throw new AppError(`${fieldName} is required`, 400);
  }
  return parsed;
}
