import { serve } from "@hono/node-server";
import { app } from "./app.js";
import { getConfig } from "./config.js";
import { startHealthMonitor, stopHealthMonitor } from "./fleet/health-monitor.js";
import { hydrateRoutes } from "./fleet/hydrate.js";
import { getProxyManager, setCreditLedger, setUserRoleRepo } from "./fleet/services.js";
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

    // --- Database + Auth + Billing (when DATABASE_URL is set) ---
    const { hasDatabase } = await import("./db/index.js");
    if (hasDatabase()) {
      try {
        const { getPool, getDb } = await import("./db/index.js");
        const pool = getPool();
        const db = getDb();

        // Run platform-core Drizzle migrations
        const { runMigrations } = await import("./db/migrate.js");
        await runMigrations(pool);
        logger.info("Database migrations complete");

        // Initialize BetterAuth (sessions, signup, login)
        const { initBetterAuth, runAuthMigrations } = await import("@wopr-network/platform-core/auth/better-auth");
        initBetterAuth({ pool, db });
        await runAuthMigrations();
        logger.info("BetterAuth initialized");

        // Wire credit ledger (billing gate uses this)
        const { DrizzleCreditLedger } = await import("@wopr-network/platform-core/credits/credit-ledger");
        const creditLedger = new DrizzleCreditLedger(db);
        setCreditLedger(creditLedger);
        logger.info("Credit ledger initialized");

        // Wire user role repo (admin auth session check)
        const { DrizzleUserRoleRepository } = await import("@wopr-network/platform-core/auth");
        setUserRoleRepo(new DrizzleUserRoleRepository(db));
        logger.info("User role repository initialized");

        // --- Stripe (when STRIPE_SECRET_KEY is set) ---
        const stripeKey = process.env.STRIPE_SECRET_KEY;
        if (stripeKey) {
          const Stripe = (await import("stripe")).default;
          const stripe = new Stripe(stripeKey);
          logger.info("Stripe initialized (test mode)");

          // Stripe webhook handling can be added later.
          // For now, credits can be manually granted via admin API.
          void stripe; // prevent unused warning
        } else {
          logger.warn("STRIPE_SECRET_KEY not set — Stripe integration disabled");
        }
      } catch (err) {
        logger.error("Database/auth initialization failed", {
          error: (err as Error).message,
        });
        logger.warn("Running without database — billing checks and auth sessions disabled");
      }
    } else {
      logger.warn("DATABASE_URL not set — running without database (billing checks skipped, no persistent sessions)");
    }

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
