import { timingSafeEqual } from "node:crypto";

import type { CryptoWebhookPayload } from "@wopr-network/platform-core/billing";
import { handleCryptoWebhook } from "@wopr-network/platform-core/billing";
import { Hono } from "hono";
import { getConfig } from "../config.js";
import { logger } from "../log.js";

export const cryptoWebhookRoutes = new Hono();

/** Deps injected at startup (after DB init). */
let _deps: Parameters<typeof handleCryptoWebhook>[0] | null = null;

export function setCryptoWebhookDeps(deps: Parameters<typeof handleCryptoWebhook>[0]): void {
  _deps = deps;
}

/** Validate the Bearer token against known secrets (timing-safe). */
function assertSecret(authHeader: string | undefined): boolean {
  if (!authHeader?.startsWith("Bearer ")) return false;
  const token = authHeader.slice("Bearer ".length).trim();
  const config = getConfig();
  // Accept provision secret OR crypto service key (chain server uses the latter)
  const secrets = [config.PROVISION_SECRET, config.CRYPTO_SERVICE_KEY].filter((s): s is string => !!s);
  for (const secret of secrets) {
    if (token.length === secret.length && timingSafeEqual(Buffer.from(token), Buffer.from(secret))) {
      return true;
    }
  }
  return false;
}

/**
 * POST /api/webhooks/crypto
 *
 * Crypto key server sends payment confirmations here.
 * The key server authenticates via service key (Bearer token).
 */
cryptoWebhookRoutes.post("/", async (c) => {
  if (!assertSecret(c.req.header("authorization"))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  if (!_deps) {
    logger.warn("Crypto webhook received but handler not configured");
    return c.json({ error: "Crypto payments not configured" }, 501);
  }

  let payload: CryptoWebhookPayload;
  try {
    payload = (await c.req.json()) as CryptoWebhookPayload;
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  logger.info("Crypto webhook received", {
    chargeId: payload.chargeId,
    chain: payload.chain,
    status: payload.status,
  });

  const result = await handleCryptoWebhook(_deps, payload);

  if (result.creditedCents && result.creditedCents > 0) {
    logger.info("Crypto payment credited", {
      tenant: result.tenant,
      creditedCents: result.creditedCents,
      chargeId: payload.chargeId,
    });
  }

  return c.json(result, 200);
});
