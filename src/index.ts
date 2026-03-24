import { serve } from "@hono/node-server";
import type { ILedger } from "@wopr-network/platform-core/credits";
import type { FleetUpdaterHandle } from "@wopr-network/platform-core/fleet";
import { initFleetUpdater, setRolloutOrchestrator, setVolumeSnapshotManager } from "@wopr-network/platform-core/fleet";
import { app } from "./app.js";
import { getConfig } from "./config.js";
import type { CryptoWatcherHandle } from "./crypto/init-watchers.js";
import { startHealthMonitor, stopHealthMonitor } from "./fleet/health-monitor.js";
import { hydrateRoutes } from "./fleet/hydrate.js";
import {
  getDocker,
  getFleetManager,
  getProfileStore,
  getProxyManager,
  setCreditLedger,
  setServiceKeyRepo,
  setUserRoleRepo,
} from "./fleet/services.js";
import { logger } from "./log.js";
import { setProductCorsOrigins } from "./product-cors.js";
import { setProductConfigRouterDeps } from "./trpc/index.js";

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

let fleetUpdaterHandle: FleetUpdaterHandle | null = null;
let cryptoWatcherHandle: CryptoWatcherHandle | null = null;

// Late-binding OrgService reference — set in wireTrpcDeps(), used by onUserCreated hook.
let lateOrgService: { getOrCreatePersonalOrg(userId: string, name: string): Promise<unknown> } | null = null;

