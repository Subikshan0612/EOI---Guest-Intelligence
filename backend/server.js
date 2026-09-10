import app from "./app.js";
import { env } from "./src/config/env.js";
import { connectDatabase, disconnectDatabase } from "./src/config/database.js";

let server;
let isShuttingDown = false;

async function start() {
  try {
    await connectDatabase();

    server = app.listen(env.port);

    server.on("listening", () => {
      console.log(`[KOI API] Listening on http://localhost:${env.port}`);
      console.log(`[KOI API] Environment: ${env.nodeEnv}`);
      console.log(`[KOI API] CORS origin: ${env.clientUrl}`);
    });

    server.on("error", async (error) => {
      console.error("[KOI API] Failed to start server:", error.message);
      try {
        await disconnectDatabase();
      } catch (disconnectError) {
        console.error("[KOI API] Failed to close MongoDB after listen error:", disconnectError.message);
      }
      process.exit(1);
    });
  } catch (error) {
    console.error("[KOI API] Startup failed:", error.message);
    process.exit(1);
  }
}

async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`[KOI API] Received ${signal}. Shutting down...`);

  try {
    if (server) {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      console.log("[KOI API] HTTP server closed");
    }

    await disconnectDatabase();
    process.exit(0);
  } catch (error) {
    console.error("[KOI API] Shutdown error:", error.message);
    process.exit(1);
  }
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

void start();
