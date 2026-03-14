import type { CryptoWebhookPayload } from "@wopr-network/platform-core/billing";
import { handleCryptoWebhook, verifyCryptoWebhookSignature } from "@wopr-network/platform-core/billing";
import { Hono } from "hono";
import { logger } from "../log.js";

export const cryptoWebhookRoutes = new Hono();

/** Deps injected at startup (after DB init). */
let _deps: Parameters<typeof handleCryptoWebhook>[0] | null = null;
let _webhookSecret: string | null = null;

export function setCryptoWebhookDeps(deps: Parameters<typeof handleCryptoWebhook>[0], webhookSecret: string): void {
  _deps = deps;
  _webhookSecret = webhookSecret;
}

/**
 * POST /api/webhooks/crypto
 *
 * BTCPay Server sends InvoiceSettled (and other) events here.
 * Signature verified via BTCPAY-SIG header (HMAC-SHA256).
 */
cryptoWebhookRoutes.post("/", async (c) => {
  if (!_deps || !_webhookSecret) {
    logger.warn("Crypto webhook received but handler not configured");
    return c.json({ error: "Crypto payments not configured" }, 501);
  }

  // Read raw body for signature verification.
  const rawBody = await c.req.text();
  const sig = c.req.header("BTCPAY-SIG");

  if (!sig || !verifyCryptoWebhookSignature(rawBody, sig, _webhookSecret)) {
    logger.warn("Crypto webhook signature verification failed");
    return c.json({ error: "Invalid signature" }, 401);
  }

  let payload: CryptoWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as CryptoWebhookPayload;
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  logger.info("Crypto webhook received", {
    type: payload.type,
    invoiceId: payload.invoiceId,
    isRedelivery: payload.isRedelivery,
  });

  const result = await handleCryptoWebhook(_deps, payload);

  if (result.creditedCents && result.creditedCents > 0) {
    logger.info("Crypto payment credited", {
      tenant: result.tenant,
      creditedCents: result.creditedCents,
      invoiceId: payload.invoiceId,
    });
  }

  return c.json(result, 200);
});
