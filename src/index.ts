import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import type { AuthUser } from "@wopr-network/platform-core/auth";
import { bootPlatformServer } from "@wopr-network/platform-core/server";
import type { TRPCContext } from "@wopr-network/platform-core/trpc";
import { setTrpcOrgMemberRepo } from "@wopr-network/platform-core/trpc";

import { setContainer } from "./container.js";
import { appRouter, setProductConfigRouterDeps } from "./trpc/index.js";

const platform = await bootPlatformServer({
  slug: process.env.PRODUCT_SLUG ?? "paperclip",
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
setContainer(container);

// Wire product-level tRPC deps from container
setTrpcOrgMemberRepo(container.orgMemberRepo);

// Wire product config service for admin tRPC router
const { platformBoot } = await import("@wopr-network/platform-core/product-config");
const { service: productConfigService } = await platformBoot({
  slug: process.env.PRODUCT_SLUG ?? "paperclip",
  db: container.db,
});
setProductConfigRouterDeps(productConfigService as never, process.env.PRODUCT_SLUG ?? "paperclip");

// tRPC context — resolves user from BetterAuth session
async function createTRPCContext(req: Request): Promise<TRPCContext> {
  let user: AuthUser | undefined;
  let tenantId: string | undefined;
  try {
    const { getAuth } = await import("@wopr-network/platform-core/auth/better-auth");
    const auth = getAuth();
    const session = await auth.api.getSession({ headers: req.headers });
    if (session?.user) {
      const sessionUser = session.user as { id: string; role?: string };
      const roles: string[] = [];
      if (sessionUser.role) roles.push(sessionUser.role);
      user = { id: sessionUser.id, roles };
      tenantId = req.headers.get("x-tenant-id") || sessionUser.id;
    }
  } catch {
    // No session — unauthenticated request
  }
  return { user, tenantId: tenantId ?? "" };
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
