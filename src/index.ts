import { serve } from "@hono/node-server";
import type { ICreditLedger } from "@wopr-network/platform-core/credits/credit-ledger";
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
        try {
          await runAuthMigrations();
        } catch (authMigErr) {
          logger.warn("BetterAuth migration skipped (tables may already exist via Drizzle)", {
            error: (authMigErr as Error).message,
          });
        }
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

        // --- tRPC router dependencies (billing, settings, profile, page-context) ---
        await wireTrpcDeps(db, pool, creditLedger);
        logger.info("tRPC router dependencies initialized");
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

// ---------------------------------------------------------------------------
// tRPC dependency wiring
// ---------------------------------------------------------------------------

async function wireTrpcDeps(
  db: import("@wopr-network/platform-core/db").DrizzleDb,
  pool: import("pg").Pool,
  creditLedger: ICreditLedger,
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
  const { DrizzlePageContextRepository } = await import(
    "@wopr-network/platform-core/fleet/page-context-repository"
  );
  setPageContextRouterDeps({ repo: new DrizzlePageContextRepository(db) });
}