// Late-binding product config service — set after platformBoot(), used by tRPC product router.
// Typed as unknown because @wopr-network/platform-core/product-config has no package exports entry;
// cast to the correct type at the call site via setProductConfigRouterDeps.
let _productConfigService: unknown = null;
let notificationWorkerTimer: ReturnType<typeof setInterval> | null = null;
let fleetNotificationUnsubscribe: (() => void) | null = null;
// Late-bound refs for notification service — set during notification pipeline init,
// read by onManualTenantsSkipped callback (fires at rollout time, well after boot).
let _notificationService: {
  notifyFleetUpdateAvailable: (
    tenantId: string,
    email: string,
    version: string,
    changelogDate: string,
    changelogSummary: string,
  ) => void;
  notifyTeamInvite: (tenantId: string, email: string, tenantName: string, inviteUrl: string) => void;
} | null = null;
let _emailResolver: { resolveEmail: (tenantId: string) => Promise<string | null> } | null = null;

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

      // Bootstrap product config from DB (BRAND_NAME, PLATFORM_DOMAIN, CORS, etc.)
      // Dynamic import via dist path — @wopr-network/platform-core/product-config has no
      // package.json exports entry so we import at runtime and cast.
      const productConfigMod = (await import("@wopr-network/platform-core/product-config/index.js" as string)) as {
        platformBoot: (opts: { slug: string; db: unknown; devOrigins?: string[] }) => Promise<{
          service: unknown;
          config: { product: { brandName: string; domain: string } };
          corsOrigins: string[];
          seeded: boolean;
        }>;
      };
      const {
        service: productConfigService,
        config: productConfig,
        corsOrigins,
        seeded,
      } = await productConfigMod.platformBoot({
        slug: config.PRODUCT_SLUG,
        db,
        devOrigins: process.env.DEV_ORIGINS?.split(",").filter(Boolean),
      });
      if (seeded) {
        logger.info(`Auto-seeded product config for "${config.PRODUCT_SLUG}" from built-in preset`);
      }
      logger.info(`Product config loaded: ${productConfig.product.brandName} (${productConfig.product.domain})`);

      // Make corsOrigins available for CORS middleware (late-binds into app.ts getter)
      setProductCorsOrigins(corsOrigins);
      _productConfigService = productConfigService;

      // Seed notification templates (idempotent — skips existing)
      try {
        const { DEFAULT_TEMPLATES, DrizzleNotificationTemplateRepository } = await import(
          "@wopr-network/platform-core/email"
        );
        const templateRepo = new DrizzleNotificationTemplateRepository(
          db as unknown as import("drizzle-orm/pg-core").PgDatabase<never>,
        );
        const reseeded = await templateRepo.reseedAll(DEFAULT_TEMPLATES);
        logger.info(`Reseeded ${reseeded} notification templates`);
      } catch (seedErr) {
        logger.warn("Notification template seeding failed (non-fatal)", {
          error: (seedErr as Error).message,
        });
      }

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
        brandName: productConfig.product.brandName || config.BRAND_NAME,
        onUserCreated: async (userId) => {
          try {
            const granted = await grantSignupCredits(creditLedger, userId);
            if (granted) logger.info(`Granted $5 welcome credits to user ${userId}`);
          } catch (err) {
            logger.error("Failed to grant signup credits:", err);
          }
          // Create personal tenant eagerly so the tenants table is never empty
          // for a signed-up user. lateOrgService is set after wireTrpcDeps().
          try {
            if (lateOrgService) {
              await lateOrgService.getOrCreatePersonalOrg(userId, "Personal");
              logger.info(`Created personal org for user ${userId}`);
            } else {
              logger.warn(
                `OrgService not yet initialized — personal org for ${userId} deferred to first dashboard visit`,
              );
            }
          } catch (err) {
            logger.error("Failed to create personal org:", err);
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

      // --- BTCPay crypto webhook (when configured) ---
      await wireCryptoWebhook(db, creditLedger);
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

      // Start fleet auto-update pipeline (ImagePoller → RolloutOrchestrator → ContainerUpdater)
      // Create a shared event emitter so fleet events flow to the notification listener.
      const fleetMod = await import("@wopr-network/platform-core/fleet");
      let sharedEventEmitter: ReturnType<typeof fleetMod.getFleetEventEmitter> | undefined;
      try {
        sharedEventEmitter = fleetMod.getFleetEventEmitter();
      } catch {
        // FleetEventEmitter not available — fleet notifications will be skipped
      }

      try {
        const docker = getDocker();
        const fleet = getFleetManager();
        const profileStore = getProfileStore();
        // ProfileStore implements IProfileStore; adapt to IBotProfileRepository
        // by wrapping save() to return the profile (IBotProfileRepository.save returns BotProfile)
        const profileRepo = {
          get: (id: string) => profileStore.get(id),
          list: () => profileStore.list(),
          delete: (id: string) => profileStore.delete(id),
          save: async (profile: import("@wopr-network/platform-core/fleet").BotProfile) => {
            await profileStore.save(profile);
            return profile;
          },
        };
        fleetUpdaterHandle = initFleetUpdater(docker, fleet, profileStore, profileRepo, {
          strategy: "rolling-wave",
          snapshotDir: process.env.FLEET_SNAPSHOT_DIR || `${config.FLEET_DATA_DIR}/snapshots`,
          onRolloutComplete: (result) => logger.info("Fleet rollout complete", result),
          eventEmitter: sharedEventEmitter,
          onManualTenantsSkipped: (tenantIds, imageTag) => {
            // Notify manual-mode tenants that an update is available (best-effort)
            if (!_notificationService || !_emailResolver) {
              logger.warn("onManualTenantsSkipped fired before notification pipeline ready", { tenantIds });
              return;
            }
            const svc = _notificationService;
            const resolver = _emailResolver;
            const version = imageTag || "latest";
            for (const tenantId of tenantIds) {
              resolver
                .resolveEmail(tenantId)
                .then((email) => {
                  if (email) {
                    svc.notifyFleetUpdateAvailable(tenantId, email, version, "", "");
                  }
                })
                .catch(() => {
                  // best-effort — skip on failure
                });
            }
          },
        });
        setVolumeSnapshotManager(fleetUpdaterHandle.snapshotManager);
        setRolloutOrchestrator(fleetUpdaterHandle.orchestrator);
        logger.info("Fleet auto-update pipeline started");
      } catch (err) {
        logger.warn("Fleet auto-update pipeline failed to start", {
          error: (err as Error).message,
        });
      }

      // --- Notification email pipeline (best-effort) ---
      try {
        const hasEmailBackend = config.RESEND_API_KEY || process.env.AWS_SES_REGION;
        if (hasEmailBackend && dbModule.hasDatabase()) {
          const {
            getEmailClient,
            NotificationService,
            NotificationWorker,
            DrizzleNotificationQueueStore,
            DrizzleNotificationPreferencesStore,
            DrizzleNotificationTemplateRepository,
            HandlebarsRenderer,
          } = await import("@wopr-network/platform-core/email");

          const db = dbModule.getDb();
          const pgDb = db as unknown as import("drizzle-orm/pg-core").PgDatabase<never>;

          const emailClient = getEmailClient();
          const queueStore = new DrizzleNotificationQueueStore(db);
          const prefsStore = new DrizzleNotificationPreferencesStore(db);
          const templateRepo = new DrizzleNotificationTemplateRepository(pgDb);
          const renderer = new HandlebarsRenderer(templateRepo);

          const notificationService = new NotificationService(queueStore, config.APP_BASE_URL, config.BRAND_NAME);
          _notificationService = notificationService;

          const worker = new NotificationWorker({
            queue: queueStore,
            emailClient,
            preferences: prefsStore,
            handlebarsRenderer: renderer,
          });

          // Drain any queued notifications from before restart
          worker.processBatch().catch((err: unknown) => {
            logger.error("Notification worker error (initial run)", {
              error: (err as Error).message,
            });
          });
          // Poll every 30 seconds
          notificationWorkerTimer = setInterval(() => {
            worker.processBatch().catch((err: unknown) => {
              logger.error("Notification worker error", {
                error: (err as Error).message,
              });
            });
          }, 30_000);

          // Wire fleet event → email notifications
          if (sharedEventEmitter) {
            const { DrizzleBetterAuthEmailResolver } = await import("./services/drizzle-email-resolver.js");
            const emailResolver = new DrizzleBetterAuthEmailResolver(pgDb);
            _emailResolver = emailResolver;

            fleetNotificationUnsubscribe = fleetMod.initFleetNotificationListener({
              eventEmitter: sharedEventEmitter,
              notificationService,
              preferences: prefsStore,
              resolveEmail: (tenantId) => emailResolver.resolveEmail(tenantId),
            });
            logger.info("Fleet notification listener started");
          }

          logger.info("Notification email pipeline started");
        } else if (!hasEmailBackend) {
          logger.info("Notification pipeline skipped: neither AWS_SES_REGION nor RESEND_API_KEY configured");
        }
      } catch (err) {
        logger.warn("Notification pipeline failed to start (non-fatal)", {
          error: (err as Error).message,
        });
      }
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
    if (cryptoWatcherHandle) {
      try {
        cryptoWatcherHandle.stop();
      } catch (err) {
        logger.error("Error stopping crypto watchers", { error: err });
      }
    }
    if (notificationWorkerTimer) clearInterval(notificationWorkerTimer);
    if (fleetNotificationUnsubscribe) fleetNotificationUnsubscribe();
    if (fleetUpdaterHandle) {
      fleetUpdaterHandle.stop().catch(() => {});
    }
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
  lateOrgService = orgService;
  const onInviteCreated = (orgId: string, inviteId: string, email: string) => {
    // Late-bound: notification service initializes after serve()
    if (!_notificationService) return;
    const appBaseUrl = getConfig().APP_BASE_URL;
    const inviteUrl = `${appBaseUrl}/invite/${inviteId}`;
    // Look up org name (best-effort async)
    pool
      .query("SELECT name FROM tenants WHERE id = $1 LIMIT 1", [orgId])
      .then((res) => {
        const orgName = res.rows[0]?.name ?? "your team";
        _notificationService?.notifyTeamInvite(orgId, email, orgName, inviteUrl);
        logger.info(`Sent invite email to ${email} for ${orgName}`);
      })
      .catch((err) => logger.error("Failed to send invite email", { err }));
  };

  setOrgRouterDeps({
    orgService,
    authUserRepo,
    creditLedger,
    provisionSecret: getConfig().PROVISION_SECRET,
    onInviteCreated,
  });

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
    setOrgRouterDeps({
      orgService,
      authUserRepo,
      creditLedger,
      meterAggregator,
      processor,
      priceMap,
      provisionSecret: getConfig().PROVISION_SECRET,
      onInviteCreated,
    });
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

  // --- Page context deps already set above ---

  // --- Product config tRPC router deps ---
  if (_productConfigService) {
    // Cast: service typed as unknown since the module has no package exports entry.
    // setProductConfigRouterDeps accepts the service as ProductConfigService internally.
    setProductConfigRouterDeps(
      _productConfigService as Parameters<typeof setProductConfigRouterDeps>[0],
      getConfig().PRODUCT_SLUG,
    );
    logger.info("Product config tRPC router wired");
  } else {
    logger.warn("Product config service not initialized — product tRPC router unavailable");
  }
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

  // Warm the DB-backed model cache so first request doesn't miss.
  const { resolveGatewayModel, warmModelCache, setAdminRouterDeps } = await import("./trpc/routers/admin.js");
  setAdminRouterDeps({ db });
  await warmModelCache();

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
    defaultModel: config.GATEWAY_DEFAULT_MODEL,
    providers: {
      openrouter: { apiKey: config.OPENROUTER_API_KEY },
    },
    resolveServiceKey: (key) => serviceKeyRepo.resolve(key),
    // DB-backed model resolver — requires platform-core #131
    ...(resolveGatewayModel ? { resolveDefaultModel: resolveGatewayModel } : {}),
  } as Parameters<typeof mountGateway>[1]);

  logger.info("Inference gateway mounted at /v1 (OpenRouter)", {
    defaultModel: config.GATEWAY_DEFAULT_MODEL ?? "(DB-backed)",
  });
}

