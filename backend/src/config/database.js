import mongoose from "mongoose";
import { env } from "./env.js";

const READY_STATE = {
  0: "disconnected",
  1: "connected",
  2: "connecting",
  3: "disconnecting",
};

let listenersAttached = false;

function attachConnectionListeners() {
  if (listenersAttached) return;
  listenersAttached = true;

  mongoose.connection.on("error", (error) => {
    console.error("[KOI API] MongoDB connection error:", error.message);
  });

  mongoose.connection.on("disconnected", () => {
    console.warn("[KOI API] MongoDB disconnected");
  });
}

export async function connectDatabase() {
  if (!env.mongodbUri) {
    throw new Error("Missing required environment variable: MONGODB_URI");
  }

  attachConnectionListeners();

  mongoose.set("strictQuery", true);

  await mongoose.connect(env.mongodbUri);

  console.log("[KOI API] MongoDB connected");
}

export async function disconnectDatabase() {
  if (mongoose.connection.readyState === 0) {
    return;
  }

  await mongoose.connection.close();
  console.log("[KOI API] MongoDB connection closed");
}

export function getDatabaseStatus() {
  return READY_STATE[mongoose.connection.readyState] ?? "unknown";
}

export function isDatabaseConnected() {
  return mongoose.connection.readyState === 1;
}
