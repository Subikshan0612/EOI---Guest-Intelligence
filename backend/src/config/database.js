import mongoose from "mongoose";
import { env } from "./env.js";
import { assertMongoUriAllowed } from "./mongoSafety.js";

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

  // Database-safety guard (mongoSafety.js): a test / validation / local-only process is refused here, before anything is opened, unless EVERY host of the URI is loopback.
  // The same check also sits under mongoose.connect(), mongoose.createConnection() and MongoClient, so this early call only gives the clearest message.
  assertMongoUriAllowed(env.mongodbUri);

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
