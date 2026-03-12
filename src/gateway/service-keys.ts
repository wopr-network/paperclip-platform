/**
 * Per-instance gateway service key registry.
 *
 * Each provisioned Paperclip instance gets a unique gateway key.
 * The key is stored in the instance's env (persisted in the profile YAML)
 * and loaded into this in-memory map at startup by wireGateway() (see src/index.ts).
 *
 * resolveServiceKey() is passed to mountGateway() so the gateway can
 * authenticate requests and resolve them to a tenant for billing.
 */

import { createHash, randomBytes } from "node:crypto";
import type { GatewayTenant } from "@wopr-network/platform-core/gateway";
import { logger } from "../log.js";

/** Map of key hash → tenant metadata */
const keyMap = new Map<string, { tenantId: string }>();

/** Hash a raw key for map lookup (avoids storing raw secrets in memory). */
function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Generate a new per-instance gateway key and register it. */
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

/** Remove a single service key by its raw value (used on instance destroy). */
export function removeServiceKey(rawKey: string): void {
  const hash = hashKey(rawKey);
  keyMap.delete(hash);
}

/**
 * Resolve a bearer token to a GatewayTenant.
 * Hashes the input key and performs a Map lookup — no raw key comparison.
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
