import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { logger } from "@wopr-network/platform-core/config/logger";
import { bootPlatformServer } from "@wopr-network/platform-core/server";
import { createTRPCContext, setTrpcOrgMemberRepo } from "@wopr-network/platform-core/trpc";

import { LOCAL_NODE_ID, type NodeConfig, NodeRegistry } from "./fleet/node-registry.js";
import { setOrgInstanceResolverDeps } from "./fleet/org-instance-resolver.js";
import { createPlacementStrategy } from "./fleet/placement.js";
import { setFleetResolverProxy } from "./proxy/fleet-resolver.js";
import { setAuthHelpersDeps } from "./trpc/auth-helpers.js";
import {
  appRouter,
  setAdminRouterDeps,
  setFleetRouterDeps,
  setProductConfigRouterDeps,
  setTrpcDb,
} from "./trpc/index.js";

const slug = process.env.PRODUCT_SLUG ?? "paperclip";

const platform = await bootPlatformServer({
  slug,
  databaseUrl: process.env.DATABASE_URL ?? "",
  host: process.env.HOST ?? "0.0.0.0",
  port: Number(process.env.PORT ?? 3001),
  provisionSecret: process.env.PROVISION_SECRET ?? "",
  cryptoServiceKey: process.env.CRYPTO_SERVICE_KEY,
  stripeSecretKey: process.env.STRIPE_SECRET_KEY,
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  features: {
    fleet: !!process.env.DATABASE_URL,
    crypto: !!process.env.DATABASE_URL,
    stripe: !!process.env.STRIPE_SECRET_KEY,
    gateway: !!process.env.DATABASE_URL,
    hotPool: false,
  },
});

const { container } = platform;

// ---------------------------------------------------------------------------
// Wire all product-level deps from the container
// ---------------------------------------------------------------------------

setTrpcOrgMemberRepo(container.orgMemberRepo);
setProductConfigRouterDeps(container.productConfigService as never, slug);
setTrpcDb(container.db);
setAuthHelpersDeps(container.orgMemberRepo);

if (container.fleet) {
  const { docker, profileStore, proxy, serviceKeyRepo } = container.fleet;

  // NodeRegistry — multi-node Docker host management
  const nodeRegistry = new NodeRegistry();
  const fleetNodesEnv = process.env.FLEET_NODES ?? "";
  let nodeConfigs: NodeConfig[] = [];
  if (fleetNodesEnv) {
    try {
      nodeConfigs = JSON.parse(fleetNodesEnv);
    } catch {
      logger.warn("Failed to parse FLEET_NODES — using local node only");
    }
  }
  if (nodeConfigs.length > 0) {
    for (const nodeConfig of nodeConfigs) {
      nodeRegistry.register(nodeConfig, profileStore);
    }
  } else {
    nodeRegistry.register(
      { id: LOCAL_NODE_ID, name: "local", host: "localhost", useContainerNames: true },
      profileStore,
    );
  }

  const placementStrategy = createPlacementStrategy(process.env.FLEET_PLACEMENT_STRATEGY ?? "least-loaded");

  setFleetResolverProxy(proxy);
  setOrgInstanceResolverDeps(profileStore, proxy);
  setAdminRouterDeps({
    db: container.db,
    pool: container.pool,
    creditLedger: container.creditLedger,
    profileStore,
    nodeRegistry,
    serviceKeyRepo,
  });
  setFleetRouterDeps({
    pool: container.pool,
    docker,
    creditLedger: container.creditLedger,
    profileStore,
    productConfig: container.productConfig,
    nodeRegistry,
    placementStrategy,
    serviceKeyRepo,
  });
}

// Mount product-level tRPC router
platform.app.all("/trpc/*", async (c) => {
  const response = await fetchRequestHandler({
    endpoint: "/trpc",
    req: c.req.raw,
    router: appRouter,
    createContext: () => createTRPCContext(c.req.raw),
  });
  return response;
});

await platform.start();

process.on("SIGINT", () => platform.stop().then(() => process.exit(0)));
process.on("SIGTERM", () => platform.stop().then(() => process.exit(0)));
