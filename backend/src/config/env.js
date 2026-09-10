import dotenv from "dotenv";

dotenv.config();

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(required("PORT", "5000")),
  clientUrl: required("CLIENT_URL", "http://localhost:5173"),
  mongodbUri: process.env.MONGODB_URI ?? "",
  isProduction: (process.env.NODE_ENV ?? "development") === "production",
};
