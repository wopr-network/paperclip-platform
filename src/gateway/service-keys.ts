/**
 * Per-tenant gateway service key registry.
 *
 * Each provisioned Paperclip instance gets a unique gateway key.
 * The key is stored in the instance's env (persisted in the profile YAML)
 * and loaded into this in-memory map at startup via hydrateServiceKeys().
 *
 * resolveServiceKey() is passed to mountGateway() so the gateway can
 * authenticate requests and resolve them to a tenant for billing.
 */

import { createHash, randomBytes } from "node:crypto";
import type { GatewayTenant } from "@wopr-network/platform-core/gateway";
import { logger } from "../log.js";

/** Map of key hash → tenant metadata */
const keyMap = new Map<string, { tenantId: string }>();

/** Hash a raw key for constant-time lookup */
function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Generate a new per-tenant gateway key and register it. */
export function generateServiceKey(tenantId: string): string {
  const raw = randomBytes(32).toString("hex");
  const hash = hashKey(raw);
  keyMap.set(hash, { tenantId });
  logger.info(`Registered gateway service key for tenant ${tenantId}`);
  return raw;
}

/** Register an existing key (used during hydration from profile env). */
export function registerServiceKey(rawKey: string, tenantId: string): void {
  const hash = hashKey(rawKey);
  keyMap.set(hash, { tenantId });
}

/** Remove all keys for a tenant (used on instance destroy). */
export function removeServiceKeys(tenantId: string): void {
  for (const [hash, meta] of keyMap) {
    if (meta.tenantId === tenantId) keyMap.delete(hash);
  }
}

/**
 * Resolve a bearer token to a GatewayTenant.
 * Uses timing-safe comparison via hash lookup (no raw key comparison).
 */
export function resolveServiceKey(key: string): GatewayTenant | null {
  const hash = hashKey(key);
  const meta = keyMap.get(hash);
  if (!meta) return null;
  return {
    id: meta.tenantId,
    spendLimits: { maxSpendPerHour: null, maxSpendPerMonth: null },
  };
}

/** Number of registered keys (for diagnostics). */
export function serviceKeyCount(): number {
  return keyMap.size;
}