// ---------------------------------------------------------------------------
// Crypto key-server webhook wiring
// ---------------------------------------------------------------------------

async function wireCryptoWebhook(db: import("@wopr-network/platform-core/db").DrizzleDb, creditLedger: ILedger) {
  const {
    CryptoServiceClient,
    loadCryptoConfig,
    DrizzleCryptoChargeRepository,
    DrizzlePaymentMethodStore,
    DrizzleWebhookSeenRepository,
  } = await import("@wopr-network/platform-core/billing");

  const cryptoConfig = loadCryptoConfig();
  if (!cryptoConfig) {
    logger.warn("Crypto service not configured — crypto payments disabled (set CRYPTO_SERVICE_URL)");
    return;
  }

  const { setCryptoWebhookDeps } = await import("./routes/crypto-webhook.js");
  const { setCryptoBillingDeps } = await import("./trpc/routers/billing.js");

  const cryptoClient = new CryptoServiceClient(cryptoConfig);
  const cryptoChargeRepo = new DrizzleCryptoChargeRepository(db);
  const replayGuard = new DrizzleWebhookSeenRepository(db);
  const paymentMethodStore = new DrizzlePaymentMethodStore(db);

  // Wire webhook route deps (for POST /api/webhooks/crypto)
  setCryptoWebhookDeps({ chargeStore: cryptoChargeRepo, creditLedger, replayGuard });

  // Wire unified checkout + payment method registry
  const evmXpub = process.env.EVM_XPUB;
  const evmRpcBase = process.env.EVM_RPC_BASE;
  setCryptoBillingDeps(cryptoClient, cryptoChargeRepo, evmXpub, evmRpcBase, paymentMethodStore);

  logger.info("Crypto payments configured (webhook + checkout)");
  if (evmXpub) logger.info("Stablecoin + ETH payments configured (EVM_XPUB set)");
  if (evmRpcBase) logger.info("Chainlink price oracle configured (EVM_RPC_BASE set)");

  // Start crypto watchers (polls DB for enabled methods, auto-discovers new coins)
  try {
    const { DrizzleWatcherCursorStore } = await import("@wopr-network/platform-core/billing");
    const { initCryptoWatchers } = await import("./crypto/init-watchers.js");
    const cursorStore = new DrizzleWatcherCursorStore(db);
    cryptoWatcherHandle = initCryptoWatchers({
      paymentMethodStore,
      chargeStore: cryptoChargeRepo,
      creditLedger,
      cursorStore,
      db,
      evmXpub,
      evmRpcUrl: evmRpcBase,
    });
  } catch (err) {
    logger.warn("Crypto watchers failed to start", { error: err });
  }
}
