/**
 * tRPC admin router — platform-wide settings for the operator.
 *
 * All endpoints require platform_admin role (via adminProcedure).
 */

import type { DrizzleDb } from "@wopr-network/platform-core/db";
import { adminProcedure, router } from "@wopr-network/platform-core/trpc";
import { eq } from "drizzle-orm";
import { pgTable, text } from "drizzle-orm/pg-core";
import { z } from "zod";

/** Inline table ref — matches platform-core schema/tenant-model-selection.ts */
const tenantModelSelection = pgTable("tenant_model_selection", {
  tenantId: text("tenant_id").primaryKey(),
  defaultModel: text("default_model").notNull().default("openrouter/auto"),
  updatedAt: text("updated_at")
    .notNull()
    .$default(() => new Date().toISOString()),
});

/** Well-known tenant ID for the global platform model setting. */
const GLOBAL_TENANT_ID = "__platform__";

let db: DrizzleDb | null = null;

export function setAdminRouterDeps(deps: { db: DrizzleDb }) {
  db = deps.db;
}

function getDb(): DrizzleDb {
  if (!db) throw new Error("admin router not initialized");
  return db;
}

// ---------------------------------------------------------------------------
// Cached model resolver — called per-request by the gateway proxy.
// Reads from tenant_model_selection with a short TTL so admin changes
// take effect within seconds, not on restart.
// ---------------------------------------------------------------------------

let cachedModel: string | null = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 5_000;

/**
 * Synchronous model resolver for the gateway proxy.
 * Returns the cached DB value, or null to fall back to env var.
 * The cache is refreshed asynchronously every 5 seconds.
 */
export function resolveGatewayModel(): string | null {
  const now = Date.now();
  if (now > cacheExpiry) {
    // Refresh cache in the background — don't block the request
    refreshModelCache().catch(() => {});
  }
  return cachedModel;
}

async function refreshModelCache(): Promise<void> {
  if (!db) return;
  try {
    const row = await db
      .select({ defaultModel: tenantModelSelection.defaultModel })
      .from(tenantModelSelection)
      .where(eq(tenantModelSelection.tenantId, GLOBAL_TENANT_ID))
      .then((rows) => rows[0] ?? null);
    cachedModel = row?.defaultModel ?? null;
    cacheExpiry = Date.now() + CACHE_TTL_MS;
  } catch {
    // DB error — keep stale cache, retry next time
  }
}

/** Seed the cache on startup so the first request doesn't miss. */
export async function warmModelCache(): Promise<void> {
  await refreshModelCache();
}

// ---------------------------------------------------------------------------
// tRPC admin router
// ---------------------------------------------------------------------------

export const adminRouter = router({
  /** Get the current gateway model setting. */
  getGatewayModel: adminProcedure.query(async () => {
    const d = getDb();
    const row = await d
      .select({ defaultModel: tenantModelSelection.defaultModel, updatedAt: tenantModelSelection.updatedAt })
      .from(tenantModelSelection)
      .where(eq(tenantModelSelection.tenantId, GLOBAL_TENANT_ID))
      .then((rows) => rows[0] ?? null);
    return {
      model: row?.defaultModel ?? null,
      updatedAt: row?.updatedAt ?? null,
    };
  }),

  /** Set the gateway model. Takes effect within 5 seconds. */
  setGatewayModel: adminProcedure.input(z.object({ model: z.string().min(1).max(200) })).mutation(async ({ input }) => {
    const d = getDb();
    const now = new Date().toISOString();
    await d
      .insert(tenantModelSelection)
      .values({
        tenantId: GLOBAL_TENANT_ID,
        defaultModel: input.model,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: tenantModelSelection.tenantId,
        set: { defaultModel: input.model, updatedAt: now },
      });
    // Immediately update the cache so the next gateway request uses the new model.
    cachedModel = input.model;
    cacheExpiry = Date.now() + CACHE_TTL_MS;
    return { ok: true, model: input.model };
  }),
});
