import { bootPlatformServer } from "@wopr-network/platform-core/server";
import { setContainer } from "./container.js";

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

setContainer(platform.container);
await platform.start();

process.on("SIGINT", () => platform.stop().then(() => process.exit(0)));
process.on("SIGTERM", () => platform.stop().then(() => process.exit(0)));
