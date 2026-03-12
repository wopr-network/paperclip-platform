import { serve } from "@hono/node-server";
import { app } from "./app.js";
import { getConfig } from "./config.js";
import { startHealthMonitor, stopHealthMonitor } from "./fleet/health-monitor.js";
import { hydrateRoutes } from "./fleet/hydrate.js";
import { getProxyManager } from "./fleet/services.js";
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

    // Start ProxyManager — enables Caddy sync on route changes
    const proxy = getProxyManager();
    try {
      await proxy.start();
      logger.info(`Caddy sync enabled (${config.CADDY_ADMIN_URL})`);
    } catch (err) {
      logger.warn("Caddy sync unavailable — running without reverse proxy", {
        error: (err as Error).message,
      });
    }

    // Restore proxy routes from running Docker containers
    try {
      await hydrateRoutes();
      // Push hydrated routes to Caddy
      if (proxy.isRunning) await proxy.reload();
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
    getProxyManager()
      .stop()
      .catch(() => {});
    process.exit(0);
  });
}
