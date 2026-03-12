import { serve } from "@hono/node-server";
import { app } from "./app.js";
import { getConfig } from "./config.js";
import { hydrateRoutes } from "./fleet/hydrate.js";
import { startHealthMonitor, stopHealthMonitor } from "./fleet/health-monitor.js";
import { logger } from "./log.js";

const config = getConfig();

serve(
  {
    fetch: app.fetch,
    hostname: config.HOST,
    port: config.PORT,
  },
  async (info) => {
    logger.info(`paperclip-platform listening on ${info.address}:${info.port}`);
    logger.info(`Tenant proxy domain: *.${config.PLATFORM_DOMAIN}`);

    // Restore proxy routes from running Docker containers
    try {
      await hydrateRoutes();
    } catch (err) {
      logger.error("Route hydration failed", { error: (err as Error).message });
    }

    // Start periodic health checks
    startHealthMonitor();
  },
);

// Graceful shutdown
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    logger.info(`Received ${signal}, shutting down`);
    stopHealthMonitor();
    process.exit(0);
  });
}
