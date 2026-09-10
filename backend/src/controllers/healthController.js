import { getDatabaseStatus, isDatabaseConnected } from "../config/database.js";

export function getHealth(_req, res) {
  const connected = isDatabaseConnected();
  const database = getDatabaseStatus();

  if (!connected) {
    return res.status(503).json({
      success: false,
      service: "KOI API",
      status: "unhealthy",
      database,
    });
  }

  return res.status(200).json({
    success: true,
    service: "KOI API",
    status: "healthy",
    database: "connected",
  });
}
