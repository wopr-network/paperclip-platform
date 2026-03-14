import { serve } from "@hono/node-server";
import type { ILedger } from "@wopr-network/platform-core/credits";
import { app } from "./app.js";
import { getConfig } from "./config.js";
import { startHealthMonitor, stopHealthMonitor } from "./fleet/health-monitor.js";
import { hydrateRoutes } from "./fleet/hydrate.js";
import { getProxyManager, setCreditLedger, setServiceKeyRepo, setUserRoleRepo } from "./fleet/services.js";
import { logger } from "./log.js";

// ---------------------------------------------------------------------------
// Boot sequence: init everything (including route mounting) BEFORE serve().
//
// Hono builds its route matcher lazily on the first fetch() call. If we call
// serve() first and then try to add routes (e.g. mountGateway → app.route())
// inside the serve callback, any request that arrives during that async init
// window triggers the matcher build — and the subsequent app.route() throws:
//   "Can not add a route since the matcher is already built."
//
// Fix: complete all route-adding work before calling serve().
// ---------------------------------------------------------------------------

async function main() {
  const config = getConfig();

  // --- Database + Auth + Billing (when DATABASE_URL is set) ---
  const dbModule = await import("./db/index.js");
  if (dbModule.hasDatabase()) {
    try {
      const pool = dbModule.getPool();
      const db = dbModule.getDb();

      // Run platform-core Drizzle migrations
      const { runMigrations } = await import("./db/migrate.js");
      await runMigrations(pool);
      logger.info("Database migrations complete");

      // Wire credit ledger FIRST (needed by onUserCreated hook below)
      const { DrizzleLedger, grantSignupCredits } = await import("@wopr-network/platform-core/credits");
      const creditLedger = new DrizzleLedger(db);
      setCreditLedger(creditLedger);
      logger.info("Credit ledger initialized");

      // Initialize BetterAuth (sessions, signup, login)
      const { initBetterAuth, runAuthMigrations } = await import("@wopr-network/platform-core/auth/better-auth");
      initBetterAuth({
        pool,
        db,
        onUserCreated: async (userId) => {
          try {
            const granted = await grantSignupCredits(creditLedger, userId);
            if (granted) logger.info(`Granted $5 welcome credits to user ${userId}`);
          } catch (err) {
            logger.error("Failed to grant signup credits:", err);
          }
        },
      });
      try {
        await runAuthMigrations();
      } catch (authMigErr) {
        logger.warn("BetterAuth migration skipped (tables may already exist via Drizzle)", {
          error: (authMigErr as Error).message,
        });
      }
      logger.info("BetterAuth initialized");

      // Wire user role repo (admin auth session check)
      const { DrizzleUserRoleRepository } = await import("@wopr-network/platform-core/auth");
      setUserRoleRepo(new DrizzleUserRoleRepository(db));
      logger.info("User role repository initialized");

      // --- Metered inference gateway (OpenRouter proxy) ---
      // MUST happen before serve() — mountGateway calls app.route()
      await wireGateway(db, creditLedger);

      // --- tRPC router dependencies (billing, settings, profile, page-context) ---
      await wireTrpcDeps(db, pool, creditLedger);
      logger.info("tRPC router dependencies initialized");
    } catch (err) {
      logger.error("Startup initialization failed (DB, auth, or gateway)", {
        error: (err as Error).message,
        stack: (err as Error).stack,
      });
      logger.warn("Running in degraded mode — billing, auth, and/or gateway routes may be unavailable");
    }
  } else {
    logger.warn("DATABASE_URL not set — running without database (billing checks skipped, no persistent sessions)");
  }

  // --- All routes are now mounted. Safe to start serving. ---
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
}

main().catch((err) => {
  logger.error("Fatal startup error", {
    error: (err as Error).message,
    stack: (err as Error).stack,
  });
  process.exit(1);
});

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

// ---------------------------------------------------------------------------
// tRPC dependency wiring
// ---------------------------------------------------------------------------

async function wireTrpcDeps(
  db: import("@wopr-network/platform-core/db").DrizzleDb,
  pool: import("pg").Pool,
  creditLedger: ILedger,
) {
  const { setBillingRouterDeps } = await import("./trpc/routers/billing.js");
  const { setSettingsRouterDeps } = await import("./trpc/routers/settings.js");
  const { setProfileRouterDeps } = await import("./trpc/routers/profile.js");
  const { setPageContextRouterDeps } = await import("./trpc/routers/page-context.js");
  const { setOrgRouterDeps } = await import("./trpc/routers/org.js");

  // Wire org member repo for tRPC tenant validation middleware
  const { setTrpcOrgMemberRepo } = await import("@wopr-network/platform-core/trpc");
  const { DrizzleOrgMemberRepository, DrizzleOrgRepository, OrgService } = await import(
    "@wopr-network/platform-core/tenancy"
  );
  const orgMemberRepo = new DrizzleOrgMemberRepository(db);
  setTrpcOrgMemberRepo(orgMemberRepo);

  // Wire org router deps
  const { BetterAuthUserRepository } = await import("@wopr-network/platform-core/db");
  const authUserRepo = new BetterAuthUserRepository(pool);
  const orgRepo = new DrizzleOrgRepository(db);
  const orgService = new OrgService(orgRepo, orgMemberRepo, db, { userRepo: authUserRepo });
  setOrgRouterDeps({ orgService, authUserRepo, creditLedger });

  // --- Billing deps ---
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET ?? "";

  if (stripeKey) {
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(stripeKey);
    logger.info("Stripe initialized (test mode)");

    const { DrizzleTenantCustomerRepository, loadCreditPriceMap } = await import("@wopr-network/platform-core/billing");
    const { StripePaymentProcessor } = await import("@wopr-network/platform-core/billing");
    const { DrizzleMeterAggregator, DrizzleUsageSummaryRepository } = await import(
      "@wopr-network/platform-core/metering"
    );
    const { DrizzleAutoTopupSettingsRepository } = await import("@wopr-network/platform-core/credits");
    const { DrizzleSpendingLimitsRepository } = await import(
      "@wopr-network/platform-core/monetization/drizzle-spending-limits-repository"
    );
    const { DrizzleDividendRepository } = await import(
      "@wopr-network/platform-core/monetization/credits/dividend-repository"
    );
    const { DrizzleAffiliateRepository } = await import(
      "@wopr-network/platform-core/monetization/affiliate/drizzle-affiliate-repository"
    );

    const tenantRepo = new DrizzleTenantCustomerRepository(db);
    const priceMap = loadCreditPriceMap();
    const processor = new StripePaymentProcessor({
      stripe,
      tenantRepo,
      webhookSecret: stripeWebhookSecret,
      priceMap,
      creditLedger,
    });

    const usageSummaryRepo = new DrizzleUsageSummaryRepository(db);
    const meterAggregator = new DrizzleMeterAggregator(usageSummaryRepo);
    const autoTopupSettingsStore = new DrizzleAutoTopupSettingsRepository(db);
    const spendingLimitsRepo = new DrizzleSpendingLimitsRepository(db);
    const dividendRepo = new DrizzleDividendRepository(db);
    const affiliateRepo = new DrizzleAffiliateRepository(db);

    setBillingRouterDeps({
      processor,
      tenantRepo,
      creditLedger,
      meterAggregator,
      priceMap,
      autoTopupSettingsStore,
      dividendRepo,
      spendingLimitsRepo,
      affiliateRepo,
    });

    // Wire billing deps into org router (processor, meter, priceMap)
    setOrgRouterDeps({ orgService, authUserRepo, creditLedger, meterAggregator, processor, priceMap });
    logger.info("Billing tRPC router wired (Stripe + all repositories)");
  } else {
    logger.warn("STRIPE_SECRET_KEY not set — billing tRPC procedures will fail until configured");
  }

  // --- Settings deps ---
  const { DrizzleNotificationPreferencesStore } = await import("@wopr-network/platform-core/email");
  const notificationPrefsStore = new DrizzleNotificationPreferencesStore(db);
  setSettingsRouterDeps({
    getNotificationPrefsStore: () => notificationPrefsStore,
  });

  // --- Profile deps (delegates to BetterAuth user table via raw SQL) ---
  setProfileRouterDeps({
    getUser: (userId) => authUserRepo.getUser(userId),
    updateUser: (userId, data) => authUserRepo.updateUser(userId, data),
    changePassword: (userId, currentPassword, newPassword) =>
      authUserRepo.changePassword(userId, currentPassword, newPassword),
  });

  // --- Page context deps ---
  const { DrizzlePageContextRepository } = await import("@wopr-network/platform-core/fleet/page-context-repository");
  setPageContextRouterDeps({ repo: new DrizzlePageContextRepository(db) });
}

// ---------------------------------------------------------------------------
// Metered inference gateway wiring
// ---------------------------------------------------------------------------

async function wireGateway(db: import("@wopr-network/platform-core/db").DrizzleDb, creditLedger: ILedger) {
  const config = getConfig();
  if (!config.OPENROUTER_API_KEY) {
    logger.warn("OPENROUTER_API_KEY not set — inference gateway disabled");
    return;
  }

  const { mountGateway, DrizzleServiceKeyRepository } = await import("@wopr-network/platform-core/gateway");
  const { DrizzleMeterEventRepository, MeterEmitter } = await import("@wopr-network/platform-core/metering");
  const { DrizzleBudgetChecker } = await import("@wopr-network/platform-core/monetization");

  const meter = new MeterEmitter(new DrizzleMeterEventRepository(db), {
    walPath: `${config.FLEET_DATA_DIR}/meter-wal`,
    dlqPath: `${config.FLEET_DATA_DIR}/meter-dlq`,
  });
  const budgetChecker = new DrizzleBudgetChecker(db);
  const serviceKeyRepo = new DrizzleServiceKeyRepository(db);
  setServiceKeyRepo(serviceKeyRepo);

  mountGateway(app, {
    meter,
    budgetChecker,
    creditLedger,
    providers: {
      openrouter: { apiKey: config.OPENROUTER_API_KEY },
    },
    resolveServiceKey: (key) => serviceKeyRepo.resolve(key),
  });

  logger.info("Inference gateway mounted at /v1 (OpenRouter)");
}
